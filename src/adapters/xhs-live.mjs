// Xiaohongshu creator-center readers, verified 2026-11-19 against one logged-in creator account in its own
// dedicated profile (endpoint paths and response shapes observed passively from the creator site's own page loads).
// Only these fields are kept: userId, nickname, redId (小红书号), fans total, and the daily lists below.
// Phone number, avatar and every other field of the platform response are dropped and never stored.
import { captureInBackgroundTab, listPages } from '../transports/cdp-capture.mjs';

export const XHS_ORIGIN = 'https://creator.xiaohongshu.com';
export const XHS_USER_INFO_PATH = '/api/galaxy/user/info';
export const XHS_PERSONAL_INFO_PATH = '/api/galaxy/creator/home/personal_info';
export const XHS_ACCOUNT_BASE_PATH = '/api/galaxy/v2/creator/datacenter/account/base';
export const XHS_HOME_URL = XHS_ORIGIN + '/new/home';
export const XHS_ACCOUNT_STATS_URL = XHS_ORIGIN + '/statistics/account';

// Platform list name -> panel metric. Each list holds one point per Beijing natural day: {date: epoch ms of
// 00:00 Asia/Shanghai, count}. Exposure (曝光) and views (观看) are distinct lists; net and gained fans are distinct.
export const XHS_DAILY_LISTS = Object.freeze({
  publish_note_num_list: 'published',      // 发布笔记数（图文+视频）
  impl_count_list: 'impressions',          // 曝光数
  view_list: 'views',                      // 观看数（小红书口径，面板“浏览次数”列）
  like_list: 'likes',                      // 点赞数
  net_rise_fans_count_list: 'followers_net', // 净涨粉
  rise_fans_list: 'followers_gained',      // 新增粉丝
});
const DAY_MS = 86400000, SHANGHAI_OFFSET_MS = 8 * 3600000;
const SAFE_ID = /^[0-9a-zA-Z_-]{6,64}$/;

function okEnvelope(json) {
  return json && typeof json === 'object' && json.success === true && (json.code === 0 || json.code === undefined) && json.data && typeof json.data === 'object';
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

export function parseUserInfo(text) {
  const j = parseJson(text);
  if (!okEnvelope(j)) return null;
  const { userId, userName, redId } = j.data;
  if (typeof userId !== 'string' || !SAFE_ID.test(userId)) return null;
  return { userId, nickname: typeof userName === 'string' ? userName.slice(0, 80) : null, redId: typeof redId === 'string' && /^[0-9A-Za-z_]{1,32}$/.test(redId) ? redId : null };
}

export function parsePersonalInfo(text) {
  const j = parseJson(text);
  if (!okEnvelope(j)) return null;
  const n = j.data.fans_count;
  return Number.isSafeInteger(n) && n >= 0 ? { fansTotal: n } : null;
}

export function beijingDay(ms) {
  if (!Number.isSafeInteger(ms) || (ms + SHANGHAI_OFFSET_MS) % DAY_MS !== 0) throw Error('XHS daily point is not a Beijing midnight');
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

// Returns daily samples ready for daily.saveDaily (period 'daily', Asia/Shanghai). Unknown shapes fail closed.
export function parseAccountBase(text, observedAt) {
  const j = parseJson(text);
  if (!okEnvelope(j)) throw Error('Unsupported XHS account overview response; refusing guessed data');
  const block = j.data.thirty && typeof j.data.thirty === 'object' ? j.data.thirty : j.data.seven;
  if (!block || typeof block !== 'object') throw Error('XHS account overview has no daily block');
  const at = new Date(observedAt).toISOString();
  const samples = [];
  for (const [list, metric] of Object.entries(XHS_DAILY_LISTS)) {
    const points = block[list];
    if (!Array.isArray(points)) continue; // metric absent from platform response -> stays 暂无数据
    const seen = new Set();
    for (const p of points) {
      const day = beijingDay(p?.date);
      const value = p?.count;
      if (!Number.isSafeInteger(value) || (metric !== 'followers_net' && value < 0)) throw Error('Invalid XHS daily count');
      if (seen.has(day)) throw Error('Duplicate XHS daily point');
      seen.add(day);
      samples.push({ day, timeZone: 'Asia/Shanghai', period: 'daily', metric, value, source: 'xhs:creator/datacenter/account/base', observedAt: at });
    }
  }
  if (!samples.length) throw Error('XHS account overview contained no recognised daily lists');
  return samples;
}

// Readers plugged into ChromeBackend. `capture` and `pages` are injectable for tests.
export function createXhsLiveReaders({ capture = captureInBackgroundTab, pages = listPages } = {}) {
  async function identityReader(handle, { signal } = {}) {
    // Do not open anything while the user's own window is still on the QR/login page: a second login page could
    // disturb the scan. Only after the dedicated window has left /login do we read identity in a background tab.
    const open = await pages(handle.port);
    const creatorPages = open.filter(p => { try { return new URL(p.url).origin === XHS_ORIGIN; } catch { return false; } });
    if (!creatorPages.length || creatorPages.every(p => new URL(p.url).pathname.startsWith('/login')))
      return { verified: false, platform: 'xhs', reason: 'waiting_for_login' };
    const { captured, landedUrl } = await capture({ port: handle.port, url: XHS_HOME_URL, origin: XHS_ORIGIN, want: [XHS_USER_INFO_PATH, XHS_PERSONAL_INFO_PATH], signal });
    if (landedUrl && new URL(landedUrl).pathname.startsWith('/login')) return { verified: false, platform: 'xhs', reason: 'not_logged_in' };
    const info = captured.get(XHS_USER_INFO_PATH);
    const user = info?.status === 200 ? parseUserInfo(info.body) : null;
    if (!user) return { verified: false, platform: 'xhs', reason: 'identity_not_returned' };
    const personal = captured.get(XHS_PERSONAL_INFO_PATH);
    const fans = personal?.status === 200 ? parsePersonalInfo(personal.body) : null;
    return { verified: true, platform: 'xhs', ...user, fansTotal: fans?.fansTotal ?? null, observedAt: info.observedAt };
  }
  async function dailyReader(handle, { signal } = {}) {
    const { captured, landedUrl } = await capture({ port: handle.port, url: XHS_ACCOUNT_STATS_URL, origin: XHS_ORIGIN, want: [XHS_USER_INFO_PATH, XHS_ACCOUNT_BASE_PATH], signal, timeoutMs: 14000 });
    if (landedUrl && new URL(landedUrl).pathname.startsWith('/login')) throw Error('XHS session is not logged in');
    const info = captured.get(XHS_USER_INFO_PATH), base = captured.get(XHS_ACCOUNT_BASE_PATH);
    const user = info?.status === 200 ? parseUserInfo(info.body) : null;
    if (!user) throw Error('XHS identity missing from the statistics page load');
    if (base?.status !== 200 || typeof base.body !== 'string') throw Error('XHS account overview was not returned by the page');
    return { platform: 'xhs', userId: user.userId, samples: parseAccountBase(base.body, base.observedAt) };
  }
  return { identityReader, dailyReader };
}
