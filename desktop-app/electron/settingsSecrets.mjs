export const SETTINGS_KEY = 'bossclaw-settings-v2';
export const LEGACY_SETTINGS_KEY = 'bossclaw-settings';

export function withoutModelSecrets(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return model;
  const clean = { ...model };
  delete clean.apiKey;
  delete clean.hasStoredApiKey;
  return clean;
}

export function withoutSettingsSecrets(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const clean = { ...state };
  if (clean.config?.model) clean.config = { ...clean.config, model: withoutModelSecrets(clean.config.model) };
  if (clean.savedModelConfigs && typeof clean.savedModelConfigs === 'object') {
    clean.savedModelConfigs = Object.fromEntries(Object.entries(clean.savedModelConfigs)
      .map(([provider, model]) => [provider, withoutModelSecrets(model)]));
  }
  return clean;
}

export function sanitizeSettingsSnapshot(snapshot) {
  if (typeof snapshot !== 'string') return null;
  try {
    const parsed = JSON.parse(snapshot);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return JSON.stringify('state' in parsed
      ? { ...parsed, state: withoutSettingsSecrets(parsed.state) }
      : withoutSettingsSecrets(parsed));
  } catch {
    return null;
  }
}

export function sanitizeBackupSettings(bundle) {
  if (!bundle?.keys || typeof bundle.keys !== 'object') return false;
  let changed = false;
  for (const key of [SETTINGS_KEY, LEGACY_SETTINGS_KEY]) {
    if (typeof bundle.keys[key] !== 'string') continue;
    const clean = sanitizeSettingsSnapshot(bundle.keys[key]);
    if (clean === bundle.keys[key]) continue;
    bundle.keys[key] = clean;
    changed = true;
  }
  return changed;
}
