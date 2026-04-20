import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { basename, extname } from 'path';

export function transcriptFileNameFor(sourcePath: string): string {
    const name = basename(sourcePath);
    const ext = extname(name);
    return `${name.slice(0, name.length - ext.length)}.txt`;
}

export function vaultTranscriptPath(folder: string, sourcePath: string): string {
    const fileName = transcriptFileNameFor(sourcePath);
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

export function transcriptExists(app: App, folder: string, sourcePath: string): boolean {
    const path = vaultTranscriptPath(folder, sourcePath);
    return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

export async function writeTranscript(
    app: App,
    folder: string,
    sourcePath: string,
    contents: string
): Promise<string> {
    const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');
    if (cleanFolder.length > 0) {
        await ensureFolder(app, cleanFolder);
    }
    const fullPath = vaultTranscriptPath(folder, sourcePath);
    const existing = app.vault.getAbstractFileByPath(fullPath);
    if (existing instanceof TFile) {
        await app.vault.modify(existing, contents);
    } else {
        await app.vault.create(fullPath, contents);
    }
    return fullPath;
}
