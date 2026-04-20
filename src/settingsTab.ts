import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type CallsTranscriberPlugin from './main';
import { renderTabs, TabDefinition } from './ui/tabs';
import { listProviders } from './providers/registry';
import { DEFAULT_AUDIO_EXTENSIONS, parseExtensionList } from './audio/extensions';
import { ensureProviderConfig, ProviderConfig } from './settings';

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
        new Setting(panel)
            .setName('Transcripts folder')
            .setDesc('Vault-relative folder where .txt transcripts are saved. Created if missing. Leave empty to write to the vault root.')
            .addText(text =>
                text
                    .setPlaceholder('Transcripts')
                    .setValue(this.plugin.settings.transcriptsFolder)
                    .onChange(async value => {
                        await this.plugin.updateSettings({ transcriptsFolder: value.trim() });
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
            .setDesc('When batch-transcribing a folder, skip source files whose .txt already exists in the transcripts folder.')
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
        new Setting(section)
            .setName('API key')
            .setDesc(`Stored in the vault's plugin data. Used only when calling ${providerLabel}.`)
            .addText(text => {
                text.inputEl.type = 'password';
                text
                    .setPlaceholder('sk-...')
                    .setValue(cfg.apiKey)
                    .onChange(async value => {
                        cfg.apiKey = value.trim();
                        await this.plugin.saveSettings();
                    });
            });

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

        const known = new Set<string>();
        for (const id of cfg.discoveredModels) known.add(id);
        for (const id of cfg.customModels) known.add(id);
        for (const id of cfg.enabledModels) known.add(id);

        if (known.size === 0) {
            container.createEl('p', {
                text: 'No models loaded yet. Set the API key and click "Refresh" to fetch available transcription models.',
                cls: 'setting-item-description'
            });
            return;
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
                'Comma-separated language codes (e.g. en, ru, de). With one code, it is passed as the language parameter. ' +
                'With two or more, a hint prompt is added for the provider. Leave empty to let the provider auto-detect.'
        });

        new Setting(panel)
            .setName('Language codes')
            .addText(text =>
                text
                    .setPlaceholder('en, ru')
                    .setValue(this.plugin.settings.languages.join(', '))
                    .onChange(async value => {
                        const parsed = value
                            .split(',')
                            .map(x => x.trim().toLowerCase())
                            .filter(x => x.length > 0);
                        await this.plugin.updateSettings({ languages: parsed });
                    })
            );

        const examples = panel.createEl('details');
        examples.createEl('summary', { text: 'Supported code examples' });
        const list = examples.createEl('ul');
        for (const [code, name] of Object.entries({
            en: 'English',
            ru: 'Russian',
            de: 'German',
            fr: 'French',
            es: 'Spanish',
            it: 'Italian',
            pt: 'Portuguese',
            zh: 'Chinese',
            ja: 'Japanese',
            ko: 'Korean',
            ar: 'Arabic',
            hi: 'Hindi'
        })) {
            list.createEl('li', { text: `${code} — ${name}` });
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
            .setName('Max file size (bytes)')
            .setDesc(`Files larger than this trigger chunking. OpenAI currently allows 25 MB. Default: ${25 * 1024 * 1024}.`)
            .addText(text =>
                text
                    .setPlaceholder(String(25 * 1024 * 1024))
                    .setValue(String(this.plugin.settings.maxFileSizeBytes))
                    .onChange(async value => {
                        const n = Number(value);
                        if (Number.isFinite(n) && n > 0) {
                            await this.plugin.updateSettings({ maxFileSizeBytes: Math.floor(n) });
                        }
                    })
            );

        new Setting(panel)
            .setName('Target chunk size (bytes)')
            .setDesc(`Aimed-for size of each ffmpeg-produced chunk. Default: ${23 * 1024 * 1024}.`)
            .addText(text =>
                text
                    .setPlaceholder(String(23 * 1024 * 1024))
                    .setValue(String(this.plugin.settings.targetChunkBytes))
                    .onChange(async value => {
                        const n = Number(value);
                        if (Number.isFinite(n) && n > 0) {
                            await this.plugin.updateSettings({ targetChunkBytes: Math.floor(n) });
                        }
                    })
            );

        new Setting(panel)
            .setName('Max chunk duration (seconds)')
            .setDesc('Upper bound on chunk length. Default: 1200 (20 minutes).')
            .addText(text =>
                text
                    .setPlaceholder('1200')
                    .setValue(String(this.plugin.settings.maxChunkSecs))
                    .onChange(async value => {
                        const n = Number(value);
                        if (Number.isFinite(n) && n > 0) {
                            await this.plugin.updateSettings({ maxChunkSecs: Math.floor(n) });
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
    }
}
