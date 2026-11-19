// Douyin creator-center readers, verified 2026-11-19 against one logged-in creator account in its own dedicated
// profile (paths and shapes observed passively from creator.douyin.com's own page loads; no synthesized requests).
// Kept: uid, nickname, 抖音号 (unique_id), follower count and the daily trends below. Everything else is dropped.
import { captureInBackgroundTab, listPages } from '../transports/cdp-capture.mjs';

export const DY_ORIGIN = 'https://creator.douyin.com';
export const DY_USER_INFO_PATH = '/web/api/media/user/info/';
export const DY_OVERVIEW_ALL_PATH = '/aweme/janus/creator/data/overview/all/';
export const DY_DASHBOARD_PATH = '/janus/douyin/creator/data/overview/dashboard';
export const DY_HOME_URL = DY_ORIGIN + '/creator-micro/home';
export const DY_DATA_URL = DY_ORIGIN + '/creator-micro/data-center/operation';

// Data-center dashboard trends (english_metric_name -> panel metric). Douyin offers no 曝光 for creator accounts here,
// so 'impressions' is intentionally absent and stays 暂无数据.
export const DY_DASHBOARD_METRICS = Object.freeze({ publish_cnt: 'published', play_cnt: 'views', digg_cnt: 'likes', net_fans_cnt: 'followers_net' });
// Home overview lists (key -> panel metric): 新增粉丝 is only provided here.
export const DY_OVERVIEW_METRICS = Object.freeze({ new_fans: 'followers_gained' });
const SAFE_UID = /^[0-9]{6,32}$/;
const parseJson = t => { try { return JSON.parse(t); } catch { return null; } };
const intOf = v => { const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v; return Number.isSafeInteger(n) ? n : null; };

export function parseDouyinUser(text) {
  const j = parseJson(text);
  if (!j || j.status_code !== 0 || !j.user || typeof j.user !== 'object') return null;
  const { uid, nickname, unique_id, short_id, follower_count } = j.user;
  if (typeof uid !== 'string' || !SAFE_UID.test(uid)) return null;
  const douyinNo = typeof unique_id === 'string' && unique_id ? unique_id : (typeof short_id === 'string' ? short_id : null);
  return { userId: uid, nickname: typeof nickname === 'string' ? nickname.slice(0, 80) : null, redId: douyinNo && /^[0-9A-Za-z_.]{1,40}$/.test(douyinNo) ? douyinNo : null, fansTotal: Number.isSafeInteger(follower_count) && follower_count >= 0 ? follower_count : null };
}

// Douyin states its data "每天12点更新" (Beijing). Day D is accepted only once Beijing time has passed D+1 12:00, so
// a not-yet-updated day (which the API still returns as 0) is never stored as a real zero. Today is never accepted.
export function douyinLastFinalDay(now = Date.now()) {
  const bj = new Date(now + 8 * 3600000); // Beijing wall clock expressed in UTC fields
  const back = bj.getUTCHours() >= 12 ? 1 : 2;
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - back)).toISOString().slice(0, 10);
}
const ymd = s => { if (typeof s !== 'string') return null; const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s); if (!m) return null; const d = `${m[1]}-${m[2]}-${m[3]}`; return new Date(d).toISOString().slice(0, 10) === d ? d : null; };

function sample(day, metric, value, source, at) {
  if (!Number.isSafeInteger(value) || (metric !== 'followers_net' && value < 0)) throw Error('Invalid Douyin daily value');
  return { day, timeZone: 'Asia/Shanghai', period: 'daily', metric, value, source, observedAt: at };
}

export function parseDouyinDashboard(text, observedAt, now = Date.now()) {
  const j = parseJson(text);
  if (!j || j.status_code !== 0 || !Array.isArray(j.metrics)) throw Error('Unsupported Douyin dashboard response; refusing guessed data');
  const at = new Date(observedAt).toISOString(), last = douyinLastFinalDay(now), out = [];
  for (const m of j.metrics) {
    const metric = DY_DASHBOARD_METRICS[m?.english_metric_name];
    if (!metric || !Array.isArray(m.trends)) continue;
    const seen = new Set();
    for (const t of m.trends) {
      const day = ymd(t?.date_time); if (!day) throw Error('Invalid Douyin trend date');
      if (seen.has(day)) throw Error('Duplicate Douyin trend day'); seen.add(day);
      if (day > last) continue;
      out.push(sample(day, metric, intOf(t.value), 'douyin:creator/data/overview/dashboard', at));
    }
  }
  return out;
}

export function parseDouyinOverview(text, observedAt, now = Date.now()) {
  const j = parseJson(text);
  if (!j || j.status_code !== 0 || !j.data || typeof j.data !== 'object') throw Error('Unsupported Douyin overview response; refusing guessed data');
  const at = new Date(observedAt).toISOString(), last = douyinLastFinalDay(now), out = [];
  for (const [key, metric] of Object.entries(DY_OVERVIEW_METRICS)) {
    const list = j.data[key]?.option_list;
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    for (const x of list) {
      const day = ymd(x?.date); if (!day) throw Error('Invalid Douyin overview date');
      if (seen.has(day)) throw Error('Duplicate Douyin overview day'); seen.add(day);
      if (day > last) continue;
      out.push(sample(day, metric, intOf(x.count), 'douyin:creator/data/overview/all', at));
    }
  }
  return out;
}

const loggedInPage = url => { try { const u = new URL(url); return u.origin === DY_ORIGIN && u.pathname.startsWith('/creator-micro/'); } catch { return false; } };

export function createDouyinLiveReaders({ capture = captureInBackgroundTab, pages = listPages, now = Date.now } = {}) {
  async function identityReader(handle, { signal } = {}) {
    // While the user is on the QR login page (site root), open nothing; read identity only once the dedicated
    // window has reached the logged-in creator area.
    if (!(await pages(handle.port)).some(p => loggedInPage(p.url))) return { verified: false, platform: 'douyin', reason: 'waiting_for_login' };
    const { captured, landedUrl } = await capture({ port: handle.port, url: DY_HOME_URL, origin: DY_ORIGIN, want: [DY_USER_INFO_PATH], signal });
    if (landedUrl && !loggedInPage(landedUrl)) return { verified: false, platform: 'douyin', reason: 'not_logged_in' };
    const info = captured.get(DY_USER_INFO_PATH);
    const user = info?.status === 200 ? parseDouyinUser(info.body) : null;
    if (!user) return { verified: false, platform: 'douyin', reason: 'identity_not_returned' };
    return { verified: true, platform: 'douyin', ...user, observedAt: info.observedAt };
  }
  async function dailyReader(handle, { signal } = {}) {
    const read = async (url, path) => {
      const { captured, landedUrl } = await capture({ port: handle.port, url, origin: DY_ORIGIN, want: [DY_USER_INFO_PATH, path], signal, timeoutMs: 12000 });
      if (landedUrl && !loggedInPage(landedUrl)) throw Error('Douyin session is not logged in');
      const user = captured.get(DY_USER_INFO_PATH)?.status === 200 ? parseDouyinUser(captured.get(DY_USER_INFO_PATH).body) : null;
      const data = captured.get(path);
      if (!user) throw Error('Douyin identity missing from the page load');
      if (data?.status !== 200 || typeof data.body !== 'string') throw Error('Douyin data was not returned by the page');
      return { user, data };
    };
    const a = await read(DY_DATA_URL, DY_DASHBOARD_PATH);
    const b = await read(DY_HOME_URL, DY_OVERVIEW_ALL_PATH);
    if (a.user.userId !== b.user.userId) throw Error('Douyin account changed between page loads');
    const t = now();
    const samples = [...parseDouyinDashboard(a.data.body, a.data.observedAt, t), ...parseDouyinOverview(b.data.body, b.data.observedAt, t)];
    if (!samples.length) throw Error('Douyin returned no final daily data yet');
    return { platform: 'douyin', userId: a.user.userId, samples };
  }
  return { identityReader, dailyReader };
}
