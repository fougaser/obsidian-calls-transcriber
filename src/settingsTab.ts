import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type CallsTranscriberPlugin from './main';
import { renderTabs, TabDefinition } from './ui/tabs';
import { listProviders, requireProvider } from './providers/registry';
import {
    DEFAULT_AUDIO_EXTENSIONS,
    DEFAULT_VIDEO_EXTENSIONS,
    parseExtensionList
} from './audio/extensions';
import { AVAILABLE_LANGUAGE_CHIPS } from './ui/languageChips';
import { ensureProviderConfig, ProviderConfig } from './settings';

class VaultFolderSuggestModal extends FuzzySuggestModal<TFolder> {
    constructor(app: App, private readonly onPick: (folder: TFolder) => void) {
        super(app);
        this.setPlaceholder('Select a vault folder');
    }

    getItems(): TFolder[] {
        const folders: TFolder[] = [];
        for (const file of this.app.vault.getAllLoadedFiles()) {
            if (file instanceof TFolder) folders.push(file);
        }
        folders.sort((a, b) => a.path.localeCompare(b.path));
        return folders;
    }

    getItemText(folder: TFolder): string {
        return folder.path.length === 0 ? '/' : folder.path;
    }

    onChooseItem(folder: TFolder): void {
        this.onPick(folder);
    }
}

function bytesToMb(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return Number.isInteger(mb) ? String(mb) : mb.toFixed(2).replace(/\.?0+$/, '');
}

function secsToMinutes(secs: number): string {
    const mins = secs / 60;
    return Number.isInteger(mins) ? String(mins) : mins.toFixed(2).replace(/\.?0+$/, '');
}

export class CallsTranscriberSettingTab extends PluginSettingTab {
    private readonly plugin: CallsTranscriberPlugin;
    private activeTabId = 'general';

    constructor(app: App, plugin: CallsTranscriberPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('ct-settings');

        containerEl.createEl('h2', { text: 'Calls Transcriber' });

        const tabs: TabDefinition[] = [
            { id: 'general', label: 'General', render: panel => this.renderGeneral(panel) },
            { id: 'providers', label: 'Providers', render: panel => this.renderProviders(panel) },
            { id: 'languages', label: 'Languages', render: panel => this.renderLanguages(panel) },
            { id: 'advanced', label: 'Advanced', render: panel => this.renderAdvanced(panel) }
        ];

        const controller = renderTabs(containerEl, tabs, this.activeTabId);
        const origActivate = controller.activateTab;
        controller.activateTab = (id: string) => {
            this.activeTabId = id;
            origActivate(id);
        };
    }

    private renderGeneral(panel: HTMLElement): void {
        const transcriptsFolderRow = new Setting(panel)
            .setName('Transcripts folder')
            .setDesc('Vault-relative folder where transcript .md files are saved. Created if missing. Leave empty to write to the vault root.');

        let transcriptsFolderInput: HTMLInputElement | null = null;
        transcriptsFolderRow.addText(text => {
            transcriptsFolderInput = text.inputEl;
            text
                .setPlaceholder('Transcripts')
                .setValue(this.plugin.settings.transcriptsFolder)
                .onChange(async value => {
                    await this.plugin.updateSettings({ transcriptsFolder: value.trim() });
                });
        });

        transcriptsFolderRow.addExtraButton(btn =>
            btn
                .setIcon('folder-open')
                .setTooltip('Pick a vault folder')
                .onClick(() => {
                    new VaultFolderSuggestModal(this.app, async folder => {
                        const path = folder.path;
                        if (transcriptsFolderInput) transcriptsFolderInput.value = path;
                        await this.plugin.updateSettings({ transcriptsFolder: path });
                    }).open();
                })
        );

        new Setting(panel)
            .setName('Default provider')
            .setDesc('The provider pre-selected in the transcribe modal.')
            .addDropdown(dropdown => {
                for (const provider of listProviders()) {
                    dropdown.addOption(provider.id, provider.displayName);
                }
                dropdown
                    .setValue(this.plugin.settings.defaultProviderId)
                    .onChange(async value => {
                        await this.plugin.updateSettings({ defaultProviderId: value });
                    });
            });

        new Setting(panel)
            .setName('Skip if transcript exists')
            .setDesc('When batch-transcribing a folder, skip source files whose .md transcript already exists in the transcripts folder.')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.skipIfExists).onChange(async value => {
                    await this.plugin.updateSettings({ skipIfExists: value });
                })
            );

        new Setting(panel)
            .setName('OS notification on completion')
            .setDesc('Post a desktop notification when a batch finishes (in addition to the in-app notice).')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.osNotification).onChange(async value => {
                    await this.plugin.updateSettings({ osNotification: value });
                })
            );
    }

    private renderProviders(panel: HTMLElement): void {
        for (const provider of listProviders()) {
            const section = panel.createDiv({ cls: 'ct-provider-section' });
            section.createEl('h3', { text: provider.displayName });
            const cfg = ensureProviderConfig(this.plugin.settings, provider.id);
            this.renderProviderBlock(section, provider.id, provider.displayName, cfg);
        }
    }

    private renderProviderBlock(
        section: HTMLElement,
        providerId: string,
        providerLabel: string,
        cfg: ProviderConfig
    ): void {
        const apiKeyRow = new Setting(section)
            .setName('API key')
            .setDesc(`Stored in the vault's plugin data. Used only when calling ${providerLabel}.`);

        let apiKeyInput: HTMLInputElement | null = null;
        let revealed = false;

        apiKeyRow.addText(text => {
            apiKeyInput = text.inputEl;
            text.inputEl.type = 'password';
            text
                .setPlaceholder('sk-...')
                .setValue(cfg.apiKey)
                .onChange(async value => {
                    cfg.apiKey = value.trim();
                    await this.plugin.saveSettings();
                });
        });

        apiKeyRow.addExtraButton(btn =>
            btn
                .setIcon('eye')
                .setTooltip('Reveal API key')
                .onClick(() => {
                    if (!apiKeyInput) return;
                    revealed = !revealed;
                    apiKeyInput.type = revealed ? 'text' : 'password';
                    btn.setIcon(revealed ? 'eye-off' : 'eye');
                    btn.setTooltip(revealed ? 'Hide API key' : 'Reveal API key');
                })
        );

        const modelsContainer = section.createDiv({ cls: 'ct-models' });
        this.renderModels(modelsContainer, providerId, cfg);

        new Setting(section)
            .setName('Refresh models')
            .setDesc('Fetch the latest list of speech-to-text models from the provider. Existing toggles are preserved.')
            .addButton(button =>
                button
                    .setButtonText('Refresh')
                    .setCta()
                    .onClick(async () => {
                        await this.refreshModelsFor(providerId);
                        modelsContainer.empty();
                        this.renderModels(modelsContainer, providerId, ensureProviderConfig(this.plugin.settings, providerId));
                    })
            );

        const customRow = new Setting(section)
            .setName('Add custom model id')
            .setDesc('Use this to add a transcription model id that the provider\'s models endpoint did not return.');
        let customInput = '';
        customRow.addText(text =>
            text.setPlaceholder('gpt-5-audio-transcribe').onChange(value => {
                customInput = value.trim();
            })
        );
        customRow.addButton(button =>
            button.setButtonText('Add').onClick(async () => {
                if (customInput.length === 0) return;
                const fresh = ensureProviderConfig(this.plugin.settings, providerId);
                if (!fresh.customModels.includes(customInput)) {
                    fresh.customModels.push(customInput);
                }
                if (!fresh.enabledModels.includes(customInput)) {
                    fresh.enabledModels.push(customInput);
                }
                if (fresh.defaultModel.length === 0) {
                    fresh.defaultModel = customInput;
                }
                await this.plugin.saveSettings();
                customInput = '';
                modelsContainer.empty();
                this.renderModels(modelsContainer, providerId, fresh);
            })
        );
    }

    private renderModels(container: HTMLElement, providerId: string, cfg: ProviderConfig): void {
        const header = container.createEl('h4', { text: 'Available models' });
        header.style.marginBottom = '6px';

        const provider = requireProvider(providerId);
        const known = new Set<string>();
        for (const model of provider.knownModels()) known.add(model.id);
        for (const id of cfg.discoveredModels) known.add(id);
        for (const id of cfg.customModels) known.add(id);
        for (const id of cfg.enabledModels) known.add(id);

        if (known.size === 0) {
            container.createEl('p', {
                text: 'No models known yet. Set the API key and click "Refresh" to fetch available transcription models.',
                cls: 'setting-item-description'
            });
            return;
        }

        if (cfg.discoveredModels.length === 0) {
            container.createEl('p', {
                text: 'Built-in list shown below. Click "Refresh" after entering your API key to discover any newer models OpenAI has published.',
                cls: 'setting-item-description'
            });
        }

        const sorted = Array.from(known).sort((a, b) => a.localeCompare(b));

        for (const id of sorted) {
            const row = new Setting(container).setName(id);
            const isCustom = cfg.customModels.includes(id);
            if (isCustom) row.setDesc('Custom model id');
            row.addToggle(toggle =>
                toggle.setValue(cfg.enabledModels.includes(id)).onChange(async value => {
                    const fresh = ensureProviderConfig(this.plugin.settings, providerId);
                    if (value) {
                        if (!fresh.enabledModels.includes(id)) fresh.enabledModels.push(id);
                    } else {
                        fresh.enabledModels = fresh.enabledModels.filter(m => m !== id);
                    }
                    if (fresh.defaultModel === id && !value) {
                        fresh.defaultModel = fresh.enabledModels[0] ?? '';
                    }
                    if (value && fresh.defaultModel.length === 0) {
                        fresh.defaultModel = id;
                    }
                    await this.plugin.saveSettings();
                })
            );
            if (isCustom) {
                row.addExtraButton(btn =>
                    btn
                        .setIcon('trash')
                        .setTooltip('Remove custom model id')
                        .onClick(async () => {
                            const fresh = ensureProviderConfig(this.plugin.settings, providerId);
                            fresh.customModels = fresh.customModels.filter(m => m !== id);
                            fresh.enabledModels = fresh.enabledModels.filter(m => m !== id);
                            if (fresh.defaultModel === id) {
                                fresh.defaultModel = fresh.enabledModels[0] ?? '';
                            }
                            await this.plugin.saveSettings();
                            container.empty();
                            this.renderModels(container, providerId, fresh);
                        })
                );
            }
        }

        new Setting(container)
            .setName('Default model')
            .setDesc('Pre-selected in the transcribe modal. Only enabled models appear here.')
            .addDropdown(dropdown => {
                const options = cfg.enabledModels.slice().sort((a, b) => a.localeCompare(b));
                if (options.length === 0) {
                    dropdown.addOption('', '(no enabled models)');
                    dropdown.setDisabled(true);
                    return;
                }
                for (const id of options) dropdown.addOption(id, id);
                const current = options.includes(cfg.defaultModel) ? cfg.defaultModel : options[0];
                dropdown.setValue(current).onChange(async value => {
                    const fresh = ensureProviderConfig(this.plugin.settings, providerId);
                    fresh.defaultModel = value;
                    await this.plugin.saveSettings();
                });
            });
    }

    private async refreshModelsFor(providerId: string): Promise<void> {
        try {
            await this.plugin.refreshProviderModels(providerId);
            new Notice(`Refreshed ${providerId} models.`);
        } catch (err) {
            new Notice(`Failed to refresh models: ${(err as Error).message}`, 8000);
        }
    }

    private renderLanguages(panel: HTMLElement): void {
        panel.createEl('p', {
            cls: 'setting-item-description',
            text:
                'Default languages pre-selected on each file added to the transcriber. With one active, it is sent as the language parameter; with multiple, a prompt hint is added. None active = auto-detect.'
        });

        const row = new Setting(panel).setName('Default languages');
        const chipsWrap = row.controlEl.createDiv({ cls: 'ct-lang-chips' });

        for (const { code, label } of AVAILABLE_LANGUAGE_CHIPS) {
            const chip = chipsWrap.createEl('button', {
                cls: 'ct-lang-chip',
                text: label,
                attr: { type: 'button', title: `Toggle ${label} by default` }
            });
            if (this.plugin.settings.languages.includes(code)) chip.addClass('is-active');
            chip.addEventListener('click', async () => {
                const current = this.plugin.settings.languages.slice();
                const idx = current.indexOf(code);
                if (idx >= 0) {
                    current.splice(idx, 1);
                    chip.removeClass('is-active');
                } else {
                    current.push(code);
                    chip.addClass('is-active');
                }
                await this.plugin.updateSettings({ languages: current });
            });
        }
    }

    private renderAdvanced(panel: HTMLElement): void {
        new Setting(panel)
            .setName('ffmpeg path')
            .setDesc('Leave empty to auto-detect from PATH. Set only if your ffmpeg binary is not on PATH.')
            .addText(text =>
                text
                    .setPlaceholder('ffmpeg')
                    .setValue(this.plugin.settings.ffmpegPath)
                    .onChange(async value => {
                        await this.plugin.updateSettings({ ffmpegPath: value.trim() });
                    })
            );

        new Setting(panel)
            .setName('ffprobe path')
            .setDesc('Leave empty to auto-detect from PATH.')
            .addText(text =>
                text
                    .setPlaceholder('ffprobe')
                    .setValue(this.plugin.settings.ffprobePath)
                    .onChange(async value => {
                        await this.plugin.updateSettings({ ffprobePath: value.trim() });
                    })
            );

        new Setting(panel)
            .setName('Re-detect ffmpeg')
            .setDesc('Current status shown below. Click to re-run detection after changing paths or installing ffmpeg.')
            .addButton(button =>
                button.setButtonText('Re-detect').onClick(async () => {
                    const status = await this.plugin.redetectFfmpeg();
                    new Notice(
                        status.ok
                            ? `ffmpeg: ${status.ffmpegPath}\nffprobe: ${status.ffprobePath}`
                            : `ffmpeg unavailable: ${status.error ?? 'unknown error'}`,
                        8000
                    );
                    this.display();
                })
            );

        const statusEl = panel.createDiv({ cls: 'setting-item-description ct-ffmpeg-status' });
        const status = this.plugin.ffmpegStatus;
        if (status.ok) {
            statusEl.setText(`✓ ffmpeg at ${status.ffmpegPath} | ffprobe at ${status.ffprobePath}`);
            statusEl.addClass('is-ok');
        } else if (status.error) {
            statusEl.setText(`✗ ${status.error}`);
            statusEl.addClass('is-err');
        } else {
            statusEl.setText('ffmpeg not detected yet. Click "Re-detect" to probe.');
        }

        new Setting(panel)
            .setName('Max file size (MB)')
            .setDesc('Files larger than this trigger chunking. OpenAI currently allows 25 MB. Default: 25.')
            .addText(text =>
                text
                    .setPlaceholder('25')
                    .setValue(bytesToMb(this.plugin.settings.maxFileSizeBytes))
                    .onChange(async value => {
                        const mb = Number(value);
                        if (Number.isFinite(mb) && mb > 0) {
                            await this.plugin.updateSettings({ maxFileSizeBytes: Math.round(mb * 1024 * 1024) });
                        }
                    })
            );

        new Setting(panel)
            .setName('Target chunk size (MB)')
            .setDesc('Aimed-for size of each ffmpeg-produced chunk. Default: 23.')
            .addText(text =>
                text
                    .setPlaceholder('23')
                    .setValue(bytesToMb(this.plugin.settings.targetChunkBytes))
                    .onChange(async value => {
                        const mb = Number(value);
                        if (Number.isFinite(mb) && mb > 0) {
                            await this.plugin.updateSettings({ targetChunkBytes: Math.round(mb * 1024 * 1024) });
                        }
                    })
            );

        new Setting(panel)
            .setName('Max chunk duration (minutes)')
            .setDesc('Upper bound on chunk length. Default: 20.')
            .addText(text =>
                text
                    .setPlaceholder('20')
                    .setValue(secsToMinutes(this.plugin.settings.maxChunkSecs))
                    .onChange(async value => {
                        const mins = Number(value);
                        if (Number.isFinite(mins) && mins > 0) {
                            await this.plugin.updateSettings({ maxChunkSecs: Math.round(mins * 60) });
                        }
                    })
            );

        new Setting(panel)
            .setName('Audio file extensions')
            .setDesc(`Comma-separated. Default: ${DEFAULT_AUDIO_EXTENSIONS.join(', ')}`)
            .addText(text =>
                text
                    .setPlaceholder(DEFAULT_AUDIO_EXTENSIONS.join(', '))
                    .setValue(this.plugin.settings.audioExtensions.join(', '))
                    .onChange(async value => {
                        const parsed = parseExtensionList(value);
                        if (parsed.length > 0) {
                            await this.plugin.updateSettings({ audioExtensions: parsed });
                        }
                    })
            );

        new Setting(panel)
            .setName('Video file extensions')
            .setDesc(
                `Videos selected via file/folder picker have their audio track extracted to a temporary mp3 before transcription (requires ffmpeg). Default: ${DEFAULT_VIDEO_EXTENSIONS.join(', ')}`
            )
            .addText(text =>
                text
                    .setPlaceholder(DEFAULT_VIDEO_EXTENSIONS.join(', '))
                    .setValue(this.plugin.settings.videoExtensions.join(', '))
                    .onChange(async value => {
                        const parsed = parseExtensionList(value);
                        if (parsed.length > 0) {
                            await this.plugin.updateSettings({ videoExtensions: parsed });
                        }
                    })
            );
    }
}
