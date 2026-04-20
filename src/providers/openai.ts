import { statSync, readFileSync, existsSync, unlinkSync, rmdirSync } from 'fs';
import { basename, dirname, extname } from 'path';
import { extractAudioToMp3, makeTempMp3Path, probeStreams, splitAudio } from '../audio/ffmpeg';
import { normalizeExtension } from '../audio/extensions';
import { ModelInfo, TranscribeOptions, TranscriptionProvider } from './types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const LANG_NAMES: Record<string, string> = {
    en: 'English',
    ru: 'Russian',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    pl: 'Polish',
    tr: 'Turkish',
    uk: 'Ukrainian',
    zh: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
    ar: 'Arabic',
    hi: 'Hindi'
};

const TRANSCRIPTION_MODEL_PATTERN = /whisper|transcribe/i;

export const KNOWN_OPENAI_TRANSCRIPTION_MODELS: readonly string[] = [
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe'
];

function prettyLanguageList(codes: string[]): string {
    return codes.map(code => LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase()).join(' and ');
}

function contentTypeForExtension(ext: string): string {
    switch (ext.toLowerCase()) {
        case '.mp3':
            return 'audio/mpeg';
        case '.m4a':
            return 'audio/mp4';
        case '.mp4':
            return 'video/mp4';
        case '.wav':
            return 'audio/wav';
        case '.ogg':
            return 'audio/ogg';
        case '.flac':
            return 'audio/flac';
        case '.webm':
            return 'audio/webm';
        default:
            return 'application/octet-stream';
    }
}

async function transcribeSingleFile(
    filePath: string,
    apiKey: string,
    opts: TranscribeOptions
): Promise<string> {
    const extension = filePath.slice(filePath.lastIndexOf('.'));
    const buffer = readFileSync(filePath);
    const blob = new Blob([new Uint8Array(buffer)], { type: contentTypeForExtension(extension) });

    const form = new FormData();
    form.append('file', blob, basename(filePath));
    form.append('model', opts.model);
    form.append('response_format', 'text');

    if (opts.languages.length === 1) {
        form.append('language', opts.languages[0]);
    } else if (opts.languages.length > 1) {
        form.append('prompt', `The audio may contain ${prettyLanguageList(opts.languages)} speech.`);
    }

    const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: opts.signal
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `OpenAI transcription error (${response.status}): ${text.slice(0, 500) || response.statusText}`
        );
    }
    return text;
}

export class OpenAIProvider implements TranscriptionProvider {
    readonly id = 'openai';
    readonly displayName = 'OpenAI';

    knownModels(): ModelInfo[] {
        return KNOWN_OPENAI_TRANSCRIPTION_MODELS.map(id => ({ id }));
    }

    async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
        if (!apiKey) throw new Error('OpenAI API key is empty.');
        const response = await fetch(`${OPENAI_BASE_URL}/models`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
            signal
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(
                `OpenAI models list error (${response.status}): ${body.slice(0, 500) || response.statusText}`
            );
        }
        const parsed = (await response.json()) as { data?: Array<{ id?: string }> };
        const all = Array.isArray(parsed.data) ? parsed.data : [];
        const filtered: ModelInfo[] = [];
        for (const entry of all) {
            if (typeof entry.id !== 'string') continue;
            if (!TRANSCRIPTION_MODEL_PATTERN.test(entry.id)) continue;
            filtered.push({ id: entry.id });
        }
        filtered.sort((a, b) => a.id.localeCompare(b.id));
        return filtered;
    }

    async transcribe(
        filePath: string,
        apiKey: string,
        opts: TranscribeOptions
    ): Promise<string> {
        if (!apiKey) throw new Error('OpenAI API key is empty.');

        let workingPath = filePath;
        let extractedCleanup: (() => void) | null = null;

        try {
            const prepared = await this.prepareAudio(filePath, opts);
            workingPath = prepared.path;
            extractedCleanup = prepared.cleanup;

            const size = statSync(workingPath).size;
            if (size <= opts.maxFileSizeBytes) {
                opts.onProgress({ stage: 'uploading', pct: 0 });
                const text = await transcribeSingleFile(workingPath, apiKey, opts);
                opts.onProgress({ stage: 'uploading', pct: 1 });
                return text;
            }

            opts.onProgress({ stage: 'probing' });
            const split = await splitAudio(workingPath, opts.ffmpegPath, opts.ffprobePath, {
                targetBytes: opts.targetChunkBytes,
                maxChunkSecs: opts.maxChunkSecs,
                signal: opts.signal,
                onChunkReady: (_chunk, index, total) => {
                    opts.onProgress({
                        stage: 'splitting',
                        chunkIndex: index + 1,
                        chunkTotal: total,
                        pct: (index + 1) / total
                    });
                }
            });

            try {
                const parts: string[] = [];
                const total = split.chunks.length;
                for (let i = 0; i < total; i++) {
                    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                    opts.onProgress({
                        stage: 'uploading',
                        chunkIndex: i + 1,
                        chunkTotal: total,
                        pct: i / total
                    });
                    const partText = await transcribeSingleFile(split.chunks[i].path, apiKey, opts);
                    parts.push(partText);
                    opts.onProgress({
                        stage: 'uploading',
                        chunkIndex: i + 1,
                        chunkTotal: total,
                        pct: (i + 1) / total
                    });
                }
                return parts.join('\n');
            } finally {
                split.cleanup();
            }
        } finally {
            extractedCleanup?.();
        }
    }

    private async prepareAudio(
        filePath: string,
        opts: TranscribeOptions
    ): Promise<{ path: string; cleanup: (() => void) | null }> {
        const ext = normalizeExtension(extname(filePath));
        const videoSet = new Set(opts.videoExtensions.map(normalizeExtension));
        const looksLikeVideo = videoSet.has(ext);

        // If we have no ffmpeg at all, we can't extract — let upstream handle/error.
        const hasFfmpeg = opts.ffmpegPath.length > 0 && opts.ffprobePath.length > 0;
        if (!hasFfmpeg) {
            if (looksLikeVideo) {
                throw new Error(
                    `"${basename(filePath)}" appears to be a video file, but ffmpeg was not detected. Install ffmpeg to transcribe video.`
                );
            }
            return { path: filePath, cleanup: null };
        }

        // Fast path for unambiguous audio extensions: skip probing.
        if (!looksLikeVideo && isPlainAudio(ext)) {
            return { path: filePath, cleanup: null };
        }

        // Probe streams to decide.
        opts.onProgress({ stage: 'probing' });
        const streams = await probeStreams(filePath, opts.ffprobePath, opts.signal);
        if (!streams.hasVideo) {
            return { path: filePath, cleanup: null };
        }
        if (!streams.hasAudio) {
            throw new Error(`"${basename(filePath)}" has no audio stream to transcribe.`);
        }

        opts.onProgress({ stage: 'extracting' });
        const tempPath = makeTempMp3Path(filePath);
        await extractAudioToMp3(filePath, opts.ffmpegPath, tempPath, opts.signal);
        return {
            path: tempPath,
            cleanup: () => {
                try {
                    if (existsSync(tempPath)) unlinkSync(tempPath);
                } catch {
                    // ignore
                }
                try {
                    rmdirSync(dirname(tempPath));
                } catch {
                    // ignore — non-empty or already gone
                }
            }
        };
    }
}

const PLAIN_AUDIO_EXTENSIONS = new Set([
    '.mp3',
    '.m4a',
    '.wav',
    '.ogg',
    '.flac',
    '.aac',
    '.wma',
    '.opus'
]);

function isPlainAudio(ext: string): boolean {
    return PLAIN_AUDIO_EXTENSIONS.has(ext);
}
