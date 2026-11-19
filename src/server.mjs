import {openDaily} from './daily.mjs';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import crypto from 'node:crypto';import os from 'node:os';import {openStore} from './store.mjs';import {ConnectionManager} from './connections.mjs';import {ChromeBackend} from './chrome-backend.mjs';import {createXhsLiveReaders} from './adapters/xhs-live.mjs';import {createDouyinLiveReaders} from './adapters/douyin-live.mjs';import {createChannelsLiveReaders} from './adapters/channels-live.mjs';import {createScheduler} from './scheduler.mjs';
// LAN mode only: names other computers may use to reach this Mac (non-internal IPv4 addresses and the Bonjour name).
export function lanHosts(){const out=new Set();for(const list of Object.values(os.networkInterfaces()))for(const n of list||[])if(n.family==='IPv4'&&!n.internal)out.add(n.address);const h=os.hostname();if(h){out.add(h);out.add(h.endsWith('.local')?h:h+'.local');}return [...out];}
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createDashboard({dataDir=path.join(ROOT,'data'),port=18887,enableAccountLogin=false,xhsReaders=null,platformReaders=null,collectAt='12:30',schedulerOptions={},lan=false}={}){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const secretFile=path.join(dataDir,'access-token');
 if(!fs.existsSync(secretFile))fs.writeFileSync(secretFile,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
 const secret=fs.readFileSync(secretFile,'utf8').trim();
 const csrf=crypto.randomBytes(32).toString('hex');
 const store=openStore(path.join(dataDir,'accounts.db'),path.join(dataDir,'profiles'));
 store.hideUnusedPlaceholders();
 const daily=openDaily(path.join(dataDir,'daily.db'),store);
 // Platform readers: only platforms with a live-verified reader can verify identity and collect. Every platform can
 // open its own dedicated login window (login is a prerequisite for discovering what that platform exposes).
 const readers=enableAccountLogin?(platformReaders||{xhs:xhsReaders||createXhsLiveReaders(),...(xhsReaders?{}:{douyin:createDouyinLiveReaders(),channels:createChannelsLiveReaders()})}):{};
 const collectPlatforms=Object.keys(readers).filter(p=>readers[p]?.dailyReader);
 const backend=enableAccountLogin?new ChromeBackend({profileRoot:path.join(dataDir,'profiles'),stateFile:path.join(dataDir,'owned-browser.json'),identityReaders:Object.fromEntries(Object.entries(readers).map(([p,r])=>[p,r.identityReader])),dailyReaders:Object.fromEntries(Object.entries(readers).filter(([,r])=>r.dailyReader).map(([p,r])=>[p,r.dailyReader]))}):null;
 const connections=new ConnectionManager(store,backend,{opTimeoutMs:30000,daily,autoBind:true});
 const scheduler=backend?createScheduler({store,connections,stateFile:path.join(dataDir,'schedule.json'),collectPlatforms,at:collectAt,...schedulerOptions}):null;
 for(const a of store.listAccounts())connections.plan(a.id);
 const eq=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const send=(res,status,body,type='application/json; charset=utf-8',extra={})=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",...extra});res.end(typeof body==='string'?body:JSON.stringify(body));};
 const server=http.createServer(async(req,res)=>{try{
  const boundPort=server.address()?.port || port; const hosts=[`127.0.0.1:${boundPort}`,`localhost:${boundPort}`,...(lan?lanHosts().map(h=>`${h}:${boundPort}`):[])];
  if(!hosts.includes(req.headers.host))return send(res,403,{error:'Host blocked'});
  if(req.headers.origin&&!hosts.map(h=>'http://'+h).includes(req.headers.origin))return send(res,403,{error:'Origin blocked'});
  const u=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&u.pathname==='/'&&u.searchParams.has('key')){
   if(!eq(u.searchParams.get('key'),secret))return send(res,401,{error:'Invalid key'});
   return send(res,303,'','text/plain',{'Location':'/','Set-Cookie':`maitian_multi=${secret}; Path=/; HttpOnly; SameSite=Strict`});
  }
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('maitian_multi='))?.slice(14);
  if(!eq(cookie,secret))return send(res,401,'请从桌面“麦田多账号面板”入口打开。','text/plain; charset=utf-8');
  if(req.method==='GET'&&u.pathname==='/api/daily'){try{return send(res,200,daily.report(Object.fromEntries(u.searchParams)));}catch(e){return send(res,400,{error:e.message});}}
  if(req.method==='GET'&&u.pathname==='/api/summary')return send(res,200,{...store.summary(),prototype:true,collectionConnected:!!backend&&collectPlatforms.length>0,collectionPlatforms:backend?collectPlatforms:[],loginPlatforms:backend?['xhs','douyin','channels']:[],maxConcurrentWorkers:1});
  if(req.method==='GET'&&u.pathname==='/api/accounts/removed')return send(res,200,{accounts:store.listRemoved()});
  const shot=u.pathname.match(/^\/api\/accounts\/([a-zA-Z0-9_-]+)\/screen$/);
  if(req.method==='GET'&&shot){
   if(!store.listAccounts().some(a=>a.id===shot[1]))return send(res,404,{error:'Unknown account'});
   try{const img=await connections.screenshot(shot[1]);res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(img);}
   catch(e){return send(res,409,{error:e.message,code:e.code||null});}
  }
  const life=u.pathname.match(/^\/api\/accounts\/([a-zA-Z0-9_-]+)\/(remove|restore)$/);
  if(req.method==='POST'&&life){
   const [,id,action]=life;
   if(!req.headers.origin||!eq(req.headers['x-csrf-token'],csrf))return send(res,403,{error:'CSRF blocked'});
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)return send(res,413,{error:'Request too large'});}
   let input;try{input=JSON.parse(body);}catch{return send(res,400,{error:'Invalid JSON'});}
   if(input.confirmAccountId!==id)return send(res,400,{error:'必须明确确认当前账号标识'});
   try{store.getAccount(id);}catch{return send(res,404,{error:'Unknown account'});}
   if(action==='remove'){
    if(connections.hasSession(id))return send(res,409,{error:'请先关闭这个账号的专用窗口，再移除'});
    if(scheduler?.status().current===id)return send(res,409,{error:'这个账号正在采集，请稍后再移除'});
    store.removeAccount(id);return send(res,200,{removed:true});
   }
   return send(res,200,{restored:store.restoreAccount(id)});
  }
  const connectionRoute=u.pathname.match(/^\/api\/accounts\/([a-zA-Z0-9_-]+)\/(connection|login|identity|close|collect)$/);
  if(connectionRoute){
   const [,id,action]=connectionRoute;
   if(!store.listAccounts().some(a=>a.id===id))return send(res,404,{error:'Unknown account'});
   if(req.method==='GET'&&action==='connection'){const plan=connections.plan(id);const ready=plan.backendReady;return send(res,200,{...plan,backendReady:ready,identityReaderReady:!!readers[plan.platform]?.identityReader,identityVerified:plan.identityBound,collectionEnabled:ready&&plan.identityBound&&collectPlatforms.includes(plan.platform)});}
   if(req.method==='POST'&&['login','identity','close','collect'].includes(action)){
    if(!req.headers.origin||!eq(req.headers['x-csrf-token'],csrf))return send(res,403,{error:'CSRF blocked'});
    if(action==='collect'&&!collectPlatforms.includes(store.getAccount(id).platform))return send(res,409,{error:'该平台的只读采集尚未接入'});
    if(!backend)return send(res,409,{error:action==='collect'?'真实采集尚未开放':'真实账号后端尚未启用：当前不会打开浏览器或采集。'});
    if(req.headers['content-type']!=='application/json')return send(res,415,{error:'JSON required'});
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)return send(res,413,{error:'Request too large'});}
    let input;try{input=JSON.parse(body);}catch{return send(res,400,{error:'Invalid JSON'});}
    if(input.confirmAccountId!==id)return send(res,400,{error:'必须明确确认当前账号标识'});
    try {
      if(action==='login')return send(res,200,await connections.login(id));
      if(action==='identity'){
        // Client disconnect/abort cancels the server-side bounded identity read (frees the account lock).
        const ac=new AbortController(),onClose=()=>{if(!res.writableEnded)ac.abort();};res.once('close',onClose);
        try{return send(res,200,await connections.observe(id,{signal:ac.signal}));}finally{res.off('close',onClose);}
      }
      if(action==='collect')return send(res,200,await connections.collectDaily(id));
      return send(res,200,{closed:await connections.close(id)});
    }catch(e){return send(res,409,{error:e.message,...(typeof e.code==='string'?{code:e.code}:{})});}

   }
  }
  if(req.method==='GET'&&u.pathname==='/api/session')return send(res,200,{csrf});
  if(req.method==='GET'&&u.pathname==='/api/access')return send(res,200,{lan,urls:lan?lanHosts().filter(h=>/^\d/.test(h)||h.endsWith('.local')).map(h=>`http://${h}:${boundPort}/?key=${secret}`):[]});
  if(req.method==='GET'&&u.pathname==='/api/schedule')return send(res,200,scheduler?{enabled:true,...scheduler.status()}:{enabled:false});
  if(req.method==='POST'&&u.pathname==='/api/schedule/run'){
   if(!req.headers.origin||!eq(req.headers['x-csrf-token'],csrf))return send(res,403,{error:'CSRF blocked'});
   if(!scheduler)return send(res,409,{error:'真实账号后端未启用'});
   const r=scheduler.run({manual:true});return send(res,r.started?202:409,r.started?{started:true,accounts:r.accounts}:{error:r.reason});
  }
  if(req.method==='POST'&&u.pathname==='/api/accounts'){
   if(!req.headers.origin||!eq(req.headers['x-csrf-token'],csrf))return send(res,403,{error:'CSRF blocked'});
   if(req.headers['content-type']!=='application/json')return send(res,415,{error:'JSON required'});
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return send(res,413,{error:'Request too large'});}
   let input;try{input=JSON.parse(body);}catch{return send(res,400,{error:'Invalid JSON'});}
   if(typeof input.label!=='string'||!input.label.trim()||input.label.length>80||!['xhs','douyin','channels'].includes(input.platform))return send(res,400,{error:'请输入平台与1–80字的账号备注'});
   const row=store.addAccount({id:crypto.randomUUID(),platform:input.platform,label:input.label.trim()});return send(res,201,{id:row.id});
  }
  const files={'/':'index.html','/app.js':'app.js','/daily-ui.js':'daily-ui.js','/style.css':'style.css'};
  if(req.method==='GET'&&files[u.pathname])return send(res,200,fs.readFileSync(path.join(ROOT,'web',files[u.pathname]),'utf8'),u.pathname.endsWith('.js')?'text/javascript; charset=utf-8':u.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
  return send(res,404,{error:'Not found'});
 }catch{send(res,500,{error:'本地操作失败，请重试'});}});
 return {server,store,secret,scheduler,connectionsForTest:connections,close:()=>new Promise(resolve=>{scheduler?.stop();server.close(()=>{daily.close();store.close();resolve();});})};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const lan=process.env.MAITIAN_LISTEN_LAN==='1';
 const app=createDashboard({enableAccountLogin:process.env.MAITIAN_ENABLE_ACCOUNT_LOGIN==='1',collectAt:process.env.MAITIAN_COLLECT_AT||'12:30',lan});app.scheduler?.start();app.server.listen(18887,lan?'0.0.0.0':'127.0.0.1',()=>console.log('Multi-account prototype on http://127.0.0.1:18887 (xhs/douyin/channels read-only collection '+(process.env.MAITIAN_ENABLE_ACCOUNT_LOGIN==='1'?'enabled':'disabled')+'; no publishing)'));
 for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>app.close().then(()=>process.exit(0)));
}
