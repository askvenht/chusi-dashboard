import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createScheduler,beijingClock} from '../src/scheduler.mjs';
const at=s=>Date.parse(s+'+08:00');
function setup(t,{fail={},clock=at('2026-11-19T12:31:00')}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chusi-sched-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const accounts=[{id:'x',platform:'xhs',label:'X',platform_user_id:'u1'},{id:'d',platform:'douyin',label:'D',platform_user_id:'u2'},{id:'n',platform:'xhs',label:'未绑定',platform_user_id:null},{id:'z',platform:'zzz',label:'Z',platform_user_id:'u3'}];
 const log=[];let now=clock;
 const connections={sessions:new Map(),
  async login(id){log.push('login:'+id);this.sessions.set(id,{});return {};},
  async observe(id){log.push('observe:'+id);if(fail[id]==='login')throw Object.assign(Error('x'),{code:'identity_unverified'});return {bound:true};},
  async collectDaily(id){log.push('collect:'+id);if(fail[id]==='collect')throw Object.assign(Error('boom'),{code:'identity_mismatch'});return {saved:6,from:'2026-11-12',to:'2026-11-18'};},
  async close(id){log.push('close:'+id);this.sessions.delete(id);return true;}};
 const s=createScheduler({store:{listAccounts:()=>accounts},connections,stateFile:path.join(dir,'schedule.json'),collectPlatforms:['xhs','douyin'],now:()=>now,identityWaitMs:10,identityPollMs:1,wait:async()=>{now+=5;}});
 return {s,log,connections,dir,setNow:v=>now=v};
}
test('Beijing clock is independent of the machine time zone',()=>{assert.deepEqual(beijingClock(Date.parse('2026-11-18T20:30:00-08:00')),{day:'2026-11-19',hhmm:'12:30'});});
test('runs once per Beijing day after 12:30, one account at a time, only bound accounts of collectable platforms',async t=>{
 const {s,log,setNow}=setup(t,{clock:at('2026-11-19T12:29:00')});assert.equal(s.tick(),null);
 setNow(at('2026-11-19T12:31:00'));const r=s.tick();assert.equal(r.started,true);await r.done;
 assert.deepEqual(log,['login:x','observe:x','collect:x','close:x','login:d','observe:d','collect:d','close:d']);
 assert.equal(s.tick(),null);assert.equal(s.status().lastRunDay,'2026-11-19');assert.equal(s.status().accounts.x.ok,true);
 setNow(at('2026-11-20T13:00:00'));assert.equal(s.tick().started,true);});
test('scheduled run is deferred while the user has an account window open; manual run refuses',async t=>{
 const {s,connections,log}=setup(t);connections.sessions.set('x',{});assert.equal(s.tick().started,false);assert.equal(log.length,0);
 assert.match(s.run({manual:true}).reason,/先关闭/);connections.sessions.clear();await s.tick().done;assert.equal(log.length,8);});
test('one failing account is recorded and the others still run; every opened window is closed',async t=>{
 const {s,log}=setup(t,{fail:{x:'login',d:'collect'}});await s.tick().done;
 assert.ok(log.includes('close:x')&&log.includes('close:d'));assert.ok(!log.includes('collect:x'));
 const st=s.status().accounts;assert.equal(st.x.ok,false);assert.match(st.x.message,/重新扫码/);assert.equal(st.d.ok,false);assert.match(st.d.message,/不是已绑定/);});
test('state persists across restarts (no double run the same day); manual runs do not consume the daily run',async t=>{
 const {s,dir}=setup(t);await s.run({manual:true}).done;assert.equal(s.status().lastRunDay,null);await s.tick().done;
 const again=createScheduler({store:{listAccounts:()=>[]},connections:{sessions:new Map()},stateFile:path.join(dir,'schedule.json'),collectPlatforms:['xhs'],now:()=>at('2026-11-19T15:00:00')});
 assert.equal(again.tick(),null);assert.equal(again.status().accounts.x.ok,true);assert.equal(fs.statSync(path.join(dir,'schedule.json')).mode&0o777,0o600);});
