export interface ModelInfo {
    id: string;
    label?: string;
}

export type TranscribeStage =
    | 'queued'
    | 'probing'
    | 'splitting'
    | 'uploading'
    | 'writing'
    | 'done'
    | 'error';

export interface TranscribeProgress {
    stage: TranscribeStage;
    message?: string;
    pct?: number;
    chunkIndex?: number;
    chunkTotal?: number;
}

export interface TranscribeOptions {
    model: string;
    languages: string[];
    signal: AbortSignal;
    onProgress(event: TranscribeProgress): void;
    maxFileSizeBytes: number;
    targetChunkBytes: number;
    maxChunkSecs: number;
    ffmpegPath: string;
    ffprobePath: string;
}

export interface TranscriptionProvider {
    readonly id: string;
    readonly displayName: string;

    listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]>;
    transcribe(filePath: string, apiKey: string, opts: TranscribeOptions): Promise<string>;
}
