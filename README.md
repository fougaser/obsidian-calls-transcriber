<div align="center">

# Calls Transcriber

### Drop-in audio transcription for Obsidian — pick a file or folder, watch the progress, get a .txt in your vault.

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5.0+-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Platform](https://img.shields.io/badge/platform-desktop-444)](#compatibility)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stability](https://img.shields.io/badge/stability-alpha-EF4444)](#status)

<sub>Provider-agnostic transcription. OpenAI Whisper is the first provider; more can be added without touching the modal or settings code.</sub>

</div>

---

## Features

- **Pick a file or a folder** from anywhere on disk via a native picker.
- **Per-file progress bars** and a clean cancel button.
- **Automatic chunking** of files larger than the provider's upload limit (via system `ffmpeg`).
- **Multi-language hints** for Whisper-style providers.
- **Tabbed settings** — General, Providers, Languages, Advanced.
- **Pluggable providers** — a small `TranscriptionProvider` interface; register a new file to add a new backend.
- **Desktop notification** when the batch finishes (optional).

## Requirements

- Obsidian 1.5+
- Desktop only (Electron APIs for file pickers and `child_process` for ffmpeg).
- `ffmpeg` and `ffprobe` on `PATH` if you want automatic chunking of files > 25 MB. Without them, large files surface a clear error.
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg` (or download from <https://www.gyan.dev/ffmpeg/builds/>)
  - Linux: your package manager's `ffmpeg` package.

## Installation

```bash
git clone https://github.com/fougaser/obsidian-calls-transcriber.git
cd obsidian-calls-transcriber
npm install
npm run build
```

Symlink (or copy) the three artifacts into your vault's plugin folder:

```bash
mkdir -p <vault>/.obsidian/plugins/obsidian-calls-transcriber
ln -s "$PWD/main.js"       <vault>/.obsidian/plugins/obsidian-calls-transcriber/main.js
ln -s "$PWD/manifest.json" <vault>/.obsidian/plugins/obsidian-calls-transcriber/manifest.json
ln -s "$PWD/styles.css"    <vault>/.obsidian/plugins/obsidian-calls-transcriber/styles.css
```

Enable the plugin under `Settings → Community plugins`, then open the settings tab to paste your OpenAI API key and pick a transcripts folder.

## Usage

1. Click the microphone ribbon icon, or run `Calls Transcriber: Open transcriber` from the command palette.
2. Choose a file or a folder via the picker buttons.
3. Pick a provider and model (defaults match your settings).
4. Press **Start**. Watch progress per file. Cancel whenever.
5. The `.txt` transcripts land in the transcripts folder you configured in settings, named after the source audio file.

## Adding a new provider

Implement `TranscriptionProvider` in a new file under `src/providers/` and register it in `src/providers/registry.ts`. No other code needs to change.

## Compatibility

- Obsidian 1.5+
- macOS, Windows, Linux (desktop)

## License

[MIT](./LICENSE) © fougaser.
