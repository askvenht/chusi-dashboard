import { randomUUID } from 'node:crypto';

export const loginUrls = Object.freeze({
 xhs:'https://creator.xiaohongshu.com/',
 douyin:'https://creator.douyin.com/',
 channels:'https://channels.weixin.qq.com/',
});

// Error with a stable machine-readable code for the panel's identity poller.
export const coded=(message,code)=>Object.assign(Error(message),{code});
const OWN=Symbol('manager-error');
const shanghaiToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

// All browser work is dependency-injected. Production backend is deliberately absent.
// Implementations must only expose start / observeIdentity / readFollowers / stop.
// No arbitrary script evaluation, upload, publish, cookies, or password APIs here.
export class ConnectionManager {
 constructor(store, backend=null, {opTimeoutMs=15000,daily=null,autoBind=false}={}){this.store=store;this.backend=backend;this.daily=daily;this.autoBind=autoBind;this.sessions=new Map();this.busyAccounts=new Set();this.running=new Map();this.opTimeoutMs=opTimeoutMs;}
 plan(id){const a=this.store.getAccount(id),cfg=this.store.runtimeConfig(id);return {
  accountId:id,platform:a.platform,label:a.label,windowTitle:`麦田 · ${a.label} [${id}]`,
  loginUrl:loginUrls[a.platform],profilePath:cfg.profile_path,debugPort:cfg.port,
  outputPath:cfg.output_path,databasePath:cfg.database_path,
  backendReady:!!this.backend,phase:this.phase(id),
  identityBound:!!a.platform_user_id,
 };}
 // 'awaiting_identity': this service owns a live session handle.
 // 'session_unknown': no in-memory session, but the backend's persisted ownership record says an
 //   owned browser for this account was started and never confirmed stopped (e.g. service restart).
 //   Process state is unknown: never reported as closed, never relaunched or adopted.
 // 'prepared': no session and no live/unknown ownership record (never started, or confirmed stopped).
 phase(id){
  if(this.sessions.has(id))return 'awaiting_identity';
  let rec=null;try{rec=typeof this.backend?.ownedRecord==='function'?this.backend.ownedRecord():null;}catch{rec={accountId:null,alive:null};}
  if(rec&&(rec.accountId===id||rec.accountId===null)&&rec.alive!==false)return 'session_unknown';
  return 'prepared';
 }
 assertNotUnknown(id){if(!this.sessions.has(id)&&this.phase(id)==='session_unknown')throw coded('Session not recovered: dedicated browser state unknown; not relaunched, adopted or reported closed','session_unknown');}
 // Per-account lock. A session being closed accepts no new operations (only close itself).
 serial(id,fn,forClose=false){
  if(!forClose&&this.sessions.get(id)?.closing)return Promise.reject(coded('Session is closing','session_closing'));
  if(this.busyAccounts.has(id))return Promise.reject(coded('Account operation already in progress','busy'));
  this.busyAccounts.add(id);let p;
  p=(async()=>{try{return await fn();}finally{this.busyAccounts.delete(id);if(this.running.get(id)===p)this.running.delete(id);}})();
  this.running.set(id,p);return p;
 }
 // Bounded, cancellable backend call bound to session s. Settles on result, timeout, client abort or
 // close(), so a hung reader never holds the lock. Once aborted, the backend's late value/error is
 // dropped here (never resolved to the caller); callers apply side effects only after assertCurrent.
 async bounded(s,fn,signal){
  if(s.closing)throw Object.assign(coded('Session is closing','session_closing'),{[OWN]:true});
  // Do not stack reads on a handle whose previous (abandoned) call never settled.
  if(s.abandoned>0)throw Object.assign(coded('Previous backend read still unsettled; not starting another','reader_hung'),{[OWN]:true});
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort('timeout'),this.opTimeoutMs);
  const onClient=()=>ac.abort('client');
  if(signal){if(signal.aborted)onClient();else signal.addEventListener('abort',onClient,{once:true});}
  s.inflight=ac;
  try{return await new Promise((resolve,reject)=>{
   let settled=false,started=false;
   const stop=()=>{if(started&&!settled&&ac.signal.reason!=='settled')s.abandoned=(s.abandoned||0)+1;const r=ac.signal.reason;reject(Object.assign(r==='timeout'?coded('Backend operation timed out; result will be discarded','timeout'):coded(r==='closing'?'Operation cancelled: session closing':'Operation cancelled by client','cancelled'),{[OWN]:true}));};
   if(ac.signal.aborted)return stop();
   ac.signal.addEventListener('abort',stop,{once:true});
   const done=()=>{if(!settled){settled=true;if(started&&ac.signal.aborted&&ac.signal.reason!=='settled')s.abandoned--;}};
   Promise.resolve().then(()=>{if(ac.signal.aborted)return undefined;started=true;return fn(ac.signal);})
    .then(v=>{done();if(!ac.signal.aborted)resolve(v);},e=>{done();if(!ac.signal.aborted)reject(e);});
  });}finally{clearTimeout(timer);signal?.removeEventListener('abort',onClient);if(s.inflight===ac)s.inflight=null;if(!ac.signal.aborted)ac.abort('settled');}
 }
 // Session must still be the same live, non-closing object before any state write.
 assertCurrent(id,s){if(this.sessions.get(id)!==s||s.closing)throw coded('Session closed or replaced during operation; result discarded','session_changed');}
 async login(id){return this.serial(id,async()=>{
  const plan=this.plan(id);if(!this.backend)throw Error('Real login backend not enabled');
  if(this.sessions.has(id))return this.sessions.get(id).public;
  this.assertNotUnknown(id);
  // This lock has a timeout, but backend is also responsible for a single-worker
  // process gate. No lease expiry permits launching over a live owned process.
  if(this.sessions.size>0)throw Error('Close the active account before opening another');
  const lease=this.store.claim(id);if(!lease)throw Error('Another account owns the worker');
  try{const handle=await this.backend.start({...plan,sessionId:randomUUID(),bindAddress:'127.0.0.1'});
   const pub={accountId:id,label:plan.label,phase:'awaiting_identity'};
   this.sessions.set(id,{handle,lease,public:pub,observed:null});return pub;
  }catch(e){if(!e.processRetained)this.store.release(lease);throw e;}
 });}
 async observe(id,{signal}={}){return this.serial(id,async()=>{
  this.assertNotUnknown(id);
  const s=this.sessions.get(id);if(!s)throw coded('No active session','no_session');
  if(typeof this.backend?.observeIdentity!=='function')throw coded('Unverified platform identity: identity source not available','identity_source_unavailable');
  let identity;
  try{identity=await this.bounded(s,sig=>this.backend.observeIdentity(s.handle,{signal:sig}),signal);}
  catch(e){throw e?.[OWN]?e:coded(e.message,'identity_check_failed');}
  this.assertCurrent(id,s);
  const a=this.store.getAccount(id);
  // Codes are additive; messages keep their existing prefix for compatibility.
  if(identity?.verified!==true&&identity?.sourceUnavailable===true)throw coded('Unverified platform identity: identity source not available','identity_source_unavailable');
  if(identity?.verified!==true||!identity.userId||identity.platform!==a.platform)throw coded('Unverified platform identity','identity_unverified');
  if(a.platform_user_id&&identity.userId!==a.platform_user_id)throw coded('Account identity mismatch: refusing switch','identity_mismatch');
  s.observed=identity.userId;
  // autoBind (production): the identity was read from this account's own dedicated profile, so the first verified
  // identity is bound to this card. The store's UNIQUE(platform,platform_user_id) refuses binding one platform
  // account to two cards; a later different identity is refused above as identity_mismatch.
  let bound=!!a.platform_user_id;
  if(!bound&&this.autoBind){
   const owner=this.store.findByPlatformUser(a.platform,identity.userId);
   if(owner&&owner.id!==id)throw coded(this.store.isRemoved?.(owner.id)?'这个平台账号属于已移除的卡片「'+owner.label+'」，请在“已移除的账号”里恢复它，不要重复添加':'这个平台账号已绑定到卡片「'+owner.label+'」，拒绝重复绑定','identity_taken');
   this.store.bindIdentity(id,identity.userId);bound=true;
  }
  if(bound)this.store.saveProfile(id,identity.userId,{nickname:identity.nickname??null,redId:identity.redId??null});
  return {accountId:id,platform:a.platform,observedUserId:identity.userId,nickname:identity.nickname??null,redId:identity.redId??null,bound,requiresBinding:!bound};
 });}
 async confirmBinding(id,expectedObservedId){return this.serial(id,async()=>{
  const s=this.sessions.get(id);if(!s?.observed||s.observed!==expectedObservedId)throw Error('Identity has not been observed');
  const identity=await this.bounded(s,sig=>this.backend.observeIdentity(s.handle,{signal:sig}));this.assertCurrent(id,s);const a=this.store.getAccount(id);
  if(identity?.verified!==true||identity.platform!==a.platform||identity.userId!==s.observed)throw Error('Identity changed before binding');
  this.store.bindIdentity(id,identity.userId);return {accountId:id,bound:true};
 });}
 async collectFollowers(id,day){return this.serial(id,async()=>{
  const s=this.sessions.get(id),a=this.store.getAccount(id);if(!s||!a.platform_user_id)throw Error('Verified account binding required');
  const before=await this.bounded(s,sig=>this.backend.observeIdentity(s.handle,{signal:sig}));this.assertCurrent(id,s);
  if(before?.verified!==true||before.platform!==a.platform||before.userId!==a.platform_user_id)throw Error('Account identity mismatch');
  const sample=await this.bounded(s,sig=>this.backend.readFollowers(s.handle,{signal:sig}));this.assertCurrent(id,s);
  const after=await this.bounded(s,sig=>this.backend.observeIdentity(s.handle,{signal:sig}));this.assertCurrent(id,s);
  if(after?.verified!==true||after.platform!==a.platform||after.userId!==a.platform_user_id||sample.userId!==a.platform_user_id||sample.platform!==a.platform)throw Error('Account identity changed during collection');
  this.store.saveFollowers(id,a.platform_user_id,day,sample.total,'live');return {accountId:id,day,total:sample.total};
 });}
 // Daily operating metrics: identity before, page-load sample, identity after; all must equal the bound id.
 // Nothing is written unless every check passes. Fans total (if the identity read returned it) is stored too.
 async collectDaily(id){return this.serial(id,async()=>{
  this.assertNotUnknown(id);
  if(!this.daily)throw coded('Daily store not configured','not_configured');
  const s=this.sessions.get(id),a=this.store.getAccount(id);
  if(!s)throw coded('Open this account\'s dedicated window first','no_session');
  if(!a.platform_user_id)throw coded('Verified account binding required','not_bound');
  const check=(x,stage)=>{if(x?.verified!==true||x.platform!==a.platform||x.userId!==a.platform_user_id)throw coded('Account identity mismatch '+stage+' collection; nothing written','identity_mismatch');};
  const before=await this.bounded(s,sig=>this.backend.observeIdentity(s.handle,{signal:sig}));this.assertCurrent(id,s);check(before,'before');
  const sample=await this.bounded(s,sig=>this.backend.readDaily(s.handle,{signal:sig}));this.assertCurrent(id,s);
  if(sample?.userId!==a.platform_user_id||sample.platform!==a.platform)throw coded('Daily sample belongs to another account; nothing written','identity_mismatch');
  const after=await this.bounded(s,sig=>this.backend.observeIdentity(s.handle,{signal:sig}));this.assertCurrent(id,s);check(after,'after');
  for(const x of sample.samples)this.daily.saveDaily(id,a.platform_user_id,x);
  let fansTotal=null;
  if(Number.isSafeInteger(after.fansTotal)){fansTotal=after.fansTotal;this.store.saveFollowers(id,a.platform_user_id,shanghaiToday(),fansTotal,'live');}
  this.store.saveProfile(id,a.platform_user_id,{nickname:after.nickname??null,redId:after.redId??null});
  const days=[...new Set(sample.samples.map(x=>x.day))].sort();
  return {accountId:id,saved:sample.samples.length,from:days[0]??null,to:days.at(-1)??null,fansTotal};
 });}
 hasSession(id){return this.sessions.has(id);}
 async screenshot(id){const s=this.sessions.get(id);if(!s)throw coded('No active session','no_session');if(typeof this.backend?.screenshot!=='function')throw coded('Screenshot unavailable','unavailable');return this.backend.screenshot(s.handle);}
 // close cancels any in-flight bounded backend call (instead of failing with busy), waits for the lock,
 // then stops. Concurrent/duplicate close calls share one attempt. Stop failure keeps the session
 // (fail closed) and clears the closing mark so close can be retried.
 close(id){
  const s=this.sessions.get(id);
  if(!s)return this.serial(id,async()=>{this.assertNotUnknown(id);return false;});
  if(s.closing)return s.closing;
  const run=async()=>{
   s.inflight?.abort('closing');
   const pending=this.running.get(id);if(pending)await pending.catch(()=>{});
   return this.serial(id,async()=>{
    if(this.sessions.get(id)!==s)return false;
    const exited=await this.backend.stop(s.handle);if(exited!==true)throw Error('Owned process exit not confirmed');
    this.sessions.delete(id);this.store.release(s.lease);return true;
   },true);
  };
  s.closing=run().finally(()=>{if(this.sessions.get(id)===s)s.closing=null;});
  return s.closing;
 }
}
