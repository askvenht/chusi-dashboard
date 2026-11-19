// Passive, read-only capture inside ONE owned dedicated browser (identified by its loopback debug port).
// - Opens a background tab in that same browser/profile, lets the platform's own page load and sign its own
//   requests, records only responses whose pathname is listed in `want`, then closes the tab.
// - Never synthesizes platform requests, never reads cookies/storage, never evaluates scripts, never clicks.
// The caller (ChromeBackend) must verify that the port is owned by the dedicated process before calling.

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function listPages(port, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw Error('Dedicated browser target list unavailable');
  return (await r.json()).filter(t => t.type === 'page').map(t => ({ id: t.id, url: t.url }));
}

function openSocket(url, signal) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const fail = () => reject(Error('Dedicated browser debug socket unavailable'));
    ws.onopen = () => resolve(ws); ws.onerror = fail;
    signal?.addEventListener('abort', () => { try { ws.close(); } catch {} fail(); }, { once: true });
  });
}

// Every capture tab runs in Asia/Shanghai (Emulation.setTimezoneOverride) so pages that compute date ranges on the
// client (e.g. 视频号) request Beijing natural days regardless of this Mac's system time zone. `all` keeps every
// response per wanted path together with the page's own request body (postData), for date-range alignment.
export async function captureInBackgroundTab({ port, url, origin, want, timeoutMs = 12000, settleMs = 400, extraWaitMs = 0, signal, fetchImpl = fetch }) {
  if (!Number.isInteger(port) || port < 19400 || port > 20000) throw Error('Port outside dedicated range');
  const target = new URL(url);
  if (target.origin !== origin) throw Error('Capture URL outside allowlisted origin');
  if (signal?.aborted) throw Error('Capture cancelled');
  const version = await (await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  if (!version?.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`)) throw Error('Unexpected browser endpoint');
  const ws = await openSocket(version.webSocketDebuggerUrl, signal);
  let seq = 0; const pending = new Map(); const handlers = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); }
    else handlers.forEach(h => h(d));
  };
  ws.onclose = () => { for (const p of pending.values()) p.reject(Error('Debug socket closed')); pending.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  let targetId = null;
  const captured = new Map(); // pathname -> first {status, body, observedAt, requestBody}
  const all = new Map(); // pathname -> [{status, body, observedAt, requestBody}]
  let landedUrl = null;
  try {
    ({ targetId } = await send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const responses = new Map(); // requestId -> {path,status}
    const requestBodies = new Map();
    const bodies = [];
    handlers.push(d => {
      if (d.sessionId !== sessionId) return;
      if (d.method === 'Page.frameNavigated' && !d.params.frame.parentId) landedUrl = d.params.frame.url;
      if (d.method === 'Network.requestWillBeSent' && typeof d.params.request.postData === 'string') requestBodies.set(d.params.requestId, d.params.request.postData.slice(0, 4096));
      if (d.method === 'Network.responseReceived') {
        let u; try { u = new URL(d.params.response.url); } catch { return; }
        if (u.origin === origin && want.includes(u.pathname)) responses.set(d.params.requestId, { path: u.pathname, status: d.params.response.status });
      }
      if (d.method === 'Network.loadingFinished' && responses.has(d.params.requestId)) {
        const meta = responses.get(d.params.requestId); responses.delete(d.params.requestId);
        bodies.push(send('Network.getResponseBody', { requestId: d.params.requestId }, sessionId)
          .then(b => { const entry = { status: meta.status, body: b.base64Encoded ? null : b.body, observedAt: Date.now(), requestBody: requestBodies.get(d.params.requestId) ?? null };
            if (!captured.has(meta.path)) captured.set(meta.path, entry);
            if (!all.has(meta.path)) all.set(meta.path, []); all.get(meta.path).push(entry); })
          .catch(() => {}));
      }
    });
    await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' }, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: target.href }, sessionId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && captured.size < want.length) {
      if (signal?.aborted) throw Error('Capture cancelled');
      // A redirect away from the wanted page (e.g. to the login page) ends the capture early.
      if (landedUrl && new URL(landedUrl).pathname.startsWith('/login')) { await sleep(settleMs); break; }
      await sleep(100);
    }
    // Some pages issue a short request first and the full-range one later; optionally keep listening a little.
    const until = Math.min(deadline, Date.now() + extraWaitMs);
    while (Date.now() < until) { if (signal?.aborted) throw Error('Capture cancelled'); await sleep(100); }
    await Promise.all(bodies);
    return { landedUrl, captured, all };
  } finally {
    if (targetId) { try { await send('Target.closeTarget', { targetId }); } catch {} }
    try { ws.close(); } catch {}
  }
}
