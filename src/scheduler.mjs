// Daily scheduled read-only collection. One account at a time: open its own dedicated window -> wait for the
// verified identity -> collect -> close the window, then the next account. Never publishes, never touches other
// browsers. If the user has any account window open, the scheduled run is deferred (never interrupts the user).
import fs from 'node:fs';
import path from 'node:path';

const BJ = 8 * 3600000;
export function beijingClock(ms) { const d = new Date(ms + BJ); return { day: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REASONS = {
  identity_unverified: '登录已失效或未完成，请在卡片上点“登录此账号”重新扫码',
  identity_mismatch: '窗口里登录的不是已绑定的账号，已拒绝写入',
  identity_taken: '该平台账号已绑定到别的卡片，已拒绝',
};
const reason = e => REASONS[e?.code] || (e?.message || '未知错误').slice(0, 200);

export function createScheduler({ store, connections, stateFile, collectPlatforms, at = '12:30', now = Date.now,
  identityWaitMs = 45000, identityPollMs = 3000, wait = sleep }) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw Error('Invalid schedule time');
  let state = { at, lastRunDay: null, running: false, current: null, startedAt: null, finishedAt: null, accounts: {} };
  try { const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state = { ...state, lastRunDay: saved.lastRunDay ?? null, finishedAt: saved.finishedAt ?? null, accounts: saved.accounts ?? {} }; } catch {}
  const save = () => { fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 }); const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ lastRunDay: state.lastRunDay, finishedAt: state.finishedAt, accounts: state.accounts }), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  let timer = null, running = null;

  const eligible = () => store.listAccounts().filter(a => a.platform_user_id && collectPlatforms.includes(a.platform));
  const busy = () => connections.sessions.size > 0;

  async function collectOne(a) {
    const record = { at: new Date(now()).toISOString(), ok: false, message: '' };
    state.current = a.id;
    let opened = false;
    try {
      await connections.login(a.id); opened = true;
      // The dedicated page needs a few seconds to load; identity_unverified while loading is expected.
      let identity = null, last = null;
      for (const end = now() + identityWaitMs; now() < end;) {
        try { identity = await connections.observe(a.id); break; }
        catch (e) { last = e; if (e?.code !== 'identity_unverified' && e?.code !== 'busy') throw e; }
        await wait(identityPollMs);
      }
      if (!identity) throw last || Object.assign(Error('identity timeout'), { code: 'identity_unverified' });
      const r = await connections.collectDaily(a.id);
      Object.assign(record, { ok: true, message: `已采集 ${r.from} 至 ${r.to}（${r.saved} 项）`, saved: r.saved, from: r.from, to: r.to });
    } catch (e) { record.message = reason(e); record.code = e?.code ?? null; }
    finally {
      if (opened) { try { const closed = await connections.close(a.id); if (closed !== true) record.message += '；专用窗口未确认关闭'; } catch (e) { record.message += '；关闭窗口失败：' + reason(e); } }
      state.accounts[a.id] = record; state.current = null; save();
    }
    return record;
  }

  // manual=true: started from the panel button; refuses instead of deferring when a window is open.
  function run({ manual = false } = {}) {
    if (running) return { started: false, reason: '已有一轮采集在进行' };
    if (busy()) return { started: false, reason: manual ? '请先关闭已打开的账号专用窗口，再开始全部采集' : 'deferred' };
    const day = beijingClock(now()).day;
    state.running = true; state.startedAt = new Date(now()).toISOString();
    running = (async () => {
      try { for (const a of eligible()) { if (busy()) break; await collectOne(a); } }
      finally {
        if (!manual) state.lastRunDay = day;
        state.running = false; state.finishedAt = new Date(now()).toISOString(); save(); running = null;
      }
    })();
    return { started: true, accounts: eligible().length, done: running };
  }

  function tick() {
    const c = beijingClock(now());
    if (running || state.lastRunDay === c.day || c.hhmm < at) return null;
    return run();
  }

  return {
    tick, run,
    start(intervalMs = 60000) { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); setTimeout(tick, 5000).unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
    idle: () => running ?? Promise.resolve(),
    status() {
      const c = beijingClock(now());
      const nextDay = state.lastRunDay === c.day || c.hhmm >= at && running ? 'tomorrow' : (c.hhmm < at ? 'today' : 'pending');
      return { at, timeZone: 'Asia/Shanghai', lastRunDay: state.lastRunDay, running: state.running, current: state.current, startedAt: state.startedAt, finishedAt: state.finishedAt,
        next: nextDay, deferred: !state.running && nextDay === 'pending' && busy(), accounts: state.accounts };
    },
  };
}
