'use strict';
/**
 * 统一的大模型调用层（只依赖 Node 18+ 内置 fetch，无第三方依赖）。
 *
 * 支持：
 *   - DeepSeek（原生 + 兼容 OpenAI 协议）
 *   - OpenAI 及任何兼容 OpenAI /chat/completions 的中转站、国内模型（Qwen / GLM / Kimi / 硅基流动…）
 *   - Anthropic Claude（/v1/messages）
 *   - Ollama / LM Studio / vLLM 等本地服务
 */

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    keyHint: 'sk-... （platform.deepseek.com 获取）',
  },
  openai: {
    label: 'OpenAI 官方',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    defaultModel: 'gpt-4o-mini',
    keyHint: 'sk-...',
  },
  openai_compatible: {
    label: 'OpenAI 兼容中转 / 其他模型',
    protocol: 'openai',
    baseUrl: 'https://your-gateway.example.com/v1',
    models: ['gpt-4o-mini', 'qwen-plus', 'glm-4-plus', 'moonshot-v1-8k', 'deepseek-chat'],
    defaultModel: 'gpt-4o-mini',
    keyHint: '填你的中转站 Key',
    editableBase: true,
  },
  anthropic: {
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    keyHint: 'sk-ant-...',
  },
  ollama: {
    label: '本地 Ollama（无需 Key）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:14b', 'qwen2.5:7b', 'llama3.1:8b'],
    defaultModel: 'qwen2.5:14b',
    keyHint: '本地模型随便填，比如 ollama',
    editableBase: true,
    noKey: true,
  },
  lmstudio: {
    label: '本地 LM Studio / vLLM',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    defaultModel: 'local-model',
    keyHint: '本地模型随便填，比如 lmstudio',
    editableBase: true,
    noKey: true,
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    models: p.models,
    defaultModel: p.defaultModel,
    keyHint: p.keyHint,
    editableBase: !!p.editableBase,
    noKey: !!p.noKey,
  }));
}

function normalizeBase(baseUrl, protocol) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('缺少接口地址（Base URL）');
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  if (protocol === 'anthropic') {
    // Anthropic 的地址是 https://api.anthropic.com，最终请求 /v1/messages
    if (!/\/v1$/i.test(b) && !/\/v1\/messages$/i.test(b)) return b;
    return b.replace(/\/v1(\/messages)?$/i, '');
  }
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

function buildRequest(cfg) {
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.openai_compatible;
  const protocol = provider.protocol;
  const baseRaw = cfg.baseUrl && String(cfg.baseUrl).trim() ? cfg.baseUrl : provider.baseUrl;
  const url = normalizeBase(baseRaw, protocol);
  const model = cfg.model && String(cfg.model).trim() ? String(cfg.model).trim() : provider.defaultModel;

  const systemText = (cfg.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = (cfg.messages || []).filter((m) => m.role !== 'system');

  const wantsJson = cfg.json !== false;
  const headers = { 'Content-Type': 'application/json' };
  let body;

  const isReasoner = /reasoner|^o\d|-thinking|thinking/i.test(model);
  const temperature = typeof cfg.temperature === 'number' ? cfg.temperature : undefined;
  const maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 8000;

  if (protocol === 'anthropic') {
    headers['x-api-key'] = cfg.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      max_tokens: maxTokens,
      messages: convo.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    if (systemText) body.system = systemText;
    if (!isReasoner && temperature !== undefined) body.temperature = temperature;
    if (cfg.stream !== false) body.stream = true;
  } else {
    headers.Authorization = `Bearer ${cfg.apiKey || ''}`;
    body = {
      model,
      messages: (cfg.messages || []).map((m) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      stream: cfg.stream !== false,
    };
    if (!isReasoner && temperature !== undefined) body.temperature = temperature;
    if (wantsJson) body.response_format = { type: 'json_object' };
  }

  return { url, headers, body, protocol, model, isReasoner, wantsJson };
}

function extractText(data, protocol) {
  if (!data) return '';
  if (protocol === 'anthropic') {
    if (typeof data.completion === 'string') return data.completion;
    if (Array.isArray(data.content)) {
      return data.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
    }
    return '';
  }
  const choice = data.choices && data.choices[0];
  if (!choice) return '';
  if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

function extractReasoning(data, protocol) {
  if (!data || protocol === 'anthropic') {
    if (data && data.type === 'content_block_delta' && data.delta && data.delta.type === 'thinking_delta') {
      return data.delta.thinking || '';
    }
    return '';
  }
  const choice = data.choices && data.choices[0];
  if (!choice) return '';
  if (choice.delta && typeof choice.delta.reasoning_content === 'string') return choice.delta.reasoning_content;
  if (choice.delta && typeof choice.delta.reasoning === 'string') return choice.delta.reasoning;
  if (choice.message && typeof choice.message.reasoning_content === 'string') return choice.message.reasoning_content;
  return '';
}

/**
 * 调用模型。
 * @param {object} cfg {provider, baseUrl, apiKey, model, messages, temperature, maxTokens, stream, json, timeoutMs}
 * @param {(evt:object)=>void} onEvent 事件：{type:'delta'|'reasoning'|'done'|'retry', ...}
 * @returns {Promise<{text:string, reasoning:string, usage:object|null, model:string, attempts:number}>}
 */
async function chat(cfg, onEvent = () => {}) {
  const req = buildRequest(cfg);
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 300000;
  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text = '';
    let reasoning = '';
    let usage = null;
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        const err = new Error(describeHttpError(res.status, raw));
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }

      const contentType = res.headers.get('content-type') || '';
      const streaming = cfg.stream !== false && /event-stream/.test(contentType);

      if (!streaming) {
        const raw = await res.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`接口返回的不是 JSON：${raw.slice(0, 200)}`);
        }
        text = extractText(data, req.protocol);
        reasoning = extractReasoning(data, req.protocol);
        usage = data.usage || null;
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let sseDataLines = [];
        let sawAnyEvent = false;

        const handlePayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            return;
          }
          if (data.error) throw new Error('模型返回错误：' + (data.error.message || JSON.stringify(data.error)));
          const t = extractText(data, req.protocol);
          const r = extractReasoning(data, req.protocol);
          if (t) {
            text += t;
            onEvent({ type: 'delta', text: t, total: text.length });
          }
          if (r) {
            reasoning += r;
            onEvent({ type: 'reasoning', text: r, total: reasoning.length });
          }
          if (data.usage) usage = data.usage;
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop();
          for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed) {
              if (sseDataLines.length) {
                handlePayload(sseDataLines.join('\n'));
                sseDataLines = [];
                sawAnyEvent = true;
              }
              continue;
            }
            if (trimmed.startsWith(':')) continue;
            if (trimmed.startsWith('data:')) {
              sseDataLines.push(trimmed.slice(5).trim());
            } else if (trimmed.startsWith('{')) {
              // 少数服务端不规范，直接吐 JSON 行
              handlePayload(trimmed);
              sawAnyEvent = true;
            }
          }
        }
        if (sseDataLines.length) handlePayload(sseDataLines.join('\n'));
        if (!text && !sawAnyEvent) {
          throw new Error('流式响应为空，可能是接口地址或模型名不对。');
        }
      }

      clearTimeout(timer);
      return { text, reasoning, usage, model: req.model, attempts: attempt };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      const retryable = aborted || err.retryable || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(String(err.message));
      if (attempt < maxAttempts && retryable) {
        const waitMs = 900 * attempt;
        onEvent({ type: 'retry', attempt, message: aborted ? '请求超时' : String(err.message).slice(0, 160), waitMs });
        await sleep(waitMs);
        continue;
      }
      throw aborted ? new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）。可以让模型换小一点的分段，或调大超时。`) : err;
    }
  }
  throw lastErr || new Error('调用失败');
}

function describeHttpError(status, raw) {
  let detail = raw ? raw.slice(0, 400) : '';
  try {
    const j = JSON.parse(raw);
    if (j && j.error) detail = j.error.message || JSON.stringify(j.error);
  } catch {
    /* keep raw */
  }
  const map = {
    400: '请求被拒绝（400）',
    401: 'API Key 无效或未填写（401）',
    402: '余额不足（402）',
    403: '没有权限访问该模型（403）',
    404: '接口地址或模型名不存在（404）',
    422: '参数不合法（422）',
    429: '触发限流或额度用尽（429）',
    500: '服务端错误（500）',
    502: '网关错误（502）',
    503: '服务暂不可用（503）',
  };
  const head = map[status] || `请求失败（${status}）`;
  return `${head}：${detail}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 连接测试：发一个极小的请求，确认「地址 + Key + 模型名」三件套都对。
 * 成功 / 失败都返回结构化结果，不抛异常，方便界面直接展示。
 */
async function testConnection(cfg = {}) {
  const started = Date.now();
  const req = buildRequest({
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    stream: false,
    json: cfg.json !== false,
    maxTokens: 64,
    temperature: 0,
    messages: [
      { role: 'system', content: '你是一个连通性测试端点，只输出 JSON，不要输出任何多余文字。' },
      { role: 'user', content: '请只输出这个 JSON：{"ok":true,"echo":"pong"}' },
    ],
  });

  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 45000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return { ok: false, latencyMs, model: req.model, url: req.url, error: describeHttpError(res.status, raw) };
    }
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, latencyMs, model: req.model, url: req.url, error: `接口返回的不是 JSON：${raw.slice(0, 160)}` };
    }
    const text = extractText(data, req.protocol);
    return {
      ok: true,
      latencyMs,
      model: req.model,
      url: req.url,
      protocol: req.protocol,
      echoed: /pong|"ok"\s*:\s*true/i.test(text),
      sample: text.slice(0, 200),
      usage: data.usage || null,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
    return {
      ok: false,
      latencyMs: Date.now() - started,
      model: req.model,
      url: req.url,
      error: aborted ? `连接超时（${timeoutMs} ms 内没有响应）` : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, testConnection, listProviders, PROVIDERS, normalizeBase, buildRequest };
