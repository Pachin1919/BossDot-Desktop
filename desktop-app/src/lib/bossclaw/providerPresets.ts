import type { AppConfig, ModelProvider } from './types';

export type LLMProvider = ModelProvider;
type ModelProtocol = 'responses' | 'chat';

export interface ProviderPreset {
  baseUrl: string;
  model: string;
  models: string[];
  label: string;
  protocol: ModelProtocol;
  docs?: string;
  hint?: string;
}

export const PROVIDER_DEFAULTS: Record<LLMProvider, ProviderPreset> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.2-astra'],
    label: 'OpenAI',
    protocol: 'responses',
    docs: 'https://developers.openai.com/api/docs/models',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    label: 'DeepSeek',
    protocol: 'chat',
    docs: 'https://api-docs.deepseek.com/',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-flash',
    models: ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max', 'qwen4-max', 'qwen-plus', 'qwen-flash'],
    label: '阿里云百炼（千问）',
    protocol: 'chat',
    docs: 'https://help.aliyun.com/zh/model-studio/base-url',
    hint: '预设为北京按量付费地址。使用其他地域、业务空间或 Token Plan 时，填写控制台中与密钥配套的地址。',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5'],
    label: '智谱 GLM',
    protocol: 'chat',
    docs: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'Pro/zai-org/GLM-5.1'],
    label: '硅基流动',
    protocol: 'chat',
    docs: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    hint: '模型 ID 使用平台模型广场上的完整名称，保留组织前缀。',
  },
  volces: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-1-lite-260915',
    models: ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-evolving'],
    label: '火山方舟',
    protocol: 'chat',
    docs: 'https://docs.volcengine.com/docs/ark/model-list?lang=zh',
    hint: '填写当前账号已开通的模型 ID 或推理接入点 ID（ep-…）。此预设使用按量付费地址。',
  },
  custom: {
    baseUrl: '',
    model: '',
    models: [],
    label: '自定义兼容接口',
    protocol: 'chat',
    hint: '可填写 Base URL 或完整接口地址。Responses 网关请填写以 /responses 结尾的地址。',
  },
};

export const DEFAULT_PROVIDER: LLMProvider = 'deepseek';
export const DEFAULT_MODEL_NAME = PROVIDER_DEFAULTS[DEFAULT_PROVIDER].model;

export function hasModelApiKey(config: Pick<AppConfig['model'], 'apiKey' | 'hasStoredApiKey'> | null | undefined): boolean {
  return Boolean(config?.hasStoredApiKey || config?.apiKey?.trim());
}

export function resolveModelTarget(config: Pick<AppConfig['model'], 'provider' | 'baseUrl' | 'model'>) {
  const preset = PROVIDER_DEFAULTS[config.provider] ?? PROVIDER_DEFAULTS.custom;
  const model = config.model?.trim() || preset.model;
  const address = config.baseUrl?.trim() || preset.baseUrl;
  if (!address) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) return null;

  const officialOpenAI = url.origin === 'https://api.openai.com';
  const path = url.pathname.replace(/\/+$/, '');
  const protocol = path.endsWith('/responses')
    ? 'responses'
    : path.endsWith('/chat/completions')
      ? 'chat'
      : officialOpenAI
        ? 'responses'
        : config.provider === 'openai'
          ? 'chat'
          : preset.protocol;
  if (path.endsWith('/responses') || path.endsWith('/chat/completions')) {
    url.pathname = path;
  } else {
    const basePath = officialOpenAI && !path ? '/v1' : path;
    url.pathname = `${basePath}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`;
  }
  return { url: url.href, endpoint: url.origin + url.pathname, model, protocol, officialOpenAI };
}

export function resolveModelCatalog(config: AppConfig['model']) {
  const target = resolveModelTarget(config);
  if (!target) return null;
  const url = new URL(target.url);
  const qwenWorkspace = config.provider === 'qwen'
    && (url.hostname.endsWith('.maas.aliyuncs.com') || url.hostname === 'dashscope-us.aliyuncs.com');
  if (qwenWorkspace) {
    url.pathname = '/api/v1/models';
    url.searchParams.set('capabilities', 'TG');
    url.searchParams.set('page_size', '100');
  } else {
    if (config.provider === 'qwen' && url.hostname.endsWith('.aliyuncs.com')) return null;
    url.pathname = url.pathname.replace(/\/(?:responses|chat\/completions)$/, '/models');
    if (config.provider === 'siliconflow' && url.hostname === 'api.siliconflow.cn') url.searchParams.set('sub_type', 'chat');
  }
  return { url, qwenWorkspace, officialOpenAI: target.officialOpenAI };
}
