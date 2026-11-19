// Parsing adapter based on the upstream followers.mjs response shape.
// No transport to real accounts is bundled or enabled.
export const XHS_FANS_PATH='/api/galaxy/creator/data/fans/overall_new';
const origin='https://creator.xiaohongshu.com';
const count=n=>Number.isSafeInteger(n)&&n>=0;
function day(value){const d=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)?new Date(value+8*3600000).toISOString().slice(0,10):null;if(!d||new Date(d).toISOString().slice(0,10)!==d)throw Error('Invalid historical day');return d;}
export function normalizeFans(payload){
 // Each field is read exactly once and only validated primitives are copied into new objects, so the result
 // never aliases (or re-reads) the transport-owned payload.
 const d=payload?.data?.thirty;
 const total=d?.fans_count,fansList=d?.fans_list;
 if(!d||!count(total)||!Array.isArray(fansList)||fansList.length>366)throw Error('Unsupported XHS fans response; refusing guessed data');
 const map=list=>{if(!Array.isArray(list))throw Error('Invalid XHS history');const out=new Map();for(const x of list){const c=x?.count;if(!count(c))throw Error('Invalid history count');const key=day(x.date);if(out.has(key))throw Error('Duplicate history day');out.set(key,c);}return out;};
 const totals=map(fansList),gains=map(d.rise_fans_list||[]),losses=map(d.leave_fans_list||[]);
 return {total,history:[...totals].map(([date,total])=>({day:date,total,gain:gains.get(date)??null,loss:losses.get(date)??null})).sort((a,b)=>a.day.localeCompare(b.day))};
}

// Strict per-response provenance contract (every identity envelope AND every fans response):
//   origin, platform:'xhs', accountId, sessionId, profilePath  -> must equal the session snapshot taken at call entry
//   requestId -> must echo the fresh id the adapter generated for THAT transport call (no cached/replayed reply)
//   observedAt -> epoch ms, within maxAgeMs of now() and not in the future beyond maxSkewMs
// Final evidence freshness: readFollowers captures now() exactly once after the last read settles (and after
// normalization), and every observation (before identity, fans, after identity) must lie in [n-maxAgeMs, n+maxSkewMs]
// at that single n, otherwise it fails with 'Stale XHS evidence'. now() must return a nonnegative safe-integer epoch ms;
// maxAgeMs/maxSkewMs must be nonnegative safe integers. Anything else fails closed (construction or 'Invalid clock').
//   identity: scope:'authenticated-self', userId; fans: path, method:'GET', userId === verified self userId
// Cancellation: the caller's AbortSignal is forwarded to every transport read. Aborted before a read => the read is
// never invoked; aborted while pending => the late value/error is discarded as cancelled once the read settles.
// Like chrome-backend.mjs we deliberately do not race the transport promise: ConnectionManager.bounded() relies on
// the call staying pending until the underlying read truly ends (reader_hung guard).
const SAFE_ID=/^[-_a-zA-Z0-9]{1,128}$/;
const nonEmpty=v=>typeof v==='string'&&v.length>0&&v.length<=512;
function cancelError(stage){const e=Error('XHS '+stage+' read cancelled');e.code='cancelled';return e;}
function snapshotSession(session){
 if(!session||!nonEmpty(session.accountId)||!nonEmpty(session.sessionId)||!nonEmpty(session.profile))throw Error('Unverified XHS session: accountId/sessionId/profile required');
 return Object.freeze({accountId:session.accountId,sessionId:session.sessionId,profile:session.profile});
}
function checkSignal(signal){if(signal!==undefined&&signal!==null&&!(signal instanceof AbortSignal))throw TypeError('signal must be an AbortSignal');return signal??undefined;}

export function createXhsAdapter({transport,now=Date.now,maxAgeMs=30000,maxSkewMs=2000,newRequestId=()=>globalThis.crypto.randomUUID()}){
 if(!transport||typeof transport.readOwnIdentity!=='function'||typeof transport.readFans!=='function')throw Error('Reviewed read-only transport required');
 if(typeof now!=='function')throw TypeError('now must be a function');
 for(const [k,v] of [['maxAgeMs',maxAgeMs],['maxSkewMs',maxSkewMs]])if(!count(v))throw RangeError(k+' must be a nonnegative safe integer');
 const clock=()=>{const n=now();if(!count(n))throw Error('Invalid clock: now() must return nonnegative safe-integer epoch ms');return n;};
 const freshAt=(t,n)=>Number.isSafeInteger(t)&&t-n<=maxSkewMs&&n-t<=maxAgeMs;
 const sameSource=(e,s,requestId)=>e.origin===origin&&e.platform==='xhs'&&e.accountId===s.accountId&&e.sessionId===s.sessionId&&e.profilePath===s.profile&&e.requestId===requestId&&freshAt(e.observedAt,clock());
 // Run one transport read under the signal: fail closed before, and after it settles either way.
 async function guarded(stage,signal,fn){
  if(signal?.aborted)throw cancelError(stage);
  let value;
  try{value=await fn();}catch(e){if(signal?.aborted)throw cancelError(stage);throw e;}
  if(signal?.aborted)throw cancelError(stage);
  return value;
 }
 async function identity(s,signal,stage){
  const requestId=newRequestId();
  if(!nonEmpty(requestId))throw Error('Request id generator failed');
  const e=await guarded(stage,signal,()=>transport.readOwnIdentity(s,{signal,requestId}));
  if(!e||typeof e!=='object'||!sameSource(e,s,requestId)||e.scope!=='authenticated-self'||!SAFE_ID.test(e.userId||''))throw Error('Unverified or wrong-session XHS identity');
  return {verified:true,platform:'xhs',userId:e.userId,observedAt:e.observedAt};
 }
 const pub=({verified,platform,userId})=>({verified,platform,userId});
 return {
  // readOwnIdentity is a privileged adapter contract, never an HTTP user payload.
  // A real implementation MUST prove this is the current creator's self identity,
  // not an arbitrary profile link, nickname, note author, or account typed by user.
  async observeIdentity(session,{signal}={}){
   signal=checkSignal(signal);if(signal?.aborted)throw cancelError('identity');
   return pub(await identity(snapshotSession(session),signal,'identity'));
  },
  async readFollowers(session,{signal}={}){
   signal=checkSignal(signal);if(signal?.aborted)throw cancelError('identity');
   const s=snapshotSession(session);
   const before=await identity(s,signal,'identity');
   const requestId=newRequestId();
   if(!nonEmpty(requestId))throw Error('Request id generator failed');
   const response=await guarded('fans',signal,()=>transport.readFans(s,{origin,path:XHS_FANS_PATH,method:'GET',requestId,signal}));
   if(!response||typeof response!=='object'||!sameSource(response,s,requestId)||response.path!==XHS_FANS_PATH||response.method!=='GET')throw Error('Response source/session mismatch');
   if(response.userId!==before.userId)throw Error('XHS account changed during read: fans response belongs to another user');
   // Snapshot evidence now: the transport-owned response object (including nested payload data) may be mutated
   // while the after read is pending. Normalize BEFORE awaiting so only newly built, validated scalars/history
   // objects survive the await; no reference into response/payload is retained across it.
   const fansAt=response.observedAt,fansData=normalizeFans(response.payload);
   const after=await identity(s,signal,'identity');
   if(before.userId!==after.userId)throw Error('XHS account changed during read');
   if(fansAt<before.observedAt||after.observedAt<fansAt)throw Error('Response source/session mismatch: out-of-order observation');
   const result={total:fansData.total,history:fansData.history,platform:'xhs',userId:before.userId};
   const n=clock();
   if(!freshAt(before.observedAt,n)||!freshAt(fansAt,n)||!freshAt(after.observedAt,n))throw Error('Stale XHS evidence at return: identity/fans observation outside freshness window');
   return result;
  },
 };
}
