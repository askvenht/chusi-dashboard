// 回归：服务重启/会话失忆时不得把专用窗口误报为已关闭，不得误示可重新启动或自动接管。
// 全部使用假后端/假 fetch，不启动真实 Chrome。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {ConnectionManager} from '../src/connections.mjs';import {ChromeBackend} from '../src/chrome-backend.mjs';

const tick=ms=>new Promise(r=>setTimeout(r,ms));
const fakeStore=()=>{const released=[];return {released,getAccount:id=>({id,platform:'xhs',label:id,platform_user_id:null}),runtimeConfig:()=>({}),claim:id=>'lease-'+id,release:t=>{released.push(t);return true;}};};
// 模拟 ChromeBackend 的持久化所有权记录：启动后写入、确认退出后清空，跨“服务重启”共享
function fakeBackend(disk){const n={start:0,stop:0};let stopResult=true;return {n,setStop:v=>stopResult=v,
 ownedRecord:()=>disk.record,
 start:async plan=>{n.start++;disk.record={accountId:plan.accountId,alive:true};return {id:plan.accountId};},
 observeIdentity:async()=>({verified:false,platform:'xhs'}),
 stop:async()=>{n.stop++;if(stopResult===true)disk.record=null;return stopResult;}};}

test('service restart: lost in-memory session is session_unknown, never prepared/closed, never relaunched or adopted',async()=>{
 const disk={record:null},store=fakeStore();
 const b1=fakeBackend(disk),cm1=new ConnectionManager(store,b1);
 // 从未启动的账号：prepared，observe 为 no_session
 assert.equal(cm1.plan('a').phase,'prepared');
 await assert.rejects(cm1.observe('a'),e=>e.code==='no_session');
 await cm1.login('a');assert.equal(cm1.plan('a').phase,'awaiting_identity');assert.equal(b1.n.start,1);

 // 服务重启：新的 ConnectionManager / 后端实例，内存会话丢失，但持久化记录仍在且进程存活
 const b2=fakeBackend(disk),cm2=new ConnectionManager(store,b2);
 assert.equal(cm2.plan('a').phase,'session_unknown');
 assert.equal(cm2.plan('b').phase,'prepared','其他从未启动的账号不受影响');
 await assert.rejects(cm2.login('a'),e=>e.code==='session_unknown');
 await assert.rejects(cm2.observe('a'),e=>e.code==='session_unknown');
 await assert.rejects(cm2.close('a'),e=>e.code==='session_unknown','不得返回 closed:false 让前端当作已关闭');
 assert.equal(b2.n.start,0,'不重新启动');assert.equal(b2.n.stop,0,'不接管/停止未持有句柄的进程');
 assert.deepEqual(disk.record,{accountId:'a',alive:true},'所有权记录保持不变');
 assert.equal(store.released.length,0,'不释放租约');

 // 进程存活状态未知或记录不可读：同样为未知
 disk.record={accountId:'a',alive:null};assert.equal(cm2.plan('a').phase,'session_unknown');
 disk.record={accountId:null,alive:null};assert.equal(cm2.plan('a').phase,'session_unknown');assert.equal(cm2.plan('b').phase,'session_unknown');
 // ownedRecord 抛错也不得让 plan 抛错或显示 prepared
 const cm3=new ConnectionManager(store,{...b2,ownedRecord:()=>{throw Error('io');}});assert.equal(cm3.plan('a').phase,'session_unknown');
 // 后端已证明记录中的 PID 不再存活：沿用原有 start() 语义（可恢复），不是“已确认关闭”文案
 disk.record={accountId:'a',alive:false};assert.equal(cm2.plan('a').phase,'prepared');
});

test('close is only confirmed by backend: stop!==true keeps session; confirmed stop returns to prepared',async()=>{
 const disk={record:null},store=fakeStore(),b=fakeBackend(disk),cm=new ConnectionManager(store,b);
 await cm.login('a');b.setStop(false);
 await assert.rejects(cm.close('a'),/not confirmed/);
 assert.equal(cm.plan('a').phase,'awaiting_identity');assert.equal(store.released.length,0);
 b.setStop(true);assert.equal(await cm.close('a'),true);
 assert.equal(cm.plan('a').phase,'prepared');assert.equal(disk.record,null);assert.deepEqual(store.released,['lease-a']);
});

test('ChromeBackend.ownedRecord is read-only and never throws',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'maitian-owned-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const stateFile=path.join(dir,'owned-browser.json');let launched=0,live=true;
 const b=new ChromeBackend({profileRoot:path.join(dir,'profiles'),stateFile,launch:()=>{launched++;throw Error('no launch in test');},processLive:()=>live});
 assert.equal(b.ownedRecord(),null,'无记录文件');
 fs.writeFileSync(stateFile,'null');assert.equal(b.ownedRecord(),null,'确认退出后清空的记录');
 const rec=JSON.stringify({pid:4242,accountId:'a',port:19450});fs.writeFileSync(stateFile,rec);
 assert.deepEqual(b.ownedRecord(),{accountId:'a',alive:true});
 live=false;assert.deepEqual(b.ownedRecord(),{accountId:'a',alive:false});
 b.processLive=()=>{throw Error('x');};assert.deepEqual(b.ownedRecord(),{accountId:'a',alive:null});
 assert.equal(fs.readFileSync(stateFile,'utf8'),rec,'记录未被改写');
 fs.writeFileSync(stateFile,'{garbage');assert.deepEqual(b.ownedRecord(),{accountId:null,alive:null});
 fs.writeFileSync(stateFile,JSON.stringify({accountId:'a'}));assert.deepEqual(b.ownedRecord(),{accountId:'a',alive:null});
 assert.equal(launched,0);assert.equal(fs.existsSync(path.join(dir,'profiles')),false);
});

// ---- 前端 ----
function setupDom(){
 const nodes=new Map();
 const make=tag=>({tag,onclick:null,children:[],textContent:'',value:'',disabled:false,hidden:false,dataset:{},append(...c){this.children.push(...c);},replaceChildren(...c){this.children=c;},setAttribute(){},addEventListener(){},focus(){},showModal(){this.open=true},close(){this.open=false},reset(){}});
 globalThis.document={querySelector:s=>{if(!nodes.has(s))nodes.set(s,make());return nodes.get(s)},querySelectorAll:()=>[],createElement:make};
 return nodes;
}
const reply=r=>r&&r.fail?{ok:false,status:r.status??409,json:async()=>({error:r.error??'x',code:r.code})}:{ok:true,json:async()=>r};
const cardButton=(nodes,label)=>{const card=nodes.get('#accountGrid').children.find(c=>c.children.some(x=>x.tag==='h3'&&x.textContent===label));return card.children.filter(x=>x.tag==='button')[0];};
const cardStatus=(nodes,label)=>{const card=nodes.get('#accountGrid').children.find(c=>c.children.some(x=>x.tag==='h3'&&x.textContent===label));return card.children[0].children[1].textContent;};
const CLOSED=/已关闭|已确认|已不在运行/;

test('panel: restart/no_session/prepared responses show unknown state, never closed or relaunchable',async()=>{
 const nodes=setupDom();
 const ids=['a1','a2','a3','a4','a5','a6'];
 const accounts=ids.map(id=>({id,platform:'xhs',label:'号'+id,total:null,works:0}));
 const phase={a1:'awaiting_identity',a2:'session_unknown',a3:'prepared',a4:'awaiting_identity',a5:'awaiting_identity',a6:'awaiting_identity'};
 const identity={a1:()=>({fail:true,error:'Unverified platform identity',code:'identity_unverified'}),a6:()=>({fail:true,error:'No active session',code:'no_session'})};
 const closeReply={a4:{closed:false},a5:{closed:true}};
 const calls=[];
 globalThis.fetch=async(url,opts)=>{calls.push({url,opts});
  if(url==='/api/session')return reply({csrf:'t'});
  if(url==='/api/summary')return reply({accounts,accountsWithData:0,loginPlatforms:['xhs'],collectionPlatforms:['xhs']});
  const [,id,action]=url.match(/^\/api\/accounts\/([^/]+)\/(connection|identity|login|close)$/)||[];if(!id)throw Error(url);
  if(action==='connection')return reply({accountId:id,platform:'xhs',label:'号'+id,phase:phase[id],backendReady:true,debugPort:19401,profilePath:'p',databasePath:'d',outputPath:'o'});
  if(action==='identity')return reply(await (identity[id]||identity.a1)(opts));
  if(action==='close')return reply(closeReply[id]??{closed:false});
  return reply({});
 };
 globalThis.__maitianPoll={intervalMs:5,maxAttempts:1000,deadlineMs:10000};
 let m;
 try{
  m=await import('../web/app.js?session-unknown');

  // 1) 服务端返回 no_session：终止为状态未知，而不是“已关闭”
  const p6=m.startPoll('a6');assert.equal(await p6.done,'session_unknown');
  assert.match(nodes.get('#error').textContent,/无法确认/);assert.doesNotMatch(nodes.get('#error').textContent,CLOSED);

  // 2) 轮询中服务重启：/connection 变为 prepared（内存会话丢失），轮询终止为状态未知，卡片不可启动
  const p1=m.startPoll('a1');await tick(20);assert.equal(p1.state,'polling');
  phase.a1='prepared';await nodes.get('#syncStatus').onclick();
  assert.equal(p1.state,'session_unknown');assert.ok(m.lostSessions.has('a1'));
  let btn=cardButton(nodes,'号a1');assert.equal(btn.disabled,true);assert.match(btn.textContent,/状态未知/);assert.equal(btn.onclick,null);
  assert.match(cardStatus(nodes,'号a1'),/状态未知/);assert.doesNotMatch(cardStatus(nodes,'号a1'),CLOSED);
  await m.showConnection('a1');
  assert.equal(nodes.get('#launchLogin').disabled,true,'不得误示可重复启动');assert.equal(nodes.get('#stopLogin').hidden,true);
  assert.match(nodes.get('#connectionDetails').textContent,/状态未知/);assert.doesNotMatch(nodes.get('#connectionDetails').textContent,/未启动专用窗口|已关闭/);
  await nodes.get('#launchLogin').onclick();
  // 再次刷新仍保持未知（不会被下一次 load 清掉）
  await nodes.get('#syncStatus').onclick();assert.equal(cardButton(nodes,'号a1').disabled,true);

  // 3) 新页面打开时服务端即报告 session_unknown（重启后有存活的所有权记录）
  btn=cardButton(nodes,'号a2');assert.equal(btn.disabled,true);assert.match(btn.textContent,/状态未知/);
  await m.showConnection('a2');assert.equal(nodes.get('#launchLogin').disabled,true);assert.equal(nodes.get('#stopLogin').hidden,true);
  assert.doesNotMatch(nodes.get('#connectionDetails').textContent,CLOSED);

  // 4) 从未启动的账号：仍可正常启动
  btn=cardButton(nodes,'号a3');assert.equal(btn.disabled,false);assert.equal(btn.textContent,'登录此账号');
  await m.showConnection('a3');assert.equal(nodes.get('#launchLogin').disabled,false);assert.match(nodes.get('#connectionDetails').textContent,/未启动专用窗口/);

  // 5) 关闭必须经后端确认：closed:false 不显示已确认，不开放启动
  await m.showConnection('a4');assert.equal(nodes.get('#stopLogin').hidden,false);
  phase.a4='prepared';await nodes.get('#stopLogin').onclick();
  assert.doesNotMatch(nodes.get('#connectionDetails').textContent,/已确认/);assert.equal(nodes.get('#launchLogin').disabled,true);
  assert.match(nodes.get('#connectionMessage').textContent,/无法确认/);assert.ok(m.lostSessions.has('a4'));
  assert.equal(cardButton(nodes,'号a4').disabled,true);

  // 6) closed:true（后端确认自有进程退出）才显示已确认并允许再次启动
  await m.showConnection('a5');phase.a5='prepared';await nodes.get('#stopLogin').onclick();
  assert.match(nodes.get('#connectionDetails').textContent,/已确认专用进程退出/);assert.equal(nodes.get('#launchLogin').disabled,false);
  assert.equal(m.lostSessions.has('a5'),false);assert.equal(cardButton(nodes,'号a5').disabled,false);

  assert.equal(calls.filter(c=>c.url.endsWith('/login')).length,0,'全程不重新打开/接管窗口');
 }finally{if(m)await Promise.all([...m.polls.values()].map(p=>p.cancel(true)));delete globalThis.__maitianPoll;delete globalThis.document;delete globalThis.fetch;}
});
