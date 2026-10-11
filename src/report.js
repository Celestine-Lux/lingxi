'use strict';
/**
 * 把分析结果导出为 Markdown（方便复制到备忘录、Notion 或发给朋友）。
 */

const { fmtMin } = require('./stats');

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

function buildMarkdownReport({ report, stats, findings, parsed, ctx }) {
  const L = [];
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  L.push('# 聊天解读报告');
  L.push('');
  L.push(`生成时间：${stamp}`);
  if (stats) L.push(`聊天区间：${stats.range.first} → ${stats.range.last}（约 ${stats.range.days} 天）`);
  if (ctx && ctx.selfName) L.push(`我：${ctx.selfName} ／ 对方：${ctx.otherName || '未指定'}`);
  if (report && report.meta && report.meta.model) L.push(`分析模型：${report.meta.model}${report.meta.chunks ? `（${report.meta.chunks} 个分段）` : ''}`);
  L.push('');

  if (stats) {
    L.push('## 一、客观互动数据（程序计算，不经过模型）');
    L.push('');
    L.push('| 指标 | 我 | 对方 |');
    L.push('| --- | --- | --- |');
    const s = stats.self;
    const o = stats.other;
    const row = (label, fn) => L.push(`| ${label} | ${s ? esc(fn(s)) : '—'} | ${o ? esc(fn(o)) : '—'} |`);
    row('消息条数', (p) => `${p.count}（${(p.share * 100).toFixed(0)}%）`);
    row('平均字数/条', (p) => `${p.avgLen}`);
    row('中位回复间隔', (p) => fmtMin(p.replyMedianMs));
    row('主动开启对话', (p) => `${p.initiations} 次（${(p.initiationShare * 100).toFixed(0)}%）`);
    row('最后由谁收尾', (p) => `${p.sessionEnds} 次`);
    row('连续发消息（中位/最长）', (p) => `${p.medianRun == null ? '—' : p.medianRun} / ${p.maxRun}`);
    row('疑问句', (p) => `${p.questions} 次`);
    row('笑（哈哈/笑死等）', (p) => `${p.laugh} 次`);
    row('表情包 / 图片 / 语音', (p) => `${p.sticker} / ${p.image} / ${p.voice}`);
    row('0-6 点消息', (p) => `${p.lateNight} 条`);
    L.push('');
    if (stats.talkRatio) L.push(`- 发言量比：我 / 对方 = **${stats.talkRatio.toFixed(2)}**`);
    L.push(`- 会话段数：${stats.sessionCount} 段（间隔超过 ${stats.sessionGapMinutes} 分钟算新一段）`);
    if (stats.longestSilence) L.push(`- 最长沉默：${fmtMin(stats.longestSilence.gap)}（${stats.longestSilence.from} 之后）`);
    if (stats.peakHours && stats.peakHours.length) {
      L.push(`- 聊天高峰：${stats.peakHours.map((h) => `${h.hour} 点`).join('、')}`);
    }
    L.push('');
  }

  if (findings && findings.length) {
    L.push('## 二、程序检测到的信号');
    L.push('');
    for (const f of findings) {
      const icon = f.level === 'warn' ? '⚠️' : f.level === 'good' ? '✅' : 'ℹ️';
      L.push(`- ${icon} **${f.title}**：${f.detail}`);
    }
    L.push('');
  }

  if (report) {
    const ov = report.overview || {};
    L.push('## 三、关系温度与整体判断');
    L.push('');
    if (ov.temperature != null) L.push(`**温度：${ov.temperature} / 100**${ov.trend ? `　趋势：${ov.trend}` : ''}`);
    L.push('');
    if (ov.otherAttitude) {
      L.push('### 对方目前的态度');
      L.push('');
      L.push(ov.otherAttitude);
      L.push('');
    }
    if (ov.signals && ov.signals.length) {
      L.push('### 关键信号');
      L.push('');
      for (const s of ov.signals) L.push(`- ${s}`);
      L.push('');
    }

    if (report.insights && report.insights.length) {
      L.push('## 四、逐条解读：对方在说什么、想什么');
      L.push('');
      for (const it of report.insights) {
        L.push(`### ${it.speaker || '对方'}${it.ref != null ? `（第 ${it.ref} 条）` : ''}：${it.emotion || '—'}`);
        L.push('');
        L.push(`> ${it.text || ''}`);
        L.push('');
        if (it.surface) L.push(`- **字面**：${it.surface}`);
        if (it.subtext) L.push(`- **潜台词**：${it.subtext}`);
        if (it.confidence != null) L.push(`- **把握度**：${it.confidence}%`);
        if (it.suggestion) L.push(`- **你可以这样接**：${it.suggestion}`);
        L.push('');
      }
    }

    if (report.review && report.review.length) {
      L.push('## 五、复盘：我的回复哪里没说好');
      L.push('');
      report.review.forEach((r, i) => {
        L.push(`### ${i + 1}. ${r.issue || '待改进'}${r.severity ? `（危害：${r.severity}）` : ''}${r.ref != null ? `　第 ${r.ref} 条` : ''}`);
        L.push('');
        if (r.otherBefore) L.push(`- 对方上一句：${r.otherBefore}`);
        L.push(`- 我原话：${r.myText || ''}`);
        if (r.why) L.push(`- 问题在哪：${r.why}`);
        if (r.rewrite) L.push(`- **可以改成**：${r.rewrite}`);
        if (r.whyBetter) L.push(`- 好在哪：${r.whyBetter}`);
        L.push('');
      });
    }

    const ad = report.advice || {};
    L.push('## 六、接下来怎么做');
    L.push('');
    if (ad.do && ad.do.length) {
      L.push('### 现在该做');
      L.push('');
      for (const x of ad.do) L.push(`- [ ] ${x}`);
      L.push('');
    }
    if (ad.dont && ad.dont.length) {
      L.push('### 千万别做');
      L.push('');
      for (const x of ad.dont) L.push(`- [ ] ${x}`);
      L.push('');
    }
    if (ad.topicIdeas && ad.topicIdeas.length) {
      L.push('### 可以聊的新话题');
      L.push('');
      for (const x of ad.topicIdeas) L.push(`- ${x}`);
      L.push('');
    }
    if (ad.nextMove && (ad.nextMove.shouldReach || ad.nextMove.message)) {
      L.push('### 下一步动作');
      L.push('');
      if (ad.nextMove.shouldReach) L.push(`- **该不该主动**：${ad.nextMove.shouldReach}`);
      if (ad.nextMove.message) L.push(`- **直接发这条**：\`${ad.nextMove.message}\``);
      if (ad.nextMove.fallback) L.push(`- **如果对方冷淡**：${ad.nextMove.fallback}`);
      L.push('');
    }
    if (ad.watchList && ad.watchList.length) {
      L.push('### 继续观察');
      L.push('');
      for (const x of ad.watchList) L.push(`- ${x}`);
      L.push('');
    }
    if (report.warnings && report.warnings.length) {
      L.push('## 备注');
      L.push('');
      for (const w of report.warnings) L.push(`- ${w}`);
      L.push('');
    }
  }

  if (parsed && parsed.warnings && parsed.warnings.length) {
    L.push('## 解析提示');
    L.push('');
    for (const w of parsed.warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('本报告由「灵犀 · 聊天解读小工具」生成。模型的判断是概率性的推测，请当作参考视角，而不是定论。');
  return L.join('\n');
}

module.exports = { buildMarkdownReport };
