import { OpenAIProvider } from './openai';
import { TranscriptionProvider } from './types';

const providers: TranscriptionProvider[] = [new OpenAIProvider()];

export function listProviders(): TranscriptionProvider[] {
    return providers.slice();
}

export function getProvider(id: string): TranscriptionProvider | undefined {
    return providers.find(p => p.id === id);
}

export function requireProvider(id: string): TranscriptionProvider {
    const provider = getProvider(id);
    if (!provider) {
        throw new Error(`Unknown transcription provider: ${id}`);
    }
    return provider;
}
