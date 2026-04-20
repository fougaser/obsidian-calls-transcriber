import { spawn } from 'child_process';
import { existsSync, mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, extname } from 'path';

export interface FfmpegStatus {
    ok: boolean;
    ffmpegPath: string;
    ffprobePath: string;
    error?: string;
}

export interface AudioInfo {
    durationSec: number;
    bitrateBps: number;
}

export interface AudioChunk {
    path: string;
    offsetSec: number;
}

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

function runProcess(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', err => reject(err));
        child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));

        if (signal) {
            if (signal.aborted) {
                child.kill('SIGKILL');
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            signal.addEventListener(
                'abort',
                () => {
                    child.kill('SIGKILL');
                    reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true }
            );
        }
    });
}

const COMMON_UNIX_PREFIXES = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/opt/local/bin'
];

async function tryRun(candidate: string): Promise<boolean> {
    try {
        const res = await runProcess(candidate, ['-version']);
        return res.code === 0;
    } catch {
        return false;
    }
}

async function resolveBin(custom: string, fallback: string): Promise<string> {
    const trimmedCustom = custom.trim();
    if (trimmedCustom.length > 0) {
        if (await tryRun(trimmedCustom)) return trimmedCustom;
        throw new Error(`Could not run "${trimmedCustom}": not found or failed to execute.`);
    }
    if (await tryRun(fallback)) return fallback;
    for (const prefix of COMMON_UNIX_PREFIXES) {
        const candidate = `${prefix}/${fallback}`;
        if (await tryRun(candidate)) return candidate;
    }
    throw new Error(
        `Could not find "${fallback}" on PATH or in common locations (${COMMON_UNIX_PREFIXES.join(', ')}). Install it or set the path in Advanced settings.`
    );
}

export async function detectFfmpeg(customFfmpeg = '', customFfprobe = ''): Promise<FfmpegStatus> {
    try {
        const ffmpegPath = await resolveBin(customFfmpeg, 'ffmpeg');
        const ffprobePath = await resolveBin(customFfprobe, 'ffprobe');
        return { ok: true, ffmpegPath, ffprobePath };
    } catch (err) {
        return {
            ok: false,
            ffmpegPath: customFfmpeg || 'ffmpeg',
            ffprobePath: customFfprobe || 'ffprobe',
            error: (err as Error).message
        };
    }
}

export interface StreamInfo {
    hasVideo: boolean;
    hasAudio: boolean;
}

export async function probeStreams(
    filePath: string,
    ffprobePath: string,
    signal?: AbortSignal
): Promise<StreamInfo> {
    const res = await runProcess(
        ffprobePath || 'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath],
        signal
    );
    if (res.code !== 0) {
        throw new Error(`ffprobe stream query failed (${res.code}): ${res.stderr.slice(0, 300)}`);
    }
    const parsed = JSON.parse(res.stdout) as { streams?: Array<{ codec_type?: string }> };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    return {
        hasVideo: streams.some(s => s.codec_type === 'video'),
        hasAudio: streams.some(s => s.codec_type === 'audio')
    };
}

export async function extractAudioToMp3(
    sourcePath: string,
    ffmpegPath: string,
    outputPath: string,
    signal?: AbortSignal
): Promise<void> {
    const res = await runProcess(
        ffmpegPath || 'ffmpeg',
        [
            '-y',
            '-i',
            sourcePath,
            '-vn',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '96k',
            '-ac',
            '1',
            outputPath
        ],
        signal
    );
    if (res.code !== 0) {
        throw new Error(`ffmpeg audio extraction failed (${res.code}): ${res.stderr.slice(0, 300)}`);
    }
}

export function makeTempMp3Path(sourcePath: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-transcriber-extract-'));
    const stem = basename(sourcePath, extname(sourcePath));
    return join(dir, `${stem}.mp3`);
}

export async function probeAudio(
    filePath: string,
    ffprobePath: string,
    signal?: AbortSignal
): Promise<AudioInfo> {
    const res = await runProcess(
        ffprobePath || 'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath],
        signal
    );
    if (res.code !== 0) {
        throw new Error(`ffprobe failed (${res.code}): ${res.stderr.slice(0, 300)}`);
    }
    const parsed = JSON.parse(res.stdout) as { format?: { duration?: string; bit_rate?: string } };
    const fmt = parsed.format ?? {};
    return {
        durationSec: Number(fmt.duration ?? 0) || 0,
        bitrateBps: Number(fmt.bit_rate ?? 0) || 0
    };
}

export function planChunks(
    info: AudioInfo,
    targetBytes: number,
    maxChunkSecs: number
): number[] {
    const chunkSecs =
        info.bitrateBps > 0
            ? Math.min((targetBytes * 8) / info.bitrateBps, maxChunkSecs)
            : maxChunkSecs;
    const total = Math.max(1, Math.ceil(info.durationSec / chunkSecs));
    const offsets: number[] = [];
    for (let i = 0; i < total; i++) offsets.push(i * chunkSecs);
    return offsets;
}

export async function splitAudio(
    filePath: string,
    ffmpegPath: string,
    ffprobePath: string,
    options: { targetBytes: number; maxChunkSecs: number; signal?: AbortSignal; onChunkReady?: (chunk: AudioChunk, index: number, total: number) => void }
): Promise<{ chunks: AudioChunk[]; cleanup: () => void }> {
    const info = await probeAudio(filePath, ffprobePath, options.signal);
    const chunkSecs =
        info.bitrateBps > 0
            ? Math.min((options.targetBytes * 8) / info.bitrateBps, options.maxChunkSecs)
            : options.maxChunkSecs;
    const offsets = planChunks(info, options.targetBytes, options.maxChunkSecs);
    const total = offsets.length;

    const dir = mkdtempSync(join(tmpdir(), 'obsidian-transcriber-'));
    const stem = basename(filePath, extname(filePath));
    const chunks: AudioChunk[] = [];

    try {
        for (let i = 0; i < offsets.length; i++) {
            if (options.signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const offset = offsets[i];
            const chunkPath = join(dir, `${stem}_chunk${String(i).padStart(3, '0')}.mp3`);
            const res = await runProcess(
                ffmpegPath || 'ffmpeg',
                [
                    '-y',
                    '-ss',
                    String(offset),
                    '-t',
                    String(chunkSecs),
                    '-i',
                    filePath,
                    '-vn',
                    '-c:a',
                    'libmp3lame',
                    '-b:a',
                    '96k',
                    '-ac',
                    '1',
                    chunkPath
                ],
                options.signal
            );
            if (res.code !== 0) {
                throw new Error(`ffmpeg chunking failed (${res.code}): ${res.stderr.slice(0, 300)}`);
            }
            const chunk: AudioChunk = { path: chunkPath, offsetSec: offset };
            chunks.push(chunk);
            options.onChunkReady?.(chunk, i, total);
        }
    } catch (err) {
        for (const chunk of chunks) {
            try {
                if (existsSync(chunk.path)) unlinkSync(chunk.path);
            } catch {
                // ignore
            }
        }
        throw err;
    }

    const cleanup = () => {
        for (const chunk of chunks) {
            try {
                if (existsSync(chunk.path)) unlinkSync(chunk.path);
            } catch {
                // ignore
            }
        }
    };

    return { chunks, cleanup };
}
