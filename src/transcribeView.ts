import { ItemView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { basename, extname } from 'path';
import type CallsTranscriberPlugin from './main';
import { getProvider } from './providers/registry';
import { TranscribeProgress, TranscribeStage, TranscriptionProvider } from './providers/types';
import { pickMedia } from './fs/picker';
import { listAudioFilesInFolder } from './fs/walkAudio';
import { mergeMediaExtensions } from './audio/extensions';
import { ensureProviderConfig } from './settings';
import { transcriptExists, writeTranscript } from './output/writer';
import { showInAppNotice, showOsNotification } from './ui/notify';
import { AVAILABLE_LANGUAGE_CHIPS } from './ui/languageChips';

export const TRANSCRIBE_VIEW_TYPE = 'calls-transcriber-view';

interface FileRow {
    sourcePath: string;
    statusEl: HTMLElement;
    progressEl: HTMLProgressElement;
    stage: TranscribeStage;
    languages: string[];
    langToggles: Map<string, HTMLButtonElement>;
}

const STAGE_LABELS: Record<TranscribeStage, string> = {
    queued: 'Queued',
    probing: 'Probing media',
    extracting: 'Extracting audio from video',
    splitting: 'Splitting',
    uploading: 'Uploading',
    writing: 'Writing transcript',
    done: 'Done',
    error: 'Error'
};

// Cumulative progress the bar reaches at each stage boundary. Each stage fills
// its slice of the bar as sub-steps complete (via event.pct), then jumps to the
// next stage's start. Missing stages (e.g. no video → no extraction) simply
// skip their slice.
const STAGE_RANGE: Record<TranscribeStage, { start: number; end: number }> = {
    queued:     { start: 0.00, end: 0.02 },
    probing:    { start: 0.02, end: 0.05 },
    extracting: { start: 0.05, end: 0.15 },
    splitting:  { start: 0.15, end: 0.30 },
    uploading:  { start: 0.30, end: 0.97 },
    writing:    { start: 0.97, end: 1.00 },
    done:       { start: 1.00, end: 1.00 },
    error:      { start: 0.00, end: 0.00 }
};

function stageToProgress(stage: TranscribeStage, pct: number | undefined): number {
    const range = STAGE_RANGE[stage];
    const clamped = typeof pct === 'number' ? Math.max(0, Math.min(1, pct)) : 0;
    return range.start + clamped * (range.end - range.start);
}

export class TranscribeView extends ItemView {
    private readonly plugin: CallsTranscriberPlugin;

    private selectedFiles: string[] = [];
    private selectedSourceLabel = '';
    private selectedFolder: string | null = null;

    private pickBtn!: HTMLButtonElement;
    private sourceLabelEl!: HTMLElement;

    private startBtn!: HTMLButtonElement;
    private cancelBtn!: HTMLButtonElement;
    private actionsEl!: HTMLElement;
    private summaryEl!: HTMLElement;

    private filesWrap!: HTMLElement;
    private rowsByPath = new Map<string, FileRow>();

    private mergeSectionEl!: HTMLElement;
    private mergeToggle!: HTMLInputElement;
    private mergeEnabled = false;

    private running = false;
    private abortController: AbortController | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: CallsTranscriberPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return TRANSCRIBE_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Transcribe';
    }

    getIcon(): string {
        return 'microphone';
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('ct-view');

        // Create every DOM node we reference before any callback can fire.
        this.renderTitleRow();
        this.renderPicker();
        this.renderFilesList();
        this.renderMergeSection();
        this.renderSummary();
        this.renderActions();

        this.updateVisibility();
        this.updateStartState();
    }

    async onClose(): Promise<void> {
        if (this.running) {
            this.abortController?.abort();
        }
        this.contentEl.empty();
        this.rowsByPath.clear();
    }

    private openPluginSettings(): void {
        const setting = (this.app as unknown as {
            setting?: {
                open?: () => void;
                openTabById?: (id: string) => void;
            };
        }).setting;
        if (!setting?.open || !setting?.openTabById) {
            new Notice('Could not open settings automatically — open Settings → Community plugins → Calls Transcriber.', 6000);
            return;
        }
        setting.open();
        setting.openTabById(this.plugin.manifest.id);
    }

    private renderTitleRow(): void {
        const row = this.contentEl.createDiv({ cls: 'ct-title-row' });
        row.createEl('h2', { cls: 'ct-title', text: 'Calls Transcriber' });
        const gearBtn = row.createEl('button', {
            cls: 'clickable-icon ct-title-gear',
            attr: { 'aria-label': 'Open Calls Transcriber settings', type: 'button' }
        });
        setIcon(gearBtn, 'settings');
        gearBtn.addEventListener('click', () => this.openPluginSettings());
    }

    private renderPicker(): void {
        const section = this.contentEl.createDiv({ cls: 'ct-section' });

        const buttons = section.createDiv({ cls: 'ct-row-buttons' });
        this.pickBtn = buttons.createEl('button', { text: 'Pick file(s) or folder', cls: 'mod-cta' });
        this.pickBtn.addEventListener('click', () => {
            void this.onPick();
        });

        this.sourceLabelEl = section.createDiv({ cls: 'ct-source-label' });
        this.sourceLabelEl.setText('No source selected.');
    }

    private renderFilesList(): void {
        this.filesWrap = this.contentEl.createDiv({ cls: 'ct-files' });
    }

    private renderMergeSection(): void {
        this.mergeSectionEl = this.contentEl.createDiv({ cls: 'ct-merge-section' });

        const label = this.mergeSectionEl.createEl('label', { cls: 'ct-merge-label' });
        this.mergeToggle = label.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
        label.createSpan({ text: ' Merge into one transcript' });

        this.mergeToggle.addEventListener('change', () => {
            this.mergeEnabled = this.mergeToggle.checked;
            this.updateStartState();
        });
    }

    private renderSummary(): void {
        this.summaryEl = this.contentEl.createDiv({ cls: 'ct-summary' });
    }

    private renderActions(): void {
        this.actionsEl = this.contentEl.createDiv({ cls: 'ct-actions' });
        this.startBtn = this.actionsEl.createEl('button', { text: 'Start', cls: 'mod-cta' });
        this.startBtn.addEventListener('click', () => {
            void this.onStart();
        });
        this.cancelBtn = this.actionsEl.createEl('button', { text: 'Cancel' });
        this.cancelBtn.addEventListener('click', () => this.onCancel());
        this.cancelBtn.setAttr('disabled', 'true');
    }

    private updateVisibility(): void {
        const hasFiles = this.selectedFiles.length > 0;
        const hasMany = this.selectedFiles.length >= 2;

        this.actionsEl.toggleClass('is-hidden', !hasFiles);
        this.mergeSectionEl.toggleClass('is-hidden', !hasMany);
        this.pickBtn.toggleClass('mod-cta', !hasFiles);
    }

    private updateStartState(): void {
        this.updateVisibility();

        const hasFiles = this.selectedFiles.length > 0;
        const providerId = this.plugin.settings.defaultProviderId;
        const provider = getProvider(providerId);
        const providerCfg = ensureProviderConfig(this.plugin.settings, providerId);
        const hasProvider = provider !== undefined;
        const hasKey = providerCfg.apiKey.length > 0;
        const hasModel = providerCfg.defaultModel.length > 0;
        const enabled = !this.running && hasFiles && hasProvider && hasKey && hasModel;
        this.startBtn.disabled = !enabled;

        this.summaryEl.empty();
        if (!hasProvider) {
            this.summaryEl.setText(`Provider "${providerId}" not found. Pick a valid one in settings.`);
            return;
        }
        if (!hasKey) {
            this.summaryEl.setText(`Add an API key for ${provider.displayName} in settings.`);
            return;
        }
        if (!hasModel) {
            this.summaryEl.setText(`Set a default model for ${provider.displayName} in settings.`);
            return;
        }
        if (!hasFiles) {
            this.summaryEl.setText('Pick a file or folder to begin.');
            return;
        }
        const modelSuffix = ` · ${provider.displayName} / ${providerCfg.defaultModel}`;
        this.summaryEl.setText(
            this.selectedFiles.length === 1
                ? `1 file queued from ${this.selectedSourceLabel}${modelSuffix}.`
                : `${this.selectedFiles.length} files queued from ${this.selectedSourceLabel}${modelSuffix}.`
        );
    }

    private mediaExtensions(): string[] {
        return mergeMediaExtensions(
            this.plugin.settings.audioExtensions,
            this.plugin.settings.videoExtensions
        );
    }

    private async onPick(): Promise<void> {
        try {
            const exts = this.mediaExtensions();
            const picked = await pickMedia(exts);
            if (!picked) return;
            if (picked.folder) {
                const files = listAudioFilesInFolder(picked.folder, exts);
                if (files.length === 0) {
                    new Notice(`No audio or video files in ${picked.folder}.`, 6000);
                    return;
                }
                this.setSelection(files, picked.folder, picked.folder);
                return;
            }
            this.setSelection(picked.paths, 'selected files', null);
        } catch (err) {
            new Notice((err as Error).message, 8000);
        }
    }

    private setSelection(files: string[], label: string, folder: string | null): void {
        this.selectedFiles = files;
        this.selectedSourceLabel = label;
        this.selectedFolder = folder;
        this.sourceLabelEl.setText(`${label}: ${files.length} file(s).`);
        this.rowsByPath.clear();
        this.filesWrap.empty();
        for (const file of files) {
            this.rowsByPath.set(file, this.createFileRow(file));
        }
        // Reset merge toggle when selection count changes semantics.
        if (files.length < 2) {
            this.mergeEnabled = false;
            this.mergeToggle.checked = false;
        }
        this.updateStartState();
    }

    private createFileRow(sourcePath: string): FileRow {
        const row = this.filesWrap.createDiv({ cls: 'ct-file-row' });
        const header = row.createDiv({ cls: 'ct-file-header' });
        header.createDiv({ cls: 'ct-file-name', text: basename(sourcePath) });
        const langRow = header.createDiv({ cls: 'ct-file-langs' });

        const meta = row.createDiv({ cls: 'ct-file-meta' });
        const statusEl = meta.createSpan({ cls: 'ct-file-status', text: STAGE_LABELS.queued });
        const progressEl = row.createEl('progress') as HTMLProgressElement;
        progressEl.max = 1;
        progressEl.value = 0;

        const defaultLangs = this.plugin.settings.languages.slice();
        const chipCodes = AVAILABLE_LANGUAGE_CHIPS.map(c => c.code);
        const initialLanguages = defaultLangs.filter(code => chipCodes.includes(code));
        const toggles = new Map<string, HTMLButtonElement>();

        const fileRow: FileRow = {
            sourcePath,
            statusEl,
            progressEl,
            stage: 'queued',
            languages: initialLanguages,
            langToggles: toggles
        };

        for (const { code, label } of AVAILABLE_LANGUAGE_CHIPS) {
            const chip = langRow.createEl('button', {
                cls: 'ct-lang-chip',
                text: label,
                attr: { type: 'button', title: `Toggle ${label} for this file` }
            });
            if (initialLanguages.includes(code)) chip.addClass('is-active');
            chip.addEventListener('click', () => {
                if (fileRow.languages.includes(code)) {
                    fileRow.languages = fileRow.languages.filter(c => c !== code);
                    chip.removeClass('is-active');
                } else {
                    fileRow.languages = [...fileRow.languages, code];
                    chip.addClass('is-active');
                }
            });
            toggles.set(code, chip);
        }

        return fileRow;
    }

    private async onStart(): Promise<void> {
        if (this.running || this.selectedFiles.length === 0) return;
        const providerId = this.plugin.settings.defaultProviderId;
        const provider = getProvider(providerId);
        if (!provider) {
            new Notice(`Provider "${providerId}" not found. Pick a valid one in settings.`, 6000);
            return;
        }
        const cfg = ensureProviderConfig(this.plugin.settings, providerId);
        const model = cfg.defaultModel;
        if (model.length === 0) {
            new Notice('Set a default model in settings first.', 5000);
            return;
        }

        const merge = this.mergeEnabled && this.selectedFiles.length > 1;

        this.running = true;
        this.abortController = new AbortController();
        this.startBtn.disabled = true;
        this.cancelBtn.removeAttribute('disabled');
        this.pickBtn.disabled = true;
        this.mergeToggle.disabled = true;
        for (const row of this.rowsByPath.values()) {
            for (const chip of row.langToggles.values()) chip.disabled = true;
        }

        let successes = 0;
        let skipped = 0;
        let failures = 0;
        let aborted = false;

        const mergedTexts: Array<{ sourcePath: string; text: string }> = [];

        try {
            for (const sourcePath of this.selectedFiles) {
                if (this.abortController.signal.aborted) {
                    aborted = true;
                    break;
                }
                const row = this.rowsByPath.get(sourcePath);
                if (!row) continue;
                try {
                    if (
                        !merge &&
                        this.plugin.settings.skipIfExists &&
                        transcriptExists(this.app, this.plugin.settings.transcriptsFolder, sourcePath)
                    ) {
                        row.stage = 'done';
                        row.statusEl.setText('Skipped (transcript exists)');
                        row.progressEl.value = 1;
                        row.progressEl.addClass('is-skipped');
                        skipped++;
                        continue;
                    }

                    const text = await this.transcribeOne(sourcePath, provider, cfg.apiKey, model, row);

                    if (merge) {
                        mergedTexts.push({ sourcePath, text });
                        row.stage = 'done';
                        row.statusEl.setText('Ready for merge');
                        row.progressEl.value = 1;
                    } else {
                        row.stage = 'writing';
                        row.statusEl.setText(STAGE_LABELS.writing);
                        const writingStart = stageToProgress('writing', 0);
                        if (writingStart > row.progressEl.value) {
                            row.progressEl.value = writingStart;
                        }
                        const written = await writeTranscript(
                            this.app,
                            this.plugin.settings.transcriptsFolder,
                            sourcePath,
                            text
                        );
                        row.stage = 'done';
                        row.statusEl.setText(`Saved to ${written}`);
                        row.progressEl.value = 1;
                    }
                    successes++;
                } catch (err) {
                    if ((err as Error).name === 'AbortError') {
                        aborted = true;
                        break;
                    }
                    failures++;
                    row.stage = 'error';
                    row.statusEl.setText(`Error: ${(err as Error).message}`);
                    row.progressEl.addClass('is-error');
                    row.progressEl.value = 0;
                }
            }

            if (merge && !aborted && mergedTexts.length > 0) {
                const mergedPath = await this.writeMergedTranscript(mergedTexts);
                showInAppNotice(`Merged transcript saved to ${mergedPath}.`, 6000);
            }
        } finally {
            this.running = false;
            this.abortController = null;
            this.cancelBtn.setAttr('disabled', 'true');
            this.pickBtn.disabled = false;
            this.mergeToggle.disabled = false;
            for (const row of this.rowsByPath.values()) {
                for (const chip of row.langToggles.values()) chip.disabled = false;
            }
            this.updateStartState();
        }

        const parts: string[] = [];
        if (successes > 0) parts.push(`${successes} transcribed`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (failures > 0) parts.push(`${failures} failed`);
        if (aborted) parts.push('cancelled');
        const summary = parts.length > 0 ? parts.join(', ') : 'nothing to do';
        showInAppNotice(`Transcription complete: ${summary}.`, 7000);
        if (this.plugin.settings.osNotification && !aborted) {
            showOsNotification('Calls Transcriber', `Complete: ${summary}.`);
        }
    }

    private mergedSourcePath(): string {
        if (this.selectedFolder) return this.selectedFolder;
        const first = this.selectedFiles[0];
        const stem = basename(first, extname(first));
        return `${stem}_merged`;
    }

    private async writeMergedTranscript(
        parts: Array<{ sourcePath: string; text: string }>
    ): Promise<string> {
        const body = parts
            .map(p => p.text.trim())
            .filter(text => text.length > 0)
            .join('\n\n');
        return writeTranscript(
            this.app,
            this.plugin.settings.transcriptsFolder,
            this.mergedSourcePath(),
            body
        );
    }

    private async transcribeOne(
        sourcePath: string,
        provider: TranscriptionProvider,
        apiKey: string,
        model: string,
        row: FileRow
    ): Promise<string> {
        const settings = this.plugin.settings;
        const status = this.plugin.ffmpegStatus;
        row.stage = 'queued';
        row.progressEl.removeClass('is-error');
        row.progressEl.removeClass('is-skipped');
        row.progressEl.value = 0;

        if (!status.ok) {
            const { statSync } = await import('fs');
            const size = statSync(sourcePath).size;
            if (size > settings.maxFileSizeBytes) {
                throw new Error(
                    `File > ${settings.maxFileSizeBytes} bytes and ffmpeg is unavailable: ${status.error ?? 'not detected'}`
                );
            }
        }

        const onProgress = (event: TranscribeProgress): void => {
            row.stage = event.stage;
            const base = STAGE_LABELS[event.stage] ?? event.stage;
            const suffix =
                event.chunkIndex !== undefined && event.chunkTotal !== undefined
                    ? ` (${event.chunkIndex}/${event.chunkTotal})`
                    : '';
            row.statusEl.setText(`${base}${suffix}`);
            const next = stageToProgress(event.stage, event.pct);
            // Monotonic: the bar never regresses within a single file's run.
            if (next > row.progressEl.value) {
                row.progressEl.value = next;
            }
        };

        onProgress({ stage: 'queued', pct: 0 });

        const signal = this.abortController?.signal ?? new AbortController().signal;
        return provider.transcribe(sourcePath, apiKey, {
            model,
            languages: row.languages,
            signal,
            onProgress,
            maxFileSizeBytes: settings.maxFileSizeBytes,
            targetChunkBytes: settings.targetChunkBytes,
            maxChunkSecs: settings.maxChunkSecs,
            ffmpegPath: status.ok ? status.ffmpegPath : settings.ffmpegPath,
            ffprobePath: status.ok ? status.ffprobePath : settings.ffprobePath,
            videoExtensions: settings.videoExtensions
        });
    }

    private onCancel(): void {
        if (!this.running) return;
        this.abortController?.abort();
        showInAppNotice('Cancelling…');
    }
}
