// 回归：挂起的身份读取器不得长期占用账号锁；超时/取消/关闭后迟到响应不得写入 s.observed 或影响新会话。
// 全部使用假后端，不启动真实 Chrome，不访问任何平台。
import test from 'node:test';import assert from 'node:assert/strict';
import {ConnectionManager} from '../src/connections.mjs';

const tick=ms=>new Promise(r=>setTimeout(r,ms));
function setup({timeout=30,bound=null}={}){
 const released=[],bindings=[];
 const store={getAccount:id=>({id,platform:'xhs',label:id,platform_user_id:bound}),runtimeConfig:()=>({}),claim:id=>'lease-'+id,release:t=>{released.push(t);return true;},bindIdentity:(id,u)=>bindings.push([id,u])};
 const calls=[];let starts=0,stops=0,stopResult=true;
 // 每次 observeIdentity 返回一个由测试手动控制的挂起 promise
 const backend={start:async()=>({h:++starts}),stop:async()=>{stops++;return stopResult;},
  observeIdentity:(handle,opts)=>new Promise((resolve,reject)=>calls.push({handle,signal:opts?.signal,resolve,reject}))};
 const cm=new ConnectionManager(store,backend,{opTimeoutMs:timeout});
 return {cm,calls,released,bindings,n:()=>({starts,stops}),setStop:v=>stopResult=v};
}
const good={verified:true,platform:'xhs',userId:'u-1'};

test('hung reader: observe times out, lock is freed, late response does not write observed',async()=>{
 const x=setup({timeout:20});await x.cm.login('a');
 const p=x.cm.observe('a');
 await assert.rejects(p,e=>e.code==='timeout');
 assert.equal(x.calls[0].signal.aborted,true,'后端收到取消信号');
 assert.equal(x.cm.busyAccounts.has('a'),false,'超时后释放账号锁');
 x.calls[0].resolve(good);await tick(5);
 assert.equal(x.cm.sessions.get('a').observed,null,'迟到响应不得写入 observed');
 await assert.rejects(x.cm.confirmBinding('a','u-1'),/not been observed/);
 assert.equal(x.bindings.length,0);
 // 超时后关闭正常完成，不返回 busy
 assert.equal(await x.cm.close('a'),true);assert.equal(x.n().stops,1);assert.deepEqual(x.released,['lease-a']);
});

test('close during hung observe cancels it instead of returning busy',async()=>{
 const x=setup({timeout:10000});await x.cm.login('a');
 const p=x.cm.observe('a');await tick(1);
 assert.equal(x.calls.length,1);
 const c=x.cm.close('a');
 await assert.rejects(p,e=>e.code==='cancelled');
 assert.equal(x.calls[0].signal.aborted,true);
 assert.equal(await c,true);assert.equal(x.n().stops,1);
 x.calls[0].resolve(good);await tick(5);
 assert.equal(x.cm.sessions.has('a'),false,'迟到响应不得恢复已关闭会话');
});

test('duplicate close shares one stop; new ops during closing are refused',async()=>{
 const x=setup({timeout:10000});await x.cm.login('a');
 const p=x.cm.observe('a');await tick(1);
 const c1=x.cm.close('a'),c2=x.cm.close('a');
 await assert.rejects(x.cm.observe('a'),e=>e.code==='session_closing');
 await assert.rejects(p,e=>e.code==='cancelled');
 assert.equal(await c1,true);assert.equal(await c2,true);assert.equal(x.n().stops,1,'只停止一次');
 assert.equal(await x.cm.close('a'),false,'已关闭后再次关闭为 false');
 assert.deepEqual(x.released,['lease-a']);
});

test('stop failure keeps session (fail closed) and close can be retried',async()=>{
 const x=setup({timeout:10000});await x.cm.login('a');x.setStop(false);
 await assert.rejects(x.cm.close('a'),/exit not confirmed/);
 assert.equal(x.cm.sessions.has('a'),true);assert.equal(x.released.length,0);
 x.setStop(true);assert.equal(await x.cm.close('a'),true);
});

test('late response from old session never touches the new session',async()=>{
 const x=setup({timeout:10000});await x.cm.login('a');
 const p=x.cm.observe('a');await tick(1);
 assert.equal(await Promise.allSettled([p,x.cm.close('a')]).then(r=>r[1].value),true);
 await x.cm.login('a');const s2=x.cm.sessions.get('a');assert.deepEqual(s2.handle,{h:2});
 x.calls[0].resolve(good);await tick(5);
 assert.equal(s2.observed,null,'旧会话迟到响应不得写入新会话');
 // 新会话正常核验，使用新句柄
 const p2=x.cm.observe('a');await tick(1);assert.deepEqual(x.calls[1].handle,{h:2});
 x.calls[1].resolve({verified:true,platform:'xhs',userId:'u-2'});
 assert.equal((await p2).observedUserId,'u-2');assert.equal(s2.observed,'u-2');
 await x.cm.close('a');
});

test('client abort signal cancels server-side observe and frees lock',async()=>{
 const x=setup({timeout:10000});await x.cm.login('a');
 const ac=new AbortController();const p=x.cm.observe('a',{signal:ac.signal});await tick(1);
 ac.abort();
 await assert.rejects(p,e=>e.code==='cancelled');
 assert.equal(x.cm.busyAccounts.has('a'),false);
 x.calls[0].resolve(good);await tick(5);assert.equal(x.cm.sessions.get('a').observed,null);
 // 已中止的信号不触发后端调用
 const pre=new AbortController();pre.abort();
 await assert.rejects(x.cm.observe('a',{signal:pre.signal}),e=>e.code==='cancelled');
 assert.equal(await x.cm.close('a'),true);
});

test('late rejection after timeout is swallowed (no unhandled rejection, no state change)',async()=>{
 const x=setup({timeout:10});await x.cm.login('a');
 await assert.rejects(x.cm.observe('a'),e=>e.code==='timeout');
 x.calls[0].reject(Error('late boom'));await tick(5);
 assert.equal(x.cm.sessions.get('a').observed,null);assert.equal(await x.cm.close('a'),true);
});

test('hung reader is not stacked: new read refused until abandoned call settles',async()=>{
 const x=setup({timeout:10});await x.cm.login('a');
 await assert.rejects(x.cm.observe('a'),e=>e.code==='timeout');
 await assert.rejects(x.cm.observe('a'),e=>e.code==='reader_hung');assert.equal(x.calls.length,1,'不叠加挂起读取');
 x.calls[0].resolve(good);await tick(1);
 const p=x.cm.observe('a');await tick(1);x.calls[1].resolve(good);assert.equal((await p).observedUserId,'u-1');
 assert.equal(await x.cm.close('a'),true);
});

test('confirmBinding: late response after timeout/close never binds identity',async()=>{
 const x=setup({timeout:15});await x.cm.login('a');
 const p=x.cm.observe('a');await tick(1);x.calls[0].resolve(good);await p;
 await assert.rejects(x.cm.confirmBinding('a','u-1'),e=>e.code==='timeout');
 x.calls[1].resolve(good);await tick(5);assert.equal(x.bindings.length,0);
 const p2=x.cm.confirmBinding('a','u-1');await tick(1);const c=x.cm.close('a');
 await assert.rejects(p2,e=>e.code==='cancelled');assert.equal(await c,true);
 x.calls[2].resolve(good);await tick(5);assert.equal(x.bindings.length,0,'关闭后迟到响应不得绑定');
});

test('bound account: hung reader during collect times out without saving followers',async()=>{
 const x=setup({timeout:15,bound:'u-1'});const saved=[];x.cm.store.saveFollowers=(...a)=>saved.push(a);
 x.cm.backend.readFollowers=()=>new Promise(()=>{});
 await x.cm.login('a');
 const p=x.cm.collectFollowers('a','2026-11-17');await tick(1);x.calls[0].resolve(good);
 await assert.rejects(p,e=>e.code==='timeout');assert.equal(saved.length,0);
 assert.equal(x.cm.busyAccounts.has('a'),false);assert.equal(await x.cm.close('a'),true);
});
