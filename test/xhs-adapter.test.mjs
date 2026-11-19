import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createXhsAdapter,normalizeFans,XHS_FANS_PATH} from '../src/adapters/xhs.mjs';
// All values are synthetic. No real endpoint, identity selector or browser is involved.
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/xhs-fans.json',import.meta.url)));
const ORIGIN='https://creator.xiaohongshu.com',NOW=100000;
const session={accountId:'xhs-a',sessionId:'nonce-a',profile:'/isolated/xhs-a'};
const self=(s=session,o={})=>({origin:ORIGIN,platform:'xhs',scope:'authenticated-self',accountId:s.accountId,sessionId:s.sessionId,profilePath:s.profile,observedAt:NOW,userId:'synthetic-owner',requestId:o.requestId});
const fans=(s,request)=>({origin:ORIGIN,platform:'xhs',path:XHS_FANS_PATH,method:'GET',accountId:s.accountId,sessionId:s.sessionId,profilePath:s.profile,observedAt:NOW,userId:'synthetic-owner',requestId:request.requestId,payload:structuredClone(fixture)});
// Fake transport records every call (order, signal, request id) so tests can assert what was / was not invoked.
function setup(){
 const calls=[];let seq=0;
 const t={
  async readOwnIdentity(s,o){calls.push({kind:'identity',signal:o?.signal,requestId:o?.requestId});return self(s,o);},
  async readFans(s,request){calls.push({kind:'fans',signal:request.signal,requestId:request.requestId});assert.equal(request.method,'GET');return fans(s,request);},
 };
 return {t,calls,adapter:createXhsAdapter({transport:t,now:()=>NOW,newRequestId:()=>'req-'+(++seq)})};
}
const kinds=calls=>calls.map(c=>c.kind).join(',');

// ---- parsing (unchanged) ----
test('upstream fans shape normalizes synthetic totals and historical rows',()=>{const x=normalizeFans(fixture);assert.equal(x.total,42);assert.deepEqual(x.history[1],{day:'2026-11-16',total:41,gain:3,loss:1});});
test('malformed/login response never becomes zero or fabricated data',()=>{for(const p of [{},{data:{thirty:{fans_count:-1,fans_list:[]}}},'<html>login</html>'])assert.throws(()=>normalizeFans(p));});
test('duplicate daily rows fail rather than double-count',()=>{const p=structuredClone(fixture);p.data.thirty.fans_list.push(p.data.thirty.fans_list[0]);assert.throws(()=>normalizeFans(p),/Duplicate/);});

// ---- valid flow ----
test('valid flow without a signal keeps existing caller contract',async()=>{const {adapter,calls}=setup();assert.deepEqual(await adapter.observeIdentity(session),{verified:true,platform:'xhs',userId:'synthetic-owner'});const x=await adapter.readFollowers(session);assert.equal(x.userId,'synthetic-owner');assert.equal(x.platform,'xhs');assert.equal(x.total,42);assert.equal(x.history.length,2);assert.equal(kinds(calls),'identity,identity,fans,identity');});
test('valid flow with a signal forwards the same signal and a fresh request id to every read',async()=>{const {adapter,calls}=setup();const ac=new AbortController();const x=await adapter.readFollowers(session,{signal:ac.signal});assert.equal(x.total,42);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.signal===ac.signal));assert.equal(new Set(calls.map(c=>c.requestId)).size,3);await adapter.observeIdentity(session,{signal:ac.signal});assert.equal(calls[3].signal,ac.signal);});
test('fans request carries fixed origin/path/GET only',async()=>{const {t,adapter}=setup();let req;const fn=t.readFans;t.readFans=async(s,r)=>{req=r;return fn(s,r);};await adapter.readFollowers(session);assert.equal(req.origin,ORIGIN);assert.equal(req.path,XHS_FANS_PATH);assert.equal(req.method,'GET');});
test('non-AbortSignal signal is rejected before any read',async()=>{const {adapter,calls}=setup();await assert.rejects(adapter.readFollowers(session,{signal:{aborted:false}}),TypeError);await assert.rejects(adapter.observeIdentity(session,{signal:'x'}),TypeError);assert.equal(calls.length,0);});

// ---- cancellation ----
test('already-aborted signal: no transport read is ever invoked',async()=>{const {adapter,calls}=setup();const ac=new AbortController();ac.abort('test');await assert.rejects(adapter.readFollowers(session,{signal:ac.signal}),e=>/cancelled/.test(e.message)&&e.code==='cancelled');await assert.rejects(adapter.observeIdentity(session,{signal:ac.signal}),/cancelled/);assert.equal(calls.length,0);});
// Abort while each of the three reads is pending; the read ignores the signal and resolves with valid data late.
for(const [i,label] of [[0,'before-identity'],[1,'fans'],[2,'after-identity']])test('abort during '+label+' read discards late valid result and stops later reads',async()=>{
 const {t,adapter,calls}=setup();const ac=new AbortController();const id=t.readOwnIdentity,fn=t.readFans;
 const wrap=orig=>async(...a)=>{const v=await orig(...a);if(calls.length-1===i)ac.abort('closing');return v;};
 t.readOwnIdentity=wrap(id);t.readFans=wrap(fn);
 await assert.rejects(adapter.readFollowers(session,{signal:ac.signal}),/cancelled/);assert.equal(calls.length,i+1);
});
for(const [i,label] of [[0,'before-identity'],[1,'fans'],[2,'after-identity']])test('late rejection after abort during '+label+' surfaces as cancellation, not transport error',async()=>{
 const {t,adapter,calls}=setup();const ac=new AbortController();const id=t.readOwnIdentity,fn=t.readFans;let fail;
 const wrap=orig=>async(...a)=>{const v=await orig(...a);if(calls.length-1===i)return new Promise((r,j)=>fail=j);return v;};
 t.readOwnIdentity=wrap(id);t.readFans=wrap(fn);
 const p=adapter.readFollowers(session,{signal:ac.signal});while(!fail)await new Promise(r=>setImmediate(r));
 ac.abort('closing');fail(Error('late boom'));await assert.rejects(p,e=>/cancelled/.test(e.message)&&!/boom/.test(e.message));assert.equal(calls.length,i+1);
});
test('pending read is not raced: adapter settles only after transport settles',async()=>{const {t,adapter}=setup();const ac=new AbortController();let release,settled=false;const fn=t.readFans;t.readFans=(s,r)=>new Promise(res=>release=()=>res(fn(s,r)));const p=adapter.readFollowers(session,{signal:ac.signal}).finally(()=>settled=true);p.catch(()=>{});while(!release)await new Promise(r=>setImmediate(r));ac.abort('closing');for(let k=0;k<5;k++)await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();await assert.rejects(p,/cancelled/);});
test('transport error without abort propagates unchanged',async()=>{const {t,adapter}=setup();t.readFans=async()=>{throw Error('upstream 500');};await assert.rejects(adapter.readFollowers(session,{signal:new AbortController().signal}),/upstream 500/);});
test('observeIdentity abort during read discards late identity',async()=>{const {t,adapter}=setup();const ac=new AbortController();t.readOwnIdentity=async(s,o)=>{ac.abort('x');return self(s,o);};await assert.rejects(adapter.observeIdentity(session,{signal:ac.signal}),/cancelled/);});

// ---- identity envelope provenance ----
for(const [name,change] of [['other profile',{profilePath:'/daily-profile'}],['other session',{sessionId:'nonce-b'}],['other account slot',{accountId:'xhs-b'}],['stale identity',{observedAt:1}],['future identity',{observedAt:NOW+60000}],['missing observedAt',{observedAt:undefined}],['public author',{scope:'note-author'}],['wrong origin',{origin:'https://www.xiaohongshu.com'}],['wrong platform',{platform:'douyin'}],['replayed request id',{requestId:'req-old'}],['missing request id',{requestId:undefined}],['unsafe userId',{userId:'a b'}]])test('refuse identity: '+name,async()=>{const {t,adapter}=setup();t.readOwnIdentity=async(s,o)=>({...self(s,o),...change});await assert.rejects(adapter.readFollowers(session),/Unverified/);await assert.rejects(adapter.observeIdentity(session),/Unverified/);});
test('null identity envelope is refused',async()=>{const {t,adapter}=setup();t.readOwnIdentity=async()=>null;await assert.rejects(adapter.observeIdentity(session),/Unverified/);});
test('cached before-identity replayed as after-identity is refused',async()=>{const {t,adapter}=setup();let first;const id=t.readOwnIdentity;t.readOwnIdentity=async(s,o)=>{const v=await id(s,o);if(!first){first=v;return v;}return first;};await assert.rejects(adapter.readFollowers(session),/Unverified/);});

// ---- session snapshot ----
for(const [name,bad] of [['null',null],['missing profile',{accountId:'xhs-a',sessionId:'nonce-a'}],['empty sessionId',{accountId:'xhs-a',sessionId:'',profile:'/p'}],['non-string accountId',{accountId:1,sessionId:'s',profile:'/p'}]])test('refuse incomplete session: '+name,async()=>{const {adapter,calls}=setup();await assert.rejects(adapter.readFollowers(bad),/Unverified XHS session/);await assert.rejects(adapter.observeIdentity(bad),/Unverified XHS session/);assert.equal(calls.length,0);});
test('session object mutated mid-read cannot redirect comparison to another account',async()=>{const {t,adapter}=setup();const s={...session};const fn=t.readFans;t.readFans=async(x,r)=>{s.accountId='xhs-b';s.sessionId='nonce-b';s.profile='/isolated/xhs-b';return fn(s,r);};await assert.rejects(adapter.readFollowers(s),/mismatch/);});

// ---- identity switch ----
test('identity change during read is blocked',async()=>{const {t,adapter}=setup();let n=0;const id=t.readOwnIdentity;t.readOwnIdentity=async(s,o)=>({...await id(s,o),userId:++n===1?'synthetic-owner':'second'});await assert.rejects(adapter.readFollowers(session),e=>e.message==='XHS account changed during read');});
test('identity switch between before-identity and fans read is blocked',async()=>{const {t,adapter}=setup();let n=0;const id=t.readOwnIdentity;t.readOwnIdentity=async(s,o)=>({...await id(s,o),userId:++n===1?'first':'synthetic-owner'});await assert.rejects(adapter.readFollowers(session),/changed/);});
test('fans response for a switched user is blocked even when identity is stable',async()=>{const {t,adapter}=setup();const fn=t.readFans;t.readFans=async(...a)=>({...await fn(...a),userId:'someone-else'});await assert.rejects(adapter.readFollowers(session),/changed/);});

// ---- fans response provenance ----
for(const [name,change] of [['other session',{sessionId:'other'}],['other account slot',{accountId:'xhs-b'}],['other profile',{profilePath:'/daily-profile'}],['stale response',{observedAt:1}],['future response',{observedAt:NOW+60000}],['missing observedAt',{observedAt:undefined}],['wrong platform',{platform:'douyin'}],['wrong origin',{origin:'https://www.xiaohongshu.com'}],['wrong path',{path:'/api/other'}],['non-GET',{method:'POST'}],['replayed request id',{requestId:'req-1'}],['missing request id',{requestId:undefined}]])test('refuse fans response: '+name,async()=>{const {t,adapter}=setup();const fn=t.readFans;t.readFans=async(...a)=>({...await fn(...a),...change});await assert.rejects(adapter.readFollowers(session),/mismatch/);});
test('null / non-object fans response is refused cleanly',async()=>{for(const bad of [null,undefined,'<html>login</html>']){const {t,adapter}=setup();t.readFans=async()=>bad;await assert.rejects(adapter.readFollowers(session),/mismatch/);}});
test('fans observation outside the before/after identity window is refused',async()=>{const {t}=setup();const fn=t.readFans;t.readFans=async(...a)=>({...await fn(...a),observedAt:NOW-10});const a2=createXhsAdapter({transport:t,now:()=>NOW});await assert.rejects(a2.readFollowers(session),/out-of-order/);});
test('fans observation later than after-identity is refused',async()=>{const {t,adapter}=setup();const fn=t.readFans;t.readFans=async(...a)=>({...await fn(...a),observedAt:NOW+1000});await assert.rejects(adapter.readFollowers(session),/out-of-order/);});

// ---- final evidence freshness (controlled injected clock) ----
// Read i runs pre[i] (time passes while in flight), stamps observedAt=clock+stamp[i], then runs post[i].
function timed({pre=[],post=[],stamp=[],now,...opts}={}){
 const st={t:NOW,calls:[],nowCalls:0};let seq=0;
 const step=async(i,v)=>{await pre[i]?.(st);const out={...v(),observedAt:st.t+(stamp[i]??0)};await post[i]?.(st);return out;};
 const t={
  readOwnIdentity:(s,o)=>{const i=st.calls.push('identity')-1;return step(i,()=>self(s,o));},
  readFans:(s,r)=>{const i=st.calls.push('fans')-1;return step(i,()=>fans(s,r));},
 };
 const clock=now?()=>(st.nowCalls++,now(st)):()=>(st.nowCalls++,st.t);
 return {st,adapter:createXhsAdapter({transport:t,now:clock,newRequestId:()=>'req-'+(++seq),...opts})};
}
const STALE=/Stale XHS evidence/;
const later=ms=>s=>{s.t+=ms;};
test('before evidence expiring during the fans read is refused at return',async()=>{await assert.rejects(timed({maxAgeMs:1000,pre:[null,later(1001)]}).adapter.readFollowers(session),STALE);});
test('before and fans evidence expiring while after-identity is pending is refused at return',async()=>{await assert.rejects(timed({maxAgeMs:1000,pre:[null,null,later(1001)]}).adapter.readFollowers(session),STALE);});
test('age boundary: oldest evidence exactly maxAgeMs old passes, +1 ms fails',async()=>{
 assert.equal((await timed({maxAgeMs:1000,pre:[null,null,later(1000)]}).adapter.readFollowers(session)).total,42);
 await assert.rejects(timed({maxAgeMs:1000,pre:[null,null,later(1001)]}).adapter.readFollowers(session),STALE);
 assert.equal((await timed({maxAgeMs:1000,pre:[null,later(500),later(500)]}).adapter.readFollowers(session)).total,42);
});
test('maxAgeMs 0: frozen clock passes, any elapsed time fails',async()=>{
 assert.equal((await timed({maxAgeMs:0}).adapter.readFollowers(session)).total,42);
 await assert.rejects(timed({maxAgeMs:0,pre:[null,null,later(1)]}).adapter.readFollowers(session),STALE);
});
test('skew boundary at final now: exactly maxSkewMs ahead passes, +1 ms (clock stepped back) fails',async()=>{
 const stamp=[2000,2000,2000];
 assert.equal((await timed({maxSkewMs:2000,stamp}).adapter.readFollowers(session)).total,42);
 // 4th now() call is the final capture; step it back 1 ms so only the final check can see the extra skew.
 const stepBack=s=>s.nowCalls>=4?s.t-1:s.t;
 await assert.rejects(timed({maxSkewMs:2000,stamp,now:stepBack}).adapter.readFollowers(session),STALE);
});
test('backward clock step at final capture fails closed with maxSkewMs 0',async()=>{await assert.rejects(timed({maxSkewMs:0,now:s=>s.nowCalls>=4?s.t-1:s.t}).adapter.readFollowers(session),STALE);});
for(const [name,bad] of [['NaN',NaN],['Infinity',Infinity],['negative',-1],['fractional',1.5],['numeric string','100000'],['undefined',undefined],['bigint',10n],['null',null],['unsafe',2**53]])test('invalid clock value fails closed: '+name,async()=>{
 const {adapter}=timed({now:()=>bad});await assert.rejects(adapter.readFollowers(session),/Invalid clock/);await assert.rejects(adapter.observeIdentity(session),/Invalid clock/);
});
test('throwing clock fails closed',async()=>{await assert.rejects(timed({now:()=>{throw Error('clock boom');}}).adapter.readFollowers(session),/clock boom/);});
test('clock valid for every read but invalid at the final capture fails closed',async()=>{const {adapter,st}=timed({now:s=>s.nowCalls>=4?NaN:s.t});await assert.rejects(adapter.readFollowers(session),/Invalid clock/);assert.equal(st.calls.join(','),'identity,fans,identity');});
test('invalid now option is refused at construction',()=>{for(const now of [123,'x',null,{}])assert.throws(()=>createXhsAdapter({transport:setup().t,now}),/now/);});
for(const key of ['maxAgeMs','maxSkewMs'])test('invalid '+key+' is refused at construction',()=>{for(const v of [NaN,Infinity,-Infinity,-1,1.5,'1',null,2**53,10n,{}])assert.throws(()=>createXhsAdapter({transport:setup().t,[key]:v}),new RegExp(key));});
test('valid complete flow with clock advancing within bounds keeps return shape',async()=>{
 const {adapter,st}=timed({pre:[null,later(300),later(300)]});const x=await adapter.readFollowers(session);
 assert.deepEqual(Object.keys(x).sort(),['history','platform','total','userId']);assert.equal(x.userId,'synthetic-owner');assert.equal(x.total,42);assert.equal(x.history.length,2);assert.equal(st.calls.join(','),'identity,fans,identity');
 assert.deepEqual(await adapter.observeIdentity(session),{verified:true,platform:'xhs',userId:'synthetic-owner'});
});
test('final freshness takes exactly one clock capture after the last read settles',async()=>{let at;const {adapter,st}=timed({post:[null,null,s=>{at=s.nowCalls;}]});await adapter.readFollowers(session);assert.equal(at,2);assert.equal(st.nowCalls,4);});
test('cancellation during after-identity wins over stale evidence',async()=>{const ac=new AbortController();const {adapter}=timed({maxAgeMs:1000,pre:[null,null,later(100000)],post:[null,null,()=>ac.abort('closing')]});await assert.rejects(adapter.readFollowers(session,{signal:ac.signal}),e=>/cancelled/.test(e.message)&&e.code==='cancelled');});

// ---- payload mutation while after-identity is pending (transport keeps a live reference) ----
const EXPECTED={total:42,history:[{day:'2026-11-15',total:39,gain:2,loss:0},{day:'2026-11-16',total:41,gain:3,loss:1}],platform:'xhs',userId:'synthetic-owner'};
// The fake transport retains the response it handed out and mutates it while the after-identity read is in flight.
function mutating(mutate,{abort=false}={}){
 const {t,adapter,calls}=setup();const ac=new AbortController();const box={};const fn=t.readFans,id=t.readOwnIdentity;
 t.readFans=async(...a)=>(box.held=await fn(...a));
 t.readOwnIdentity=async(s,o)=>{const v=await id(s,o);if(calls.length===3){mutate(box.held.payload,box.held);if(abort)ac.abort('closing');}return v;};
 return {adapter,calls,ac,box};
}
const collectObjects=(v,acc=new Set())=>{if(v&&typeof v==='object'&&!acc.has(v)){acc.add(v);for(const k of Object.keys(v))collectObjects(v[k],acc);}return acc;};
for(const [name,mutate] of [
 ['fans_count 42 -> 999',p=>{p.data.thirty.fans_count=999;}],
 ['history entry counts/dates rewritten',p=>{const l=p.data.thirty.fans_list;l[0].count=7777;l[1].date='2020-01-01';p.data.thirty.rise_fans_list[1].count=500;p.data.thirty.leave_fans_list[0].count=900;}],
 ['history lists pushed/spliced/replaced',p=>{p.data.thirty.fans_list.push({date:'2026-11-17',count:999});p.data.thirty.rise_fans_list.splice(0);p.data.thirty.leave_fans_list=[{date:'2026-11-16',count:888}];}],
 ['whole payload/data swapped',(p,r)=>{p.data={thirty:{fans_count:999,fans_list:[]}};r.payload={data:{thirty:{fans_count:1,fans_list:[]}}};}],
 ['payload made invalid',p=>{p.data.thirty.fans_count=-1;p.data.thirty.fans_list=null;}],
])test('mutation during after-identity cannot change returned data: '+name,async()=>{
 const m=mutating(mutate);const x=await m.adapter.readFollowers(session);
 assert.equal(kinds(m.calls),'identity,fans,identity');
 assert.deepEqual(x,EXPECTED);
});
test('returned result shares no object with the transport response/payload',async()=>{
 const m=mutating(()=>{});const x=await m.adapter.readFollowers(session);const held=m.box.held;
 const theirs=collectObjects(held);
 for(const o of collectObjects(x))assert.equal(theirs.has(o),false,'aliased object leaked');
 // Mutating the transport payload after return also cannot reach the result.
 const th=held.payload.data.thirty;th.fans_count=999;th.fans_list[0].count=1;th.fans_list.length=0;
 assert.deepEqual(x,EXPECTED);
});
test('payload fields are read once: accessor that changes on re-read cannot inject values',async()=>{
 const {t,adapter}=setup();const fn=t.readFans;
 t.readFans=async(...a)=>{const r=await fn(...a);const th=r.payload.data.thirty;let n=0,k=0;
  Object.defineProperty(th,'fans_count',{get:()=>++n===1?42:999,enumerable:true});
  Object.defineProperty(th.fans_list[0],'count',{get:()=>++k===1?39:-5,enumerable:true});return r;};
 assert.deepEqual(await adapter.readFollowers(session),EXPECTED);
});
test('invalid payload fails closed before the after-identity read is issued',async()=>{const {t,adapter,calls}=setup();const fn=t.readFans;t.readFans=async(...a)=>{const r=await fn(...a);r.payload.data.thirty.fans_count=-1;return r;};await assert.rejects(adapter.readFollowers(session),/Unsupported XHS fans/);assert.equal(kinds(calls),'identity,fans');});
test('mutation plus abort during after-identity still surfaces cancellation',async()=>{const m=mutating(p=>{p.data.thirty.fans_count=999;},{abort:true});await assert.rejects(m.adapter.readFollowers(session,{signal:m.ac.signal}),e=>/cancelled/.test(e.message)&&e.code==='cancelled');});