import { statSync } from 'fs';

export interface PickResult {
    files: string[];
}

export interface MediaPickResult {
    paths: string[];
    folder: string | null;
}

interface ElectronOpenDialogResult {
    canceled: boolean;
    filePaths: string[];
}

interface ElectronDialog {
    showOpenDialog(options: {
        properties?: string[];
        filters?: Array<{ name: string; extensions: string[] }>;
        title?: string;
    }): Promise<ElectronOpenDialogResult>;
}

type NodeRequire = (module: string) => unknown;

function loadDialog(): ElectronDialog {
    const nodeRequire = (window as unknown as { require?: NodeRequire }).require;
    if (typeof nodeRequire !== 'function') {
        throw new Error('Electron APIs are unavailable. This plugin requires desktop Obsidian.');
    }
    try {
        const remote = nodeRequire('@electron/remote') as { dialog?: ElectronDialog };
        if (remote?.dialog) return remote.dialog;
    } catch {
        // fall through to electron module
    }
    const electron = nodeRequire('electron') as { remote?: { dialog?: ElectronDialog } };
    if (electron?.remote?.dialog) return electron.remote.dialog;
    throw new Error('Could not access Electron file dialog. Update Obsidian or install @electron/remote.');
}

function extensionsWithoutDot(audioExtensions: string[]): string[] {
    return audioExtensions.map(ext => (ext.startsWith('.') ? ext.slice(1) : ext));
}

export async function pickMedia(mediaExtensions: string[]): Promise<MediaPickResult | null> {
    const dialog = loadDialog();
    const result = await dialog.showOpenDialog({
        title: 'Select audio/video file(s) or a folder',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [
            { name: 'Audio & video', extensions: extensionsWithoutDot(mediaExtensions) },
            { name: 'All files', extensions: ['*'] }
        ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    if (result.filePaths.length === 1) {
        const only = result.filePaths[0];
        try {
            if (statSync(only).isDirectory()) {
                return { paths: [], folder: only };
            }
        } catch {
            // fall through and treat as file
        }
    }
    return { paths: result.filePaths, folder: null };
}
