'use strict';
// Accounts: one 主帳號 (main) = whatever the claude CLI is logged into (~/.claude/.credentials.json, `claude auth
// login`), plus any number of 副帳號 (sub accounts) = long-lived tokens from `claude setup-token`, given to each
// claude we start through CLAUDE_CODE_OAUTH_TOKEN. Everything else in ~/.claude (transcripts, settings, MCP, skills)
// stays shared, so a conversation can continue on any account.
//
// Everything about accounts lives here: the list, the tokens (encrypted with Windows DPAPI, current user only), which
// one is in use, each one's plan usage, and its status. Any state is allowed (switching to an account that is logged
// out, out of quota or has a dead token is not blocked) — the status only tells the user what to expect, and when a
// problem shows up after a message was sent, a warning explains it and what to do.
//
// Status per account:  ok | loggedOut (main: CLI not logged in) | invalid (sub: token rejected) | limited (quota used up)
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const MAIN = 'default'; // id of the main account (kept from v1.9.32 so stored usage carries over)
const NEAR = 0.9;       // warn once when a window passes this utilization
const AUTH_ERR = /\b401\b|unauthori[sz]ed|invalid (oauth|access|api)|oauth (access )?token|authenticat|log ?in again|token (has )?expired|revoked/i;
const LIMIT_ERR = /usage limit|limit reached|hit your limit|rate.?limit|out of (extra )?usage|quota|額度/i;
const WINDOW_NAMES = { five_hour: '5 小時', seven_day: '每週', seven_day_opus: '每週 Opus', seven_day_sonnet: '每週 Sonnet' };

module.exports = function createAccounts({ store, saveStore, log, broadcast, cleanEnv, claude, killTree }) {
  store.accounts = Array.isArray(store.accounts) ? store.accounts : [];
  store.acctState = store.acctState || {}; // id -> { invalid?: {at, text}, limited?: {until, windows}, warned?: key }
  const rates = store.rates = store.rates || {}; // id -> rate_limit_info + receivedAt (+ who: main account's email)
  if (store.lastRate && !rates[MAIN]) rates[MAIN] = store.lastRate; // before v1.9.32: one shared number
  delete store.lastRate;
  if (!valid(store.activeAccount)) store.activeAccount = MAIN;
  let cliAuth = null; // latest `claude auth status` of the main account

  function valid(id) { return id === MAIN || store.accounts.some(a => a.id === id); }
  const st = id => store.acctState[id] || (store.acctState[id] = {});
  const sub = id => store.accounts.find(a => a.id === id);
  const active = () => store.activeAccount;
  const nowSec = () => Date.now() / 1000;
  function fmtTime(sec) {
    const d = new Date(sec * 1000), n = new Date();
    const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    return d.toDateString() === n.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // ---------- tokens (DPAPI) ----------
  const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  function dpapi(protect, text) {
    return new Promise((resolve, reject) => {
      const script = 'Add-Type -AssemblyName System.Security; $s=[Security.Cryptography.DataProtectionScope]::CurrentUser; ' + (protect
        ? '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:CC_IN),$null,$s))'
        : '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CC_IN),$null,$s))');
      execFile(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script],
        { env: { ...process.env, CC_IN: text }, windowsHide: true, encoding: 'utf8', timeout: 20000 },
        (err, out) => { const v = String(out || '').trim(); if (err || !v) reject(new Error('無法' + (protect ? '加密' : '解密') + '副帳號 token（token 只能在當初加入它的這台電腦、這個 Windows 使用者下使用）')); else resolve(v); });
    });
  }
  const tokenCache = new Map(); // id -> decrypted token
  async function token(id) {
    if (tokenCache.has(id)) return tokenCache.get(id);
    const a = sub(id); if (!a) throw new Error('找不到副帳號');
    const t = await dpapi(false, a.tokEnc); tokenCache.set(id, t); return t;
  }
  for (const a of store.accounts) token(a.id).catch(e => log('account', a.id, e.message)); // ready before the first message

  // Environment for a claude run on this account. A token beats the CLI login; an ANTHROPIC_API_KEY would beat
  // the token, so it is removed for sub accounts. The main account gets the plain environment.
  async function env(id = active()) {
    const e = cleanEnv();
    if (id !== MAIN && sub(id)) {
      e.CLAUDE_CODE_OAUTH_TOKEN = await token(id);
      delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN;
    }
    return e;
  }

  // ---------- status ----------
  function status(id) {
    const s = st(id);
    if (id === MAIN && cliAuth && !cliAuth.loggedIn) return { code: 'loggedOut', text: '尚未登入' };
    if (id !== MAIN && s.invalid) return { code: 'invalid', text: 'token 失效' };
    if (s.limited && s.limited.until > nowSec()) return { code: 'limited', text: `額度用完・${fmtTime(s.limited.until)} 重置`, until: s.limited.until };
    return { code: 'ok', text: '' };
  }
  function label(id) {
    if (id === MAIN) return (cliAuth && cliAuth.loggedIn && cliAuth.email) || store.cliEmail || 'CLI 登入帳號';
    const a = sub(id); return a ? a.label : id;
  }
  const kindName = id => (id === MAIN ? '主帳號' : '副帳號');
  const fullName = id => `${kindName(id)}「${label(id)}」`;
  function view() {
    const one = (id, extra) => ({ id, kind: id === MAIN ? 'main' : 'sub', label: label(id), status: status(id), ...extra });
    return {
      active: active(),
      list: [one(MAIN, { cli: cliAuth ? { loggedIn: !!cliAuth.loggedIn, email: cliAuth.email || '', org: cliAuth.orgName || '', plan: cliAuth.subscriptionType || '' } : null })]
        .concat(store.accounts.map(a => one(a.id, { addedAt: a.addedAt }))),
    };
  }
  const changed = () => { saveStore(); broadcast({ type: 'accounts', accounts: view(), rate: rates[active()] || null }); };
  // a problem the user has to know about; sid: the conversation it happened in (shown there too)
  function warn(id, level, text, sid) {
    log('account warn', id, level, text.replace(/\n/g, ' '));
    broadcast({ type: 'acctWarn', acct: id, level, text, sid: sid || null });
  }
  const switchHint = id => store.accounts.length || id !== MAIN ? '可以在左下「用量」旁的選單切換到其他帳號，再送一次訊息就能接著聊（對話紀錄共用）。' : '可以到 ⚙ 設定 → 帳號新增副帳號，額度用完時切換過去接著聊。';

  // ---------- usage ----------
  // rate_limit_event from any claude we ran on this account: keep it, and update the limited / near-limit state
  function onRate(id, info, sid) {
    if (!valid(id)) return;
    rates[id] = { ...info, receivedAt: Date.now(), who: id === MAIN ? label(MAIN) : undefined };
    const s = st(id);
    if (s.invalid) { delete s.invalid; } // a response came back, so the token works
    const wins = info.unifiedWindows || (info.rateLimitType ? { [info.rateLimitType]: info } : {});
    const rejected = Object.entries(wins).filter(([, w]) => w && w.status === 'rejected');
    if (info.status === 'rejected' || rejected.length) {
      const until = Math.max(info.resetsAt || 0, ...rejected.map(([, w]) => w.resetsAt || 0)) || nowSec() + 3600;
      const names = rejected.map(([k]) => WINDOW_NAMES[k] || k).join('、') || '用量';
      const was = s.limited && s.limited.until > nowSec();
      s.limited = { until, windows: names };
      if (!was) warn(id, 'limit', `${fullName(id)}的${names}額度已用完，約 ${fmtTime(until)} 重置。\n${switchHint(id)}`, sid);
    } else {
      delete s.limited;
      // near the limit: warn once per window and reset time
      for (const [k, w] of Object.entries(wins)) {
        if (!w || w.utilization == null || w.utilization < NEAR || (w.resetsAt && w.resetsAt <= nowSec())) continue;
        const key = k + ':' + (w.resetsAt || '');
        if (s.warned === key) continue;
        s.warned = key;
        warn(id, 'near', `${fullName(id)}的${WINDOW_NAMES[k] || k}額度已用 ${Math.round(w.utilization * 100)}%` + (w.resetsAt ? `，${fmtTime(w.resetsAt)} 重置` : '') + `。用完後訊息會失敗；${switchHint(id)}`, sid);
        break;
      }
    }
    saveStore();
    if (id === active()) broadcast({ type: 'rate', rate: rates[id] });
    broadcast({ type: 'accounts', accounts: view(), rate: rates[active()] || null });
    return rates[id];
  }
  // A turn (or a one-off run) ended with an error: tell the user what it means for the account.
  // Returns true when the error was an account problem (auth / quota).
  function onError(id, text, sid) {
    if (!valid(id) || !text) return false;
    const s = st(id);
    if (LIMIT_ERR.test(text) && !AUTH_ERR.test(text)) {
      const was = s.limited && s.limited.until > nowSec();
      if (!was) {
        const r = rates[id], wins = r && (r.unifiedWindows || {});
        const until = Math.max(0, ...Object.values(wins || {}).filter(w => w && w.utilization >= 0.99).map(w => w.resetsAt || 0));
        s.limited = { until: until > nowSec() ? until : nowSec() + 3600, windows: '用量' };
        warn(id, 'limit', `${fullName(id)}的額度已用完，這則訊息沒有送出成功` + (until > nowSec() ? `（約 ${fmtTime(until)} 重置）` : '') + `。\n${switchHint(id)}`, sid);
        changed();
      }
      return true;
    }
    if (AUTH_ERR.test(text)) {
      if (id === MAIN) {
        warn(id, 'auth', `${fullName(id)}的登入有問題（${text.slice(0, 120)}）。\n請到 ⚙ 設定 → 帳號按「登入」重新登入 CLI，或切換到副帳號再送一次。`, sid);
      } else if (!s.invalid) {
        s.invalid = { at: Date.now(), text: text.slice(0, 300) };
        warn(id, 'invalid', `${fullName(id)}的 token 被拒絕（可能過期或已在 claude.ai 撤銷），這則訊息沒有送出成功。\n請切換到其他帳號再送一次；這個副帳號要到 ⚙ 設定 → 帳號移除後重新新增。`, sid);
        changed();
      }
      return true;
    }
    return false;
  }
  function onSuccess(id) { const s = st(id); if (id !== MAIN && s.invalid) { delete s.invalid; changed(); } }

  // Refreshing plan usage needs one real API request (claude only learns the numbers from response headers;
  // `/usage` and the get_usage control request return nothing without one). This is the smallest request possible:
  // Haiku, no tools, no MCP, no settings, a one-line system prompt — about 640 input + 3 output tokens.
  // It also checks that a sub account's token works (`claude auth status` does not).
  const ratePending = new Map();
  function refreshRate(id = active(), force, quiet) {
    const last = rates[id];
    if (!force && last && Date.now() - last.receivedAt < 20000) return Promise.resolve(last); // several windows asking at once
    if (ratePending.has(id)) return ratePending.get(id);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'haiku',
      '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--system-prompt', 'Reply with a single period.'];
    const pending = env(id).then(e => new Promise((resolve, reject) => {
      const p = spawn(claude.bin, claude.pre.concat(args), { cwd: os.homedir(), env: e, windowsHide: true });
      let buf = '', got = null, err = '';
      const timer = setTimeout(() => killTree(p.pid), 60000);
      p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
      p.stdout.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const o = JSON.parse(l); if (o.type === 'rate_limit_event' && o.rate_limit_info) got = o.rate_limit_info; else if (o.type === 'result' && o.is_error) err = o.result || err; } catch {}
        }
      });
      p.stderr.on('data', d => { err = (err + d).slice(-1000); });
      p.on('error', e2 => { err += e2.message; });
      p.on('close', () => {
        clearTimeout(timer);
        if (got) resolve(onRate(id, got));
        else { const msg = err.trim() || '沒有取得用量資料'; if (!quiet) onError(id, msg); reject(new Error(msg)); }
      });
      p.stdin.on('error', () => {});
      p.stdin.end('.');
    })).finally(() => ratePending.delete(id));
    ratePending.set(id, pending);
    return pending;
  }

  // ---------- main account (CLI login) ----------
  // Called with every `claude auth status`. When the CLI is now logged into a different account than the one the
  // stored usage belongs to, that usage is dropped (it was the old account's) and fetched again for the new one.
  function onCliAuth(a) {
    const prevIn = cliAuth ? !!cliAuth.loggedIn : null;
    cliAuth = a || { loggedIn: false };
    const s = st(MAIN);
    if (cliAuth.loggedIn && cliAuth.email) {
      const before = store.cliEmail;
      store.cliEmail = cliAuth.email;
      const r = rates[MAIN];
      if ((before && before !== cliAuth.email) || (r && r.who && r.who !== cliAuth.email)) {
        delete rates[MAIN]; delete s.limited; delete s.warned;
        log('account main changed', before || '?', '->', cliAuth.email);
        warn(MAIN, 'changed', `CLI 登入的帳號換成了 ${cliAuth.email}。主帳號的用量已清除並重新讀取。`);
        refreshRate(MAIN, true).catch(() => {});
      }
    }
    if (prevIn === true && !cliAuth.loggedIn && active() === MAIN)
      warn(MAIN, 'loggedOut', `CLI 已登出，主帳號暫時不能用。\n請到 ⚙ 設定 → 帳號按「登入」，或切換到副帳號。`);
    changed();
  }

  // ---------- add / remove / switch ----------
  async function add(name, tok) {
    name = String(name || '').trim().slice(0, 60); tok = String(tok || '').replace(/\s+/g, '');
    if (!name) throw new Error('請輸入副帳號名稱');
    if (!/^sk-ant-oat\d*-[\w-]{20,}$/.test(tok)) throw new Error('這不像 claude setup-token 產生的 token（應該是 sk-ant-oat01- 開頭的一長串）');
    const id = 'a' + crypto.randomBytes(5).toString('hex');
    const tokEnc = await dpapi(true, tok);
    // try it before keeping it: one tiny request, which also gives this account's usage
    store.accounts.push({ id, label: name, tokEnc, addedAt: Date.now() }); tokenCache.set(id, tok);
    try { await refreshRate(id, true, true); }
    catch (e) { store.accounts = store.accounts.filter(a => a.id !== id); tokenCache.delete(id); delete rates[id]; delete store.acctState[id]; throw new Error('token 無法使用：' + e.message); }
    log('account added', id, name); changed();
    return view();
  }
  function remove(id) {
    if (id === MAIN) throw new Error('主帳號（CLI 登入）不能移除；要換帳號請用「登入」重新登入 CLI');
    if (!sub(id)) throw new Error('找不到副帳號');
    store.accounts = store.accounts.filter(a => a.id !== id); tokenCache.delete(id); delete rates[id]; delete store.acctState[id];
    if (active() === id) store.activeAccount = MAIN;
    log('account removed', id); changed();
    return view();
  }
  function rename(id, name) {
    const a = sub(id); name = String(name || '').trim().slice(0, 60);
    if (!a) throw new Error('只有副帳號可以改名');
    if (!name) throw new Error('名稱不可空白');
    a.label = name; changed(); return view();
  }
  // Conversations from now on use this account. Any status is allowed; the reply says what to expect.
  // A claude that is already running keeps the account it started with until its process ends.
  function use(id) {
    if (!valid(id)) throw new Error('找不到帳號');
    store.activeAccount = id; log('account switched', id); changed();
    return { accounts: view(), status: status(id) };
  }

  return {
    MAIN, active, env, view, label, fullName, status, rate: id => rates[id] || null, rates: () => rates,
    onRate, onError, onSuccess, onCliAuth, refreshRate, add, remove, rename, use,
  };
};
