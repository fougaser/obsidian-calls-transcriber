export interface LanguageChip {
    code: string;
    label: string;
}

export const AVAILABLE_LANGUAGE_CHIPS: ReadonlyArray<LanguageChip> = [
    { code: 'en', label: 'EN' },
    { code: 'ru', label: 'RU' }
];
