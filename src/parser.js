'use strict';
/**
 * QQ / 微信 等聊天记录文本解析器
 *
 * 支持的典型格式：
 *   小鹿: 10-08 19:01:50
 *   在吗
 *
 *   小鹿 2024-10-08 19:01:50
 *   在吗
 *
 *   [2024-10-08 19:01:50] 小鹿
 *   在吗
 *
 *   2024/10/8 19:01 小鹿
 *   在吗
 *
 * 同时也兼容"时间在消息后一行"的情况（部分导出工具）。
 */

const KIND = {
  TEXT: 'text',
  IMAGE: 'image',
  VOICE: 'voice',
  VIDEO: 'video',
  FILE: 'file',
  STICKER: 'sticker',
  SYSTEM: 'system',
  REDPACKET: 'redpacket',
  OTHER: 'other',
};

const BRACKET_KINDS = [
  { re: /^\[图片\]|^\[照片\]|^\[Image\]$/i, kind: KIND.IMAGE, label: '[图片]' },
  { re: /^\[语音\]|^\[Voice\]$/i, kind: KIND.VOICE, label: '[语音]' },
  { re: /^\[视频\]|^\[Video\]$/i, kind: KIND.VIDEO, label: '[视频]' },
  { re: /^\[文件\]|^\[File\]/i, kind: KIND.FILE, label: '[文件]' },
  { re: /^\[动画表情\]|^\[表情\]$|^\[Sticker\]$/i, kind: KIND.STICKER, label: '[表情]' },
  { re: /^\[红包\]/, kind: KIND.REDPACKET, label: '[红包]' },
  { re: /^\[(系统消息|QQ红包|转账|位置|名片|分享|音乐|链接|合并转发|聊天记录)\]/, kind: KIND.SYSTEM, label: null },
];

const SYSTEM_LINE_RE = new RegExp(
  [
    '撤回了一条消息',
    '撤回了一條消息',
    '对方撤回',
    '你撤回',
    '以上是打招呼的内容',
    '以下为新消息',
    '以上为新消息',
    '消息已发出，但被对方拒收',
    '消息已发出，但对方',
    '开启了朋友验证',
    '已经是好友',
    '邀请.+加入群聊',
    '加入了群聊',
    '退出了群聊',
    '与.+连续互发',
    '你已添加了',
    '拍了拍',
    '\\[系统消息\\]',
    '^\\s*={2,}\\s*$',
  ].join('|'),
);

const DATE_ONLY_RE = /^\s*[\[\(]?\s*(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*[\]\)]?\s*$/;

const RE_FULL = /^\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*[,，]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(上午|下午|AM|PM)?\s*[\]\)]?\s*$/i;
const RE_BRACKET = /^\s*[\[\(]?\s*(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*[,，]?\s*)?(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(上午|下午|AM|PM)?\s*[\]\)]\s*$/i;
const RE_PLAIN = /^\s*(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(上午|下午|AM|PM)?\s*$/i;
const RE_INLINE_TS = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?/;

const RE_REPLY_TAIL = /\s*\[[^\]\n]{1,60}\]\s*$/;

const META_TOKEN_RE = /\[(图片|照片|表情|动画表情|语音|视频|文件|红包|转账|位置|名片|分享|音乐|链接|合并转发|聊天记录|QQ红包|戳一戳|动画表情)\]/g;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeHeader(header) {
  let h = String(header || '');
  h = h.replace(/[【】]/g, '');
  h = h.replace(/^[\s,，:：\-–—>》\]]+/, '');
  h = h.replace(/[\s:：\-–—<《\[\]]+$/, '');
  return h.trim();
}

/**
 * 探测一段文本的时间戳格式（用于界面提示与导入前预览）。
 */
function detectFormat(text) {
  if (!text) return { ok: false, reason: '内容为空' };
  const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 60);
  let plain = 0;
  let full = 0;
  let bracket = 0;
  let inline = 0;
  for (const line of head) {
    if (RE_FULL.test(line)) full += 1;
    if (RE_BRACKET.test(line)) bracket += 1;
    if (RE_PLAIN.test(line)) plain += 1;
    if (!RE_FULL.test(line) && !RE_BRACKET.test(line) && !RE_PLAIN.test(line) && RE_INLINE_TS.test(line)) {
      inline += 1;
    }
  }
  const total = full + bracket + plain + inline;
  let type = 'none';
  if (total === 0) type = 'none';
  else if (inline >= full + bracket + plain) type = 'inline';
  else if (full + bracket >= plain) type = 'header';
  else type = 'header';
  return { ok: type !== 'none', type, counts: { full, bracket, plain, inline } };
}

/**
 * 解析聊天记录文本。
 * @param {string} text
 * @param {{aName?:string,bName?:string,defaultYear?:number}} options
 * @returns {{messages:Array, speakers:Array, stats:Object, warnings:Array}}
 */
function parseChatLog(text, options = {}) {
  const defaultYear = Number(options.defaultYear) || new Date().getFullYear();
  const warnings = [];
  let src = String(text || '');
  if (!src.trim()) {
    return { messages: [], speakers: [], warnings: ['聊天记录为空'], stats: emptyStats() };
  }

  src = src.replace(/^\uFEFF/, '');
  src = src.replace(/\r\n?/g, '\n');
  // 去掉零宽字符
  src = src.replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (/<\/?[a-zA-Z][^>]*>/.test(src)) {
    warnings.push('检测到 HTML/XML 标签，已自动去除标签，仅保留文本。');
    src = src
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
    src = src.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  if (/\t|,{2,}|"\s*,\s*"/.test(src) && !RE_PLAIN.test(src.split('\n').slice(0, 40).join('\n'))) {
    // 可能是 CSV，但不敢乱切，只做提示
    const csvLike = src.split('\n').filter((l) => (l.match(/,/g) || []).length >= 2).length;
    if (csvLike > 5) {
      warnings.push('这段内容看起来像 CSV/表格导出，若解析结果不对，请改成「昵称: 时间」的纯文本格式再粘贴。');
    }
  }

  const rawMessages = [];
  let cur = null;
  let year = null;
  let lastMonth = null;
  let lastDate = null;
  let lineNo = 0;

  const flush = () => {
    if (!cur) return;
    cur.text = cur.text.replace(/^\n+/, '').replace(/\s+$/, '');
    let body = cur.text;
    if (!body) {
      cur = null;
      return;
    }
    let kind = KIND.TEXT;
    let label = null;

    // [表情] 之类的元信息标记
    const tokens = body.match(META_TOKEN_RE);
    if (tokens && tokens.length) {
      for (const t of tokens) {
        const found = BRACKET_KINDS.find((b) => b.re.test(t));
        if (found) {
          kind = found.kind;
          label = found.label || t;
          break;
        }
      }
      const stripped = body.replace(META_TOKEN_RE, '').trim();
      if (stripped) {
        kind = KIND.TEXT;
        body = stripped;
      } else {
        body = label || '[非文本]';
      }
    }

    // 引用尾巴：[回复 xxx]
    const replyMatch = body.match(RE_REPLY_TAIL);
    if (replyMatch && kind === KIND.TEXT) {
      cur.replyTo = normalizeHeader(replyMatch[0].replace(/^\[|\]$/g, ''));
      cur.textRaw = body;
      body = body.replace(RE_REPLY_TAIL, '').trim();
    }

    if (kind === KIND.TEXT && SYSTEM_LINE_RE.test(body)) {
      kind = KIND.SYSTEM;
    }

    cur.kind = kind;
    cur.text = body;
    rawMessages.push(cur);
    cur = null;
  };

  const lines = src.split('\n');
  for (const rawLine of lines) {
    lineNo += 1;
    const line = rawLine.replace(/\s+$/, '');

    if (!line.trim()) {
      if (cur) cur.text += '\n';
      continue;
    }

    const dOnly = line.match(DATE_ONLY_RE);
    if (dOnly) {
      year = Number(dOnly[1]);
      lastMonth = Number(dOnly[2]);
      lastDate = Number(dOnly[3]);
      flush();
      continue;
    }

    const mFull = line.match(RE_FULL);
    const mBracket = line.match(RE_BRACKET);
    const mPlain = line.match(RE_PLAIN);

    let ts = null;
    let rest = null;
    let hasYear = false;

    if (mFull) {
      hasYear = true;
      ts = {
        year: Number(mFull[1]),
        month: Number(mFull[2]),
        day: Number(mFull[3]),
        hour: Number(mFull[4]),
        minute: Number(mFull[5]),
        second: Number(mFull[6] || 0),
        meridiem: mFull[7] || null,
      };
      rest = line.replace(mFull[0], '');
    } else if (mBracket) {
      // 可能是 [2024-10-08 19:01:50] 也可能是 [10-08 19:01:50]
      const yr = mBracket[0].match(/(\d{4})[-/.年]\d{1,2}[-/.月]\d{1,2}/);
      ts = {
        year: yr ? Number(yr[1]) : undefined,
        month: Number(mBracket[1]),
        day: Number(mBracket[2]),
        hour: Number(mBracket[3]),
        minute: Number(mBracket[4]),
        second: Number(mBracket[5] || 0),
        meridiem: mBracket[6] || null,
      };
      rest = line.replace(mBracket[0], '');
    } else if (mPlain) {
      ts = {
        month: Number(mPlain[1]),
        day: Number(mPlain[2]),
        hour: Number(mPlain[3]),
        minute: Number(mPlain[4]),
        second: Number(mPlain[5] || 0),
        meridiem: mPlain[6] || null,
      };
      rest = line.replace(mPlain[0], '');
    }

    if (ts) {
      // 时间在左边，昵称在右边
      if (ts.meridiem) {
        const pm = /下午|PM/i.test(ts.meridiem);
        const am = /上午|AM/i.test(ts.meridiem);
        if (pm && ts.hour < 12) ts.hour += 12;
        if (am && ts.hour === 12) ts.hour = 0;
      }
      if (!hasYear && ts.year == null) {
        const curYear = year == null ? defaultYear : year;
        ts.year = curYear;
        if (lastMonth != null && ts.month < lastMonth - 6) {
          // 跨年（如 12 月 -> 1 月）
          year = curYear + 1;
          ts.year = year;
        } else {
          year = curYear;
        }
      } else {
        year = ts.year;
      }
      lastMonth = ts.month;
      lastDate = ts.day;
      const speaker = normalizeHeader(rest);
      if (!speaker) {
        warnings.push(`第 ${lineNo} 行有时没有昵称，已跳过该行时间戳。`);
        continue;
      }
      flush();
      cur = {
        idx: rawMessages.length,
        speaker,
        year: ts.year,
        month: ts.month,
        day: ts.day,
        hour: ts.hour,
        minute: ts.minute,
        second: ts.second,
        ts: makeTs(ts),
        text: '',
        kind: KIND.TEXT,
        line: lineNo,
      };
      continue;
    }

    // 时间在右边：昵称 时间  或  消息内容 时间
    if (RE_INLINE_TS.test(line) && !cur) {
      const m = line.match(RE_INLINE_TS);
      const idxTs = line.indexOf(m[0]);
      const left = normalizeHeader(line.slice(0, idxTs));
      const rightPart = line.slice(idxTs + m[0].length).trim();
      const parsed = parseInlineTs(m[0], year, defaultYear, lastMonth);
      if (left && rightPart === '') {
        if (parsed.year !== year && parsed.month < (lastMonth || 99) - 6) {
          // 跨年
        }
        year = parsed.year;
        lastMonth = parsed.month;
        flush();
        cur = {
          idx: rawMessages.length,
          speaker: left,
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          hour: parsed.hour,
          minute: parsed.minute,
          second: parsed.second,
          ts: parsed.ts,
          text: '',
          kind: KIND.TEXT,
          line: lineNo,
          inlineTs: true,
        };
        continue;
      }
    }

    if (cur) {
      cur.text += (cur.text ? '\n' : '') + line;
    } else {
      // 没有识别到任何时间戳，先当作前一条的延续；若还没有消息则暂存为前言
      warnings.push(`第 ${lineNo} 行没有时间戳，也没有上一条消息可挂靠，已忽略：${line.slice(0, 24)}`);
    }
  }
  flush();

  const systemCount = rawMessages.filter((m) => m.kind === KIND.SYSTEM).length;
  if (systemCount > 0) {
    warnings.push(`已自动识别并过滤 ${systemCount} 条系统提示（撤回、拍了拍等）。`);
  }

  const speakers = [];
  const speakerCount = new Map();
  for (const m of rawMessages) {
    speakerCount.set(m.speaker, (speakerCount.get(m.speaker) || 0) + 1);
    if (!speakers.includes(m.speaker)) speakers.push(m.speaker);
  }
  speakers.sort((a, b) => (speakerCount.get(b) || 0) - (speakerCount.get(a) || 0));

  if (options.aName && options.bName) {
    const known = [options.aName, options.bName];
    const unknown = speakers.filter((s) => !known.includes(s));
    if (unknown.length) {
      warnings.push(`记录里出现了没填进昵称栏的说话人：${unknown.slice(0, 6).join('、')}。可以在昵称栏用 / 分隔补充。`);
    }
  }
  if (rawMessages.length === 0) {
    warnings.push('没有解析出任何消息，请确认格式形如「昵称: 10-08 19:01:50」且时间与昵称在同一行。');
  }

  const messages = rawMessages.map((m, i) => ({ ...m, idx: i }));

  return {
    messages,
    speakers,
    warnings: dedupe(warnings),
    stats: {
      total: messages.length,
      textCount: messages.filter((m) => m.kind === KIND.TEXT).length,
      mediaCount: messages.filter((m) => m.kind !== KIND.TEXT && m.kind !== KIND.SYSTEM).length,
      systemCount,
      firstTs: messages.length ? messages[0].ts : null,
      lastTs: messages.length ? messages[messages.length - 1].ts : null,
    },
  };
}

function parseInlineTs(str, prevYear, defaultYear, lastMonth) {
  const clean = str.trim();
  const full = clean.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (full) {
    const o = {
      year: Number(full[1]),
      month: Number(full[2]),
      day: Number(full[3]),
      hour: Number(full[4]),
      minute: Number(full[5]),
      second: Number(full[6] || 0),
    };
    return { ...o, ts: makeTs(o) };
  }
  const short = clean.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const o = {
    month: Number(short[1]),
    day: Number(short[2]),
    hour: Number(short[3]),
    minute: Number(short[4]),
    second: Number(short[5] || 0),
  };
  let y = prevYear == null ? defaultYear : prevYear;
  if (lastMonth != null && o.month < lastMonth - 6) y += 1;
  o.year = y;
  return { ...o, ts: makeTs(o) };
}

function makeTs(o) {
  const y = o.year;
  const mo = pad2(o.month);
  const d = pad2(o.day);
  const h = pad2(o.hour);
  const mi = pad2(o.minute);
  const s = pad2(o.second || 0);
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const dt = new Date(iso);
  const valid = !Number.isNaN(dt.getTime());
  return {
    iso,
    label: `${y}-${mo}-${d} ${h}:${mi}:${s}`,
    short: `${mo}-${d} ${h}:${mi}`,
    clock: `${h}:${mi}`,
    ms: valid ? dt.getTime() : null,
    valid,
  };
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

function emptyStats() {
  return { total: 0, textCount: 0, mediaCount: 0, systemCount: 0, firstTs: null, lastTs: null };
}

module.exports = { parseChatLog, detectFormat, KIND };
