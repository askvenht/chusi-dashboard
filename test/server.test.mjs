import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {createDashboard} from '../src/server.mjs';
test('dashboard auth, isolation, registration and CSRF',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maitian-dashboard-'));const app=createDashboard({dataDir:dir,port:0});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/api/summary')).status,401);
 const login=await fetch(base+'/?key='+app.secret,{redirect:'manual'});assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/');assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 const headers={Cookie:'maitian_multi='+app.secret};const summary=await(await fetch(base+'/api/summary',{headers})).json();
 assert.equal(summary.accounts.length,0);assert.equal(summary.accountsWithData,0);assert.equal(summary.collectionConnected,false);assert.ok(summary.accounts.every(a=>a.total===null&&a.platform_user_id===null));
 const page=await fetch(base+'/',{headers});assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await page.text(),/小红书、抖音、视频号已接通/);assert.doesNotMatch(await (await fetch(base+'/',{headers})).text(),/发布作品到/);
 assert.equal((await fetch(base+'/api/accounts',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/summary',{headers:{...headers,Origin:'https://bad.example'}})).status,403);
 const badHost=await new Promise(r=>http.get(base+'/',{headers:{Host:'bad.example'}},res=>{res.resume();r(res.statusCode)}));assert.equal(badHost,403);
 const {csrf}=await(await fetch(base+'/api/session',{headers})).json();const postHeaders={...headers,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf};
 assert.equal((await fetch(base+'/api/accounts',{method:'POST',headers:postHeaders,body:JSON.stringify({platform:'xhs',label:'原型测试'})})).status,201);
 assert.equal((await fetch(base+'/api/accounts',{method:'POST',headers:postHeaders,body:JSON.stringify({platform:'unsupported',label:'a'})})).status,400);
 assert.equal((await fetch(base+'/api/summary',{headers}).then(r=>r.json())).accounts.length,1);
 app.store.addAccount({id:'xhs-1',platform:'xhs',label:'测试小红书'});app.store.addAccount({id:'douyin-1',platform:'douyin',label:'测试抖音'});
 const plan=await(await fetch(base+'/api/accounts/xhs-1/connection',{headers})).json();assert.equal(plan.backendReady,false);assert.equal(plan.debugPort>=19400,true);
 assert.equal((await fetch(base+'/api/accounts/xhs-1/login',{method:'POST',headers:postHeaders})).status,409);
 assert.equal((await fetch(base+'/api/accounts/xhs-1/collect',{method:'POST',headers:postHeaders})).status,409);
 assert.equal((await fetch(base+'/publish',{method:'POST',headers:postHeaders})).status,404);
});
test('opt-in exposes xhs login plan only; no process starts without exact confirmation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maitian-login-plan-'));const app=createDashboard({dataDir:dir,port:0,enableAccountLogin:true,xhsReaders:{identityReader:async()=>({verified:false,platform:'xhs'}),dailyReader:async()=>{throw Error('no')}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,headers={Cookie:'maitian_multi='+app.secret};
 app.store.addAccount({id:'xhs-1',platform:'xhs',label:'测试小红书'});app.store.addAccount({id:'douyin-1',platform:'douyin',label:'测试抖音'});
 const plan=await(await fetch(base+'/api/accounts/xhs-1/connection',{headers})).json();assert.equal(plan.backendReady,true);assert.equal(plan.identityVerified,false);assert.equal(plan.collectionEnabled,false); // unbound until a verified identity is read
 const other=await(await fetch(base+'/api/accounts/douyin-1/connection',{headers})).json();assert.equal(other.identityReaderReady,false);assert.equal(other.collectionEnabled,false);
 const {csrf}=await(await fetch(base+'/api/session',{headers})).json();const h={...headers,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf};
 assert.equal((await fetch(base+'/api/accounts/xhs-1/login',{method:'POST',headers:h,body:JSON.stringify({confirmAccountId:'xhs-2'})})).status,400);
 assert.equal((await fetch(base+'/api/accounts/douyin-1/collect',{method:'POST',headers:h,body:JSON.stringify({confirmAccountId:'douyin-1'})})).status,409); // no douyin reader yet: collection refused
 assert.equal((await fetch(base+'/api/accounts/xhs-1/collect',{method:'POST',headers:h,body:JSON.stringify({confirmAccountId:'xhs-1'})})).status,409);
 assert.equal(fs.existsSync(path.join(dir,'owned-browser.json')),false);assert.equal(fs.existsSync(path.join(dir,'profiles')),false);
});
