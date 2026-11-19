// Explicit opt-in integration test. Never runs via node --test.
// Uses only about:blank, a fresh temporary profile, and owned-process shutdown.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {ChromeBackend,assertPortAvailable} from '../src/chrome-backend.mjs';
if(process.env.MAITIAN_RUN_BLANK_CHROME_TEST!=='1')throw Error('Explicit local blank-browser test opt-in required');
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'maitian-blank-verification-')));
// The only policy substitution is about:blank; production allowlist stays unchanged.
class BlankOnlyBackend extends ChromeBackend {validateProfile(plan){if(plan.loginUrl!=='about:blank'||plan.accountId!=='test-blank')throw Error('Test must stay blank');return super.validateProfile({...plan,loginUrl:'https://creator.xiaohongshu.com/'});}}
const backend=new BlankOnlyBackend({profileRoot:path.join(root,'profiles'),stateFile:path.join(root,'owned.json')});
let port;for(let p=19580;p<19600;p++){try{await assertPortAvailable(p);port=p;break;}catch{}}if(!port)throw Error('No free test port');
const plan={accountId:'test-blank',platform:'xhs',profilePath:path.join(root,'profiles/test-blank'),debugPort:port,loginUrl:'about:blank',bindAddress:'127.0.0.1',sessionId:'blank-test'};
let handle;let safeToRemove=false;
try {
 const occupied=net.createServer();await new Promise(r=>occupied.listen(port,'127.0.0.1',r));
 try{await assert.rejects(backend.start(plan),/occupied/);assert.equal(backend.active,null);console.log('PASS occupied port rejected; pre-existing socket untouched');}
 finally{await new Promise(r=>occupied.close(r));}
 handle=await backend.start(plan);console.log('PASS real dedicated Chrome started and owned listener verified; PID '+handle.pid);
 const {stdout}=await exec('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN']);
 assert.match(stdout,new RegExp(`127\\.0\\.0\\.1:${port}`));assert.doesNotMatch(stdout,new RegExp(`\\*:${port}`));
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const pages=targets.filter(t=>t.type==='page');
 assert.ok(pages.length>0);assert.ok(pages.every(t=>t.url==='about:blank'),'Non-blank page unexpectedly opened');console.log('PASS loopback-only listener and about:blank-only page; no platform URL opened');
 assert.equal((await backend.observeIdentity(handle)).verified,false);console.log('PASS blank identity is unverified; no account binding');
 await assert.rejects(backend.start(plan),/still active/);console.log('PASS duplicate runtime start blocked');
 assert.equal(await backend.stop(handle),true);handle=null;
 await assertPortAvailable(port);assert.equal(backend.active,null);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'owned.json'),'utf8')),null);
 for(let i=0;i<30;i++){const {stdout:processes}=await exec('/bin/ps',['-axo','pid=,command=']);const matches=processes.split('\n').filter(l=>l.includes(root));if(!matches.length){safeToRemove=true;break;}await sleep(100);}
 assert.equal(safeToRemove,true,'Owned helpers remain; test directory retained');console.log('PASS owned process/helpers exited; port and ownership record released');
}finally{
 if(handle){const ok=await backend.stop(handle);if(!ok)console.log('WARNING test process not confirmed exited; retained '+root);}
 if(safeToRemove){fs.rmSync(root,{recursive:true,force:true});console.log('PASS only disposable test profile removed');}
 else console.log('Retained isolated diagnostic directory: '+root);
}
