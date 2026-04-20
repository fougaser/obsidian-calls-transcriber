import { readdirSync, statSync } from 'fs';
import { extname, join } from 'path';

export function listAudioFilesInFolder(folder: string, audioExtensions: string[]): string[] {
    const allowed = new Set(audioExtensions.map(ext => ext.toLowerCase()));
    const entries = readdirSync(folder);
    const matches: string[] = [];
    for (const entry of entries) {
        const full = join(folder, entry);
        let isFile = false;
        try {
            isFile = statSync(full).isFile();
        } catch {
            continue;
        }
        if (!isFile) continue;
        if (!allowed.has(extname(entry).toLowerCase())) continue;
        matches.push(full);
    }
    matches.sort((a, b) => a.localeCompare(b));
    return matches;
}
