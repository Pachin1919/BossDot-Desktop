import { LEGACY_SETTINGS_KEY, SETTINGS_KEY, sanitizeSettingsSnapshot } from '../../electron/settingsSecrets.mjs';
import { markPersistDirty } from './persistSafe';
import { DEFAULT_PROVIDER, PROVIDER_DEFAULTS, resolveModelTarget } from './bossclaw/providerPresets';
import type { AppConfig, ModelProvider } from './bossclaw/types';
import { electronApi, type LegacyModelKey, type ModelKeyOrigins } from './electronApi';

type Model = AppConfig['model'];
type LegacySettings = {
  config?: { model?: Partial<Model> };
  savedModelConfigs?: Partial<Record<ModelProvider, Partial<Model>>>;
};

// Settings hydration is synchronous. Prevent a persist write from discarding legacy credentials
// while the asynchronous main-process migration is still in progress or needs to be retried.
let migrationPending = true;
export function modelKeyMigrationPending(): boolean {
  return migrationPending;
}

export function modelKeyOrigin(model: Pick<Model, 'provider' | 'baseUrl' | 'model'>): string | null {
  const target = resolveModelTarget(model);
  return target ? new URL(target.url).origin : null;
}

function collectLegacyKeys(snapshot: string | null, keys: Map<ModelProvider, LegacyModelKey>): void {
  if (!snapshot) return;
  let state: LegacySettings;
  try {
    const parsed = JSON.parse(snapshot);
    state = parsed?.state ?? parsed;
  } catch {
    return;
  }
  const add = (model: Partial<Model> | undefined, provider: ModelProvider) => {
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, provider) || typeof model?.apiKey !== 'string' || !model.apiKey.trim()) return;
    const origin = modelKeyOrigin({
      provider,
      baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : '',
      model: typeof model.model === 'string' ? model.model : '',
    });
    keys.set(provider, { provider, origin, apiKey: model.apiKey.trim() });
  };
  for (const provider of Object.keys(PROVIDER_DEFAULTS) as ModelProvider[]) {
    add(state?.savedModelConfigs?.[provider], provider);
  }
  const active = state?.config?.model;
  add(active, active?.provider ?? DEFAULT_PROVIDER);
}

export async function initializeModelCredentials(): Promise<{ origins?: ModelKeyOrigins; error?: string }> {
  const keys = new Map<ModelProvider, LegacyModelKey>();
  let raw: string | null;
  let legacy: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
    legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
  } catch {
    migrationPending = false;
    const status = await electronApi.modelKeys.status();
    return status.ok ? { origins: status.origins } : { error: status.error };
  }
  collectLegacyKeys(raw, keys);
  migrationPending = keys.size > 0;
  if (keys.size && !electronApi.modelKeys.available()) {
    return { error: '请使用 BossDot 桌面版迁移旧 API Key' };
  }
  const status = keys.size ? await electronApi.modelKeys.migrate([...keys.values()])
    : electronApi.modelKeys.available() ? await electronApi.modelKeys.status() : { ok: true as const, origins: {} };
  if (!status.ok && keys.size) {
    const existing = await electronApi.modelKeys.status();
    return { origins: existing.ok ? existing.origins : undefined, error: `旧 API Key 尚未迁移。${status.error}` };
  }
  try {
    for (const [name, value] of [[SETTINGS_KEY, raw], [LEGACY_SETTINGS_KEY, legacy]] as const) {
      const clean = sanitizeSettingsSnapshot(value);
      if (clean !== null && clean !== value && localStorage.getItem(name) === value) {
        localStorage.setItem(name, clean);
        markPersistDirty(name);
      }
    }
    migrationPending = false;
  } catch {
    return { origins: status.ok ? status.origins : undefined, error: '无法清理设置中的旧 API Key，请检查本地存储后重试' };
  }
  return status.ok ? { origins: status.origins } : { error: status.error };
}
