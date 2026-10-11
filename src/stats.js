'use strict';
/**
 * 本地硬统计：不调用任何模型，纯规则计算互动节奏、主动性与表达习惯。
 */

const KIND_TEXT = 'text';
const KIND_SYSTEM = 'system';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const KAOMOJI_RE = /(\(|\uff08)?[Tt][_\-]?[Tt]|>[_<]|\.{2,}|~{2,}|233+|hhh+|哈哈|嘿嘿|嘻嘻|嘤嘤|呜呜|emmm+|额+|\uD83D\uDE02/g;
const LAUGH_RE = /哈哈|hhh|233|笑死|嘿嘿|嘻嘻|\uD83D\uDE02|\uD83D\uDE04|\uD83E\uDD23/g;
const QUESTION_RE=/[?？]/g;
const FILLER_RE = /就是|那个|其实|反正|然后|怎么说|emm+|呃+|嗯+|哦+|额+/g;
const CLOSER_RE = /晚安|早点睡|睡吧|明天见|先这样|拜拜|安啦|睡了|我先睡|么么|抱抱|照顾好自己/g;

function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] !== undefined) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtMin(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const m = ms / 60000;
  if (m < 1) return `${Math.round(ms / 1000)} 秒`;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)} 分钟`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

function countMatches(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

/**
 * @param {Array} messages
 * @param {{selfName?:string, otherName?:string, sessionGapMinutes?:number}} options
 */
function computeStats(messages, options = {}) {
  const sessionGapMs = (options.sessionGapMinutes || 240) * 60000;
  const list = (messages || []).filter((m) => m.kind !== KIND_SYSTEM);
  const self = options.selfName || null;
  const other = options.otherName || null;
  const speakers = [];
  for (const m of list) if (!speakers.includes(m.speaker)) speakers.push(m.speaker);

  const per = new Map();
  for (const s of speakers) {
    per.set(s, {
      name: s,
      count: 0,
      textCount: 0,
      chars: 0,
      lens: [],
      media: 0,
      sticker: 0,
      image: 0,
      voice: 0,
      questions: 0,
      laugh: 0,
      emoji: 0,
      filler: 0,
      lateNight: 0,
      runs: [],
      replyDelays: [],
    });
  }

  const hourHistogram = {};
  for (let h = 0; h < 24; h += 1) hourHistogram[h] = {};

  let prev = null;
  let run = null;
  const sessions = [];

  for (const m of list) {
    const p = per.get(m.speaker);
    p.count += 1;
    const text = m.text || '';
    if (m.kind === KIND_TEXT) {
      p.textCount += 1;
      p.chars += text.length;
      p.lens.push(text.length);
      p.questions += countMatches(text, QUESTION_RE);
      p.laugh += countMatches(text, LAUGH_RE);
      p.emoji += countMatches(text, EMOJI_RE);
      p.filler += countMatches(text, FILLER_RE);
      if (m.hour >= 0 && (m.hour < 6)) p.lateNight += 1;
    } else {
      p.media += 1;
      if (m.kind === 'sticker') p.sticker += 1;
      if (m.kind === 'image') p.image += 1;
      if (m.kind === 'voice') p.voice += 1;
    }

    const hourKey = String(m.hour).padStart(2, '0');
    hourHistogram[m.hour][m.speaker] = (hourHistogram[m.hour][m.speaker] || 0) + 1;

    if (prev) {
      const gap = m.ts && prev.ts && m.ts.ms != null && prev.ts.ms != null ? m.ts.ms - prev.ts.ms : null;
      if (gap != null && gap >= 0) {
        if (gap > sessionGapMs) {
          sessions.push({ start: prev, end: prev, gapAfter: gap });
        }
        if (m.speaker !== prev.speaker) {
          p.replyDelays.push(gap);
        }
      }
    }

    if (run && run.speaker === m.speaker) {
      run.count += 1;
    } else {
      if (run) per.get(run.speaker).runs.push(run.count);
      run = { speaker: m.speaker, count: 1, startIdx: m.idx };
    }
    prev = m;
  }
  if (run) per.get(run.speaker).runs.push(run.count);

  // 会话切分
  const sessionList = [];
  let curSession = null;
  let lastMs = null;
  for (const m of list) {
    const ms = m.ts && m.ts.ms != null ? m.ts.ms : null;
    if (curSession == null || (ms != null && lastMs != null && ms - lastMs > sessionGapMs)) {
      if (curSession) sessionList.push(curSession);
      curSession = { startIdx: m.idx, endIdx: m.idx, startTs: m.ts, messages: [m] };
    } else {
      curSession.endIdx = m.idx;
      curSession.messages.push(m);
    }
    lastMs = ms;
  }
  if (curSession) sessionList.push(curSession);

  const initiators = new Map();
  const enders = new Map();
  let longestSilence = null;
  let prevM = null;
  for (const s of sessionList) {
    const first = s.messages[0];
    initiators.set(first.speaker, (initiators.get(first.speaker) || 0) + 1);
    const last = s.messages[s.messages.length - 1];
    enders.set(last.speaker, (enders.get(last.speaker) || 0) + 1);
  }
  for (const m of list) {
    if (prevM && m.ts && prevM.ts && m.ts.ms != null && prevM.ts.ms != null) {
      const gap = m.ts.ms - prevM.ts.ms;
      if (gap > 0 && (!longestSilence || gap > longestSilence.gap)) {
        longestSilence = { gap, from: prevM.ts.label, to: m.ts.label, by: prevM.speaker };
      }
    }
    prevM = m;
  }

  const overnights = [];
  for (const m of list) {
    if (m.hour >= 0 && m.hour < 6 && m.kind === KIND_TEXT) {
      if (!overnights.length || overnights[overnights.length - 1].ts.short !== m.ts.short) {
        overnights.push({ speaker: m.speaker, text: (m.text || '').slice(0, 60), ts: m.ts });
      }
    }
  }

  const people = speakers.map((s) => {
    const p = per.get(s);
    return {
      name: s,
      count: p.count,
      textCount: p.textCount,
      share: list.length ? p.count / list.length : 0,
      avgLen: p.lens.length ? Number((p.chars / p.lens.length).toFixed(1)) : 0,
      medianLen: median(p.lens),
      media: p.media,
      sticker: p.sticker,
      image: p.image,
      voice: p.voice,
      questions: p.questions,
      laugh: p.laugh,
      emoji: p.emoji,
      filler: p.filler,
      lateNight: p.lateNight,
      replyMedianMs: median(p.replyDelays),
      replyMeanMs: p.replyDelays.length ? mean(p.replyDelays) : null,
      replySamples: p.replyDelays.length,
      medianRun: median(p.runs),
      maxRun: p.runs.length ? Math.max(...p.runs) : 0,
      initiations: initiators.get(s) || 0,
      sessionEnds: enders.get(s) || 0,
    };
  });

  for (const p of people) {
    p.initiationShare = sessionList.length ? p.initiations / sessionList.length : 0;
  }

  const sharedHours = [];
  for (let h = 0; h < 24; h += 1) {
    const both = Object.keys(hourHistogram[h]).length >= 2;
    if (both) sharedHours.push(h);
  }
  const peakHours = Object.entries(hourHistogram)
    .map(([h, bySpeaker]) => ({ hour: Number(h), total: Object.values(bySpeaker).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .filter((x) => x.total > 0);

  const textMsgs = list.filter((m) => m.kind === KIND_TEXT && m.text);
  const timeline = [];
  const bucketSize = Math.max(1, Math.ceil(textMsgs.length / 10));
  for (let i = 0; i < textMsgs.length; i += bucketSize) {
    const slice = textMsgs.slice(i, i + bucketSize);
    const bySpeaker = {};
    for (const m of slice) bySpeaker[m.speaker] = (bySpeaker[m.speaker] || 0) + 1;
    timeline.push({
      from: slice[0].ts ? slice[0].ts.label : '',
      to: slice[slice.length - 1].ts ? slice[slice.length - 1].ts.label : '',
      bySpeaker,
      avgLen: mean(slice.map((m) => (m.text || '').length)),
      laugh: slice.reduce((a, m) => a + countMatches(m.text, LAUGH_RE), 0),
      questions: slice.reduce((a, m) => a + countMatches(m.text, QUESTION_RE), 0),
    });
  }

  let selfStats = null;
  let otherStats = null;
  if (self) selfStats = people.find((p) => p.name === self) || null;
  if (other) otherStats = people.find((p) => p.name === other) || null;
  if (!selfStats && otherStats) selfStats = people.find((p) => p.name !== other) || null;
  if (!otherStats && selfStats) otherStats = people.find((p) => p.name !== self) || null;

  const ratio = selfStats && otherStats && otherStats.count ? selfStats.count / otherStats.count : null;

  return {
    generatedAt: new Date().toISOString(),
    range: {
      first: list.length ? list[0].ts.label : null,
      last: list.length ? list[list.length - 1].ts.label : null,
      days: spanDays(list),
    },
    total: list.length,
    textTotal: textMsgs.length,
    mediaTotal: list.length - textMsgs.length,
    people,
    self: selfStats,
    other: otherStats,
    talkRatio: ratio,
    sessionCount: sessionList.length,
    sessionGapMinutes: options.sessionGapMinutes || 240,
    sessions: sessionList.slice(0, 200).map((s) => ({
      from: s.startTs ? s.startTs.label : '',
      to: s.messages[s.messages.length - 1].ts ? s.messages[s.messages.length - 1].ts.label : '',
      count: s.messages.length,
      initiator: s.messages[0].speaker,
      ender: s.messages[s.messages.length - 1].speaker,
    })),
    longestSilence,
    peakHours,
    sharedHours,
    overnights: overnights.slice(-12),
    timeline,
  };
}

function spanDays(list) {
  if (!list.length) return 0;
  const a = list[0].ts && list[0].ts.ms;
  const b = list[list.length - 1].ts && list[list.length - 1].ts.ms;
  if (a == null || b == null) return 0;
  return Number(((b - a) / 86400000).toFixed(1));
}

/**
 * 把硬统计压缩成给模型看的短文本（控制在 ~1500 字内）。
 */
function formatStatsForPrompt(stats) {
  if (!stats) return '（无统计）';
  const L = [];
  const self = stats.self;
  const other = stats.other;
  L.push(`区间：${stats.range.first} → ${stats.range.last}（约 ${stats.range.days} 天），共 ${stats.total} 条，其中文本 ${stats.textTotal} 条、图片/语音/表情等 ${stats.mediaTotal} 条。`);
  L.push(`会话段数（间隔>${stats.sessionGapMinutes} 分钟算新一段）：${stats.sessionCount} 段。`);
  const line = (p) => {
    if (!p) return '—';
    return `${p.name}：${p.count} 条(${(p.share * 100).toFixed(0)}% 占比)，平均 ${p.avgLen} 字/条，中位回复间隔 ${fmtMin(p.replyMedianMs)}，主动开启 ${p.initiations} 次(${(p.initiationShare * 100).toFixed(0)}%)，收尾 ${p.sessionEnds} 次，连发中位 ${p.medianRun ?? '—'} 条/最长 ${p.maxRun} 条，问号 ${p.questions} 次，笑 ${p.laugh} 次，Emoji ${p.emoji} 个，表情包 ${p.sticker} 个，图片 ${p.image}，语音 ${p.voice}，深夜(0-6点) ${p.lateNight} 条`;
  };
  L.push(`我（${self ? self.name : '未知'}）：${line(self).replace(/^[^：]*：/, '')}`);
  L.push(`对方（${other ? other.name : '未知'}）：${line(other).replace(/^[^：]*：/, '')}`);
  const others = stats.people.filter((p) => p !== self && p !== other);
  for (const p of others) L.push(`其他人：${line(p)}`);
  if (stats.talkRatio) L.push(`我方条数 / 对方条数 = ${stats.talkRatio.toFixed(2)}（>1.6 说明我方明显更主动，<0.7 说明对方更主动）。`);
  if (stats.longestSilence) {
    L.push(`最长沉默：${fmtMin(stats.longestSilence.gap)}（${stats.longestSilence.from} → ${stats.longestSilence.to}，最后一句是 ${stats.longestSilence.by} 发的）。`);
  }
  if (stats.peakHours.length) {
    L.push(`聊天高峰时段：${stats.peakHours.map((h) => `${h.hour}点(${h.total}条)`).join('、')}；双方都在线的小时：${stats.sharedHours.length ? stats.sharedHours.map((h) => `${h}点`).join('、') : '很少'}。`);
  }
  if (stats.overnights.length) {
    L.push('深夜消息样本：' + stats.overnights.slice(-5).map((o) => `${o.speaker}「${o.text}」`).join(' | '));
  }
  L.push('分段时间线（看趋势变化）：');
  for (const b of stats.timeline) {
    const parts = Object.entries(b.bySpeaker).map(([k, v]) => `${k}${v}`).join('/');
    L.push(`  ${b.from.slice(5, 16)}~${b.to.slice(5, 16)} 条数 ${parts}，均长 ${b.avgLen.toFixed(1)}，笑 ${b.laugh}，问号 ${b.questions}`);
  }
  return L.join('\n');
}

/**
 * 本地零成本洞察：不依赖模型也能给一部分结论（"只看本地"模式用）。
 */
function localInsights(stats) {
  const out = [];
  if (!stats) return out;
  const self = stats.self;
  const other = stats.other;
  if (!self || !other) {
    out.push({ level: 'info', title: '说话人识别不完整', detail: '请在昵称栏指定「我是谁」和「对方是谁」，才能对比双方节奏。' });
    return out;
  }
  if (stats.talkRatio != null) {
    if (stats.talkRatio > 1.6) {
      out.push({ level: 'warn', title: '你发得明显更多', detail: `你 ${self.count} 条 vs 对方 ${other.count} 条（${stats.talkRatio.toFixed(2)}:1）。通常意味着你在追着推话题，可以试着留白，让对方来找你。` });
    } else if (stats.talkRatio < 0.7) {
      out.push({ level: 'info', title: '对方发得更多', detail: `对方 ${other.count} 条 vs 你 ${self.count} 条。对方输出更多，通常是在意的一种表现，但也要注意你是不是回得太短、太"冷"。` });
    } else {
      out.push({ level: 'good', title: '发言量比较对等', detail: `你 ${self.count} 条、对方 ${other.count} 条，节奏均衡。` });
    }
  }
  if (self.replyMedianMs != null && other.replyMedianMs != null) {
    const a = self.replyMedianMs;
    const b = other.replyMedianMs;
    const who = a < b ? '你' : '对方';
    const ratio = (Math.max(a, b) / Math.max(1, Math.min(a, b))).toFixed(1);
    out.push({
      level: ratio > 2.5 ? 'warn' : 'info',
      title: '回复速度对比',
      detail: `你中位 ${fmtMin(a)}，对方中位 ${fmtMin(b)}，${who}快约 ${ratio} 倍。${who === '你' && ratio > 2.5 ? '你几乎是随叫随到，对方偏慢——这是"投入不对等"的典型信号。' : ''}`,
    });
  }
  if (self.initiations != null && other.initiations != null) {
    const total = self.initiations + other.initiations;
    if (total >= 4) {
      const myShare = self.initiations / total;
      if (myShare > 0.75) {
        out.push({ level: 'warn', title: '几乎都是你先开口', detail: `共 ${total} 次对话由你开启 ${self.initiations} 次。可以刻意等一两天不主动，看对方会不会来。` });
      } else if (myShare < 0.25) {
        out.push({ level: 'info', title: '多为对方主动', detail: `对方主动开启 ${other.initiations}/${total} 次，说明对方愿意维系联系。` });
      } else {
        out.push({ level: 'good', title: '主动性是双向的', detail: `你开启 ${self.initiations} 次、对方 ${other.initiations} 次。` });
      }
    }
  }
  if (self.maxRun >= 4 && self.maxRun > other.maxRun + 2) {
    out.push({ level: 'warn', title: '你存在连发轰炸', detail: `你最多一次性连发 ${self.maxRun} 条（对方 ${other.maxRun} 条）。连发容易造成压迫感，把三条合成一条更稳。` });
  }
  if (other.lateNight > 0 && (self.lateNight === 0 || other.lateNight >= self.lateNight)) {
    out.push({ level: 'info', title: '对方有深夜找你聊天', detail: `对方 0-6 点发了 ${other.lateNight} 条。深夜聊天通常代表放松和信任，这个时段的对话质量往往最高。` });
  }
  if (stats.longestSilence && stats.longestSilence.gap > 3 * 86400000) {
    out.push({ level: 'info', title: '出现过较长冷淡期', detail: `最长 ${fmtMin(stats.longestSilence.gap)} 没有对话（${stats.longestSilence.from} 之后）。可留意那段时间前后话题是否变敏感。` });
  }
  const lens = [self, other].map((p) => ({ name: p.name, len: p.avgLen }));
  const diff = Math.abs(lens[0].len - lens[1].len);
  if (diff >= 8) {
    const shortSide = lens[0].len < lens[1].len ? lens[0] : lens[1];
    out.push({ level: 'info', title: '双方表达密度差异大', detail: `${lens.map((x) => `${x.name} ${x.len} 字/条`).join('，')}。${shortSide.name} 明显更短，可能偏被动或没找到话题。` });
  }
  if (stats.mediaTotal && stats.total && stats.mediaTotal / stats.total > 0.35) {
    out.push({ level: 'info', title: '表情包/图片占比高', detail: `非文本消息占 ${((stats.mediaTotal / stats.total) * 100).toFixed(0)}%。这类聊天轻松但信息量低，模型对情绪的判断会保守一些。` });
  }
  return out;
}

module.exports = { computeStats, formatStatsForPrompt, localInsights, fmtMin, median };
