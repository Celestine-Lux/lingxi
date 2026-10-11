'use strict';
/**
 * 灵犀 · 聊天解读小工具 —— 本地服务
 *
 * 纯 Node 内置模块实现：起一个只监听本机的 HTTP 服务，提供网页界面，
 * 并作为大模型 API 的安全中转（避免浏览器跨域问题，Key 也只留在本机）。
 *
 * 用法： node server.js [--port 5178] [--no-open]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { parseChatLog, detectFormat } = require('./src/parser');
const { computeStats, formatStatsForPrompt, localInsights } = require('./src/stats');
const { analyze, simulate } = require('./src/analyzer');
const llm = require('./src/llm');
const configStore = require('./src/config-store');
const { buildMarkdownReport } = require('./src/report');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + '='));
  if (pref) return pref.slice(name.length + 1);
  return fallback;
}

const PORT = Number(argValue('--port', process.env.CHAT_LENS_PORT || 5178));
const HOST = argValue('--host', '127.0.0.1');
const NO_OPEN = argv.includes('--no-open');
const MAX_BODY = 12 * 1024 * 1024;

/* --------------------------------------------------------------- 接口配置管理 */
/* 具体逻辑在 src/config-store.js（单独成模块，方便离线自检直接测试）。
 * config.json 形如：
 * {
 *   "activeId": "p1",
 *   "profiles": [
 *     { "id": "p1", "name": "DeepSeek 官方", "provider": "deepseek",
 *       "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-...",
 *       "model": "deepseek-chat", "temperature": 0.4, "maxTokens": 8000,
 *       "chunkSize": 400, "maxChunks": 12, "timeoutMs": 300000 }
 *   ]
 * }
 * 早期「顶层直接写 provider/apiKey/model」的写法会自动识别成一条配置。
 */

function currentState() {
  return configStore.loadConfigState();
}

/** 带 ok/writable 包装的、Key 已打码的配置视图 */
function sanitizedProfiles() {
  const view = configStore.sanitizeState(currentState());
  return { ok: true, ...view, writable: configStore.canWriteConfig() };
}

function resolveConfig(raw = {}) {
  return configStore.resolveConfig(raw, currentState());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（超过 12MB），请分批分析。'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '非法路径' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found: ' + rel });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function prepare(req) {
  return readBody(req).then((body) => {
    const text = body.text || '';
    const ctx = body.ctx || {};
    const names = (ctx.names || '').split(/\s*[\/|、,，]\s*/).filter(Boolean);
    const parsed = parseChatLog(text, {
      aName: ctx.selfName || names[0],
      bName: ctx.otherName || names[1],
      defaultYear: Number(ctx.defaultYear) || new Date().getFullYear(),
    });
    const selfName = ctx.selfName || parsed.speakers[0] || '';
    const otherName = ctx.otherName || parsed.speakers.find((s) => s !== selfName) || '';
    const stats = computeStats(parsed.messages, {
      selfName,
      otherName,
      sessionGapMinutes: Number(ctx.sessionGapMinutes) || 240,
    });
    const findings = localInsights(stats);
    return { body, parsed, stats, findings, selfName, otherName, ctx: { ...ctx, selfName, otherName } };
  });
}

async function handleParse(req, res) {
  try {
    const { parsed, stats, findings, selfName, otherName } = await prepare(req);
    sendJson(res, 200, {
      ok: true,
      speakers: parsed.speakers,
      messages: parsed.messages,
      warnings: parsed.warnings,
      format: detectFormat(''),
      stats,
      findings,
      selfName,
      otherName,
      preview: parsed.messages.slice(0, 400),
    });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
}

async function handleAnalyze(req, res) {
  let prepared;
  try {
    prepared = await prepare(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }

  const { parsed, stats, findings, selfName, otherName, ctx } = prepared;
  if (!parsed.messages.length) {
    sendJson(res, 400, { ok: false, error: '没有解析出消息，请检查聊天记录格式。' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  const send = (obj) => {
    if (res.writableEnded) return;
    res.write(JSON.stringify(obj) + '\n');
  };

  send({
    type: 'parsed',
    speakers: parsed.speakers,
    messages: parsed.messages,
    warnings: parsed.warnings,
    stats,
    findings,
    selfName,
    otherName,
  });

  const cfg = resolveConfig(prepared.body.config);
  if (prepared.body.previewOnly) {
    send({ type: 'done', previewOnly: true, stats, findings });
    res.end();
    return;
  }
  if (ctx.localOnly) {
    send({ type: 'done', localOnly: true, stats, findings });
    res.end();
    return;
  }
  if (!cfg.apiKey && !(llm.PROVIDERS[cfg.provider] || {}).noKey) {
    send({ type: 'error', error: '还没有填写 API Key。可以在左侧「模型设置」里填，或写进 config.json。' });
    res.end();
    return;
  }

  const statsText = formatStatsForPrompt(stats);
  try {
    const report = await analyze(
      {
        messages: parsed.messages,
        statsText,
        localFindings: findings,
        ctx,
        config: cfg,
      },
      (evt) => send(evt),
    );
    send({ type: 'result', report, stats, findings, markdown: buildMarkdownReport({ report, stats, findings, parsed, ctx }) });
  } catch (err) {
    send({ type: 'error', error: err.message || String(err) });
  } finally {
    res.end();
  }
}

async function handleSimulate(req, res) {
  try {
    const body = await readBody(req);
    const ctx = body.ctx || {};
    const cfg = resolveConfig(body.config);
    if (!cfg.apiKey && !(llm.PROVIDERS[cfg.provider] || {}).noKey) {
      sendJson(res, 400, { ok: false, error: '还没有填写 API Key。' });
      return;
    }
    const parsed = parseChatLog(body.text || '', {
      defaultYear: Number(ctx.defaultYear) || new Date().getFullYear(),
    });
    const selfName = ctx.selfName || parsed.speakers[0] || '';
    const otherName = ctx.otherName || parsed.speakers.find((s) => s !== selfName) || '';
    const stats = computeStats(parsed.messages, { selfName, otherName, sessionGapMinutes: 240 });
    const recent = parsed.messages.slice(-8);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = (obj) => {
      if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
    };
    const result = await simulate(
      {
        draft: body.draft || '',
        ctx: { ...ctx, selfName, otherName },
        recentText: recent.map((m, i) => `#${i} [${m.ts.short}] ${m.speaker}: ${m.text}`).join('\n'),
        statsText: formatStatsForPrompt(stats),
        config: cfg,
      },
      (evt) => send(evt),
    );
    send({ type: 'result', result });
  } catch (err) {
    try {
      sendJson(res, 200, { ok: false, error: err.message || String(err) });
    } catch {
      /* ignore */
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** GET/POST/DELETE /api/config —— 模型接口配置的读取、保存、删除 */
async function handleConfig(req, res) {
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, sanitizedProfiles());
      return;
    }
    const body = await readBody(req);
    if (req.method === 'POST') {
      const saved = configStore.writeConfigState(body);
      sendJson(res, 200, { ok: true, ...sanitizedProfiles(), activeId: saved.activeId });
      return;
    }
    if (req.method === 'DELETE') {
      const state = currentState();
      const id = body.id || new URL(req.url, 'http://x').searchParams.get('id');
      const profiles = state.profiles.filter((p) => p.id !== id);
      const saved = configStore.writeConfigState({ profiles, activeId: profiles.length ? profiles[0].id : '' });
      sendJson(res, 200, { ok: true, ...sanitizedProfiles(), activeId: saved.activeId });
      return;
    }
    sendJson(res, 405, { ok: false, error: '不支持的方法' });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message || String(err) });
  }
}

/** POST /api/test —— 测试当前表单里的模型接口是否可用 */
async function handleTest(req, res) {
  try {
    const body = await readBody(req);
    const cfg = resolveConfig({ ...(body.config || {}), timeoutMs: 45000 });
    const provider = llm.PROVIDERS[cfg.provider];
    if (!provider) {
      sendJson(res, 200, { ok: false, error: `未知的服务商：${cfg.provider}` });
      return;
    }
    if (!cfg.apiKey && !provider.noKey) {
      sendJson(res, 200, { ok: false, error: '还没有填写 API Key。', provider: cfg.provider, model: cfg.model });
      return;
    }
    if (!cfg.model) {
      sendJson(res, 200, { ok: false, error: '还没有填写模型名。', provider: cfg.provider });
      return;
    }
    const result = await llm.testConnection(cfg);
    sendJson(res, 200, {
      ok: !!result.ok,
      provider: cfg.provider,
      providerLabel: provider.label,
      latencyMs: result.latencyMs,
      model: result.model,
      url: result.url,
      echoed: result.echoed,
      sample: result.sample,
      usage: result.usage,
      error: result.error || '',
    });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message || String(err) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/providers' && req.method === 'GET') {
    const state = currentState();
    sendJson(res, 200, {
      ok: true,
      providers: llm.listProviders(),
      hasFileKey: state.profiles.some((p) => !!p.apiKey),
      writable: configStore.canWriteConfig(),
    });
    return;
  }
  if (pathname === '/api/config') {
    handleConfig(req, res);
    return;
  }
  if (pathname === '/api/test' && req.method === 'POST') {
    handleTest(req, res);
    return;
  }
  if (pathname === '/api/parse' && req.method === 'POST') {
    handleParse(req, res);
    return;
  }
  if (pathname === '/api/analyze' && req.method === 'POST') {
    handleAnalyze(req, res);
    return;
  }
  if (pathname === '/api/simulate' && req.method === 'POST') {
    handleSimulate(req, res);
    return;
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    const state = currentState();
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      node: process.version,
      profiles: state.profiles.length,
      activeId: state.activeId,
      writable: configStore.canWriteConfig(),
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
});

function listen(port, attemptsLeft = 12) {
  const onError = (err) => {
    server.removeListener('error', onError);
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`端口 ${port} 被占用，换 ${port + 1} 试试…`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    const url = `http://${HOST}:${port}/`;
    console.log('');
    console.log('  灵犀 · 聊天解读小工具 已启动');
    console.log('  ------------------------------------------');
    console.log(`  在浏览器打开：${url}`);
    console.log('  数据不出本机：只有你主动点「开始分析」时，聊天内容才会发给你自己配置的模型。');
    console.log('  关闭此窗口即可停止服务（或按 Ctrl+C）。');
    console.log('');
    if (!NO_OPEN) openBrowser(url);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch {
    /* 打不开就算了，用户可手动访问 */
  }
}

listen(PORT);
