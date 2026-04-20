export const DEFAULT_AUDIO_EXTENSIONS: readonly string[] = [
    '.mp3',
    '.m4a',
    '.wav',
    '.ogg',
    '.flac',
    '.webm',
    '.mp4'
];

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
