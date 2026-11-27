import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import type { AppConfig } from '@/lib/bossclaw/types';
import { DEFAULT_CONFIG } from '@/lib/bossclaw/defaults';
import { hasModelApiKey, PROVIDER_DEFAULTS, resolveModelTarget, type LLMProvider } from '@/lib/bossclaw/providerPresets';
import { electronApi, type ModelKeyOrigins } from '@/lib/electronApi';
import { initializeModelCredentials, modelKeyMigrationPending, modelKeyOrigin } from '@/lib/modelCredentials';
import { SETTINGS_KEY, withoutModelSecrets, withoutSettingsSecrets } from '../../electron/settingsSecrets.mjs';
import {
  applyMigrations,
  extractLegacyBatchDelivery,
  RETIRED_DEEPSEEK_MODEL_MAP,
  type LegacyBatchDelivery,
} from './migrations/settingsMigrations';

// P1-10：模型提供商预设已收敛到 providerPresets.ts 单一来源，此处只 re-export 供设置页等
// 既有 import（`import { PROVIDER_DEFAULTS } from '@/store/useSettingsStore'`）兼容使用。
export { PROVIDER_DEFAULTS, type ProviderPreset, type LLMProvider } from '@/lib/bossclaw/providerPresets';

export interface LLMConfig {
  provider: LLMProvider;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export type { LegacyBatchDelivery };

/** merge 时剥离到的旧分批配置（仅老用户升级后的首次启动存在，消费后置空） */
export let legacyBatchDelivery: LegacyBatchDelivery | null = null;

/** App 启动调用：取走一次性的旧分批配置（幂等；已消费后返回 null）。 */
export function consumeLegacyBatchDelivery(): LegacyBatchDelivery | null {
  const v = legacyBatchDelivery;
  legacyBatchDelivery = null;
  return v;
}

interface SettingsState {
  config: AppConfig;
  savedModelConfigs: Partial<Record<LLMProvider, AppConfig['model']>>;
  modelKeyOrigins: ModelKeyOrigins;
  modelKeyError?: string;
  initializeModelKeys: () => Promise<void>;
  saveModelKey: (model: AppConfig['model'], key: string) => Promise<string | undefined>;
  setConfig: (patch: Partial<AppConfig>) => void;
  setModel: (patch: Partial<AppConfig['model']>) => void;
  applyProviderDefaults: (p: LLMProvider) => void;
  selectProvider: (p: LLMProvider) => void;
  isLLMConfigured: () => boolean;
}

type PersistedSettings = Pick<SettingsState, 'config' | 'savedModelConfigs'>;
const settingsStorage = createSafePersistStorage<PersistedSettings>();

function withModelKeyStatus(model: AppConfig['model'], origins: ModelKeyOrigins): AppConfig['model'] {
  const origin = modelKeyOrigin(model);
  return { ...withoutModelSecrets(model), hasStoredApiKey: origin !== null && origins[model.provider] === origin };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      savedModelConfigs: {},
      modelKeyOrigins: {},
      initializeModelKeys: async () => {
        const result = await initializeModelCredentials();
        set((s) => {
          const origins = result.origins ?? s.modelKeyOrigins;
          return {
            modelKeyOrigins: origins,
            modelKeyError: result.error,
            config: { ...s.config, model: withModelKeyStatus(s.config.model, origins) },
          };
        });
      },
      saveModelKey: async (model, key) => {
        if (modelKeyMigrationPending()) return '请先重试旧 API Key 迁移';
        const origin = modelKeyOrigin(model);
        if (key.trim() && !origin) return '请填写有效的模型接入地址';
        const result = await electronApi.modelKeys.set(model.provider, origin, key);
        if (!result.ok) return result.error;
        set((s) => {
          const origins = result.origins ?? {};
          return {
            modelKeyOrigins: origins,
            modelKeyError: undefined,
            config: { ...s.config, model: withModelKeyStatus(s.config.model, origins) },
          };
        });
      },
      setConfig: (patch) => set((s) => ({
        config: { ...s.config, ...patch, model: patch.model ? withModelKeyStatus(patch.model, s.modelKeyOrigins) : s.config.model },
      })),
      setModel: (patch) => set((s) => ({
        config: { ...s.config, model: withModelKeyStatus({ ...s.config.model, ...patch }, s.modelKeyOrigins) },
      })),
      applyProviderDefaults: (p) =>
        set((s) => ({
          config: {
            ...s.config,
            model: withModelKeyStatus({
              ...s.config.model,
              provider: p,
              baseUrl: PROVIDER_DEFAULTS[p].baseUrl,
              model: PROVIDER_DEFAULTS[p].model,
              thinking: { enabled: false, effort: '' },
            }, s.modelKeyOrigins),
          },
        })),
      selectProvider: (p) => set((s) => {
        const current = s.config.model;
        if (current.provider === p) return s;
        const preset = PROVIDER_DEFAULTS[p];
        const model = s.savedModelConfigs[p] ?? {
          ...current,
          provider: p,
          baseUrl: preset.baseUrl,
          model: preset.model,
          thinking: { enabled: false, effort: '' },
        };
        return {
          savedModelConfigs: { ...s.savedModelConfigs, [current.provider]: withoutModelSecrets(current), [p]: undefined },
          config: { ...s.config, model: withModelKeyStatus(model, s.modelKeyOrigins) },
        };
      }),
      isLLMConfigured: () => {
        const { model } = get().config;
        return Boolean(hasModelApiKey(model) && resolveModelTarget(model)?.model);
      },
    }),
    {
      // v2 命名空间：本次回滚强制重置旧 bossclaw-settings（含已被删除的 engineMode:'cloak' 持久化值）
      name: SETTINGS_KEY,
      // P30：安全持久化——config 变更（含暂停冷却 pausedUntil 等安全字段）不得因 localStorage
      // 配额异常向上抛错中断引擎/UI；防抖合批也避免高频 setConfig 触发全量序列化
      storage: {
        ...settingsStorage,
        setItem: (name, value) => {
          if (!modelKeyMigrationPending()) settingsStorage.setItem(name, value);
        },
      },
      partialize: ({ config, savedModelConfigs }): PersistedSettings => withoutSettingsSecrets({ config, savedModelConfigs }),
      // 浅合并持久化配置到最新 DEFAULT_CONFIG，自动补齐新增的安全字段
      // （老用户 localStorage 中缺少 maxDailySent 等字段时回退到安全默认值）。
      // P2-06：历史迁移收敛到 migrations/settingsMigrations.ts 注册表；
      // 本函数回归「纯合并」——batchDelivery 剥离走 extractLegacyBatchDelivery（不改写入参），
      // 其余迁移走 applyMigrations（只读入参、不改写）。
      merge: (persisted, current) => {
        const p = withoutSettingsSecrets((persisted || {}) as Partial<PersistedSettings>);
        const pc = (p.config || {}) as Partial<AppConfig>;
        // 一次性剥离退役字段 batchDelivery：转存到模块级变量，由 App 启动迁移为定时任务（幂等）
        const legacy = extractLegacyBatchDelivery(pc);
        if (legacy.artifact) legacyBatchDelivery = legacy.artifact;
        // 剩余历史迁移（纯函数，只读入参）：每日目标/平台归一/模型名义/看门狗时长
        const migrated = applyMigrations(legacy.cleaned, {
          current: (current as SettingsState).config,
          deepseekMap: RETIRED_DEEPSEEK_MODEL_MAP,
        });
        return {
          ...current,
          savedModelConfigs: p.savedModelConfigs ?? current.savedModelConfigs,
          config: {
            ...(current as SettingsState).config,
            ...legacy.cleaned,
            ...migrated,
          },
        };
      },
    }
  )
);

export const getLLMConfig = (): LLMConfig & AppConfig['model'] => {
  const { model } = useSettingsStore.getState().config;
  return model;
};
