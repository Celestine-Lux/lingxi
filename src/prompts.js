'use strict';
/**
 * 提示词构造：所有模型共用的分析协议。
 * 输出被约束为一个固定 JSON 结构，便于前端渲染与分段汇总。
 */

const SCHEMA_HINT = `请只输出一个 JSON 对象，不要输出解释、客套话或 Markdown 代码块。结构必须如下（字段名不要改）：
{
  "overview": {
    "temperature": 0-100 的整数，代表这段关系的"温度",
    "trend": "升温中 | 稳定 | 微妙降温 | 忽冷忽热 | 数据不足",
    "otherAttitude": "一段话，对方目前对你的真实态度与情绪基调",
    "signals": ["关键信号，4-8 条，每条一句话并点明依据"]
  },
  "insights": [
    {
      "ref": 12,
      "speaker": "对方的昵称（原样抄）",
      "text": "原文，不超过 60 字",
      "emotion": "情绪，2-6 字",
      "surface": "字面意思，一句话",
      "subtext": "潜台词/真实想法，一句话",
      "confidence": 0-100 的整数,
      "suggestion": "针对这一条，我该怎么接，一句话，要具体到能直接发出去"
    }
  ],
  "review": [
    {
      "ref": 15,
      "myText": "我发的原文，不超过 60 字",
      "otherBefore": "我这句话之前对方说的关键一句，没有就留空",
      "issue": "问题类型，4-10 字，例如：情绪没接住 / 太急着解释 / 反问施压 / 敷衍",
      "why": "为什么这样不好，一到两句",
      "severity": "高 | 中 | 低",
      "rewrite": "改写后的回复，要像我平时的语气，能直接发",
      "whyBetter": "改写好在哪，一句话"
    }
  ],
  "advice": {
    "do": ["现在该做的事，3-6 条，每条要能落地"],
    "dont": ["雷区/不要做的事，3-6 条"],
    "topicIdeas": ["可以自然开启的新话题，3-6 条，要结合聊天里的具体细节，别写通用话题"],
    "nextMove": {
      "shouldReach": "该不该主动，以及什么时机",
      "message": "如果要发，直接给一条可以复制发送的开场消息",
      "fallback": "如果对方冷淡，第二套应对方案"
    },
    "watchList": ["后续要留意的观察点，2-5 条"]
  }
}`;

function systemPrompt() {
  return [
    '你是一位关系心理学与沟通分析专家，同时也是一位很懂中文互联网语感的聊天教练。',
    '你的任务：读懂一段聊天记录里对方的情绪与潜台词，并诊断"我"的回复哪里没表达好、该怎么调整。',
    '',
    '工作原则：',
    '1. 以证据说话。任何结论都要指向记录里的具体句子，不要凭空猜测；证据不足就直说"不确定"。',
    '2. 不要讨好。既不夸大"对方一定喜欢你"，也不渲染"对方要跑了"。要给出诚实的、包含反例可能性的判断。',
    '3. 注意中文网感的细节：短句、口语、语气词（啊/吧/啦/嘛/哦/嗯）、"。"结尾 vs 无标点、"哈哈"与"哈哈哈哈哈"的区别、'
      + '发错又撤回、突然用敬语、回复间隔变化、话题是否被接住或被打断、谁在收尾。这些比字面内容更能说明态度。',
    '4. 短消息不等于冷淡（有人就是打字少）；热情的长消息也可能只是客套。要结合节奏数据（回复速度、谁先开口、谁收尾）一起判断。',
    '5. 改写我的回复时：必须保持我原本的语气和打字习惯（别改成播音腔或恋爱话术模板），长度接近我平时的水平，'
      + '要具体、能直接复制发出去，不要写"你可以表达关心"这种空话。',
    '6. 站在我的立场给建议，但不要教我去操控、试探、冷暴力或 PUA 对方。真诚和清晰永远优先。',
    '7. 输出必须是一个合法 JSON 对象，不要有 JSON 之外的任何字符。字符串里不要出现未转义的换行。',
    '',
    SCHEMA_HINT,
    '',
    'insights 按重要性（对关系影响大小）排序，最多 12 条；review 挑最值得改的最多 10 条，按危害从高到低排序。',
    '所有输出用中文。',
  ].join('\n');
}

function formatMessageLine(m, index) {
  const speaker = m.speaker;
  const time = m.ts && m.ts.short ? m.ts.short : '';
  let body = (m.text || '').replace(/\n+/g, ' ⏎ ');
  if (body.length > 220) body = body.slice(0, 220) + '…';
  if (m.kind !== 'text') body = `${body}（非文本：${m.kind}）`;
  return `#${index} [${time}] ${speaker}: ${body}`;
}

function formatSlice(messages, start, end, opts = {}) {
  const idx = opts.indexOffset || 0;
  void idx;
  const lines = [];
  for (let i = Math.max(0, start); i < Math.min(messages.length, end); i += 1) {
    lines.push(formatMessageLine(messages[i], i));
  }
  return lines.join('\n');
}

function contextBlock(ctx = {}) {
  const L = [];
  L.push(`我（说话人 A）= ${ctx.selfName || '未知'}${ctx.selfGender ? `，${ctx.selfGender}` : ''}；对方（说话人 B）= ${ctx.otherName || '未知'}${ctx.otherGender ? `，${ctx.otherGender}` : ''}。`);
  if (ctx.relationship) L.push(`关系阶段：${ctx.relationship}。`);
  if (ctx.knownFacts) L.push(`补充背景（我提供的，可信）：${ctx.knownFacts}`);
  if (ctx.goal) L.push(`我这次的目标：${ctx.goal}`);
  if (ctx.notes) L.push(`其他说明：${ctx.notes}`);
  return L.join('\n');
}

/**
 * 单个分段的逐条分析提示词。
 */
function buildChunkPrompt({ messages, start, end, statsText, localFindings, ctx, totalCount, partIndex, partTotal }) {
  const L = [];
  L.push(`【任务】分析一段聊天记录，输出规定的 JSON。`);
  L.push('');
  L.push('【人物与背景】');
  L.push(contextBlock(ctx));
  L.push('');
  L.push('【客观互动数据（由程序计算，可信，请充分利用）】');
  L.push(statsText);
  L.push('');
  if (localFindings && localFindings.length) {
    L.push('【程序检测到的疑似问题（仅供参考，需你自己判断是否成立）】');
    for (const f of localFindings) L.push(`- [${f.level}] ${f.title}：${f.detail}`);
    L.push('');
  }
  L.push(`【聊天记录片段 ${partIndex}/${partTotal}（整个记录共 ${totalCount} 条，编号 #N 是全局编号，请原样引用编号）】`);
  L.push(formatSlice(messages, start, end));
  L.push('');
  L.push('【要求】');
  L.push('1. insights 只挑真正有信息量的消息（尤其对方的话），不要把"嗯""哦""哈哈"这类没信息量的都列出来。');
  L.push('2. 每条的 ref 必须是上面出现过的 #编号；speaker 和 text 要跟记录一致。');
  L.push('3. review 只评我（说话人 A）说过的话，重点找：没接住对方情绪、答非所问、太急着解释或反驳、'
    + '连续反问、敷衍（嗯/哦/行）、自说自话、把天聊死的收尾、过度索取关注、开不合时宜的玩笑。');
  L.push('4. rewrite 要像我会发的话，不要客套模板。');
  L.push('5. 如果这一段信息量太低，insights 和 review 可以为空数组，但 overview 和 advice 仍要填。');
  return L.join('\n');
}

/**
 * 多段汇总提示词。
 */
function buildSynthesizePrompt({ partials, statsText, ctx, totalCount }) {
  const L = [];
  L.push('【任务】下面是对同一段聊天记录分段分析得到的多份 JSON 结果。请把它们合并、去重、并给出整体判断，输出同样结构的 JSON。');
  L.push('');
  L.push('【人物与背景】');
  L.push(contextBlock(ctx));
  L.push('');
  L.push('【客观互动数据】');
  L.push(statsText);
  L.push('');
  L.push(`【记录总条数】${totalCount}`);
  L.push('');
  L.push('【各分段分析结果（JSON 数组）】');
  L.push(JSON.stringify(partials, null, 1));
  L.push('');
  L.push('【合并要求】');
  L.push('1. 去掉重复或互相矛盾的条目，保留证据更硬、更重要、且能体现"变化趋势"的。');
  L.push('2. overview 要给出整段关系的整体判断，signals 要综合各段（比如前期热络后期变冷）。');
  L.push('3. insights 最多 12 条、review 最多 10 条，跨分段统一排序。');
  L.push('4. advice 要整合成一套不重复的行动方案，结合聊天里的真实细节。');
  L.push('5. ref / speaker / text / myText 必须来自上面的原始条目，不要自己编编号。');
  return L.join('\n');
}

/**
 * 试聊模拟：预测对方的回复方式。
 */
function buildSimulatePrompt({ draft, ctx, recentText, statsText }) {
  return [
    '【任务】我打算给下面这个人发一条消息。请你先扮演"对方"给出最可能的 3 种真实回复，再评估我这条消息的风险，输出 JSON。',
    '',
    '【人物与背景】',
    contextBlock(ctx),
    '',
    '【客观互动数据】',
    statsText,
    '',
    '【最近的聊天上下文（最后几条）】',
    recentText,
    '',
    '【我打算发的消息】',
    draft,
    '',
    '请只输出如下 JSON（不要有多余字符）：',
    '{',
    '  "replies": [',
    '    { "style": "可能的反应类型，4-8 字", "likelihood": 0-100 整数, "reply": "对方最可能回的原话，口语化，别太长" }',
    '  ],',
    '  "risks": ["这条消息可能踩的雷，2-4 条"],',
    '  "readiness": 0-100 的整数，现在发这条消息的合适程度,',
    '  "verdict": "一句话结论：发 / 改 / 再等",',
    '  "improved": "如果你想更稳，改成这样说，直接给一条可发送的文本"',
    '}',
    '',
    'replies 给 3 条，按 likelihood 从高到低。回复要符合对方在聊天里的说话风格（用词、长度、标点习惯）。',
  ].join('\n');
}

module.exports = {
  SCHEMA_HINT,
  systemPrompt,
  buildChunkPrompt,
  buildSynthesizePrompt,
  buildSimulatePrompt,
  formatSlice,
  formatMessageLine,
  contextBlock,
};
