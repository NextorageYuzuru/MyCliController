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
// /btw floating side-chat window (see the bottom of this file for the logic)
let btwPop = null, btwIn = null, btwAnchor = null, btwScale = 1;
let btwPane = null;   // the pane the window is docked to (never follows focus)
let btwBusy = 0;      // how many btw answers are still streaming
// ---------- panes ----------
// The content area has one pane (L) or two side by side (L + R, 右側分割視窗). Each pane keeps its own session,
// draft, transcript and scroll position. The rendering code below works on the globals S / T / tail: the state of
// the pane being worked on is copied into them (withPane), and copied back out afterwards. The composer at the
// bottom is shared and always shows the ACTIVE pane (the one the mouse was last pressed in).
const PANE_KEYS = ['draft', 'cur', 'cwd', 'msgs', 'stream', 'toolEls', 'images', 'showAllMsgs', 'stick', 'ctx', 'model', 'loading', 'pending', 'attachments'];
const newPaneState = () => ({ draft: null, cur: null, cwd: '', msgs: [], stream: '', toolEls: new Map(), images: [], showAllMsgs: false, stick: true, ctx: null, model: '', loading: false, pending: [], attachments: [], input: '' });
let T = null, tail = null;      // transcript element and live tail of the pane currently loaded into S
let CTX = null, ACTIVE = null;  // pane currently loaded into S; pane that has the composer
const PANE = {};                // PANE.L, PANE.R (built at the bottom of this file)
function saveTo(p) { for (const k of PANE_KEYS) p.st[k] = S[k]; p.tail = tail; }
function loadPane(p) { for (const k of PANE_KEYS) S[k] = p.st[k]; T = p.T; tail = p.tail; CTX = p; }
// run fn with pane p loaded into S/T/tail, then put the previous pane back
function withPane(p, fn) {
  if (CTX === p) return fn();
  const prev = CTX;
  saveTo(prev); loadPane(p);
  try { return fn(); }
  finally { saveTo(p); loadPane(prev); }
}
// run fn with the active pane loaded (composer and viewer strip always belong to it)
const inActive = fn => withPane(ACTIVE, fn);
// a pane's state, whether or not it is the one loaded right now
const pst = p => (p === CTX ? S : p.st);
const panesOn = () => (PANE.R.el.hidden ? [PANE.L] : [PANE.L, PANE.R]);
const paneShows = (p, sid) => !pst(p).draft && pst(p).cur === sid;
const shownIds = () => new Set(panesOn().map(p => { const st = pst(p); return st.draft ? (st.draft.vid || null) : st.cur; }).filter(Boolean));
const panesShowing = sid => panesOn().filter(p => paneShows(p, sid));

// ---------- helpers ----------
// 未讀完成（藍點）：沒在畫面上的對話跑完了，直到使用者看到它為止；存在 localStorage，重新整理也還在
const UNREAD = new Set(JSON.parse(ls('cc_unread') || '[]'));
function saveUnread() { ls('cc_unread', JSON.stringify([...UNREAD])); }
function markUnread(id) { if (!UNREAD.has(id)) { UNREAD.add(id); saveUnread(); } }
// the sessions on screen count as read — but only while this window has focus
function clearShownUnread() {
  if (!document.hasFocus()) return;
  let ch = false; for (const p of panesOn()) { const id = pst(p).cur; if (id && UNREAD.delete(id)) ch = true; }
  if (ch) { saveUnread(); renderSidebar(); }
}
addEventListener('focus', clearShownUnread);
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
function nearEl(e) { return e.scrollHeight - e.scrollTop - e.clientHeight < 120; }
function nearBottom() { return nearEl(T); }
function scrollBottom(force) { if (force || S.stick) T.scrollTop = T.scrollHeight; }

// ---------- sidebar ----------
function visibleSessions() {
  const q = $('#search').value.trim().toLowerCase();
  const showScratch = S.showScratch, showHidden = S.showHidden, src = S.source, shown = shownIds();
  return S.sessions.filter(s => (showHidden || !s.hidden || shown.has(s.id)) && (showScratch || !s.scratch || shown.has(s.id)) &&
    (!S.focusKey || folderKey(s.cwd) === S.focusKey) &&
    (src === 'all' || s.source === src || shown.has(s.id)) &&
    (!q || (s.title + ' ' + s.cwd + ' ' + (s.lastPrompt || '')).toLowerCase().includes(q)));
}
function renderSidebar() {
  renderRailDot(); renderTabs();
  if (S.sbCollapsed) return;
  if (S.dnd) { S.dndPending = true; return; } // 拖曳中不重畫（會把被拖的節點換掉）；放開後再畫
  const list = $('#sessionList'); list.innerHTML = '';
  const ss = visibleSessions();
  if (S.focusKey) { // 專注模式（工作區副本）
    renderFocusSidebar(list, ss);
    const ri0 = list.querySelector('.renameIn'); if (ri0) { ri0.focus(); const n = ri0.value.length; try { ri0.setSelectionRange(n, n); } catch {} }
    return;
  }
  const pinned = ss.filter(s => s.pinned), rest = ss.filter(s => !s.pinned);
  if (pinned.length) list.append(group('pinned', '📌 釘選', null, pinned));
  if (S.prefs.groupBy === 'flat') { // plain list, newest first, with the folder name under each title
    if (rest.length) {
      const box = el('div', { class: 'group flat' });
      const max = S.flatAll ? Infinity : 60;
      rest.slice(0, max).forEach(s => box.append(item(s, true)));
      if (rest.length > max) box.append(el('div', { class: 'more muted', onclick: () => { S.flatAll = true; renderSidebar(); } }, `顯示其餘 ${rest.length - max} 個…`));
      list.append(box);
    }
  } else if (S.prefs.groupBy === 'time') {
    const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const b = [['今天', today], ['昨天', today - 864e5], ['過去 7 天', today - 7 * 864e5], ['過去 30 天', today - 30 * 864e5], ['更早', -Infinity]];
    for (let i = 0; i < b.length; i++) {
      const items = rest.filter(s => s.updatedAt >= b[i][1] && (i === 0 || s.updatedAt < b[i - 1][1]));
      if (items.length) list.append(group('t' + i, b[i][0], null, items, true));
    }
  } else {
    const groups = new Map();
    for (const s of rest) { const k = (s.cwd || '(未知)').toLowerCase(); if (!groups.has(k)) groups.set(k, { cwd: s.cwd, items: [] }); groups.get(k).items.push(s); }
    for (const [k, g] of groups) g.items = orderSessions(k, g.items);
    ensureFolderColors([...groups.keys()]);
    // 使用者自訂的「資料夾群組」：把多個資料夾合成一區（群組 > 資料夾 > 對話）
    const placed = new Set(), q = $('#search').value.trim(), units = [];
    for (const fg of folderGroups()) {
      const inner = fg.folders.filter(k => groups.has(k));
      inner.forEach(k => placed.add(k));
      if (!inner.length && q) continue;
      units.push({ key: 'g:' + fg.id, node: () => userGroup(fg, inner.map(k => [k, groups.get(k)])) });
    }
    for (const [k, g] of groups) if (!placed.has(k)) units.push({ key: 'f:' + k, node: () => group('f:' + k, baseName(g.cwd) || '(未知)', g.cwd, g.items) });
    // 最上層（群組和資料夾同一位階）照使用者拖出來的順序；沒排過的維持原本順序、排在後面
    const ord = Array.isArray(S.prefs.folderOrder) ? S.prefs.folderOrder : [];
    units.forEach((u, i) => { const o = ord.indexOf(u.key); u.rank = o >= 0 ? o : 1e6 + i; });
    units.sort((a, b) => a.rank - b.rank);
    S.topKeys = units.map(u => u.key);
    units.forEach(u => list.append(u.node()));
  }
  if (!ss.length) list.append(el('div', { class: 'empty muted' }, S.sessions.length ? '沒有符合的對話' : '還沒有對話，按「＋ 新對話」開始'));
  const ri = list.querySelector('.renameIn'); if (ri) { ri.focus(); const n = ri.value.length; try { ri.setSelectionRange(n, n); } catch {} }
}
// ---- 拖曳排序：群組／資料夾（同一位階）、群組內的資料夾（也能拖進／拖出群組）、資料夾內的對話 ----
function orderSessions(fk, items) {
  const o = (S.prefs.sessionOrder || {})[fk]; if (!o || !o.length) return items;
  const rank = new Map(o.map((id, i) => [id, i]));
  // 沒排過的（新對話）維持原本的時間順序、放最前面；排過的照使用者的順序
  return [...items.filter(s => !rank.has(s.id)), ...items.filter(s => rank.has(s.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id))];
}
function clearDropMarks() { document.querySelectorAll('.dz-before, .dz-after, .dz-into').forEach(n => n.classList.remove('dz-before', 'dz-after', 'dz-into')); }
function dndWire(node, info) {
  node.__dnd = info; node.draggable = true;
  node.addEventListener('dragstart', e => {
    e.stopPropagation(); S.dnd = info; node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', info.key || info.sid || ''); } catch {}
  });
  node.addEventListener('dragend', () => {
    S.dnd = null; node.classList.remove('dragging'); clearDropMarks();
    if (S.dndPending) { S.dndPending = false; renderSidebar(); }
  });
  node.addEventListener('dragover', e => {
    if (!S.dnd) return;
    const plan = planDrop(S.dnd, info, e, node);
    clearDropMarks();
    if (!plan) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
    (node.__block && plan.pos !== 'into' ? node.__block : node).classList.add('dz-' + plan.pos); // 分頁列：前／後的記號畫在整個區塊（群組／資料夾連同底下的分頁）的邊上
  });
  node.addEventListener('drop', e => {
    if (!S.dnd) return;
    const plan = planDrop(S.dnd, info, e, node); if (!plan) return;
    e.preventDefault(); e.stopPropagation();
    S.dnd = null; S.dndPending = false; clearDropMarks();
    execDrop(plan);
  });
}
// where on the target the pointer is: before / after (halves), or 'into' for the middle of a group header
function dropPos(e, node, allowInto) {
  const r = node.getBoundingClientRect(), horiz = !!node.closest('#tabBar'); // 分頁列是橫的：用左右判斷
  const y = horiz ? (e.clientX - r.left) / Math.max(1, r.width) : (e.clientY - r.top) / Math.max(1, r.height);
  if (allowInto) return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into';
  return y < 0.5 ? 'before' : 'after';
}
function planDrop(src, tgt, e, node) {
  if (src.type === 'wsession') { // 專注模式：工作群
    if (src.virtual) return tgt.type === 'wsession' && tgt.gid === src.gid && tgt.sid !== src.sid ? { act: 'winto', sid: src.sid, gid: src.gid, tsid: tgt.sid, pos: dropPos(e, node) } : null; // 空白卡片只能在自己的群裡換位置
    if (tgt.type === 'wsession') {
      if (tgt.sid === src.sid) return null;
      if (tgt.gid) return { act: 'winto', sid: src.sid, gid: tgt.gid, tsid: tgt.sid, pos: dropPos(e, node) };
      return { act: 'wtop', skey: 'ws:' + src.sid, tkey: 'ws:' + tgt.sid, pos: dropPos(e, node), ungroup: src.sid };
    }
    if (tgt.type === 'wgroup') {
      const pos = dropPos(e, node, true);
      if (pos === 'into') return { act: 'winto', sid: src.sid, gid: tgt.key, pos: 'into' };
      return { act: 'wtop', skey: 'ws:' + src.sid, tkey: 'wg:' + tgt.key, pos, ungroup: src.sid };
    }
    return null;
  }
  if (src.type === 'wgroup') {
    if (tgt.type === 'wgroup') return tgt.key === src.key ? null : { act: 'wtop', skey: 'wg:' + src.key, tkey: 'wg:' + tgt.key, pos: dropPos(e, node) };
    if (tgt.type === 'wsession') {
      const tkey = tgt.gid ? 'wg:' + tgt.gid : 'ws:' + tgt.sid;
      return tkey === 'wg:' + src.key ? null : { act: 'wtop', skey: 'wg:' + src.key, tkey, pos: dropPos(e, node) };
    }
    return null;
  }
  if (src.type === 'session') {
    if (tgt.type !== 'session' || tgt.fk !== src.fk || tgt.sid === src.sid) return null;
    return { act: 'sessions', fk: src.fk, sid: src.sid, tsid: tgt.sid, pos: dropPos(e, node) };
  }
  if (src.type === 'group') {
    if (tgt.type === 'session') return null;
    const tkey = tgt.type === 'group' ? 'g:' + tgt.key : tgt.gid ? 'g:' + tgt.gid : 'f:' + tgt.key; // 拖到群組裡的資料夾上 = 對該群組整體排序
    if (tkey === 'g:' + src.key) return null;
    return { act: 'top', skey: 'g:' + src.key, tkey, pos: dropPos(e, node) };
  }
  if (src.type === 'folder') {
    if (tgt.type === 'session') return null;
    if (tgt.type === 'folder') {
      if (tgt.key === src.key) return null;
      if (tgt.gid) return { act: 'intoGroup', fk: src.key, gid: tgt.gid, tfk: tgt.key, pos: dropPos(e, node) };
      return { act: 'top', skey: 'f:' + src.key, tkey: 'f:' + tgt.key, pos: dropPos(e, node), ungroup: src.key };
    }
    const pos = dropPos(e, node, true); // 拖到群組標題：中間 = 放進群組，邊緣 = 排在群組前／後（群組外）
    if (pos === 'into') return { act: 'intoGroup', fk: src.key, gid: tgt.key, pos: 'into' };
    return { act: 'top', skey: 'f:' + src.key, tkey: 'g:' + tgt.key, pos, ungroup: src.key };
  }
  return null;
}
function execDrop(p) {
  if (p.act === 'wtop' || p.act === 'winto') { // 專注模式：工作群的拖曳
    const ws = wsGet(), keys = wsKeys();
    if (p.act === 'wtop') {
      const ks = keys.filter(k => k !== p.skey);
      let i = ks.indexOf(p.tkey); if (i < 0) i = ks.length; if (p.pos === 'after') i++;
      ks.splice(i, 0, p.skey); ws.order = ks;
      if (p.ungroup) ws.groups.forEach(g => { g.sessions = g.sessions.filter(x => x !== p.ungroup); });
    } else {
      ws.groups.forEach(g => { g.sessions = g.sessions.filter(x => x !== p.sid); });
      const g = ws.groups.find(x => x.id === p.gid); if (!g) return;
      let i = p.pos === 'into' ? g.sessions.length : g.sessions.indexOf(p.tsid); if (i < 0) i = g.sessions.length; else if (p.pos === 'after') i++;
      g.sessions.splice(i, 0, p.sid); ws.order = keys.filter(k => k !== 'ws:' + p.sid);
    }
    wsSave(); return;
  }
  const body = {};
  if (p.act === 'sessions') {
    const items = orderSessions(p.fk, visibleSessions().filter(s => !s.pinned && folderKey(s.cwd) === p.fk));
    const ids = items.map(s => s.id).filter(id => id !== p.sid);
    let i = ids.indexOf(p.tsid); if (i < 0) i = ids.length; if (p.pos === 'after') i++;
    ids.splice(i, 0, p.sid);
    body.sessionOrder = { ...(S.prefs.sessionOrder || {}), [p.fk]: ids };
  } else if (p.act === 'top') {
    const keys = (S.topKeys || []).filter(k => k !== p.skey);
    let i = keys.indexOf(p.tkey); if (i < 0) i = keys.length; if (p.pos === 'after') i++;
    keys.splice(i, 0, p.skey);
    body.folderOrder = keys;
    if (p.ungroup) body.folderGroups = folderGroups().map(g => ({ ...g, folders: g.folders.filter(k => k !== p.ungroup) }));
  } else if (p.act === 'intoGroup') {
    body.folderGroups = folderGroups().map(g => {
      const fs_ = g.folders.filter(k => k !== p.fk);
      if (g.id !== p.gid) return { ...g, folders: fs_ };
      let i = p.pos === 'into' ? fs_.length : fs_.indexOf(p.tfk); if (i < 0) i = fs_.length; else if (p.pos === 'after') i++;
      fs_.splice(i, 0, p.fk); return { ...g, folders: fs_ };
    });
  }
  Object.assign(S.prefs, body); renderSidebar();
  api('POST', '/api/prefs', body).catch(e => toast('儲存排序失敗: ' + e.message));
}
// ---- 資料夾群組（類似瀏覽器的分頁群組，但單位是整個資料夾）----
const FG_COLORS = ['#4a90d9', '#e0a030', '#3fa66b', '#d9534f', '#9b59b6', '#e67e9a', '#3fb5b5', '#8a8a8a'];
const folderGroups = () => (Array.isArray(S.prefs.folderGroups) ? S.prefs.folderGroups : []);
// 每個資料夾自帶一個顏色（跟工作群同一組色盤；沒設過就依路徑自動配，固定不會變），右鍵可以換
function folderColor(key) {
  const set = (S.prefs.folderColors || {})[key]; if (set) return set;
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FG_COLORS[h % FG_COLORS.length];
}
// 還沒有顏色的資料夾：挑目前「用得最少」的顏色並記住（前 8 個一定各不相同，之後也盡量不重複；不是隨機、也不會每次重整換色）
function ensureFolderColors(keys) {
  const fc = S.prefs.folderColors || (S.prefs.folderColors = {}), use = new Map(FG_COLORS.map(c => [c, 0]));
  for (const k of Object.keys(fc)) if (use.has(fc[k])) use.set(fc[k], use.get(fc[k]) + 1);
  let changed = false;
  for (const k of keys) {
    if (fc[k]) continue;
    let best = FG_COLORS[0]; for (const c of FG_COLORS) if (use.get(c) < use.get(best)) best = c;
    fc[k] = best; use.set(best, use.get(best) + 1); changed = true;
  }
  if (changed) api('POST', '/api/prefs', { folderColors: fc }).catch(() => {});
}
function cycleFolderColor(key) {
  const i = FG_COLORS.indexOf(folderColor(key)), next = FG_COLORS[(i + 1) % FG_COLORS.length];
  S.prefs.folderColors = { ...(S.prefs.folderColors || {}), [key]: next }; renderSidebar();
  api('POST', '/api/prefs', { folderColors: S.prefs.folderColors }).catch(e => toast('儲存顏色失敗: ' + e.message));
}
const folderKey = cwd => (cwd || '(未知)').toLowerCase();
const groupOfFolder = key => folderGroups().find(g => g.folders.includes(key));
function saveFolderGroups(arr) {
  S.prefs.folderGroups = arr; renderSidebar();
  api('POST', '/api/prefs', { folderGroups: arr }).catch(e => toast('儲存群組失敗: ' + e.message));
}
function newFolderGroup(key) {
  const name = prompt('新資料夾群組的名稱', ''); if (name == null || !name.trim()) return;
  const gs = folderGroups().map(g => ({ ...g, folders: g.folders.filter(k => k !== key) }));
  gs.push({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.trim(), color: FG_COLORS[gs.length % FG_COLORS.length], folders: [key] });
  saveFolderGroups(gs);
}
function moveFolderToGroup(key, gid) { // gid = null → 移出群組
  saveFolderGroups(folderGroups().map(g => ({ ...g, folders: g.id === gid ? [...g.folders.filter(k => k !== key), key] : g.folders.filter(k => k !== key) })));
}
// ---- 專注模式：把一個資料夾做成「獨立工作區副本」----
// 進入後：只剩這個資料夾；資料夾卡片只能退出；不能開這個資料夾以外的對話；對話可以多組一層「工作群」。
// 每個資料夾各有一份自己的狀態（工作群、排序、收合、主／副捷徑卡、開著的視窗）存在伺服器，下次進入還原；退出就是原本的樣子。
try { const f = JSON.parse(ls('cc_focus') || 'null'); S.focusKey = (f && f.key) || null; S.focusCwd = (f && f.cwd) || ''; S.focusSaved = (f && f.saved) || null; } catch { S.focusKey = null; S.focusCwd = ''; S.focusSaved = null; }
function persistFocus() { ls('cc_focus', S.focusKey ? JSON.stringify({ key: S.focusKey, cwd: S.focusCwd, saved: S.focusSaved }) : ''); }
const paneSid = p => (!pst(p).draft && pst(p).cur) || null;
const paneIds = () => ({ L: paneSid(PANE.L), R: PANE.R.el.hidden ? null : paneSid(PANE.R), split: !PANE.R.el.hidden });
const sessionExists = id => !!id && S.sessions.some(s => s.id === id);
const inFocusFolder = id => { const s = S.sessions.find(x => x.id === id); return !!s && folderKey(s.cwd) === S.focusKey; };
function wsAll() { return (S.prefs.workspaces ||= {}); }
function wsGet() {
  const w = (wsAll()[S.focusKey] ||= { groups: [], order: [], collapsed: [], short: { main: null, sub: null }, panes: null });
  w.vcards ||= {}; // 虛擬空白卡片（每個工作群最多一張）
  return w;
}
function wsSave() { api('POST', '/api/prefs', { workspaces: wsAll() }).catch(e => toast('儲存專注工作區失敗: ' + e.message)); renderSidebar(); }
// 專注工作區的結構：頂層＝工作群＋沒進群的對話（同一位階，可混排）；新出現的對話放最前面、其餘照手動順序
function wsStructure() {
  const ws = wsGet(), sess = visibleSessions(), byId = new Map(sess.map(s => [s.id, s])), inGroup = new Set();
  const groups = ws.groups.map(g => { const items = g.sessions.map(id => byId.get(id) || wsVStub(ws, id)).filter(Boolean); items.forEach(s => inGroup.add(s.id)); return { g, items }; });
  const units = [...groups.map(x => ({ key: 'wg:' + x.g.id, group: x })), ...sess.filter(s => !inGroup.has(s.id)).map(s => ({ key: 'ws:' + s.id, s }))];
  units.forEach((u, i) => { const o = ws.order.indexOf(u.key); u.rank = o >= 0 ? o : -1e6 + i; });
  units.sort((a, b) => a.rank - b.rank);
  S.wsKeys = units.map(u => u.key);
  return units;
}
const wsKeys = () => { wsStructure(); return S.wsKeys.slice(); };
function wsNewGroup(sid) {
  const name = prompt('新工作群的名稱', ''); if (name == null || !name.trim()) return;
  const ws = wsGet(), all = wsKeys(); let i = all.indexOf('ws:' + sid); if (i < 0) i = 0;
  const keys = all.filter(k => k !== 'ws:' + sid);
  ws.groups.forEach(g => { g.sessions = g.sessions.filter(x => x !== sid); });
  const g = { id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name.trim(), color: FG_COLORS[ws.groups.length % FG_COLORS.length], sessions: [sid] };
  ws.groups.push(g); keys.splice(i, 0, 'wg:' + g.id); ws.order = keys; wsSave();
}
function wsMoveToGroup(sid, gid) { // gid = null → 移出群
  const ws = wsGet(), keys = wsKeys().filter(k => k !== 'ws:' + sid);
  ws.groups.forEach(g => { g.sessions = g.sessions.filter(x => x !== sid); });
  if (gid) ws.groups.find(g => g.id === gid).sessions.push(sid); else keys.unshift('ws:' + sid);
  ws.order = keys; wsSave();
}
function wsMenuItems(s) {
  const ws = wsGet(), cur = ws.groups.find(g => g.sessions.includes(s.id));
  const items = [['＋ 新增工作群…', () => wsNewGroup(s.id)]];
  for (const g of ws.groups) if (!cur || g.id !== cur.id) items.push([`➜ 移到工作群「${g.name}」`, () => wsMoveToGroup(s.id, g.id)]);
  if (cur) items.push([`✕ 從「${cur.name}」移出`, () => wsMoveToGroup(s.id, null)]);
  return items;
}
function wgroupMenu(g, x, y) {
  showMenu(x, y, [
    ['＋ 在這個工作群新增對話', () => wsAddSession(g.id)],
    ['✎ 重新命名工作群', () => { const n = prompt('工作群名稱', g.name); if (n != null && n.trim()) { g.name = n.trim(); wsSave(); } }],
    ['🎨 換顏色', () => { g.color = FG_COLORS[(FG_COLORS.indexOf(g.color) + 1) % FG_COLORS.length]; wsSave(); }],
    ['解散工作群（對話回到外面）', () => {
      const ws = wsGet(), vc = ws.vcards[g.id]; if (vc) wsDropVirtual(vc.vid, false); // 沒說過話的空白卡片直接丟掉
      const keys = wsKeys(), i = keys.indexOf('wg:' + g.id), ids = g.sessions.filter(id => !vc || id !== vc.vid);
      ws.groups = ws.groups.filter(x => x.id !== g.id);
      keys.splice(i < 0 ? 0 : i, 1, ...ids.map(id => 'ws:' + id)); ws.order = keys; wsSave();
    }, 'danger'],
  ]);
}
const wsToggle = key => { const ws = wsGet(), i = ws.collapsed.indexOf(key); if (i >= 0) ws.collapsed.splice(i, 1); else ws.collapsed.push(key); wsSave(); };
// ---- 工作群的「虛擬空白卡片」：還沒說過話的新對話，只存在工作區資料裡（不是伺服器的 session）----
// 新增時必須先取名字（沒取名字＝不建立）；取了名字就暫時保留，直到說第一句話（才登記成真正的 session，原位置替換、名字沿用）或手動刪除。
// 每個工作群同時最多一張：這張還沒說過話之前不能再新增。
const shownVids = () => new Set(panesOn().map(p => pst(p).draft && pst(p).draft.vid).filter(Boolean));
function wsVStub(ws, vid) {
  for (const [gid, vc] of Object.entries(ws.vcards)) if (vc.vid === vid) return { id: vid, virtual: true, gid, title: '', cwd: S.focusCwd, updatedAt: 0 };
  return null;
}
function dispTitle(s) {
  if (!S.focusKey) return s.title;
  const ws = wsGet();
  if (s.virtual) { const vc = ws.vcards[s.gid], g = ws.groups.find(x => x.id === s.gid); return (vc && vc.name) || ((g ? g.name : '') + '：（新對話）'); }
  return s.title;
}
function wsOpenVirtual(vid) {
  const shown = panesOn().find(p => pst(p).draft && pst(p).draft.vid === vid);
  if (shown) { setActive(shown); return; }
  if (ACTIVE !== PANE.L) setActive(PANE.L);
  withPane(PANE.L, () => { newDraft(S.focusCwd); S.draft = { vid }; });
  renderSidebar();
}
function wsAddSession(gid) {
  const ws = wsGet(), g = ws.groups.find(x => x.id === gid); if (!g) return;
  const ex = ws.vcards[gid];
  if (ex) { // 一個工作群只允許一張：已經有就跳過去
    ws.collapsed = ws.collapsed.filter(k => k !== 'wg:' + gid); wsSave();
    toast('這個工作群已經有一張還沒開始的新對話，已跳到那張'); wsOpenVirtual(ex.vid); return;
  }
  const vid = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  ws.vcards[gid] = { vid, name: null }; g.sessions.push(vid); // name 還是空的＝等著命名；命名前不算數
  ws.collapsed = ws.collapsed.filter(k => k !== 'wg:' + gid);
  wsSave(); wsOpenVirtual(vid);
  const def = g.name + '：';
  if (S.sbCollapsed) { // 橫向分頁列沒有就地輸入框：用輸入視窗（一定要取名字；取消＝放棄這張卡片）
    let t; for (;;) { t = prompt('新對話的名稱（必填；取消＝放棄）', def); if (t == null) break; t = t.trim(); if (t && t !== def) break; toast('新增對話需要先取名字'); }
    wsVRenameDone({ id: vid, gid, virtual: true }, t == null ? null : t, def, true);
  } else { // 像 Windows 新增資料夾：先進入重新命名，預設「工作群名：」，游標在後面
    S.vrCreating = vid; S.renaming = vid; S.renameText = def; S.renameInit = def; renderSidebar();
  }
}
function wsVRenameDone(s, t, init, creating, viaBlur) {
  const ws = wsGet(), vc = ws.vcards[s.gid]; S.vrCreating = null;
  if (!vc || vc.vid !== s.id) { renderSidebar(); return; }
  if (t === null) { if (creating) wsDropVirtual(s.id); else renderSidebar(); return; } // Esc：新建的直接放棄
  const before = init != null ? init : S.renameInit;
  if (t && t !== before) { vc.name = t; wsSave(); return; } // 取了名字：暫時保留
  if (creating) { // 新增時一定要改名：只按 Enter／沒改內容不算；點別處離開＝放棄，Enter＝留在輸入框提醒
    if (viaBlur) { wsDropVirtual(s.id); return; }
    toast('新增對話需要先取名字（Esc 放棄）');
    S.vrCreating = s.id; S.renaming = s.id; S.renameText = before; S.renameInit = before; renderSidebar(); return;
  }
  renderSidebar();
}
function wsDropVirtual(vid, resetPane = true) {
  const ws = wsGet();
  for (const [gid, vc] of Object.entries(ws.vcards)) if (vc.vid === vid) delete ws.vcards[gid];
  ws.groups.forEach(g => { g.sessions = g.sessions.filter(x => x !== vid); });
  ws.order = ws.order.filter(k => k !== 'ws:' + vid);
  if (resetPane) for (const p of panesOn()) if (pst(p).draft && pst(p).draft.vid === vid) withPane(p, () => newDraft(S.focusCwd));
  wsSave();
}
function wsSweepVirtual() { // 清掉「還沒取名字」的半成品卡片（命名中途退出／重整／當機留下的）；取過名字的一律保留
  if (!S.focusKey) return;
  const ws = wsGet();
  for (const vc of Object.values(ws.vcards).slice()) if (!vc.name) wsDropVirtual(vc.vid, true);
}
function wsPromote(vid, sid) { // 第一句話送出：虛擬卡片變成真正的 session（原位置替換）
  for (const ws of Object.values(wsAll())) {
    if (!ws.vcards) continue;
    for (const [gid, vc] of Object.entries(ws.vcards)) {
      if (vc.vid !== vid) continue;
      const g = ws.groups.find(x => x.id === gid);
      if (g) g.sessions = g.sessions.map(x => (x === vid ? sid : x));
      delete ws.vcards[gid];
      if (vc.name) patch(sid, { title: vc.name }); // 沿用使用者取的名字
    }
  }
  api('POST', '/api/prefs', { workspaces: wsAll() }).catch(() => {}); renderSidebar();
}
function wsSweepAllStored() { // 重開 app：每個工作區「還沒取名字」的半成品卡片清一次（當機／直接關閉時留下的）
  let ch = false;
  for (const ws of Object.values(wsAll())) {
    if (!ws.vcards) continue;
    for (const [gid, vc] of Object.entries(ws.vcards)) if (!vc.name) {
      delete ws.vcards[gid]; ch = true;
      (ws.groups || []).forEach(g => { g.sessions = g.sessions.filter(x => x !== vc.vid); });
    }
  }
  if (ch) { api('POST', '/api/prefs', { workspaces: wsAll() }).catch(() => {}); renderSidebar(); }
}
function vitem(s) { // 側欄：虛擬空白卡片
  const d = el('div', { class: 'sitem blankcard' + (shownIds().has(s.id) ? ' active' : ''), title: '還沒說過話的新對話（點一下開始；第一句話送出才會變成正式對話）' },
    el('div', { class: 'sbody' }, el('div', { class: 'stitle' }, S.renaming === s.id ? renameInput(s) : dispTitle(s))),
    el('span', { class: 'blanktag' }, '未開始'));
  d.onclick = () => { if (S.renaming === s.id) return; wsOpenVirtual(s.id); };
  d.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, vMenuItems(s)); };
  if (S.renaming !== s.id) dndWire(d, { type: 'wsession', sid: s.id, gid: s.gid, virtual: true });
  return d;
}
function vMenuItems(s) { // 虛擬卡片的右鍵：只有改名和刪除
  return [
    ['✎ 重新命名', () => {
      if (S.sbCollapsed) { const t = prompt('卡片名稱', dispTitle(s)); if (t != null) wsVRenameDone(s, t.trim(), dispTitle(s), false); return; }
      S.renaming = s.id; S.renameText = dispTitle(s); S.renameInit = dispTitle(s); renderSidebar();
    }],
    ['🗑 刪除這張空白卡片', () => wsDropVirtual(s.id), 'danger'],
  ];
}
function enterFocus(cwd) {
  if (S.focusKey) return;
  S.focusSaved = paneIds();                      // 進入前開著的視窗，退出時還原
  S.focusKey = folderKey(cwd); S.focusCwd = cwd; persistFocus();
  const ws = wsGet(), want = ws.panes || {};
  wsSweepVirtual(true); // 上次當機留下的、沒命名的空白卡片
  renderSidebar();
  // 還原這個工作區上次的視窗；沒有就沿用已經在這個資料夾裡的；其餘一律不能留在畫面上
  const L = want.L && inFocusFolder(want.L) ? want.L : (S.focusSaved.L && inFocusFolder(S.focusSaved.L) ? S.focusSaved.L : null);
  let R = want.split && want.R && inFocusFolder(want.R) ? want.R : (S.focusSaved.R && inFocusFolder(S.focusSaved.R) ? S.focusSaved.R : null);
  if (R === L) R = null;
  if (L) { if (!paneShows(PANE.L, L)) openSession(L, PANE.L); }
  else if (!(pst(PANE.L).draft && folderKey(pst(PANE.L).cwd) === S.focusKey)) withPane(PANE.L, () => newDraft(cwd));
  if (R) { if (!paneShows(PANE.R, R) || PANE.R.el.hidden) openRight(R); }
  else if (!PANE.R.el.hidden) closeRight();
  setActive(PANE.L);
}
function exitFocus() {
  if (!S.focusKey) return;
  wsSweepVirtual(true); // 退出時若還有「還沒取名字」的半成品卡片就清掉（取過名字的會保留）
  wsGet().panes = paneIds();                      // 記住這個工作區的視窗，下次進入還原
  const saved = S.focusSaved;
  api('POST', '/api/prefs', { workspaces: wsAll() }).catch(() => {});
  S.focusKey = null; S.focusCwd = ''; S.focusSaved = null; persistFocus();
  renderSidebar();
  if (saved) { // 還原進入前的視窗
    if (sessionExists(saved.L) && !paneShows(PANE.L, saved.L)) openSession(saved.L, PANE.L);
    if (saved.split && sessionExists(saved.R)) openRight(saved.R); else if (!saved.split && !PANE.R.el.hidden) closeRight();
    setActive(PANE.L);
  }
}
function focusBar() {
  const name = baseName(S.focusCwd) || '(未知)';
  return el('div', { class: 'focusBar', title: S.focusCwd },
    el('span', { class: 'ft' }, '🎯 專注模式：' + name),
    el('button', { class: 'btn small', title: '在這個資料夾開新對話', onclick: () => newDraft(S.focusCwd) }, '＋'),
    el('button', { class: 'btn small', title: '退出專注模式（回到原本的列表）', onclick: () => exitFocus() }, '退出'));
}
// 專注中，左側列表的內容
function renderFocusSidebar(list, ss) {
  list.append(focusBar());
  const head = el('div', { class: 'ghead fhx', title: S.focusCwd + '\n專注模式：資料夾卡片只能退出（右鍵）' },
    el('span', { class: 'glabel' }, baseName(S.focusCwd) || '(未知)'), el('span', { class: 'gcount muted' }, ss.length));
  head.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, [['⮌ 退出專注模式', () => exitFocus()]]); };
  list.append(head);
  const body = el('div', { class: 'fxbody' }), ws = wsGet();
  const wsItem = (s, gid) => { if (s.virtual) return vitem(s); const n = item(s, false); if (S.renaming !== s.id) dndWire(n, { type: 'wsession', sid: s.id, gid: gid || null }); return n; };
  for (const u of wsStructure()) {
    if (u.s) { body.append(wsItem(u.s, null)); continue; }
    const g = u.group.g, key = 'wg:' + g.id, collapsed = ws.collapsed.includes(key), color = g.color || '#8a8a8a';
    // 工作群的畫法＝跟「依資料夾」的資料夾區塊一樣：┌─ 名稱 (N)＋群組自己顏色的括弧，被點到的對話前面用同色的「>」
    const box = el('div', { class: 'group gbracket' + (collapsed ? ' collapsed' : ''), style: '--bk:' + color });
    const gh = el('div', { class: 'ghead', title: '右鍵：新增對話／重新命名／換顏色／解散工作群' },
      el('span', { class: 'glabel' }, g.name),
      el('span', { class: 'gn' }, '(' + u.group.items.filter(x => !x.virtual).length + ')')); // 空白卡片不計入數量
    gh.onclick = () => wsToggle(key);
    gh.oncontextmenu = e => { e.preventDefault(); wgroupMenu(g, e.clientX, e.clientY); };
    dndWire(gh, { type: 'wgroup', key: g.id });
    box.append(gh);
    if (!collapsed) u.group.items.forEach(s => box.append(wsItem(s, g.id)));
    body.append(box);
  }
  if (!ss.length) body.append(el('div', { class: 'empty muted' }, '這個資料夾目前沒有（符合條件的）對話，可以按上面的 ＋ 開新對話'));
  list.append(body);
}
function folderMenu(cwd, x, y) {
  const key = folderKey(cwd), cur = groupOfFolder(key);
  if (S.focusKey) { showMenu(x, y, [['⮌ 退出專注模式', () => exitFocus()]]); return; } // 專注中：資料夾卡片只能退出
  const items = [];
  if (cwd) items.push(['🎯 進入專注模式（只看這個資料夾）', () => enterFocus(cwd)]);
  if (cwd && !cur) items.push(['🎨 換資料夾顏色', () => cycleFolderColor(key)]);
  items.push(['＋ 新增資料夾群組…', () => newFolderGroup(key)]);
  for (const g of folderGroups()) if (!cur || g.id !== cur.id) items.push([`➜ 移到群組「${g.name}」`, () => moveFolderToGroup(key, g.id)]);
  if (cur) items.push([`✕ 從「${cur.name}」移出`, () => moveFolderToGroup(key, null)]);
  if (cwd) items.push(['📂 開啟資料夾', () => reveal(cwd)]);
  showMenu(x, y, items);
}
function groupMenu(fg, x, y) {
  showMenu(x, y, [
    ['✎ 重新命名群組', () => { const n = prompt('群組名稱', fg.name); if (n != null && n.trim()) saveFolderGroups(folderGroups().map(g => g.id === fg.id ? { ...g, name: n.trim() } : g)); }],
    ['🎨 換顏色', () => { const i = FG_COLORS.indexOf(fg.color); saveFolderGroups(folderGroups().map(g => g.id === fg.id ? { ...g, color: FG_COLORS[(i + 1) % FG_COLORS.length] } : g)); }],
    ['解散群組（資料夾回到外面）', () => saveFolderGroups(folderGroups().filter(g => g.id !== fg.id)), 'danger'],
  ]);
}
// 群組名稱塗滿顏色底（像瀏覽器的分頁群組標籤）：依底色亮度選黑／白字
function fgInk(hex) {
  const n = parseInt(String(hex).slice(1), 16); if (isNaN(n)) return '#fff';
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 160 ? '#1f1e1c' : '#fff';
}
function userGroup(fg, folders) {
  const key = 'g:' + fg.id, collapsed = S.collapsed.has(key);
  const total = folders.reduce((n, [, f]) => n + f.items.length, 0);
  const box = el('div', { class: 'fgroup' + (collapsed ? ' collapsed' : ''), style: '--fg:' + (fg.color || '#8a8a8a') });
  const head = el('div', { class: 'ghead fghead', title: '右鍵：重新命名／換顏色／解散群組' },
    el('span', { class: 'caret' }, collapsed ? '▸' : '▾'),
    el('span', { class: 'glabel' }, el('span', { class: 'fgname', style: 'background:' + (fg.color || '#8a8a8a') + ';color:' + fgInk(fg.color || '#8a8a8a') }, fg.name)),
    el('span', { class: 'gcount muted' }, folders.length + ' 個資料夾 · ' + total));
  head.onclick = () => { collapsed ? S.collapsed.delete(key) : S.collapsed.add(key); ls('cc_collapsed', JSON.stringify([...S.collapsed])); renderSidebar(); };
  head.oncontextmenu = e => { e.preventDefault(); groupMenu(fg, e.clientX, e.clientY); };
  dndWire(head, { type: 'group', key: fg.id });
  box.append(head);
  if (!collapsed) {
    const body = el('div', { class: 'fgbody' });
    for (const [k, g] of folders) body.append(group('f:' + k, baseName(g.cwd) || '(未知)', g.cwd, g.items, false, fg.id));
    if (!folders.length) body.append(el('div', { class: 'more muted' }, '（空的：在資料夾卡片上右鍵 → 移到群組）'));
    box.append(body);
  }
  return box;
}
function group(key, label, cwd, items, showFolder, gid) {
  const collapsed = S.collapsed.has(key);
  // 「依資料夾」排列下、沒進資料夾群組的資料夾：整塊（標題＋底下的對話）用 ┌ 括弧括起來，括弧／「>」用這個資料夾自己的顏色
  const br = !!(cwd && !gid);
  const g = el('div', { class: 'group' + (collapsed ? ' collapsed' : '') + (br ? ' gbracket' : ''), style: br ? '--bk:' + folderColor(folderKey(cwd)) : null });
  const head = el('div', { class: 'ghead', title: cwd || '' },
    ...(br ? [el('span', { class: 'glabel' }, label), el('span', { class: 'gn' }, '(' + items.length + ')')] // 括弧樣式：不要展開三角形，名稱後面直接 (N)
           : [el('span', { class: 'caret' }, collapsed ? '▸' : '▾'), el('span', { class: 'glabel' }, label), el('span', { class: 'gcount muted' }, items.length)]));
  if (cwd) head.append(el('button', { class: 'gadd', title: '在此資料夾開新對話', onclick: e => { e.stopPropagation(); newDraft(cwd); } }, '＋'));
  head.onclick = () => { collapsed ? S.collapsed.delete(key) : S.collapsed.add(key); ls('cc_collapsed', JSON.stringify([...S.collapsed])); renderSidebar(); };
  if (cwd) head.oncontextmenu = e => { e.preventDefault(); folderMenu(cwd, e.clientX, e.clientY); }; // 資料夾卡片右鍵：資料夾群組
  if (cwd) dndWire(head, { type: 'folder', key: folderKey(cwd), gid: gid || null });
  g.append(head);
  if (!collapsed) {
    const max = S.expandedGroups && S.expandedGroups.has(key) ? Infinity : 15;
    items.slice(0, max).forEach(s => {
      const n = item(s, showFolder);
      if (cwd && S.renaming !== s.id) dndWire(n, { type: 'session', sid: s.id, fk: folderKey(cwd) });
      g.append(n);
    });
    if (items.length > max) g.append(el('div', { class: 'more muted', onclick: () => { (S.expandedGroups ||= new Set()).add(key); renderSidebar(); } }, `顯示其餘 ${items.length - max} 個…`));
  }
  return g;
}
function item(s, showFolder) {
  const run = S.running.has(s.id), wait = S.perms.get(s.id) && S.perms.get(s.id).size;
  const d = el('div', { class: 'sitem' + (shownIds().has(s.id) ? ' active' : '') + (s.hidden ? ' ishidden' : ''), title: `${s.title}\n${s.cwd}` },
    el('div', { class: 'sbody' }, el('div', { class: 'stitle' }, S.source === 'all' && s.source === 'desktop' ? el('span', { class: 'srctag', title: '桌面版開的對話' }, '桌面') : null,
        S.renaming === s.id ? renameInput(s) : dispTitle(s)),
      showFolder ? el('div', { class: 'sfolder muted' }, baseName(s.cwd)) : null),
    el('span', { class: 'stime muted' }, relTime(s.updatedAt)),
    // 右側狀態點（全部統一在右邊）：黃 = 有問題等你回答、橘閃 = 執行中、藍 = 跑完了還沒看（空位固定保留，標題不會頂到邊）
    el('span', { class: 'sflag' + (wait ? ' wait' : run ? ' run' : UNREAD.has(s.id) ? ' unread' : ''),
      title: wait ? 'Claude 正在等你回答' : run ? '執行中' : UNREAD.has(s.id) ? '已完成，尚未查看' : '' }));
  // 點一下開啟；對已經是目前焦點的卡片再點一次（連點也一樣）→ 就地改名。右鍵選單的「重新命名」照舊
  d.onclick = () => { if (S.renaming === s.id) return; if (!S.draft && paneShows(ACTIVE, s.id)) startRename(s); else openHere(s.id); };
  d.oncontextmenu = e => { e.preventDefault(); sessionMenu(s, e.clientX, e.clientY); };
  return d;
}
function startRename(s) {
  S.renaming = s.id; S.renameText = dispTitle(s); renderSidebar();
  const i = document.querySelector('#sessionList .renameIn'); if (i) { i.focus(); i.select(); }
}
function renameInput(s) {
  let done = false;
  const finish = (ok, viaBlur) => {
    if (done) return; done = true;
    const t = i.value.trim(); S.renaming = null;
    if (s.virtual) { const creating = S.vrCreating === s.id; wsVRenameDone(s, ok ? t : null, null, creating, viaBlur); return; }
    if (ok && t !== dispTitle(s)) patch(s.id, { title: t }); else renderSidebar();
  };
  const i = el('input', { class: 'renameIn', type: 'text', value: S.renameText != null ? S.renameText : dispTitle(s), maxlength: '200', spellcheck: 'false' });
  i.oninput = () => { S.renameText = i.value; };
  i.onclick = e => e.stopPropagation();
  i.ondblclick = e => e.stopPropagation();
  i.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
  i.onblur = () => finish(true, true);
  return i;
}
// click in the list: if the other pane already shows it, go there; otherwise open it in the active pane
function openHere(id) { openMain(id); } // 左鍵點對話＝在主視窗預覽（已在某格顯示就跳過去）；要真的說話才會變成最新主視窗
function sessionMenu(s, x, y) {
  const inR = paneShows(PANE.R, s.id) && !PANE.R.el.hidden;
  showMenu(x, y, [
    ...(S.focusKey ? wsMenuItems(s) : []),
    ['✎ 重新命名', () => renameSession(s)],
    [inR ? '✕ 取消右側分割' : '⫽ 放到右側分割視窗', () => (inR ? closeRight() : openRight(s.id))],
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
  patch(s.id, { hidden: !s.hidden }).then(() => toast(s.hidden ? '已取消封存' : '已封存（⚙ 設定 → 顯示已封存對話，可以再看到）'));
}
// 刪除 = the transcript (+ its folder) goes to the Windows Recycle Bin, so it can still be restored from there
async function deleteSessionUI(s) {
  if (S.running.has(s.id)) { toast('這個對話正在執行，請先按停止再刪除'); return; }
  const warn = s.source === 'desktop' ? '\n\n⚠ 這是桌面版開的對話。刪除後，桌面版裡的這個對話也會打不開。' : '';
  if (!confirm(`刪除對話「${s.title}」？\n\n對話紀錄會移到 Windows 資源回收筒，需要的話還可以從那裡還原。${warn}`)) return;
  try { await api('DELETE', `/api/sessions/${s.id}`); }
  catch (e) { toast('刪除失敗: ' + e.message, 6000); return; }
  for (const p of panesOn()) if (paneShows(p, s.id)) withPane(p, () => newDraft(s.cwd));
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
function renameSession(s) { const t = prompt('對話名稱', dispTitle(s)); if (t != null) patch(s.id, { title: t.trim() }); }
function reveal(p) { if (p) api('POST', '/api/reveal', { path: p }).catch(e => toast(e.message)); }
async function loadSessions() {
  const d = await api('GET', '/api/sessions');
  S.sessions = d.sessions;
  for (const s of S.sessions) if (s.running && !S.running.has(s.id)) S.running.set(s.id, { startedAt: Date.now(), activity: '' });
  renderSidebar(); renderHeads();
}

// ---------- header (one per pane) ----------
function renderHeads() { for (const p of panesOn()) withPane(p, renderHead); }
function renderHead() {
  const s = curSession(), h = CTX.hdr, draft = !!S.draft;
  h.title.textContent = draft ? '新對話' : s ? dispTitle(s) : '';
  h.cwd.textContent = S.cwd ? S.cwd : '';
  h.cwd.hidden = !S.cwd;
  h.model.textContent = S.model ? '· ' + S.model : '';
  // 視窗最上面那條（Windows 標題列／工作列）永遠顯示軟體名稱，不跟著切換對話變動（頁面 <title> 固定）
}
// context length: how much of the model's context window this session currently fills
function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}
function renderCtx() { inActive(renderCtxActive); }
function renderCtxActive() {
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

// ---------- composer controls (shared; they always belong to the active pane) ----------
const PERM_MODES = ['auto', 'bypassPermissions'];
function setSelectors(model, effort, perm) {
  const sm = $('#selModel');
  if (model && ![...sm.options].some(o => o.value === model)) sm.insertBefore(el('option', { value: model }, model), sm.lastElementChild);
  sm.value = model || '';
  $('#selEffort').value = effort || '';
  $('#selPerm').value = PERM_MODES.includes(perm) ? perm : 'auto'; // older modes (每次詢問 etc.) now run as Auto
}
// the selectors show the active pane's session settings (or the defaults for a new conversation)
function syncSelectors() {
  inActive(() => {
    const s = S.draft ? null : curSession();
    setSelectors(s && s.model != null ? s.model : S.prefs.model, s && s.effort != null ? s.effort : S.prefs.effort, s && s.permissionMode != null ? s.permissionMode : S.prefs.permissionMode);
  });
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
  const fr = new FileReader(), p = ACTIVE;
  fr.onload = () => {
    const url = fr.result; const m = url.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(m[1])) { toast('只支援 PNG / JPEG / GIF / WebP'); return; }
    withPane(p, () => { S.attachments.push({ mediaType: m[1], data: m[2], url, name: file.name || 'image' }); renderAttachments(); });
  };
  fr.readAsDataURL(file);
}
function renderAttachments() {
  inActive(() => {
    const a = $('#attachments'); a.innerHTML = '';
    S.attachments.forEach((at, i) => a.append(el('div', { class: 'att' }, el('img', { src: at.url, onclick: () => openViewer(at.url, at.name) }),
      el('button', { class: 'x', title: '移除', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }, '✕'))));
    a.hidden = !S.attachments.length;
  });
}
// empty the composer of pane p (its text and attachments); p may be the active pane or not
function clearComposerOf(p) {
  if (p === ACTIVE) { input.value = ''; autosize(); } else p.st.input = '';
  withPane(p, () => { S.attachments = []; renderAttachments(); });
}

// send(override): with a string, sends that text and leaves the input box and attachments alone (used by the / menu)
async function send(override) {
  const useInput = typeof override !== 'string';
  const p = ACTIVE; // the pane this message belongs to, even if the user clicks another pane while it is sent
  const text = useInput ? input.value.trim() : override;
  if (!text && !(useInput && S.attachments.length)) return;
  const atts = useInput ? S.attachments.slice() : [];
  const images = atts.map(a => ({ mediaType: a.mediaType, data: a.data }));
  // commands the app handles itself (/btw, /usage, /context, /clear, /model, /effort, /rename)
  const sc = !images.length && text.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  if (sc && runAppCommand(sc[1].toLowerCase(), (sc[2] || '').trim())) { if (useInput) { input.value = ''; autosize(); } closeCmd(); input.focus(); return; }
  try {
    if (S.draft) {
      if (!S.cwd) { toast('請先選擇工作資料夾'); return; }
      if (S.focusKey && folderKey(S.cwd) !== S.focusKey) { toast('專注模式中只能在這個資料夾作業（要換資料夾請先退出專注模式）'); return; }
      $('#btnSend').disabled = true;
      const vid = pst(p).draft && pst(p).draft.vid; // 這是從工作群的虛擬空白卡片開出來的草稿
      const d = await api('POST', '/api/sessions', { cwd: S.cwd, ...cfgFromSelectors() });
      withPane(p, () => { S.draft = null; S.cur = d.id; S.cwd = d.cwd; S.msgs = []; renderTranscript(); });
      if (vid) wsPromote(vid, d.id);
      ls('cc_last', d.id);
      await loadSessions();
    }
    const id = pst(p).cur;
    commitShortcut(p, id); // 真的說話了：這格的「最新主／副視窗」捷徑換成這個對話
    if (S.running.has(id)) { // Claude is busy: park it in the queue (like the Desktop app); 插話 sends it in now
      enqueue(id, text, atts);
      if (useInput) clearComposerOf(p);
      return;
    }
    if (useInput) clearComposerOf(p);
    withPane(p, () => { S.stick = true; });
    await api('POST', `/api/sessions/${id}/send`, { text, images });
  } catch (e) { toast('送出失敗: ' + e.message, 6000); }
  finally { $('#btnSend').disabled = false; input.focus(); }
}
$('#btnSend').onclick = () => send();
$('#btnStop').onclick = () => S.cur && api('POST', `/api/sessions/${S.cur}/stop`).catch(e => toast(e.message));
function renderComposerState() {
  inActive(() => {
    const run = S.cur && S.running.has(S.cur) && !S.draft;
    $('#btnStop').hidden = !run;
    $('#btnSend').textContent = '送出 ➤';
    $('#btnSend').title = run ? 'Claude 執行中：送出的訊息會先排隊，這一輪結束後自動送出（排隊中的訊息可以按「插話」馬上送進去）' : '送出 (Enter)';
    input.placeholder = run ? 'Claude 正在處理… 現在送出會先排隊，這一輪結束後自動送出' : '輸入訊息… (Enter 送出，Shift+Enter 換行，可貼上/拖放圖片)';
    renderQueue();
  });
}
// everything the composer shows for the active pane
function refreshComposer() { inActive(() => { syncSelectors(); renderCtxActive(); renderAttachments(); renderComposerState(); }); }

// ---------- message queue ----------
// While Claude works, sent messages wait here (per session) and go out by themselves when the turn ends.
// Each one can be sent in right away (插話 — claude picks it up after its current step), edited, or cancelled.
S.queue = new Map(); // sid -> [{ id, text, atts: [{mediaType, data, url, name}] }]
S.stoppedRuns = new Set(); // sessions whose last turn ended by ■ 停止 (their queue is kept, not auto-sent)
const qOf = sid => S.queue.get(sid) || [];
function enqueue(sid, text, atts) {
  S.queue.set(sid, qOf(sid).concat({ id: crypto.randomUUID(), text, atts }));
  renderQueue();
}
function dequeue(sid, qid) {
  const list = qOf(sid), it = list.find(x => x.id === qid);
  S.queue.set(sid, list.filter(x => x.id !== qid));
  renderQueue();
  return it;
}
function postQueued(sid, it) {
  panesShowing(sid).forEach(p => withPane(p, () => { S.stick = true; }));
  return api('POST', `/api/sessions/${sid}/send`, { text: it.text, images: it.atts.map(a => ({ mediaType: a.mediaType, data: a.data })) })
    .catch(e => { toast('送出失敗: ' + e.message, 6000); S.queue.set(sid, [it].concat(qOf(sid))); renderQueue(); });
}
function injectQueued(sid, qid) { const it = dequeue(sid, qid); if (it) postQueued(sid, it); }
function editQueued(sid, qid) {
  const it = dequeue(sid, qid); if (!it) return;
  input.value = it.text + (input.value.trim() ? '\n' + input.value : '');
  inActive(() => { S.attachments = it.atts.concat(S.attachments); renderAttachments(); });
  autosize(); input.focus(); input.selectionStart = input.selectionEnd = it.text.length;
}
// turn finished: send everything that waited (the first starts a new run, the rest are taken into that same run)
async function flushQueue(sid) {
  const list = qOf(sid); if (!list.length) return;
  S.queue.set(sid, []); renderQueue();
  for (const it of list) await postQueued(sid, it);
}
function renderQueue() { inActive(renderQueueActive); }
function renderQueueActive() {
  const box = $('#queueBox'), list = S.draft ? [] : qOf(S.cur);
  box.innerHTML = ''; box.hidden = !list.length;
  if (!list.length) return;
  const running = S.running.has(S.cur);
  box.append(el('div', { class: 'qhead muted small' }, `排隊中 ${list.length} 則 · ` + (running ? 'Claude 這一輪結束後會自動送出；滑鼠移上去可以插話、編輯或取消' : '目前沒有在執行，按「送出」或「插話」送出')));
  for (const it of list) {
    const sid = S.cur;
    box.append(el('div', { class: 'qitem' },
      el('div', { class: 'qtext', title: it.text }, it.text || '（只有圖片）', it.atts.length ? el('span', { class: 'muted small' }, `  🖼×${it.atts.length}`) : null),
      el('div', { class: 'qbtns' },
        el('button', { class: 'btn small primary', title: '馬上送給 Claude：它做完目前這一步就會看到，並在這一輪一起處理', onclick: () => injectQueued(sid, it.id) }, running ? '插話 ➤' : '送出 ➤'),
        el('button', { class: 'btn small', title: '拿回輸入框修改（會從排隊中移除）', onclick: () => editQueued(sid, it.id) }, '編輯'),
        el('button', { class: 'btn icon small', title: '取消這則訊息', onclick: () => dequeue(sid, it.id) }, '✕'))));
  }
}

// ---------- new session (draft) ----------
// new conversation in the pane that is loaded (the active one, unless called through withPane)
function newDraft(cwd) {
  S.draft = { }; S.cur = null; S.msgs = []; S.model = ''; S.ctx = null;
  S.cwd = S.focusKey ? S.focusCwd : (cwd || S.prefs.lastCwd || ''); // 專注模式：新對話一律開在這個資料夾
  renderSidebar(); renderHead(); renderTranscript(); refreshComposer();
  if (CTX === ACTIVE) input.focus();
}
function renderDraft() {
  const recent = [];
  for (const s of S.sessions) if (s.cwd && !s.scratch && !recent.some(r => r.toLowerCase() === s.cwd.toLowerCase())) recent.push(s.cwd);
  const pathInput = el('input', { type: 'text', class: 'pathinput', value: S.cwd, placeholder: '貼上資料夾路徑，或按右邊按鈕選擇…' });
  const p = CTX; // this pane's draft; onchange fires on blur, which can happen after the user pressed another pane
  pathInput.onchange = () => withPane(p, () => { S.cwd = pathInput.value.trim().replace(/^"|"$/g, ''); renderHead(); });
  const box = el('div', { class: 'draft' },
    el('h2', null, '開始新對話'),
    el('div', { class: 'muted' }, '選擇 Claude 要工作的資料夾，然後在下方輸入第一則訊息。'),
    el('div', { class: 'pathrow' }, pathInput,
      el('button', { class: 'btn', onclick: async () => {
        const d = await api('POST', '/api/pick-folder', { initial: S.cwd }).catch(e => (toast(e.message), {}));
        if (d.path) withPane(p, () => { S.cwd = d.path; pathInput.value = d.path; renderHead(); renderTranscript(); });
      } }, '📁 選擇資料夾…')),
    recent.length ? el('div', { class: 'recent' }, el('div', { class: 'muted small' }, '最近使用'),
      recent.slice(0, 12).map(c => el('button', { class: 'chip' + (c.toLowerCase() === (S.cwd || '').toLowerCase() ? ' on' : ''), title: c,
        onclick: () => { S.cwd = c; renderHead(); renderTranscript(); } }, el('b', null, baseName(c)), ' ', el('span', { class: 'muted' }, c)))) : null);
  T.append(box);
}

// ---------- open session ----------
// open a session in pane p (default: the active pane)
async function openSession(id, p = ACTIVE) {

  if (S.focusKey && !inFocusFolder(id)) { toast('專注模式中只能開啟這個資料夾的對話（要看別的請先退出專注模式）'); return; }
  withPane(p, () => {
    S.draft = null; S.cur = id; S.cwd = (curSession() || {}).cwd || ''; S.model = ''; S.ctx = null;
    if (p === ACTIVE) ls('cc_last', id);
    if (UNREAD.delete(id)) saveUnread();
    renderCtx(); renderSidebar(); renderHead(); refreshComposer();
    T.innerHTML = ''; T.append(el('div', { class: 'loading muted' }, '載入中…'));
    S.loading = true; S.pending = []; S.showAllMsgs = false;
  });
  let d;
  try { d = await api('GET', `/api/sessions/${id}/messages`); }
  catch (e) {
    withPane(p, () => { if (S.cur === id) { T.innerHTML = ''; T.append(el('div', { class: 'err' }, '載入失敗: ' + e.message)); } S.loading = false; });
    return;
  }
  withPane(p, () => {
    if (S.cur !== id) return; // the pane was switched to something else while loading
    S.loading = false;
    S.msgs = d.messages; if (d.cwd) S.cwd = d.cwd;
    S.ctx = d.ctx || null; renderCtx();
    S.stream = d.partial || '';
    if (d.running) S.running.set(id, { startedAt: d.startedAt, activity: d.activity });
    else S.running.delete(id);
    const pm = new Map(); for (const x of d.perms || []) pm.set(x.requestId, x); S.perms.set(id, pm);
    renderTranscript();
    // replay events that arrived while loading
    const seen = new Set(S.msgs.map(m => m.uuid));
    const pending = S.pending; S.pending = [];
    for (const ev of pending) { if (ev.type === 'msg' && seen.has(ev.msg.uuid)) continue; handleEvent(ev); }
    renderHead(); refreshComposer();
    S.stick = true; scrollBottom(true);
    if (btwPop && !btwPop.hidden) btwRepos(); // 對話在同一个面板被换掉：让小视窗重新对应新的 session
    if (p === ACTIVE) input.focus();
  });
}

// ---------- transcript rendering ----------
function renderTranscript() {
  T.innerHTML = ''; S.toolEls.clear(); S.images = [];
  tail = el('div', { class: 'tail' }, el('div', { class: 'atext md stream' }), el('div', { class: 'permBox' }), el('div', { class: 'working' }));
  if (S.draft) { renderDraft(); renderSideCards(); renderStrip(); return; }
  const msgs = S.msgs, LIMIT = 300;
  const start = S.showAllMsgs ? 0 : Math.max(0, msgs.length - LIMIT);
  if (start > 0) T.append(el('button', { class: 'btn showmore', onclick: () => { S.showAllMsgs = true; renderTranscript(); } }, `顯示較早的 ${start} 則訊息`));
  T.append(tail);
  for (let i = start; i < msgs.length; i++) appendMsg(msgs[i]);
  if (!msgs.length) insert(el('div', { class: 'empty muted' }, '（沒有訊息）'));
  appendLastDoneLine();
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
// changed from ⚙ 設定 → 對話 → 工具呼叫
function setToolMode(v) {
  if (!TOOL_MODES[v] || S.toolMode === v) return;
  S.toolMode = v; ls('cc_toolmode', v);
  for (const p of panesOn()) withPane(p, () => {
    const st = nearBottom(), top = T.scrollTop;
    renderTranscript();
    if (st) scrollBottom(true); else T.scrollTop = top;
  });
}

// live streaming text
let streamTimer = null;
function renderStream() {
  const s = tail && tail.querySelector('.stream'); if (!s) return;
  s.innerHTML = S.stream ? window.md(S.stream) : '';
  s.hidden = !S.stream;
}
// one timer for all panes: every pane that is streaming text gets redrawn
function scheduleStream() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    for (const p of panesOn()) if (pst(p).stream) withPane(p, () => { const st = nearBottom(); renderStream(); if (st) scrollBottom(true); });
  }, 80);
}

// working indicator (each pane has its own)
setInterval(() => { for (const p of panesOn()) withPane(p, renderWorking); refreshRtimes(); }, 1000);
function renderWorking() {
  const w = tail && tail.querySelector('.working'); if (!w) return;
  const r = S.cur && S.running.get(S.cur);
  if (!r || S.draft) { w.hidden = true; w.innerHTML = ''; return; }
  const secs = r.startedAt ? Math.max(0, Math.round((Date.now() - r.startedAt) / 1000)) : 0;
  const t = secs >= 60 ? `${Math.floor(secs / 60)}分${secs % 60}秒` : `${secs}秒`;
  w.hidden = false;
  w.innerHTML = '';
  w.append(el('span', { class: 'spinner' }), el('span', null, r.activity || '執行中…'), el('span', { class: 'muted' }, ' · ' + t));
}

// ---------- completion time ("AI 多久以前回覆完成") ----------
// Shown at the end of a finished reply, never while it is still running. Relative text ("3 分鐘前") that the
// 1-second interval above keeps fresh; hovering gives the exact clock time.
function agoText(ts) {
  const t = Date.parse(ts); if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return '剛剛';
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  const d = Math.round(s / 86400);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-TW') + ' 完成';
}
function timeSpan(ts) {
  const t = Date.parse(ts);
  return el('span', { class: 'rtime', 'data-ts': ts || '', title: t ? '完成於 ' + new Date(t).toLocaleString('zh-TW', { hour12: false }) : '' }, agoText(ts));
}
function refreshRtimes() {
  for (const e of document.querySelectorAll('.rtime')) {
    const ts = e.getAttribute('data-ts'); if (!ts) continue;
    const txt = agoText(ts); if (e.textContent !== txt) e.textContent = txt;
  }
}
// when a saved transcript is shown, the ephemeral "✓ 完成" line is gone; leave one faint line under the last
// reply so it is still clear when the conversation last got an answer (nothing while the AI is still replying)
function appendLastDoneLine() {
  if (S.draft || !S.msgs.length) return;
  if (S.cur && S.running.get(S.cur)) return;
  for (let i = S.msgs.length - 1; i >= 0; i--) {
    const m = S.msgs[i];
    if (m.role === 'assistant') { insert(el('div', { class: 'result muted' }, timeSpan(m.ts))); return; }
    if (m.role === 'user') return; // nothing after the last prompt yet
  }
}

// permission prompts
function renderPerms() {
  const box = tail && tail.querySelector('.permBox'); if (!box) return;
  box.innerHTML = '';
  const pm = S.cur && S.perms.get(S.cur);
  if (!pm || !pm.size) return;
  for (const p of pm.values()) box.append(permCard({ ...p, sid: S.cur }));
}
// answer a permission prompt of session sid (the card can be in either pane, so the session id is passed along)
function answer(p, body) {
  api('POST', `/api/sessions/${p.sid}/perm`, { requestId: p.requestId, ...body }).catch(e => toast(e.message));
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
// session events go to every pane showing that session (usually one, sometimes none); the rest is global
function handleEvent(ev) {
  const shown = ev.sid ? panesShowing(ev.sid) : [];
  const inShown = fn => shown.forEach(p => withPane(p, fn));
  const visibleHere = shown.includes(ACTIVE); // the session is on screen in the active pane
  // while a pane is still loading its transcript, hold back events for it and replay them afterwards
  if (ev.sid && ['msg', 'delta', 'result', 'perm', 'permDone', 'ctx'].includes(ev.type)) {
    const loading = shown.find(p => pst(p).loading);
    if (loading) { pst(loading).pending.push(ev); return; }
  }
  switch (ev.type) {
    case 'hello': // (re)connected — possibly to a newly started server
      checkVersion(ev.version || null);
      for (const r of ev.running || []) {
        S.running.set(r.sid, { startedAt: r.startedAt, activity: r.activity });
        const pm = new Map(); for (const p of r.perms || []) pm.set(p.requestId, p); S.perms.set(r.sid, pm);
      }
      if (ev.rate) renderRate(ev.rate); if (ev.auth) renderAuth(ev.auth);
      loadSessions().catch(() => {});
      if (S.helloCount++) for (const p of panesOn()) { const st = pst(p); if (st.cur && !st.draft && !st.loading) openSession(st.cur, p); } // resync after a reconnect
      break;
    case 'sessions': loadSessions().catch(() => {}); break;
    case 'status':
      if (ev.running) S.running.set(ev.sid, { startedAt: ev.startedAt, activity: '啟動中…' });
      else {
        S.running.delete(ev.sid); S.perms.delete(ev.sid);
        inShown(() => { S.stream = ''; renderStream(); renderPerms(); });
        // turn over: send what queued up — unless the user pressed ■ 停止, then keep it for them to decide
        if (S.stoppedRuns.delete(ev.sid)) { if (qOf(ev.sid).length) toast('已停止；排隊中的訊息保留著，可以按「送出」或編輯'); }
        else flushQueue(ev.sid);
      }
      renderSidebar(); inShown(() => { renderComposerState(); renderWorking(); });
      break;
    case 'activity': { const r = S.running.get(ev.sid); if (r) r.activity = ev.text; inShown(renderWorking); break; }
    case 'init': inShown(() => { S.model = ev.model; renderHead(); }); break;
    case 'ctx': inShown(() => { S.ctx = ev.ctx; renderCtx(); }); break;
    case 'msg':
      inShown(() => {
        const st = nearBottom() || S.stick;
        S.msgs.push(ev.msg);
        if (ev.msg.role === 'assistant') { S.stream = ''; renderStream(); }
        T.querySelector('.empty') && T.querySelector('.empty').remove();
        appendMsg(ev.msg); renderStrip();
        if (ev.injected) insert(el('div', { class: 'sysline muted injnote', 'data-uuid': ev.msg.uuid }, '↳ 插話：Claude 會在目前這一步完成後看到'));
        else if (ev.queued) insert(el('div', { class: 'sysline muted injnote' }, '↳ 已排入佇列，這一輪結束後送出（伺服器是舊版，重開 App 後才能直接插話）'));
        if (st) scrollBottom(true);
      });
      break;
    case 'consumed': // claude took in a message that was sent while it was working
      inShown(() => { const n = T.querySelector(`.injnote[data-uuid="${ev.uuid}"]`); if (n) { n.textContent = '✓ Claude 已收到這則插話'; n.classList.add('ok'); } });
      break;
    case 'delta':
      inShown(() => { if (ev.reset) S.stream = ''; else S.stream += ev.text || ''; });
      scheduleStream();
      break;
    case 'perm': {
      if (!S.perms.has(ev.sid)) S.perms.set(ev.sid, new Map());
      S.perms.get(ev.sid).set(ev.perm.requestId, ev.perm);
      renderSidebar();
      inShown(() => { renderPerms(); scrollBottom(true); });
      if (!visibleHere) notify('Claude 需要你的許可', (S.sessions.find(s => s.id === ev.sid) || {}).title || '');
      break;
    }
    case 'permDone': { const pm = S.perms.get(ev.sid); if (pm) pm.delete(ev.requestId); renderSidebar(); inShown(renderPerms); break; }
    case 'result':
      if ((ev.result || {}).stopped) S.stoppedRuns.add(ev.sid);
      inShown(() => {
        const r = ev.result || {}; S.stream = ''; renderStream();
        const doneTs = new Date(ev.ts || Date.now()).toISOString();
        let left, cls = 'result muted';
        if (r.stopped) left = '■ 已停止';
        else if (r.isError) { left = '✗ ' + (r.text || r.subtype || '發生錯誤'); cls = 'result err'; }
        else {
          const parts = ['✓ 完成'];
          if (r.durationMs) parts.push((r.durationMs / 1000).toFixed(1) + ' 秒');
          if (r.usage && r.usage.output_tokens) parts.push('輸出 ' + r.usage.output_tokens.toLocaleString() + ' tokens');
          left = parts.join(' · ');
        }
        const node = el('div', { class: cls }, el('span', { class: 'rt' }, left), timeSpan(doneTs));
        const st = nearBottom(); insert(node); if (st) scrollBottom(true);
      });
      if (!(ev.result || {}).stopped && (!shown.length || !document.hasFocus())) { markUnread(ev.sid); renderSidebar(); }
      if (!visibleHere && !(ev.result || {}).stopped) notify('Claude 完成了', (S.sessions.find(s => s.id === ev.sid) || {}).title || '');
      break;
    case 'rate': renderRate(ev.rate); break;
    case 'auth': renderAuth(ev.auth); break;
    case 'prompts': loadPrompts(); break;
    case 'notice': // e.g. a message that will go out once the previous claude process has exited
      toast(ev.text, 6000);
      inShown(() => insert(el('div', { class: 'sysline muted' }, ev.text)));
      break;
  }
}
function notify(title, body) {
  if (document.hasFocus()) { toast(`${title}：${body}`); return; }
  try { if (Notification.permission === 'granted') new Notification(title, { body }); } catch {}
}
// Plan usage of the account the claude CLI is logged into (same numbers as `/usage` in an interactive claude).
// Updated whenever a message runs here, by the ↻ button, and automatically on the chosen interval
// (each refresh is one tiny Haiku request; it is skipped when a message already refreshed the numbers).
const RATE_NAMES = { five_hour: '目前工作階段', seven_day: '本週', seven_day_opus: '本週 Opus', seven_day_sonnet: '本週 Sonnet' };
function fmtWhen(ms) {
  const d = new Date(ms), now = new Date();
  const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
function renderRate(r) {
  if (r) S.rate = r;
  r = S.rate;
  renderRailGauges();
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
    // one line: 目前工作階段（4小時11分後重置） 13:50 …… 50%
    const left = v.resetsAt ? (expired ? '（已重置）' : `（${fmtLeft(v.resetsAt - now).replace(/ /g, '')}後重置）`) : '';
    const at = v.resetsAt && !expired ? fmtWhen(v.resetsAt * 1000) : '';
    rows.append(el('div', { class: 'urow', title: `${RATE_NAMES[k] || k}：已用 ${pct}%${at ? `\n${at} 重置，還有 ${fmtLeft(v.resetsAt - now)}` : ''}` },
      el('div', { class: 'ulabel' }, el('span', { class: 'uname' }, (RATE_NAMES[k] || k) + left),
        el('span', { class: 'ureset muted' }, at), el('span', { class: 'upct' + level }, pct + '%')),
      el('div', { class: 'ubar' }, el('i', { class: level.trim(), style: `width:${Math.min(100, pct)}%` }))));
  }
}
// time left until a reset, e.g. "2 天 5 小時", "3 小時 12 分", "8 分"
function fmtLeft(sec) {
  const m = Math.max(1, Math.ceil(sec / 60)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d} 天 ${h} 小時`;
  if (h) return `${h} 小時 ${mm} 分`;
  return `${mm} 分`;
}
setInterval(() => renderRate(), 30000); // keep the countdown / "updated at" current

// Usage numbers arrive for free with every reply while a conversation runs here. The only other way to refresh
// them is the ↻ button, which sends one tiny Haiku request (claude learns the numbers only from an API response).
let usageBusy = false;
async function refreshUsage() {
  if (usageBusy) return; usageBusy = true;
  $('#uRefresh').classList.add('spin'); $('#uRefresh').disabled = true;
  try { const d = await api('POST', '/api/usage/refresh'); renderRate(d.rate); }
  catch (e) { toast('無法更新用量: ' + e.message, 6000); }
  finally { usageBusy = false; $('#uRefresh').classList.remove('spin'); $('#uRefresh').disabled = false; }
}
$('#uRefresh').onclick = () => refreshUsage();
try { localStorage.removeItem('cc_usage_every'); } catch {} // the old auto-refresh setting is gone
// The account lives in ⚙ 設定 → 帳號與用量; the sidebar only shows an alert when the CLI is not logged in.
function renderAuth(a) {
  if (!a) return;
  S.auth = a; renderRate();
  $('#authAlert').hidden = !!a.loggedIn;
  if (!$('#settingsModal').hidden) renderSettings();
}
function doLogin() { api('POST', '/api/login').then(() => toast('已開啟登入視窗，登入完成後這裡會自動更新', 6000)).catch(e => toast(e.message)); }
function recheckAuth() { return api('GET', '/api/auth').then(d => { renderAuth(d.auth); toast(d.auth.loggedIn ? '已登入' : '未登入'); }); }
$('#btnLoginAlert').onclick = doLogin;

// ---------- image viewer (right split) ----------
let vCur = null;
const isSplit = () => !PANE.R.el.hidden;
function openViewer(src, label, filePath) {
  vCur = { src, label, filePath };
  // 分割模式：太擠，不開右側面板，改成在「自己那一格」裡跳出小視窗（跟 /btw 互斥）
  if (isSplit()) { closeViewer(); ipShow(ACTIVE); lbFill(); return; }
  if (ipPop && !ipPop.hidden) ipPop.hidden = true;
  $('#viewer').hidden = false; $('#splitter').hidden = false;
  const img = $('#vImg'); img.src = src; img.hidden = false; $('#vEmpty').hidden = true;
  $('#vTitle').textContent = label || ''; $('#vTitle').title = label || '';
  $('#vReveal').hidden = !filePath;
  renderStrip(); lbFill();
}
function closeViewer() { $('#viewer').hidden = true; $('#splitter').hidden = true; }
// the strip lists the images of the active pane's conversation
function renderStrip() {
  ipStrip();
  inActive(() => {
    const s = $('#vStrip'); if ($('#viewer').hidden) return;
    s.innerHTML = '';
    for (const im of S.images) {
      const t = el('img', { src: im.src, title: im.label || '', class: vCur && vCur.src === im.src ? 'on' : '' });
      t.onclick = () => openViewer(im.src, im.label, im.filePath);
      t.onerror = () => t.remove();
      s.append(t);
    }
    s.hidden = !S.images.length;
  });
}
$('#vClose').onclick = closeViewer;
$('#vZoom').onclick = () => lbOpen();

// ---- 分割模式的圖片小視窗 + 放大燈箱 ----
let ipPop = null, ipPane = null;
function ipEnsure() {
  if (ipPop) return ipPop;
  ipPop = el('div', { class: 'btw ipop', hidden: true },
    el('div', { class: 'vhead' },
      el('span', { class: 'vtitle', id: 'ipTitle' }),
      el('button', { class: 'btn small', id: 'ipFit', title: '切換 適合視窗 / 原始尺寸' }, '適合'),
      el('button', { class: 'btn small', id: 'ipReveal', title: '在檔案總管顯示' }, '📂'),
      el('button', { class: 'btn small', id: 'ipZoom', title: '放大（燈箱）' }, '⤢'),
      el('button', { class: 'btn icon small', id: 'ipClose', title: '關閉 (Esc)' }, '✕')),
    el('div', { class: 'ipbody', id: 'ipBody' }, el('img', { id: 'ipImg', alt: '' })),
    el('div', { class: 'ipstrip', id: 'ipStrip' }));
  document.body.append(ipPop);
  $('#ipClose').onclick = closeImgPop;
  $('#ipZoom').onclick = () => lbOpen();
  $('#ipFit').onclick = () => { const b = $('#ipBody'); b.classList.toggle('actual'); $('#ipFit').textContent = b.classList.contains('actual') ? '原尺寸' : '適合'; };
  $('#ipReveal').onclick = () => $('#vReveal').onclick();
  return ipPop;
}
function ipRepos() {
  if (!ipPop || ipPop.hidden) return;
  if (!ipPane || ipPane.el.hidden) { closeImgPop(); return; }
  const T = ipPane.T, cs = getComputedStyle(T);
  if (ipPop.parentElement !== ipPane.el) ipPane.el.append(ipPop);
  const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
  ipPop.style.left = pl + 'px';
  ipPop.style.top = Math.round(T.offsetTop + pt + 4) + 'px';
  ipPop.style.width = Math.round(Math.min(T.clientWidth - pl * 2, 860)) + 'px';
  ipPop.style.height = Math.round(T.clientHeight * 0.62) + 'px';
}
function ipShow(p) {
  ipEnsure();
  if (btwPop && !btwPop.hidden) btwHide();   // 看圖 UI 和 /btw 互斥：開一個就關另一個
  ipPane = p; ipPop.hidden = false; ipRepos(); ipFill();
}
function ipFill() {
  if (!ipPop || ipPop.hidden || !vCur) return;
  const img = $('#ipImg'); if (img.getAttribute('src') !== vCur.src) img.src = vCur.src;
  $('#ipTitle').textContent = vCur.label || ''; $('#ipTitle').title = vCur.label || '';
  $('#ipReveal').hidden = !vCur.filePath;
  ipStrip();
}
function ipStrip() {
  if (!ipPop || ipPop.hidden || !ipPane) return;
  const s = $('#ipStrip'); s.innerHTML = '';
  const list = pst(ipPane).images || [];
  for (const im of list) {
    const t = el('img', { src: im.src, title: im.label || '', class: vCur && vCur.src === im.src ? 'on' : '' });
    t.onclick = () => openViewer(im.src, im.label, im.filePath);
    t.onerror = () => t.remove();
    s.append(t);
  }
  s.hidden = !list.length;
}
function closeImgPop() { if (ipPop) ipPop.hidden = true; }
addEventListener('resize', () => ipRepos());

let lbEl = null;
function lbList() { const p = ipPop && !ipPop.hidden && ipPane ? ipPane : ACTIVE; return pst(p).images || []; }
function lbOpen() {
  if (!vCur) return;
  if (!lbEl) {
    lbEl = el('div', { class: 'lb', hidden: true },
      el('img', { alt: '' }), el('div', { class: 'lbcap' }),
      el('button', { class: 'lbbtn lbclose', title: '關閉 (Esc)' }, '✕'),
      el('button', { class: 'lbbtn lbprev', title: '上一張 (←)' }, '‹'),
      el('button', { class: 'lbbtn lbnext', title: '下一張 (→)' }, '›'));
    document.body.append(lbEl);
    lbEl.addEventListener('click', e => { if (e.target === lbEl || e.target.classList.contains('lbclose')) lbClose(); });
    lbEl.querySelector('.lbprev').onclick = () => lbStep(-1);
    lbEl.querySelector('.lbnext').onclick = () => lbStep(1);
  }
  lbEl.hidden = false; lbFill();
}
function lbClose() { if (lbEl) lbEl.hidden = true; }
function lbFill() {
  if (!lbEl || lbEl.hidden || !vCur) return;
  lbEl.querySelector('img').src = vCur.src; lbEl.querySelector('.lbcap').textContent = vCur.label || '';
  const multi = lbList().length > 1;
  lbEl.querySelector('.lbprev').hidden = !multi; lbEl.querySelector('.lbnext').hidden = !multi;
}
function lbStep(d) {
  const L = lbList(), i = L.findIndex(x => vCur && x.src === vCur.src);
  if (i < 0 || L.length < 2) return;
  const n = L[(i + d + L.length) % L.length]; openViewer(n.src, n.label, n.filePath);
}
// 燈箱開著時 Esc／←／→ 優先給它
addEventListener('keydown', e => {
  if (lbEl && !lbEl.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); lbClose(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); lbStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); lbStep(1); }
  } else if (e.key === 'Escape' && ipPop && !ipPop.hidden && !e.defaultPrevented && document.activeElement !== input) closeImgPop();
}, true);
// 分割 ⇄ 單欄切換時，看圖 UI 跟著換形態（面板 ⇄ 小視窗）
function syncViewerMode() {
  if (!vCur) return;
  if (isSplit()) { if (!$('#viewer').hidden) { closeViewer(); ipShow(ACTIVE); } }
  else if (ipPop && !ipPop.hidden) { const c = vCur; closeImgPop(); openViewer(c.src, c.label, c.filePath); }
}
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

// clicks inside a transcript (every pane has one, see buildPane): image links, code copy
function onTranscriptClick(e) {
  const a = e.target.closest('.imglink');
  if (a) { e.preventDefault(); openViewer(fileUrl(a.dataset.path), a.dataset.path, a.dataset.path); return; }
  const c = e.target.closest('.copy');
  if (c) { const code = c.closest('.code').querySelector('code').textContent; navigator.clipboard.writeText(code); c.textContent = '已複製'; setTimeout(() => (c.textContent = '複製'), 1200); }
}

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
      // 客服式小視窗：送出 /btw 的瞬間跳出、答案不再插進對話。延後一拍再開，避開 send() 結束時對輸入框的 focus
      setTimeout(() => { btwShow(); if (arg) runBtw(arg); }, 0);
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

// inline side cards: output shown here but never written into the conversation (/usage, /context). /btw 改用浮動小視窗
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
  const p = CTX, key = cmdKeyCwd();
  const c = { id: crypto.randomUUID(), key, title, kind: req.kind, state: 'run', text: '', isError: false };
  sideList(key).push(c);
  placeCard(sideCardEl(c)); S.stick = true; scrollBottom(true);
  const t0 = Date.now();
  api('POST', '/api/side', req)
    .then(r => { c.text = r.text; c.isError = !!r.isError; })
    .catch(e => { c.text = e.message; c.isError = true; })
    .finally(() => withPane(p, () => {
      c.state = 'done'; c.secs = Math.round((Date.now() - t0) / 1000);
      const old = document.getElementById('side-' + c.id);
      if (old && key === cmdKeyCwd()) { const st = nearBottom(); old.replaceWith(sideCardEl(c)); if (st) scrollBottom(true); }
      else if (c.kind === 'btw') toast('btw 的回答好了，切回那個對話就看得到');
    }));
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
$('#btnNewRail').onclick = () => newDraft();
// 整頁縮進去：收起左側列表，右側（對話區）就多出整個寬度；收起時 » 上的小點代表還有黃／藍點的對話
function applySidebar(collapsed, init) {
  S.sbCollapsed = collapsed; if (!init) ls('cc_sbcollapsed', collapsed ? '1' : '0');
  $('#app').classList.toggle('sbcollapsed', collapsed); $('#sbRail').hidden = !collapsed;
  if (init) return; // 載入階段 PANE 等還沒建好，不能在這裡渲染；之後的啟動流程會 renderSidebar
  renderRailDot(); renderTabs(); btwRepos();
  if (!collapsed) renderSidebar();
}
// ---- 微縮 UI：用量小儀表 + 頂端分頁列 ----
S.tabsOn = ls('cc_tabs') === '1';
// ---- 寬頁模式的頂端分頁列 ----
// 結構＝左側列表（群組 > 資料夾 > 對話：收合狀態、排序都共用），最前面是兩張「捷徑」虛擬卡片：
//  · 主：最近一次「真的在主視窗說話」的對話　· 副：最近一次「真的在副視窗說話」的對話
// 左鍵點任何對話只是在主視窗「預覽」，不會變捷徑；要真的送出訊息才算（commitShortcut），直到被下一個取代。
let SHORT = { main: null, sub: null };
try { SHORT = Object.assign(SHORT, JSON.parse(ls('cc_sc') || '{}')); } catch {}
const shortObj = () => (S.focusKey ? wsGet().short : SHORT); // 專注模式有自己的一份主／副捷徑
function saveShort() { if (S.focusKey) api('POST', '/api/prefs', { workspaces: wsAll() }).catch(() => {}); else ls('cc_sc', JSON.stringify(SHORT)); }
function commitShortcut(p, id) {
  const k = p.key === 'R' ? 'sub' : 'main';
  const sh = shortObj();
  if (!id || sh[k] === id) return;
  sh[k] = id; saveShort(); renderTabs();
}
// 預覽：已經在某一格顯示就跳過去，否則一律開在主視窗（左）
function openMain(id) {
  const shown = panesOn().find(p => paneShows(p, id));
  if (shown) { setActive(shown); return; }
  if (ACTIVE !== PANE.L) setActive(PANE.L);
  openSession(id, PANE.L);
}
function openSub(id) {
  const shown = panesOn().find(p => paneShows(p, id));
  if (shown) { setActive(shown); return; }
  openRight(id);
}
// 左側列表同款的結構資料（群組／資料夾的順序、群組成員、資料夾內對話的手動排序）
function tabStructure() {
  let vis = S.sessions.filter(s => (S.showHidden || !s.hidden) && (S.showScratch || !s.scratch) && (S.source === 'all' || s.source === S.source));
  if (S.focusKey) vis = vis.filter(s => folderKey(s.cwd) === S.focusKey); // 專注模式
  const pinned = S.focusKey ? [] : vis.filter(s => s.pinned), rest = S.focusKey ? vis : vis.filter(s => !s.pinned);
  const groups = new Map();
  for (const s of rest) { const k = folderKey(s.cwd); if (!groups.has(k)) groups.set(k, { cwd: s.cwd, items: [] }); groups.get(k).items.push(s); }
  for (const [k, g] of groups) g.items = orderSessions(k, g.items);
  ensureFolderColors([...groups.keys()]);
  const units = [], placed = new Set();
  for (const fg of S.focusKey ? [] : folderGroups()) {
    const inner = fg.folders.filter(k => groups.has(k)); inner.forEach(k => placed.add(k));
    units.push({ key: 'g:' + fg.id, fg, folders: inner.map(k => [k, groups.get(k)]) });
  }
  for (const [k, g] of groups) if (!placed.has(k)) units.push({ key: 'f:' + k, folder: [k, g] });
  const ord = Array.isArray(S.prefs.folderOrder) ? S.prefs.folderOrder : [];
  units.forEach((u, i) => { const o = ord.indexOf(u.key); u.rank = o >= 0 ? o : 1e6 + i; });
  units.sort((a, b) => a.rank - b.rank);
  S.topKeys = units.map(u => u.key);
  return { pinned, units };
}
function renderTabs() {
  const bar = $('#tabBar'); if (!bar) return;
  bar.hidden = !(S.sbCollapsed && S.tabsOn);
  $('#btnTabs').classList.toggle('on', S.tabsOn);
  if (bar.hidden) return;
  if (S.dnd) { S.dndPending = true; return; } // 拖曳中不重畫，放開後再畫
  const st = tabStructure();
  const byId = new Map(S.sessions.map(s => [s.id, s]));
  const paneOf = new Map(panesOn().filter(p => !pst(p).draft && pst(p).cur).map(p => [pst(p).cur, p]));
  const flagOf = s => 'sflag' + (S.perms.get(s.id) && S.perms.get(s.id).size ? ' wait' : S.running.has(s.id) ? ' run' : UNREAD.has(s.id) ? ' unread' : '');
  const toggle = key => () => { S.collapsed.has(key) ? S.collapsed.delete(key) : S.collapsed.add(key); ls('cc_collapsed', JSON.stringify([...S.collapsed])); renderSidebar(); };
  const virtualTab = s => { // 分頁列：虛擬空白卡片
    const d = el('div', { class: 'tab vtab' + (shownIds().has(s.id) ? ' cur' : ''), title: '還沒說過話的新對話（點一下開始）' },
      el('span', { class: 'ttl' }, dispTitle(s)), el('span', { class: 'blanktag' }, '未開始'));
    d.onclick = () => wsOpenVirtual(s.id);
    d.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, vMenuItems(s)); };
    dndWire(d, { type: 'wsession', sid: s.id, gid: s.gid, virtual: true });
    return d;
  };
  const sessionTab = (s, fk, gid) => {
    if (s.virtual) return virtualTab(s);
    const p = paneOf.get(s.id);
    const d = el('div', { class: 'tab' + (p === ACTIVE ? ' cur' : p ? ' side' : ''), title: s.title + '\n' + s.cwd },
      el('span', { class: 'ttl' }, dispTitle(s)), el('span', { class: flagOf(s) }));
    d.onclick = () => openMain(s.id);
    d.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, [
      ...(S.focusKey ? wsMenuItems(s) : []),
      ['⫽ 加入到分割畫面', () => (paneShows(PANE.R, s.id) && !PANE.R.el.hidden ? setActive(PANE.R) : openRight(s.id))],
      ['✎ 重新命名', () => renameSession(s)],
    ]); };
    if (S.focusKey) dndWire(d, { type: 'wsession', sid: s.id, gid: gid || null });
    else if (fk) dndWire(d, { type: 'session', sid: s.id, fk });
    return d;
  };
  const moreChip = (key, n) => { const m = el('div', { class: 'tmore', title: '展開其餘' }, '+' + n); m.onclick = () => { (S.expandedGroups ||= new Set()).add(key); renderSidebar(); }; return m; };
  const folderUnit = ([k, g], gid) => {
    const key = 'f:' + k, collapsed = S.collapsed.has(key), br = !gid; // 沒進群組的資料夾：括弧樣式（橫向版）
    const wrap = el('div', { class: 'tfold' + (collapsed ? ' collapsed' : '') + (br ? ' tbr' : ''), style: br ? '--bk:' + folderColor(k) : null });
    const chip = el('div', { class: 'tchip ' + (br ? 'tfbr' : 'tfchip'), title: g.cwd + '\n右鍵：資料夾群組選單' },
      ...(br ? [el('span', { class: 'ttl' }, baseName(g.cwd) || '(未知)'), el('span', { class: 'tn' }, '(' + g.items.length + ')')]
             : [el('span', { class: 'caret' }, collapsed ? '▸' : '▾'), el('span', { class: 'ttl' }, baseName(g.cwd) || '(未知)'), el('span', { class: 'tcount' }, g.items.length)]));
    chip.onclick = toggle(key);
    chip.oncontextmenu = e => { e.preventDefault(); folderMenu(g.cwd, e.clientX, e.clientY); };
    dndWire(chip, { type: 'folder', key: k, gid: gid || null }); chip.__block = wrap;
    wrap.append(chip);
    if (!collapsed) {
      const max = S.expandedGroups && S.expandedGroups.has(key) ? Infinity : 15;
      g.items.slice(0, max).forEach(s => wrap.append(sessionTab(s, k)));
      if (g.items.length > max) wrap.append(moreChip(key, g.items.length - max));
    }
    return wrap;
  };
  const groupUnit = u => {
    const fg = u.fg, key = 'g:' + fg.id, collapsed = S.collapsed.has(key), color = fg.color || '#8a8a8a';
    const total = u.folders.reduce((n, [, f]) => n + f.items.length, 0);
    const wrap = el('div', { class: 'tunit tg' + (collapsed ? ' collapsed' : ''), style: '--fg:' + color });
    const chip = el('div', { class: 'tchip tgchip', title: '右鍵：重新命名／換顏色／解散群組', style: 'background:' + color + ';color:' + fgInk(color) },
      el('span', { class: 'caret' }, collapsed ? '▸' : '▾'), el('span', { class: 'ttl' }, fg.name), el('span', { class: 'tcount' }, u.folders.length + '·' + total));
    chip.onclick = toggle(key);
    chip.oncontextmenu = e => { e.preventDefault(); groupMenu(fg, e.clientX, e.clientY); };
    dndWire(chip, { type: 'group', key: fg.id }); chip.__block = wrap;
    wrap.append(chip);
    if (!collapsed) u.folders.forEach(f => wrap.append(folderUnit(f, fg.id)));
    return wrap;
  };
  const left = $('#tabShort'), right = $('#tabScroll');
  left.innerHTML = ''; right.innerHTML = '';
  // 1) 左區（固定）：兩張捷徑虛擬卡片（沒有右鍵功能，只有左鍵跳回去）
  let anyV = false;
  for (const [kind, tag] of [['main', '主'], ['sub', '副']]) {
    const s = byId.get(shortObj()[kind]); if (!s) continue;
    anyV = true;
    const p = paneOf.get(s.id);
    const d = el('div', { class: 'tab vcard' + (p === ACTIVE ? ' cur' : p ? ' side' : ''), title: (kind === 'main' ? '最新主視窗' : '最新副視窗') + '（點一下跳回去）\n' + s.title },
      el('span', { class: 'vtag' }, tag), el('span', { class: 'ttl' }, dispTitle(s)), el('span', { class: flagOf(s) }));
    d.onclick = () => (kind === 'main' ? openMain(s.id) : openSub(s.id));
    d.oncontextmenu = e => e.preventDefault();
    left.append(d);
  }
  if (!anyV) left.append(el('div', { class: 'tshint', title: '在主／副視窗真的說話過的對話，會在這裡放一張捷徑卡，點一下跳回去' }, '主／副 捷徑'));
  // 2) 右區：Web 分頁式——還沒開始說話的新對話（草稿）
  for (const p of panesOn()) if ((pst(p).draft && !pst(p).draft.vid) || !pst(p).cur && !pst(p).draft) {
    const d = el('div', { class: 'tab' + (p === ACTIVE ? ' cur' : ' side') }, el('span', { class: 'ttl' }, '＋ 新對話'));
    d.onclick = () => setActive(p); right.append(d);
  }
  if (S.focusKey) { // 專注模式：右區只剩這個資料夾（資料夾標籤只能退出）＋ 工作群／對話（同樣的分頁邏輯）
    const ws = wsGet();
    const fchip = el('div', { class: 'tchip tfchip', title: S.focusCwd + '\n專注模式：資料夾只能退出（右鍵）' },
      el('span', { class: 'ttl' }, '🎯 ' + (baseName(S.focusCwd) || '(未知)')), el('span', { class: 'tcount' }, visibleSessions().length));
    fchip.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, [['⮌ 退出專注模式', () => exitFocus()]]); };
    right.append(fchip);
    for (const u of wsStructure()) {
      if (u.s) { right.append(sessionTab(u.s, null, null)); continue; }
      const g = u.group.g, key = 'wg:' + g.id, collapsed = ws.collapsed.includes(key), color = g.color || '#8a8a8a';
      const wrap = el('div', { class: 'tfold tbr' + (collapsed ? ' collapsed' : ''), style: '--bk:' + color });
      const chip = el('div', { class: 'tchip tfbr', title: '右鍵：新增對話／重新命名／換顏色／解散工作群' },
        el('span', { class: 'ttl' }, g.name), el('span', { class: 'tn' }, '(' + u.group.items.filter(x => !x.virtual).length + ')'));
      chip.onclick = () => wsToggle(key);
      chip.oncontextmenu = e => { e.preventDefault(); wgroupMenu(g, e.clientX, e.clientY); };
      dndWire(chip, { type: 'wgroup', key: g.id }); chip.__block = wrap;
      wrap.append(chip);
      if (!collapsed) u.group.items.forEach(s => wrap.append(sessionTab(s, null, g.id)));
      right.append(wrap);
    }
    return;
  }
  // 3) 釘選、群組、資料夾（同左側列表）
  if (st.pinned.length) {
    const collapsed = S.collapsed.has('pinned'), wrap = el('div', { class: 'tfold' + (collapsed ? ' collapsed' : '') });
    const chip = el('div', { class: 'tchip tfchip' }, el('span', { class: 'caret' }, collapsed ? '▸' : '▾'), el('span', { class: 'ttl' }, '📌 釘選'), el('span', { class: 'tcount' }, st.pinned.length));
    chip.onclick = toggle('pinned'); wrap.append(chip);
    if (!collapsed) st.pinned.forEach(s => wrap.append(sessionTab(s, null)));
    right.append(wrap);
  }
  for (const u of st.units) right.append(u.fg ? groupUnit(u) : folderUnit(u.folder, null));
}
$('#tabScroll').addEventListener('wheel', e => { const b = e.currentTarget; if (b.scrollWidth > b.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { b.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
$('#btnTabs').onclick = () => { S.tabsOn = !S.tabsOn; ls('cc_tabs', S.tabsOn ? '1' : '0'); renderTabs(); btwRepos(); };
// 兩個小半圓儀表（本階段／本週）放在收起後的窄欄下方
function renderRailGauges() {
  const box = $('#railGauges'); if (!box) return;
  box.innerHTML = '';
  const r = S.rate, wins = r && (r.unifiedWindows || (r.rateLimitType ? { [r.rateLimitType]: r } : {})) || {};
  const now = Date.now() / 1000;
  for (const [k, lab] of [['five_hour', '階段'], ['seven_day', '本週']]) {
    const v = wins[k], has = v && v.utilization != null;
    const expired = has && v.resetsAt && v.resetsAt <= now;
    const pct = has ? (expired ? 0 : Math.round(v.utilization * 100)) : null;
    const lv = pct >= 90 ? ' hot' : pct >= 75 ? ' warm' : '';
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 40 23');
    const path = cls => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M4 20 A16 16 0 0 1 36 20'); p.setAttribute('pathLength', '100'); p.setAttribute('class', cls); return p; };
    const val = path('gval'); val.setAttribute('stroke-dasharray', (has ? Math.min(100, pct) : 0) + ' 100');
    svg.append(path('gtrack'), val);
    const tip = has ? RATE_NAMES[k] + '：已用 ' + pct + '%' + (v.resetsAt && !expired ? '\n' + fmtWhen(v.resetsAt * 1000) + ' 重置，還有 ' + fmtLeft(v.resetsAt - now) : '') : RATE_NAMES[k] + '：尚無資料';
    box.append(el('div', { class: 'gauge' + lv, title: tip }, svg, el('div', { class: 'gpct' }, has ? pct + '%' : '–'), el('div', { class: 'glab' }, lab)));
  }
}
function renderRailDot() {
  const d = $('#railDot'); if (!d) return;
  const wait = [...S.perms.values()].some(m => m && m.size);
  const unread = S.sessions.some(s => UNREAD.has(s.id));
  d.className = wait ? 'wait' : unread ? 'unread' : '';
}
$('#btnSbHide').onclick = () => applySidebar(true);
$('#btnSbShow').onclick = () => applySidebar(false);
applySidebar(ls('cc_sbcollapsed') === '1', true);
$('#search').addEventListener('input', renderSidebar);
// 左上半部：來源按鈕，每按一次循環 全部 → CLI → 桌面版
const SOURCE_ORDER = ['all', 'cli', 'desktop'];
const SOURCE_LABEL = { all: '全部來源', cli: '只有 CLI', desktop: '只有桌面版' };
const SOURCE_SHORT = { all: '全部', cli: 'CLI', desktop: '桌面' };
S.source = SOURCE_ORDER.includes(ls('cc_source')) ? ls('cc_source') : 'all';
function renderSourceBtn() {
  const b = $('#btnSource'); if (!b) return;
  b.textContent = '來源：' + (SOURCE_SHORT[S.source] || '全部');
  b.title = `顯示哪裡開的對話：${SOURCE_LABEL[S.source] || '全部'}\n（每按一次切換：全部 → CLI → 桌面版）`;
}
$('#btnSource').onclick = () => {
  S.source = SOURCE_ORDER[(SOURCE_ORDER.indexOf(S.source) + 1) % SOURCE_ORDER.length];
  ls('cc_source', S.source); renderSourceBtn(); renderSidebar();
};
renderSourceBtn();
// ⚙ 設定 → 左側列表: show Desktop temp sessions / archived sessions
S.showScratch = ls('cc_scratch') === '1';
S.showHidden = ls('cc_hidden') === '1';
const GROUP_MODES = { folder: '依資料夾', time: '依時間分段', flat: '時間排序' };
const SORT_ORDER = ['folder', 'time', 'flat'];
function renderSortBtn() {
  const b = $('#btnSort'); if (!b) return;
  const v = GROUP_MODES[S.prefs.groupBy] ? S.prefs.groupBy : 'folder';
  b.textContent = '排序：' + GROUP_MODES[v];
  b.title = `左側列表排列：${GROUP_MODES[v]}\n（每按一次切換：依資料夾 → 依時間分段 → 時間排序）`;
}
$('#btnSort').onclick = () => {
  const cur = GROUP_MODES[S.prefs.groupBy] ? S.prefs.groupBy : 'folder';
  setGroupBy(SORT_ORDER[(SORT_ORDER.indexOf(cur) + 1) % SORT_ORDER.length]);
};
function setGroupBy(v) {
  if (!GROUP_MODES[v]) v = 'folder';
  S.prefs.groupBy = v; api('POST', '/api/prefs', { groupBy: v }).catch(() => {});
  renderSidebar(); renderSortBtn();
}
renderSortBtn();

// ---------- version ----------
// page = public/version.json on disk now (what this page and a fresh server would run);
// server = the version the running server started with. Different → the server is old and needs a restart.
S.ver = { page: null, server: null };
async function checkVersion(serverVer) {
  if (serverVer !== undefined) S.ver.server = serverVer || null;
  try { S.ver.page = (await (await fetch('/version.json', { cache: 'no-store' })).json()).version; } catch {}
  renderVersion();
}
function renderVersion() {
  const v = $('#verLine'), { page, server } = S.ver;
  if (!page) { v.textContent = ''; return; }
  const old = server !== page;
  v.className = old ? 'verwarn' : 'muted small';
  v.textContent = old ? '⚠ 伺服器未重開到新版' : `v${page}`;
  v.title = old
    ? `伺服器：${server ? 'v' + server : '舊版（沒有版號）'} → 程式：v${page}\n按左下角的「⟳ 重啟後端」就會換成新版（不用重開視窗；有對話在執行會先確認）。`
    : `CLI Controller v${page}（畫面和伺服器都是這個版本）`;
}

// ---------- server control (⏻ 關閉後端 / ⟳ 重啟後端) ----------
// The claude processes belong to the server, and normally start.vbs is what replaces an idle server. These two
// buttons do it from inside the window: 關閉後端 ends the server (and every claude it started); 重啟後端 also
// spawns a fresh server — the current code on disk — on the same port, then reloads this window onto it. So a
// server-side change takes effect without closing and relaunching the window. A turn that is actually replying
// triggers a confirm first; the retry comes back with force.
function setSrvButtons(d) { $('#btnKillServer').disabled = d; $('#btnRestartServer').disabled = d; }
async function serverCtl(action, body) {
  let r;
  try { r = await fetch('/api/server/' + action, { method: 'POST', headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
  catch { return { status: 0, body: {} }; }
  let b = {}; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}
function runningTitles() {
  const ids = new Set([...S.running.keys(), ...S.sessions.filter(s => s.running).map(s => s.id)]);
  return [...ids].map(id => (S.sessions.find(s => s.id === id) || {}).title).filter(Boolean);
}
function busyConfirm(kind, n) {
  const t = runningTitles();
  const list = t.length ? '\n\n進行中的對話：\n' + t.slice(0, 6).map(x => '· ' + x).join('\n') + (t.length > 6 ? `\n…（共 ${t.length} 個）` : '') : '';
  const what = kind === 'restart' ? '重新啟動後端' : '關閉後端';
  return confirm(`目前有 ${n} 個對話正在執行。\n${what}會先停止這些對話，這一輪還沒跑完的回應會不見。${list}\n\n確定要${what}嗎？`);
}
let srvTimer = null;
function showServerDown(mode) {
  S.serverDown = mode; S.serverBusy = false;
  try { if (es) es.close(); } catch {}
  $('#app').classList.remove('offline');
  $('#settingsModal').hidden = true;
  setSrvButtons(true);
  clearTimeout(srvTimer);
  $('#serverDown').hidden = false;
  const title = $('#sdTitle'), bodyEl = $('#sdBody'), retry = $('#sdRetry');
  bodyEl.innerHTML = '';
  if (mode === 'restarting') {
    title.textContent = '正在重新啟動後端…';
    bodyEl.append(
      el('div', { class: 'sdspin' }, el('span', { class: 'spinner' })),
      el('div', { class: 'muted small', style: 'margin-top:10px' }, '新的後端服務啟動中（用的是目前最新版程式），完成後這個視窗會自動重新載入。'));
    retry.disabled = true; retry.textContent = '請稍候…';
    pollServerUp();
  } else {
    title.textContent = '後端服務已關閉';
    bodyEl.append(el('div', { class: 'muted', style: 'line-height:1.7' },
      '背景服務（和它開的 claude 對話）已經完全結束。', el('br'),
      el('span', { class: 'muted small' }, '要再使用，請雙擊 start.vbs（或開始選單／桌面的「Claude CLI Controller」捷徑）重新啟動，完成後按「重新連線」。')));
    retry.disabled = false; retry.textContent = '重新連線';
  }
}
function pollServerUp() {
  let tries = 0;
  const tick = async () => {
    let up = false;
    try { up = (await fetch('/api/init?t=' + encodeURIComponent(TOKEN), { cache: 'no-store' })).ok; } catch {}
    if (up) { location.reload(); return; }
    if (++tries >= 44) {
      $('#sdTitle').textContent = '還沒連回新的後端';
      const b = $('#sdBody'); b.innerHTML = '';
      b.append(el('div', { class: 'muted', style: 'line-height:1.7' },
        '沒有找到新的後端服務。', el('br'),
        el('span', { class: 'muted small' }, '可能是舊的後端還佔著連線埠。請開工作管理員結束 node.exe，或再雙擊一次 start.vbs，然後按「重新連線」。')));
      const r = $('#sdRetry'); r.disabled = false; r.textContent = '重新連線';
      return;
    }
    srvTimer = setTimeout(tick, 500);
  };
  tick();
}
// a server process from before this feature (v1.1.7 and earlier) has no /api/server/*: use /api/shutdown (idle
// only) and let the launcher bring up the new version. This is only for the one-time transition to v1.1.8.
async function legacyShutdownAndReload() {
  let status = 0;
  try { status = (await fetch('/api/shutdown', { method: 'POST', headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, body: '{}' })).status; } catch {}
  if (status === 409) { toast('執行中的後端是舊版，還有對話在跑時無法從視窗重啟。請先按 ■ 停止對話，或關掉視窗等它閒置後用 start.vbs 重開。', 9000); return false; }
  if (status === 0 || status === 200) { showServerDown('stopped'); return true; }
  toast('這個舊版後端不支援從視窗操作，請用 start.vbs 重新開啟一次。', 9000); return false;
}
async function doRestartServer() {
  if (S.serverDown || S.serverBusy) return;
  S.serverBusy = true; setSrvButtons(true);
  try {
    let { status, body } = await serverCtl('restart');
    if (status === 404) { await legacyShutdownAndReload(); return; }
    if (status === 409 && busyConfirm('restart', body.running || 1)) ({ status, body } = await serverCtl('restart', { force: true }));
    if (status === 404) { await legacyShutdownAndReload(); return; }
    if (status === 200) { showServerDown('restarting'); return; }
    if (status !== 409) toast('重新啟動失敗' + (body && body.error ? ': ' + body.error : ''), 6000); // 409 = user cancelled
  } catch (e) { toast('重新啟動失敗: ' + e.message, 6000); }
  finally { if (!S.serverDown) { S.serverBusy = false; setSrvButtons(false); } }
}
async function doStopServer() {
  if (S.serverDown || S.serverBusy) return;
  S.serverBusy = true; setSrvButtons(true);
  try {
    let { status, body } = await serverCtl('stop');
    if (status === 404) { await legacyShutdownAndReload(); return; }
    if (status === 409 && busyConfirm('stop', body.running || 1)) ({ status, body } = await serverCtl('stop', { force: true }));
    if (status === 404) { await legacyShutdownAndReload(); return; }
    if (status === 200) { showServerDown('stopped'); return; }
    if (status !== 409) toast('關閉後端失敗' + (body && body.error ? ': ' + body.error : ''), 6000);
  } catch (e) { toast('關閉後端失敗: ' + e.message, 6000); }
  finally { if (!S.serverDown) { S.serverBusy = false; setSrvButtons(false); } }
}
$('#btnRestartServer').onclick = () => doRestartServer();
$('#btnKillServer').onclick = () => doStopServer();
$('#sdRetry').onclick = async () => {
  let up = false; try { up = (await fetch('/api/init?t=' + encodeURIComponent(TOKEN), { cache: 'no-store' })).ok; } catch {}
  if (up) location.reload(); else toast('後端服務還沒有上線，請先啟動後端再按一次', 4000);
};

// ---------- settings (⚙) ----------
// Theme is per window (localStorage); the rest are the same values the other controls use.
const THEMES = { system: '跟隨系統', light: '淺色', dark: '深色' };
function applyTheme(t) {
  if (!THEMES[t]) t = 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
applyTheme(ls('cc_theme'));
// 標題列顏色由伺服器在「開視窗」時寫進瀏覽器設定檔（見 server.js applyWindowScheme），所以主題要告訴伺服器
function saveWindowTheme(t) { S.prefs.windowTheme = t; return api('POST', '/api/prefs', { windowTheme: t }).catch(() => {}); }
const themeIsDark = t => t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
async function changeTheme(v) {
  const was = themeIsDark(ls('cc_theme') || 'system');
  ls('cc_theme', v); applyTheme(v);
  await saveWindowTheme(v);
  // 標題列是瀏覽器自己畫的，只在「開視窗」時才會照主題上色：深淺有變就問要不要現在重開視窗
  if (was !== themeIsDark(v) && confirm('主題已換好。\n\n視窗最上面的標題列要重新開啟視窗才會跟著換色，現在重開嗎？\n（對話都在背景服務裡，不會不見；輸入框裡還沒送出的文字會消失。）')) {
    api('POST', '/api/window/reopen').catch(() => {});
  }
}
function segRow(label, hint, options, value, onPick) {
  return el('div', { class: 'setrow' },
    el('div', { class: 'setlabel' }, label, hint ? el('div', { class: 'muted small' }, hint) : null),
    el('div', { class: 'seg setseg' }, Object.entries(options).map(([v, text]) =>
      el('button', { type: 'button', class: v === String(value) ? 'on' : '', onclick: () => { onPick(v); renderSettings(); } }, text))));
}
const setSection = title => el('div', { class: 'setsec' }, title);
// Everything configurable lives here, grouped; nothing in here is duplicated elsewhere in the UI.
function renderSettings() {
  const body = $('#setBody'); body.innerHTML = '';
  const a = S.auth || {};
  const acct = a.loggedIn
    ? [a.email || '已登入', [a.orgName, a.planTier || a.subscriptionType].filter(Boolean).join(' · ')].filter(Boolean)
    : ['尚未登入'];
  body.append(
    setSection('帳號'),
    el('div', { class: 'setrow' },
      el('div', { class: 'setlabel' }, 'claude CLI 登入帳號', el('div', { class: 'muted small' }, '登入或登出後這裡會自動更新')),
      el('div', { class: 'setacct' + (a.loggedIn ? '' : ' err') }, acct.map(t => el('div', null, t))),
      el('button', { class: 'btn icon small', title: '重新檢查登入狀態', onclick: () => recheckAuth() }, '↻'),
      el('button', { class: 'btn small' + (a.loggedIn ? '' : ' primary'), title: '開一個 PowerShell 視窗執行 claude auth login', onclick: doLogin }, a.loggedIn ? '換帳號' : '登入')),
    setSection('外觀'),
    segRow('主題', '視窗最上面的標題列顏色要「關掉視窗再開」才會跟著換', THEMES, ls('cc_theme') || 'system', v => changeTheme(v)),
    setSection('左側列表'),
    segRow('顯示桌面版暫存對話', 'Claude Desktop 放在 AppData 的暫存 session', { 0: '不顯示', 1: '顯示' }, S.showScratch ? 1 : 0,
      v => { S.showScratch = v === '1'; ls('cc_scratch', S.showScratch ? '1' : '0'); renderSidebar(); }),
    segRow('顯示已封存對話', '封存的對話會以淡色顯示，右鍵可以取消封存', { 0: '不顯示', 1: '顯示' }, S.showHidden ? 1 : 0,
      v => { S.showHidden = v === '1'; ls('cc_hidden', S.showHidden ? '1' : '0'); renderSidebar(); }),
    setSection('對話'),
    segRow('工具呼叫', 'Bash、Read 等工具呼叫的顯示方式', TOOL_MODES, S.toolMode, v => setToolMode(v)),
    segRow('新對話預設權限', 'Auto：一般操作自動執行，危險操作會擋下。略過所有權限：完全不確認', { auto: 'Auto', bypassPermissions: '略過所有權限' }, PERM_MODES.includes(S.prefs.permissionMode) ? S.prefs.permissionMode : 'auto',
      v => { api('POST', '/api/prefs', { permissionMode: v }).then(d => { S.prefs = d.prefs; if (S.draft) $('#selPerm').value = v; }); S.prefs.permissionMode = v; }),
    setSection('關於'),
    el('div', { class: 'setrow' }, el('div', { class: 'setlabel' }, '版本'),
      el('div', { class: S.ver.server && S.ver.server === S.ver.page ? 'muted' : 'err' },
        S.ver.page ? `v${S.ver.page}` + (S.ver.server === S.ver.page ? '' : `（伺服器：${S.ver.server ? 'v' + S.ver.server : '舊版'}，需要重開 App）`) : '—')),
  );
}
function openSettings() { renderSettings(); $('#settingsModal').hidden = false; }
$('#btnSettings').onclick = openSettings;
$('#setClose').onclick = () => { $('#settingsModal').hidden = true; };
$('#settingsModal').addEventListener('mousedown', e => { if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#settingsModal').hidden) $('#settingsModal').hidden = true; });
document.addEventListener('keydown', e => {
  if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newDraft(); }
  if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); applySidebar(!S.sbCollapsed); }
});
setInterval(() => { if (document.visibilityState === 'visible') renderSidebar(); }, 60000);

// ---------- panes: build, focus, 右側分割視窗 ----------
// Each pane gets its own header and transcript from the <template>. Pressing the mouse anywhere in a pane
// (including blank space) makes it the active pane: the composer, the viewer strip and the list selection follow it.
function buildPane(key) {
  const node = $('#paneTpl').content.firstElementChild.cloneNode(true);
  node.dataset.pane = key;
  const q = sel => node.querySelector(sel);
  const p = {
    key, el: node, T: q('.transcript'), tail: null, st: newPaneState(),
    hdr: { title: q('[data-role=title]'), cwd: q('[data-role=cwd]'), model: q('[data-role=model]'), splitClose: q('[data-act=split-close]'), swap: q('[data-act=split-swap]') },
  };
  // double-click the title to rename, click the folder chip to reveal it; the rest lives in the card (list) menu
  const run = fn => () => withPane(p, fn);
  const h = p.hdr;
  h.title.ondblclick = run(() => { const s = curSession(); if (s && !S.draft) renameSession(s); });
  h.cwd.onclick = run(() => reveal(S.cwd));
  h.splitClose.onclick = () => closeRight();
  h.splitClose.hidden = key === 'L';
  h.swap.onclick = () => swapPanes();
  h.swap.hidden = key === 'L';
  p.T.addEventListener('scroll', () => { const st = nearEl(p.T); if (p === CTX) S.stick = st; else p.st.stick = st; });
  p.T.addEventListener('click', onTranscriptClick);
  node.addEventListener('mousedown', () => setActive(p), true);
  return p;
}
function updateFocusMarks() {
  PANE.L.el.classList.toggle('focused', ACTIVE === PANE.L);
  PANE.R.el.classList.toggle('focused', ACTIVE === PANE.R);
}
function updateSplit() {
  $('#panes').classList.toggle('split', !PANE.R.el.hidden);
  syncViewerMode();
  updateFocusMarks();
  renderSidebar();
}
// make pane p the one the composer belongs to
function setActive(p) {
  if (p === ACTIVE || p.el.hidden) return;
  const old = ACTIVE;
  old.st.input = input.value; // keep what was typed in the pane we leave
  saveTo(old);
  closeCmd(); closePop();
  ACTIVE = p; loadPane(p);
  input.value = p.st.input || ''; autosize();
  if (S.cur && !S.draft) ls('cc_last', S.cur);
  if (S.cur && UNREAD.delete(S.cur)) { saveUnread(); renderSidebar(); }
  renderTabs();
  updateFocusMarks();
  refreshComposer(); renderStrip(); renderHead();
  // 分割視窗下切換焦點：btw 小視窗是綁在「開啟它的那一格」，不跟焦點走。切到別的格 = 當作取消，直接關掉
  // （AI 還在回答中就先留著，讓答案跑完；切回原來那格會看到）。
  if (btwPop && !btwPop.hidden && btwPane && p !== btwPane && !btwBusy) btwCancel();
  input.focus();
}
// 跟主視窗互換：右邊這格變成主視窗（L）、原本的主視窗變成副視窗（R）。只換位置，內容、捲動位置、草稿都留在各自那格
function swapPanes() {
  const L = PANE.L, R = PANE.R; if (R.el.hidden) return;
  const sL = L.T.scrollTop, sR = R.T.scrollTop;
  L.el.parentNode.insertBefore(R.el, L.el);          // 搬 DOM 會讓捲動歸零，下面再還原
  PANE.L = R; PANE.R = L; R.key = 'L'; L.key = 'R'; R.el.dataset.pane = 'L'; L.el.dataset.pane = 'R';
  R.hdr.splitClose.hidden = true; R.hdr.swap.hidden = true; L.hdr.splitClose.hidden = false; L.hdr.swap.hidden = false;
  L.T.scrollTop = sL; R.T.scrollTop = sR;
  { const sh = shortObj(); [sh.main, sh.sub] = [sh.sub, sh.main]; saveShort(); }
  updateFocusMarks(); renderTabs(); renderSidebar();
  if (typeof btwRepos === 'function') btwRepos();
  if (typeof ipRepos === 'function') ipRepos();
}
// 右側分割視窗: show a session in the right pane (replaces whatever was there; at most two panes)
function openRight(sid) {
  if (S.focusKey && !inFocusFolder(sid)) { toast('專注模式中只能開啟這個資料夾的對話'); return; }
  if (paneShows(PANE.L, sid)) { toast('這個對話已經在左側開著'); return; }
  const R = PANE.R;
  if (R.el.hidden) { R.el.hidden = false; updateSplit(); }
  openSession(sid, R);
  setActive(R);
}
function closeRight() {
  const R = PANE.R;
  if (R.el.hidden) return;
  if (btwPop && !btwPop.hidden && btwPane === R) btwCancel(); // 小視窗綁在右格：右格要關了，一起關掉
  if (ipPane === R) closeImgPop();
  if (ACTIVE === R) setActive(PANE.L);
  R.st = newPaneState(); R.tail = null; R.T.innerHTML = '';
  R.el.hidden = true;
  updateSplit(); renderTabs();
}

PANE.L = buildPane('L');
PANE.R = buildPane('R');
PANE.R.el.hidden = true;
$('#panes').append(PANE.L.el, PANE.R.el);
ACTIVE = PANE.L; loadPane(PANE.L);
updateFocusMarks();

(async function init() {
  if (!TOKEN) { document.body.innerHTML = '<p style="padding:2em">缺少存取權杖。請用 start.vbs 啟動。</p>'; return; }
  try {
    const d = await api('GET', '/api/init');
    S.prefs = d.prefs; S.sessions = d.sessions;
    checkVersion(d.version || null);
    if (!GROUP_MODES[S.prefs.groupBy]) S.prefs.groupBy = 'folder';
    if ((S.prefs.windowTheme || 'system') !== (ls('cc_theme') || 'system')) saveWindowTheme(ls('cc_theme') || 'system');
    renderSortBtn();
    renderAuth(d.auth); renderRate(d.rate);
  } catch (e) { toast('無法連線到伺服器: ' + e.message, 10000); }
  connect();
  loadPrompts();
  try { if (Notification.permission === 'default') Notification.requestPermission(); } catch {}
  const last = ls('cc_last');
  wsSweepAllStored(); // 重開 app：把上次當機／直接關閉留下的空白卡片清掉
  if (S.focusKey) { // 專注中重新整理：回到這個工作區上次的主視窗
    const w = wsGet().panes, L = (last && inFocusFolder(last)) ? last : (w && w.L && inFocusFolder(w.L) ? w.L : null);
    if (L) openSession(L); else newDraft(S.focusCwd);
  } else if (last && S.sessions.some(s => s.id === last)) openSession(last); else newDraft();
  renderSidebar();
})();

// ---------- /btw 順帶一提：客服式浮動小視窗 ----------
// 懸在右側對話區上方、靠左對齊到文字行首；答案只顯示在這裡，不會寫進對話，也不插進訊息串。
// 開啟：打 /btw 送出、或按送出鈕左邊的 💬（會直接焦點到輸入欄）。再按一次 💬 或 ✕／Esc 關閉；
// ⤢ 在「一半 / 三分之二」兩種高度間切換。綁在開啟時作用中的那個分割面板與 session。
function btwEnsure() {
  if (btwPop) return btwPop;
  btwPop = el('div', { class: 'btw' + (btwScale === 2 ? ' btw-lg' : ''), id: 'btwPop', hidden: true },
    el('div', { class: 'btwhd' },
      el('span', { class: 'btwtt', id: 'btwTitle' }, '💬 順帶一提'),
      el('button', { class: 'btn icon small', id: 'btwSize', title: '切換小視窗大小（一半 / 三分之二）' }, btwScale === 2 ? '½' : '⅔'),
      el('button', { class: 'btn icon small', id: 'btwClose', title: '關閉 (Esc)' }, '✕')),
    el('div', { class: 'btwthread', id: 'btwThread' }),
    el('div', { class: 'btwrow' },
      el('input', { id: 'btwInput', class: 'btwin', type: 'text', placeholder: '順帶問一個問題，Enter 送出（不會寫進對話）…' }),
      el('button', { class: 'btn primary small', id: 'btwSendB', title: '送出 (Enter)' }, '送出')));
  ($('#main') || document.body).append(btwPop);
  btwIn = $('#btwInput');
  $('#btwClose').onclick = btwHide;
  $('#btwSize').onclick = btwSizeToggle;
  $('#btwSendB').onclick = btwSend;
  btwIn.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btwSend(); }
    else if (e.key === 'Escape') { e.preventDefault(); btwHide(); }
  });
  return btwPop;
}
function btwThread() { return $('#btwThread'); }
function btwSizeToggle() {
  btwScale = btwScale === 1 ? 2 : 1; ls('cc_btw', String(btwScale));
  btwPop.classList.toggle('btw-lg', btwScale === 2);
  $('#btwSize').textContent = btwScale === 2 ? '½' : '⅔';
  btwRepos(); btwIn.focus();
}
// dock to the pane it was opened in (btwPane, never ACTIVE), align to that transcript's top/left, size by btwScale
function btwRepos() {
  if (!btwPop || btwPop.hidden) return;
  if (!btwPane || btwPane.el.hidden) { btwCancel(); return; }  // 那個分割格已經被關掉 → 小視窗也關掉
  const pane = btwPane, T = pane.T, cs = getComputedStyle(T);
  if (btwPop.parentElement !== pane.el) pane.el.append(btwPop);
  const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
  btwPop.style.left = pl + 'px';
  btwPop.style.top = Math.round(T.offsetTop + pt + 4) + 'px';
  btwPop.style.width = Math.round(Math.min(T.clientWidth - pl * 2, 860)) + 'px';
  btwPop.style.height = Math.round(T.clientHeight * (btwScale === 2 ? 0.66 : 0.5)) + 'px';
  const st = pst(pane), sid = (!st.draft && st.cur) ? st.cur : null;
  if (sid !== btwAnchor) { btwAnchor = sid; btwThread().innerHTML = ''; }
  const s = sid ? S.sessions.find(x => x.id === sid) : null;
  $('#btwTitle').textContent = '💬 順帶一提' + (s ? ' · ' + (s.title || '') : '');
}
function btwShow() {
  btwEnsure();
  closeImgPop(); if (!$('#viewer').hidden) closeViewer(); // 看圖 UI 和 /btw 互斥
  btwPane = ACTIVE;               // 綁在目前作用中的那一格
  const st = pst(btwPane);
  if (st.draft || !st.cur) { btwPane = null; toast('先在對話裡才能用「順帶一提」'); return; }
  btwPop.classList.toggle('btw-lg', btwScale === 2);
  $('#btwSize').textContent = btwScale === 2 ? '½' : '⅔';
  btwPop.hidden = false; btwRepos(); btwIn.focus();
}
function btwHide() { if (btwPop) btwPop.hidden = true; input.focus(); }   // 手動關閉：保留內容，之後開同一個對話還在
function btwCancel() {                                                        // 切焦點/關格子：當作沒開過
  if (!btwPop) return;
  btwPop.hidden = true; btwThread().innerHTML = ''; btwAnchor = null; btwPane = null;
}
function btwToggle() { if (btwPop && !btwPop.hidden && btwIn === document.activeElement) btwHide(); else btwShow(); }
function runBtw(text) {
  text = String(text || '').trim(); if (!text) return;
  const sid = btwAnchor;
  if (!sid) { toast('/btw 要在已經開始的對話裡使用'); return; }
  const th = btwThread();
  const q = el('div', { class: 'btwq' }, el('b', null, '我'), el('span', null, text));
  const a = el('div', { class: 'btwa run' }, el('span', { class: 'spinner' }), ' 思考中…（不影響原本的對話）');
  th.append(q, a); th.scrollTop = th.scrollHeight;
  btwBusy++;
  api('POST', '/api/side', { sid, kind: 'btw', text })
    .then(r => {
      a.className = 'btwa md' + (r.isError ? ' err' : '');
      a.innerHTML = window.md(r.text || (r.isError ? '（發生錯誤）' : '（沒有輸出）'));
      decorateImgLinks(a);
    })
    .catch(e => { a.className = 'btwa err'; a.textContent = e.message; })
    .finally(() => { btwBusy = Math.max(0, btwBusy - 1); th.scrollTop = th.scrollHeight; });
}
function btwSend() {
  const v = btwIn.value.trim(); if (!v) return;
  btwIn.value = ''; runBtw(v); btwIn.focus();
}
$('#btwBtn').onclick = btwToggle;
addEventListener('resize', () => { if (btwPop && !btwPop.hidden) btwRepos(); });
btwScale = (ls('cc_btw') === '2' ? 2 : 1);
btwEnsure();
