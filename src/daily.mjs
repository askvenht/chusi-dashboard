import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
export const METRICS=['published','impressions','views','likes','followers_net','followers_gained'];
export const TZ='Asia/Shanghai';
export function dayInZone(at=new Date(),timeZone=TZ){return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);}
const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
export function openDaily(file,accounts){
 if(file!==':memory:'&&!fs.existsSync(file))fs.closeSync(fs.openSync(file,'wx',0o600));
 const db=new DatabaseSync(file);db.exec(`CREATE TABLE IF NOT EXISTS daily(account_id TEXT,day TEXT,tz TEXT,metric TEXT,value INTEGER,source TEXT,observed_at TEXT,PRIMARY KEY(account_id,day,tz,metric));CREATE TABLE IF NOT EXISTS snapshots(account_id TEXT,observed_at TEXT,metric TEXT,value INTEGER,source TEXT,PRIMARY KEY(account_id,observed_at,metric));`);
 const check=(id,userId,s)=>{const a=accounts.getAccount(id);if(!a.platform_user_id||a.platform_user_id!==userId)throw Error('Identity mismatch');if(!METRICS.includes(s.metric)||!Number.isSafeInteger(s.value)||(s.metric!=='followers_net'&&s.value<0)||!s.source?.trim()||!s.observedAt||!Number.isFinite(Date.parse(s.observedAt))||!/(Z|[+-]\d\d:\d\d)$/.test(s.observedAt))throw Error('Invalid observation');};
 return {close:()=>db.close(),
 saveDaily(id,userId,s){check(id,userId,s);if(!validDay(s.day)||s.timeZone!==TZ||s.period!=='daily')throw Error('Daily period/timezone required');db.prepare('INSERT INTO daily VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,day,tz,metric) DO UPDATE SET value=excluded.value,source=excluded.source,observed_at=excluded.observed_at WHERE excluded.observed_at>=daily.observed_at').run(id,s.day,s.timeZone,s.metric,s.value,s.source,new Date(s.observedAt).toISOString());},
 saveSnapshot(id,userId,s){check(id,userId,s);if(s.period!=='cumulative'||s.metric.startsWith('followers_'))throw Error('Cumulative metric required');db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?)').run(id,new Date(s.observedAt).toISOString(),s.metric,s.value,s.source);},
 report({from=dayInZone(new Date(Date.now()-6*86400000)),to=dayInZone(),platform='all',accountId='all'}={}){
 if(!validDay(from)||!validDay(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>90)throw Error('请选择最多91天的有效日期');
 if(!['all','xhs','douyin','channels'].includes(platform))throw Error('Invalid platform');
 const rows=accounts.listAccounts().filter(a=>(platform==='all'||a.platform===platform)&&(accountId==='all'||a.id===accountId));
 const days=[];for(let d=Date.parse(from);d<=Date.parse(to);d+=86400000)days.push(new Date(d).toISOString().slice(0,10));
 const observations=db.prepare('SELECT * FROM daily WHERE day>=? AND day<=? AND tz=?').all(from,to,TZ);const byKey=new Map(observations.map(o=>[`${o.account_id}/${o.day}/${o.metric}`,o]));
 const totals=(list,day)=>Object.fromEntries(METRICS.map(metric=>{const found=list.map(a=>byKey.get(`${a.id}/${day}/${metric}`)).filter(Boolean);return [metric,{value:found.length?found.reduce((n,x)=>n+x.value,0):null,covered:found.length,expected:list.length,status:!found.length?'missing':found.length<list.length?'partial':'complete'}]}));
 return {timeZone:TZ,from,to,collectionConnected:observations.some(o=>rows.some(a=>a.id===o.account_id)),days:days.map(day=>({day,metrics:totals(rows,day)})),platforms:['xhs','douyin','channels'].filter(p=>rows.some(a=>a.platform===p)).map(platform=>({platform,days:days.map(day=>({day,metrics:totals(rows.filter(a=>a.platform===platform),day)}))})),accounts:rows.map(a=>({id:a.id,label:a.label,platform:a.platform,days:days.map(day=>({day,metrics:totals([a],day)}))})),note:'北京时间自然日；曝光与浏览分列；涨粉净增与平台新增粉分列，不混算。累计快照不转换为每日增量。'};
 }
 };
}
// Adapter boundary: transport must provide authenticated account identity before and after read.
export async function collectDailyReadOnly({accountId,store,transport}){const before=await transport.identity();if(!before?.verified||before.accountId!==accountId)throw Error('Unverified account');const samples=await transport.readDaily();const after=await transport.identity();if(!after?.verified||after.accountId!==accountId||before.userId!==after.userId||before.sessionId!==after.sessionId||!before.sessionId)throw Error('Account/session changed');for(const s of samples)store.saveDaily(accountId,before.userId,s);return samples.length;}
