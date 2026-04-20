export const DEFAULT_AUDIO_EXTENSIONS: readonly string[] = [
    '.mp3',
    '.m4a',
    '.wav',
    '.ogg',
    '.flac',
    '.aac',
    '.wma',
    '.opus'
];

export const DEFAULT_VIDEO_EXTENSIONS: readonly string[] = [
    '.mp4',
    '.mov',
    '.mkv',
    '.webm',
    '.avi',
    '.wmv',
    '.flv',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.3gp',
    '.ts'
];

const VIDEO_EXTENSION_SET = new Set(DEFAULT_VIDEO_EXTENSIONS);

export function normalizeExtension(raw: string): string {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) return '';
    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

export function parseExtensionList(input: string): string[] {
    return input
        .split(',')
        .map(normalizeExtension)
        .filter(ext => ext.length > 0);
}

export function isVideoExtension(ext: string): boolean {
    return VIDEO_EXTENSION_SET.has(normalizeExtension(ext));
}

export function mergeMediaExtensions(audio: string[], video: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ext of [...audio, ...video]) {
        const n = normalizeExtension(ext);
        if (n.length === 0 || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}
