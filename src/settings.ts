import { DEFAULT_AUDIO_EXTENSIONS, normalizeExtension } from './audio/extensions';

export interface ProviderConfig {
    apiKey: string;
    enabledModels: string[];
    defaultModel: string;
    customModels: string[];
    discoveredModels: string[];
}

export interface TranscriberSettings {
    transcriptsFolder: string;
    defaultProviderId: string;
    skipIfExists: boolean;
    osNotification: boolean;
    languages: string[];
    providers: Record<string, ProviderConfig>;
    ffmpegPath: string;
    ffprobePath: string;
    maxFileSizeBytes: number;
    targetChunkBytes: number;
    maxChunkSecs: number;
    audioExtensions: string[];
}

export const OPENAI_PROVIDER_ID = 'openai';

export const DEFAULT_OPENAI_CONFIG: ProviderConfig = {
    apiKey: '',
    enabledModels: ['whisper-1'],
    defaultModel: 'whisper-1',
    customModels: [],
    discoveredModels: []
};

export const DEFAULT_SETTINGS: TranscriberSettings = {
    transcriptsFolder: '',
    defaultProviderId: OPENAI_PROVIDER_ID,
    skipIfExists: true,
    osNotification: false,
    languages: [],
    providers: {
        [OPENAI_PROVIDER_ID]: { ...DEFAULT_OPENAI_CONFIG }
    },
    ffmpegPath: '',
    ffprobePath: '',
    maxFileSizeBytes: 25 * 1024 * 1024,
    targetChunkBytes: 23 * 1024 * 1024,
    maxChunkSecs: 20 * 60,
    audioExtensions: [...DEFAULT_AUDIO_EXTENSIONS]
};

function sanitizeStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item === 'string' && item.length > 0) out.push(item);
    }
    return out;
}

function sanitizeExtensions(value: unknown): string[] | null {
    const arr = sanitizeStringArray(value);
    if (!arr) return null;
    const normalized = arr.map(normalizeExtension).filter(x => x.length > 0);
    return normalized.length > 0 ? normalized : null;
}

function sanitizePositiveInt(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    return fallback;
}

function sanitizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function sanitizeBool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function sanitizeProvider(stored: unknown, fallback: ProviderConfig): ProviderConfig {
    const s = (stored ?? {}) as Partial<ProviderConfig>;
    const enabledModels = sanitizeStringArray(s.enabledModels) ?? [...fallback.enabledModels];
    const customModels = sanitizeStringArray(s.customModels) ?? [...fallback.customModels];
    const discoveredModels = sanitizeStringArray(s.discoveredModels) ?? [...fallback.discoveredModels];
    const defaultModel =
        typeof s.defaultModel === 'string' && s.defaultModel.length > 0 ? s.defaultModel : fallback.defaultModel;
    return {
        apiKey: sanitizeString(s.apiKey, fallback.apiKey),
        enabledModels,
        defaultModel,
        customModels,
        discoveredModels
    };
}

export function mergeSettings(stored: Partial<TranscriberSettings> | null): TranscriberSettings {
    const providers: Record<string, ProviderConfig> = {};
    providers[OPENAI_PROVIDER_ID] = sanitizeProvider(
        stored?.providers?.[OPENAI_PROVIDER_ID],
        DEFAULT_OPENAI_CONFIG
    );
    if (stored?.providers && typeof stored.providers === 'object') {
        for (const [id, value] of Object.entries(stored.providers)) {
            if (id === OPENAI_PROVIDER_ID) continue;
            providers[id] = sanitizeProvider(value, DEFAULT_OPENAI_CONFIG);
        }
    }

    return {
        transcriptsFolder: sanitizeString(stored?.transcriptsFolder, DEFAULT_SETTINGS.transcriptsFolder),
        defaultProviderId:
            typeof stored?.defaultProviderId === 'string' && stored.defaultProviderId.length > 0
                ? stored.defaultProviderId
                : DEFAULT_SETTINGS.defaultProviderId,
        skipIfExists: sanitizeBool(stored?.skipIfExists, DEFAULT_SETTINGS.skipIfExists),
        osNotification: sanitizeBool(stored?.osNotification, DEFAULT_SETTINGS.osNotification),
        languages: sanitizeStringArray(stored?.languages) ?? [...DEFAULT_SETTINGS.languages],
        providers,
        ffmpegPath: sanitizeString(stored?.ffmpegPath, DEFAULT_SETTINGS.ffmpegPath),
        ffprobePath: sanitizeString(stored?.ffprobePath, DEFAULT_SETTINGS.ffprobePath),
        maxFileSizeBytes: sanitizePositiveInt(stored?.maxFileSizeBytes, DEFAULT_SETTINGS.maxFileSizeBytes),
        targetChunkBytes: sanitizePositiveInt(stored?.targetChunkBytes, DEFAULT_SETTINGS.targetChunkBytes),
        maxChunkSecs: sanitizePositiveInt(stored?.maxChunkSecs, DEFAULT_SETTINGS.maxChunkSecs),
        audioExtensions: sanitizeExtensions(stored?.audioExtensions) ?? [...DEFAULT_SETTINGS.audioExtensions]
    };
}

export function ensureProviderConfig(
    settings: TranscriberSettings,
    providerId: string
): ProviderConfig {
    if (!settings.providers[providerId]) {
        settings.providers[providerId] = { ...DEFAULT_OPENAI_CONFIG };
    }
    return settings.providers[providerId];
}
