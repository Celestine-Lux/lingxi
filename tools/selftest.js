'use strict';
/**
 * 离线自检：不需要联网、不需要 API Key，验证解析、统计、JSON 修复、报告导出是否正常。
 * 用法： node tools/selftest.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { parseChatLog, detectFormat } = require(path.join(ROOT, 'src/parser'));
const { computeStats, formatStatsForPrompt, localInsights } = require(path.join(ROOT, 'src/stats'));
const analyzer = require(path.join(ROOT, 'src/analyzer'));
const prompts = require(path.join(ROOT, 'src/prompts'));
const { buildMarkdownReport } = require(path.join(ROOT, 'src/report'));
const llm = require(path.join(ROOT, 'src/llm'));
const configStore = require(path.join(ROOT, 'src/config-store'));
const fixtures = require('./fixtures');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

section('模块加载');
check('parser / stats / analyzer / prompts / report / llm / config-store 均可 require', () => {
  assert.ok(parseChatLog && computeStats && analyzer.analyze && prompts.systemPrompt && buildMarkdownReport && llm.chat && configStore.loadConfigState);
});
check('连接测试函数存在', () => {
  assert.strictEqual(typeof llm.testConnection, 'function');
});
check('服务商列表包含 DeepSeek / OpenAI / Claude / 本地模型', () => {
  const ids = llm.listProviders().map((p) => p.id);
  for (const id of ['deepseek', 'openai', 'openai_compatible', 'anthropic', 'ollama']) {
    assert.ok(ids.includes(id), `缺少 ${id}`);
  }
});
check('Base URL 归一化正确', () => {
  assert.strictEqual(llm.normalizeBase('https://api.deepseek.com/v1', 'openai'), 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(llm.normalizeBase('https://api.deepseek.com', 'openai'), 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(llm.normalizeBase('https://api.anthropic.com', 'anthropic'), 'https://api.anthropic.com');
});

section('格式识别');
const sampleText = fixtures.HEADER_STYLE;
check('识别出昵称前置格式', () => {
  const f = detectFormat(sampleText);
  assert.ok(f.ok, '未能识别');
});
check('兼容「2024-10-08 19:01:50 昵称」格式', () => {
  const r = parseChatLog(fixtures.FULL_TS_STYLE);
  assert.strictEqual(r.messages.length, 2);
  assert.strictEqual(r.messages[0].speaker, 'aurora');
  assert.strictEqual(r.messages[1].speaker, '我');
});
check('兼容「[2024-10-08 19:01:50] 昵称」格式', () => {
  const r = parseChatLog(fixtures.BRACKET_STYLE);
  assert.strictEqual(r.messages.length, 2);
  assert.strictEqual(r.messages[0].ts.label, '2024-10-08 19:01:50');
});
check('兼容「昵称 2024/10/8 19:01」时间在后格式', () => {
  const r = parseChatLog(fixtures.INLINE_TS_STYLE);
  assert.strictEqual(r.messages.length, 2);
  assert.strictEqual(r.messages[0].speaker, 'aurora');
  assert.ok(r.messages[0].ts.label.startsWith('2024-10-08 19:01'));
});
check('自动补年份并处理跨年', () => {
  const t = 'aurora: 12-30 23:50\n年底了\n我: 01-02 09:10\n新年好\n';
  const r = parseChatLog(t, { defaultYear: 2024 });
  assert.strictEqual(r.messages[0].ts.label.slice(0, 4), '2024');
  assert.strictEqual(r.messages[1].ts.label.slice(0, 4), '2025');
});
check('识别 [表情]/[图片] 等非文本消息', () => {
  const t = 'a: 10-08 19:01:50\n[动画表情]\na: 10-08 19:02:00\n[图片]\na: 10-08 19:03:00\n在的\n';
  const r = parseChatLog(t);
  assert.strictEqual(r.messages[0].kind, 'sticker');
  assert.strictEqual(r.messages[1].kind, 'image');
  assert.strictEqual(r.messages[2].kind, 'text');
});
check('过滤系统提示（撤回/拍了拍）', () => {
  const t = 'a: 10-08 19:01:50\n你好\na: 10-08 19:02:00\n"a" 撤回了一条消息\nb: 10-08 19:03:00\nb 拍了拍 a\nb: 10-08 19:04:00\n在\n';
  const r = parseChatLog(t);
  const sys = r.messages.filter((m) => m.kind === 'system');
  assert.strictEqual(sys.length, 2, `系统消息数 ${sys.length}`);
});
check('清洗 HTML 导出内容', () => {
  const t = '<div>a: 10-08 19:01:50</div><div>你好</div>';
  const r = parseChatLog(t);
  assert.strictEqual(r.messages.length, 1);
  assert.strictEqual(r.messages[0].text, '你好');
});

section('解析真实样本');
const parsed = parseChatLog(sampleText);
check('解析出 33 条以上消息与两个说话人', () => {
  assert.ok(parsed.messages.length >= 33, `只有 ${parsed.messages.length} 条`);
  assert.deepStrictEqual(parsed.speakers.sort(), ['Celestine-Lux', 'aurora'].sort());
});
check('带文件头/图片/撤回的导出文件也能解析', () => {
  const r = parseChatLog(fixtures.FILE_STYLE);
  assert.ok(r.messages.length >= 3, `只有 ${r.messages.length} 条`);
  const kinds = r.messages.map((m) => m.kind);
  assert.ok(kinds.includes('image') || kinds.includes('voice'), `没识别出非文本消息：${kinds.join(',')}`);
});

const stats = computeStats(parsed.messages, { selfName: 'Celestine-Lux', otherName: 'aurora' });
check('统计出双方条数与主动性', () => {
  assert.ok(stats.total >= 33);
  assert.ok(stats.self && stats.other);
  assert.ok(stats.self.count > 0 && stats.other.count > 0);
  assert.ok(stats.sessionCount >= 1);
});
check('统计文本能生成给模型的摘要', () => {
  const t = formatStatsForPrompt(stats);
  assert.ok(t.includes('会话段数'));
  assert.ok(t.length > 200);
});
check('本地洞察能给出结论', () => {
  const f = localInsights(stats);
  assert.ok(Array.isArray(f) && f.length > 0);
});

section('模型输出容错');
check('直接解析标准 JSON', () => {
  const obj = analyzer.extractJson('{"overview":{"temperature":70},"insights":[],"review":[],"advice":{}}');
  assert.strictEqual(obj.overview.temperature, 70);
});
check('剥离 ```json 代码块', () => {
  const obj = analyzer.extractJson('这是结果：\n```json\n{"overview":{"trend":"升温中"},"advice":{}}\n```\n希望有帮助！');
  assert.strictEqual(obj.overview.trend, '升温中');
});
check('修复被截断的 JSON', () => {
  const obj = analyzer.extractJson('{"overview":{"temperature":55,"trend":"稳定"},"insights":[{"ref":3,"text":"你好');
  assert.strictEqual(obj.overview.temperature, 55);
  assert.ok(Array.isArray(obj.insights));
});
check('修复中文引号与尾逗号', () => {
  const obj = analyzer.extractJson('{"overview":{"trend":"稳定",},"insights":[{"text":"“在的”"}]}');
  assert.strictEqual(obj.overview.trend, '稳定');
  assert.ok(obj.insights[0].text.includes('在的'));
});
check('字符串里出现真实换行也能救回来', () => {
  const obj = analyzer.extractJson('{"overview":{"otherAttitude":"第一行\n第二行"},"insights":[]}');
  assert.ok(obj.overview.otherAttitude.includes('第一行'));
});
check('完全不是 JSON 时返回 null', () => {
  assert.strictEqual(analyzer.extractJson('我觉得对方其实挺喜欢你的。'), null);
});
check('normalizeReport 能把字符串数组/缺字段补齐', () => {
  const r = analyzer.normalizeReport({ overview: { signals: '第一条\n第二条' }, insights: [{ ref: '2', text: '在吗', confidence: '150' }], advice: { do: '做A；做B' } });
  assert.deepStrictEqual(r.overview.signals, ['第一条', '第二条']);
  assert.strictEqual(r.insights[0].confidence, 100);
  assert.deepStrictEqual(r.advice.do, ['做A', '做B']);
});
check('分段规划不会漏掉最后一条消息', () => {
  const chunks = analyzer.planChunks(1000, { chunkSize: 400, overlap: 6, maxChunks: 3 });
  assert.strictEqual(chunks[chunks.length - 1].end, 1000);
  assert.ok(chunks.length <= 3);
});

section('提示词与报告');
check('分块提示词包含消息编号和输出协议', () => {
  const p = prompts.buildChunkPrompt({
    messages: parsed.messages,
    start: 0,
    end: 5,
    statsText: formatStatsForPrompt(stats),
    localFindings: localInsights(stats),
    ctx: { selfName: 'Celestine-Lux', otherName: 'aurora', relationship: '已经在一起', goal: '让对话更热络' },
    totalCount: parsed.messages.length,
    partIndex: 1,
    partTotal: 1,
  });
  assert.ok(p.includes('#0'));
  assert.ok(p.includes('"overview"'));
});
check('Markdown 报告包含所有章节', () => {
  const report = analyzer.normalizeReport({
    overview: { temperature: 72, trend: '升温中', otherAttitude: '对方比较主动', signals: ['她会主动找你'] },
    insights: [{ ref: 1, speaker: 'aurora', text: '想你了', emotion: '依恋', surface: '表达想念', subtext: '想被回应', confidence: 80, suggestion: '回一句具体的想念' }],
    review: [{ ref: 2, myText: '哦', issue: '敷衍', why: '一个字接不住情绪', severity: '高', rewrite: '我也想你，刚在打游戏，现在有空了' }],
    advice: { do: ['主动一点'], dont: ['别只回一个字'], topicIdeas: ['聊聊那部电影'], nextMove: { shouldReach: '今晚可以主动', message: '电影我看完了，结局确实有点戳' }, watchList: ['她回复速度'] },
  });
  const md = buildMarkdownReport({ report, stats, findings: localInsights(stats), parsed, ctx: { selfName: 'Celestine-Lux', otherName: 'aurora' } });
  for (const kw of ['# 聊天解读报告', '客观互动数据', '关系温度', '逐条解读', '复盘', '接下来怎么做']) {
    assert.ok(md.includes(kw), `缺少章节 ${kw}`);
  }
  assert.ok(md.length > 1500);
});
check('模拟接口提示词要求三种反应', () => {
  const p = prompts.buildSimulatePrompt({ draft: '在吗', ctx: {}, recentText: '#0 hi', statsText: 'stats' });
  assert.ok(p.includes('"replies"'));
  assert.ok(p.includes('likelihood'));
});

section('渲染前端文件存在');
check('public/index.html、style.css、app.js 均在', () => {
  for (const f of ['public/index.html', 'public/style.css', 'public/app.js', 'start.bat']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少 ${f}`);
  }
});
check('app.js 里用到的元素 id 在 index.html 中都存在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepStrictEqual(missing, [], `index.html 缺少这些 id：${missing.join(', ')}`);
});
check('index.html 里引用的本地脚本和样式存在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', m[1])), `缺少 public/${m[1]}`);
  }
});
check('界面里已经没有「示例」入口', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.ok(!/btnSample|loadSample|载入示例/.test(html), 'index.html 里还有示例入口');
  assert.ok(!/btnSample|loadSample|api\/sample/.test(js), 'app.js 里还有示例逻辑');
  assert.ok(!fs.existsSync(path.join(ROOT, 'samples')), 'samples 目录应该已经删掉');
});

section('模型接口配置（config-store）');
const sampleState = {
  activeId: 'p1',
  profiles: [
    {
      id: 'p1', name: 'DeepSeek 官方', provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-abcdefgh1234', model: 'deepseek-chat',
    },
    {
      id: 'p2', name: '公司中转', provider: 'openai_compatible',
      baseUrl: 'https://gw.example.com/v1', apiKey: 'gw-9999', model: 'gpt-4o-mini',
    },
  ],
};
check('读取配置并补全默认字段', () => {
  const s = configStore.loadConfigState(sampleState);
  assert.strictEqual(s.activeId, 'p1');
  assert.strictEqual(s.profiles.length, 2);
  assert.strictEqual(s.profiles[0].model, 'deepseek-chat');
  assert.strictEqual(s.profiles[0].temperature, 0.4);
  assert.strictEqual(s.profiles[1].maxTokens, 8000);
});
check('打码视图不泄露完整 Key', () => {
  const view = configStore.sanitizeState(configStore.loadConfigState(sampleState));
  assert.ok(!view.profiles[0].apiKey.includes('abcdefgh'));
  assert.ok(view.profiles[0].apiKey.endsWith('1234'));
  assert.strictEqual(view.profiles[0].hasKey, true);
});
check('空 Key 回退到已保存的 Key', () => {
  const cfg = configStore.resolveConfig({ profileId: 'p1', provider: 'deepseek', model: 'deepseek-chat', apiKey: '' }, configStore.loadConfigState(sampleState));
  assert.strictEqual(cfg.apiKey, 'sk-abcdefgh1234');
});
check('打码 Key 也回退到已保存的 Key', () => {
  const cfg = configStore.resolveConfig({ profileId: 'p1', apiKey: '••••••1234' }, configStore.loadConfigState(sampleState));
  assert.strictEqual(cfg.apiKey, 'sk-abcdefgh1234');
});
check('新填的 Key 会覆盖旧值', () => {
  const cfg = configStore.resolveConfig({ profileId: 'p1', apiKey: 'sk-new-key-0001' }, configStore.loadConfigState(sampleState));
  assert.strictEqual(cfg.apiKey, 'sk-new-key-0001');
});
check('合并时打码 Key 不会把真 Key 覆盖掉', () => {
  const merged = configStore.mergeProfiles(
    [{ id: 'p1', name: '改了名字', provider: 'deepseek', model: 'deepseek-chat', apiKey: '••••••1234' }],
    configStore.loadConfigState(sampleState),
  );
  assert.strictEqual(merged[0].apiKey, 'sk-abcdefgh1234');
  assert.strictEqual(merged[0].name, '改了名字');
});
check('兼容早期的扁平 config.json', () => {
  const legacy = configStore.loadConfigState({ provider: 'openai', apiKey: 'sk-legacy', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
  assert.strictEqual(legacy.profiles.length, 1);
  assert.strictEqual(legacy.profiles[0].provider, 'openai');
  assert.strictEqual(legacy.profiles[0].apiKey, 'sk-legacy');
});
check('未知 activeId 会回退到第一条', () => {
  const s = configStore.loadConfigState({ ...sampleState, activeId: '不存在' });
  assert.strictEqual(s.activeId, 'p1');
});
check('baseUrl 缺失时用服务商默认值', () => {
  const s = configStore.loadConfigState({ profiles: [{ id: 'x', provider: 'anthropic', apiKey: 'sk-ant-1' }] });
  assert.strictEqual(s.profiles[0].baseUrl, 'https://api.anthropic.com');
  assert.strictEqual(s.profiles[0].model, 'claude-sonnet-4-5');
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`);
if (failed) process.exitCode = 1;
