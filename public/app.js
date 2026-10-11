/* 灵犀 · 聊天解读小工具 —— 前端逻辑（原生 JS，无依赖） */
'use strict';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'lingxi.settings.v2';
const THEME_KEY = 'lingxi.theme.v1';

const state = {
  providers: [],
  providerMeta: null,
  profiles: [],
  activeId: '',
  configWritable: true,
  serviceDown: false,
  testCache: {},
  messages: [],
  speakers: [],
  stats: null,
  findings: [],
  report: null,
  markdown: '',
  rawLog: '',
  selfName: '',
  otherName: '',
  insightFilter: 'all',
  analyzing: false,
};

/* ------------------------------------------------------------------ 工具 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

function pct(x) {
  return `${Math.round((x || 0) * 100)}%`;
}

function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}

function toastError(message) {
  const box = el('div', { class: 'notice error', text: message });
  const panel = $('panel-summary');
  panel.prepend(box);
  switchTab('summary');
  setTimeout(() => box.remove(), 15000);
}

/* ------------------------------------------------------------------ 设置 */
/* 表单里的这些值属于「界面偏好」，存在浏览器里；模型接口配置（含 Key）存在服务端 config.json。 */
const FORM_IDS = ['provider', 'baseUrl', 'model', 'temperature', 'maxTokens', 'chunkSize', 'maxChunks', 'stream'];

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const form = { profileName: $('profileName').value.trim() };
  for (const id of FORM_IDS) {
    const node = $(id);
    form[id] = node.type === 'checkbox' ? node.checked : node.value;
  }
  const s = {
    ...form,
    lastProfileId: $('profileSelect').value || state.activeId || '',
    selfName: $('selfName').value.trim(),
    otherName: $('otherName').value.trim(),
    relationship: $('relationship').value,
    goal: $('goal').value,
    theme: currentTheme(),
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

function applySettings() {
  const s = readSettings();
  applyTheme(s.theme === 'dark' ? 'dark' : 'light');
  if (s.selfName) $('selfName').value = s.selfName;
  if (s.otherName) $('otherName').value = s.otherName;
  if (s.relationship) $('relationship').value = s.relationship;
  if (s.goal) $('goal').value = s.goal;
  for (const id of FORM_IDS) {
    if (id === 'provider') continue;
    if (s[id] === undefined || s[id] === null || s[id] === '') continue;
    const node = $(id);
    if (node.type === 'checkbox') node.checked = !!s[id];
    else node.value = s[id];
  }
  if (s.profileName) $('profileName').value = s.profileName;
  return s;
}

/* ------------------------------------------------------------------ 主题 */
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('btnTheme');
  if (btn) {
    btn.textContent = dark ? '☀' : '☾';
    btn.title = dark ? '切换到浅色' : '切换到深色';
  }
  try {
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
  } catch { /* ignore */ }
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

function fillProviders(providers) {
  state.providers = providers;
  const sel = $('provider');
  sel.innerHTML = '';
  for (const p of providers) sel.appendChild(el('option', { value: p.id, text: p.label }));
}

function applyProviderMeta(id, { fillModel = true } = {}) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  state.providerMeta = p;
  $('baseUrl').value = p.baseUrl;
  $('baseUrl').placeholder = p.baseUrl;
  $('apiKey').placeholder = p.keyHint || '';
  if (fillModel) {
    $('model').value = p.defaultModel;
    const dl = $('modelList');
    dl.innerHTML = '';
    for (const m of p.models || []) dl.appendChild(el('option', { value: m }));
  }
  updateStatusPill();
}

function updateStatusPill() {
  const pill = $('statusPill');
  pill.classList.remove('ok', 'bad');
  if (state.serviceDown) {
    pill.textContent = '服务未连接';
    pill.classList.add('bad');
    return;
  }
  if ($('localOnly').checked) {
    pill.textContent = '仅本地统计';
    return;
  }
  const profile = state.profiles.find((p) => p.id === $('profileSelect').value);
  const noKeyNeed = !(state.providerMeta && state.providerMeta.noKey);
  if (!profile) {
    pill.textContent = '未配置接口';
    return;
  }
  if (noKeyNeed && !profile.hasKey && !$('apiKey').value.trim()) {
    pill.textContent = `${profile.name} · 缺 Key`;
    pill.classList.add('bad');
    return;
  }
  pill.textContent = `${profile.name} · ${$('model').value.trim() || profile.model}`;
  pill.classList.add('ok');
}

/* ------------------------------------------------------------------ 模型接口配置 */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function apiJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `服务返回 ${res.status}`);
  return data;
}

function emptyProfile() {
  const meta = state.providers.find((p) => p.id === 'deepseek') || state.providers[0];
  return {
    id: newProfileId(),
    name: '新配置',
    provider: meta ? meta.id : 'deepseek',
    baseUrl: meta ? meta.baseUrl : '',
    model: meta ? meta.defaultModel : '',
    apiKey: '',
    temperature: 0.4,
    maxTokens: 8000,
    chunkSize: 400,
    maxChunks: 12,
    timeoutMs: 300000,
    hasKey: false,
  };
}

function newProfileId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function loadConfigState({ quiet = false } = {}) {
  try {
    const data = await apiJson('/api/config');
    state.profiles = data.profiles || [];
    state.activeId = data.activeId || (state.profiles[0] && state.profiles[0].id) || '';
    state.configWritable = data.writable !== false;
    renderProfileOptions();
    renderProfileList();
    return data;
  } catch (err) {
    if (!quiet) toastError(`读取接口配置失败：${err.message}`);
    return null;
  }
}

function renderProfileOptions() {
  const sel = $('profileSelect');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const p of state.profiles) sel.appendChild(el('option', { value: p.id, text: p.name }));
  if (state.profiles.some((p) => p.id === keep)) sel.value = keep;
  else if (state.profiles.some((p) => p.id === state.activeId)) sel.value = state.activeId;
  else if (state.profiles[0]) sel.value = state.profiles[0].id;
  updateStatusPill();
}

function applyProfileToForm(id, { silent = false } = {}) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  state.activeId = id;
  if (state.profiles.some((x) => x.id === id)) $('profileSelect').value = id;
  $('profileName').value = p.name || '';
  $('provider').value = p.provider || 'deepseek';
  applyProviderMeta($('provider').value, { fillModel: false });
  $('baseUrl').value = p.baseUrl || '';
  $('model').value = p.model || '';
  $('apiKey').value = p.apiKey || '';
  $('temperature').value = p.temperature != null ? p.temperature : 0.4;
  $('maxTokens').value = p.maxTokens || 8000;
  $('chunkSize').value = p.chunkSize || 400;
  $('maxChunks').value = p.maxChunks || 12;
  $('testResult').innerHTML = '';
  $('configHint').textContent = state.configWritable
    ? '配置保存在本机 config.json，可存多条随时切换；Key 只留在你自己的电脑上。'
    : '检测到 config.json 不可写：请手动编辑该文件，或用系统权限重新启动后再保存。';
  renderProfileList();
  if (!silent) saveSettings();
  updateStatusPill();
}

function collectFormConfig() {
  return {
    id: $('profileSelect').value || state.activeId || newProfileId(),
    name: $('profileName').value.trim() || '未命名配置',
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
    temperature: Number($('temperature').value),
    maxTokens: Number($('maxTokens').value),
    chunkSize: Number($('chunkSize').value),
    maxChunks: Number($('maxChunks').value),
  };
}

async function saveProfileToServer({ silent = false } = {}) {
  const cfg = collectFormConfig();
  const list = state.profiles.slice();
  const idx = list.findIndex((p) => p.id === cfg.id);
  const prev = idx >= 0 ? list[idx] : null;
  const merged = { ...(prev || {}), ...cfg };
  if (!cfg.apiKey) merged.apiKey = (prev && prev.apiKey) || '';
  if (idx >= 0) list[idx] = merged;
  else list.push(merged);
  const data = await apiJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles: list, activeId: cfg.id }),
  });
  state.profiles = data.profiles || [];
  state.activeId = data.activeId || cfg.id;
  state.configWritable = data.writable !== false;
  renderProfileOptions();
  renderProfileList();
  $('profileSelect').value = state.activeId;
  const saved = state.profiles.find((p) => p.id === state.activeId);
  if (saved && saved.apiKey) $('apiKey').value = saved.apiKey;
  saveSettings();
  updateStatusPill();
  if (!silent) {
    $('configHint').textContent = `已保存「${merged.name}」到 config.json。`;
    setTimeout(() => {
      $('configHint').textContent = '配置保存在本机 config.json，可存多条随时切换；Key 只留在你自己的电脑上。';
    }, 4000);
  }
  return data;
}

async function newProfile() {
  const p = emptyProfile();
  state.profiles = [...state.profiles, { ...p }];
  renderProfileOptions();
  $('profileSelect').value = p.id;
  applyProfileToForm(p.id, { silent: true });
  $('profileName').value = '新配置';
  $('apiKey').value = '';
  $('profileName').focus();
  $('profileName').select();
  $('configHint').textContent = '填好这条新配置后点「保存修改」写入 config.json。';
  closeModal('configModal');
  $('configModal').classList.remove('hidden');
  state.activeId = p.id;
}

async function deleteActiveProfile() {
  const id = $('profileSelect').value || state.activeId;
  const p = state.profiles.find((x) => x.id === id);
  if (!p) {
    toastError('没有可删除的配置。');
    return;
  }
  if (!window.confirm(`确定删除配置「${p.name}」吗？会同时从 config.json 里移除它的 API Key。`)) return;
  try {
    const data = await apiJson(`/api/config?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.profiles = data.profiles || [];
    state.activeId = data.activeId || (state.profiles[0] && state.profiles[0].id) || '';
    renderProfileOptions();
    if (state.profiles.length) applyProfileToForm(state.activeId, { silent: true });
    else {
      $('profileName').value = '';
      $('apiKey').value = '';
      $('testResult').innerHTML = '';
      renderProfileList();
    }
    updateStatusPill();
  } catch (err) {
    toastError(`删除失败：${err.message}`);
  }
}

async function testProfile(id, { silent = false } = {}) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return null;
  const editing = id === ($('profileSelect').value || state.activeId);
  const apiKey = editing ? $('apiKey').value.trim() : '';
  const target = editing
    ? {
      provider: $('provider').value,
      baseUrl: $('baseUrl').value.trim(),
      model: $('model').value.trim(),
      apiKey,
    }
    : { provider: p.provider, baseUrl: p.baseUrl, model: p.model, apiKey: '' };

  const host = editing ? $('testResult') : null;
  const show = (html) => {
    if (host) host.innerHTML = html;
  };
  show(`<div class="test-line"><span class="badge pending"><span class="dot"></span> 正在连接…</span></div>`);
  renderProfileList(id);

  try {
    const r = await apiJson('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...target, profileId: id } }),
    });
    const elapsed = `${(r.latencyMs / 1000).toFixed(2)} 秒`;
    const html = r.ok
      ? `<div class="test-line">
           <span class="badge ok"><span class="dot"></span> 连接正常</span>
           <span class="hint" style="display:inline">${escapeHtml(r.providerLabel || r.provider)} · ${escapeHtml(r.model)} · ${elapsed}${r.echoed ? ' · 返回内容正确' : ' · 返回内容异常（模型没按要求输出 JSON）'}</span>
           ${r.sample ? `<p class="hint wrap">模型返回样例：${escapeHtml(r.sample)}</p>` : ''}
         </div>`
      : `<div class="test-line">
           <span class="badge bad"><span class="dot"></span> 连接失败</span>
           <p class="hint">${escapeHtml(r.error || '未知错误')}</p>
           ${r.url ? `<p class="hint wrap">请求地址：${escapeHtml(r.url)}</p>` : ''}
         </div>`;
    show(html);
    state.testCache[id] = { ok: !!r.ok, at: Date.now(), latencyMs: r.latencyMs, error: r.error || '', sample: r.sample || '' };
    renderProfileList(id);
    if (!silent && !editing) {
      // 从列表里测试：把结果也贴到侧栏，方便顺手看一眼
      $('testResult').innerHTML = html;
    }
    return r;
  } catch (err) {
    show(`<div class="test-line"><span class="badge bad"><span class="dot"></span> 连接失败</span><p class="hint">${escapeHtml(err.message)}</p></div>`);
    state.testCache[id] = { ok: false, at: Date.now(), error: err.message };
    renderProfileList(id);
    return null;
  }
}

function renderProfileList(pendingId) {
  const host = $('profileList');
  if (!host) return;
  host.innerHTML = '';
  if (!state.profiles.length) {
    host.appendChild(el('div', { class: 'notice info', text: '还没有任何接口配置。点下面的「新建配置」，填好服务商、地址、Key 和模型，然后保存并测试。' }));
    return;
  }
  for (const p of state.profiles) {
    const active = p.id === ($('profileSelect').value || state.activeId);
    const cached = state.testCache[p.id];
    const item = el('div', { class: `profile-item${active ? ' active' : ''}` });
    const radio = el('input', { type: 'radio', name: 'activeProfile', title: '设为当前使用' });
    radio.checked = active;
    radio.addEventListener('change', async () => {
      $('profileSelect').value = p.id;
      applyProfileToForm(p.id);
      try {
        await apiJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profiles: state.profiles, activeId: p.id }),
        });
      } catch { /* 记不住也没关系，界面已经切过去了 */ }
      renderProfileList();
    });

    const main = el('div', { class: 'pi-main', title: '载入这条配置到表单' });
    const nameRow = el('div', { class: 'pi-name' }, [el('span', { text: p.name || '未命名' })]);
    const meta = state.providers.find((x) => x.id === p.provider);
    nameRow.appendChild(el('span', { class: 'tag neutral', text: meta ? meta.label : p.provider }));
    if (!p.hasKey && !(meta && meta.noKey)) nameRow.appendChild(el('span', { class: 'tag warn', text: '缺 Key' }));
    if (p.id === pendingId) nameRow.appendChild(el('span', { class: 'badge pending' }, [el('span', { class: 'dot' }), el('span', { text: '测试中' })]));
    else if (cached) {
      nameRow.appendChild(el('span', {
        class: `badge ${cached.ok ? 'ok' : 'bad'}`,
        text: cached.ok ? `可用 ${(cached.latencyMs / 1000).toFixed(2)}s` : '连接失败',
      }));
    }
    main.appendChild(nameRow);
    main.appendChild(el('div', { class: 'pi-meta', text: `${p.model || '未填模型'}　${p.baseUrl || '未填地址'}` }));
    main.addEventListener('click', () => {
      $('profileSelect').value = p.id;
      applyProfileToForm(p.id);
      closeModal('configModal');
    });

    const actions = el('div', { class: 'pi-actions' });
    actions.appendChild(el('button', { class: 'copy-btn', text: '测试', onclick: () => testProfile(p.id, { silent: true }) }));
    actions.appendChild(el('button', {
      class: 'copy-btn',
      text: '编辑',
      onclick: () => {
        $('profileSelect').value = p.id;
        applyProfileToForm(p.id);
        closeModal('configModal');
      },
    }));

    item.appendChild(radio);
    item.appendChild(main);
    item.appendChild(actions);
    host.appendChild(item);
  }
}

function openModal(id) {
  const m = $(id);
  if (m) m.classList.remove('hidden');
}

function closeModal(id) {
  const m = $(id);
  if (m) m.classList.add('hidden');
}

async function testAllProfiles() {
  const hint = $('configModalHint');
  const list = state.profiles.slice();
  if (!list.length) {
    hint.textContent = '还没有配置可测试。';
    return;
  }
  $('btnTestAll').disabled = true;
  let ok = 0;
  for (const [i, p] of list.entries()) {
    hint.textContent = `正在测试 ${i + 1}/${list.length}：${p.name}`;
    const r = await testProfile(p.id, { silent: true });
    if (r && r.ok) ok += 1;
  }
  hint.textContent = `测试完成：${ok}/${list.length} 条配置可用。`;
  $('btnTestAll').disabled = false;
}

/* ------------------------------------------------------------------ 解析预览 */
let detectTimer = null;
function scheduleDetect() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => {
    const text = $('logText').value;
    $('charCount').textContent = `${text.length.toLocaleString()} 字`;
    if (!text.trim()) {
      $('detectHint').textContent = '等待输入…';
      return;
    }
    fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ctx: buildContext() }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) {
          $('detectHint').textContent = '解析失败';
          return;
        }
        state.messages = data.messages || [];
        state.speakers = data.speakers || [];
        state.stats = data.stats;
        state.findings = data.findings || [];
        const names = state.speakers.slice(0, 4).join('、');
        const range = data.stats && data.stats.range && data.stats.range.first
          ? ` ｜ ${data.stats.range.first.slice(0, 10)} → ${data.stats.range.last.slice(0, 10)}`
          : '';
        $('detectHint').textContent = `已识别 ${data.messages.length} 条消息${range} ｜ 说话人：${names || '未知'}`;
        $('speakerHint').textContent = state.speakers.length
          ? `记录里的说话人（按发言量排序）：${state.speakers.map((s) => `${s}`).join('、')}`
          : '填上昵称后，才能对比双方的回复节奏。';
      })
      .catch(() => { $('detectHint').textContent = '解析请求失败'; });
  }, 420);
}

/* ------------------------------------------------------------------ 请求体 */
function buildContext() {
  return {
    selfName: $('selfName').value.trim(),
    otherName: $('otherName').value.trim(),
    relationship: $('relationship').value,
    goal: $('goal').value,
    knownFacts: $('knownFacts').value.trim(),
    localOnly: $('localOnly').checked,
    sessionGapMinutes: 240,
  };
}

function buildConfig() {
  return {
    profileId: $('profileSelect').value || state.activeId || '',
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
    temperature: Number($('temperature').value),
    maxTokens: Number($('maxTokens').value),
    chunkSize: Number($('chunkSize').value),
    maxChunks: Number($('maxChunks').value),
    stream: $('stream').checked,
  };
}

/* ------------------------------------------------------------------ 进度 */
function setProgress(ratio, text, { idle = false } = {}) {
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    $('progressBar').style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  }
  $('progress').classList.toggle('idle', idle);
  if (text) $('progressText').textContent = text;
}

/* ------------------------------------------------------------------ 分析主流程 */
async function startAnalyze({ previewOnly = false } = {}) {
  const text = $('logText').value.trim();
  if (!text) {
    toastError('还没有内容：把聊天记录粘贴或拖到左边的框里。');
    return;
  }
  const cfg = buildConfig();
  const localOnly = $('localOnly').checked;
  if (!previewOnly && !localOnly) {
    if (!state.profiles.length) {
      toastError('还没有任何模型接口配置：在「3 模型接口」里填一条并点「连接测试」，或勾选「只看本地统计」。');
      return;
    }
    const provider = state.providers.find((p) => p.id === cfg.provider);
    const profile = state.profiles.find((p) => p.id === cfg.profileId);
    if (!(provider && provider.noKey) && !cfg.apiKey && !(profile && profile.hasKey)) {
      toastError('这条接口配置还没有 API Key：填好 Key 后点「保存修改」，或勾选「只看本地统计，不调用模型」。');
      return;
    }
  }
  if (state.analyzing) return;
  state.analyzing = true;
  $('btnAnalyze').disabled = true;
  $('btnPreview').disabled = true;
  state.rawLog = '';
  setProgress(0.02, previewOnly ? '正在解析记录…' : '正在解析记录并准备分段…');

  const t0 = performance.now();
  let buffer = '';
  let gotError = null;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ctx: buildContext(), config: cfg, previewOnly }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `服务返回 ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'error') gotError = evt.error;
        handleEvent(evt, t0, { previewOnly });
      }
    }
    if (buffer.trim()) {
      try { handleEvent(JSON.parse(buffer), t0, { previewOnly }); } catch { /* ignore */ }
    }

    if (gotError) throw new Error(gotError);
    setProgress(1, `完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒。`);
  } catch (err) {
    setProgress(0, '出错了。', { idle: true });
    toastError(String(err.message || err));
    appendRaw(String(err.stack || err.message || err), true);
    switchTab('raw');
  } finally {
    state.analyzing = false;
    $('btnAnalyze').disabled = false;
    $('btnPreview').disabled = false;
  }
}

function handleEvent(evt, t0, { previewOnly }) {
  switch (evt.type) {
    case 'parsed': {
      if (Array.isArray(evt.messages) && evt.messages.length) state.messages = evt.messages;
      state.speakers = evt.speakers || [];
      state.stats = evt.stats || state.stats;
      state.findings = evt.findings || state.findings;
      state.selfName = evt.selfName || $('selfName').value.trim();
      state.otherName = evt.otherName || $('otherName').value.trim();
      if (evt.warnings && evt.warnings.length) appendRaw('解析提示：\n- ' + evt.warnings.join('\n- '));
      renderLocal();
      setProgress(0.08, `已解析 ${state.stats ? state.stats.total : 0} 条消息，正在准备分析…`);
      break;
    }
    case 'phase': {
      if (evt.phase === 'plan') {
        setProgress(0.12, `准备分 ${evt.chunks.length} 段分析（共 ${evt.total} 条消息）…`);
      } else if (evt.phase === 'chunk') {
        const base = 0.12 + (0.72 * (evt.index - 1)) / Math.max(1, evt.total);
        setProgress(base, `正在分析第 ${evt.index}/${evt.total} 段（第 ${evt.start + 1}–${evt.end} 条）…`);
      } else if (evt.phase === 'synthesize') {
        setProgress(0.86, `正在把 ${evt.total} 段结果汇总成整体判断…`);
      }
      break;
    }
    case 'model_start':
      appendRaw(`\n===== ${evt.label} 开始 =====\n`);
      break;
    case 'model_end':
      appendRaw(`\n===== ${evt.label} 结束（${evt.chars} 字）=====\n`);
      break;
    case 'stream':
      appendRaw(evt.text);
      break;
    case 'reasoning':
      if (!state._reasonTick || Date.now() - state._reasonTick > 900) {
        state._reasonTick = Date.now();
        setProgress(undefined, $('progressText').textContent.replace(/（思考中.*?）/, '') + `（思考中 ${evt.chars} 字）`);
      }
      break;
    case 'retry':
      appendRaw(`\n[重试] ${evt.message}，${Math.round((evt.waitMs || 0) / 1000)} 秒后重试…\n`);
      break;
    case 'note':
      appendRaw(`\n[提示] ${evt.message}\n`);
      if (evt.raw) appendRaw(evt.raw + '\n', true);
      break;
    case 'partial':
      state.partialCount = evt.index;
      break;
    case 'result': {
      state.report = evt.report;
      state.stats = evt.stats || state.stats;
      state.findings = evt.findings || state.findings;
      state.markdown = evt.markdown || '';
      renderAll();
      $('btnExportMd').disabled = false;
      $('btnExportJson').disabled = false;
      setProgress(1, `分析完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒。`);
      switchTab('summary');
      break;
    }
    case 'done': {
      if (evt.previewOnly) {
        renderAll();
        setProgress(1, '解析完成（未调用模型）。');
        switchTab('local');
      } else if (evt.localOnly) {
        state.report = null;
        renderAll();
        setProgress(1, '本地统计完成（未调用模型）。');
        switchTab('local');
      } else if (evt.report) {
        state.report = evt.report;
        renderAll();
        $('btnExportMd').disabled = !state.markdown;
        $('btnExportJson').disabled = false;
        switchTab('summary');
      }
      break;
    }
    default:
      break;
  }
  void previewOnly;
}

function appendRaw(text, isErr = false) {
  state.rawLog += text;
  const pre = $('rawLogPre');
  if (pre) {
    pre.textContent = state.rawLog.length > 200000 ? state.rawLog.slice(-200000) : state.rawLog;
    pre.classList.toggle('err', isErr);
    pre.scrollTop = pre.scrollHeight;
  }
}

/* ------------------------------------------------------------------ 渲染 */
function renderAll() {
  renderSummary();
  renderInsights();
  renderReview();
  renderAdvice();
  renderLocal();
  renderRaw();
}

function gaugeSvg(value) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const r = 56;
  const c = 2 * Math.PI * r;
  const color = v >= 70 ? '#e8558f' : v >= 45 ? '#e0803a' : '#6d5ce7';
  return `<svg width="132" height="132" viewBox="0 0 132 132">
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="#eeecf7" stroke-width="12" />
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c - (c * v) / 100}" />
  </svg>
  <div class="val" style="color:${color}">${value == null ? '—' : v}<small>温度</small></div>`;
}

function renderSummary() {
  const body = $('summaryBody');
  body.innerHTML = '';
  if (!state.report && !state.stats) {
    $('emptySummary').classList.remove('hidden');
    return;
  }
  $('emptySummary').classList.add('hidden');
  const stats = state.stats;
  const report = state.report;

  if (report) {
    const ov = report.overview || {};
    const block = el('div', { class: 'block' });
    block.appendChild(el('div', { class: 'gauge-wrap' }, [
      el('div', { class: 'gauge', html: gaugeSvg(ov.temperature) }),
      el('div', { style: 'flex:1;min-width:240px' }, [
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px' }, [
          ov.trend ? el('span', { class: 'tag', text: `趋势：${ov.trend}` }) : null,
          el('span', { class: 'tag neutral', text: `样本 ${stats ? stats.total : 0} 条` }),
          report.meta && report.meta.model ? el('span', { class: 'tag neutral', text: `模型 ${report.meta.model}` }) : null,
        ]),
        el('h3', { text: '对方目前的态度' }),
        el('p', { text: ov.otherAttitude || '—' }),
      ]),
    ]));
    if (ov.signals && ov.signals.length) {
      block.appendChild(el('h3', { text: '关键信号' }));
      block.appendChild(el('ul', { class: 'clean' }, ov.signals.map((s) => el('li', { text: s }))));
    }
    body.appendChild(block);
  }

  if (stats) {
    const grid = el('div', { class: 'grid-2' });
    const s = stats.self;
    const o = stats.other;
    const metric = (k, v, d) => el('div', { class: 'metric' }, [
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v', text: v }),
      d ? el('div', { class: 'd', text: d }) : null,
    ]);
    if (s && o) {
      grid.appendChild(metric('发言量（我 / 对方）', `${s.count} / ${o.count}`, stats.talkRatio ? `比值 ${stats.talkRatio.toFixed(2)}` : ''));
      grid.appendChild(metric('中位回复间隔', `${fmtMin(s.replyMedianMs)} / ${fmtMin(o.replyMedianMs)}`, '我 / 对方'));
      grid.appendChild(metric('主动开启对话', `${s.initiations} / ${o.initiations}`, '谁先开口的次数'));
      grid.appendChild(metric('由谁收尾', `${s.sessionEnds} / ${o.sessionEnds}`, '每次会话最后一句'));
    } else {
      grid.appendChild(metric('消息总数', String(stats.total)));
      grid.appendChild(metric('会话段数', String(stats.sessionCount)));
    }
    grid.appendChild(metric('聊天区间', stats.range.days ? `${stats.range.days} 天` : '—', `${(stats.range.first || '').slice(0, 16)} → ${(stats.range.last || '').slice(0, 16)}`));
    if (stats.longestSilence) {
      grid.appendChild(metric('最长沉默', fmtMin(stats.longestSilence.gap), `之后是 ${stats.longestSilence.by} 发的最后一句`));
    }
    body.appendChild(el('div', { class: 'section-title', text: '互动节奏一览' }));
    body.appendChild(grid);

    if (s && o && stats.sessionCount > 0) {
      const block = el('div', { class: 'block' });
      block.appendChild(el('h3', { text: '谁在推动这段关系' }));
      const initTotal = Math.max(1, s.initiations + o.initiations);
      const barLine = (label, a, b, colorA, colorB) => {
        const total = Math.max(1, a + b);
        return el('div', { class: 'bar-line' }, [
          el('div', { class: 'lbl' }, [el('span', { text: label }), el('span', { text: `${a} : ${b}` })]),
          el('div', { class: 'bar-track' }, [
            el('i', { style: `width:${(a / total) * 100}%;background:${colorA}` }),
            el('i', { style: `width:${(b / total) * 100}%;background:${colorB}` }),
          ]),
        ]);
      };
      block.appendChild(barLine(`主动开启对话（我 ${pct(s.initiations / initTotal)} / 对方 ${pct(o.initiations / initTotal)}）`, s.initiations, o.initiations, '#6d5ce7', '#e8558f'));
      const endTotal = Math.max(1, s.sessionEnds + o.sessionEnds);
      block.appendChild(barLine(`会话收尾（我 ${pct(s.sessionEnds / endTotal)} / 对方 ${pct(o.sessionEnds / endTotal)}）`, s.sessionEnds, o.sessionEnds, '#6d5ce7', '#e8558f'));
      block.appendChild(barLine('发言条数', s.count, o.count, '#8a6cf0', '#f08bb4'));
      block.appendChild(el('p', { class: 'hint', text: '紫 = 我，粉 = 对方。谁在推动、谁在收尾，比单条消息的语气更能说明关系状态。' }));
      body.appendChild(block);
    }

    if (stats.timeline && stats.timeline.length > 1) {
      const block = el('div', { class: 'block' });
      block.appendChild(el('h3', { text: '聊天热度的变化（按时间顺序）' }));
      const tl = el('div', { class: 'timeline' });
      const maxTotal = Math.max(...stats.timeline.map((b) => Object.values(b.bySpeaker).reduce((x, y) => x + y, 0)), 1);
      for (const b of stats.timeline) {
        const mine = b.bySpeaker[state.selfName] || 0;
        const theirs = Object.entries(b.bySpeaker).filter(([k]) => k !== state.selfName).reduce((x, [, v]) => x + v, 0);
        const total = mine + theirs;
        tl.appendChild(el('div', { class: 'tl-row' }, [
          el('span', { text: `${b.from.slice(5, 16)}` }),
          el('span', { class: 'tl-bars', style: `width:${(total / maxTotal) * 100}%` }, [
            el('i', { style: `width:${(mine / Math.max(1, total)) * 100}%;background:#6d5ce7` }),
            el('i', { style: `width:${(theirs / Math.max(1, total)) * 100}%;background:#e8558f` }),
          ]),
          el('span', { style: 'text-align:right', text: `${total} 条` }),
        ]));
      }
      block.appendChild(tl);
      body.appendChild(block);
    }
  }
}

function renderInsights() {
  const body = $('messagesBody');
  const filters = $('insightFilters');
  body.innerHTML = '';
  filters.innerHTML = '';
  const report = state.report;
  if (!report || !report.insights || !report.insights.length) {
    body.appendChild(el('div', { class: 'notice info', text: '还没有逐条解读。点「开始分析」后，这里会列出对方每句关键话的情绪、潜台词，以及你该怎么接。' }));
    return;
  }

  const speakers = Array.from(new Set(report.insights.map((i) => i.speaker).filter(Boolean)));
  const chip = (key, label) => el('button', {
    class: `chip${state.insightFilter === key ? ' active' : ''}`,
    text: label,
    onclick: () => { state.insightFilter = key; renderInsights(); },
  });
  filters.appendChild(chip('all', `全部 ${report.insights.length}`));
  speakers.forEach((s, i) => filters.appendChild(chip(`s${i}`, s)));
  const mine = report.insights.filter((i) => i.speaker === state.selfName).length;
  if (mine) filters.appendChild(chip('mine', `我自己的 ${mine}`));

  let list = report.insights;
  if (state.insightFilter.startsWith('s')) {
    const sp = speakers[Number(state.insightFilter.slice(1))];
    list = list.filter((i) => i.speaker === sp);
  } else if (state.insightFilter === 'mine') {
    list = list.filter((i) => i.speaker === state.selfName);
  }

  for (const it of list) {
    const card = el('div', { class: 'insight' });
    const isMine = it.speaker === state.selfName;
    card.appendChild(el('div', { class: 'head' }, [
      el('span', { class: 'who', text: `${it.speaker || '对方'}${isMine ? '（我）' : ''}` }),
      it.emotion ? el('span', { class: `tag${emotionClass(it.emotion)}`, text: it.emotion }) : null,
      it.ref != null ? el('span', { class: 'tag neutral', text: `第 ${it.ref} 条` }) : null,
      it.confidence != null ? el('span', { class: 'conf', html: `把握度 ${it.confidence}% <span class="conf-bar"><i style="width:${it.confidence}%"></i></span>` }) : null,
      el('span', { style: 'flex:1' }),
      el('button', { class: 'copy-btn', text: '复制原文', onclick: (e) => copyText(it.text || '', e.target) }),
    ]));
    card.appendChild(el('div', { class: 'quote', text: it.text || '' }));
    const kv = el('div', { class: 'kv' });
    if (it.surface) { kv.appendChild(el('div', { class: 'k', text: '字面' })); kv.appendChild(el('div', { text: it.surface })); }
    if (it.subtext) { kv.appendChild(el('div', { class: 'k', text: '潜台词' })); kv.appendChild(el('div', { text: it.subtext })); }
    if (it.confidence != null) { kv.appendChild(el('div', { class: 'k', text: '把握度' })); kv.appendChild(el('div', { text: `${it.confidence}%（低于 60% 建议只作参考）` })); }
    card.appendChild(kv);
    if (it.suggestion) {
      card.appendChild(el('div', { class: 'rewrite' }, [
        el('div', { style: 'font-size:12px;color:#3d8a68;margin-bottom:4px', text: '可以这样接：' }),
        el('div', { text: it.suggestion }),
        el('button', { class: 'copy-btn', style: 'margin-top:6px', text: '复制这句', onclick: (e) => copyText(it.suggestion, e.target) }),
      ]));
    }
    body.appendChild(card);
  }
}

function emotionClass(emotion) {
  const e = String(emotion);
  if (/怒|烦|生气|不爽|失望|冷|疏离|不悦|介意/.test(e)) return ' warn';
  if (/开心|喜欢|期待|撒娇|亲近|温柔|甜/.test(e)) return ' good';
  if (/敷衍|平淡|客套|疲惫|无奈/.test(e)) return ' neutral';
  return '';
}

function renderReview() {
  const body = $('reviewBody');
  body.innerHTML = '';
  const report = state.report;
  if (!report || !report.review || !report.review.length) {
    body.appendChild(el('div', { class: 'notice info', text: '还没有复盘内容。分析完成后，这里会逐条列出你哪句话没接好，并给出可以直接发送的改写。' }));
    return;
  }
  report.review.forEach((r, idx) => {
    const card = el('div', { class: `review sev-${r.severity || '中'}` });
    card.appendChild(el('div', { class: 'head' }, [
      el('span', { class: 'tag danger', text: `${idx + 1}. ${r.issue || '待改进'}` }),
      r.severity ? el('span', { class: `tag${r.severity === '高' ? ' danger' : r.severity === '低' ? ' neutral' : ' warn'}`, text: `危害 ${r.severity}` }) : null,
      r.ref != null ? el('span', { class: 'tag neutral', text: `第 ${r.ref} 条` }) : null,
    ]));
    if (r.otherBefore) {
      card.appendChild(el('div', { style: 'font-size:12.5px;color:var(--ink-3)', text: '对方上一句：' }));
      card.appendChild(el('div', { class: 'quote', text: r.otherBefore }));
    }
    card.appendChild(el('div', { style: 'font-size:12.5px;color:var(--ink-3)', text: '我当时说的是：' }));
    card.appendChild(el('div', { class: 'quote', style: 'border-left-color:#f0c9a0', text: r.myText || '' }));
    if (r.why) card.appendChild(el('p', { text: `问题在哪：${r.why}` }));
    if (r.rewrite) {
      card.appendChild(el('div', { class: 'rewrite' }, [
        el('div', { style: 'font-size:12px;color:#3d8a68;margin-bottom:4px', text: '可以改成：' }),
        el('div', { text: r.rewrite }),
        el('button', { class: 'copy-btn', style: 'margin-top:6px', text: '复制改写', onclick: (e) => copyText(r.rewrite, e.target) }),
      ]));
    }
    if (r.whyBetter) card.appendChild(el('p', { class: 'hint', text: `好在哪：${r.whyBetter}` }));
    body.appendChild(card);
  });
}

function renderAdvice() {
  const body = $('adviceBody');
  body.innerHTML = '';
  const report = state.report;
  if (!report || !report.advice) {
    body.appendChild(el('div', { class: 'notice info', text: '还没有行动建议。分析完成后，这里会给出该做什么、别做什么、可以聊的新话题，以及下一条消息怎么发。' }));
    return;
  }
  const ad = report.advice;
  const listBlock = (title, items, cls) => {
    if (!items || !items.length) return null;
    const b = el('div', { class: `block ${cls || ''}` });
    b.appendChild(el('h3', { text: title }));
    b.appendChild(el('ul', { class: 'check' }, items.map((x) => el('li', { text: x }))));
    return b;
  };
  const grid = el('div', { class: 'grid-2' });
  const d = listBlock('现在该做', ad.do, 'do');
  const n = listBlock('千万别做', ad.dont, 'dont');
  if (d) grid.appendChild(d);
  if (n) grid.appendChild(n);
  body.appendChild(grid);

  if (ad.topicIdeas && ad.topicIdeas.length) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '可以自然聊起的新话题' }));
    b.appendChild(el('ul', { class: 'clean' }, ad.topicIdeas.map((x) => el('li', { text: x }))));
    body.appendChild(b);
  }

  if (ad.nextMove && (ad.nextMove.shouldReach || ad.nextMove.message)) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '下一步动作' }));
    if (ad.nextMove.shouldReach) {
      b.appendChild(el('div', { class: 'kv' }, [
        el('div', { class: 'k', text: '该不该主动' }),
        el('div', { text: ad.nextMove.shouldReach }),
      ]));
    }
    if (ad.nextMove.message) {
      b.appendChild(el('div', { class: 'rewrite' }, [
        el('div', { style: 'font-size:12px;color:#3d8a68;margin-bottom:4px', text: '现在就可以发这条：' }),
        el('div', { text: ad.nextMove.message }),
        el('button', { class: 'copy-btn', style: 'margin-top:6px', text: '复制', onclick: (e) => copyText(ad.nextMove.message, e.target) }),
      ]));
    }
    if (ad.nextMove.fallback) b.appendChild(el('p', { class: 'hint', text: `如果对方反应冷淡：${ad.nextMove.fallback}` }));
    body.appendChild(b);
  }

  if (ad.watchList && ad.watchList.length) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '继续观察这些点' }));
    b.appendChild(el('ul', { class: 'clean' }, ad.watchList.map((x) => el('li', { text: x }))));
    body.appendChild(b);
  }
}

function renderLocal() {
  const body = $('localBody');
  body.innerHTML = '';
  const stats = state.stats;
  if (!stats) {
    body.appendChild(el('div', { class: 'notice info', text: '粘贴聊天记录后，这里会立即显示不需要模型的硬统计。' }));
    return;
  }
  if (state.findings && state.findings.length) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '程序检测到的信号（纯规则，不花钱）' }));
    for (const f of state.findings) {
      b.appendChild(el('div', { class: `notice ${f.level === 'warn' ? 'warn' : f.level === 'good' ? 'ok' : 'info'}`, style: 'margin-bottom:8px' }, [
        el('b', { text: f.title + '：' }),
        el('span', { text: f.detail }),
      ]));
    }
    body.appendChild(b);
  }

  const b = el('div', { class: 'block' });
  b.appendChild(el('h3', { text: '双人指标对照' }));
  const s = stats.self;
  const o = stats.other;
  const table = el('table', { class: 'data' });
  table.appendChild(el('tr', {}, [
    el('th', { text: '指标' }),
    el('th', { text: `我（${s ? s.name : '—'}）` }),
    el('th', { text: `对方（${o ? o.name : '—'}）` }),
  ]));
  const rows = [
    ['消息条数', (p) => `${p.count}（${pct(p.share)}）`],
    ['平均字数 / 条', (p) => `${p.avgLen}`],
    ['中位字数 / 条', (p) => `${p.medianLen == null ? '—' : p.medianLen}`],
    ['中位回复间隔', (p) => fmtMin(p.replyMedianMs)],
    ['平均回复间隔', (p) => fmtMin(p.replyMeanMs)],
    ['主动开启对话', (p) => `${p.initiations} 次（${pct(p.initiationShare)}）`],
    ['会话收尾次数', (p) => `${p.sessionEnds} 次`],
    ['连续发消息（中位 / 最长）', (p) => `${p.medianRun == null ? '—' : p.medianRun} / ${p.maxRun}`],
    ['疑问句', (p) => `${p.questions} 次`],
    ['笑（哈哈/笑死/emoji）', (p) => `${p.laugh} 次`],
    ['表情包 / 图片 / 语音', (p) => `${p.sticker} / ${p.image} / ${p.voice}`],
    ['0-6 点消息', (p) => `${p.lateNight} 条`],
  ];
  for (const [label, fn] of rows) {
    table.appendChild(el('tr', {}, [
      el('td', { text: label }),
      el('td', { class: 'num', text: s ? fn(s) : '—' }),
      el('td', { class: 'num', text: o ? fn(o) : '—' }),
    ]));
  }
  b.appendChild(table);
  const meta = [];
  meta.push(`聊天区间：${stats.range.first} → ${stats.range.last}（约 ${stats.range.days} 天）`);
  meta.push(`消息总数 ${stats.total}（文本 ${stats.textTotal}，图片/语音/表情等 ${stats.mediaTotal}）`);
  meta.push(`会话段数 ${stats.sessionCount}（间隔超过 ${stats.sessionGapMinutes} 分钟算一段）`);
  if (stats.longestSilence) meta.push(`最长沉默 ${fmtMin(stats.longestSilence.gap)}（${stats.longestSilence.from} 之后）`);
  if (stats.peakHours && stats.peakHours.length) meta.push(`聊天高峰：${stats.peakHours.map((h) => `${h.hour} 点`).join('、')}`);
  b.appendChild(el('p', { class: 'hint', text: meta.join('　｜　') }));
  body.appendChild(b);

  if (state.messages && state.messages.length) {
    const pre = el('div', { class: 'block' });
    pre.appendChild(el('h3', { text: `解析预览（共 ${state.messages.length} 条，显示前 300 条）` }));
    const box = el('div', { class: 'chat-preview' });
    for (const m of state.messages.slice(0, 300)) {
      const mine = m.speaker === state.selfName;
      box.appendChild(el('div', { class: `chat-line${mine ? ' mine' : ''}${m.kind === 'system' ? ' sys' : ''}` }, [
        el('span', { class: 'idx', text: `#${m.idx}` }),
        el('span', { class: 'ts', text: m.ts ? m.ts.short : '' }),
        el('span', { class: 'who', text: m.speaker + '：' }),
        el('span', { text: m.text }),
        m.kind !== 'text' ? el('span', { class: 'meta-kind', text: `（${m.kind}）` }) : null,
      ]));
    }
    pre.appendChild(box);
    body.appendChild(pre);
  }
}

function renderRaw() {
  const body = $('rawBody');
  if (!body.dataset.built) {
    body.innerHTML = '';
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '原始日志 / 模型返回（排查问题用）' }));
    b.appendChild(el('p', { class: 'hint', text: '这里会实时显示模型的原始输出。如果报告解析失败，多半是模型没按 JSON 输出，可以在这里看到原因。' }));
    const pre = el('pre', { class: 'log', id: 'rawLogPre', text: state.rawLog || '（暂无日志）' });
    b.appendChild(pre);
    b.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', text: '复制日志', onclick: () => copyText(state.rawLog) }),
    ]));
    body.appendChild(b);
    body.dataset.built = '1';
  } else {
    const pre = $('rawLogPre');
    if (pre) pre.textContent = state.rawLog || '（暂无日志）';
  }
}

/* ------------------------------------------------------------------ 标签页 */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['summary', 'messages', 'review', 'advice', 'local', 'simulate', 'raw'].forEach((n) => {
    const p = $(`panel-${n}`);
    if (p) p.classList.toggle('hidden', n !== name);
  });
}

/* ------------------------------------------------------------------ 试聊模拟 */
async function runSimulate() {
  const draft = $('draftText').value.trim();
  if (!draft) {
    $('simHint').textContent = '先写一句你准备发的话。';
    return;
  }
  if (!$('logText').value.trim()) {
    $('simHint').textContent = '需要先在左边导入聊天记录，模型才知道对方的说话风格。';
    return;
  }
  const cfg = buildConfig();
  const provider = state.providers.find((x) => x.id === cfg.provider);
  const profile = state.profiles.find((x) => x.id === cfg.profileId);
  if (!(provider && provider.noKey) && !cfg.apiKey && !(profile && profile.hasKey)) {
    $('simHint').textContent = '先在左边「3 模型接口」里填好 Key 并保存。';
    return;
  }
  $('btnSimulate').disabled = true;
  $('simHint').textContent = '正在预演…';
  const body = $('simBody');
  body.innerHTML = '<div class="notice info">模型正在推演对方的反应…</div>';
  try {
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('logText').value, draft, ctx: buildContext(), config: cfg }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let error = null;
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      buffer += decoder.decode(c.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'result') result = evt.result;
        else if (evt.type === 'error' || evt.error) error = evt.error || evt.message;
        else if (evt.type === 'stream') $('simHint').textContent = `正在预演…（${evt.chars} 字）`;
      }
    }
    if (error) throw new Error(error);
    if (!result) throw new Error('没有拿到结果');
    renderSimulation(result);
    $('simHint').textContent = '完成。';
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'notice error', text: String(err.message || err) }));
    $('simHint').textContent = '失败。';
  } finally {
    $('btnSimulate').disabled = false;
  }
}

function renderSimulation(r) {
  const body = $('simBody');
  body.innerHTML = '';
  if (r.readiness != null || r.verdict) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '这条消息现在发合适吗' }));
    b.appendChild(el('div', { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap' }, [
      el('div', { class: 'gauge', style: 'width:110px;height:110px', html: gaugeSvg(r.readiness) }),
      el('div', { style: 'flex:1;min-width:220px' }, [
        el('p', { style: 'font-size:16px;font-weight:700;margin:0 0 6px', text: r.verdict || '' }),
        r.risks && r.risks.length ? el('ul', { class: 'clean' }, r.risks.map((x) => el('li', { text: x }))) : null,
      ]),
    ]));
    body.appendChild(b);
  }
  if (r.replies && r.replies.length) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '对方最可能的反应' }));
    for (const rep of r.replies) {
      b.appendChild(el('div', { class: 'quote' }, [
        el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:4px' }, [
          el('span', { class: 'tag', text: rep.style || '可能' }),
          rep.likelihood != null ? el('span', { class: 'conf', text: `可能性 ${rep.likelihood}%` }) : null,
        ]),
        el('div', { text: rep.reply }),
      ]));
    }
    body.appendChild(b);
  }
  if (r.improved) {
    const b = el('div', { class: 'block' });
    b.appendChild(el('h3', { text: '更稳的说法' }));
    b.appendChild(el('div', { class: 'rewrite' }, [
      el('div', { text: r.improved }),
      el('button', { class: 'copy-btn', style: 'margin-top:6px', text: '复制', onclick: (e) => copyText(r.improved, e.target) }),
    ]));
    body.appendChild(b);
  }
}

/* ------------------------------------------------------------------ 事件绑定 */
function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('btnAnalyze').addEventListener('click', () => startAnalyze({}));
  $('btnPreview').addEventListener('click', () => startAnalyze({ previewOnly: true }));
  $('btnSimulate').addEventListener('click', runSimulate);

  $('logText').addEventListener('input', scheduleDetect);
  ['selfName', 'otherName', 'knownFacts', 'relationship', 'goal'].forEach((id) => {
    $(id).addEventListener('change', () => { saveSettings(); scheduleDetect(); });
  });
  ['profileName', 'baseUrl', 'model', 'temperature', 'maxTokens', 'chunkSize', 'maxChunks', 'stream', 'apiKey'].forEach((id) => {
    $(id).addEventListener('change', saveSettings);
  });

  $('provider').addEventListener('change', () => {
    applyProviderMeta($('provider').value);
    saveSettings();
    updateStatusPill();
    $('testResult').innerHTML = '';
  });

  // 接口配置管理
  $('profileSelect').addEventListener('change', () => {
    applyProfileToForm($('profileSelect').value);
  });
  $('btnTest').addEventListener('click', () => testProfile($('profileSelect').value || state.activeId));
  $('btnSaveProfile').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await saveProfileToServer();
    } catch (err) {
      toastError(`保存失败：${err.message}`);
    } finally {
      e.target.disabled = false;
    }
  });
  $('btnNewProfile').addEventListener('click', newProfile);
  $('btnNewProfile2').addEventListener('click', newProfile);
  $('btnDeleteProfile').addEventListener('click', deleteActiveProfile);
  $('btnProfiles').addEventListener('click', () => {
    renderProfileList();
    openModal('configModal');
  });
  $('btnReloadProfiles').addEventListener('click', async () => {
    const data = await loadConfigState();
    if (data) {
      if (state.profiles.length) applyProfileToForm(state.activeId, { silent: true });
      $('configHint').textContent = '已从 config.json 重新读取配置。';
    }
  });
  $('btnTestAll').addEventListener('click', testAllProfiles);
  $('btnTheme').addEventListener('click', toggleTheme);

  $('localOnly').addEventListener('change', () => {
    $('progressText').textContent = $('localOnly').checked
      ? '已切换到「只看本地统计」：不会调用任何模型。'
      : '准备就绪。';
    updateStatusPill();
  });

  // 文件导入
  const pick = () => $('fileInput').click();
  $('btnPick').addEventListener('click', pick);
  $('dropZone').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') pick(); });
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) readFileInto(f);
    e.target.value = '';
  });
  const dz = $('dropZone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFileInto(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('btnHelp').addEventListener('click', () => openModal('helpModal'));
  $('helpClose').addEventListener('click', () => closeModal('helpModal'));
  $('helpModal').addEventListener('click', (e) => { if (e.target === $('helpModal')) closeModal('helpModal'); });
  $('configClose').addEventListener('click', () => closeModal('configModal'));
  $('configModal').addEventListener('click', (e) => { if (e.target === $('configModal')) closeModal('configModal'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('configModal');
      closeModal('helpModal');
    }
  });

  $('btnExportMd').addEventListener('click', () => {
    if (state.markdown) download(`聊天解读报告-${stamp()}.md`, state.markdown, 'text/markdown;charset=utf-8');
  });
  $('btnExportJson').addEventListener('click', () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      self: state.selfName,
      other: state.otherName,
      stats: state.stats,
      findings: state.findings,
      report: state.report,
    };
    download(`聊天解读数据-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function readFileInto(file) {
  if (file.size > 12 * 1024 * 1024) {
    toastError('文件太大了（超过 12MB），建议只保留想分析的那几周记录。');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    $('logText').value = String(reader.result || '');
    scheduleDetect();
    $('progressText').textContent = `已载入 ${file.name}，点「开始分析」。`;
  };
  reader.onerror = () => toastError('读取文件失败。');
  reader.readAsText(file, 'utf-8');
}

/* ------------------------------------------------------------------ 启动 */
function updateModelList(providerId) {
  const meta = state.providers.find((p) => p.id === providerId);
  const dl = $('modelList');
  dl.innerHTML = '';
  for (const m of (meta && meta.models) || []) dl.appendChild(el('option', { value: m }));
}

async function init() {
  bind();
  const saved = applySettings();
  $('provider').value = '';
  try {
    const providers = await apiJson('/api/providers');
    fillProviders(providers.providers || []);
    state.configWritable = providers.writable !== false;
  } catch {
    state.serviceDown = true;
    updateStatusPill();
    $('configHint').textContent = '连不上本地服务：请确认是通过 start.bat 或 node tools/launch.js 打开的页面。';
    setProgress(0, '服务未连接。', { idle: true });
    return;
  }

  await loadConfigState({ quiet: true });
  if (!state.profiles.length) {
    // 首次使用：给一条预填好的配置，用户只需补 Key
    const p = emptyProfile();
    p.name = 'DeepSeek 官方';
    state.profiles = [p];
    state.activeId = p.id;
  }
  if (saved.lastProfileId && state.profiles.some((p) => p.id === saved.lastProfileId)) {
    state.activeId = saved.lastProfileId;
  }
  const active = state.profiles.find((p) => p.id === state.activeId) || state.profiles[0];
  $('profileSelect').innerHTML = '';
  for (const p of state.profiles) $('profileSelect').appendChild(el('option', { value: p.id, text: p.name }));
  $('profileSelect').value = active.id;

  updateModelList(active.provider);
  applyProfileToForm(active.id, { silent: true });
  renderProfileList();
  updateStatusPill();
  setProgress(0, state.profiles.some((p) => p.hasKey)
    ? '准备就绪：接口配置已就位，可以直接开始分析。'
    : '准备就绪：先在「3 模型接口」里填好 Key 并点「连接测试」。', { idle: true });
}

document.addEventListener('DOMContentLoaded', init);
window.__LINGXI_READY__ = true;
window.addEventListener('error', (e) => {
  try {
    const box = document.createElement('div');
    box.className = 'notice error';
    box.style.margin = '12px 18px';
    box.textContent = `界面出错：${e.message}（${(e.filename || '').split('/').pop()}:${e.lineno}）——可以把这个信息截图反馈。`;
    document.body.prepend(box);
  } catch { /* ignore */ }
});
