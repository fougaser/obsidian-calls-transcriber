import { Plugin, WorkspaceLeaf } from 'obsidian';
import {
    DEFAULT_SETTINGS,
    TranscriberSettings,
    ensureProviderConfig,
    mergeSettings
} from './settings';
import { CallsTranscriberSettingTab } from './settingsTab';
import { TRANSCRIBE_VIEW_TYPE, TranscribeView } from './transcribeView';
import { detectFfmpeg, FfmpegStatus } from './audio/ffmpeg';
import { requireProvider } from './providers/registry';

const DEFAULT_FFMPEG_STATUS: FfmpegStatus = {
    ok: false,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    error: 'ffmpeg not detected yet.'
};

export default class CallsTranscriberPlugin extends Plugin {
    settings: TranscriberSettings = DEFAULT_SETTINGS;
    ffmpegStatus: FfmpegStatus = DEFAULT_FFMPEG_STATUS;

    async onload(): Promise<void> {
        const stored = (await this.loadData()) as Partial<TranscriberSettings> | null;
        this.settings = mergeSettings(stored);

        this.registerView(TRANSCRIBE_VIEW_TYPE, leaf => new TranscribeView(leaf, this));

        this.addSettingTab(new CallsTranscriberSettingTab(this.app, this));

        this.addRibbonIcon('microphone', 'Open Calls Transcriber', () => {
            void this.activateTranscribeView();
        });

        this.addCommand({
            id: 'calls-transcriber-open',
            name: 'Open transcriber',
            callback: () => void this.activateTranscribeView()
        });

        void this.redetectFfmpeg();
    }

    async onunload(): Promise<void> {
        // Leaves stay registered; Obsidian detaches them.
    }

    async activateTranscribeView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(TRANSCRIBE_VIEW_TYPE);
        let leaf: WorkspaceLeaf | null;
        if (existing.length > 0) {
            leaf = existing[0];
        } else {
            leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: TRANSCRIBE_VIEW_TYPE, active: true });
            }
        }
        if (leaf) {
            this.app.workspace.revealLeaf(leaf);
        }
    }

    async updateSettings(patch: Partial<TranscriberSettings>): Promise<void> {
        this.settings = { ...this.settings, ...patch };
        await this.saveData(this.settings);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    async redetectFfmpeg(): Promise<FfmpegStatus> {
        this.ffmpegStatus = await detectFfmpeg(this.settings.ffmpegPath, this.settings.ffprobePath);
        return this.ffmpegStatus;
    }

    async refreshProviderModels(providerId: string): Promise<void> {
        const provider = requireProvider(providerId);
        const cfg = ensureProviderConfig(this.settings, providerId);
        if (cfg.apiKey.length === 0) {
            throw new Error('Add the API key before refreshing models.');
        }
        const discovered = await provider.listModels(cfg.apiKey);
        cfg.discoveredModels = discovered.map(m => m.id);

        // Seed-enable newly discovered models when nothing is enabled yet.
        if (cfg.enabledModels.length === 0 && cfg.discoveredModels.length > 0) {
            cfg.enabledModels = [cfg.discoveredModels[0]];
            cfg.defaultModel = cfg.enabledModels[0];
        }

        if (cfg.defaultModel.length === 0 && cfg.enabledModels.length > 0) {
            cfg.defaultModel = cfg.enabledModels[0];
        }

        await this.saveSettings();
    }
}
