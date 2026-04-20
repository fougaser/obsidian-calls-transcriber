import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { statSync } from 'fs';
import { basename, extname } from 'path';

export function formatDateDDMMYYYY(date: Date): string {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

/**
 * Best-guess creation date of a local media file: the earliest of filesystem
 * birthtime and mtime (many copy tools preserve mtime even when birthtime
 * moves to the copy moment). Returns null if the path can't be stat'd.
 */
export function fileCreationDate(sourcePath: string): Date | null {
    try {
        const stat = statSync(sourcePath);
        const birth = stat.birthtime?.getTime() ?? Number.POSITIVE_INFINITY;
        const mod = stat.mtime?.getTime() ?? Number.POSITIVE_INFINITY;
        const earliest = Math.min(birth, mod);
        if (!Number.isFinite(earliest)) return null;
        return new Date(earliest);
    } catch {
        return null;
    }
}

export function transcriptFileNameFor(sourcePath: string, date?: Date | null): string {
    const name = basename(sourcePath);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const suffix = date ? ` - ${formatDateDDMMYYYY(date)}` : '';
    return `${stem}${suffix}.md`;
}

export function vaultTranscriptPath(
    folder: string,
    sourcePath: string,
    date?: Date | null
): string {
    const fileName = transcriptFileNameFor(sourcePath, date);
    const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');
    return normalizePath(cleanFolder.length > 0 ? `${cleanFolder}/${fileName}` : fileName);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
    if (folderPath.length === 0) return;
    const existing = app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) return;
    if (existing) {
        throw new Error(`Path exists but is not a folder: ${folderPath}`);
    }
    await app.vault.createFolder(folderPath);
}

export function transcriptExists(
    app: App,
    folder: string,
    sourcePath: string,
    date?: Date | null
): boolean {
    const path = vaultTranscriptPath(folder, sourcePath, date);
    return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

export async function writeTranscript(
    app: App,
    folder: string,
    sourcePath: string,
    contents: string,
    date?: Date | null
): Promise<string> {
    const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');
    if (cleanFolder.length > 0) {
        await ensureFolder(app, cleanFolder);
    }
    const fullPath = vaultTranscriptPath(folder, sourcePath, date);
    const existing = app.vault.getAbstractFileByPath(fullPath);
    if (existing instanceof TFile) {
        await app.vault.modify(existing, contents);
    } else {
        await app.vault.create(fullPath, contents);
    }
    return fullPath;
}
