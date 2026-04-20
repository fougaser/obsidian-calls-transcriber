import { App, Modal, Notice, Setting } from 'obsidian';
import { basename } from 'path';
import type CallsTranscriberPlugin from './main';
import { listProviders, requireProvider } from './providers/registry';
import { TranscribeProgress, TranscribeStage, TranscriptionProvider } from './providers/types';
import { pickAudioFiles, pickFolder } from './fs/picker';
import { listAudioFilesInFolder } from './fs/walkAudio';
import { ensureProviderConfig } from './settings';
import { transcriptExists, writeTranscript } from './output/writer';
import { showInAppNotice, showOsNotification } from './ui/notify';

interface FileRow {
    sourcePath: string;
    statusEl: HTMLElement;
    progressEl: HTMLProgressElement;
    stage: TranscribeStage;
}

const STAGE_LABELS: Record<TranscribeStage, string> = {
    queued: 'Queued',
    probing: 'Probing audio',
    splitting: 'Splitting',
    uploading: 'Uploading',
    writing: 'Writing transcript',
    done: 'Done',
    error: 'Error'
};

export class TranscribeModal extends Modal {
    private readonly plugin: CallsTranscriberPlugin;

    private selectedFiles: string[] = [];
    private selectedSourceLabel = '';

    private pickFileBtn!: HTMLButtonElement;
    private pickFolderBtn!: HTMLButtonElement;
    private sourceLabelEl!: HTMLElement;

    private providerSelect!: HTMLSelectElement;
    private modelSelect!: HTMLSelectElement;
    private startBtn!: HTMLButtonElement;
    private cancelBtn!: HTMLButtonElement;
    private summaryEl!: HTMLElement;

    private filesWrap!: HTMLElement;
    private rowsByPath = new Map<string, FileRow>();

    private running = false;
    private abortController: AbortController | null = null;

    constructor(app: App, plugin: CallsTranscriberPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen(): void {
        this.titleEl.setText('Transcribe audio');
        this.contentEl.addClass('ct-modal');

        this.renderPicker();
        this.renderProviderControls();
        this.renderActions();
        this.renderSummary();
        this.renderFilesList();

        this.updateStartState();
    }

    onClose(): void {
        if (this.running) {
            this.abortController?.abort();
        }
        this.contentEl.empty();
        this.rowsByPath.clear();
    }

    private renderPicker(): void {
        const section = this.contentEl.createDiv({ cls: 'ct-section' });
        section.createEl('h3', { text: 'Source' });

        const buttons = section.createDiv({ cls: 'ct-row-buttons' });
        this.pickFileBtn = buttons.createEl('button', { text: 'Pick file(s)' });
        this.pickFileBtn.addEventListener('click', () => {
            void this.onPickFiles();
        });
        this.pickFolderBtn = buttons.createEl('button', { text: 'Pick folder' });
        this.pickFolderBtn.addEventListener('click', () => {
            void this.onPickFolder();
        });

        this.sourceLabelEl = section.createDiv({ cls: 'ct-source-label' });
        this.sourceLabelEl.setText('No source selected.');
    }

    private renderProviderControls(): void {
        const section = this.contentEl.createDiv({ cls: 'ct-section' });
        section.createEl('h3', { text: 'Provider & model' });

        new Setting(section)
            .setName('Provider')
            .addDropdown(dropdown => {
                for (const provider of listProviders()) {
                    dropdown.addOption(provider.id, provider.displayName);
                }
                const initial = listProviders().some(p => p.id === this.plugin.settings.defaultProviderId)
                    ? this.plugin.settings.defaultProviderId
                    : listProviders()[0]?.id ?? '';
                dropdown.setValue(initial);
                dropdown.onChange(() => this.refreshModelOptions());
                this.providerSelect = dropdown.selectEl;
            });

        new Setting(section).setName('Model').addDropdown(dropdown => {
            this.modelSelect = dropdown.selectEl;
            this.refreshModelOptions();
        });
    }

    private renderActions(): void {
        const actions = this.contentEl.createDiv({ cls: 'ct-actions' });
        this.startBtn = actions.createEl('button', { text: 'Start', cls: 'mod-cta' });
        this.startBtn.addEventListener('click', () => {
            void this.onStart();
        });
        this.cancelBtn = actions.createEl('button', { text: 'Cancel' });
        this.cancelBtn.addEventListener('click', () => this.onCancel());
        this.cancelBtn.setAttr('disabled', 'true');
    }

    private renderSummary(): void {
        this.summaryEl = this.contentEl.createDiv({ cls: 'ct-summary' });
    }

    private renderFilesList(): void {
        this.filesWrap = this.contentEl.createDiv({ cls: 'ct-files' });
    }

    private refreshModelOptions(): void {
        this.modelSelect.empty();
        const providerId = this.providerSelect.value;
        const cfg = ensureProviderConfig(this.plugin.settings, providerId);
        const models = cfg.enabledModels.slice().sort((a, b) => a.localeCompare(b));
        if (models.length === 0) {
            const opt = this.modelSelect.createEl('option');
            opt.value = '';
            opt.text = '(no enabled models — configure in settings)';
            opt.disabled = true;
            opt.selected = true;
            this.updateStartState();
            return;
        }
        for (const id of models) {
            const opt = this.modelSelect.createEl('option');
            opt.value = id;
            opt.text = id;
        }
        const preferred = models.includes(cfg.defaultModel) ? cfg.defaultModel : models[0];
        this.modelSelect.value = preferred;
        this.updateStartState();
    }

    private updateStartState(): void {
        const hasFiles = this.selectedFiles.length > 0;
        const hasModel = this.modelSelect.value.length > 0;
        const providerCfg = ensureProviderConfig(this.plugin.settings, this.providerSelect.value);
        const hasKey = providerCfg.apiKey.length > 0;
        const enabled = !this.running && hasFiles && hasModel && hasKey;
        this.startBtn.disabled = !enabled;
        this.summaryEl.empty();
        if (!hasKey) {
            this.summaryEl.setText('API key for selected provider is missing. Add it in settings.');
            return;
        }
        if (!hasFiles) {
            this.summaryEl.setText('Pick a file or folder to begin.');
            return;
        }
        this.summaryEl.setText(
            this.selectedFiles.length === 1
                ? `1 file queued from ${this.selectedSourceLabel}.`
                : `${this.selectedFiles.length} files queued from ${this.selectedSourceLabel}.`
        );
    }

    private async onPickFiles(): Promise<void> {
        try {
            const result = await pickAudioFiles(this.plugin.settings.audioExtensions);
            if (result.files.length === 0) return;
            this.setSelection(result.files, 'selected files');
        } catch (err) {
            new Notice((err as Error).message, 8000);
        }
    }

    private async onPickFolder(): Promise<void> {
        try {
            const folder = await pickFolder();
            if (!folder) return;
            const files = listAudioFilesInFolder(folder, this.plugin.settings.audioExtensions);
            if (files.length === 0) {
                new Notice(`No audio files in ${folder}.`, 6000);
                return;
            }
            this.setSelection(files, folder);
        } catch (err) {
            new Notice((err as Error).message, 8000);
        }
    }

    private setSelection(files: string[], label: string): void {
        this.selectedFiles = files;
        this.selectedSourceLabel = label;
        this.sourceLabelEl.setText(`${label}: ${files.length} file(s).`);
        this.rowsByPath.clear();
        this.filesWrap.empty();
        for (const file of files) {
            this.rowsByPath.set(file, this.createFileRow(file));
        }
        this.updateStartState();
    }

    private createFileRow(sourcePath: string): FileRow {
        const row = this.filesWrap.createDiv({ cls: 'ct-file-row' });
        row.createDiv({ cls: 'ct-file-name', text: basename(sourcePath) });
        const meta = row.createDiv({ cls: 'ct-file-meta' });
        const statusEl = meta.createSpan({ cls: 'ct-file-status', text: STAGE_LABELS.queued });
        const progressEl = row.createEl('progress') as HTMLProgressElement;
        progressEl.max = 1;
        progressEl.value = 0;
        return { sourcePath, statusEl, progressEl, stage: 'queued' };
    }

    private async onStart(): Promise<void> {
        if (this.running || this.selectedFiles.length === 0) return;
        const providerId = this.providerSelect.value;
        const provider = requireProvider(providerId);
        const cfg = ensureProviderConfig(this.plugin.settings, providerId);
        const model = this.modelSelect.value;
        if (model.length === 0) {
            new Notice('Select a model first.', 5000);
            return;
        }

        this.running = true;
        this.abortController = new AbortController();
        this.startBtn.disabled = true;
        this.cancelBtn.removeAttribute('disabled');
        this.pickFileBtn.disabled = true;
        this.pickFolderBtn.disabled = true;

        let successes = 0;
        let skipped = 0;
        let failures = 0;
        let aborted = false;

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

                    await this.transcribeOne(sourcePath, provider, cfg.apiKey, model, row);
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
        } finally {
            this.running = false;
            this.abortController = null;
            this.cancelBtn.setAttr('disabled', 'true');
            this.pickFileBtn.disabled = false;
            this.pickFolderBtn.disabled = false;
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

    private async transcribeOne(
        sourcePath: string,
        provider: TranscriptionProvider,
        apiKey: string,
        model: string,
        row: FileRow
    ): Promise<void> {
        const settings = this.plugin.settings;
        const status = this.plugin.ffmpegStatus;
        row.stage = 'queued';
        row.progressEl.removeClass('is-error');
        row.progressEl.removeClass('is-skipped');
        row.progressEl.value = 0;

        if (!this.plugin.ffmpegStatus.ok) {
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
            if (typeof event.pct === 'number') {
                row.progressEl.value = Math.max(0, Math.min(1, event.pct));
            }
        };

        onProgress({ stage: 'queued', pct: 0 });

        const signal = this.abortController?.signal ?? new AbortController().signal;
        const text = await provider.transcribe(sourcePath, apiKey, {
            model,
            languages: settings.languages,
            signal,
            onProgress,
            maxFileSizeBytes: settings.maxFileSizeBytes,
            targetChunkBytes: settings.targetChunkBytes,
            maxChunkSecs: settings.maxChunkSecs,
            ffmpegPath: settings.ffmpegPath || (status.ok ? status.ffmpegPath : 'ffmpeg'),
            ffprobePath: settings.ffprobePath || (status.ok ? status.ffprobePath : 'ffprobe')
        });

        onProgress({ stage: 'writing', pct: 1 });
        const written = await writeTranscript(this.app, settings.transcriptsFolder, sourcePath, text);
        row.stage = 'done';
        row.statusEl.setText(`Saved to ${written}`);
        row.progressEl.value = 1;
    }

    private onCancel(): void {
        if (!this.running) return;
        this.abortController?.abort();
        showInAppNotice('Cancelling…');
    }
}
