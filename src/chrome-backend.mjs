import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {loginUrls} from './connections.mjs';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function assertPortAvailable(port){
 if(!Number.isInteger(port)||port<19400||port>20000)throw Error('Port outside dedicated range');
 const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',()=>reject(Error('Dedicated port occupied; existing process untouched')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
async function ownsPort(pid,port){try{const {stdout}=await exec('/usr/sbin/lsof',['-nP','-t',`-iTCP:${port}`,'-sTCP:LISTEN']);return stdout.trim().split(/\s+/).includes(String(pid));}catch{return false;}}
function livePid(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}

// User-triggered browser launch only. There is no remote-debugging script evaluator.
export class ChromeBackend {
 constructor({profileRoot,stateFile,browserPath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',launch=spawn,portCheck=assertPortAvailable,portOwner=ownsPort,processLive=livePid,probe=async port=>{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(700)});if(!r.ok)throw Error('No browser endpoint');return r.json();},identityReaders={},followerReaders={},dailyReaders={},hostname=os.hostname}){
  this.root=path.resolve(profileRoot);this.stateFile=stateFile;this.browserPath=browserPath;this.launch=launch;this.portCheck=portCheck;this.portOwner=portOwner;this.processLive=processLive;this.probe=probe;this.identityReaders=identityReaders;this.followerReaders=followerReaders;this.dailyReaders=dailyReaders;this.hostname=hostname;this.active=null;
 }
 // Read-only view of the persisted ownership record (written right after spawn, cleared only on
 // confirmed stop). Never writes, kills, adopts or clears anything; never throws.
 // Returns null when no record exists; {accountId,alive:true|false|null} otherwise (alive:null = unknown,
 // accountId:null = unreadable record, applies to every account).
 ownedRecord(){
  let raw;try{raw=fs.readFileSync(this.stateFile,'utf8');}catch(e){return e?.code==='ENOENT'?null:{accountId:null,alive:null};}
  let rec;try{rec=JSON.parse(raw);}catch{return {accountId:null,alive:null};}
  if(rec===null)return null;
  if(typeof rec!=='object'||!Number.isSafeInteger(rec.pid))return {accountId:typeof rec?.accountId==='string'?rec.accountId:null,alive:null};
  let alive=null;try{alive=this.processLive(rec.pid)===true;}catch{alive=null;}
  return {accountId:typeof rec.accountId==='string'?rec.accountId:null,alive};
 }
 writeState(value){fs.mkdirSync(path.dirname(this.stateFile),{recursive:true,mode:0o700});const tmp=this.stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,this.stateFile);}
 validateProfile(plan){
  if(plan.loginUrl!==loginUrls[plan.platform])throw Error('Login destination not allowlisted');
  if(plan.bindAddress!=='127.0.0.1')throw Error('Loopback binding required');
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(plan.accountId))throw Error('Invalid account id');
  const expected=path.join(this.root,plan.accountId);
  if(path.resolve(plan.profilePath)!==expected)throw Error('Profile outside dedicated account root');
  fs.mkdirSync(this.root,{recursive:true,mode:0o700});
  if(fs.realpathSync(this.root)!==this.root)throw Error('Symlink profile root refused');
  if(fs.existsSync(expected)&&fs.lstatSync(expected).isSymbolicLink())throw Error('Symlink profile refused');
  // Chrome's SingletonLock is a symlink to "<hostname>-<pid>". SIGTERM shutdown can leave it behind; a lock that
  // names this host and a process that no longer exists is stale and Chrome itself takes it over on launch.
  // Any other lock (live pid, other host, unreadable) still refuses the launch.
  let lock=null;try{lock=fs.readlinkSync(path.join(expected,'SingletonLock'));}catch(e){if(e.code!=='ENOENT')throw Error('Profile already in use');}
  if(lock!==null){
   const m=/^(.+)-(\d+)$/.exec(lock);
   const stale=m&&m[1]===this.hostname()&&!this.processLive(Number(m[2]));
   if(!stale)throw Error('Profile already in use');
  }
  return expected;
 }
 async start(plan){
  if(this.active)throw Error('An owned browser is still active');
  const previous=fs.existsSync(this.stateFile)?JSON.parse(fs.readFileSync(this.stateFile,'utf8')):null;
  if(previous?.pid&&this.processLive(previous.pid))throw Error('Prior browser process still alive; manual recovery required');
  // Reserve synchronously before the first await to prevent concurrent starts.
  this.active={starting:true};let child;
  try{
   const profile=this.validateProfile(plan);await this.portCheck(plan.debugPort);
   fs.mkdirSync(profile,{recursive:true,mode:0o700});
   const initialPreferences=path.join(profile,'Default','Preferences');
   if(!fs.existsSync(initialPreferences)){
    fs.mkdirSync(path.dirname(initialPreferences),{recursive:true,mode:0o700});
    fs.writeFileSync(initialPreferences,JSON.stringify({profile:{name:`麦田 · ${plan.label || plan.accountId} [${plan.accountId}]`}}),{mode:0o600,flag:'wx'});
   }
   child=this.launch(this.browserPath,[`--user-data-dir=${profile}`,`--remote-debugging-port=${plan.debugPort}`,'--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check',plan.loginUrl],{stdio:'ignore',detached:false});
   const handle={child,pid:child.pid,accountId:plan.accountId,platform:plan.platform,port:plan.debugPort,profile,exited:false,sessionId:plan.sessionId};
   child.once('exit',()=>{handle.exited=true;});child.once('error',()=>{handle.exited=true;});this.active=handle;
   if(!Number.isSafeInteger(handle.pid))throw Error('Browser failed to start');
   this.writeState({pid:handle.pid,accountId:handle.accountId,profile,port:handle.port,sessionId:handle.sessionId,startedAt:new Date().toISOString()});
   for(let i=0;i<50;i++){
    if(handle.exited)throw Error('Owned browser exited during startup');
    if(await this.portOwner(handle.pid,handle.port)){
     try{const version=await this.probe(handle.port);if(version.webSocketDebuggerUrl)return handle;}catch{}
    }
    await delay(100);
   }
   throw Error('Dedicated browser endpoint could not be verified');
  }catch(e){
   if(this.active?.child){const stopped=await this.stop(this.active);if(!stopped){const retained=Error(e.message+'; owned process did not exit, lock retained');retained.processRetained=true;throw retained;}}
   else this.active=null;
   throw e;
  }
 }
 async observeIdentity(handle,{signal}={}){
  if(this.active!==handle||handle.exited||!(await this.portOwner(handle.pid,handle.port)))throw Error('Owned browser not verified');
  if(signal?.aborted)throw Error('Identity read cancelled');
  const reader=this.identityReaders[handle.platform];
  if(!reader)return {verified:false,sourceUnavailable:true,platform:handle.platform,reason:'账号身份读取器尚未验证，请勿采集；扫码不会被自动宣称成功'};
  // Only an explicitly installed, reviewed read-only reader may supply identity.
  const identity=await reader(handle,{signal});if(signal?.aborted)throw Error('Identity read cancelled');// An explicit 'not yet verified' (still on the login page / page loading) is passed through so callers can wait;
  // anything malformed or from another platform still fails closed.
  if(identity?.verified===false&&identity.platform===handle.platform)return {verified:false,platform:handle.platform,reason:typeof identity.reason==='string'?identity.reason:'unverified'};
  if(identity?.verified!==true||!identity.userId||identity.platform!==handle.platform)throw Error('Identity reader did not verify account');return identity;
 }
 // The ConnectionManager signal is forwarded to identity checks and the follower reader.
 // Aborted before the call => reader is never invoked; aborted while pending => the late value/error
 // is discarded as cancelled once the reader settles. We deliberately do not settle early: the
 // manager's bounded() keeps s.abandoned until the backend call really ends (reader_hung guard),
 // and bounded() already returns to the caller promptly. Identity/ownership checks are unchanged.
 async readFollowers(handle,{signal}={}){
  const reader=handle&&this.followerReaders[handle.platform];
  if(!reader)throw Error('Real collection adapter not enabled');
  const cancelled=()=>{if(signal?.aborted)throw Error('Follower read cancelled');};
  cancelled();
  const before=await this.observeIdentity(handle,{signal});cancelled();if(before.verified!==true)throw Error('Verified self identity required');
  let sample;try{sample=await reader(handle,{signal});}catch(e){cancelled();throw e;}cancelled();
  const after=await this.observeIdentity(handle,{signal});cancelled();
  if(after.verified!==true||before.userId!==after.userId||sample?.userId!==before.userId||sample?.platform!==handle.platform)throw Error('Read-only sample identity mismatch');
  return sample;
 }
 // Daily operating metrics. Ownership is re-verified right before the read; identity before/after the read is
 // checked by ConnectionManager.collectDaily, and the sample must carry the same platform user id.
 async readDaily(handle,{signal}={}){
  const reader=handle&&this.dailyReaders[handle.platform];
  if(!reader)throw Error('Daily metrics reader not available for this platform');
  if(this.active!==handle||handle.exited||!(await this.portOwner(handle.pid,handle.port)))throw Error('Owned browser not verified');
  if(signal?.aborted)throw Error('Daily read cancelled');
  const sample=await reader(handle,{signal});if(signal?.aborted)throw Error('Daily read cancelled');
  if(sample?.platform!==handle.platform||!sample.userId||!Array.isArray(sample.samples))throw Error('Daily reader returned no verified sample');
  return sample;
 }
 // Screenshot of the user's own page in the owned dedicated window (to show the platform QR code in the panel, so
 // login can be done from another computer). Read-only: no input is sent. Ownership is verified first.
 async screenshot(handle,{fetchImpl=fetch}={}){
  if(this.active!==handle||handle.exited||!(await this.portOwner(handle.pid,handle.port)))throw Error('Owned browser not verified');
  const list=await (await fetchImpl(`http://127.0.0.1:${handle.port}/json/list`,{signal:AbortSignal.timeout(2000)})).json();
  const host=new URL(loginUrls[handle.platform]).hostname;
  const pages=list.filter(t=>t.type==='page'&&(()=>{try{return new URL(t.url).hostname===host;}catch{return false;}})());
  const page=pages.at(-1); // oldest platform tab = the window the user sees (capture tabs are short-lived and newer)
  if(!page?.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${handle.port}/`))throw Error('Dedicated page not found');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  try{
   await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error('Debug socket unavailable'));setTimeout(()=>reject(Error('Debug socket timeout')),3000);});
   const r=await new Promise((resolve,reject)=>{ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id===1)d.error?reject(Error(d.error.message)):resolve(d.result);};setTimeout(()=>reject(Error('Screenshot timeout')),5000);
    ws.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'jpeg',quality:70}}));});
   return Buffer.from(r.data,'base64');
  }finally{try{ws.close();}catch{}}
 }
 async stop(handle){
  if(this.active!==handle)throw Error('Refusing to stop unowned process');
  if(!handle.exited){handle.child.kill('SIGTERM');for(let i=0;i<50&&!handle.exited;i++)await delay(100);}
  if(!handle.exited)return false;
  this.active=null;this.writeState(null);return true;
 }
}
