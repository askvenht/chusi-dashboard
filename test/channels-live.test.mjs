import test from 'node:test';import assert from 'node:assert/strict';
import {parseChannelsAuth,rangeDays,channelsDailySamples,createChannelsLiveReaders,CH_AUTH_PATH,CH_POST_TOTAL_PATH,CH_FANS_TREND_PATH,CH_POST_LIST_PATH} from '../src/adapters/channels-live.mjs';
// Fictional values in the response shapes observed on 2026-11-19.
const ts=d=>String(Date.parse(d+'T00:00:00+08:00')/1000);
const auth=(uniq='sphTestAbc123')=>JSON.stringify({errCode:0,data:{userAttr:{nickname:'管理员私人昵称',username:'AAQZ'+Math.random()},finderUser:{uniqId:uniq,nickname:'测试视频号',fansCount:100,adminNickname:'管理员'}}});
const req=(a,b)=>JSON.stringify({startTs:ts(a),endTs:ts(b),interval:3});
const postBody=(n,off=0)=>JSON.stringify({errCode:0,data:{totalData:{browse:Array.from({length:n},(_,i)=>String(100+i+off)),like:Array.from({length:n},()=> '1'),fav:Array.from({length:n},()=>'9')}}});
const fansBody=n=>JSON.stringify({errCode:0,data:{add:Array(n).fill(2),netAdd:Array(n).fill(-1),total:Array(n).fill(100)}});
const e=(body,requestBody)=>({status:201,body,requestBody,observedAt:Date.now()});
test('identity uses the stable 视频号ID, never the per-load username or admin nickname',()=>{const u=parseChannelsAuth(auth());assert.deepEqual(u,{userId:'sphTestAbc123',nickname:'测试视频号',redId:'sphTestAbc123',fansTotal:100});assert.equal(parseChannelsAuth('{"errCode":1}'),null);});
test('day ranges must be Beijing day starts',()=>{assert.deepEqual(rangeDays(req('2026-11-17','2026-11-18')),['2026-11-17','2026-11-18']);assert.equal(rangeDays(JSON.stringify({startTs:String(Date.parse('2026-11-17T00:00:00-08:00')/1000),endTs:ts('2026-11-18')})),null);});
test('widest aligned range wins; arrays map to Beijing days; ♡ like≠👍 fav; no impressions; today excluded',()=>{
 const s=channelsDailySamples({postEntries:[e(postBody(2),req('2026-11-17','2026-11-18')),e(postBody(7),req('2026-11-12','2026-11-18'))],fansEntries:[e(fansBody(7),req('2026-11-12','2026-11-18'))],postList:null,today:'2026-11-19'});
 const g=(m,d)=>s.find(x=>x.metric===m&&x.day===d)?.value;
 assert.equal(g('views','2026-11-12'),100);assert.equal(g('views','2026-11-18'),106);assert.equal(g('likes','2026-11-18'),1);
 assert.equal(g('followers_gained','2026-11-12'),2);assert.equal(g('followers_net','2026-11-12'),-1);assert.equal(s.some(x=>x.metric==='impressions'),false);
 const t=channelsDailySamples({postEntries:[e(postBody(7),req('2026-11-12','2026-11-18'))],fansEntries:[],postList:null,today:'2026-11-18'});assert.equal(t.some(x=>x.day==='2026-11-18'),false);});
test('array length mismatch or non-Beijing range is refused (no guessed dates)',()=>{const s=channelsDailySamples({postEntries:[e(postBody(6),req('2026-11-12','2026-11-18'))],fansEntries:[e(fansBody(7),JSON.stringify({startTs:'1',endTs:'2'}))],postList:null,today:'2026-11-19'});assert.equal(s.length,0);});
test('published counted only for days fully covered by the newest-first post list',()=>{
 const list=JSON.stringify({errCode:0,data:{list:[{createTime:+ts('2026-11-18')+3600},{createTime:+ts('2026-11-16')+3600},{createTime:+ts('2026-11-14')+7200},{createTime:+ts('2026-11-14')+3600}]}});
 const s=channelsDailySamples({postEntries:[e(postBody(7),req('2026-11-12','2026-11-18'))],fansEntries:[],postList:{body:list,observedAt:Date.now()},today:'2026-11-19'}).filter(x=>x.metric==='published');
 assert.deepEqual(s.map(x=>[x.day,x.value]),[['2026-11-15',0],['2026-11-16',1],['2026-11-17',0],['2026-11-18',1]]);});
test('identity reader waits on login page; daily reader refuses an account switch between page loads',async()=>{
 const calls=[];let n=0;const cap=async o=>{calls.push(o);const id=n++===1?'sphOtherAcct99':'sphTestAbc123';const m=new Map([[CH_AUTH_PATH,e(auth(id),null)]]);return {landedUrl:o.url,captured:m,all:new Map([[CH_POST_TOTAL_PATH,[e(postBody(7),req('2026-11-12','2026-11-18'))]],[CH_FANS_TREND_PATH,[e(fansBody(7),req('2026-11-12','2026-11-18'))]]])};};
 let r=createChannelsLiveReaders({capture:cap,pages:async()=>[{url:'https://channels.weixin.qq.com/login.html'}]});assert.equal((await r.identityReader({port:19419})).verified,false);assert.equal(calls.length,0);
 r=createChannelsLiveReaders({capture:cap,pages:async()=>[{url:'https://channels.weixin.qq.com/platform'}],now:()=>Date.parse('2026-11-19T09:00:00+08:00')});await assert.rejects(r.dailyReader({port:19419}),/changed/);});
