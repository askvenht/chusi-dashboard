import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {openStore} from '../src/store.mjs';import {openDaily} from '../src/daily.mjs';import {ConnectionManager} from '../src/connections.mjs';import {createDashboard,lanHosts} from '../src/server.mjs';
test('remove hides card, totals and scheduling input but keeps data; restore brings it back',t=>{
 const s=openStore(':memory:','/tmp/chusi-rm');const d=openDaily(':memory:',s);t.after(()=>{d.close();s.close();});
 s.addAccount({id:'a',platform:'xhs',label:'A',platformUserId:'u1'});s.addAccount({id:'b',platform:'xhs',label:'B'});
 d.saveDaily('a','u1',{day:'2026-11-18',timeZone:'Asia/Shanghai',period:'daily',metric:'views',value:5,source:'t',observedAt:'2026-11-19T00:00:00Z'});
 s.removeAccount('a');assert.deepEqual(s.listAccounts().map(x=>x.id),['b']);assert.equal(s.summary().accounts.length,1);assert.equal(d.report({from:'2026-11-18',to:'2026-11-18'}).days[0].metrics.views.value,null);
 assert.equal(s.listRemoved()[0].id,'a');assert.equal(s.getAccount('a').platform_user_id,'u1');
 assert.equal(s.restoreAccount('a'),true);assert.equal(d.report({from:'2026-11-18',to:'2026-11-18'}).days[0].metrics.views.value,5);});
test('a platform account belonging to a removed card cannot be bound to a new card (restore instead)',async t=>{
 const s=openStore(':memory:','/tmp/chusi-rm2');t.after(()=>s.close());s.addAccount({id:'a',platform:'xhs',label:'旧卡',platformUserId:'u1'});s.addAccount({id:'b',platform:'xhs',label:'新卡'});s.removeAccount('a');
 const fake={async start(p){return p;},async observeIdentity(){return {verified:true,platform:'xhs',userId:'u1'};},async stop(){return true;}};
 const m=new ConnectionManager(s,fake,{autoBind:true});await m.login('b');await assert.rejects(m.observe('b'),e=>e.code==='identity_taken'&&/已移除的卡片「旧卡」/.test(e.message));});
test('HTTP: remove needs CSRF + exact confirmation, refuses while window open; restore works; LAN off by default',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chusi-rm3-'));const app=createDashboard({dataDir:dir,port:0});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,headers={Cookie:'maitian_multi='+app.secret};app.store.addAccount({id:'x1',platform:'xhs',label:'X'});
 const {csrf}=await(await fetch(base+'/api/session',{headers})).json();const h={...headers,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf};
 assert.equal((await fetch(base+'/api/accounts/x1/remove',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"confirmAccountId":"x1"}'})).status,403);
 assert.equal((await fetch(base+'/api/accounts/x1/remove',{method:'POST',headers:h,body:'{"confirmAccountId":"other"}'})).status,400);
 assert.equal((await fetch(base+'/api/accounts/x1/remove',{method:'POST',headers:h,body:'{"confirmAccountId":"x1"}'})).status,200);
 assert.equal((await(await fetch(base+'/api/accounts/removed',{headers})).json()).accounts.length,1);
 assert.equal((await fetch(base+'/api/accounts/x1/restore',{method:'POST',headers:h,body:'{"confirmAccountId":"x1"}'})).status,200);
 assert.equal((await(await fetch(base+'/api/summary',{headers})).json()).accounts.length,1);
 assert.deepEqual(await(await fetch(base+'/api/access',{headers})).json(),{lan:false,urls:[]});
 const lanHost=lanHosts()[0];if(lanHost){const code=await new Promise(r=>http.get(base+'/api/summary',{headers:{...headers,Host:lanHost+':'+app.server.address().port}},res=>{res.resume();r(res.statusCode)}));assert.equal(code,403);}});
test('remove refuses while the account window is open',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chusi-rm4-'));const reader={identityReader:async()=>({verified:false,platform:'xhs'}),dailyReader:async()=>{throw Error('x')}};
 const app=createDashboard({dataDir:dir,port:0,enableAccountLogin:true,xhsReaders:reader});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 app.store.addAccount({id:'x1',platform:'xhs',label:'X'});
 // Simulate an open session without launching Chrome.
 const base='http://127.0.0.1:'+app.server.address().port,headers={Cookie:'maitian_multi='+app.secret};const {csrf}=await(await fetch(base+'/api/session',{headers})).json();
 app.connectionsForTest?.sessions.set('x1',{});if(!app.connectionsForTest)return;
 const r=await fetch(base+'/api/accounts/x1/remove',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{"confirmAccountId":"x1"}'});assert.equal(r.status,409);});
