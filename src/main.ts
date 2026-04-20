import { Plugin } from 'obsidian';
import {
    DEFAULT_SETTINGS,
    TranscriberSettings,
    ensureProviderConfig,
    mergeSettings
} from './settings';
import { CallsTranscriberSettingTab } from './settingsTab';
import { TranscribeModal } from './transcribeModal';
import {
    TRANSCRIBE_LAUNCHER_VIEW_TYPE,
    TranscribeLauncherView
} from './transcribeTabLauncher';
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

        this.registerView(
            TRANSCRIBE_LAUNCHER_VIEW_TYPE,
            leaf => new TranscribeLauncherView(leaf, this)
        );

        this.addSettingTab(new CallsTranscriberSettingTab(this.app, this));

        this.addRibbonIcon('microphone', 'Open Calls Transcriber', () => {
            this.openTranscribeModal();
        });

        this.addCommand({
            id: 'calls-transcriber-open',
            name: 'Open transcriber',
            callback: () => this.openTranscribeModal()
        });

        this.app.workspace.onLayoutReady(async () => {
            await this.ensureLauncherTab();
            this.interceptLauncherTabClick();
        });

        void this.redetectFfmpeg();
    }

    async onunload(): Promise<void> {
        this.removeLauncherTabInterception();
    }

    openTranscribeModal(): void {
        new TranscribeModal(this.app, this).open();
    }

    private async ensureLauncherTab(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(TRANSCRIBE_LAUNCHER_VIEW_TYPE);
        if (existing.length > 0) return;
        const leaf = this.app.workspace.getLeftLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: TRANSCRIBE_LAUNCHER_VIEW_TYPE, active: false });
    }

    private launcherTabEls: HTMLElement[] = [];
    private launcherTabHandler: ((e: Event) => void) | null = null;

    // Intercept clicks on the launcher tab icon so that selecting it does NOT
    // switch the sidebar to the launcher view. Instead, just open the modal
    // and leave the current active leaf alone.
    private interceptLauncherTabClick(): void {
        this.removeLauncherTabInterception();
        const tabs = document.querySelectorAll<HTMLElement>(
            `.workspace-tab-header[data-type="${TRANSCRIBE_LAUNCHER_VIEW_TYPE}"]`
        );
        if (tabs.length === 0) return;

        const handler = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation === 'function') {
                (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation!();
            }
            this.openTranscribeModal();
        };

        this.launcherTabHandler = handler;
        tabs.forEach(el => {
            el.addEventListener('mousedown', handler, { capture: true });
            el.addEventListener('click', handler, { capture: true });
            this.launcherTabEls.push(el);
        });
    }

    private removeLauncherTabInterception(): void {
        if (!this.launcherTabHandler) return;
        for (const el of this.launcherTabEls) {
            el.removeEventListener('mousedown', this.launcherTabHandler, { capture: true } as AddEventListenerOptions);
            el.removeEventListener('click', this.launcherTabHandler, { capture: true } as AddEventListenerOptions);
        }
        this.launcherTabEls = [];
        this.launcherTabHandler = null;
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
