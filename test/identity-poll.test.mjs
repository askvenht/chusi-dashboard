import test from 'node:test';import assert from 'node:assert/strict';
import {ConnectionManager} from '../src/connections.mjs';

const tick=ms=>new Promise(r=>setTimeout(r,ms));
function setupDom(){
 const nodes=new Map();
 const make=tag=>({tag,textContent:'',value:'',disabled:false,hidden:false,dataset:{},append(){},replaceChildren(){},setAttribute(){},addEventListener(){},focus(){},showModal(){this.open=true},close(){this.open=false},reset(){}});
 globalThis.document={querySelector:s=>{if(!nodes.has(s))nodes.set(s,make());return nodes.get(s)},querySelectorAll:()=>[],createElement:make};
 return nodes;
}
const reply=r=>r&&r.fail?{ok:false,status:r.status??409,json:async()=>({error:r.error??'x',code:r.code})}:{ok:true,json:async()=>r};
function setupFetch(responders){
 const calls=[];
 const accounts=[{id:'a1',platform:'xhs',label:'号一',total:null,works:0},{id:'a2',platform:'xhs',label:'号二',total:null,works:0}];
 globalThis.fetch=async(url,opts)=>{calls.push({url,opts});
  if(url==='/api/session')return reply({csrf:'t'});
  if(url==='/api/summary')return reply({accounts,accountsWithData:0});
  const m=url.match(/^\/api\/accounts\/([^/]+)\/(connection|identity|login|close)$/);if(!m)throw Error(url);
  const [,id,action]=m;
  if(action==='connection')return reply({accountId:id,platform:'xhs',label:id,phase:'awaiting_identity',backendReady:true});
  if(action==='identity')return reply(await responders[id](opts));
  return reply({});
 };
 return calls;
}
const identityCalls=(calls,id)=>calls.filter(c=>c.url===`/api/accounts/${id}/identity`);
const UNVERIFIED={fail:true,error:'Unverified platform identity',code:'identity_unverified'};

test('panel identity polling is bounded, per-account, deduplicated and cancellable',async()=>{
 const nodes=setupDom();const responders={a1:()=>UNVERIFIED,a2:()=>({fail:true,error:'Unverified platform identity: identity source not available',code:'identity_source_unavailable'})};
 const calls=setupFetch(responders);globalThis.__maitianPoll={intervalMs:1,maxAttempts:3,deadlineMs:10000};
 let m;
 try{
  m=await import('../web/app.js?poll');
  // 两个账号互不影响：a1 有界重试后过期，a2 立即显示身份源未接入
  const p1=m.startPoll('a1'),p2=m.startPoll('a2');
  assert.equal(await p1.done,'expired');assert.equal(await p2.done,'unavailable');
  assert.equal(identityCalls(calls,'a1').length,3);assert.equal(identityCalls(calls,'a2').length,1);
  for(const c of calls.filter(c=>c.url.endsWith('/identity')))assert.equal(JSON.parse(c.opts.body).confirmAccountId,c.url.split('/')[3]);
  assert.equal(calls.filter(c=>c.url.endsWith('/login')).length,0,'轮询绝不重新打开扫码页');
  assert.match(nodes.get('#error').textContent,/未核验/);

  // 重复点击：同一账号同时只存在一个轮询
  const r1=m.startPoll('a1'),r2=m.startPoll('a1');assert.equal(r1,r2);
  assert.equal(await r1.done,'expired');assert.equal(identityCalls(calls,'a1').length,6);
  assert.match(nodes.get('#error').textContent,/面板本轮等待已结束/);assert.match(nodes.get('#error').textContent,/不代表平台二维码已过期/);

  // 其他账号的观测结果不被接受（账号隔离）
  responders.a1=()=>({accountId:'a2',platform:'xhs',observedUserId:'other'});
  const iso=m.startPoll('a1');assert.equal(await iso.done,'expired');assert.equal(iso.observedUserId,null);

  // 只有服务端 200 且账号一致时才显示读到的身份，且仍为未绑定
  responders.a1=()=>({accountId:'a1',platform:'xhs',observedUserId:'u-1',requiresBinding:true});
  const ok=m.startPoll('a1');assert.equal(await ok.done,'observed');assert.equal(ok.observedUserId,'u-1');
  const before=identityCalls(calls,'a1').length;await tick(20);assert.equal(identityCalls(calls,'a1').length,before,'观测到后停止轮询');
  assert.match(nodes.get('#error').textContent,/u-1/);assert.match(nodes.get('#error').textContent,/尚未绑定/);

  // 取消：进行中的请求迟到返回也被忽略，且不再继续请求
  let release;responders.a1=()=>new Promise(r=>release=r);
  const c=m.startPoll('a1');while(!c.inFlight)await tick(1);
  const settled=c.cancel();assert.equal(c.state,'cancelled');
  release({accountId:'a1',platform:'xhs',observedUserId:'late'});await settled;
  assert.equal(c.state,'cancelled');assert.equal(c.observedUserId,null);
  const n=identityCalls(calls,'a1').length;await tick(20);assert.equal(identityCalls(calls,'a1').length,n);

  // 服务端无会话为终止状态，但只表示“状态未知/会话未恢复”，不得报告为窗口已关闭
  responders.a2=()=>({fail:true,error:'No active session',code:'no_session'});
  assert.equal(await m.startPoll('a2').done,'session_unknown');
  assert.doesNotMatch(nodes.get('#error').textContent,/已关闭|已不在运行/);
 }finally{if(m)await Promise.all([...m.polls.values()].map(p=>p.cancel(true)));delete globalThis.__maitianPoll;delete globalThis.document;delete globalThis.fetch;}
});

test('panel poll expires by wall clock and aborts a hung identity request',async()=>{
 setupDom();let aborted=false;
 const responders={a1:opts=>new Promise((_,reject)=>opts.signal?.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));})),a2:()=>UNVERIFIED};
 const calls=setupFetch(responders);globalThis.__maitianPoll={intervalMs:1,maxAttempts:1000,deadlineMs:30};
 let m;
 try{
  m=await import('../web/app.js?deadline');
  const p=m.startPoll('a1');assert.equal(await p.done,'expired');assert.equal(aborted,true);
  await tick(20);assert.equal(identityCalls(calls,'a1').length,1);assert.equal(p.state,'expired');
 }finally{if(m)await Promise.all([...m.polls.values()].map(p=>p.cancel(true)));delete globalThis.__maitianPoll;delete globalThis.document;delete globalThis.fetch;}
});

test('ConnectionManager.observe returns machine-readable codes without inventing identity',async()=>{
 let bound=null,result;
 const store={getAccount:id=>({id,platform:'xhs',label:'x',platform_user_id:bound}),runtimeConfig:()=>({}),claim:()=>({lease:1}),release(){}};
 const backend={start:async()=>({h:1}),observeIdentity:async()=>typeof result==='function'?result():result,stop:async()=>true};
 const cm=new ConnectionManager(store,backend);
 await assert.rejects(cm.observe('a'),e=>e.code==='no_session'&&/No active session/.test(e.message));
 await cm.login('a');
 result={verified:false,sourceUnavailable:true,platform:'xhs'};
 await assert.rejects(cm.observe('a'),e=>e.code==='identity_source_unavailable'&&/^Unverified platform identity/.test(e.message));
 result={verified:false,platform:'xhs'};
 await assert.rejects(cm.observe('a'),e=>e.code==='identity_unverified'&&e.message==='Unverified platform identity');
 result={verified:true,platform:'douyin',userId:'u'};
 await assert.rejects(cm.observe('a'),e=>e.code==='identity_unverified');
 result=()=>{throw Error('Owned browser not verified');};
 await assert.rejects(cm.observe('a'),e=>e.code==='identity_check_failed');
 bound='u-bound';result={verified:true,platform:'xhs',userId:'u-other'};
 await assert.rejects(cm.observe('a'),e=>e.code==='identity_mismatch');
 bound=null;let go;result=()=>new Promise(r=>go=r);
 const first=cm.observe('a');
 await assert.rejects(cm.observe('a'),e=>e.code==='busy');
 go({verified:true,platform:'xhs',userId:'u-1'});
 assert.deepEqual(await first,{accountId:'a',platform:'xhs',observedUserId:'u-1',nickname:null,redId:null,bound:false,requiresBinding:true});
 assert.equal(await cm.close('a'),true);
 const none=new ConnectionManager(store,{start:async()=>({}),stop:async()=>true});await none.login('b');
 await assert.rejects(none.observe('b'),e=>e.code==='identity_source_unavailable');
});
