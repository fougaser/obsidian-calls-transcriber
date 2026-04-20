export interface PickResult {
    files: string[];
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

export async function pickAudioFiles(audioExtensions: string[]): Promise<PickResult> {
    const dialog = loadDialog();
    const result = await dialog.showOpenDialog({
        title: 'Select audio file(s) to transcribe',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Audio', extensions: extensionsWithoutDot(audioExtensions) },
            { name: 'All files', extensions: ['*'] }
        ]
    });
    return { files: result.canceled ? [] : result.filePaths };
}

export async function pickFolder(): Promise<string | null> {
    const dialog = loadDialog();
    const result = await dialog.showOpenDialog({
        title: 'Select folder of audio files',
        properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
}
