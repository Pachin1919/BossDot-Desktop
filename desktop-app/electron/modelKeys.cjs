'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROVIDERS = new Set(['openai', 'deepseek', 'qwen', 'zhipu', 'siliconflow', 'volces', 'custom']);
const storagePath = () => path.join(app.getPath('userData'), 'model-api-keys.enc');
let operations = Promise.resolve();

function serialize(run) {
  const next = operations.then(run);
  operations = next.catch(() => undefined);
  return next;
}

function requireProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error('不支持的模型服务商');
}

function validateOrigin(origin) {
  const url = typeof origin === 'string' && URL.canParse(origin) ? new URL(origin) : null;
  const loopback = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || origin !== url.origin || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('请填写有效的模型接入地址');
  }
}

async function encrypt(keys) {
  if (!(await safeStorage.isAsyncEncryptionAvailable()) ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('系统安全存储不可用，请解锁系统密钥库后重试');
  }
  try {
    return await safeStorage.encryptStringAsync(JSON.stringify(keys));
  } catch {
    throw new Error('无法加密 API Key，请检查系统安全存储');
  }
}

async function writeKeys(keys) {
  const file = storagePath();
  const encrypted = await encrypt(keys);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } catch {
    throw new Error('无法写入本机 API Key 存储');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readKeys() {
  let encrypted;
  try {
    encrypted = await fs.readFile(storagePath());
  } catch (error) {
    if (error.code === 'ENOENT') return { keys: {}, rotate: false };
    throw new Error('无法读取本机 API Key 存储');
  }
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    const keys = JSON.parse(result);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error();
    for (const [provider, entry] of Object.entries(keys)) {
      requireProvider(provider);
      if (typeof entry?.apiKey !== 'string' || !entry.apiKey) throw new Error();
      if (entry.origin !== null) validateOrigin(entry.origin);
    }
    return { keys, rotate: shouldReEncrypt };
  } catch {
    throw new Error('无法解密本机 API Key，请检查系统安全存储后重试');
  }
}

function origins(keys) {
  return Object.fromEntries(Object.entries(keys).map(([provider, entry]) => [provider, entry.origin]));
}

function status() {
  return serialize(async () => {
    const { keys, rotate } = await readKeys();
    if (rotate) await writeKeys(keys).catch(() => undefined);
    return origins(keys);
  });
}

function migrate(entries) {
  if (!Array.isArray(entries) || entries.length > PROVIDERS.size) throw new Error('旧模型密钥格式无效');
  return serialize(async () => {
    const { keys, rotate } = await readKeys();
    let changed = false;
    for (const { provider, origin, apiKey } of entries) {
      requireProvider(provider);
      if (Object.hasOwn(keys, provider)) continue;
      if (origin !== null) validateOrigin(origin);
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('旧模型密钥格式无效');
      keys[provider] = { apiKey: apiKey.trim(), origin };
      changed = true;
    }
    if (changed || rotate) await writeKeys(keys);
    return origins(keys);
  });
}

function set(provider, origin, apiKey) {
  requireProvider(provider);
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey.trim())) throw new Error('API Key 格式无效');
  const key = apiKey.trim();
  if (key) validateOrigin(origin);
  return serialize(async () => {
    const { keys } = await readKeys();
    if (key) keys[provider] = { apiKey: key, origin };
    else delete keys[provider];
    if (Object.keys(keys).length) await writeKeys(keys);
    else await fs.rm(storagePath(), { force: true });
    return origins(keys);
  });
}

function resolve(provider, origin) {
  requireProvider(provider);
  return serialize(async () => {
    const { keys, rotate } = await readKeys();
    const entry = keys[provider];
    if (!entry || entry.origin !== origin) throw new Error('请在设置中为此接入地址保存 API Key');
    if (rotate) await writeKeys(keys).catch(() => undefined);
    return entry.apiKey;
  });
}

function clear() {
  return serialize(() => fs.rm(storagePath(), { force: true }));
}

module.exports = { status, migrate, set, resolve, clear };
