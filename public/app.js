'use strict';
// ---------- bootstrap ----------
const qs = new URLSearchParams(location.search);
let TOKEN = qs.get('t') || localStorage.getItem('cc_token') || '';
if (qs.get('t')) { localStorage.setItem('cc_token', TOKEN); history.replaceState(null, '', '/'); }

const $ = s => document.querySelector(s);
const esc = window.escHtml;
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch {} throw new Error(msg); }
  return r.json();
}
let toastTimer;
function toast(msg, ms = 3000) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }
function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} }

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const S = {
  sessions: [], prefs: {}, cur: null, draft: null, cwd: '',
  msgs: [], toolEls: new Map(), images: [], showAllMsgs: false,
  running: new Map(),    // sid -> {startedAt, activity}
  perms: new Map(),      // sid -> Map(requestId -> perm)
  stream: '', loading: false, pending: [], attachments: [], model: '', helloCount: 0, stick: true,
  collapsed: new Set(JSON.parse(ls('cc_collapsed') || '[]')),
};
const T = $('#transcript');

// ---------- helpers ----------
function relTime(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '剛剛';
  if (d < 3600) return Math.floor(d / 60) + ' 分';
  if (d < 86400) return Math.floor(d / 3600) + ' 小時';
  if (d < 86400 * 2) return '昨天';
  if (d < 86400 * 7) return Math.floor(d / 86400) + ' 天';
  const t = new Date(ts); return (t.getMonth() + 1) + '/' + t.getDate();
}
function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
function fileUrl(p) { return `/api/file?t=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}&cwd=${encodeURIComponent(S.cwd || '')}`; }
function curSession() { return S.sessions.find(s => s.id === S.cur); }
function nearBottom() { return T.scrollHeight - T.scrollTop - T.clientHeight < 120; }
function scrollBottom(force) { if (force || S.stick) T.scrollTop = T.scrollHeight; }
T.addEventListener('scroll', () => { S.stick = nearBottom(); });

// ---------- sidebar ----------
function visibleSessions() {
  const q = $('#search').value.trim().toLowerCase();
  const showScratch = $('#chkScratch').checked, showHidden = $('#chkHidden').checked, src = S.source;
  return S.sessions.filter(s => (showHidden || !s.hidden || s.id === S.cur) && (showScratch || !s.scratch || s.id === S.cur) &&
    (src === 'all' || s.source === src || s.id === S.cur) &&
    (!q || (s.title + ' ' + s.cwd + ' ' + (s.lastPrompt || '')).toLowerCase().includes(q)));
}
function renderSidebar() {
  const list = $('#sessionList'); list.innerHTML = '';
  const ss = visibleSessions();
  const pinned = ss.filter(s => s.pinned), rest = ss.filter(s => !s.pinned);
  if (pinned.length) list.append(group('pinned', '📌 釘選', null, pinned));
  if (S.prefs.groupBy === 'time') {
    const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const b = [['今天', today], ['昨天', today - 864e5], ['過去 7 天', today - 7 * 864e5], ['過去 30 天', today - 30 * 864e5], ['更早', -Infinity]];
    for (let i = 0; i < b.length; i++) {
      const items = rest.filter(s => s.updatedAt >= b[i][1] && (i === 0 || s.updatedAt < b[i - 1][1]));
      if (items.length) list.append(group('t' + i, b[i][0], null, items, true));
    }
  } else {
    const groups = new Map();
    for (const s of rest) { const k = (s.cwd || '(未知)').toLowerCase(); if (!groups.has(k)) groups.set(k, { cwd: s.cwd, items: [] }); groups.get(k).items.push(s); }
    for (const [k, g] of groups) list.append(group('f:' + k, baseName(g.cwd) || '(未知)', g.cwd, g.items));
  }
  if (!ss.length) list.append(el('div', { class: 'empty muted' }, S.sessions.length ? '沒有符合的對話' : '還沒有對話，按「＋ 新對話」開始'));
}
function group(key, label, cwd, items, showFolder) {
  const collapsed = S.collapsed.has(key);
  const g = el('div', { class: 'group' + (collapsed ? ' collapsed' : '') });
  const head = el('div', { class: 'ghead', title: cwd || '' },
    el('span', { class: 'caret' }, collapsed ? '▸' : '▾'), el('span', { class: 'glabel' }, label), el('span', { class: 'gcount muted' }, items.length));
  if (cwd) head.append(el('button', { class: 'gadd', title: '在此資料夾開新對話', onclick: e => { e.stopPropagation(); newDraft(cwd); } }, '＋'));
  head.onclick = () => { collapsed ? S.collapsed.delete(key) : S.collapsed.add(key); ls('cc_collapsed', JSON.stringify([...S.collapsed])); renderSidebar(); };
  g.append(head);
  if (!collapsed) {
    const max = S.expandedGroups && S.expandedGroups.has(key) ? Infinity : 15;
    items.slice(0, max).forEach(s => g.append(item(s, showFolder)));
    if (items.length > max) g.append(el('div', { class: 'more muted', onclick: () => { (S.expandedGroups ||= new Set()).add(key); renderSidebar(); } }, `顯示其餘 ${items.length - max} 個…`));
  }
  return g;
}
function item(s, showFolder) {
  const run = S.running.has(s.id), wait = S.perms.get(s.id) && S.perms.get(s.id).size;
  const d = el('div', { class: 'sitem' + (s.id === S.cur ? ' active' : '') + (s.hidden ? ' ishidden' : ''), title: `${s.title}\n${s.cwd}` },
    el('span', { class: 'dot' + (wait ? ' wait' : run ? ' run' : '') }),
    el('div', { class: 'sbody' }, el('div', { class: 'stitle' }, S.source === 'all' && s.source === 'desktop' ? el('span', { class: 'srctag', title: '桌面版開的對話' }, '桌面') : null, s.title),
      showFolder ? el('div', { class: 'sfolder muted' }, baseName(s.cwd)) : null),
    el('span', { class: 'stime muted' }, relTime(s.updatedAt)));
  d.onclick = () => openSession(s.id);
  d.oncontextmenu = e => { e.preventDefault(); sessionMenu(s, e.clientX, e.clientY); };
  return d;
}
function sessionMenu(s, x, y) {
  showMenu(x, y, [
    ['✎ 重新命名', () => renameSession(s)],
    [s.pinned ? '取消釘選' : '📌 釘選', () => patch(s.id, { pinned: !s.pinned })],
    [s.hidden ? '↩ 取消封存' : '🗄 封存', () => archiveSession(s)],
    ['⌨ 在 PowerShell 開啟', () => api('POST', `/api/sessions/${s.id}/terminal`).catch(e => toast(e.message))],
    ['📂 開啟資料夾', () => reveal(s.cwd)],
    ['⧉ 複製 Session ID', () => { navigator.clipboard.writeText(s.id); toast('已複製 ' + s.id); }],
    ['🗑 刪除…', () => deleteSessionUI(s), 'danger'],
  ]);
}
// 封存 = app-side "hidden" flag: the conversation stays on disk, it just leaves the list
// (sessions archived in Claude Desktop start out archived here too)
function archiveSession(s) {
  patch(s.id, { hidden: !s.hidden }).then(() => toast(s.hidden ? '已取消封存' : '已封存（勾左下「已封存」可以再看到）'));
}
// 刪除 = the transcript (+ its folder) goes to the Windows Recycle Bin, so it can still be restored from there
async function deleteSessionUI(s) {
  if (S.running.has(s.id)) { toast('這個對話正在執行，請先按停止再刪除'); return; }
  const warn = s.source === 'desktop' ? '\n\n⚠ 這是桌面版開的對話。刪除後，桌面版裡的這個對話也會打不開。' : '';
  if (!confirm(`刪除對話「${s.title}」？\n\n對話紀錄會移到 Windows 資源回收筒，需要的話還可以從那裡還原。${warn}`)) return;
  try { await api('DELETE', `/api/sessions/${s.id}`); }
  catch (e) { toast('刪除失敗: ' + e.message, 6000); return; }
  if (S.cur === s.id) newDraft(s.cwd);
  S.sessions = S.sessions.filter(x => x.id !== s.id); renderSidebar();
  toast('已刪除（在資源回收筒）');
}
function showMenu(x, y, items) {
  const m = $('#menu'); m.innerHTML = '';
  for (const [label, fn, cls] of items) m.append(el('div', { class: 'mi' + (cls ? ' ' + cls : ''), onclick: () => { hideMenu(); fn(); } }, label));
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideMenu() { $('#menu').hidden = true; }
document.addEventListener('click', e => { if (!e.target.closest('#menu')) hideMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });

async function patch(id, body) { try { await api('PATCH', `/api/sessions/${id}`, body); await loadSessions(); } catch (e) { toast(e.message); } }
function renameSession(s) { const t = prompt('對話名稱', s.title); if (t != null) patch(s.id, { title: t.trim() }); }
function reveal(p) { if (p) api('POST', '/api/reveal', { path: p }).catch(e => toast(e.message)); }
async function loadSessions() {
  const d = await api('GET', '/api/sessions');
  S.sessions = d.sessions;
  for (const s of S.sessions) if (s.running && !S.running.has(s.id)) S.running.set(s.id, { startedAt: Date.now(), activity: '' });
  renderSidebar(); renderHead();
}

// ---------- header ----------
function renderHead() {
  const s = curSession();
  $('#hTitle').textContent = S.draft ? '新對話' : s ? s.title : '';
  $('#hCwd').textContent = S.cwd ? S.cwd : '';
  $('#hCwd').hidden = !S.cwd;
  $('#hModel').textContent = S.model ? '· ' + S.model : '';
  for (const id of ['#btnTerminal', '#btnPin', '#btnHide', '#btnDelete']) $(id).disabled = !s || !!S.draft;
  if (s) {
    $('#btnPin').classList.toggle('on', s.pinned); $('#btnHide').classList.toggle('on', s.hidden);
    $('#btnHide').title = s.hidden ? '取消封存' : '封存（從列表收起，勾左下「已封存」可再看到）';
  }
  document.title = (s && !S.draft ? s.title + ' — ' : '') + 'CLI Controller';
}
// context length: how much of the model's context window this session currently fills
function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}
function renderCtx() {
  const m = $('#ctxMeter'), c = !S.draft && S.ctx;
  if (!c || (!c.used && !c.compacted)) { m.hidden = true; return; }
  m.hidden = false;
  const win = c.window && c.used != null && c.used <= c.window * 1.05 ? c.window : null;
  const pct = win ? Math.min(100, (c.used / win) * 100) : null;
  m.classList.toggle('nowin', !win);
  m.classList.toggle('warn', pct != null && pct >= 70 && pct < 90);
  m.classList.toggle('full', pct != null && pct >= 90);
  m.querySelector('.ctxbar i').style.width = (pct || 0) + '%';
  let txt = c.used == null ? '已壓縮' : fmtTok(c.used) + (win ? ' / ' + fmtTok(win) + ' (' + Math.round(pct) + '%)' : '');
  if (c.compacted && c.used != null) txt += ' · 已壓縮';
  m.querySelector('.ctxnum').textContent = txt;
  m.title = c.used == null
    ? '對話剛被壓縮，下一次回覆後會更新 context 長度'
    : `目前這個 session 已使用的 context：${c.used.toLocaleString()} tokens` +
      (win ? `\n模型上限：${win.toLocaleString()} tokens（${c.model || ''}）` : '\n模型上限未知（在這裡送出一則訊息後就會知道）') +
      (c.compacted ? '\n（對話壓縮後的估計值，下一次回覆後會更新）' : '') +
      '\n快滿時 Claude 會自動壓縮 (compact) 對話';
}

$('#hTitle').ondblclick =() => { const s = curSession(); if (s && !S.draft) renameSession(s); };
$('#hCwd').onclick = () => reveal(S.cwd);
$('#btnTerminal').onclick = () => S.cur && api('POST', `/api/sessions/${S.cur}/terminal`).then(() => toast('已開啟 PowerShell 視窗')).catch(e => toast(e.message));
$('#btnPin').onclick = () => { const s = curSession(); if (s) patch(s.id, { pinned: !s.pinned }); };
$('#btnHide').onclick = () => { const s = curSession(); if (s) archiveSession(s); };
$('#btnDelete').onclick = () => { const s = curSession(); if (s && !S.draft) deleteSessionUI(s); };
$('#btnGallery').onclick = () => toggleViewer();

// ---------- composer controls ----------
function setSelectors(model, effort, perm) {
  const sm = $('#selModel');
  if (model && ![...sm.options].some(o => o.value === model)) sm.insertBefore(el('option', { value: model }, model), sm.lastElementChild);
  sm.value = model || '';
  $('#selEffort').value = effort || '';
  $('#selPerm').value = perm || 'auto';
}
function cfgFromSelectors() { return { model: $('#selModel').value, effort: $('#selEffort').value, permissionMode: $('#selPerm').value }; }
async function onCfgChange(key, value) {
  if (S.draft || !S.cur) { api('POST', '/api/prefs', { [key]: value }).then(d => (S.prefs = d.prefs)); return; }
  await patch(S.cur, { [key]: value });
  S.prefs[key] = value;
  if (S.running.has(S.cur)) toast('設定會從下一則訊息開始生效');
}
$('#selModel').onchange = () => {
  let v = $('#selModel').value;
  if (v === '__custom') {
    v = (prompt('輸入模型名稱 (例如 claude-opus-5-5 或 sonnet[1m])', '') || '').trim();
    setSelectors(v, $('#selEffort').value, $('#selPerm').value);
  }
  onCfgChange('model', v);
};
$('#selEffort').onchange = () => onCfgChange('effort', $('#selEffort').value);
$('#selPerm').onchange = () => onCfgChange('permissionMode', $('#selPerm').value);

const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => {
  if (cmd.open && cmdKey(e)) return;
  if (pop.open && popKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  // "//keyword" at the start of the input opens the saved-prompt picker
  const m = input.value.match(/^\/\/([^\n]*)$/);
  if (m) openPop(true, m[1]);
  else if (pop.open && pop.fromSlash) closePop();
  // "/name" (single slash, no space yet) opens the command menu
  const c = input.value.match(/^\/([^\s\/]*)$/);
  if (c) { cmd.carry = null; openCmd(c[1]); } else if (cmd.open && cmd.carry == null) closeCmd();
});
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); files.forEach(addAttachment); }
});
$('#main').addEventListener('dragover', e => { e.preventDefault(); });
$('#main').addEventListener('drop', e => {
  e.preventDefault();
  const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
  const imgs = files.filter(f => f.type.startsWith('image/'));
  imgs.forEach(addAttachment);
  if (files.length > imgs.length) toast('只支援拖放圖片；其他檔案請直接在訊息裡寫路徑');
});
$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { [...e.target.files].forEach(addAttachment); e.target.value = ''; };
function addAttachment(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const url = fr.result; const m = url.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(m[1])) { toast('只支援 PNG / JPEG / GIF / WebP'); return; }
    S.attachments.push({ mediaType: m[1], data: m[2], url, name: file.name || 'image' });
    renderAttachments();
  };
  fr.readAsDataURL(file);
}
function renderAttachments() {
  const a = $('#attachments'); a.innerHTML = '';
  S.attachments.forEach((at, i) => a.append(el('div', { class: 'att' }, el('img', { src: at.url, onclick: () => openViewer(at.url, at.name) }),
    el('button', { class: 'x', title: '移除', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }, '✕'))));
  a.hidden = !S.attachments.length;
}

// send(override): with a string, sends that text and leaves the input box and attachments alone (used by the / menu)
async function send(override) {
  const useInput = typeof override !== 'string';
  const text = useInput ? input.value.trim() : override;
  if (!text && !(useInput && S.attachments.length)) return;
  const images = useInput ? S.attachments.map(a => ({ mediaType: a.mediaType, data: a.data })) : [];
  // commands the app handles itself (/btw, /usage, /context, /clear, /model, /effort, /rename)
  const sc = !images.length && text.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  if (sc && runAppCommand(sc[1].toLowerCase(), (sc[2] || '').trim())) { if (useInput) { input.value = ''; autosize(); } closeCmd(); input.focus(); return; }
  try {
    if (S.draft) {
      if (!S.cwd) { toast('請先選擇工作資料夾'); return; }
      $('#btnSend').disabled = true;
      const d = await api('POST', '/api/sessions', { cwd: S.cwd, ...cfgFromSelectors() });
      S.draft = null; S.cur = d.id; S.cwd = d.cwd; S.msgs = []; ls('cc_last', d.id);
      renderTranscript();
      await loadSessions();
    }
    const id = S.cur;
    if (useInput) { input.value = ''; autosize(); S.attachments = []; renderAttachments(); }
    S.stick = true;
    await api('POST', `/api/sessions/${id}/send`, { text, images });
  } catch (e) { toast('送出失敗: ' + e.message, 6000); }
  finally { $('#btnSend').disabled = false; input.focus(); }
}
$('#btnSend').onclick = () => send();
$('#btnStop').onclick = () => S.cur && api('POST', `/api/sessions/${S.cur}/stop`).catch(e => toast(e.message));
function renderComposerState() {
  const run = S.cur && S.running.has(S.cur) && !S.draft;
  $('#btnStop').hidden = !run;
  $('#btnSend').textContent = run ? '排入佇列 ➤' : '送出 ➤';
  input.placeholder = run ? 'Claude 正在處理… 現在送出的訊息會在這一輪結束後接著執行' : '輸入訊息… (Enter 送出，Shift+Enter 換行，可貼上/拖放圖片)';
}

// ---------- new session (draft) ----------
function newDraft(cwd) {
  S.draft = { }; S.cur = null; S.msgs = []; S.model = ''; S.ctx = null; renderCtx();
  S.cwd = cwd || S.prefs.lastCwd || '';
  setSelectors(S.prefs.model, S.prefs.effort, S.prefs.permissionMode);
  renderSidebar(); renderHead(); renderTranscript(); renderComposerState();
  input.focus();
}
function renderDraft() {
  const recent = [];
  for (const s of S.sessions) if (s.cwd && !s.scratch && !recent.some(r => r.toLowerCase() === s.cwd.toLowerCase())) recent.push(s.cwd);
  const pathInput = el('input', { type: 'text', class: 'pathinput', value: S.cwd, placeholder: '貼上資料夾路徑，或按右邊按鈕選擇…' });
  pathInput.onchange = () => { S.cwd = pathInput.value.trim().replace(/^"|"$/g, ''); renderHead(); };
  const box = el('div', { class: 'draft' },
    el('h2', null, '開始新對話'),
    el('div', { class: 'muted' }, '選擇 Claude 要工作的資料夾，然後在下方輸入第一則訊息。'),
    el('div', { class: 'pathrow' }, pathInput,
      el('button', { class: 'btn', onclick: async () => {
        const d = await api('POST', '/api/pick-folder', { initial: S.cwd }).catch(e => (toast(e.message), {}));
        if (d.path) { S.cwd = d.path; pathInput.value = d.path; renderHead(); renderTranscript(); }
      } }, '📁 選擇資料夾…')),
    recent.length ? el('div', { class: 'recent' }, el('div', { class: 'muted small' }, '最近使用'),
      recent.slice(0, 12).map(c => el('button', { class: 'chip' + (c.toLowerCase() === (S.cwd || '').toLowerCase() ? ' on' : ''), title: c,
        onclick: () => { S.cwd = c; renderHead(); renderTranscript(); } }, el('b', null, baseName(c)), ' ', el('span', { class: 'muted' }, c)))) : null);
  T.append(box);
}

// ---------- open session ----------
async function openSession(id) {
  S.draft = null; S.cur = id; S.cwd = (curSession() || {}).cwd || ''; S.model = ''; S.ctx = null; renderCtx();
  ls('cc_last', id);
  const s = curSession();
  setSelectors(s && s.model != null ? s.model : S.prefs.model, s && s.effort != null ? s.effort : S.prefs.effort, s && s.permissionMode != null ? s.permissionMode : S.prefs.permissionMode);
  renderSidebar(); renderHead(); renderComposerState();
  T.innerHTML = ''; T.append(el('div', { class: 'loading muted' }, '載入中…'));
  S.loading = true; S.pending = []; S.showAllMsgs = false;
  let d;
  try { d = await api('GET', `/api/sessions/${id}/messages`); }
  catch (e) { if (S.cur === id) { T.innerHTML = ''; T.append(el('div', { class: 'err' }, '載入失敗: ' + e.message)); } S.loading = false; return; }
  if (S.cur !== id) return;
  S.loading = false;
  S.msgs = d.messages; if (d.cwd) S.cwd = d.cwd;
  S.ctx = d.ctx || null; renderCtx();
  S.stream = d.partial || '';
  if (d.running) S.running.set(id, { startedAt: d.startedAt, activity: d.activity });
  else S.running.delete(id);
  const pm = new Map(); for (const p of d.perms || []) pm.set(p.requestId, p); S.perms.set(id, pm);
  renderTranscript();
  // replay events that arrived while loading
  const seen = new Set(S.msgs.map(m => m.uuid));
  for (const ev of S.pending) { if (ev.type === 'msg' && seen.has(ev.msg.uuid)) continue; handleEvent(ev); }
  S.pending = [];
  renderHead(); renderComposerState();
  S.stick = true; scrollBottom(true);
  input.focus();
}

// ---------- transcript rendering ----------
let tail;
function renderTranscript() {
  T.innerHTML = ''; S.toolEls.clear(); S.images = [];
  tail = el('div', { id: 'tail' }, el('div', { id: 'stream', class: 'atext md' }), el('div', { id: 'permBox' }), el('div', { id: 'working' }));
  if (S.draft) { renderDraft(); renderSideCards(); renderStrip(); return; }
  const msgs = S.msgs, LIMIT = 300;
  const start = S.showAllMsgs ? 0 : Math.max(0, msgs.length - LIMIT);
  if (start > 0) T.append(el('button', { class: 'btn showmore', onclick: () => { S.showAllMsgs = true; renderTranscript(); } }, `顯示較早的 ${start} 則訊息`));
  T.append(tail);
  for (let i = start; i < msgs.length; i++) appendMsg(msgs[i]);
  if (!msgs.length) insert(el('div', { class: 'empty muted' }, '（沒有訊息）'));
  renderSideCards();
  renderStream(); renderPerms(); renderWorking(); renderStrip();
}
function insert(node) { T.insertBefore(node, tail); }

function appendMsg(m) {
  if (m.role === 'system') { insert(el('div', { class: 'sysline muted' }, m.text)); return; }
  if (m.role === 'user') {
    const texts = [], imgs = [];
    for (const b of m.blocks) {
      if (b.type === 'tool_result') attachResult(b);
      else if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image') imgs.push(b.src);
    }
    if (texts.length || imgs.length) {
      const bubble = el('div', { class: 'user' });
      if (imgs.length) bubble.append(el('div', { class: 'thumbs' }, imgs.map(src => thumb(src, '附加圖片'))));
      if (texts.length) bubble.append(el('div', { class: 'utext' }, texts.join('\n\n')));
      insert(bubble);
    }
    return;
  }
  for (const b of m.blocks) {
    if (b.type === 'text') {
      const d = el('div', { class: 'atext md', html: window.md(b.text) });
      decorateImgLinks(d);
      insert(d);
    } else if (b.type === 'thinking') {
      const th = el('details', { class: 'thinking' }, el('summary', null, '💭 思考過程'), el('div', { class: 'ttext' }, b.text));
      const g = openToolGroup(); // thinking between tool calls stays inside the current group
      if (g) g.list.append(th); else insert(th);
    } else if (b.type === 'tool_use') {
      const w = toolEl(b); if (w) insert(w);
    } else if (b.type === 'image') {
      insert(el('div', { class: 'thumbs' }, thumb(b.src, '圖片')));
    }
  }
}
function decorateImgLinks(container) {
  const paths = [...new Set([...container.querySelectorAll('.imglink')].map(a => a.dataset.path))];
  if (!paths.length) return;
  const row = el('div', { class: 'thumbs' });
  for (const p of paths.slice(0, 8)) row.append(thumb(fileUrl(p), p, p, true));
  container.append(row);
}
function thumb(src, label, filePath, removeOnError) {
  const img = el('img', { class: 'thumb', src, loading: 'lazy', title: label || '', alt: '' });
  img.onclick = () => openViewer(src, label, filePath);
  if (removeOnError) img.onerror = () => { img.remove(); const i = S.images.findIndex(x => x.src === src); if (i >= 0) { S.images.splice(i, 1); renderStrip(); } };
  if (!S.images.some(x => x.src === src)) S.images.push({ src, label, filePath });
  return img;
}

const TOOL_ICON = { Bash: '⌘', PowerShell: '⌘', Read: '📄', Write: '✍', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎', Grep: '🔍', Glob: '🔍', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', Agent: '🤖', TodoWrite: '☑', AskUserQuestion: '❓', ExitPlanMode: '📋' };
function toolSummary(b) {
  const i = b.input || {};
  const first = s => String(s || '').split('\n')[0].slice(0, 200);
  switch (b.name) {
    case 'Bash': case 'PowerShell': return i.description ? `${i.description}` : first(i.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return i.file_path || '';
    case 'NotebookEdit': return i.notebook_path || '';
    case 'Grep': return `${i.pattern || ''}${i.path ? '  in ' + i.path : ''}`;
    case 'Glob': return `${i.pattern || ''}${i.path ? '  in ' + i.path : ''}`;
    case 'WebFetch': return i.url || '';
    case 'WebSearch': return i.query || '';
    case 'Task': case 'Agent': return i.description || '';
    case 'TodoWrite': return `${(i.todos || []).length} 項待辦`;
    default: { const v = Object.values(i).find(v => typeof v === 'string'); return first(v); }
  }
}
function toolInputView(b) {
  const i = b.input || {};
  if ((b.name === 'Bash' || b.name === 'PowerShell') && i.command) return el('pre', { class: 'cmd' }, i.command);
  if (b.name === 'Edit' && (i.old_string != null || i.new_string != null))
    return el('div', { class: 'diff' }, el('pre', { class: 'del' }, i.old_string || ''), el('pre', { class: 'add' }, i.new_string || ''));
  if (b.name === 'Write' && i.content != null) return el('pre', { class: 'add' }, i.content);
  if (b.name === 'TodoWrite' && Array.isArray(i.todos))
    return el('ul', { class: 'todos' }, i.todos.map(t => el('li', { class: t.status }, (t.status === 'completed' ? '☑ ' : t.status === 'in_progress' ? '◐ ' : '☐ ') + (t.content || ''))));
  return el('pre', null, JSON.stringify(i, null, 2));
}
// How tool calls are shown: 'group' = consecutive calls collapse into one line (default),
// 'hide' = not shown at all (images they produce still are), 'all' = one row per call.
const TOOL_MODES = { group: '摺疊', hide: '隱藏', all: '全部' };
S.toolMode = TOOL_MODES[ls('cc_toolmode')] ? ls('cc_toolmode') : 'group';
// the tool group directly above the live tail, if nothing else has been inserted after it
function openToolGroup() {
  if (S.toolMode === 'all' || !tail) return null;
  const prev = tail.previousElementSibling;
  return prev && prev._group ? prev._group : null;
}
function newToolGroup() {
  const g = { count: 0, names: new Map(), pending: 0, errors: 0 };
  g.sum = el('summary');
  g.list = el('div', { class: 'tbody tglist' });
  g.det = el('details', { class: 'tool tgdetails' }, g.sum, g.list);
  g.thumbs = el('div', { class: 'thumbs' });
  g.el = el('div', { class: 'toolgroup' + (S.toolMode === 'hide' ? ' hidetools' : '') }, g.det, g.thumbs);
  g.el._group = g;
  insert(g.el);
  return g;
}
function renderGroup(g) {
  const single = g.count === 1;
  g.el.classList.toggle('single', single);
  if (single) g.det.open = true; else if (g.wasSingle) g.det.open = false;
  g.wasSingle = single;
  const names = [...g.names].map(([n, c]) => c > 1 ? `${toolLabel(n)} ×${c}` : toolLabel(n)).join('、');
  g.sum.className = g.pending ? '' : g.errors ? 'err' : 'ok';
  g.sum.innerHTML = '';
  g.sum.append(...[el('span', { class: 'ticon' }, '⚙'), el('span', { class: 'tname' }, `${g.count} 個工具`), el('span', { class: 'targ' }, names),
    g.errors ? el('span', { class: 'tgerr' }, `${g.errors} 個失敗`) : null, el('span', { class: 'tstat' })].filter(Boolean));
}
// mcp__Server_Name__tool_name -> tool_name (full name stays in the tooltip)
function toolLabel(n) { const m = String(n || '').match(/^mcp__.+?__(.+)$/); return m ? m[1] : n; }
function toolEl(b) {
  const sum = el('summary', null, el('span', { class: 'ticon' }, TOOL_ICON[b.name] || '⚙'), el('span', { class: 'tname', title: b.name }, toolLabel(b.name)), el('span', { class: 'targ' }, toolSummary(b)), el('span', { class: 'tstat' }));
  const res = el('div', { class: 'tres' });
  const d = el('details', { class: 'tool' }, sum, el('div', { class: 'tbody' }, toolInputView(b), res));
  const wrap = el('div', { class: 'toolwrap' }, d);
  let g = null, thumbHost = wrap;
  if (S.toolMode !== 'all') {
    g = openToolGroup() || newToolGroup();
    g.list.append(wrap); thumbHost = g.thumbs;
    g.count++; g.pending++; g.names.set(b.name, (g.names.get(b.name) || 0) + 1);
    renderGroup(g);
  }
  const fp = (b.input || {}).file_path;
  if (fp && IMG_EXT.test(fp)) thumbHost.append(...(thumbHost === wrap ? [el('div', { class: 'thumbs' }, thumb(fileUrl(fp), fp, fp, true))] : [thumb(fileUrl(fp), fp, fp, true)]));
  S.toolEls.set(b.id, { wrap, d, res, sum, g, thumbHost });
  return g ? null : wrap;
}
function attachResult(b) {
  const t = S.toolEls.get(b.toolUseId);
  const body = [];
  if (b.text) body.push(el('pre', { class: b.isError ? 'errout' : '' }, b.text));
  const imgs = b.images && b.images.length ? b.images.map(src => thumb(src, '工具結果圖片')) : [];
  if (t) {
    t.sum.classList.add(b.isError ? 'err' : 'ok');
    t.res.innerHTML = ''; t.res.append(...body);
    if (t.g) {
      if (!t.done) { t.done = true; t.g.pending = Math.max(0, t.g.pending - 1); if (b.isError) t.g.errors++; renderGroup(t.g); }
      if (imgs.length) t.g.thumbs.append(...imgs);
    } else if (imgs.length) t.wrap.append(el('div', { class: 'thumbs' }, imgs));
  } else if (body.length || imgs.length) {
    if (S.toolMode !== 'hide' && body.length)
      insert(el('details', { class: 'tool orphan' }, el('summary', { class: b.isError ? 'err' : 'ok' }, el('span', { class: 'ticon' }, '↳'), el('span', { class: 'tname' }, '工具結果')), el('div', { class: 'tbody' }, ...body)));
    if (imgs.length) insert(el('div', { class: 'thumbs' }, imgs));
  }
}
function renderToolModeBtn() {
  const b = $('#btnToolMode'); if (!b) return;
  b.textContent = '工具：' + TOOL_MODES[S.toolMode];
  b.title = '工具呼叫 (Bash、Read…) 的顯示方式，點一下切換\n摺疊：連續的工具呼叫合成一行\n隱藏：完全不顯示（圖片照樣顯示）\n全部：每個工具呼叫各一行';
}
$('#btnToolMode').onclick = () => {
  const keys = Object.keys(TOOL_MODES);
  S.toolMode = keys[(keys.indexOf(S.toolMode) + 1) % keys.length]; ls('cc_toolmode', S.toolMode);
  renderToolModeBtn();
  const st = nearBottom(), top = T.scrollTop;
  renderTranscript();
  if (st) scrollBottom(true); else T.scrollTop = top;
  toast('工具呼叫：' + TOOL_MODES[S.toolMode]);
};
renderToolModeBtn();

// live streaming text
let streamTimer = null;
function renderStream() {
  const s = $('#stream'); if (!s) return;
  s.innerHTML = S.stream ? window.md(S.stream) : '';
  s.hidden = !S.stream;
}
function scheduleStream() { if (streamTimer) return; streamTimer = setTimeout(() => { streamTimer = null; const st = nearBottom(); renderStream(); if (st) scrollBottom(true); }, 80); }

// working indicator
function renderWorking() {
  const w = $('#working'); if (!w) return;
  const r = S.cur && S.running.get(S.cur);
  if (!r || S.draft) { w.hidden = true; w.innerHTML = ''; return; }
  const secs = r.startedAt ? Math.max(0, Math.round((Date.now() - r.startedAt) / 1000)) : 0;
  const t = secs >= 60 ? `${Math.floor(secs / 60)}分${secs % 60}秒` : `${secs}秒`;
  w.hidden = false;
  w.innerHTML = '';
  w.append(el('span', { class: 'spinner' }), el('span', null, r.activity || '執行中…'), el('span', { class: 'muted' }, ' · ' + t));
}
setInterval(renderWorking, 1000);

// permission prompts
function renderPerms() {
  const box = $('#permBox'); if (!box) return;
  box.innerHTML = '';
  const pm = S.cur && S.perms.get(S.cur);
  if (!pm || !pm.size) return;
  for (const p of pm.values()) box.append(permCard(p));
}
function answer(p, body) {
  api('POST', `/api/sessions/${S.cur}/perm`, { requestId: p.requestId, ...body }).catch(e => toast(e.message));
}
function permCard(p) {
  const i = p.input || {};
  if (p.toolName === 'AskUserQuestion' && Array.isArray(i.questions)) {
    const answers = {};
    const card = el('div', { class: 'perm ask' }, el('div', { class: 'ptitle' }, '❓ Claude 想問你'));
    i.questions.forEach(q => {
      const qd = el('div', { class: 'q' }, el('div', { class: 'qh' }, q.header ? el('span', { class: 'chip' }, q.header) : null, ' ', q.question));
      const opts = el('div', { class: 'qopts' });
      const chosen = new Set();
      const other = el('input', { type: 'text', placeholder: '其他（自行輸入）', class: 'qother' });
      const sync = () => { const v = [...chosen]; if (other.value.trim()) v.push(other.value.trim()); answers[q.question] = v.join(', '); };
      (q.options || []).forEach(o => {
        const b = el('button', { class: 'btn opt', title: o.description || '' }, el('b', null, o.label), o.description ? el('div', { class: 'muted small' }, o.description) : null);
        b.onclick = () => {
          if (q.multiSelect) { chosen.has(o.label) ? chosen.delete(o.label) : chosen.add(o.label); b.classList.toggle('on'); }
          else { chosen.clear(); chosen.add(o.label); opts.querySelectorAll('.opt').forEach(x => x.classList.remove('on')); b.classList.add('on'); }
          sync();
        };
        opts.append(b);
      });
      other.oninput = sync;
      qd.append(opts, other); card.append(qd);
    });
    card.append(el('div', { class: 'pbtns' },
      el('button', { class: 'btn primary', onclick: () => {
        if (i.questions.some(q => !answers[q.question])) { toast('請回答每一個問題'); return; }
        answer(p, { allow: true, answers });
      } }, '送出回答'),
      el('button', { class: 'btn', onclick: () => answer(p, { allow: false, message: '使用者略過了這個問題' }) }, '略過')));
    return card;
  }
  if (p.toolName === 'ExitPlanMode') {
    return el('div', { class: 'perm plan' }, el('div', { class: 'ptitle' }, '📋 Claude 的計畫，確認後開始執行'),
      el('div', { class: 'md planbody', html: window.md(i.plan || '') }),
      el('div', { class: 'pbtns' },
        el('button', { class: 'btn primary', onclick: () => answer(p, { allow: true }) }, '核准並開始執行'),
        denyWithReason(p, '繼續規劃')));
  }
  const view = toolInputView({ name: p.toolName, input: i });
  const hasSug = Array.isArray(p.suggestions) && p.suggestions.length;
  return el('div', { class: 'perm' },
    el('div', { class: 'ptitle' }, '⚠ 需要你的許可：', el('b', null, p.toolName), p.description ? el('span', { class: 'muted' }, ' — ' + p.description) : null),
    view,
    el('div', { class: 'pbtns' },
      el('button', { class: 'btn primary', onclick: () => answer(p, { allow: true }) }, '允許'),
      hasSug ? el('button', { class: 'btn', title: JSON.stringify(p.suggestions), onclick: () => answer(p, { allow: true, always: true }) }, '允許，之後不再詢問') : null,
      denyWithReason(p, '拒絕')));
}
function denyWithReason(p, label) {
  const wrap = el('span', { class: 'deny' });
  const reason = el('input', { type: 'text', placeholder: '（選填）告訴 Claude 原因或改怎麼做', class: 'reason' });
  wrap.append(el('button', { class: 'btn danger', onclick: () => answer(p, { allow: false, message: reason.value.trim() }) }, label), reason);
  return wrap;
}

// ---------- events (SSE) ----------
let es;
function connect() {
  es = new EventSource('/api/events?t=' + encodeURIComponent(TOKEN));
  es.onmessage = e => { let ev; try { ev = JSON.parse(e.data); } catch { return; } handleEvent(ev); };
  es.onerror = () => { $('#app').classList.add('offline'); };
  es.onopen = () => { $('#app').classList.remove('offline'); };
}
function handleEvent(ev) {
  if (S.loading && ev.sid && ev.sid === S.cur && ['msg', 'delta', 'result', 'perm', 'permDone', 'ctx'].includes(ev.type)) { S.pending.push(ev); return; }
  const isCur = ev.sid && ev.sid === S.cur && !S.draft;
  switch (ev.type) {
    case 'hello':
      for (const r of ev.running || []) {
        S.running.set(r.sid, { startedAt: r.startedAt, activity: r.activity });
        const pm = new Map(); for (const p of r.perms || []) pm.set(p.requestId, p); S.perms.set(r.sid, pm);
      }
      if (ev.rate) renderRate(ev.rate); if (ev.auth) renderAuth(ev.auth);
      loadSessions().catch(() => {});
      if (S.helloCount++ && S.cur && !S.draft && !S.loading) openSession(S.cur); // resync after a reconnect
      break;
    case 'sessions': loadSessions().catch(() => {}); break;
    case 'status':
      if (ev.running) S.running.set(ev.sid, { startedAt: ev.startedAt, activity: '啟動中…' });
      else { S.running.delete(ev.sid); S.perms.delete(ev.sid); if (isCur) { S.stream = ''; renderStream(); renderPerms(); } }
      renderSidebar(); if (isCur) { renderComposerState(); renderWorking(); }
      break;
    case 'activity': { const r = S.running.get(ev.sid); if (r) r.activity = ev.text; if (isCur) renderWorking(); break; }
    case 'init': if (isCur) { S.model = ev.model; renderHead(); } break;
    case 'ctx': if (isCur) { S.ctx = ev.ctx; renderCtx(); } break;
    case 'msg':
      if (!isCur) break;
      { const st = nearBottom() || S.stick;
        S.msgs.push(ev.msg);
        if (ev.msg.role === 'assistant') { S.stream = ''; renderStream(); }
        T.querySelector('.empty') && T.querySelector('.empty').remove();
        appendMsg(ev.msg); renderStrip();
        if (ev.queued) insert(el('div', { class: 'sysline muted' }, '（已排入佇列，這一輪結束後送出）'));
        if (st) scrollBottom(true); }
      break;
    case 'delta':
      if (!isCur) break;
      if (ev.reset) S.stream = ''; else S.stream += ev.text || '';
      scheduleStream();
      break;
    case 'perm': {
      if (!S.perms.has(ev.sid)) S.perms.set(ev.sid, new Map());
      S.perms.get(ev.sid).set(ev.perm.requestId, ev.perm);
      renderSidebar();
      if (isCur) { renderPerms(); scrollBottom(true); }
      else notify('Claude 需要你的許可', (S.sessions.find(s => s.id === ev.sid) || {}).title || '');
      break;
    }
    case 'permDone': { const pm = S.perms.get(ev.sid); if (pm) pm.delete(ev.requestId); renderSidebar(); if (isCur) renderPerms(); break; }
    case 'result':
      if (isCur) {
        const r = ev.result || {}; S.stream = ''; renderStream();
        let node;
        if (r.stopped) node = el('div', { class: 'result muted' }, '■ 已停止');
        else if (r.isError) node = el('div', { class: 'result err' }, '✗ ' + (r.text || r.subtype || '發生錯誤'));
        else {
          const parts = ['✓ 完成'];
          if (r.durationMs) parts.push((r.durationMs / 1000).toFixed(1) + ' 秒');
          if (r.usage && r.usage.output_tokens) parts.push('輸出 ' + r.usage.output_tokens.toLocaleString() + ' tokens');
          node = el('div', { class: 'result muted' }, parts.join(' · '));
        }
        const st = nearBottom(); insert(node); if (st) scrollBottom(true);
      } else if (!(ev.result || {}).stopped) notify('Claude 完成了', (S.sessions.find(s => s.id === ev.sid) || {}).title || '');
      break;
    case 'rate': renderRate(ev.rate); break;
    case 'auth': renderAuth(ev.auth); break;
    case 'prompts': loadPrompts(); break;
  }
}
function notify(title, body) {
  if (document.hasFocus()) { toast(`${title}：${body}`); return; }
  try { if (Notification.permission === 'granted') new Notification(title, { body }); } catch {}
}
// Plan usage of the account the claude CLI is logged into (same numbers as `/usage` in an interactive claude).
// Updated whenever a message runs here, by the ↻ button, and automatically on the chosen interval
// (each refresh is one tiny Haiku request; it is skipped when a message already refreshed the numbers).
const RATE_NAMES = { five_hour: '目前工作階段（5 小時）', seven_day: '本週（全部模型）', seven_day_opus: '本週 Opus', seven_day_sonnet: '本週 Sonnet' };
function fmtWhen(ms) {
  const d = new Date(ms), now = new Date();
  const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
function renderRate(r) {
  if (r) S.rate = r;
  r = S.rate;
  const rows = $('#uRows'); rows.innerHTML = '';
  $('#uUpdated').textContent = r && r.receivedAt ? fmtWhen(r.receivedAt) + ' 更新' : '尚無資料，按 ↻';
  $('#uUpdated').title = r && r.receivedAt ? new Date(r.receivedAt).toLocaleString() : '';
  if (!r) return;
  const now = Date.now() / 1000;
  const wins = r.unifiedWindows || (r.rateLimitType ? { [r.rateLimitType]: r } : {});
  for (const [k, v] of Object.entries(wins)) {
    if (!v || v.utilization == null) continue;
    const expired = v.resetsAt && v.resetsAt <= now;
    const pct = expired ? 0 : Math.round(v.utilization * 100);
    const level = pct >= 90 ? ' hot' : pct >= 75 ? ' warm' : '';
    const reset = v.resetsAt ? (expired ? '已重置' : fmtWhen(v.resetsAt * 1000) + ' 重置') : '';
    rows.append(el('div', { class: 'urow', title: `${RATE_NAMES[k] || k}：已用 ${pct}%${reset ? '，' + reset : ''}` },
      el('div', { class: 'ulabel' }, el('span', { class: 'uname' }, RATE_NAMES[k] || k), el('span', { class: 'ureset muted' }, reset),
        el('span', { class: 'upct' + level }, pct + '%')),
      el('div', { class: 'ubar' }, el('i', { class: level.trim(), style: `width:${Math.min(100, pct)}%` }))));
  }
}
setInterval(() => renderRate(), 60000); // re-check reset times / "updated at" date

S.usageEvery = Number(ls('cc_usage_every') ?? 5); if (![0, 1, 5, 15].includes(S.usageEvery)) S.usageEvery = 5;
$('#uInterval').value = String(S.usageEvery);
$('#uInterval').onchange = () => { S.usageEvery = Number($('#uInterval').value); ls('cc_usage_every', String(S.usageEvery)); autoUsage(); };
let usageBusy = false;
async function refreshUsage(manual) {
  if (usageBusy) return; usageBusy = true;
  $('#uRefresh').classList.add('spin'); $('#uRefresh').disabled = true;
  try { const d = await api('POST', '/api/usage/refresh'); renderRate(d.rate); }
  catch (e) { if (manual) toast('無法更新用量: ' + e.message, 6000); }
  finally { usageBusy = false; $('#uRefresh').classList.remove('spin'); $('#uRefresh').disabled = false; }
}
$('#uRefresh').onclick = () => refreshUsage(true);
// auto refresh: only while the window is visible, and only when the numbers are older than the interval
function autoUsage() {
  if (!S.usageEvery || document.visibilityState !== 'visible') return;
  const age = S.rate && S.rate.receivedAt ? Date.now() - S.rate.receivedAt : Infinity;
  if (age >= S.usageEvery * 60000 - 2000) refreshUsage(false);
}
setInterval(autoUsage, 20000);
document.addEventListener('visibilitychange', autoUsage);
function renderAuth(a) {
  if (!a) return;
  S.auth = a; renderRate();
  $('#account').title = a.loggedIn ? ['claude CLI 登入帳號', a.email, a.orgName && '組織：' + a.orgName, a.planTier || a.subscriptionType].filter(Boolean).join('\n') : '';
  $('#account').textContent = a.loggedIn ? `${a.email || '已登入'}${a.subscriptionType ? ' · ' + a.subscriptionType : ''}` : '未登入';
  $('#account').classList.toggle('err', !a.loggedIn);
  $('#btnLogin').classList.toggle('primary', !a.loggedIn);
}
$('#btnLogin').onclick = () => api('POST', '/api/login').then(() => toast('已開啟登入視窗，完成後按 ↻ 重新檢查', 6000)).catch(e => toast(e.message));
$('#btnAuth').onclick = () => api('GET', '/api/auth').then(d => { renderAuth(d.auth); toast(d.auth.loggedIn ? '已登入' : '未登入'); });

// ---------- image viewer (right split) ----------
let vCur = null;
function openViewer(src, label, filePath) {
  vCur = { src, label, filePath };
  $('#viewer').hidden = false; $('#splitter').hidden = false;
  const img = $('#vImg'); img.src = src; img.hidden = false; $('#vEmpty').hidden = true;
  $('#vTitle').textContent = label || ''; $('#vTitle').title = label || '';
  $('#vReveal').hidden = !filePath;
  renderStrip();
}
function toggleViewer() {
  const v = $('#viewer');
  if (v.hidden) { v.hidden = false; $('#splitter').hidden = false; if (!vCur && S.images.length) { const l = S.images[S.images.length - 1]; openViewer(l.src, l.label, l.filePath); } renderStrip(); }
  else closeViewer();
}
function closeViewer() { $('#viewer').hidden = true; $('#splitter').hidden = true; }
function renderStrip() {
  const s = $('#vStrip'); if ($('#viewer').hidden) return;
  s.innerHTML = '';
  for (const im of S.images) {
    const t = el('img', { src: im.src, title: im.label || '', class: vCur && vCur.src === im.src ? 'on' : '' });
    t.onclick = () => openViewer(im.src, im.label, im.filePath);
    t.onerror = () => t.remove();
    s.append(t);
  }
  s.hidden = !S.images.length;
}
$('#vClose').onclick = closeViewer;
$('#vFit').onclick = () => { const b = $('#vBody'); b.classList.toggle('actual'); $('#vFit').textContent = b.classList.contains('actual') ? '原尺寸' : '適合'; };
$('#vReveal').onclick = () => {
  if (!vCur || !vCur.filePath) return;
  let p = vCur.filePath;
  if (!/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(p) && S.cwd) p = S.cwd.replace(/[\\/]$/, '') + '\\' + p;
  reveal(p);
};
(function splitter() {
  const sp = $('#splitter'), v = $('#viewer');
  const w = parseInt(ls('cc_vw') || '0', 10); if (w) v.style.width = w + 'px';
  sp.addEventListener('mousedown', e => {
    e.preventDefault(); document.body.classList.add('dragging');
    const move = ev => { const nw = Math.min(Math.max(innerWidth - ev.clientX, 240), innerWidth - 520); v.style.width = nw + 'px'; };
    const up = () => { document.body.classList.remove('dragging'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); ls('cc_vw', parseInt(v.style.width, 10)); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
})();

// clicks inside the transcript: image links, code copy
T.addEventListener('click', e => {
  const a = e.target.closest('.imglink');
  if (a) { e.preventDefault(); openViewer(fileUrl(a.dataset.path), a.dataset.path, a.dataset.path); return; }
  const c = e.target.closest('.copy');
  if (c) { const code = c.closest('.code').querySelector('code').textContent; navigator.clipboard.writeText(code); c.textContent = '已複製'; setTimeout(() => (c.textContent = '複製'), 1200); }
});

// ---------- slash commands ----------
// Commands the app handles itself. Everything else typed as /xxx is sent to claude, which runs it (skills, /compact…).
const APP_CMDS = [
  { name: 'btw', argumentHint: '<問題>', description: '順便問一個問題：用目前對話的內容回答，不會寫進對話紀錄，Claude 執行中也能問' },
  { name: 'usage', description: '顯示用量分析（不寫進對話紀錄）' },
  { name: 'context', description: '顯示這個對話目前的 context 用量（不寫進對話紀錄）' },
  { name: 'clear', description: '在同一個資料夾開新對話（目前的對話保留在左側列表）' },
  { name: 'model', argumentHint: '<fable|opus|sonnet|haiku|模型名稱>', description: '切換模型（下一則訊息生效）' },
  { name: 'effort', argumentHint: '<low|medium|high|xhigh|max>', description: '切換思考程度（下一則訊息生效）' },
  { name: 'rename', argumentHint: '<名稱>', description: '重新命名這個對話' },
];
const cmd = { open: false, q: '', idx: 0, items: [], lists: new Map(), loading: new Set() };
function cmdKeyCwd() { return (S.draft ? 'cwd:' : 'sid:') + (S.draft ? S.cwd : S.cur); }
function loadCommands() {
  const key = cmdKeyCwd();
  if (cmd.lists.has(key) || cmd.loading.has(key)) return;
  cmd.loading.add(key);
  const q = S.draft ? 'cwd=' + encodeURIComponent(S.cwd || '') : 'sid=' + S.cur;
  api('GET', '/api/commands?' + q).then(d => cmd.lists.set(key, d.commands || [])).catch(() => {})
    .finally(() => { cmd.loading.delete(key); if (cmd.open) renderCmd(); });
}
function allCommands() {
  const cli = (cmd.lists.get(cmdKeyCwd()) || []).filter(c => !APP_CMDS.some(a => a.name === c.name));
  return APP_CMDS.map(c => ({ ...c, app: true })).concat(cli);
}
function openCmd(q) {
  if (!cmd.open || cmd.q !== q) cmd.idx = 0;
  cmd.open = true; cmd.q = q;
  if (pop.open) closePop();
  $('#cmdPop').hidden = false;
  loadCommands(); renderCmd();
}
function closeCmd() { cmd.open = false; cmd.carry = null; $('#cmdPop').hidden = true; }
function renderCmd() {
  const q = cmd.q.toLowerCase(), all = allCommands();
  const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
  const rest = q ? all.filter(c => !c.name.toLowerCase().startsWith(q) && (c.name + ' ' + c.description).toLowerCase().includes(q)) : [];
  cmd.items = starts.concat(rest);
  if (cmd.idx >= cmd.items.length) cmd.idx = Math.max(0, cmd.items.length - 1);
  const loading = cmd.loading.has(cmdKeyCwd());
  $('#cmdHint').textContent = (cmd.carry != null ? '輸入框的文字會成為指令的參數 · ' : '') + (loading ? '正在向 claude 讀取可用指令…' : `${cmd.items.length} 個`);
  const list = $('#cmdList'); list.innerHTML = '';
  if (!cmd.items.length) list.append(el('div', { class: 'ppempty muted' }, loading ? '讀取中…' : `沒有符合「/${cmd.q}」的指令；直接送出的話會交給 claude 處理`));
  cmd.items.forEach((c, i) => {
    const row = el('div', { class: 'ppitem' + (i === cmd.idx ? ' on' : ''), title: c.description },
      el('span', { class: 'cmdname' }, '/' + c.name),
      c.argumentHint ? el('span', { class: 'cmdarg' }, c.argumentHint) : null,
      el('span', { class: 'pptext muted', style: 'flex:1;min-width:0' }, c.description),
      c.app ? el('span', { class: 'cmdtag', title: '由這個 App 處理' }, 'App') : null);
    row.onmousemove = () => { if (cmd.idx !== i) { cmd.idx = i; list.querySelectorAll('.ppitem').forEach((r, j) => r.classList.toggle('on', j === i)); } };
    row.onmousedown = e => e.preventDefault(); // keep focus in the input
    row.onclick = () => pickCmd(c);
    list.append(row);
  });
  const on = list.querySelector('.ppitem.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function cmdKey(e) {
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); const n = cmd.items.length; if (!n) return true;
    cmd.idx = (cmd.idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; renderCmd(); return true;
  }
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    const c = cmd.items[cmd.idx];
    if (!c) return e.key === 'Tab' ? (e.preventDefault(), true) : false; // Enter with no match: send as typed
    e.preventDefault(); pickCmd(c); return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeCmd(); return true; }
  return false;
}
// cmd.carry: text that was already in the input when the menu was opened with the / button.
// It becomes the command's argument (e.g. type a question, click /, pick btw -> "/btw <question>").
function pickCmd(c) {
  const carry = cmd.carry != null ? input.value.trim() : null; closeCmd();
  if (c.argumentHint) {
    input.value = '/' + c.name + ' ' + (carry || ''); autosize(); input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
  } else {
    if (carry == null) { input.value = ''; autosize(); }
    send('/' + c.name);
  }
}
function runAppCommand(name, arg) {
  switch (name) {
    case 'btw':
      if (S.draft || !S.cur) { toast('/btw 要在已經開始的對話裡使用'); return true; }
      if (!arg) { toast('用法：/btw 你的問題'); return true; }
      sideRun('💬 btw：' + arg, { sid: S.cur, kind: 'btw', text: arg });
      return true;
    case 'usage': case 'context':
      if (arg) return false;
      sideRun('/' + name, { sid: S.draft ? null : S.cur, cwd: S.cwd, kind: 'local', text: '/' + name });
      return true;
    case 'clear':
      newDraft(S.cwd); toast('已開新對話（原本的對話還在左側列表）'); return true;
    case 'model': {
      if (!arg) { toast('目前模型：' + ($('#selModel').value || '預設') + '。用法：/model opus'); return true; }
      setSelectors(arg, $('#selEffort').value, $('#selPerm').value); onCfgChange('model', arg);
      toast('模型改為 ' + arg + '（下一則訊息生效）'); return true;
    }
    case 'effort': {
      const v = arg.toLowerCase();
      if (!v) { toast('目前程度：' + ($('#selEffort').value || '預設') + '。用法：/effort high'); return true; }
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) { toast('程度只能是 low / medium / high / xhigh / max'); return true; }
      $('#selEffort').value = v; onCfgChange('effort', v); toast('程度改為 ' + v + '（下一則訊息生效）'); return true;
    }
    case 'rename': {
      const s = curSession(); if (!s || S.draft) { toast('對話開始後才能重新命名'); return true; }
      if (arg) patch(s.id, { title: arg }); else renameSession(s);
      return true;
    }
  }
  return false;
}

// side cards: output that is shown here but never written into the conversation (/btw, /usage, /context)
S.side = new Map(); // 'sid:<id>' or 'cwd:<path>' -> [{id, title, state, text, isError}]
function sideList(key = cmdKeyCwd()) { if (!S.side.has(key)) S.side.set(key, []); return S.side.get(key); }
function placeCard(node) { if (tail && tail.parentNode === T) insert(node); else T.append(node); }
function sideCardEl(c) {
  const body = c.state === 'run'
    ? el('div', { class: 'scbody running' }, el('span', { class: 'spinner' }), c.kind === 'btw' ? '思考中…（用對話的複本回答，不影響原本的對話）' : '執行中…')
    : el('div', { class: 'scbody md', html: window.md(c.text || (c.isError ? '發生錯誤' : '（沒有輸出）')) });
  if (c.state !== 'run') decorateImgLinks(body);
  return el('div', { class: 'sidecard' + (c.isError ? ' err' : ''), id: 'side-' + c.id },
    el('div', { class: 'schead' }, el('span', { class: 'sctitle', title: c.title }, c.title),
      el('span', { class: 'muted small' }, c.state === 'run' ? '' : (c.secs != null ? c.secs + ' 秒 · ' : '') + '不會寫進對話紀錄'),
      el('button', { class: 'btn icon small', title: '關閉', onclick: () => { const l = sideList(c.key); l.splice(l.indexOf(c), 1); document.getElementById('side-' + c.id)?.remove(); } }, '✕')),
    body);
}
function renderSideCards() { for (const c of sideList()) placeCard(sideCardEl(c)); }
function sideRun(title, req) {
  const key = cmdKeyCwd();
  const c = { id: crypto.randomUUID(), key, title, kind: req.kind, state: 'run', text: '', isError: false };
  sideList(key).push(c);
  placeCard(sideCardEl(c)); S.stick = true; scrollBottom(true);
  const t0 = Date.now();
  api('POST', '/api/side', req)
    .then(r => { c.text = r.text; c.isError = !!r.isError; })
    .catch(e => { c.text = e.message; c.isError = true; })
    .finally(() => {
      c.state = 'done'; c.secs = Math.round((Date.now() - t0) / 1000);
      const old = document.getElementById('side-' + c.id);
      if (old && key === cmdKeyCwd()) { const st = nearBottom(); old.replaceWith(sideCardEl(c)); if (st) scrollBottom(true); }
      else if (c.kind === 'btw') toast('btw 的回答好了，切回那個對話就看得到');
    });
}
$('#btnCmds').onclick = () => {
  if (cmd.open) { closeCmd(); return; }
  const v = input.value.trim();
  input.focus();
  if (!v) { input.value = '/'; openCmd(''); return; }
  const m = v.match(/^\/([^\s\/]*)$/);
  if (m) { openCmd(m[1]); return; }
  cmd.carry = v; openCmd(''); // keep the typed text; it becomes the argument of the picked command
};
document.addEventListener('mousedown', e => {
  if (cmd.open && !e.target.closest('#cmdPop') && !e.target.closest('#btnCmds') && e.target !== input) closeCmd();
});

// ---------- saved prompts (常用 Prompt) ----------
S.prompts = [];
const pop = { open: false, fromSlash: false, q: '', idx: 0, items: [] };
async function loadPrompts() { try { S.prompts = (await api('GET', '/api/prompts')).prompts || []; } catch {} if (pop.open) renderPop(); }
async function savePrompts() { try { S.prompts = (await api('POST', '/api/prompts', { prompts: S.prompts })).prompts; } catch (e) { toast('儲存失敗: ' + e.message); } }
function promptTitle(p) { return p.title || p.text.trim().split('\n')[0].slice(0, 60); }
function filteredPrompts() {
  const q = pop.q.trim().toLowerCase();
  return S.prompts.filter(p => !q || (p.title + '\n' + p.text).toLowerCase().includes(q))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.lastUsed || 0) - (a.lastUsed || 0) || (b.createdAt || 0) - (a.createdAt || 0));
}
function openPop(fromSlash, q = '') {
  const wasOpen = pop.open;
  pop.open = true; pop.fromSlash = fromSlash; pop.q = q;
  if (!wasOpen || fromSlash) pop.idx = 0;
  if (cmd.open) closeCmd();
  $('#promptPop').hidden = false;
  $('#ppSearch').hidden = fromSlash;
  if (!fromSlash) { $('#ppSearch').value = q; if (!wasOpen) setTimeout(() => $('#ppSearch').focus(), 0); }
  renderPop();
}
function closePop() { pop.open = false; $('#promptPop').hidden = true; }
function renderPop() {
  const list = $('#ppList'); list.innerHTML = '';
  pop.items = filteredPrompts();
  if (pop.idx >= pop.items.length) pop.idx = Math.max(0, pop.items.length - 1);
  if (!S.prompts.length) list.append(el('div', { class: 'ppempty muted' }, '還沒有常用 Prompt。按「＋ 新增」，或先在輸入框打好內容再按「把目前輸入存成常用」。'));
  else if (!pop.items.length) list.append(el('div', { class: 'ppempty muted' }, '沒有符合「' + pop.q + '」的 Prompt'));
  pop.items.forEach((p, i) => {
    const row = el('div', { class: 'ppitem' + (i === pop.idx ? ' on' : ''), title: p.text },
      el('div', { class: 'ppbody' }, el('div', { class: 'ppname' }, promptTitle(p)), el('div', { class: 'pptext muted' }, p.text.replace(/\s+/g, ' ').slice(0, 160))),
      el('span', { class: 'ppuses muted small', title: '使用次數' }, p.uses ? p.uses + '次' : ''),
      el('button', { class: 'btn icon small', title: '編輯', onclick: e => { e.stopPropagation(); editPrompt(p); } }, '✎'),
      el('button', { class: 'btn icon small', title: '刪除', onclick: e => { e.stopPropagation(); deletePrompt(p); } }, '🗑'));
    row.onmousemove = () => { if (pop.idx !== i) { pop.idx = i; list.querySelectorAll('.ppitem').forEach((r, j) => r.classList.toggle('on', j === i)); } };
    row.onclick = e => usePrompt(p, e.ctrlKey);
    list.append(row);
  });
  const on = list.querySelector('.ppitem.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function popKey(e) {
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = pop.items.length; if (!n) return true;
    pop.idx = (pop.idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; renderPop(); return true;
  }
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    const p = pop.items[pop.idx];
    if (!p) { e.preventDefault(); return true; }
    e.preventDefault(); usePrompt(p, e.ctrlKey); return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); closePop(); input.focus(); return true; }
  return false;
}
function usePrompt(p, sendNow) {
  if (pop.fromSlash) input.value = input.value.replace(/^\/\/[^\n]*/, '');
  const v = input.value;
  if (!v.trim()) input.value = p.text;
  else {
    const s = input.selectionStart ?? v.length, en = input.selectionEnd ?? v.length;
    input.value = v.slice(0, s) + p.text + v.slice(en);
    input.selectionStart = input.selectionEnd = s + p.text.length;
  }
  p.uses = (p.uses || 0) + 1; p.lastUsed = Date.now(); savePrompts();
  closePop(); autosize(); input.focus();
  if (sendNow) send();
}
let pmEditing = null;
function editPrompt(p, preset) {
  pmEditing = p || null;
  $('#pmHead').textContent = p ? '編輯常用 Prompt' : '新增常用 Prompt';
  $('#pmTitle').value = p ? p.title : '';
  $('#pmText').value = p ? p.text : (preset || '');
  $('#pmDelete').hidden = !p;
  $('#promptModal').hidden = false;
  setTimeout(() => (p || preset ? $('#pmTitle') : $('#pmText')).focus(), 0);
}
function closeModal() { $('#promptModal').hidden = true; if (pop.open) (pop.fromSlash ? input : $('#ppSearch')).focus(); }
async function deletePrompt(p) {
  if (!confirm(`刪除常用 Prompt「${promptTitle(p)}」？`)) return;
  S.prompts = S.prompts.filter(x => x.id !== p.id); await savePrompts(); renderPop();
}
$('#pmForm').onsubmit = async e => {
  e.preventDefault();
  const title = $('#pmTitle').value.trim(), text = $('#pmText').value;
  if (!text.trim()) { toast('內容不能是空的'); return; }
  if (pmEditing) Object.assign(pmEditing, { title, text });
  else S.prompts.push({ id: crypto.randomUUID(), title, text, uses: 0, lastUsed: 0, createdAt: Date.now() });
  await savePrompts();
  closeModal(); toast('已儲存');
  if (pop.open) renderPop();
};
$('#pmForm').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); $('#pmForm').requestSubmit(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(); }
});
$('#pmCancel').onclick = closeModal;
$('#pmDelete').onclick = async () => { if (pmEditing) { const p = pmEditing; closeModal(); await deletePrompt(p); } };
$('#promptModal').addEventListener('mousedown', e => { if (e.target.id === 'promptModal') closeModal(); });
$('#btnPrompts').onclick = e => { e.stopPropagation(); pop.open ? closePop() : openPop(false); };
$('#ppSearch').addEventListener('input', () => { pop.q = $('#ppSearch').value; pop.idx = 0; renderPop(); });
$('#ppSearch').addEventListener('keydown', e => { popKey(e); });
$('#ppNew').onclick = () => editPrompt(null);
$('#ppSaveCur').onclick = () => {
  const t = input.value.replace(/^\/\/[^\n]*/, '').trim();
  if (!t) { toast('輸入框是空的'); return; }
  editPrompt(null, t);
};
document.addEventListener('mousedown', e => {
  if (pop.open && !e.target.closest('#promptPop') && !e.target.closest('#btnPrompts') && !e.target.closest('#promptModal') && e.target !== input) closePop();
});
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === '/') { e.preventDefault(); pop.open ? closePop() : openPop(false); }
});

// ---------- misc ----------
$('#btnNew').onclick = () => newDraft();
$('#search').addEventListener('input', renderSidebar);
S.source = ['all', 'cli', 'desktop'].includes(ls('cc_source')) ? ls('cc_source') : 'all';
function renderSeg() { document.querySelectorAll('#srcSeg button').forEach(b => b.classList.toggle('on', b.dataset.src === S.source)); }
document.querySelectorAll('#srcSeg button').forEach(b => b.onclick = () => { S.source = b.dataset.src; ls('cc_source', S.source); renderSeg(); renderSidebar(); });
renderSeg();
$('#chkScratch').checked = ls('cc_scratch') === '1';
$('#chkHidden').checked = ls('cc_hidden') === '1';
$('#chkScratch').onchange = () => { ls('cc_scratch', $('#chkScratch').checked ? '1' : '0'); renderSidebar(); };
$('#chkHidden').onchange = () => { ls('cc_hidden', $('#chkHidden').checked ? '1' : '0'); renderSidebar(); };
$('#btnGroup').onclick = () => { S.prefs.groupBy = S.prefs.groupBy === 'time' ? 'folder' : 'time'; api('POST', '/api/prefs', { groupBy: S.prefs.groupBy }); renderSidebar(); toast(S.prefs.groupBy === 'time' ? '依時間分組' : '依資料夾分組'); };
document.addEventListener('keydown', e => {
  if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newDraft(); }
});
setInterval(() => { if (document.visibilityState === 'visible') renderSidebar(); }, 60000);

(async function init() {
  if (!TOKEN) { document.body.innerHTML = '<p style="padding:2em">缺少存取權杖。請用 start.vbs 啟動。</p>'; return; }
  try {
    const d = await api('GET', '/api/init');
    S.prefs = d.prefs; S.sessions = d.sessions;
    renderAuth(d.auth); renderRate(d.rate);
  } catch (e) { toast('無法連線到伺服器: ' + e.message, 10000); }
  connect();
  loadPrompts();
  try { if (Notification.permission === 'default') Notification.requestPermission(); } catch {}
  const last = ls('cc_last');
  if (last && S.sessions.some(s => s.id === last)) openSession(last); else newDraft();
  renderSidebar();
})();
