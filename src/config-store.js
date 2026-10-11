'use strict';
/**
 * 模型接口配置的读写（config.json）。
 * 单独成模块是为了让 tools/selftest.js 能在不启动 HTTP 服务的情况下直接测试。
 */

const fs = require('fs');
const path = require('path');
const llm = require('./llm');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOCAL_PATH = path.join(ROOT, 'config.local.json');

/* ------------------------------------------------------------------ 基础工具 */

function numOr(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && v !== null && v !== undefined && v !== '') return n;
  }
  return undefined;
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return '••••••';
  return `••••••${s.slice(-4)}`;
}

function isMasked(key) {
  return /^[•*]/.test(String(key || ''));
}

function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------------------------------------------ 读取 */

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[warn] 读取 ${path.basename(file)} 失败：${err.message}`);
    return {};
  }
}

function loadRawFile() {
  const out = { ...readJsonSafe(CONFIG_PATH), ...readJsonSafe(LOCAL_PATH) };
  if (process.env.CHAT_LENS_API_KEY) out.apiKey = process.env.CHAT_LENS_API_KEY;
  if (process.env.DEEPSEEK_API_KEY) out.apiKeyByProvider = { ...(out.apiKeyByProvider || {}), deepseek: process.env.DEEPSEEK_API_KEY };
  if (process.env.OPENAI_API_KEY) out.apiKeyByProvider = { ...(out.apiKeyByProvider || {}), openai: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) out.apiKeyByProvider = { ...(out.apiKeyByProvider || {}), anthropic: process.env.ANTHROPIC_API_KEY };
  return out;
}

/** 把一条原始配置补全成规范形状 */
function normalizeProfile(p = {}, index = 0) {
  const provider = p.provider || 'deepseek';
  const meta = llm.PROVIDERS[provider] || {};
  return {
    id: String(p.id || newId()),
    name: String(p.name || meta.label || provider),
    provider,
    baseUrl: String(p.baseUrl || meta.baseUrl || ''),
    apiKey: String(p.apiKey || ''),
    model: String(p.model || meta.defaultModel || ''),
    temperature: numOr(p.temperature, 0.4),
    maxTokens: numOr(p.maxTokens, 8000),
    chunkSize: numOr(p.chunkSize, 400),
    maxChunks: numOr(p.maxChunks, 12),
    timeoutMs: numOr(p.timeoutMs, 300000),
  };
}

/** 兼容早期「顶层扁平写 provider/apiKey/model」的 config.json */
function legacyProfile(raw) {
  if (!raw || (!raw.apiKey && !raw.model && !raw.baseUrl && !raw.provider)) return null;
  const provider = raw.provider || 'deepseek';
  const meta = llm.PROVIDERS[provider] || {};
  return normalizeProfile({
    id: 'default',
    name: `${meta.label || provider}（旧配置）`,
    provider,
    baseUrl: raw.baseUrl || meta.baseUrl || '',
    apiKey: raw.apiKey || (raw.apiKeyByProvider && raw.apiKeyByProvider[provider]) || '',
    model: raw.model || meta.defaultModel || '',
    temperature: raw.temperature,
    maxTokens: raw.maxTokens,
    chunkSize: raw.chunkSize,
    maxChunks: raw.maxChunks,
    timeoutMs: raw.timeoutMs,
  });
}

/**
 * 读取当前生效的配置集合（含真实 Key，仅供服务端内部使用）。
 * @returns {{activeId:string, profiles:Array}}
 */
function loadConfigState(raw) {
  const src = raw || loadRawFile();
  let list = Array.isArray(src.profiles) ? src.profiles.map((p, i) => normalizeProfile(p, i)) : [];
  if (!list.length) {
    const legacy = legacyProfile(src);
    if (legacy) list = [legacy];
  }
  // 环境变量补 Key（用于「不想把 Key 写进文件」的场景）
  list = list.map((p) => {
    if (p.apiKey) return p;
    const fromEnv =
      (src.apiKeyByProvider && src.apiKeyByProvider[p.provider]) ||
      (p.provider === 'deepseek' && process.env.DEEPSEEK_API_KEY) ||
      (p.provider === 'openai' && process.env.OPENAI_API_KEY) ||
      (p.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) ||
      '';
    return fromEnv ? { ...p, apiKey: fromEnv } : p;
  });
  const activeId = list.some((p) => p.id === src.activeId) ? src.activeId : list.length ? list[0].id : '';
  return { activeId, profiles: list };
}

/** 给界面看的版本：Key 打码 */
function sanitizeState(state) {
  return {
    activeId: state.activeId,
    profiles: state.profiles.map((p) => ({ ...p, apiKey: maskKey(p.apiKey), hasKey: !!p.apiKey })),
  };
}

function canWriteConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.accessSync(CONFIG_PATH, fs.constants.W_OK);
    else fs.accessSync(ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 写入 */

/** 合并前端提交的配置：打码或留空的 Key 保留原有真实值 */
function mergeProfiles(incoming, current) {
  const base = current || loadConfigState();
  const byId = new Map(base.profiles.map((p) => [p.id, p]));
  const out = [];
  for (const [i, p] of (Array.isArray(incoming) ? incoming : []).entries()) {
    const prev = byId.get(String((p && p.id) || ''));
    const merged = normalizeProfile({ ...p, id: (p && p.id) || (prev && prev.id) }, i);
    if (!merged.apiKey && prev) merged.apiKey = prev.apiKey;
    if (isMasked(merged.apiKey) && prev) merged.apiKey = prev.apiKey;
    out.push(merged);
  }
  return out;
}

/**
 * 写入 config.json（保留文件里其它自定义字段）。
 * @returns {{activeId:string, profiles:Array}} 真实值版本
 */
function writeConfigState(payload) {
  const current = loadConfigState();
  const profiles = mergeProfiles(payload.profiles, current);
  const activeId = profiles.some((p) => p.id === payload.activeId) ? payload.activeId : profiles.length ? profiles[0].id : '';

  const existing = readJsonSafe(CONFIG_PATH);
  const next = { ...existing };
  delete next._说明;
  delete next.provider;
  delete next.apiKey;
  delete next.baseUrl;
  delete next.model;
  delete next.apiKeyByProvider;
  next.activeId = activeId;
  next.profiles = profiles;

  if (!canWriteConfig()) {
    throw new Error('config.json 不可写（可能被占用或权限不足）。可以先用记事本手动编辑该文件，或给这个目录写权限后重试。');
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return { activeId, profiles };
}

/**
 * 把界面传来的配置解析成「可发起请求」的配置。
 * 空 Key / 打码 Key 会自动回退到已保存的值。
 */
function resolveConfig(raw = {}, savedState) {
  const state = savedState || loadConfigState();
  const profileId = raw.profileId || state.activeId;
  const saved = state.profiles.find((p) => p.id === profileId) || null;

  const provider = raw.provider || (saved && saved.provider) || 'deepseek';
  let apiKey = raw.apiKey;
  if (apiKey === undefined || apiKey === null || apiKey === '' || isMasked(apiKey)) {
    apiKey = (saved && saved.apiKey) || '';
  }
  const meta = llm.PROVIDERS[provider] || {};
  return {
    provider,
    apiKey,
    baseUrl: raw.baseUrl || (saved && saved.baseUrl) || meta.baseUrl || '',
    model: raw.model || (saved && saved.model) || meta.defaultModel || '',
    temperature: numOr(raw.temperature, saved && saved.temperature, 0.4),
    maxTokens: numOr(raw.maxTokens, saved && saved.maxTokens, 8000),
    timeoutMs: numOr(raw.timeoutMs, saved && saved.timeoutMs, 300000),
    chunkSize: numOr(raw.chunkSize, saved && saved.chunkSize, 400),
    maxChunks: numOr(raw.maxChunks, saved && saved.maxChunks, 12),
    stream: raw.stream !== false,
    json: raw.json !== false,
  };
}

module.exports = {
  CONFIG_PATH,
  loadRawFile,
  loadConfigState,
  sanitizeState,
  mergeProfiles,
  normalizeProfile,
  legacyProfile,
  writeConfigState,
  resolveConfig,
  canWriteConfig,
  maskKey,
  isMasked,
  newId,
};
