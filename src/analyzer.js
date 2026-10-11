'use strict';
/**
 * 分析流水线：分段 -> 逐段分析 -> 汇总综合。
 * 所有模型输出都被强制成同一套 JSON，因此不同厂商的模型可以互换。
 */

const { chat } = require('./llm');
const prompts = require('./prompts');

const DEFAULTS = {
  chunkSize: 400,
  overlap: 6,
  maxChunks: 12,
  temperature: 0.4,
  maxTokens: 8000,
  timeoutMs: 300000,
};

/** 从模型输出里抠出 JSON：容忍代码块、前后废话、尾部被截断、中文标点。 */
function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^\uFEFF/, '');

  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();

  const first = s.indexOf('{');
  if (first === -1) return null;

  const candidate = s.slice(first);
  const attempts = [
    () => JSON.parse(candidate),
    () => JSON.parse(repairJson(candidate)),
    () => JSON.parse(repairJson(truncateToBalanced(candidate))),
    () => JSON.parse(repairJson(stripTrailingCommas(truncateToBalanced(candidate)))),
  ];

  const cleaned = s.slice(first).replace(/[\u201c\u201d]/g, '"');
  attempts.push(() => JSON.parse(repairJson(truncateToBalanced(cleaned))));

  for (const fn of attempts) {
    try {
      const v = fn();
      if (v && typeof v === 'object') return v;
    } catch {
      /* 试下一种 */
    }
  }
  return null;
}

function stripTrailingCommas(str) {
  return str.replace(/,\s*([}\]])/g, '$1');
}

/** 截到最后一个结构平衡的位置，丢掉被截断的尾巴。 */
function truncateToBalanced(str) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastBalancedEnd = -1;
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) lastBalancedEnd = i;
    }
  }
  if (depth === 0) return str;
  return str.slice(0, lastBalancedEnd === -1 ? str.length : lastBalancedEnd + 1);
}

function repairJson(str) {
  let out = '';
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (inStr) {
      if (esc) {
        const valid = '"\\/bfnrtu';
        if (valid.includes(c)) out += c;
        else if (c === 'n') out += '\\n';
        else out += c;
        esc = false;
        continue;
      }
      if (c === '\\') {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        // 判断是否真的是字符串结束：后面应当是 , } ] : 或空白
        const rest = str.slice(i + 1);
        if (/^\s*[,}\]:]/.test(rest) || /^\s*$/.test(rest)) {
          out += '"';
          inStr = false;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (c === '\n') {
        out += '\\n';
        continue;
      }
      if (c === '\r') continue;
      if (c === '\t') {
        out += '\\t';
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
    out += c;
  }
  if (inStr) out += '"';
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return stripTrailingCommas(out);
}

function normalizeReport(obj, opts = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const ov = obj.overview || {};
  const report = {
    overview: {
      temperature: Number.isFinite(Number(ov.temperature)) ? Math.max(0, Math.min(100, Number(ov.temperature))) : null,
      trend: str(ov.trend),
      otherAttitude: str(ov.otherAttitude),
      signals: strArray(ov.signals),
    },
    insights: arr(obj.insights)
      .map((x) => ({
        ref: Number.isFinite(Number(x.ref)) ? Number(x.ref) : null,
        speaker: str(x.speaker),
        text: str(x.text),
        emotion: str(x.emotion),
        surface: str(x.surface),
        subtext: str(x.subtext),
        confidence: Number.isFinite(Number(x.confidence)) ? Math.max(0, Math.min(100, Number(x.confidence))) : null,
        suggestion: str(x.suggestion),
      }))
      .filter((x) => x.text || x.subtext),
    review: arr(obj.review)
      .map((x) => ({
        ref: Number.isFinite(Number(x.ref)) ? Number(x.ref) : null,
        myText: str(x.myText),
        otherBefore: str(x.otherBefore),
        issue: str(x.issue),
        why: str(x.why),
        severity: str(x.severity),
        rewrite: str(x.rewrite),
        whyBetter: str(x.whyBetter),
      }))
      .filter((x) => x.myText || x.issue),
    advice: {
      do: strArray(obj.advice && obj.advice.do),
      dont: strArray(obj.advice && obj.advice.dont),
      topicIdeas: strArray(obj.advice && obj.advice.topicIdeas),
      nextMove: {
        shouldReach: str(obj.advice && obj.advice.nextMove && obj.advice.nextMove.shouldReach),
        message: str(obj.advice && obj.advice.nextMove && obj.advice.nextMove.message),
        fallback: str(obj.advice && obj.advice.nextMove && obj.advice.nextMove.fallback),
      },
      watchList: strArray(obj.advice && obj.advice.watchList),
    },
    warnings: strArray(obj.warnings),
    meta: opts.meta || {},
  };
  return report;
}

function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join('；');
  if (typeof v === 'object') {
    return Object.entries(v)
      .map(([k, val]) => `${k}：${str(val)}`)
      .filter((s) => !s.endsWith('：'))
      .join('；');
  }
  return '';
}

function strArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'object' && x !== null ? str(x) : str(x)))
      .filter((s) => s && s.length > 0);
  }
  if (typeof v === 'string') {
    return v
      .split(/\n|；|;/)
      .map((s) => s.replace(/^[\s\-•*\d.、)]+/, '').trim())
      .filter(Boolean);
  }
  return [str(v)].filter(Boolean);
}

function arr(v) {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
  if (v && typeof v === 'object') return [v];
  return [];
}

function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const key = s.replace(/\s+/g, '').slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 汇总失败时的本地兜底合并 */
function mergeLocally(partials, meta) {
  const overview = { temperature: null, trend: '', otherAttitude: '', signals: [] };
  const insights = [];
  const review = [];
  const advice = { do: [], dont: [], topicIdeas: [], nextMove: { shouldReach: '', message: '', fallback: '' }, watchList: [] };
  const temps = [];
  const attitudes = [];
  for (const p of partials) {
    if (!p) continue;
    if (Number.isFinite(p.overview && p.overview.temperature)) temps.push(p.overview.temperature);
    if (p.overview && p.overview.otherAttitude) attitudes.push(p.overview.otherAttitude);
    if (p.overview && p.overview.trend && !overview.trend) overview.trend = p.overview.trend;
    overview.signals.push(...(p.overview.signals || []));
    insights.push(...(p.insights || []));
    review.push(...(p.review || []));
    advice.do.push(...(p.advice.do || []));
    advice.dont.push(...(p.advice.dont || []));
    advice.topicIdeas.push(...(p.advice.topicIdeas || []));
    advice.watchList.push(...(p.advice.watchList || []));
    const nm = p.advice.nextMove || {};
    if (nm.shouldReach && !advice.nextMove.shouldReach) advice.nextMove.shouldReach = nm.shouldReach;
    if (nm.message && !advice.nextMove.message) advice.nextMove.message = nm.message;
    if (nm.fallback && !advice.nextMove.fallback) advice.nextMove.fallback = nm.fallback;
  }
  if (temps.length) overview.temperature = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length);
  overview.otherAttitude = attitudes.slice(0, 2).join(' ');
  overview.signals = dedupeStrings(overview.signals).slice(0, 8);
  advice.do = dedupeStrings(advice.do).slice(0, 6);
  advice.dont = dedupeStrings(advice.dont).slice(0, 6);
  advice.topicIdeas = dedupeStrings(advice.topicIdeas).slice(0, 6);
  advice.watchList = dedupeStrings(advice.watchList).slice(0, 5);

  const sevRank = { 高: 0, 中: 1, 低: 2 };
  const seenReview = new Set();
  const finalReview = [];
  for (const r of review.sort((a, b) => (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1))) {
    const key = (r.myText || '').slice(0, 16) + '|' + (r.issue || '');
    if (seenReview.has(key)) continue;
    seenReview.add(key);
    finalReview.push(r);
    if (finalReview.length >= 10) break;
  }
  const seenInsight = new Set();
  const finalInsights = [];
  for (const i of insights.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
    const key = (i.text || '').slice(0, 16);
    if (seenInsight.has(key)) continue;
    seenInsight.add(key);
    finalInsights.push(i);
    if (finalInsights.length >= 12) break;
  }

  return normalizeReport(
    { overview, insights: finalInsights, review: finalReview, advice, warnings: ['分段汇总模型调用失败，本条报告由分段结果本地合并而成。'] },
    { meta: { ...meta, merged: 'local' } },
  );
}

function planChunks(total, opts = {}) {
  const chunkSize = opts.chunkSize || DEFAULTS.chunkSize;
  const overlap = opts.overlap || DEFAULTS.overlap;
  const maxChunks = opts.maxChunks || DEFAULTS.maxChunks;
  if (total <= 0) return [];
  if (total <= chunkSize) return [{ start: 0, end: total }];
  const chunks = [];
  let start = 0;
  while (start < total && chunks.length < maxChunks) {
    const end = Math.min(total, start + chunkSize);
    chunks.push({ start, end });
    if (end >= total) break;
    start = end - overlap;
  }
  if (chunks.length && chunks[chunks.length - 1].end < total) {
    // 超出 maxChunks 时，最后一段扩到结尾，避免丢失最新消息
    chunks[chunks.length - 1].end = total;
  }
  return chunks;
}

/**
 * 主分析流程。
 * @param {object} input {messages, statsText, localFindings, ctx, config}
 * @param {(evt:object)=>void} onEvent
 */
async function analyze(input, onEvent = () => {}) {
  const cfg = input.config || {};
  const messages = input.messages || [];
  const opts = {
    chunkSize: Number(cfg.chunkSize) > 0 ? Number(cfg.chunkSize) : DEFAULTS.chunkSize,
    overlap: DEFAULTS.overlap,
    maxChunks: Number(cfg.maxChunks) > 0 ? Number(cfg.maxChunks) : DEFAULTS.maxChunks,
  };
  const chunks = planChunks(messages.length, opts);
  const baseCfg = {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature != null ? cfg.temperature : DEFAULTS.temperature,
    maxTokens: cfg.maxTokens || DEFAULTS.maxTokens,
    timeoutMs: cfg.timeoutMs || DEFAULTS.timeoutMs,
    stream: cfg.stream !== false,
    json: cfg.json !== false,
  };

  onEvent({ type: 'phase', phase: 'plan', chunks: chunks.map((c) => ({ start: c.start, end: c.end })), total: messages.length });

  const system = prompts.systemPrompt();
  const partials = [];
  let usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
  let usedModel = baseCfg.model || '';

  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    onEvent({ type: 'phase', phase: 'chunk', index: i + 1, total: chunks.length, start: c.start, end: c.end });
    const user = prompts.buildChunkPrompt({
      messages,
      start: c.start,
      end: c.end,
      statsText: input.statsText,
      localFindings: input.localFindings,
      ctx: input.ctx,
      totalCount: messages.length,
      partIndex: i + 1,
      partTotal: chunks.length,
    });

    let parsed = null;
    let raw = '';
    const first = await runModel(baseCfg, system, user, onEvent, `分段 ${i + 1}/${chunks.length}`);
    raw = first.text;
    usedModel = first.model || usedModel;
    accUsage(usageTotal, first.usage);
    parsed = extractJson(raw);
    if (!parsed) {
      onEvent({ type: 'note', message: `分段 ${i + 1} 的返回不是标准 JSON，正在自动修复重试…` });
      const retry = await runModel(
        { ...baseCfg, temperature: 0.1 },
        system,
        user + '\n\n【特别提醒】上一次你的输出不是合法 JSON。这一次请务必只输出一个合法 JSON 对象，字符串内不要出现真实换行，不要在 JSON 前后加任何文字。',
        onEvent,
        `分段 ${i + 1} 修复重试`,
      );
      accUsage(usageTotal, retry.usage);
      parsed = extractJson(retry.text);
      if (!parsed) raw = first.text + '\n' + retry.text;
    }
    const norm = normalizeReport(parsed, { meta: { chunk: i + 1 } });
    if (norm) {
      partials.push(norm);
      onEvent({ type: 'partial', index: i + 1, total: chunks.length, report: norm });
    } else {
      onEvent({
        type: 'note',
        message: `分段 ${i + 1} 没能解析出结构化结果，已在最终报告中跳过这一段。可考虑换更强的模型或减小分段。`,
        raw: raw.slice(0, 4000),
      });
    }
  }

  if (!partials.length) {
    throw new Error('所有分段都没有返回可解析的结果，请检查模型是否支持 JSON 输出，或换一个模型再试。');
  }

  let final = null;
  if (partials.length === 1 && chunks.length === 1) {
    final = partials[0];
    onEvent({ type: 'phase', phase: 'done', merged: 'single' });
  } else {
    onEvent({ type: 'phase', phase: 'synthesize', total: partials.length });
    const synUser = prompts.buildSynthesizePrompt({
      partials: partials.map((p) => ({
        overview: p.overview,
        insights: p.insights,
        review: p.review,
        advice: p.advice,
      })),
      statsText: input.statsText,
      ctx: input.ctx,
      totalCount: messages.length,
    });
    try {
      const syn = await runModel({ ...baseCfg, temperature: 0.3 }, system, synUser, onEvent, '全文汇总');
      accUsage(usageTotal, syn.usage);
      usedModel = syn.model || usedModel;
      const parsedSyn = extractJson(syn.text);
      const normSyn = normalizeReport(parsedSyn, { meta: { merged: 'llm', chunks: partials.length } });
      final = normSyn || mergeLocally(partials, { chunks: partials.length });
      if (!normSyn) onEvent({ type: 'note', message: '汇总结果解析失败，已改用分段本地合并。' });
    } catch (err) {
      onEvent({ type: 'note', message: `汇总调用失败（${err.message}），已改用分段本地合并。` });
      final = mergeLocally(partials, { chunks: partials.length });
    }
  }

  if (final) {
    final.meta = {
      ...(final.meta || {}),
      model: usedModel,
      chunks: chunks.length,
      messageCount: messages.length,
      usage: usageTotal,
      analyzedAt: new Date().toISOString(),
    };
  }
  onEvent({ type: 'done', report: final, usage: usageTotal, model: usedModel });
  return final;
}

async function runModel(cfg, system, user, onEvent, label) {
  onEvent({ type: 'model_start', label });
  let streamed = 0;
  const result = await chat({ ...cfg, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, (evt) => {
    if (evt.type === 'delta') {
      streamed += evt.text.length;
      onEvent({ type: 'stream', label, chars: evt.total, text: evt.text });
    } else if (evt.type === 'reasoning') {
      onEvent({ type: 'reasoning', label, chars: evt.total });
    } else if (evt.type === 'retry') {
      onEvent({ type: 'retry', label, attempt: evt.attempt, message: evt.message });
    }
  });
  void streamed;
  onEvent({ type: 'model_end', label, chars: result.text.length });
  return result;
}

function accUsage(total, usage) {
  if (!usage) return;
  total.prompt_tokens += Number(usage.prompt_tokens || usage.input_tokens || 0);
  total.completion_tokens += Number(usage.completion_tokens || usage.output_tokens || 0);
}

/**
 * 试聊模拟：预测对方反应。
 */
async function simulate(input, onEvent = () => {}) {
  const cfg = input.config || {};
  const baseCfg = {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature != null ? cfg.temperature : 0.5,
    maxTokens: cfg.maxTokens || 2000,
    timeoutMs: cfg.timeoutMs || 120000,
    stream: cfg.stream !== false,
    json: cfg.json !== false,
  };
  const user = prompts.buildSimulatePrompt({
    draft: input.draft,
    ctx: input.ctx,
    recentText: input.recentText,
    statsText: input.statsText,
  });
  const res = await runModel(baseCfg, prompts.systemPrompt(), user, onEvent, '试聊模拟');
  const parsed = extractJson(res.text);
  if (!parsed) throw new Error('模型没有返回可解析的 JSON，请重试或换个模型。');
  return {
    replies: arr(parsed.replies)
      .map((r) => ({
        style: str(r.style),
        likelihood: Number.isFinite(Number(r.likelihood)) ? Math.max(0, Math.min(100, Number(r.likelihood))) : null,
        reply: str(r.reply),
      }))
      .filter((r) => r.reply),
    risks: strArray(parsed.risks),
    readiness: Number.isFinite(Number(parsed.readiness)) ? Math.max(0, Math.min(100, Number(parsed.readiness))) : null,
    verdict: str(parsed.verdict),
    improved: str(parsed.improved),
  };
}

module.exports = {
  analyze,
  simulate,
  extractJson,
  repairJson,
  normalizeReport,
  planChunks,
  mergeLocally,
  DEFAULTS,
  _internal: { truncateToBalanced, stripTrailingCommas, strArray, str },
};
