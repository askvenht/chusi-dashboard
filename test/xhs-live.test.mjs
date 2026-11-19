import test from 'node:test';import assert from 'node:assert/strict';
import {parseUserInfo,parseAccountBase,beijingDay,createXhsLiveReaders,XHS_USER_INFO_PATH,XHS_PERSONAL_INFO_PATH,XHS_ACCOUNT_BASE_PATH} from '../src/adapters/xhs-live.mjs';
import {openStore} from '../src/store.mjs';import {openDaily} from '../src/daily.mjs';import {ConnectionManager} from '../src/connections.mjs';

// Fictional values in the response shape observed on 2026-11-19 (no real account data).
const BJ=d=>Date.parse(d+'T00:00:00+08:00');
const userInfo=(userId='aaaa1111bbbb2222cccc3333')=>JSON.stringify({result:0,success:true,code:0,data:{userId,userName:'测试昵称',redId:'123456789',phone:'13800000000',userAvatar:'https://example.invalid/a.jpg',role:'creator'}});
const list=vals=>vals.map(([d,c])=>({date:BJ(d),count:c,count_with_double:0}));
const base=JSON.stringify({code:0,success:true,msg:'成功',data:{seven:{view_list:list([['2026-11-18',1]])},thirty:{
 publish_note_num_list:list([['2026-11-17',0],['2026-11-18',2]]),impl_count_list:list([['2026-11-17',300],['2026-11-18',250]]),
 view_list:list([['2026-11-17',40],['2026-11-18',30]]),like_list:list([['2026-11-17',1],['2026-11-18',0]]),
 net_rise_fans_count_list:list([['2026-11-17',-1],['2026-11-18',2]]),rise_fans_list:list([['2026-11-17',1],['2026-11-18',2]]),
 impl_count:550,view_count:70}}});

test('user info keeps only id, nickname and 小红书号 (phone and avatar dropped)',()=>{
 const u=parseUserInfo(userInfo());assert.deepEqual(u,{userId:'aaaa1111bbbb2222cccc3333',nickname:'测试昵称',redId:'123456789'});
 assert.equal(parseUserInfo('{"success":false}'),null);assert.equal(parseUserInfo('<html>login</html>'),null);
 assert.equal(parseUserInfo(JSON.stringify({success:true,code:0,data:{userId:'../x'}})),null);
});
test('account overview maps distinct daily lists; exposure≠views, net≠gained; zeros only when returned',()=>{
 const s=parseAccountBase(base,Date.parse('2026-11-19T01:00:00Z'));
 const get=(m,d)=>s.find(x=>x.metric===m&&x.day===d)?.value;
 assert.equal(get('impressions','2026-11-18'),250);assert.equal(get('views','2026-11-18'),30);
 assert.equal(get('followers_net','2026-11-17'),-1);assert.equal(get('followers_gained','2026-11-17'),1);
 assert.equal(get('published','2026-11-17'),0);assert.equal(s.length,12);
 assert.ok(s.every(x=>x.timeZone==='Asia/Shanghai'&&x.period==='daily'));
});
test('day boundaries must be Beijing midnight; bad shapes fail closed',()=>{
 assert.equal(beijingDay(BJ('2026-11-18')),'2026-11-18');assert.throws(()=>beijingDay(Date.parse('2026-11-18T00:00:00Z')));
 assert.throws(()=>parseAccountBase('{"success":true,"code":0,"data":{"thirty":{"view_list":[{"date":1,"count":1}]}}}',Date.now()));
 assert.throws(()=>parseAccountBase('{"success":false}',Date.now()));
 assert.throws(()=>parseAccountBase(JSON.stringify({success:true,code:0,data:{thirty:{like_list:list([['2026-11-18',-3]])}}}),Date.now()));
});

function capturing(map,landed='https://creator.xiaohongshu.com/new/home'){const calls=[];return {calls,capture:async opts=>{calls.push(opts);return {landedUrl:landed,captured:new Map(Object.entries(map).map(([k,body])=>[k,{status:200,body,observedAt:Date.now()}]))};}};}
test('identity reader waits while the dedicated window is still on the login page (opens nothing)',async()=>{
 const c=capturing({});const r=createXhsLiveReaders({capture:c.capture,pages:async()=>[{url:'https://creator.xiaohongshu.com/login?source=x'}]});
 assert.equal((await r.identityReader({port:19417})).verified,false);assert.equal(c.calls.length,0);
});
test('identity reader returns verified self identity and fans total after login',async()=>{
 const c=capturing({[XHS_USER_INFO_PATH]:userInfo(),[XHS_PERSONAL_INFO_PATH]:JSON.stringify({success:true,code:0,data:{fans_count:11}})});
 const r=createXhsLiveReaders({capture:c.capture,pages:async()=>[{url:'https://creator.xiaohongshu.com/new/home'}]});
 const id=await r.identityReader({port:19417});assert.equal(id.verified,true);assert.equal(id.userId,'aaaa1111bbbb2222cccc3333');assert.equal(id.fansTotal,11);assert.equal('phone' in id,false);
 assert.equal(c.calls[0].port,19417);assert.equal(c.calls[0].origin,'https://creator.xiaohongshu.com');
});
test('identity reader reports unverified when redirected to login',async()=>{
 const c=capturing({},'https://creator.xiaohongshu.com/login');const r=createXhsLiveReaders({capture:c.capture,pages:async()=>[{url:'https://creator.xiaohongshu.com/new/home'}]});
 assert.equal((await r.identityReader({port:19417})).verified,false);
});

function managerSetup(t,{dailyUser='aaaa1111bbbb2222cccc3333'}={}){
 const store=openStore(':memory:','/tmp/chusi-live-test');const daily=openDaily(':memory:',store);t.after(()=>{daily.close();store.close();});
 store.addAccount({id:'a',platform:'xhs',label:'卡片A'});store.addAccount({id:'b',platform:'xhs',label:'卡片B'});
 const fake={identity:{verified:true,platform:'xhs',userId:'aaaa1111bbbb2222cccc3333',nickname:'测试昵称',redId:'123456789',fansTotal:11},
  async start(plan){return plan;},async observeIdentity(){return {...this.identity};},
  async readDaily(){return {platform:'xhs',userId:dailyUser,samples:parseAccountBase(base,Date.now())};},async stop(){return true;}};
 return {store,daily,fake,m:new ConnectionManager(store,fake,{daily,autoBind:true})};
}
const range={from:'2026-11-17',to:'2026-11-18'};
test('auto-binding on first verified identity, then collection writes per-account daily data and profile',async t=>{
 const {m,store,daily}=managerSetup(t);await m.login('a');const o=await m.observe('a');
 assert.equal(o.bound,true);assert.equal(o.nickname,'测试昵称');assert.equal(store.getAccount('a').platform_user_id,'aaaa1111bbbb2222cccc3333');
 const r=await m.collectDaily('a');assert.equal(r.saved,12);assert.equal(r.fansTotal,11);
 const rep=daily.report(range);const day=rep.accounts.find(a=>a.id==='a').days.find(d=>d.day==='2026-11-18').metrics;
 assert.equal(day.impressions.value,250);assert.equal(day.views.value,30);
 assert.equal(rep.accounts.find(a=>a.id==='b').days[0].metrics.views.value,null); // other card untouched → 暂无数据
 assert.equal(rep.days[0].metrics.views.status,'partial');
 const sum=store.summary().accounts.find(a=>a.id==='a');assert.equal(sum.nickname,'测试昵称');assert.equal(sum.red_id,'123456789');assert.equal(sum.total,11);
});
test('same platform account cannot be bound to a second card (no 串号)',async t=>{
 const {m}=managerSetup(t);await m.login('a');await m.observe('a');await m.close('a');
 await m.login('b');await assert.rejects(m.observe('b'),e=>e.code==='identity_taken');
});
test('collection refuses and writes nothing if the sample or identity belongs to another account',async t=>{
 const {m,daily}=managerSetup(t,{dailyUser:'zzzz9999'});await m.login('a');await m.observe('a');
 await assert.rejects(m.collectDaily('a'),e=>e.code==='identity_mismatch');assert.equal(daily.report(range).collectionConnected,false);
});
test('identity switching between before/after checks is refused',async t=>{
 const {m,fake,daily}=managerSetup(t);await m.login('a');await m.observe('a');
 const orig=fake.readDaily;fake.readDaily=async function(){const r=await orig.call(this);fake.identity.userId='other00000000';return r;};
 await assert.rejects(m.collectDaily('a'),/mismatch/);assert.equal(daily.report(range).collectionConnected,false);
});
test('collection requires an open session and a bound identity',async t=>{
 const {m}=managerSetup(t);await assert.rejects(m.collectDaily('a'),e=>e.code==='no_session');await m.login('a');await assert.rejects(m.collectDaily('a'),e=>e.code==='not_bound');
});
