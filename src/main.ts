import { Plugin } from 'obsidian';
import {
    DEFAULT_SETTINGS,
    TranscriberSettings,
    ensureProviderConfig,
    mergeSettings
} from './settings';
import { CallsTranscriberSettingTab } from './settingsTab';
import { TranscribeModal } from './transcribeModal';
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

        this.addSettingTab(new CallsTranscriberSettingTab(this.app, this));

        this.addRibbonIcon('microphone', 'Open Calls Transcriber', () => {
            this.openTranscribeModal();
        });

        this.addCommand({
            id: 'calls-transcriber-open',
            name: 'Open transcriber',
            callback: () => this.openTranscribeModal()
        });

        void this.redetectFfmpeg();
    }

    async onunload(): Promise<void> {
        // nothing to tear down
    }

    openTranscribeModal(): void {
        new TranscribeModal(this.app, this).open();
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
