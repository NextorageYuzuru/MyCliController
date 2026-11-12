'use strict';
// Claude CLI Controller — lightweight local GUI for the Claude Code CLI.
// Zero dependencies: Node's http server + a static web UI shown in an Edge "app" window.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const PORT = Number(process.env.CLICTRL_PORT) || 47821;
const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
// The PATH this process inherits can be stale: Explorer (and so start.vbs / shortcuts) keeps the PATH it had
// at sign-in, so a claude installed or added to PATH later is invisible to us although a new PowerShell finds it.
// Merge in the current PATH from the registry, then look for claude.exe ourselves (spawn without a shell can't
// run .cmd shims, so an npm-installed claude is used through its cli.js instead).
function regPath(key) {
  try {
    const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ[ \t]+([^\r\n]*)/mi);
    return m ? m[1].replace(/%([^%]+)%/g, (s, v) => process.env[v] || s) : '';
  } catch { return ''; }
}
function freshPath() {
  const seen = new Set(), dirs = [];
  for (const d of [process.env.PATH, regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), regPath('HKCU\\Environment')].join(';').split(';')) {
    const t = d.trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); dirs.push(t); }
  }
  return dirs;
}
function findClaude() {
  if (process.env.CLAUDE_BIN) return { bin: process.env.CLAUDE_BIN, pre: [] };
  if (process.platform !== 'win32') return { bin: 'claude', pre: [] };
  const dirs = freshPath();
  process.env.PATH = dirs.join(';'); // also helps everything we spawn (claude's own tools, a restarted server)
  const home = os.homedir();
  for (const d of [...dirs, path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')]) {
    const exe = path.join(d, 'claude.exe'); if (fs.existsSync(exe)) return { bin: exe, pre: [] };
  }
  for (const d of [...dirs, path.join(process.env.APPDATA || '', 'npm')]) {
    const js = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(path.join(d, 'claude.cmd')) && fs.existsSync(js)) return { bin: process.execPath, pre: [js] };
  }
  return { bin: 'claude', pre: [] };
}
const CLAUDE = findClaude();
const CLAUDE_BIN = CLAUDE.bin;
const ARGV = new Set(process.argv.slice(2));
const NO_OPEN = ARGV.has('--no-open');
const KEEP_ALIVE = ARGV.has('--keep-alive');
// Exit this long after the last window closed, if nothing is running. Short, but long enough that reloading
// the page (F5), which briefly drops the connection, does not stop the server.
const IDLE_EXIT_MS = 15000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMG_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const STATIC_TYPES = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Internal version (public/version.json), bumped on every change. Read once at start: this is the version of the
// code this server process runs. The page compares it with the file on disk and warns when the server is older.
let APP_VERSION = '?';
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'version.json'), 'utf8')).version || '?'; } catch {}

fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, 'server.log');
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  if (process.stdout.isTTY) console.log(line);
}

// ---------- token (protects the local API from other web pages) ----------
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN); }

// ---------- persistent store (titles, pins, per-session model/effort…) ----------
const STORE_FILE = path.join(DATA_DIR, 'store.json');
let store = { sessions: {}, prefs: {} };
try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch {}
store.sessions = store.sessions || {};
store.prompts = Array.isArray(store.prompts) ? store.prompts : [];
store.ctxWindows = store.ctxWindows || {}; // model id -> context window size, as reported by claude (result.modelUsage)
store.prefs = Object.assign({ model: '', effort: '', permissionMode: 'auto', groupBy: 'folder', lastCwd: '', windowTheme: 'system', folderGroups: [], folderOrder: [], sessionOrder: {}, workspaces: {}, folderColors: {}, webPages: [] }, store.prefs);
let saveTimer = null;
function flushStore() {
  clearTimeout(saveTimer); saveTimer = null;
  try { const tmp = STORE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store, null, 1)); fs.renameSync(tmp, STORE_FILE); }
  catch (e) { log('store save failed', e.message); }
}
function saveStore() { clearTimeout(saveTimer); saveTimer = setTimeout(flushStore, 300); }
function rec(id) { return store.sessions[id] || (store.sessions[id] = { id }); }

// ---------- transcript scanning (~/.claude/projects/*/<id>.jsonl) ----------
async function readSlice(fp, start, len) {
  const fh = await fsp.open(fp, 'r');
  try { const buf = Buffer.alloc(len); const { bytesRead } = await fh.read(buf, 0, len, start); return buf.subarray(0, bytesRead).toString('utf8'); }
  finally { await fh.close(); }
}
function parseLines(text, dropFirst, dropLast) {
  const ls = text.split('\n');
  if (dropFirst) ls.shift();
  if (dropLast) ls.pop();
  const out = [];
  for (const l of ls) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
function cleanUserText(t) {
  t = String(t || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const cn = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cn) { const a = t.match(/<command-args>([\s\S]*?)<\/command-args>/); return (cn[1] + ' ' + (a ? a[1] : '')).trim(); }
  const so = t.match(/<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/);
  if (so) return so[1].trim();
  if (/^Caveat: The messages below/.test(t.trim())) return '';
  return t.trim();
}
function promptText(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary) return null;
  const c = o.message && o.message.content;
  let t = null;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return null;
    const b = c.find(b => b && b.type === 'text'); if (b) t = b.text;
  }
  if (!t) return null;
  t = cleanUserText(t);
  return t || null;
}
const HEAD = 256 * 1024, TAIL = 128 * 1024;
async function readInfo(fp, size) {
  const head = await readSlice(fp, 0, Math.min(size, HEAD));
  let lines = parseLines(head, false, size > HEAD);
  if (size > HEAD) { const st = Math.max(HEAD, size - TAIL); lines = lines.concat(parseLines(await readSlice(fp, st, size - st), true, false)); }
  const info = { cwd: null, firstPrompt: null, title: null, aiTitle: null, lastPrompt: null, count: 0 };
  for (const o of lines) {
    if (!info.cwd && o.cwd) info.cwd = o.cwd;
    if (!info.entrypoint && o.entrypoint) info.entrypoint = o.entrypoint;
    if (o.type === 'relocated' && o.relocatedCwd) info.relocated = o.relocatedCwd;
    if (o.type === 'custom-title' && o.customTitle) info.title = o.customTitle;
    if (o.type === 'ai-title' && o.aiTitle) info.aiTitle = o.aiTitle;
    if (o.type === 'last-prompt' && o.lastPrompt) info.lastPrompt = String(o.lastPrompt).slice(0, 200);
    if (!info.firstPrompt) { const p = promptText(o); if (p) info.firstPrompt = p.slice(0, 200); }
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) info.count++;
  }
  if (info.relocated) info.cwd = info.relocated;
  return info.count ? info : null;
}
const scanCache = new Map(); // file -> {mtimeMs,size,info}
const scanIndex = new Map(); // session id -> {file, info, mtime}
async function scanAll() {
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  const seen = new Set();
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files; try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6); if (!UUID_RE.test(id)) continue;
      const fp = path.join(dir, f);
      let st; try { st = await fsp.stat(fp); } catch { continue; }
      let c = scanCache.get(fp);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        let info = null; try { info = await readInfo(fp, st.size); } catch {}
        c = { mtimeMs: st.mtimeMs, size: st.size, info }; scanCache.set(fp, c);
      }
      if (!c.info) continue;
      const prev = scanIndex.get(id);
      if (seen.has(id) && prev && prev.mtime >= st.mtimeMs) continue;
      seen.add(id);
      scanIndex.set(id, { file: fp, info: c.info, mtime: st.mtimeMs });
    }
  }
  for (const id of [...scanIndex.keys()]) if (!seen.has(id)) scanIndex.delete(id);
}
function isScratch(cwd) { return /[\\/]AppData[\\/]/i.test(cwd || ''); }

// ---------- Claude Desktop metadata (archived / deleted flags, titles) ----------
// Desktop keeps one local_<id>.json per session (with cliSessionId, isArchived, title) and deleted_<cliId> markers.
const deskCache = new Map(); // file -> {mtimeMs, v}
const desk = { meta: new Map(), deleted: new Set() };
function deskRoots() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const ra = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const roots = [path.join(ra, 'Claude', 'claude-code-sessions')];
  for (const [base, sub] of [[path.join(la, 'Claude-Data'), 'claude-code-sessions'], [path.join(la, 'Packages'), path.join('LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')]]) {
    try { for (const d of fs.readdirSync(base)) if (/^claude/i.test(d)) roots.push(path.join(base, d, sub)); } catch {}
  }
  return roots.filter(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}
async function scanDesktop() {
  const meta = new Map(), deleted = new Set();
  const walk = async (dir, depth) => {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) await walk(fp, depth + 1); continue; }
      if (e.name.startsWith('deleted_')) { deleted.add(e.name.slice(8).replace(/\.json$/, '')); continue; }
      if (!/^local_.*\.json$/.test(e.name)) continue;
      let st; try { st = await fsp.stat(fp); } catch { continue; }
      let c = deskCache.get(fp);
      if (!c || c.mtimeMs !== st.mtimeMs) {
        let v = null;
        try { const o = JSON.parse(await fsp.readFile(fp, 'utf8')); if (o.cliSessionId) v = { id: o.cliSessionId, archived: !!o.isArchived, title: o.title || '' }; } catch {}
        c = { mtimeMs: st.mtimeMs, v }; deskCache.set(fp, c);
      }
      if (c.v) meta.set(c.v.id, c.v);
    }
  };
  for (const r of deskRoots()) await walk(r, 0);
  desk.meta = meta; desk.deleted = deleted;
}

async function listSessions() {
  await Promise.all([scanAll(), scanDesktop()]);
  const ids = new Set([...scanIndex.keys()]);
  for (const r of Object.values(store.sessions)) if (r.createdAt) ids.add(r.id);
  const out = [];
  for (const id of ids) {
    const s = scanIndex.get(id), r = store.sessions[id] || {}, info = (s && s.info) || {};
    const cwd = info.cwd || r.cwd || '';
    const dm = desk.meta.get(id);
    const archived = !!(dm && dm.archived) || desk.deleted.has(id);
    // where the session was started: Claude Desktop, or the CLI (PowerShell / this app)
    const source = r.createdAt ? 'cli' : (dm || info.entrypoint === 'claude-desktop') ? 'desktop' : 'cli';
    out.push({
      id, cwd,
      title: r.title || (dm && dm.title) || info.title || info.aiTitle || info.firstPrompt || r.autoTitle || '(新對話)',
      lastPrompt: info.lastPrompt || '',
      updatedAt: Math.max((s && s.mtime) || 0, r.updatedAt || 0, r.createdAt || 0),
      // archived/deleted in Claude Desktop => hidden by default; an explicit hide/unhide here wins
      pinned: !!r.pinned, hidden: r.hidden != null ? !!r.hidden : archived, archived, source, app: !!r.createdAt, scratch: isScratch(cwd),
      running: !!(runs.get(id) && runs.get(id).turnActive),
      model: r.model ?? null, effort: r.effort ?? null, permissionMode: r.permissionMode ?? null,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
function encodeCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
async function findFile(id) {
  const hit = scanIndex.get(id);
  if (hit && fs.existsSync(hit.file)) return hit.file;
  const r = store.sessions[id];
  if (r && r.cwd) { const fp = path.join(PROJECTS_DIR, encodeCwd(r.cwd), id + '.jsonl'); if (fs.existsSync(fp)) return fp; }
  await scanAll();
  const h2 = scanIndex.get(id);
  return h2 ? h2.file : null;
}
function sessionCwd(id) {
  const s = scanIndex.get(id), r = store.sessions[id];
  return (s && s.info.cwd) || (r && r.cwd) || null;
}

// ---------- message simplification (shared by transcripts and live stream) ----------
function truncStr(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…(已截斷，共 ${s.length} 字)` : s; }
function truncDeep(v, n = 12000) {
  if (typeof v === 'string') return truncStr(v, n);
  if (Array.isArray(v)) return v.map(x => truncDeep(x, n));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = truncDeep(v[k], n); return o; }
  return v;
}
function imgSrc(src) {
  if (!src) return null;
  if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
  if (src.type === 'url' && src.url) return src.url;
  return null;
}
// Claude Code's own notices about background work (subagents, background commands, Monitor events) arrive as user
// messages made of <task-notification> XML. Turn them into a "task" message the page shows as a small card.
function taskNotes(text) {
  const out = [];
  for (const m of String(text).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = n => { const x = m[1].match(new RegExp('<' + n + '>([\\s\\S]*?)</' + n + '>')); return x ? x[1].trim() : ''; };
    out.push({ id: tag('task-id'), status: tag('status'), summary: truncStr(tag('summary'), 2000), result: truncStr(tag('result'), 4000), event: truncStr(tag('event'), 1000) });
  }
  return out;
}
const TASK_LIMIT = /rate.?limit|hit your [\w-]+ limit|usage limit|\b429\b/i;
function simplify(role, content, ts, uuid) {
  const blocks = [];
  if (role === 'user') {
    const raw = typeof content === 'string' ? content
      : Array.isArray(content) && content.length && content.every(b => b && b.type === 'text') ? content.map(b => b.text).join('\n') : null;
    if (raw && /^\s*<task-notification>/.test(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''))) {
      const notes = taskNotes(raw);
      if (notes.length) return { role: 'task', notes, blocks: [], limit: notes.some(n => n.status === 'failed' && TASK_LIMIT.test(n.summary)), ts, uuid: uuid || crypto.randomUUID() };
    }
  }
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (!b) continue;
    switch (b.type) {
      case 'text': { const t = role === 'user' ? cleanUserText(b.text) : String(b.text || ''); if (t.trim()) blocks.push({ type: 'text', text: t }); break; }
      case 'image': { const s = imgSrc(b.source); if (s) blocks.push({ type: 'image', src: s }); break; }
      case 'thinking': if (b.thinking && b.thinking.trim()) blocks.push({ type: 'thinking', text: b.thinking }); break;
      case 'tool_use': case 'server_tool_use': blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: truncDeep(b.input || {}) }); break;
      case 'tool_result': {
        const r = { type: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: '', images: [] };
        const c = b.content;
        if (typeof c === 'string') r.text = c;
        else if (Array.isArray(c)) for (const x of c) {
          if (x.type === 'text') r.text += (r.text ? '\n' : '') + x.text;
          else if (x.type === 'image') { const s = imgSrc(x.source); if (s) r.images.push(s); }
        }
        r.text = truncStr(r.text, 20000);
        blocks.push(r); break;
      }
    }
  }
  if (!blocks.length) return null;
  return { role, blocks, ts, uuid: uuid || crypto.randomUUID() };
}
function fromEntry(o) {
  if (o.type === 'system') return { role: 'system', text: '— 對話已壓縮 (compact) —', ts: o.timestamp, uuid: o.uuid };
  if (o.isMeta) return null;
  if (o.isCompactSummary) return null;
  const m = o.message; if (!m) return null;
  return simplify(m.role || o.type, m.content, o.timestamp, o.uuid);
}
async function loadTranscript(fp, limit) {
  let text;
  try { text = limit != null ? await readSlice(fp, 0, limit) : await fsp.readFile(fp, 'utf8'); } catch { return { messages: [], ctx: null }; }
  const entries = parseLines(text, false, false);
  const by = new Map(); let last = null; const linear = [];
  for (const o of entries) {
    if (o.uuid) by.set(o.uuid, o);
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) { last = o; linear.push(o); }
  }
  // follow the active branch from the latest message back to the root (handles rewinds/compaction)
  const chain = []; const seen = new Set(); let cur = last;
  while (cur && !seen.has(cur.uuid)) { seen.add(cur.uuid); chain.push(cur); const p = cur.parentUuid || cur.logicalParentUuid; cur = p ? by.get(p) : null; }
  chain.reverse();
  const chainMsgs = chain.filter(o => o.type === 'user' || o.type === 'assistant' || (o.type === 'system' && o.subtype === 'compact_boundary'));
  const use = chainMsgs.filter(o => o.type !== 'system').length >= linear.length * 0.5 ? chainMsgs : linear;
  const out = [];
  for (const o of use) { const m = fromEntry(o); if (m) out.push(m); }
  return { messages: out, ctx: ctxFromEntries(use) };
}

// ---------- context length (how much of the model's context window the session uses) ----------
// = what the latest main-thread API call sent as input: input + cache read + cache creation tokens.
function ctxUsed(u) { return u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0; }
function ctxFromEntries(entries) {
  let ctx = null;
  for (const o of entries) {
    if (o.type === 'assistant' && o.message && o.message.usage && o.message.model !== '<synthetic>') {
      const n = ctxUsed(o.message.usage); if (n) ctx = { used: n, model: o.message.model || null };
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const cm = o.compactMetadata || {};
      ctx = { used: cm.postTokens || null, model: ctx && ctx.model, compacted: true };
    }
  }
  return ctx;
}
const baseModel = m => String(m || '').replace(/\[.*\]$/, '').toLowerCase();
function ctxWindow(id, model) {
  const r = store.sessions[id];
  if (r && r.ctxWin && r.ctxWin.window && (!model || baseModel(r.ctxWin.model) === baseModel(model))) return r.ctxWin.window;
  if (model && store.ctxWindows[model]) return store.ctxWindows[model];
  if (model && /\[1m\]$/i.test(model)) return 1000000;
  return null; // unknown: the UI then shows only the used tokens
}
function withWindow(id, ctx) { return ctx ? { ...ctx, window: ctxWindow(id, ctx.model) } : null; }
function setRunCtx(run, ctx) { run.ctx = ctx; broadcast({ type: 'ctx', sid: run.id, ctx: withWindow(run.id, ctx) }); }
function learnWindow(run, modelUsage) {
  const ents = Object.entries(modelUsage || {}).filter(([, v]) => v && v.contextWindow);
  if (!ents.length) return;
  const want = [run.initModel, run.ctx && run.ctx.model].filter(Boolean);
  const hit = ents.find(([k]) => want.includes(k)) || ents.find(([k]) => want.some(w => baseModel(w) === baseModel(k))) ||
    ents.sort((a, b) => ((b[1].inputTokens || 0) + (b[1].cacheReadInputTokens || 0)) - ((a[1].inputTokens || 0) + (a[1].cacheReadInputTokens || 0)))[0];
  for (const [k, v] of ents) store.ctxWindows[k] = v.contextWindow;
  rec(run.id).ctxWin = { model: hit[0], window: hit[1].contextWindow };
  saveStore();
}

// ---------- running claude processes ----------
const runs = new Map(); // session id -> run
// ---------- accounts (主帳號 = CLI login, 副帳號 = setup-token tokens): see accounts.js ----------
const ACC = require('./accounts')({ store, saveStore, log, broadcast: (...x) => broadcast(...x), cleanEnv: () => cleanEnv(), claude: CLAUDE, killTree: pid => killTree(pid) });
function cleanEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k === 'CLAUDECODE' || /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|SESSION|PARENT|CHILD)/i.test(k) || /^CLAUDE_AGENT_SDK/i.test(k)) delete e[k];
  return e;
}
function setActivity(run, text) { run.activity = text; broadcast({ type: 'activity', sid: run.id, text }); }
function writeCtl(run, obj) { try { run.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }

// opts.acct: start claude on this account instead of the one in use (used to compact on the previous account)
async function sendMessage(id, text, images, opts = {}) {
  const r = rec(id);
  if (!r.cwd) r.cwd = sessionCwd(id);
  if (!r.cwd || !fs.existsSync(r.cwd)) throw new Error('工作資料夾不存在: ' + (r.cwd || '(未設定)'));
  const content = [];
  for (const im of images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
  if (text) content.push({ type: 'text', text });
  if (!content.length) throw new Error('空白訊息');
  const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: id }) + '\n';
  const liveMsg = simplify('user', content, new Date().toISOString());
  if (!r.title && !r.autoTitle && text) r.autoTitle = text.slice(0, 80);
  r.updatedAt = Date.now(); saveStore();

  let run = runs.get(id);
  // claude's input was already closed (its process is on the way out): give it a moment to exit, then start fresh.
  // If it is still alive after that, something keeps it busy: send this once it has exited instead of losing it.
  if (run && !run.exited && run.inputClosed) {
    await Promise.race([run.closed, new Promise(r => setTimeout(r, 5000))]);
    run = runs.get(id);
    if (run && !run.exited) {
      run.afterExit.push({ text, images });
      broadcast({ type: 'notice', sid: id, text: 'Claude 這個對話的程式還在結束中，這則訊息會在它結束後自動送出' });
      return { deferred: true };
    }
  }
  if (run && !run.exited) {
    // still on the account it was started with (the user switched since): say so, it is easy to miss
    if (run.acct !== ACC.active())
      broadcast({ type: 'notice', sid: id, text: `這則訊息仍用${ACC.fullName(run.acct)}送出：這個對話的程式還在執行（${run.turnActive ? '這一輪還沒結束' : '有背景工作'}），要等它結束或按停止後，才會改用目前選的${ACC.fullName(ACC.active())}` });
    // claude's process is still alive: write it in right away, like the Desktop app does.
    // - mid-turn: claude picks it up as soon as the current step finishes and answers within the same turn (插話)
    // - turn over but the process lives on (e.g. a background task is running): it starts a new turn at once
    clearTimeout(run.idleTimer);
    const injecting = run.turnActive;
    run.written++; run.pending.push(liveMsg.uuid); run.live.push(liveMsg);
    try { run.proc.stdin.write(userLine); } catch {}
    if (!injecting) markActive(run);
    broadcast({ type: 'msg', sid: id, msg: liveMsg, injected: injecting });
    return;
  }
  const fp = await findFile(id);
  const acct = opts.acct || ACC.active(), env = await ACC.env(acct);
  r.lastAcct = acct; r.lastAcctAt = Date.now(); // which account this conversation last ran on (see compactCheck)
  const exists = !!fp && fs.existsSync(fp);
  const startOffset = exists ? (await fsp.stat(fp)).size : 0;
  // --replay-user-messages: claude echoes each message we write once it actually takes it in, so we know when
  // everything sent mid-turn has been consumed and the input can be closed.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio'];
  args.push(exists ? '--resume' : '--session-id', id);
  // A session with no setting of its own (e.g. one started in the CLI or Desktop) uses the app defaults —
  // the same values the selectors show. Without this, claude fell back to its own default ("ask every time").
  const model = r.model != null ? r.model : store.prefs.model;
  const effort = r.effort != null ? r.effort : store.prefs.effort;
  // only two modes are offered: Auto and 略過所有權限; anything older (manual, acceptEdits, plan) runs as Auto
  const PERM_MODES = ['auto', 'bypassPermissions'];
  const permissionMode = PERM_MODES.includes(r.permissionMode) ? r.permissionMode : PERM_MODES.includes(store.prefs.permissionMode) ? store.prefs.permissionMode : 'auto';
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  args.push('--permission-mode', permissionMode);
  log('spawn', r.cwd, acct === ACC.MAIN ? '' : '[account ' + ACC.label(acct) + ']', args.join(' '));
  const proc = spawn(CLAUDE_BIN, CLAUDE.pre.concat(args), { cwd: r.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // turnActive: a turn is in progress (what the UI shows as "running"). The process can outlive a turn while
  // background tasks (run_in_background, Monitor…) keep going; bgTasks mirrors claude's own list of them.
  run = { id, proc, acct, live: [liveMsg], partial: '', perms: new Map(), written: 1, consumed: 0, pending: [liveMsg.uuid], startOffset, file: exists ? fp : null,
    startedAt: Date.now(), activity: '啟動中…', stderr: '', exited: false, gotResult: false, stopped: false,
    turnActive: true, bgTasks: [], afterExit: [] };
  run.closed = new Promise(res => { run.resolveClosed = res; });
  runs.set(id, run);
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handleLine(run, line); }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => { run.stderr = (run.stderr + d).slice(-4000); });
  proc.stdin.on('error', () => {});
  proc.on('error', e => { run.stderr += '\n' + e.message; finish(run, -1); });
  proc.on('close', code => finish(run, code));
  proc.stdin.write(userLine);
  broadcast({ type: 'msg', sid: id, msg: liveMsg });
  broadcast({ type: 'status', sid: id, running: true, startedAt: run.startedAt });
  broadcast({ type: 'sessions' });
}

// ---------- slash commands ----------
// The command list comes from claude itself: the SDK "initialize" control request answers with every command
// available in print mode (built-ins, skills, plugins) without calling the model.
const CMD_HIDE = new Set(['color', 'focus', 'heapdump', 'fast', 'agents', 'extra-usage', 'workflow-launch-exec', 'design-consent', 'design-revoke']);
const cmdCache = new Map(); // lower-cased cwd -> { at, list } | { pending }
function probeCommands(cwd) {
  return new Promise(resolve => {
    const p = spawn(CLAUDE_BIN, CLAUDE.pre.concat(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']), { cwd, env: cleanEnv(), windowsHide: true });
    let buf = '', done = false;
    const end = list => { if (done) return; done = true; clearTimeout(timer); try { p.kill(); } catch {} resolve(list); };
    const timer = setTimeout(() => end(null), 30000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type === 'control_response' && o.response && o.response.request_id === 'cc-init') {
          const cmds = ((o.response.response || {}).commands || [])
            .filter(c => c && c.name && !c.name.startsWith('__') && !CMD_HIDE.has(c.name) && !/^\((removed)\)|^Renamed/i.test(c.description || ''))
            .map(c => ({ name: c.name, description: String(c.description || ''), argumentHint: String(c.argumentHint || '') }));
          end(cmds);
        }
      }
    });
    p.on('error', () => end(null));
    p.on('close', () => end(null));
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cc-init', request: { subtype: 'initialize' } }) + '\n');
  });
}
async function getCommands(cwd) {
  const key = cwd.toLowerCase(), c = cmdCache.get(key);
  if (c && c.list && Date.now() - c.at < 10 * 60000) return c.list;
  if (c && c.pending) return c.pending;
  const pending = probeCommands(cwd).then(list => {
    if (list) cmdCache.set(key, { at: Date.now(), list }); else cmdCache.delete(key);
    return list || (c && c.list) || [];
  });
  cmdCache.set(key, { ...(c || {}), pending });
  return pending;
}

// One-off claude run that never touches the session: it reads a copy of it (--fork-session) and saves nothing
// (--no-session-persistence). Used for /btw side questions and for /usage, /context output.
const LOCAL_CMDS = /^\/(usage|context)\s*$/;
async function runSide(b) {
  const sid = b.sid && UUID_RE.test(b.sid) ? b.sid.toLowerCase() : null;
  const r = (sid && store.sessions[sid]) || {};
  let cwd = (sid && (r.cwd || sessionCwd(sid))) || (b.cwd ? path.resolve(normPath(b.cwd)) : null);
  if (!cwd || !fs.existsSync(cwd)) throw new Error('工作資料夾不存在: ' + (cwd || '(未設定)'));
  const fp = sid ? await findFile(sid) : null;
  const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (fp) args.push('--resume', sid, '--fork-session');
  let prompt, timeoutMs;
  if (b.kind === 'btw') {
    if (!fp) throw new Error('這個對話還沒有內容，/btw 要在已經開始的對話裡使用');
    if (!String(b.text || '').trim()) throw new Error('用法：/btw 你的問題');
    if (r.model) args.push('--model', r.model);
    if (r.effort) args.push('--effort', r.effort);
    args.push('--tools', '');
    prompt = '[旁支提問 /btw：這是我在對話進行中順便問的問題。請根據目前為止的對話內容簡短回答；不要使用工具，也不要繼續或改變原本進行中的工作。]\n\n' + b.text;
    timeoutMs = 5 * 60000;
  } else {
    prompt = String(b.text || '').trim();
    if (!LOCAL_CMDS.test(prompt)) throw new Error('不支援的指令: ' + prompt);
    timeoutMs = 90000;
  }
  log('side', b.kind, cwd, args.join(' '));
  const acct = ACC.active(), env = await ACC.env(acct);
  return new Promise(resolve => {
    const p = spawn(CLAUDE_BIN, CLAUDE.pre.concat(args), { cwd, env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { err += '\n逾時，已中止'; killTree(p.pid); }, timeoutMs);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', e => { err += '\n' + e.message; });
    p.on('close', code => {
      clearTimeout(timer);
      let o = null; try { o = JSON.parse(out.trim().split('\n').pop()); } catch {}
      const r = o ? { text: String(o.result || (o.errors || []).join('\n') || ''), isError: !!o.is_error, durationMs: o.duration_ms, usage: o.usage }
        : { isError: true, text: (err.trim() || out.trim() || `claude 結束 (code ${code})`).slice(-3000) };
      if (r.isError && b.kind === 'btw') ACC.onError(acct, r.text, sid); else if (!r.isError && b.kind === 'btw') ACC.onSuccess(acct);
      resolve(r);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}

// A turn starts (our message, or claude reporting a finished background task on its own) / ends (its result).
function markActive(run) {
  if (run.turnActive || run.exited) return;
  run.turnActive = true; run.startedAt = Date.now(); clearTimeout(run.idleTimer);
  setActivity(run, '執行中…');
  broadcast({ type: 'status', sid: run.id, running: true, startedAt: run.startedAt });
  broadcast({ type: 'sessions' });
}
function markIdle(run) {
  if (!run.turnActive) return;
  run.turnActive = false;
  const r = rec(run.id); r.updatedAt = Date.now(); saveStore();
  broadcast({ type: 'status', sid: run.id, running: false, bg: run.bgTasks.length });
  broadcast({ type: 'sessions' });
}
// Idle with nothing left to take in: let the process end — unless background tasks still run in it. Then keep its
// input open, so a new message starts a turn right away and claude can report when the task finishes.
function maybeCloseInput(run) {
  if (run.exited || run.inputClosed || run.turnActive || run.consumed < run.written) return;
  clearTimeout(run.idleTimer);
  if (run.stopped || !run.bgTasks.length) closeInput(run);
  else setActivity(run, `背景工作執行中（${run.bgTasks.length}）`);
}

function handleLine(run, line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  const sid = run.id;
  switch (o.type) {
    case 'stream_event': {
      if (o.parent_tool_use_id) return;
      markActive(run);
      const ev = o.event || {};
      if (ev.type === 'content_block_start') {
        run.partial = '';
        const bt = ev.content_block && ev.content_block.type;
        if (bt === 'thinking') setActivity(run, '思考中…');
        else if (bt === 'text') setActivity(run, '回覆中…');
        else if (bt === 'tool_use') setActivity(run, '準備 ' + ev.content_block.name + '…');
        broadcast({ type: 'delta', sid, reset: true });
      } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        run.partial += ev.delta.text;
        broadcast({ type: 'delta', sid, text: ev.delta.text });
      }
      return;
    }
    case 'assistant': case 'user': {
      if (o.isReplay && !o.parent_tool_use_id) { // claude took in one of the messages we wrote (in order)
        run.consumed++;
        const uuid = run.pending.shift();
        if (uuid) broadcast({ type: 'consumed', sid, uuid });
        if (run.consumed > 1) setActivity(run, '已收到你插入的訊息…');
        return;
      }
      if (o.parent_tool_use_id || o.isReplay || !o.message) return;
      markActive(run);
      if (o.type === 'assistant' && o.message.usage && o.message.model !== '<synthetic>') {
        const n = ctxUsed(o.message.usage);
        if (n && (!run.ctx || run.ctx.used !== n || run.ctx.model !== o.message.model)) setRunCtx(run, { used: n, model: o.message.model || null });
      }
      const m = simplify(o.message.role || o.type, o.message.content, new Date().toISOString(), o.uuid);
      if (!m) return;
      if (o.type === 'assistant') {
        run.partial = '';
        const tu = m.blocks.find(b => b.type === 'tool_use'); if (tu) setActivity(run, '執行 ' + tu.name + '…');
      }
      run.live.push(m);
      broadcast({ type: 'msg', sid, msg: m });
      // a background subagent stopped because the account ran out of quota: same warning as a failed turn
      if (m.role === 'task' && m.limit) ACC.onError(run.acct, m.notes.find(n => TASK_LIMIT.test(n.summary)).summary, sid);
      return;
    }
    case 'control_request': {
      const q = o.request || {};
      if (q.subtype === 'can_use_tool') {
        const p = { requestId: o.request_id, toolName: q.tool_name, input: q.input || {}, description: q.description || '', suggestions: q.permission_suggestions || null, toolUseId: q.tool_use_id };
        run.perms.set(o.request_id, p);
        setActivity(run, '等待你的許可…');
        broadcast({ type: 'perm', sid, perm: p });
      } else {
        writeCtl(run, { type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: 'unsupported by CLI Controller' } });
      }
      return;
    }
    case 'control_cancel_request':
      run.perms.delete(o.request_id); broadcast({ type: 'permDone', sid, requestId: o.request_id }); return;
    case 'result': {
      run.gotResult = true; run.partial = '';
      rec(run.id).lastAcctAt = Date.now(); // its prompt cache on this account is fresh from here
      // (total_cost_usd is deliberately not passed on: on a Max plan the dollar figure means nothing)
      const res = { isError: !!o.is_error, subtype: o.subtype, durationMs: o.duration_ms, usage: o.usage,
        text: o.is_error ? (o.result || (o.errors || []).join('\n') || o.subtype || '') : '' };
      if (run.stopped) { res.isError = false; res.stopped = true; }
      broadcast({ type: 'result', sid, result: res, ts: Date.now() });
      // out of quota / token rejected: the account module warns and explains (and marks the account)
      if (res.isError && !res.stopped) {
        // an account problem while background tasks keep this process (and its account) alive: switching alone won't help
        if (ACC.onError(run.acct, res.text, sid) && run.bgTasks.length)
          broadcast({ type: 'notice', sid, text: `這個對話還有 ${run.bgTasks.length} 個背景工作在跑，程式不會結束，之後送出的訊息仍會用${ACC.fullName(run.acct)}。要換帳號重送，請先按停止（背景工作會中斷）。` });
      } else if (!res.isError) ACC.onSuccess(run.acct);
      // the result tells us about the login: a success while we think we're logged out, or an auth error → re-check
      if ((!res.isError && authInfo && !authInfo.loggedIn) || (res.isError && /log ?in|auth|401|unauthori|credential|token/i.test(res.text))) scheduleAuth(200);
      learnWindow(run, o.modelUsage);
      if (run.ctx) setRunCtx(run, run.ctx);
      // The turn is over once claude has taken in everything we wrote; a message that arrived just as the turn
      // ended is still waiting and claude runs another turn for it (the timer is a safety net for that case).
      if (run.stopped || run.consumed >= run.written) { markIdle(run); maybeCloseInput(run); if (run.stopped) closeInput(run); }
      else {
        setActivity(run, '處理你插入的訊息…');
        clearTimeout(run.idleTimer);
        run.idleTimer = setTimeout(() => { markIdle(run); maybeCloseInput(run); }, 120000);
      }
      return;
    }
    case 'rate_limit_event':
      if (o.rate_limit_info) ACC.onRate(run.acct, o.rate_limit_info, sid);
      return;
    case 'system':
      if (o.subtype === 'init') { run.initModel = o.model; broadcast({ type: 'init', sid, model: o.model, permissionMode: o.permissionMode }); }
      else if (o.subtype === 'task_summary' && o.detail) setActivity(run, o.detail);
      else if (o.subtype === 'compact_boundary') {
        const m = { role: 'system', text: '— 對話已壓縮 (compact) —', uuid: o.uuid || crypto.randomUUID() }; run.live.push(m); broadcast({ type: 'msg', sid, msg: m });
        const cm = o.compact_metadata || o.compactMetadata || {};
        setRunCtx(run, { used: cm.post_tokens || cm.postTokens || null, model: run.ctx && run.ctx.model, compacted: true });
      }
      else if (o.subtype === 'status' && o.status === 'compacting') setActivity(run, '壓縮對話中…');
      else if (o.subtype === 'background_tasks_changed') {
        run.bgTasks = Array.isArray(o.tasks) ? o.tasks : [];
        if (!run.turnActive) {
          if (run.bgTasks.length) setActivity(run, `背景工作執行中（${run.bgTasks.length}）`);
          // all background work done: claude usually starts a turn by itself to report it; give it time, then end
          else { clearTimeout(run.idleTimer); run.idleTimer = setTimeout(() => maybeCloseInput(run), 30000); }
        }
      }
      return;
  }
}

function closeInput(run) { run.inputClosed = true; try { run.proc.stdin.end(); } catch {} }
function finish(run, code) {
  if (run.exited) return;
  run.exited = true;
  if (run.resolveClosed) setImmediate(run.resolveClosed);
  clearTimeout(run.killTimer); clearTimeout(run.idleTimer);
  for (const rid of run.perms.keys()) broadcast({ type: 'permDone', sid: run.id, requestId: rid });
  runs.delete(run.id);
  if (!run.gotResult) {
    const res = run.stopped ? { stopped: true } : { isError: true, text: `claude 意外結束 (code ${code})\n${run.stderr.trim()}` };
    broadcast({ type: 'result', sid: run.id, result: res, ts: Date.now() });
    if (res.isError) ACC.onError(run.acct, res.text, run.id);
  }
  if (code && !run.stopped) log('claude exit', code, run.stderr.slice(-800));
  const r = rec(run.id); r.updatedAt = Date.now(); saveStore();
  broadcast({ type: 'status', sid: run.id, running: false });
  broadcast({ type: 'sessions' });
  // messages that arrived while this process was on its way out
  if (run.afterExit.length) (async () => { for (const m of run.afterExit) { try { await sendMessage(run.id, m.text, m.images); } catch (e) { log('afterExit send failed', e.message); } } })();
}

function stopRun(id) {
  const run = runs.get(id); if (!run) return false;
  run.stopped = true; clearTimeout(run.idleTimer);
  for (const rid of run.perms.keys()) {
    writeCtl(run, { type: 'control_response', response: { subtype: 'success', request_id: rid, response: { behavior: 'deny', message: '使用者已停止', interrupt: true } } });
    broadcast({ type: 'permDone', sid: id, requestId: rid });
  }
  run.perms.clear();
  writeCtl(run, { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } });
  setActivity(run, '停止中…');
  run.killTimer = setTimeout(() => { if (!run.exited) killTree(run.proc.pid); }, 5000);
  return true;
}
// What switching to account `to` would leave behind: every claude process still alive on another account.
// A running turn finishes there (and messages sent into it mid-turn use it too); a process kept alive by
// background tasks keeps taking new messages on its old account until it is stopped.
function switchImpact(to) {
  const title = id => { const r = store.sessions[id] || {}; return r.title || r.autoTitle || id.slice(0, 8); };
  const list = [];
  for (const r of runs.values()) {
    if (r.exited || r.acct === to || (r.inputClosed && !r.turnActive)) continue; // already on its way out
    list.push({ sid: r.id, title: title(r.id), acct: ACC.fullName(r.acct), turnActive: !!r.turnActive, bgTasks: r.bgTasks.length });
  }
  return { from: ACC.fullName(ACC.active()), to: ACC.fullName(to), target: ACC.status(to), runs: list };
}
function killTree(pid) { if (!pid) return; try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
// Stop every claude we started, save the store, and end this process — used by the 關閉/重啟後端 buttons and by a
// takeover. killTree detaches taskkill, so the tree is still taken down after process.exit returns.
function hardExit() {
  for (const r of runs.values()) { try { r.stopped = true; killTree(r.proc.pid); } catch {} }
  flushStore();
  process.exit(0);
}
// Start a fresh copy of the current server.js detached (so it outlives us). Used by 重啟後端: the new process reads
// the code on disk now, so this is also the reliable way to pick up a new version without relaunching start.vbs.
function respawnSelf(extraArgs) {
  try {
    const p = spawn(process.execPath, [path.join(APP_DIR, 'server.js'), ...(extraArgs || [])],
      { cwd: APP_DIR, env: process.env, detached: true, windowsHide: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch (e) { log('respawn failed', e.message); return false; }
}

function answerPerm(id, requestId, a) {
  const run = runs.get(id); const p = run && run.perms.get(requestId);
  if (!p) return false;
  let resp;
  if (a.allow) {
    let input = p.input;
    if (a.answers) input = { ...input, answers: a.answers };
    resp = { behavior: 'allow', updatedInput: input };
    if (a.always && Array.isArray(p.suggestions) && p.suggestions.length) resp.updatedPermissions = p.suggestions;
    if (p.toolName === 'ExitPlanMode') { const r = rec(id); if (r.permissionMode === 'plan') { r.permissionMode = 'auto'; saveStore(); broadcast({ type: 'sessions' }); } }
  } else {
    resp = { behavior: 'deny', message: a.message ? '使用者拒絕: ' + a.message : '使用者拒絕了這個操作' };
  }
  writeCtl(run, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: resp } });
  run.perms.delete(requestId);
  setActivity(run, '執行中…');
  broadcast({ type: 'permDone', sid: id, requestId });
  return true;
}

async function getMessages(id) {
  const run = runs.get(id);
  let messages = [], ctx = null;
  if (run) { if (run.file) ({ messages, ctx } = await loadTranscript(run.file, run.startOffset)); messages = messages.concat(run.live); if (run.ctx) ctx = run.ctx; }
  else { const fp = await findFile(id); if (fp) ({ messages, ctx } = await loadTranscript(fp)); }
  return { messages, ctx: withWindow(id, ctx), running: !!(run && run.turnActive), partial: run ? run.partial : '', activity: run ? run.activity : '', startedAt: run ? run.startedAt : null,
    perms: run ? [...run.perms.values()] : [], cwd: sessionCwd(id) };
}

// ---------- compact on the previous account before continuing on another one ----------
// Continuing a long conversation on another account makes that account read the whole context once (the prompt
// cache belongs to the account it was built on). Compacting first on the account the conversation last ran on —
// while that one still has quota — leaves only a short summary for the new account to read.
// Offered only when: nothing is running in it, it last ran here on a different account that is usable and not
// (nearly) out of quota, and its context is long. Unknown history (e.g. started in the CLI) → not offered.
const COMPACT_MIN = 60000; // tokens of context below which compacting is not worth asking about
// How long the previous account keeps the conversation in its prompt cache. Past this, compacting there means a full
// re-read on that account too, so it is not offered. Claude Code on a subscription uses a 1-hour cache (5 minutes on
// some setups); 1 hour is used so a still-cached conversation is never skipped.
const CACHE_TTL_MS = 60 * 60000;
async function compactCheck(id) {
  const no = { suggest: false };
  const r = store.sessions[id], run = runs.get(id);
  if (!r || (run && !run.exited)) return no;
  const from = r.lastAcct, to = ACC.active();
  if (!from || from === to || !ACC.exists(from) || ACC.status(from).code !== 'ok') return no;
  if (!r.lastAcctAt || Date.now() - r.lastAcctAt > CACHE_TTL_MS) return no; // its cache has expired: nothing to save
  const rt = ACC.rate(from), wins = rt && (rt.unifiedWindows || {});
  if (wins && Object.values(wins).some(w => w && (w.status === 'rejected' || (w.utilization >= 0.97 && !(w.resetsAt && w.resetsAt * 1000 < Date.now()))))) return no;
  const fp = await findFile(id); if (!fp) return no;
  const { ctx } = await loadTranscript(fp);
  if (!ctx || !ctx.used || ctx.used < COMPACT_MIN) return no;
  return { suggest: true, from: ACC.fullName(from), to: ACC.fullName(to), fromId: from, tokens: ctx.used, lastAt: r.lastAcctAt || null };
}
// Compact on the previous account, then send the message on the account in use (queued in afterExit: it goes out
// when the compacting claude has exited, whether compacting worked or not).
async function sendWithCompact(id, text, images) {
  const c = await compactCheck(id);
  if (!c.suggest) return sendMessage(id, text, images);
  log('compact before switch', id, c.from, '->', c.to, c.tokens);
  await sendMessage(id, '/compact', [], { acct: c.fromId });
  const run = runs.get(id);
  if (!run || run.exited) return sendMessage(id, text, images);
  run.afterExit.push({ text, images });
  broadcast({ type: 'notice', sid: id, text: `先用${c.from}壓縮這段對話（約 ${Math.round(c.tokens / 1000)}k tokens），完成後會自動用${c.to}送出你的訊息` });
  return { compacting: true };
}

// ---------- OS helpers ----------
function findBrowser() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', pf = process.env.ProgramFiles || 'C:\\Program Files', la = process.env.LOCALAPPDATA || '';
  const c = [path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(la, 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'), path.join(la, 'Google\\Chrome\\Application\\chrome.exe')];
  return c.find(p => { try { return fs.existsSync(p); } catch { return false; } });
}
// 視窗最上面那條標題列是 Edge／Chrome 自己畫的，顏色由「瀏覽器設定檔」的外觀偏好決定（網頁的 theme-color 和 DWM 都改不動它）。
// 開視窗前把設定檔的 browser.theme.color_scheme2 寫成目前主題（0 跟隨系統／1 淺色／2 深色），開出來的標題列就是對的顏色。
// 只在開窗時生效；這個設定檔的瀏覽器還開著時寫入會被它蓋回去，所以換主題後要關掉視窗再開。
function applyWindowScheme() {
  try {
    const dir = path.join(DATA_DIR, 'browser-profile', 'Default'), f = path.join(dir, 'Preferences');
    let j = {}; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    const v = { system: 0, light: 1, dark: 2 }[store.prefs.windowTheme];
    j.browser = j.browser || {}; j.browser.theme = j.browser.theme || {};
    const want = v == null ? 0 : v;
    j.profile = j.profile || {};
    const same = j.browser.theme.color_scheme2 === want && j.profile.exit_type === 'Normal';
    if (same) return;
    j.browser.theme.color_scheme2 = want;
    j.profile.exit_type = 'Normal'; j.profile.exited_cleanly = true; // 重開視窗時不要跳「還原頁面」
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(j));
  } catch (e) { log('window scheme failed', e.message); }
}
// 換主題後「重開視窗」：先請這個設定檔的瀏覽器正常關閉（逾時才強制結束），再照新主題寫入設定檔、開新視窗。
// 對話內容都在伺服器，重開不會掉；只有輸入框裡還沒送出的草稿會不見。
function reopenWindow() {
  const profile = path.join(DATA_DIR, 'browser-profile');
  const ps = `
$ProgressPreference = 'SilentlyContinue'
$prof = $env:CC_PROFILE
$all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -like ('*' + $prof + '*') })
$main = @($all | Where-Object { $_.CommandLine -notlike '*--type=*' })
foreach ($m in $main) { $p = Get-Process -Id $m.ProcessId -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() } }
$until = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $until -and @($main | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -gt 0) { Start-Sleep -Milliseconds 200 }
foreach ($a in $all) { Stop-Process -Id $a.ProcessId -Force -ErrorAction SilentlyContinue }
exit 0`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(ps)],
    { env: { ...process.env, CC_PROFILE: profile }, windowsHide: true, timeout: 20000 },
    (err) => { if (err) log('reopen: close failed', err.message); setTimeout(openWindow, 400); });
}
function openWindow() {
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  const b = findBrowser();
  if (b) applyWindowScheme();
  if (b) spawn(b, ['--app=' + url, '--user-data-dir=' + path.join(DATA_DIR, 'browser-profile'), '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
function psEncoded(script) { return Buffer.from(script, 'utf16le').toString('base64'); }
function pickFolder(initial) {
  // Modern Explorer-style dialog: an OpenFileDialog that accepts a folder ("Folder Selection" trick)
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$w = New-Object System.Windows.Forms.Form
$w.TopMost = $true; $w.ShowInTaskbar = $false; $w.Opacity = 0; $w.StartPosition = 'CenterScreen'; $w.Show(); $w.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.ValidateNames = $false; $d.CheckFileExists = $false; $d.CheckPathExists = $true
$d.FileName = '選擇此資料夾'
$d.Title = '選擇工作資料夾 (進入資料夾後按「開啟」)'
if ($env:CC_INIT -and (Test-Path -LiteralPath $env:CC_INIT)) { $d.InitialDirectory = $env:CC_INIT }
if ($d.ShowDialog($w) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output (Split-Path -Parent $d.FileName) }
$w.Close()`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', psEncoded(ps)],
      { env: { ...process.env, CC_INIT: initial || '' }, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(((out || '').trim().split(/\r?\n/).pop() || '').trim() || null));
  });
}
function pickFile(initial) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$w = New-Object System.Windows.Forms.Form
$w.TopMost = $true; $w.ShowInTaskbar = $false; $w.Opacity = 0; $w.StartPosition = 'CenterScreen'; $w.Show(); $w.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '選擇要瀏覽的網頁檔案'
$d.Filter = '網頁檔案 (*.html;*.htm;*.svg)|*.html;*.htm;*.svg|所有檔案 (*.*)|*.*'
if ($env:CC_INIT -and (Test-Path -LiteralPath $env:CC_INIT)) { $d.InitialDirectory = $env:CC_INIT }
if ($d.ShowDialog($w) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
$w.Close()`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', psEncoded(ps)],
      { env: { ...process.env, CC_INIT: initial || '' }, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(((out || '').trim().split(/\r?\n/).pop() || '').trim() || null));
  });
}
// Move files/folders to the Windows Recycle Bin (recoverable), not a permanent delete.
function toRecycleBin(paths) {
  const ps = `
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = $env:CC_PATHS | ConvertFrom-Json
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
}`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(ps)],
      { env: { ...process.env, CC_PATHS: JSON.stringify(paths) }, windowsHide: true, encoding: 'utf8', timeout: 60000 },
      (err, out, stderr) => {
        const left = paths.filter(p => fs.existsSync(p));
        if (left.length) reject(new Error('無法移到資源回收筒: ' + left.join(', ') + (stderr ? '\n' + stderr.trim() : '')));
        else resolve();
      });
  });
}
async function deleteSession(id) {
  if (runs.has(id)) throw new Error('這個對話正在執行，請先按停止再刪除');
  const fp = await findFile(id);
  const targets = [];
  if (fp && fp.startsWith(PROJECTS_DIR + path.sep) && path.basename(fp) === id + '.jsonl') {
    targets.push(fp);
    const dir = fp.slice(0, -'.jsonl'.length); // <id>/ next to the transcript: subagents, tool results
    if (fs.existsSync(dir)) targets.push(dir);
  }
  if (targets.length) await toRecycleBin(targets);
  if (fp) scanCache.delete(fp);
  scanIndex.delete(id);
  delete store.sessions[id]; saveStore();
  log('deleted session', id, targets.join(' | '));
  broadcast({ type: 'sessions' });
  return { deleted: targets };
}
function openConsole(cwd, command, env = cleanEnv()) {
  // `start` gives the PowerShell window its own visible console. Only fixed strings + a UUID go on the command line.
  spawn('cmd.exe', [`/c start "Claude" powershell.exe -NoExit -Command "${command}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore', env }).unref();
}
let authInfo = null, authAt = 0, authPending = null;
function refreshAuth() {
  if (authPending) return authPending;
  authPending = new Promise(resolve => {
    execFile(CLAUDE_BIN, CLAUDE.pre.concat(['auth', 'status']), { env: cleanEnv(), windowsHide: true, encoding: 'utf8', timeout: 20000 }, (err, out) => {
      const prev = authInfo && authInfo.loggedIn;
      try { authInfo = JSON.parse(out); } catch { authInfo = { loggedIn: false, error: (err && err.message) || 'unknown' }; }
      authAt = Date.now(); authPending = null;
      if (prev !== authInfo.loggedIn) log('auth', authInfo.loggedIn ? 'logged in ' + (authInfo.email || '') : 'not logged in');
      broadcast({ type: 'auth', auth: authInfo }); ACC.onCliAuth(authInfo); resolve(authInfo);
    });
  });
  return authPending;
}
// Logging in/out from any terminal (`claude auth login`, /login) rewrites ~/.claude/.credentials.json:
// watch it so the account shown here follows without pressing ↻. A slow periodic check covers the rest
// (e.g. credentials kept somewhere else).
let authWatchTimer = null;
function scheduleAuth(ms = 1500) { clearTimeout(authWatchTimer); authWatchTimer = setTimeout(refreshAuth, ms); }
try {
  fs.watch(CLAUDE_DIR, (ev, name) => { if (name && /^\.credentials\.json/i.test(String(name))) scheduleAuth(); });
} catch (e) { log('cannot watch', CLAUDE_DIR, e.message); }
setInterval(() => { if (clients.size) refreshAuth(); }, 5 * 60000);
function normPath(p) {
  p = String(p || '').trim().replace(/^file:\/\/\/?/i, '');
  try { p = decodeURIComponent(p); } catch {}
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/); // git-bash style /c/Users/...
  if (m) p = m[1] + ':\\' + m[2];
  return p;
}

// ---------- HTTP ----------
const clients = new Set();
let lastClientSeen = Date.now();
// set once 關閉/重啟後端 was pressed (or a replacement is taking over): /api/shutdown then quits even while runs wind down
let forceShutdown = false;
function broadcast(ev) { const s = 'data: ' + JSON.stringify(ev) + '\n\n'; for (const c of clients) { try { c.write(s); } catch {} } }
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }
function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
async function serveStatic(p, res) {
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fsp.readFile(fp);
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

const LH_TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
// /lh/<token>/<絕對路徑，例如 C:/Users/me/a.html>：唯讀，只送上面列的檔案類型（網頁、圖片、字型…），其他一律 415
async function serveLocalHtml(p, req, res) {
  const rest = p.slice(4), i = rest.indexOf('/');
  let tok = '', raw = '';
  try { tok = decodeURIComponent(i < 0 ? rest : rest.slice(0, i)); raw = i < 0 ? '' : decodeURIComponent(rest.slice(i + 1)); } catch { res.writeHead(400); return res.end('bad path'); }
  if (tok !== TOKEN) { res.writeHead(401); return res.end('unauthorized'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const fp = path.resolve(raw.replace(/\//g, '\\'));
  if (!/^[a-zA-Z]:\\/.test(fp)) { res.writeHead(404); return res.end('not found'); } // 只收磁碟機的絕對路徑（不收網路路徑 \\host）
  const type = LH_TYPES[path.extname(fp).toLowerCase()];
  if (!type) { res.writeHead(415); return res.end('unsupported type'); }
  let st; try { st = await fsp.stat(fp); } catch { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end('bad host'); }
    if (p.startsWith('/lh/')) return serveLocalHtml(p, req, res); // 瀏覽器分頁：本機網頁檔（網址第一段是權杖，相對路徑的圖片／CSS／JS 才找得到）
    if (!p.startsWith('/api/')) return serveStatic(p, res);
    if ((req.headers['x-token'] || u.searchParams.get('t')) !== TOKEN) { res.writeHead(401); return res.end('unauthorized'); }
    const M = req.method;

    if (p === '/api/events' && M === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      const running = [...runs.values()].filter(r => r.turnActive).map(r => ({ sid: r.id, startedAt: r.startedAt, activity: r.activity, perms: [...r.perms.values()] }));
      res.write('data: ' + JSON.stringify({ type: 'hello', running, rate: ACC.rate(ACC.active()), accounts: ACC.view(), auth: authInfo, version: APP_VERSION }) + '\n\n');
      req.on('close', () => { clients.delete(res); lastClientSeen = Date.now(); });
      if (Date.now() - authAt > 30000) refreshAuth(); // window opened/reloaded: make sure the account shown is current
      return;
    }
    if (p === '/api/init' && M === 'GET') return json(res, 200, { version: APP_VERSION, prefs: store.prefs, auth: authInfo, rate: ACC.rate(ACC.active()), accounts: ACC.view(), home: os.homedir(), sessions: await listSessions() });
    if (p === '/api/sessions' && M === 'GET') return json(res, 200, { sessions: await listSessions() });
    if (p === '/api/sessions' && M === 'POST') {
      const b = await readBody(req);
      const cwd = path.resolve(normPath(b.cwd));
      if (!b.cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return json(res, 400, { error: '資料夾不存在: ' + (b.cwd || '') });
      const id = crypto.randomUUID();
      const r = rec(id);
      Object.assign(r, { cwd, createdAt: Date.now(), updatedAt: Date.now(), model: b.model || '', effort: b.effort || '', permissionMode: b.permissionMode || store.prefs.permissionMode });
      store.prefs.lastCwd = cwd; saveStore();
      broadcast({ type: 'sessions' });
      return json(res, 200, { id, cwd });
    }
    if (p === '/api/commands' && M === 'GET') {
      const sid = u.searchParams.get('sid');
      const cwd = (sid && UUID_RE.test(sid) && sessionCwd(sid.toLowerCase())) || path.resolve(normPath(u.searchParams.get('cwd') || os.homedir()));
      if (!fs.existsSync(cwd)) return json(res, 200, { commands: [] });
      return json(res, 200, { commands: await getCommands(cwd) });
    }
    if (p === '/api/shutdown' && M === 'POST') { // a newer start of the app wants to take over
      // only a turn that is actually running blocks the restart; idle sessions keep their claude process around
      const busy = [...runs.values()].filter(r => r.turnActive).length;
      if (busy && !forceShutdown) return json(res, 409, { busy: true, running: busy });
      json(res, 200, { ok: true });
      log('shutting down: replaced by a new start');
      setTimeout(hardExit, 100);
      return;
    }
    // ⏻ 關閉後端 / ⟳ 重啟後端 (buttons next to ⚙). Only a turn actually replying counts as "busy"; a confirmation
    // for that is shown client-side and the retry comes back with force=1.
    if (p === '/api/server/stop' && M === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const force = b.force === true || u.searchParams.get('force') === '1';
      const busy = [...runs.values()].filter(r => r.turnActive).length;
      if (busy && !force) return json(res, 409, { busy: true, running: busy });
      forceShutdown = true;
      json(res, 200, { ok: true });
      log('stopping server (manual)');
      setTimeout(hardExit, 120);
      return;
    }
    if (p === '/api/server/restart' && M === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const force = b.force === true || u.searchParams.get('force') === '1';
      const busy = [...runs.values()].filter(r => r.turnActive).length;
      if (busy && !force) return json(res, 409, { busy: true, running: busy });
      forceShutdown = true; // let the new process take the port even while our claude processes are still dying
      json(res, 200, { ok: true, restarting: true });
      log('restarting: starting a new server (current code) and exiting');
      setTimeout(() => { respawnSelf(['--no-open']); hardExit(); }, 120);
      return;
    }
    if (p === '/api/window/reopen' && M === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(reopenWindow, 150);
      return;
    }
    if (p === '/api/usage/refresh' && M === 'POST') return json(res, 200, { rate: await ACC.refreshRate() });
    if (p === '/api/accounts' && M === 'GET') return json(res, 200, { accounts: ACC.view(), rates: ACC.rates() });
    if (p === '/api/accounts' && M === 'POST') { const b = await readBody(req); return json(res, 200, { accounts: await ACC.add(b.label, b.token) }); }
    if (p === '/api/accounts/impact' && M === 'GET') return json(res, 200, switchImpact(String(u.searchParams.get('to') || '')));
    if (p === '/api/accounts/use' && M === 'POST') {
      const b = await readBody(req), id = String(b.id || '');
      const out = ACC.use(id);
      // optional: stop conversations that are idle but kept alive by background tasks on another account,
      // so their next message starts on the new one (their background tasks end)
      let stopped = 0;
      if (b.stopBg) for (const r of runs.values()) if (!r.exited && !r.turnActive && r.acct !== id && r.bgTasks.length) { stopRun(r.id); stopped++; }
      return json(res, 200, { ...out, stopped });
    }
    if (p === '/api/accounts/rename' && M === 'POST') { const b = await readBody(req); return json(res, 200, { accounts: ACC.rename(String(b.id || ''), b.label) }); }
    if (p === '/api/accounts/remove' && M === 'POST') { const b = await readBody(req); return json(res, 200, { accounts: ACC.remove(String(b.id || '')) }); }
    if (p === '/api/accounts/setup-token' && M === 'POST') { openConsole(os.homedir(), 'claude setup-token'); return json(res, 200, { ok: true }); }
    if (p === '/api/side' && M === 'POST') return json(res, 200, await runSide(await readBody(req)));
    if (p === '/api/prompts' && M === 'GET') return json(res, 200, { prompts: store.prompts });
    if (p === '/api/prompts' && M === 'POST') {
      const b = await readBody(req);
      if (!Array.isArray(b.prompts)) return json(res, 400, { error: 'prompts must be an array' });
      store.prompts = b.prompts.filter(x => x && typeof x.text === 'string' && x.text.trim()).slice(0, 1000).map(x => ({
        id: typeof x.id === 'string' && x.id ? x.id.slice(0, 64) : crypto.randomUUID(),
        title: String(x.title || '').slice(0, 200), text: String(x.text).slice(0, 100000),
        uses: Number(x.uses) || 0, lastUsed: Number(x.lastUsed) || 0, createdAt: Number(x.createdAt) || Date.now(),
      }));
      saveStore();
      broadcast({ type: 'prompts' });
      return json(res, 200, { prompts: store.prompts });
    }
    if (p === '/api/prefs' && M === 'POST') {
      const b = await readBody(req);
      for (const k of ['model', 'effort', 'permissionMode', 'groupBy', 'lastCwd']) if (k in b) store.prefs[k] = b[k];
      if (['system', 'light', 'dark'].includes(b.windowTheme)) store.prefs.windowTheme = b.windowTheme;
      if (b.folderColors && typeof b.folderColors === 'object' && !Array.isArray(b.folderColors)) { // 資料夾（括弧）的顏色：小寫路徑 → 顏色
        const fc = {};
        for (const [k, v] of Object.entries(b.folderColors).slice(0, 500)) if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) fc[k.slice(0, 400)] = v;
        store.prefs.folderColors = fc;
      }
      if (b.workspaces && typeof b.workspaces === 'object' && !Array.isArray(b.workspaces)) { // 專注模式：每個資料夾一份工作區（工作群／排序／收合／捷徑／視窗）
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null), arr = (v, n, f) => (Array.isArray(v) ? v.slice(0, n).map(f).filter(x => x != null) : []);
        const out = {};
        for (const [k, w] of Object.entries(b.workspaces).slice(0, 200)) {
          if (!w || typeof w !== 'object') continue;
          out[k.slice(0, 400)] = {
            groups: arr(w.groups, 100, g => (g && typeof g.id === 'string' && typeof g.name === 'string')
              ? { id: g.id.slice(0, 40), name: g.name.slice(0, 60), color: str(g.color, 20) || '', sessions: arr(g.sessions, 1000, i => str(i, 80)) } : null),
            order: arr(w.order, 2000, i => str(i, 100)), collapsed: arr(w.collapsed, 300, i => str(i, 100)),
            short: { main: str(w.short && w.short.main, 80), sub: str(w.short && w.short.sub, 80) },
            vcards: (() => { const v = {}; // 每個工作群最多一張「還沒說過話」的虛擬空白卡片（只存在工作區，不是伺服器的 session）
              if (w.vcards && typeof w.vcards === 'object') for (const [gid, c] of Object.entries(w.vcards).slice(0, 100)) if (c && typeof c.vid === 'string') v[gid.slice(0, 40)] = { vid: c.vid.slice(0, 40), name: str(c.name, 200) };
              return v; })(),
            panes: w.panes && typeof w.panes === 'object' ? { L: str(w.panes.L, 80), R: str(w.panes.R, 80), split: !!w.panes.split } : null,
          };
        }
        store.prefs.workspaces = out;
      }
      if (Array.isArray(b.folderOrder)) store.prefs.folderOrder = b.folderOrder.filter(k => typeof k === 'string').slice(0, 1000).map(k => k.slice(0, 400));
      if (b.sessionOrder && typeof b.sessionOrder === 'object' && !Array.isArray(b.sessionOrder)) { // 資料夾 → 手動排的對話 id 順序
        const so = {};
        for (const [k, v] of Object.entries(b.sessionOrder).slice(0, 500)) if (Array.isArray(v)) so[k.slice(0, 400)] = v.filter(i => typeof i === 'string').slice(0, 1000).map(i => i.slice(0, 80));
        store.prefs.sessionOrder = so;
      }
      if (Array.isArray(b.folderGroups)) { // 左側「資料夾群組」：[{ id, name, color, folders: [小寫 cwd…] }]
        store.prefs.folderGroups = b.folderGroups.slice(0, 50).filter(g => g && typeof g.id === 'string' && typeof g.name === 'string')
          .map(g => ({ id: g.id.slice(0, 40), name: g.name.slice(0, 60), color: typeof g.color === 'string' ? g.color.slice(0, 20) : '',
            folders: Array.isArray(g.folders) ? g.folders.filter(f => typeof f === 'string').slice(0, 500) : [] }));
      }
      if (Array.isArray(b.webPages)) { // 「瀏覽器分頁」群組裡的頁面：[{ id, path, title }]（path 空＝還沒選檔案）
        store.prefs.webPages = b.webPages.slice(0, 100).filter(w => w && typeof w.id === 'string')
          .map(w => ({ id: w.id.slice(0, 40), path: typeof w.path === 'string' ? w.path.slice(0, 1000) : '', title: typeof w.title === 'string' ? w.title.slice(0, 120) : '' }));
      }
      saveStore(); return json(res, 200, { prefs: store.prefs });
    }
    let m = p.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(\w+))?$/i);
    if (m) {
      const id = m[1].toLowerCase(), act = m[2] || '';
      if (!act && M === 'PATCH') {
        const b = await readBody(req); const r = rec(id);
        if (!r.cwd) r.cwd = sessionCwd(id);
        for (const k of ['title', 'pinned', 'hidden', 'model', 'effort', 'permissionMode']) if (k in b) r[k] = b[k];
        for (const k of ['model', 'effort', 'permissionMode']) if (k in b) store.prefs[k] = b[k];
        saveStore(); broadcast({ type: 'sessions' });
        return json(res, 200, { ok: true });
      }
      if (!act && M === 'DELETE') return json(res, 200, await deleteSession(id));
      if (act === 'messages' && M === 'GET') return json(res, 200, await getMessages(id));
      if (act === 'send' && M === 'POST') {
        const b = await readBody(req);
        const imgs = Array.isArray(b.images) ? b.images : [];
        const r = b.compactFirst ? await sendWithCompact(id, String(b.text || ''), imgs) : await sendMessage(id, String(b.text || ''), imgs);
        return json(res, 200, { ok: true, ...(r || {}) });
      }
      if (act === 'compactcheck' && M === 'GET') return json(res, 200, await compactCheck(id));
      if (act === 'stop' && M === 'POST') return json(res, 200, { ok: stopRun(id) });
      if (act === 'perm' && M === 'POST') { const b = await readBody(req); return json(res, 200, { ok: answerPerm(id, b.requestId, b) }); }
      if (act === 'terminal' && M === 'POST') {
        const cwd = sessionCwd(id); if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: '資料夾不存在' });
        const exists = !!(await findFile(id));
        openConsole(cwd, exists ? `claude --resume ${id}` : 'claude', await ACC.env());
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/pick-folder' && M === 'POST') { const b = await readBody(req); return json(res, 200, { path: await pickFolder(normPath(b.initial)) }); }
    if (p === '/api/pick-file' && M === 'POST') { const b = await readBody(req); return json(res, 200, { path: await pickFile(normPath(b.initial)) }); }
    if (p === '/api/login' && M === 'POST') { openConsole(os.homedir(), 'claude auth login'); return json(res, 200, { ok: true }); }
    if (p === '/api/auth' && M === 'GET') return json(res, 200, { auth: await refreshAuth() });
    if (p === '/api/reveal' && M === 'POST') {
      const b = await readBody(req); const fp = path.resolve(normPath(b.path));
      if (!fs.existsSync(fp)) return json(res, 404, { error: '找不到: ' + fp });
      if (fs.statSync(fp).isDirectory()) spawn('explorer.exe', [fp], { detached: true, stdio: 'ignore' }).unref();
      else spawn('explorer.exe', ['/select,', fp], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/file' && M === 'GET') {
      let fp = normPath(u.searchParams.get('path'));
      const cwd = normPath(u.searchParams.get('cwd'));
      if (!path.isAbsolute(fp)) { if (!cwd) { res.writeHead(404); return res.end(); } fp = path.resolve(cwd, fp); }
      const type = IMG_TYPES[path.extname(fp).toLowerCase()];
      if (!type) { res.writeHead(415); return res.end('not an image'); }
      let st; try { st = await fsp.stat(fp); } catch { res.writeHead(404); return res.end('not found'); }
      if (!st.isFile()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('ERR', e.stack || String(e));
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else try { res.end(); } catch {}
  }
});

setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch {} } }, 20000);
setInterval(() => {
  if (KEEP_ALIVE || clients.size || runs.size) return;
  if (Date.now() - lastClientSeen > IDLE_EXIT_MS) { log('idle, exiting'); flushStore(); process.exit(0); }
}, 3000);
process.on('exit', () => { if (saveTimer) flushStore(); for (const r of runs.values()) killTree(r.proc.pid); });
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', e => log('uncaught', e.stack || String(e)));

// ---------- starting while an older server is still running ----------
// If it is idle, it is replaced right away (so a restart always runs the current code, with no waiting);
// if a conversation is running there, it is left alone and we only open a window onto it.
function portPid(port) {
  return new Promise(resolve => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'utf8' }, (err, out) => {
    const line = (out || '').split(/\r?\n/).find(l => new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING`).test(l));
    resolve(line ? Number(line.trim().split(/\s+/).pop()) : null);
  }));
}
async function takeOver() {
  // returns 'replaced' (it agreed to quit), 'busy' (a conversation is running there → open a window onto it),
  // or 'gone' (its process already exited and only the port is on its way to being released → just retry listening)
  const base = `http://127.0.0.1:${PORT}`, headers = { 'x-token': TOKEN, 'content-type': 'application/json' };
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(base + '/api/shutdown', { method: 'POST', headers, body: '{}' });
      if (r.ok) return 'replaced';              // it agreed to quit
      if (r.status === 409) return 'busy';      // a conversation is running there
      if (r.status !== 404) return 'busy';      // not ours / unexpected
      // an older version without /api/shutdown: if nothing runs there, end its process
      const s = await (await fetch(base + '/api/sessions', { headers })).json();
      if (!Array.isArray(s.sessions) || s.sessions.some(x => x.running)) return 'busy';
      const pid = await portPid(PORT);
      if (!pid || pid === process.pid) return 'gone';
      process.kill(pid);
      return 'replaced';
    } catch {
      // can't reach it: either it already exited (port free — just wait and rebind) or it is still holding the port
      const pid = await portPid(PORT);
      if (!pid) return 'gone';
      await new Promise(res => setTimeout(res, 250));
    }
  }
  return 'busy';
}
let tookOver = false, listenTries = 0;
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') { log('server error', e.message); process.exit(1); }
  if (!tookOver) {
    tookOver = true;
    const outcome = await takeOver();
    if (outcome === 'busy') { // busy (or not ours): just open another window onto it
      if (!NO_OPEN) openWindow();
      setTimeout(() => process.exit(0), 300);
      return;
    }
    log(outcome === 'gone' ? 'previous server already exited, waiting for the port' : 'replaced the previous (idle) server');
  }
  if (++listenTries > 40) { if (!NO_OPEN) openWindow(); setTimeout(() => process.exit(1), 300); return; }
  setTimeout(() => server.listen(PORT, '127.0.0.1'), 250); // wait for the old one to let go of the port
});
server.listen(PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(LOG_FILE, ''); } catch {}
  log(`CLI Controller v${APP_VERSION} listening on http://127.0.0.1:${PORT}/?t=${TOKEN}`);
  log('claude:', [CLAUDE_BIN, ...CLAUDE.pre].join(' '));
  lastClientSeen = Date.now();
  if (!NO_OPEN) openWindow();
  refreshAuth();
});
