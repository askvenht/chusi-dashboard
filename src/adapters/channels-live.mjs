// WeChat Channels (视频号助手) readers, verified 2026-11-19 against one logged-in 视频号 in its own dedicated profile
// (paths and shapes observed passively from channels.weixin.qq.com's own page loads; no synthesized requests).
// Identity: auth_data.finderUser.uniqId (视频号ID, stable across loads). userAttr.username changes on every load and
// is NOT used; the admin's personal WeChat nickname is NOT stored.
// Daily arrays carry no dates: the page's own request body gives startTs/endTs (day starts). Capture tabs run in
// Asia/Shanghai, so day i = Beijing date(startTs) + i, and the array length must equal the number of days.
import { captureInBackgroundTab, listPages } from '../transports/cdp-capture.mjs';

export const CH_ORIGIN = 'https://channels.weixin.qq.com';
const CGI = '/cgi-bin/mmfinderassistant-bin';
export const CH_AUTH_PATH = CGI + '/auth/auth_data';
export const CH_POST_TOTAL_PATH = '/micro/statistic' + CGI + '/statistic/new_post_total_data';
export const CH_FANS_TREND_PATH = '/micro/statistic' + CGI + '/statistic/fans_trend';
export const CH_POST_LIST_PATH = '/micro/content' + CGI + '/post/post_list';
export const CH_HOME_URL = CH_ORIGIN + '/platform';
export const CH_POST_STATS_URL = CH_ORIGIN + '/platform/statistic/post';
export const CH_FANS_STATS_URL = CH_ORIGIN + '/platform/statistic/follower';
const DAY = 86400, BJ = 8 * 3600;
const parseJson = t => { try { return JSON.parse(t); } catch { return null; } };
const intOf = v => { const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v; return Number.isSafeInteger(n) ? n : null; };
const bjDay = sec => new Date((sec + BJ) * 1000).toISOString().slice(0, 10);

export function parseChannelsAuth(text) {
  const j = parseJson(text);
  const f = j?.errCode === 0 ? j.data?.finderUser : null;
  if (!f || typeof f.uniqId !== 'string' || !/^[0-9A-Za-z_-]{6,64}$/.test(f.uniqId)) return null;
  return { userId: f.uniqId, nickname: typeof f.nickname === 'string' ? f.nickname.slice(0, 80) : null, redId: f.uniqId, fansTotal: Number.isSafeInteger(f.fansCount) && f.fansCount >= 0 ? f.fansCount : null };
}

// Returns the Beijing day list for a captured request body, or null when it is not a whole-day daily range.
export function rangeDays(requestBody) {
  const q = parseJson(requestBody);
  const start = intOf(q?.startTs), end = intOf(q?.endTs);
  if (start === null || end === null || end < start || (start + BJ) % DAY !== 0 || (end + BJ) % DAY !== 0) return null;
  const days = []; for (let t = start; t <= end; t += DAY) days.push(bjDay(t));
  return days.length <= 120 ? days : null;
}

// Pick the response with the widest valid Beijing-day range whose array lengths match it.
function widest(entries, arrays) {
  let best = null;
  for (const e of entries || []) {
    if (e.status < 200 || e.status >= 300) continue;
    const days = rangeDays(e.requestBody), j = parseJson(e.body);
    if (!days || j?.errCode !== 0 || !j.data) continue;
    const series = arrays(j.data);
    if (!series || Object.values(series).some(a => !Array.isArray(a) || a.length !== days.length)) continue;
    if (!best || days.length > best.days.length) best = { days, series, observedAt: e.observedAt };
  }
  return best;
}

const sample = (day, metric, value, source, at) => {
  if (!Number.isSafeInteger(value) || (metric !== 'followers_net' && value < 0)) throw Error('Invalid 视频号 daily value');
  return { day, timeZone: 'Asia/Shanghai', period: 'daily', metric, value, source, observedAt: new Date(at).toISOString() };
};

export function channelsDailySamples({ postEntries, fansEntries, postList, today }) {
  const out = [];
  // 播放 (browse) -> 浏览次数; ♡ (like) -> 点赞数. 👍 (fav) is a different action and is not mixed in. No 曝光 provided.
  const post = widest(postEntries, d => d.totalData ? { views: d.totalData.browse, likes: d.totalData.like } : null);
  if (post) post.days.forEach((day, i) => { if (day < today) for (const [m, arr] of Object.entries(post.series)) out.push(sample(day, m, intOf(arr[i]), 'channels:statistic/new_post_total_data', post.observedAt)); });
  const fans = widest(fansEntries, d => ({ followers_gained: d.add, followers_net: d.netAdd }));
  if (fans) fans.days.forEach((day, i) => { if (day < today) for (const [m, arr] of Object.entries(fans.series)) out.push(sample(day, m, intOf(arr[i]), 'channels:statistic/fans_trend', fans.observedAt)); });
  // 发表数 from the newest-first post list: only days strictly after the oldest listed post's day (and up to
  // yesterday) are fully covered by the list; earlier days stay 暂无数据 rather than being undercounted.
  const pl = parseJson(postList?.body);
  const list = pl?.errCode === 0 && Array.isArray(pl.data?.list) ? pl.data.list : null;
  const covered = post?.days || fans?.days;
  if (list && list.length && covered) {
    const times = list.map(x => intOf(x?.createTime)).filter(t => t !== null && t > 0);
    if (times.length === list.length) {
      const oldestDay = bjDay(Math.min(...times)), counts = new Map();
      for (const t of times) counts.set(bjDay(t), (counts.get(bjDay(t)) || 0) + 1);
      for (const day of covered) if (day > oldestDay && day < today) out.push(sample(day, 'published', counts.get(day) || 0, 'channels:post/post_list', postList.observedAt));
    }
  }
  return out;
}

const loggedIn = url => { try { const u = new URL(url); return u.origin === CH_ORIGIN && u.pathname.startsWith('/platform'); } catch { return false; } };
const todayBJ = now => bjDay(Math.floor(now / 1000));

export function createChannelsLiveReaders({ capture = captureInBackgroundTab, pages = listPages, now = Date.now } = {}) {
  async function identityReader(handle, { signal } = {}) {
    if (!(await pages(handle.port)).some(p => loggedIn(p.url))) return { verified: false, platform: 'channels', reason: 'waiting_for_login' };
    const { captured, landedUrl } = await capture({ port: handle.port, url: CH_HOME_URL, origin: CH_ORIGIN, want: [CH_AUTH_PATH], signal });
    if (landedUrl && !loggedIn(landedUrl)) return { verified: false, platform: 'channels', reason: 'not_logged_in' };
    const a = captured.get(CH_AUTH_PATH), user = a && a.status >= 200 && a.status < 300 ? parseChannelsAuth(a.body) : null;
    if (!user) return { verified: false, platform: 'channels', reason: 'identity_not_returned' };
    return { verified: true, platform: 'channels', ...user, observedAt: a.observedAt };
  }
  async function dailyReader(handle, { signal } = {}) {
    const load = async (url, want, extraWaitMs) => {
      const r = await capture({ port: handle.port, url, origin: CH_ORIGIN, want: [CH_AUTH_PATH, ...want], signal, timeoutMs: 12000, extraWaitMs });
      if (r.landedUrl && !loggedIn(r.landedUrl)) throw Error('视频号 session is not logged in');
      const a = r.captured.get(CH_AUTH_PATH), user = a ? parseChannelsAuth(a.body) : null;
      if (!user) throw Error('视频号 identity missing from the page load');
      return { user, r };
    };
    const p = await load(CH_POST_STATS_URL, [CH_POST_TOTAL_PATH], 2500);
    const f = await load(CH_FANS_STATS_URL, [CH_FANS_TREND_PATH], 2500);
    const h = await load(CH_HOME_URL, [CH_POST_LIST_PATH], 0);
    if (new Set([p.user.userId, f.user.userId, h.user.userId]).size !== 1) throw Error('视频号 account changed between page loads');
    const samples = channelsDailySamples({ postEntries: p.r.all.get(CH_POST_TOTAL_PATH), fansEntries: f.r.all.get(CH_FANS_TREND_PATH), postList: h.r.captured.get(CH_POST_LIST_PATH), today: todayBJ(now()) });
    if (!samples.length) throw Error('视频号 returned no aligned daily data');
    return { platform: 'channels', userId: p.user.userId, samples };
  }
  return { identityReader, dailyReader };
}
