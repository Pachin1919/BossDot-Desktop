export const SETTINGS_KEY: 'bossclaw-settings-v2';
export const LEGACY_SETTINGS_KEY: 'bossclaw-settings';
export function withoutModelSecrets<T>(model: T): Omit<T, 'apiKey' | 'hasStoredApiKey'>;
export function withoutSettingsSecrets<T>(state: T): T;
export function sanitizeSettingsSnapshot(snapshot: unknown): string | null;
