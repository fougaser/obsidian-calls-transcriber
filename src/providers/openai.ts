import { statSync, readFileSync } from 'fs';
import { basename } from 'path';
import { splitAudio } from '../audio/ffmpeg';
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

        const size = statSync(filePath).size;
        if (size <= opts.maxFileSizeBytes) {
            opts.onProgress({ stage: 'uploading', pct: 0 });
            const text = await transcribeSingleFile(filePath, apiKey, opts);
            opts.onProgress({ stage: 'uploading', pct: 1 });
            return text;
        }

        opts.onProgress({ stage: 'probing' });
        const split = await splitAudio(filePath, opts.ffmpegPath, opts.ffprobePath, {
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
    }
}
