import { ItemView, WorkspaceLeaf } from 'obsidian';
import type CallsTranscriberPlugin from './main';

export const TRANSCRIBE_LAUNCHER_VIEW_TYPE = 'calls-transcriber-launcher';

/**
 * A tiny sidebar view whose only job is to put the microphone icon in the
 * left-sidebar tab strip (visible at the top of the window in docked layouts).
 * Activating its tab opens the main transcribe modal; a fallback button in
 * the view's body does the same for the case where the tab is already active.
 */
export class TranscribeLauncherView extends ItemView {
    private readonly plugin: CallsTranscriberPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: CallsTranscriberPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return TRANSCRIBE_LAUNCHER_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Calls Transcriber';
    }

    getIcon(): string {
        return 'microphone';
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('ct-launcher');

        const hint = this.contentEl.createEl('p', {
            cls: 'ct-launcher-hint',
            text: 'Click below to open the Calls Transcriber.'
        });
        hint.style.color = 'var(--text-muted)';
        hint.style.fontSize = 'var(--font-ui-small)';

        const btn = this.contentEl.createEl('button', {
            text: 'Open transcriber',
            cls: 'mod-cta ct-launcher-btn'
        });
        btn.addEventListener('click', () => this.plugin.openTranscribeModal());
    }

    async onClose(): Promise<void> {
        this.contentEl.empty();
    }
}
