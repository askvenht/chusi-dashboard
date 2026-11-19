const $=s=>document.querySelector(s),names={xhs:'小红书',douyin:'抖音',channels:'视频号'};let state,filter='all',csrf,busy=false,currentConnection=null,connectionStates=new Map();
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
async function api(url,options){const r=await fetch(url,options);if(!r.ok){let j={};try{j=await r.json()||{};}catch{}throw Object.assign(Error(j.error||'请求失败，请从桌面入口重新打开'),{code:j.code,status:r.status});}return r.json();}
const postAccount=(id,action,signal)=>api('/api/accounts/'+encodeURIComponent(id)+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({confirmAccountId:id}),signal});

// ---- 身份核验轮询：只调用现有 POST /api/accounts/:id/identity，按账号隔离，有次数和总时长上限 ----
const pollCfg=globalThis.__maitianPoll||{};
const POLL_MS=pollCfg.intervalMs??3000,POLL_MAX=pollCfg.maxAttempts??40,POLL_DEADLINE_MS=pollCfg.deadlineMs??120000;
export const polls=new Map();
// no_session / session_unknown 只说明服务端没有该账号的会话（例如服务重启后丢失），不能证明窗口已关闭
const TERMINAL_CODES={no_session:'session_unknown',session_unknown:'session_unknown',identity_mismatch:'mismatch',identity_source_unavailable:'unavailable'};
// 本页曾打开过、但未经后端确认关闭就失去会话的账号：状态未知，禁止从面板再次启动
export const lostSessions=new Set();
const UNKNOWN_TEXT='状态未知 · 会话未恢复';
const isUnknown=id=>lostSessions.has(id)||polls.get(id)?.state==='session_unknown'||connectionStates.get(id)?.phase==='session_unknown';
const TERMINAL_STATUS=new Set([400,401,403,404,413,415]);
const labelOf=id=>'「'+(state?.accounts?.find(a=>a.id===id)?.label??id)+'」';
function pollMessage(id,p){const l=labelOf(id);switch(p.state){
 case 'polling':return l+'专用窗口已打开。正在等待平台身份回传并核验（面板最多等待约'+Math.round(POLL_DEADLINE_MS/1000)+'秒）；请在该窗口由你本人扫码，无需重复点击或重复扫码。核验前采集和发布保持禁用。';
 case 'observed':return p.bound?l+'已识别并绑定平台账号：'+(p.nickname||'未返回昵称')+(p.redId?'（平台号 '+p.redId+'）':'')+'。正在自动采集每日数据…':l+'已从专用窗口读取到平台身份（'+p.observedUserId+'），尚未绑定。';
 case 'expired':return l+'面板本轮等待已结束，身份仍未核验（这不代表平台二维码已过期）。如已扫码完成，可点击“重新检查登录状态”，不会重新打开扫码页。';
 case 'unavailable':return l+'专用窗口已打开。该平台的身份读取正在接入：请你本人在窗口里扫码登录，登录后保持窗口打开、不要反复扫码。身份核验前不采集，本面板不发布。';
 case 'mismatch':return l+'检测到的平台身份与该账号已绑定身份不一致，已拒绝切换。';
 case 'session_unknown':return l+'面板服务端当前没有该账号的窗口会话（可能是服务重启后会话丢失），无法确认专用窗口是否仍在运行。身份未核验，已停止检查。面板不会自动接管或重新打开该窗口，请勿重复登录或扫码。';
 case 'failed':return l+'身份核验请求被拒绝：'+(p.lastError||'未知原因')+'。已停止检查，身份未核验。';
 default:return l+'已停止身份检查，身份未核验。';}}
function notify(id,p,announce){if(state)render();if(announce)$('#error').textContent=pollMessage(id,p);}
export function startPoll(id){
 const cur=polls.get(id);if(cur?.state==='polling')return cur; // 重复点击防护：同一账号只保留一个轮询
 let timer=null,deadline=null,controller=null,finish;
 const p={id,state:'polling',attempt:0,max:POLL_MAX,observedUserId:null,lastError:null,inFlight:null};
 p.done=new Promise(r=>finish=r);
 const end=st=>{if(p.state!=='polling')return false;p.state=st;clearTimeout(timer);clearTimeout(deadline);timer=deadline=null;finish(st);return true;};
 const tick=async()=>{timer=null;if(p.state!=='polling'||p.inFlight)return;p.attempt++;
  controller=typeof AbortController==='function'?new AbortController():null;let outcome=null;
  const req=(async()=>{try{const r=await postAccount(id,'identity',controller?.signal);if(p.state!=='polling')return;
    // 仅接受服务端 200 且账号一致的观测结果；不在前端推断身份
    if(r&&r.accountId===id&&typeof r.observedUserId==='string'&&r.observedUserId){p.observedUserId=r.observedUserId;p.nickname=r.nickname||null;p.redId=r.redId||null;p.bound=r.bound===true;outcome='observed';}
   }catch(e){if(p.state!=='polling')return;
    if(TERMINAL_CODES[e.code])outcome=TERMINAL_CODES[e.code];
    else if(TERMINAL_STATUS.has(e.status)){outcome='failed';p.lastError=e.message;}
    else if(['timeout','cancelled','reader_hung','session_closing','session_changed'].includes(e.code))p.lastError='身份读取超时或已取消，结果已丢弃，未核验。';
    else if(e.code!=='identity_unverified'&&e.code!=='busy')p.lastError=e.message;}})();
  p.inFlight=req;await req;p.inFlight=null;controller=null;
  if(p.state!=='polling')return; // 已取消/已过期：迟到的响应一律忽略
  if(!outcome&&p.attempt>=p.max)outcome='expired';
  if(outcome){end(outcome);notify(id,p,true);if(outcome==='observed'&&p.bound)collect(id);}else{timer=setTimeout(tick,POLL_MS);notify(id,p,false);}
 };
 // abort=true 用于页面关闭；关窗流程不中断请求，而是等它结束，避免与服务端账号锁冲突
 p.cancel=(abort=false)=>{end('cancelled');if(abort)controller?.abort();return p.inFlight||Promise.resolve();};
 p.finishAs=st=>{if(end(st))notify(id,p,true);};
 p.checkNow=()=>{if(p.state==='polling'&&!p.inFlight){clearTimeout(timer);tick();}};
 deadline=setTimeout(()=>{if(end('expired')){controller?.abort();notify(id,p,true);}},POLL_DEADLINE_MS);
 polls.set(id,p);timer=setTimeout(tick,0);notify(id,p,true);return p;
}
function recheck(id){if(polls.get(id)?.state==='polling')return;startPoll(id);}

function statusText(a){if(collecting.has(a.id))return '正在采集…';if(a.platform_user_id)return connectionStates.get(a.id)?.phase==='awaiting_identity'?'身份已核验 · 专用窗口已打开':'身份已核验';if(isUnknown(a.id))return UNKNOWN_TEXT+' · 身份未核验';const p=polls.get(a.id);
 switch(p?.state){case 'polling':return '等待扫码 · 核验中（'+p.attempt+'/'+p.max+'）';case 'observed':return '已读取平台身份 · 未绑定';case 'expired':return '面板等待已结束 · 身份未核验';case 'unavailable':return '身份读取器未接入 · 未核验';case 'mismatch':return '身份不一致 · 已拒绝';case 'failed':return '核验请求失败 · 身份未核验';}
 const phase=connectionStates.get(a.id)?.phase;
 return phase==='awaiting_identity'?'登录窗口已打开 · 身份未核验':phase==='unreachable'?'窗口状态读取失败 · 身份未核验':'身份未核验';}
function loginButton(a){const active=connectionStates.get(a.id)?.phase==='awaiting_identity',p=polls.get(a.id);let text,disabled=false,onclick=null;
 if(!state.loginPlatforms?.includes(a.platform)){text='登录尚未开放';disabled=true;}
 else if(collecting.has(a.id)){text='正在采集…';disabled=true;}
 else if(active&&a.platform_user_id&&p?.state!=='polling'&&state.collectionPlatforms?.includes(a.platform)){text='采集最新数据';onclick=()=>collect(a.id);}
 else if(!active&&isUnknown(a.id)){text=UNKNOWN_TEXT;disabled=true;}
 else if(connectionStates.get(a.id)?.phase==='unreachable'){text='窗口状态读取失败';disabled=true;}
 else if(active){if(p?.state==='polling'){text='正在核验登录状态…';disabled=true;}else if(p?.state==='observed'){text='已读取身份 · 待绑定';disabled=true;}else{text='重新检查登录状态';onclick=()=>recheck(a.id);}}
 else{text='登录此账号';onclick=()=>directLogin(a.id);}
 const b=el('button',text);b.disabled=disabled;if(onclick)b.onclick=onclick;return b;}
function render(){ $('#accountCount').textContent=state.accounts.length;$('#connectedCount').textContent=state.accountsWithData;$('#followerCount').textContent=state.accountsWithData?state.totalFollowers.toLocaleString():'未采集';const rows=state.accounts.filter(a=>filter==='all'||a.platform===filter);$('#accountGrid').replaceChildren(...rows.map(a=>{const card=el('article',undefined,'account');const head=el('div',undefined,'accountHead');head.append(el('span',names[a.platform],'platform '+a.platform),el('span',statusText(a),'status'));card.append(head,el('h3',a.label));if(a.platform_user_id)card.append(el('p','平台账号：'+(a.nickname||'未返回昵称')+(a.red_id?' · '+({xhs:'小红书号',douyin:'抖音号',channels:'视频号ID'}[a.platform]||'平台号')+' '+a.red_id:''),'muted'));card.append(el('p',!state.loginPlatforms?.includes(a.platform)?'登录入口尚未开放 · 采集禁用':!state.collectionPlatforms?.includes(a.platform)?'可扫码登录 · 身份核验与采集接入中 · 发布禁用':a.platform_user_id?'只读采集已开放 · 发布禁用':'登录后自动核验身份 · 发布禁用','muted'));const data=el('div',undefined,'accountData');data.append(el('b',a.total===null?'未采集':a.total.toLocaleString()),el('span','粉丝'));const auto=schedule?.accounts?.[a.id];if(auto)card.append(el('p','上次批量采集（定时或全部采集）'+fmtTime(auto.at)+'：'+(auto.ok?'成功，':'失败，')+auto.message,auto.ok?'muted':'muted warn'));card.append(data,el('p',a.day?'最近样本：'+a.day:'尚无采集记录','muted'),el('p','作品明细：暂未接入（不是 0 篇）','muted'));const open=connectionStates.get(a.id)?.phase==='awaiting_identity';if(open&&(!a.platform_user_id||polls.get(a.id)?.state==='polling')){const box=el('div',undefined,'screen');box.append(el('p','在这里扫码（实时画面，来自这台 Mac 上的专用窗口）：','muted'));const img=document.createElement('img');img.alt='专用窗口画面';img.dataset.screen=a.id;img.src='/api/accounts/'+encodeURIComponent(a.id)+'/screen?t='+Date.now();box.append(img);card.append(box);}
 const prepare=loginButton(a);const details=el('button','窗口状态 / 关闭');details.onclick=()=>showConnection(a.id);const rm=el('button','移除');rm.className='subtle';rm.disabled=open||collecting.has(a.id);rm.title=open?'请先关闭这个账号的专用窗口':'';rm.onclick=()=>removeAccount(a);card.append(prepare,details,rm);return card;}));$('#empty').hidden=rows.length>0;document.querySelectorAll('[data-platform]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.platform===filter)));}
let schedule=null,schedTimer=null;
const fmtTime=iso=>iso?new Date(iso).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
function renderSchedule(){const box=$('#schedulePanel');if(!box)return;if(!schedule?.enabled){box.hidden=true;return;}box.hidden=false;
 const cur=schedule.current&&state?.accounts?.find(a=>a.id===schedule.current);
 $('#scheduleTitle').textContent='每日自动采集 · 北京时间 '+schedule.at;
 $('#scheduleText').textContent=schedule.running?('正在逐个采集'+(cur?'：'+cur.label:'')+'。期间会依次弹出各账号的专用窗口，采完自动关闭，请勿操作这些窗口。'):
  ('上次完成：'+fmtTime(schedule.finishedAt)+'。'+(schedule.next==='today'?'今天 '+schedule.at+' 后自动运行。':schedule.next==='tomorrow'?'今天已运行，明天 '+schedule.at+' 后再运行。':schedule.deferred?'已到时间，但有账号窗口开着，关闭后自动运行。':'即将运行。')+' 只采集已绑定身份的账号；面板服务需要保持运行。');
 $('#runAll').disabled=!!schedule.running;
 clearTimeout(schedTimer);if(schedule.running)schedTimer=setTimeout(async()=>{try{await load();globalThis.dispatchEvent?.(new Event('chusi:data-updated'));}catch{}},5000);}
let removed=[],access=null;
async function load(){state=await api('/api/summary');try{schedule=await api('/api/schedule');}catch{schedule=null;}try{removed=(await api('/api/accounts/removed')).accounts||[];}catch{removed=[];}try{access=await api('/api/access');}catch{access=null;}await refreshConnections();render();renderSchedule();renderRemoved();renderAccess();}
const lifePost=(id,action)=>api('/api/accounts/'+encodeURIComponent(id)+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({confirmAccountId:id})});
async function removeAccount(a){if(!confirm('移除「'+a.label+'」？\n只是隐藏：这张卡片、它的汇总数据和定时采集都不再出现；历史数据和登录状态都保留，可在“已移除的账号”里恢复。'))return;try{await lifePost(a.id,'remove');$('#error').textContent='已移除「'+a.label+'」（数据保留，可恢复）。';await load();globalThis.dispatchEvent?.(new Event('chusi:data-updated'));}catch(e){$('#error').textContent=e.message;}}
function renderRemoved(){const box=$('#removedBox');if(!box||!box.append)return;box.hidden=!removed.length;$('#removedTitle').textContent='已移除的账号（'+removed.length+'）';$('#removedList').replaceChildren(...removed.map(r=>{const row=el('p',names[r.platform]+' · '+r.label+(r.nickname?'（'+r.nickname+'）':'')+' ');const b=el('button','恢复');b.onclick=async()=>{try{await lifePost(r.id,'restore');$('#error').textContent='已恢复「'+r.label+'」。';await load();globalThis.dispatchEvent?.(new Event('chusi:data-updated'));}catch(e){$('#error').textContent=e.message;}};row.append(b);return row;}));}
function renderAccess(){const box=$('#accessBox');if(!box||!box.append)return;box.hidden=!access?.lan;if(access?.lan)$('#accessUrls').replaceChildren(...access.urls.map(u=>el('p',u,'mono')));}
const screenTimer=setInterval(()=>{if(typeof document.querySelectorAll!=='function')return;for(const img of document.querySelectorAll('img[data-screen]'))img.src='/api/accounts/'+encodeURIComponent(img.dataset.screen)+'/screen?t='+Date.now();},2000);screenTimer?.unref?.();
async function refreshConnections(){if(!state)return;await Promise.all(state.accounts.filter(a=>state.loginPlatforms?.includes(a.platform)).map(async a=>{try{const c=await api('/api/accounts/'+encodeURIComponent(a.id)+'/connection');connectionStates.set(a.id,c);
 // 服务端没有会话（prepared / session_unknown）只说明会话不在服务端内存中，不能证明窗口已关闭。
 // 本页曾打开过（仍有轮询记录）且未经后端确认关闭的账号，一律视为状态未知，不再显示可启动。
 if(c?.phase==='awaiting_identity')lostSessions.delete(a.id);
 else{const p=polls.get(a.id);if(p){lostSessions.add(a.id);if(p.state==='polling')p.finishAs('session_unknown');}}
 }catch{connectionStates.set(a.id,{phase:'unreachable'});}}));}
$('#syncStatus').onclick=async()=>{try{await load();polls.forEach(p=>p.checkNow());$('#error').textContent='已刷新本机窗口状态。身份核验结果以账号卡片为准；未核验前采集和发布保持禁用，不会重复打开扫码页。';}catch(e){$('#error').textContent=e.message;}};
document.querySelectorAll('[data-platform]').forEach(b=>b.onclick=()=>{filter=b.dataset.platform;render();});
$('#showAdd').onclick=()=>{$('#formError').textContent='';$('#addDialog').showModal();$('#label').focus();};
$('#cancelAdd').onclick=()=>{if(!busy)$('#addDialog').close();};
$('#addDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('#platform').onchange=()=>{$('#saveAdd').textContent=(state?.loginPlatforms||['xhs']).includes($('#platform').value)?'添加并登录':'添加（登录尚未开放）';};
$('#addForm').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('#saveAdd').disabled=true;$('#cancelAdd').disabled=true;let row;try{const platform=$('#platform').value;const label=$('#label').value.trim()||names[platform]+'账号';row=await api('/api/accounts',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({platform,label})});$('#addDialog').close();$('#addForm').reset();$('#platform').onchange();filter=platform;await load();if((state.loginPlatforms||[]).includes(platform))await directLogin(row.id);else $('#error').textContent='账号备注已保存。此平台登录尚未开放，不会启动浏览器。';}catch(err){if(row)$('#error').textContent='账号已保留，请在账号卡片重试登录。'+err.message;else $('#formError').textContent=err.message;}finally{busy=false;$('#saveAdd').disabled=false;$('#cancelAdd').disabled=false;}};
const launching=new Set();
const collecting=new Set();
async function collect(id){if(collecting.has(id))return;collecting.add(id);if(state)render();$('#error').textContent=labelOf(id)+'正在从专用窗口只读读取数据中心（约10–40秒，会短暂出现一个后台标签页）…';try{const r=await postAccount(id,'collect');$('#error').textContent=labelOf(id)+'已采集 '+r.from+' 至 '+r.to+' 的每日数据（'+r.saved+' 项）'+(r.fansTotal!=null?'，当前粉丝 '+r.fansTotal:'')+'。小红书数据中心按天更新，最新一天通常是昨天。';try{await load();}catch{}globalThis.dispatchEvent?.(new Event('chusi:data-updated'));}catch(e){$('#error').textContent=labelOf(id)+'采集失败，未写入任何数据：'+e.message;}finally{collecting.delete(id);if(state)render();}}
async function directLogin(id){if(launching.has(id)||polls.get(id)?.state==='polling')return;if(isUnknown(id)){$('#error').textContent=labelOf(id)+UNKNOWN_TEXT+'：无法确认专用窗口是否仍在运行，面板不会重新打开或接管。';return;}launching.add(id);$('#error').textContent='正在打开此账号专用登录窗口…';try{await postAccount(id,'login');try{await load();}catch{}startPoll(id);}catch(e){$('#error').textContent='账号已保留，未能打开登录窗口：'+e.message;}finally{launching.delete(id);}}
if(typeof globalThis.addEventListener==='function')globalThis.addEventListener('pagehide',()=>polls.forEach(p=>p.cancel(true)));
if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')polls.forEach(p=>p.checkNow());});

export async function showConnection(id){try{const p=await api('/api/accounts/'+encodeURIComponent(id)+'/connection');currentConnection=p;const acct=state?.accounts?.find(a=>a.id===id);$('#connectionMessage').textContent='';$('#connectionNotice').textContent=p.backendReady?'打开专用窗口并扫码登录后，面板会自动读取平台本人身份并绑定到此卡片，随后只读采集每日数据。未读到可信身份前一律显示未核验，请勿反复扫码。本面板没有发布功能。':'此平台尚未开放登录，当前不会启动浏览器或采集。';const unknown=p.phase!=='awaiting_identity'&&(p.phase==='session_unknown'||lostSessions.has(id)||polls.has(id));if(unknown){lostSessions.add(id);$('#connectionMessage').textContent=UNKNOWN_TEXT+'：服务端没有该账号的窗口会话（可能是服务重启后丢失），无法确认专用窗口是否仍在运行。面板不会重新打开、接管或宣称已关闭该窗口；请勿重复扫码。';}
 $('#launchLogin').disabled=!p.backendReady || p.phase!=='prepared' || unknown;$('#launchLogin').textContent=unknown?UNKNOWN_TEXT:p.backendReady?'打开此账号的独立登录窗口':'登录入口尚未开放';$('#stopLogin').hidden=p.phase!=='awaiting_identity';$('#connectionTitle').textContent=p.label+' · 独立接入';$('#connectionDetails').textContent='账号标识：'+p.accountId+'\n平台：'+names[p.platform]+'\n独立调试端口：'+p.debugPort+'\n浏览器资料：'+p.profilePath+'\n独立数据库：'+p.databasePath+'\n独立输出：'+p.outputPath+'\n状态：'+(unknown?UNKNOWN_TEXT+'（无法确认窗口是否仍在运行），身份未核验':p.phase==='prepared'?'未启动专用窗口':acct?statusText(acct):'专用窗口已打开，身份未核验');$('#connectionDialog').showModal();}catch(e){$('#error').textContent=e.message;}}
$('#closeConnection').onclick=()=>$('#connectionDialog').close();
$('#runAll').onclick=async()=>{if(!confirm('现在逐个采集所有已绑定账号？会依次弹出各账号的专用窗口，采完自动关闭。只读，不会发布。'))return;try{const r=await api('/api/schedule/run',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});$('#error').textContent='已开始采集 '+r.accounts+' 个账号。';await load();}catch(e){$('#error').textContent=e.message;}};

$('#launchLogin').onclick=async()=>{const p=currentConnection;if(!p?.backendReady||p.phase!=='prepared'||isUnknown(p.accountId))return;if(!confirm('只为 '+p.label+' ['+p.accountId+'] 打开独立 Chrome 登录窗口？不会使用日常 Chrome。扫码与登录由你本人完成；核验身份后会只读采集数据，不会发布任何内容。'))return;$('#launchLogin').disabled=true;try{await postAccount(p.accountId,'login');$('#connectionDetails').textContent+='\n已打开此账号窗口。请你本人扫码；面板会有限次检查身份，核验通过后自动采集。';$('#stopLogin').hidden=false;try{await load();}catch{}startPoll(p.accountId);}catch(e){$('#connectionMessage').textContent=e.message;$('#launchLogin').disabled=false;}};
$('#stopLogin').onclick=async()=>{const p=currentConnection;if(!p)return;const id=p.accountId;try{const poll=polls.get(id);if(poll){let t;const settled=await Promise.race([poll.cancel().then(()=>true),new Promise(r=>t=setTimeout(()=>r(false),5000))]);clearTimeout(t);if(!settled)poll.cancel(true);}const r=await postAccount(id,'close');
 // 只有后端明确回 closed:true（已确认自有进程退出）才显示已关闭并允许再次启动
 if(r?.closed===true){polls.delete(id);lostSessions.delete(id);$('#connectionDetails').textContent+='\n已确认专用进程退出，身份检查已停止。';$('#stopLogin').hidden=true;$('#launchLogin').disabled=false;}
 else{lostSessions.add(id);$('#connectionMessage').textContent=UNKNOWN_TEXT+'：服务端没有该账号的窗口会话，无法确认专用窗口已关闭。面板不会重新打开或接管该窗口。';$('#stopLogin').hidden=true;$('#launchLogin').disabled=true;}
 try{await load();}catch{}}catch(e){if(e.code==='session_unknown'||e.code==='no_session'){lostSessions.add(id);$('#launchLogin').disabled=true;}$('#connectionMessage').textContent=e.message;}};

try{csrf=(await api('/api/session')).csrf;await load();}catch(e){$('#error').textContent=e.message;}
