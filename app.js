"use strict";
const cfg=window.DAWAK_CONFIG||{};
const $=id=>document.getElementById(id);
const state={token:sessionStorage.getItem('dawak_token')||'',me:null,hubs:[],profiles:[],hubAccess:[],delivery:null,scanner:null,batchScanner:null,verificationBatch:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const notice=(id,text,ok=false)=>$(id).innerHTML=text?`<div class="status ${ok?'ok':'error'}">${esc(text)}</div>`:'';
const busy=v=>$('busy').classList.toggle('hidden',!v);

async function api(path,{method='GET',body,auth=true}={}){
  if(!cfg.supabaseUrl||!cfg.anonKey)throw new Error('Supabase connection is missing from config.js.');
  const headers={'apikey':cfg.anonKey,'Content-Type':'application/json'};
  if(auth&&state.token)headers.Authorization=`Bearer ${state.token}`;
  const response=await fetch(`${cfg.supabaseUrl}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;
  try{data=text?JSON.parse(text):null}catch{data=text}
  if(!response.ok)throw new Error(data?.message||data?.error_description||data?.hint||text||`Request failed (${response.status})`);
  return data;
}

function setOnline(){const online=navigator.onLine;$('onlineBadge').textContent=online?'Online':'Offline';$('onlineBadge').className=online?'online':'online offline'}
function cleanAwb(v){return String(v||'').trim().toUpperCase().replace(/\s+/g,'')}
function formatDate(v){if(!v)return 'Unknown';const d=new Date(v);return Number.isNaN(d.getTime())?v:d.toLocaleString('en-AE',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}
function nameFor(id){const p=state.profiles.find(x=>x.id===id);return p?.full_name||p?.email||'—'}
function hubFor(id){return state.hubs.find(x=>x.id===id)?.name||'—'}
function accessFor(id){return state.hubAccess.find(x=>x.hub_id===id)}
function canManageHub(id){return Boolean(accessFor(id)?.can_manage_cash)}
function canReceiveHub(id){return Boolean(accessFor(id)?.can_receive_cash)}
function myHubNames(){const names=state.hubAccess.filter(x=>x.can_view_cash).map(x=>hubFor(x.hub_id)).filter(x=>x!=='—');return names.length?names.join(', '):hubFor(state.me?.hub_id)}

$('loginForm').addEventListener('submit',async e=>{e.preventDefault();notice('loginStatus','');busy(true);try{
  const result=await api('/auth/v1/token?grant_type=password',{method:'POST',auth:false,body:{email:$('email').value.trim(),password:$('password').value}});
  state.token=result.access_token;sessionStorage.setItem('dawak_token',state.token);$('password').value='';await start();
}catch(error){notice('loginStatus',error.message)}finally{busy(false)}});

async function start(){
  const profileResult=await api('/rest/v1/rpc/my_profile',{method:'POST',body:{}});
  state.me=Array.isArray(profileResult)?profileResult[0]:profileResult;
  if(!state.me)throw new Error('Your account is inactive.');
  [state.hubs,state.profiles,state.hubAccess]=await Promise.all([
    api('/rest/v1/hubs?select=id,code,name&active=eq.true&order=name'),
    api('/rest/v1/profiles?select=id,full_name,email,role,hub_id,driver_name&active=eq.true&order=full_name'),
    api(`/rest/v1/profile_hubs?select=hub_id,can_view_cash,can_manage_cash,can_receive_cash&profile_id=eq.${encodeURIComponent(state.me.id)}`)
  ]);
  $('loginCard').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');
  $('who').textContent=`${state.me.full_name||state.me.email} • ${state.me.role} • ${myHubNames()}`;
  const cashAdmin=['coordinator','hub_leader'].includes(state.me.role)&&state.hubAccess.some(x=>x.can_manage_cash);
  document.querySelectorAll('.cash-admin').forEach(x=>x.classList.toggle('hidden',!cashAdmin));
  fillHubs();await refreshCash();
}
function logout(){stopBatchScanner();state.token='';state.me=null;state.delivery=null;state.hubAccess=[];state.verificationBatch=null;sessionStorage.removeItem('dawak_token');$('app').classList.add('hidden');$('logout').classList.add('hidden');$('loginCard').classList.remove('hidden');$('who').textContent='Secure pilot v0.5.0';$('batches').innerHTML='';$('auditPanel').innerHTML='';$('auditPanel').classList.add('hidden');$('verificationPanel').classList.add('hidden')}
$('logout').onclick=logout;

document.querySelectorAll('.tab').forEach(button=>button.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===button));
  $('deliveryTab').classList.toggle('hidden',button.dataset.tab!=='delivery');$('cashTab').classList.toggle('hidden',button.dataset.tab!=='cash');
});

function fillHubs(){const all=state.hubs.map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('');const managed=state.hubs.filter(h=>canManageHub(h.id)).map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('');for(const id of ['receivingHub','batchReceiving'])$(id).innerHTML=managed;for(const id of ['orderFacility','destinationHub','batchDestination'])$(id).innerHTML=all;const drivers=state.profiles.filter(p=>p.role==='driver').map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)}</option>`).join('');$('collectedBy').innerHTML=drivers||'<option value="">No active drivers</option>'}

// DELIVERY ASSIST
$('lookupAwb').onclick=lookupDelivery;$('deliveryAwb').addEventListener('keydown',e=>{if(e.key==='Enter')lookupDelivery()});
async function lookupDelivery(){const awb=cleanAwb($('deliveryAwb').value);notice('deliveryStatus','');if(!awb){notice('deliveryStatus','Scan or enter an AWB first.');return}busy(true);try{
  const result=await api('/rest/v1/rpc/lookup_delivery',{method:'POST',body:{p_awb:awb}});state.delivery=Array.isArray(result)?result[0]:result;renderDelivery();
}catch(error){$('deliveryResult').classList.add('hidden');notice('deliveryStatus',error.message)}finally{busy(false)}}
function renderDelivery(){const r=state.delivery,o=r.current_order,l=r.previous_location;$('deliveryResult').classList.remove('hidden');$('patientName').textContent=o.patient_name||'Patient name unavailable';$('currentAwb').textContent=o.tracking_number;$('assignedDriver').textContent=o.driver_name||'Not assigned';$('orderStatus').textContent=[o.last_status,o.dropoff_status].filter(Boolean).join(' / ')||'Not available';$('previousBlock').classList.toggle('hidden',!r.location_found);$('locationBadge').textContent=r.location_found?'Previous location found':'No eligible location';if(l){$('previousAwb').textContent=l.tracking_number;$('previousDate').textContent=formatDate(l.delivery_complete_date);$('previousAddress').textContent=l.address||'Address not available';$('openMaps').dataset.url=l.google_maps_url}renderCalls(r.call_attempts||[]);$('deliveryResult').scrollIntoView({behavior:'smooth',block:'start'})}
function renderCalls(attempts){const first=attempts.some(x=>Number(x.attempt_number)===1),second=attempts.some(x=>Number(x.attempt_number)===2);$('call1').disabled=first;$('call1').classList.toggle('done',first);$('call1').textContent=first?'Attempt 1 recorded ✓':'Call attempt 1';$('call2').disabled=!first||second;$('call2').classList.toggle('done',second);$('call2').textContent=second?'Attempt 2 recorded ✓':'Call attempt 2';$('callStatus').textContent=second?'Two calls are recorded.':first?'Attempt 1 recorded. Attempt 2 unlocks after 60 seconds.':'Both call attempts must be started here.'}
async function recordCall(){if(!state.delivery)return;try{const result=await api('/rest/v1/rpc/record_delivery_call',{method:'POST',body:{p_awb:state.delivery.current_order.tracking_number}});state.delivery.call_attempts.push({attempt_number:result.attempt_number,attempted_at:result.attempted_at});renderCalls(state.delivery.call_attempts);location.href=`tel:${String(result.phone||'').replace(/[^\d+]/g,'')}`}catch(error){$('callStatus').textContent=error.message}}
$('call1').onclick=recordCall;$('call2').onclick=recordCall;
$('openMaps').onclick=async()=>{if(!state.delivery)return;const url=$('openMaps').dataset.url;window.open(url,'_blank','noopener');await logDelivery('MAP_OPENED',url)};
function whatsappMessage(){const patient=state.delivery?.current_order?.patient_name||'Patient name unavailable';return `Aslam Alikum, Good Day Ma'am/Sir,

I’m from DAWAK Pharmacy. Your medicine is ready for delivery. Could you please send your location and villa number. Thank you and wishing you good health and wellness.

السلام عليكم يومك سعيد أنا من صيدلية دواك.
دواك جاهز للتوصيل الرجاء منك مشاركة الموقع ورقم الفيلا من خلال الرقم الذي سأتواصل معك من خلاله وشكرا لك مع تمنياتنا لك بدوام الصحة والعافية.

The delivery is for Patient Name: ${patient}`}
$('whatsappText').onclick=async()=>{if(!state.delivery)return;const phone=String(state.delivery.current_order.phone||'').replace(/\D/g,'');if(!phone){alert('No patient phone number is available.');return}await logDelivery('WHATSAPP_PREPARED','message-only');window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMessage())}`,'_blank','noopener')};
async function logDelivery(action,details){try{await api('/rest/v1/rpc/log_delivery_activity',{method:'POST',body:{p_awb:state.delivery.current_order.tracking_number,p_action:action,p_details:String(details||'').slice(0,500)}})}catch{}}

$('scanAwb').onclick=startScanner;$('stopScanner').onclick=stopScanner;
async function startScanner(){notice('deliveryStatus','');if(typeof Html5Qrcode==='undefined'){notice('deliveryStatus','Camera scanner is unavailable. Enter the AWB manually.');return}$('scannerWrap').classList.remove('hidden');state.scanner=new Html5Qrcode('reader');try{await state.scanner.start({facingMode:'environment'},{fps:12,qrbox:{width:290,height:150},aspectRatio:1.7},async text=>{$('deliveryAwb').value=cleanAwb(text);await stopScanner();await lookupDelivery()},()=>{})}catch{notice('deliveryStatus','Allow camera permission or enter the AWB manually.');await stopScanner()}}
async function stopScanner(){if(state.scanner){try{if(state.scanner.isScanning)await state.scanner.stop()}catch{}try{state.scanner.clear()}catch{}state.scanner=null}$('scannerWrap').classList.add('hidden')}

// CASH CUSTODY
$('addItem').onclick=async()=>{try{const type=$('paymentType').value;const rawAmount=$('amount').value.trim();if(rawAmount==='')throw new Error('Enter the payment amount.');await api('/rest/v1/rpc/create_payment_line',{method:'POST',body:{p_awb:$('cashAwb').value,p_type:type,p_amount:Number(rawAmount),p_order_facility:$('orderFacility').value,p_collected_by:$('collectedBy').value||null,p_receiving_hub:$('receivingHub').value,p_destination:$('destinationHub').value}});notice('itemStatus',type==='CASH'?'Driver cash receipt recorded.':'Card payment line recorded. It will not enter a cash batch.',true);$('cashAwb').value='';$('amount').value=''}catch(e){notice('itemStatus',e.message)}};
$('createBatch').onclick=async()=>{try{const awbs=$('batchAwbs').value.split(',').map(cleanAwb).filter(Boolean);if(!awbs.length)throw new Error('Enter at least one cash AWB.');await api('/rest/v1/rpc/create_cash_batch',{method:'POST',body:{p_name:$('batchName').value,p_receiving_hub:$('batchReceiving').value,p_destination:$('batchDestination').value,p_awbs:awbs}});notice('batchStatus','Cash batch created at the first receiving hub.',true);$('batchAwbs').value='';await refreshCash()}catch(e){notice('batchStatus',e.message)}};
$('refreshCash').onclick=refreshCash;
async function refreshCash(){if(!state.token)return;try{notice('cashStatus','');const rows=await api('/rest/v1/cash_batches?select=*&order=created_at.desc&limit=100');renderCashSummary(rows);$('batches').innerHTML=rows.map(renderBatch).join('')||'<tr><td colspan="8">No batches yet.</td></tr>'}catch(e){notice('cashStatus',e.message)}}
function renderCashSummary(rows){const active=rows.filter(x=>!['RECEIVED','EXCEPTION'].includes(x.status));const received=rows.filter(x=>x.status==='RECEIVED');const exceptions=rows.filter(x=>x.status==='EXCEPTION');const activeCash=active.reduce((n,x)=>n+Number(x.expected_amount||0),0);$('cashSummary').innerHTML=`<div><span>Active batches</span><strong>${active.length}</strong></div><div><span>Active cash</span><strong>AED ${activeCash.toFixed(2)}</strong></div><div><span>Received</span><strong>${received.length}</strong></div><div><span>Exceptions</span><strong>${exceptions.length}</strong></div>`}
function renderBatch(b){let action='—';if(state.me.role!=='viewer'&&b.pending_to===state.me.id)action=`<button onclick="acceptCash('${b.id}')">Accept cash</button>`;else if(state.me.role!=='viewer'&&b.current_custodian===state.me.id&&!['RECEIVED','EXCEPTION','HANDOVER_PENDING'].includes(b.status)){const options=state.profiles.filter(p=>p.id!==state.me.id&&p.role!=='viewer').map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)} (${esc(p.role)})</option>`).join('');action='<div class="action-stack">';if(options)action+=`<select id="to-${b.id}">${options}</select><input id="seal-${b.id}" placeholder="Seal / bag"><button onclick="handoverCash('${b.id}')">Hand over</button>`;if(['coordinator','hub_leader'].includes(state.me.role)&&canReceiveHub(b.destination_hub_id)){action+=`<button class="secondary" onclick="showVerification('${b.id}','${esc(b.batch_name)}')">Verify batch AWBs</button><input id="count-${b.id}" type="number" step="0.01" placeholder="Counted AED"><button onclick="finalCash('${b.id}')">Final count & receive</button><button class="secondary" onclick="reportBatch('${b.id}')">Report missing / exception</button>`}action+='</div>'}return `<tr><td>${esc(b.batch_name)}</td><td>${esc(hubFor(b.origin_hub_id))} → ${esc(hubFor(b.destination_hub_id))}<br><small>First hub → final destination</small></td><td>AED ${Number(b.expected_amount).toFixed(2)}</td><td><span class="pill">${esc(b.status)}</span></td><td>${esc(nameFor(b.current_custodian))}<br><small>${esc(hubFor(b.current_hub_id))}</small></td><td>${esc(nameFor(b.pending_to))}</td><td>${action}</td><td><button class="secondary" onclick="showAudit('${b.id}','${esc(b.batch_name)}')">History</button></td></tr>`}
window.handoverCash=async id=>{try{await api('/rest/v1/rpc/initiate_handover',{method:'POST',body:{p_batch:id,p_to:$(`to-${id}`).value,p_seal:$(`seal-${id}`).value,p_notes:''}});await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.acceptCash=async id=>{try{await api('/rest/v1/rpc/accept_handover',{method:'POST',body:{p_batch:id}});await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.finalCash=async id=>{try{const raw=$(`count-${id}`).value.trim();if(raw==='')throw new Error('Enter the counted amount.');const amount=Number(raw);if(!Number.isFinite(amount))throw new Error('Enter the counted amount.');const result=await api('/rest/v1/rpc/final_receive',{method:'POST',body:{p_batch:id,p_counted:amount,p_notes:''}});notice('cashStatus',result==='RECEIVED'?'Every AWB and the final cash count are confirmed.':'Amount differs. Batch is an exception.',result==='RECEIVED');state.verificationBatch=null;$('verificationPanel').classList.add('hidden');await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.reportBatch=async id=>{const notes=prompt('Describe the missing AWB, missing cash, broken seal, or other problem:');if(!notes)return;try{await api('/rest/v1/rpc/report_batch_exception',{method:'POST',body:{p_batch:id,p_notes:notes}});notice('cashStatus','Exception recorded. The batch has not been marked received.');state.verificationBatch=null;$('verificationPanel').classList.add('hidden');await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.showAudit=async(id,batch)=>{try{const rows=await api(`/rest/v1/custody_events?select=*&batch_id=eq.${encodeURIComponent(id)}&order=id.asc`);$('auditPanel').classList.remove('hidden');$('auditPanel').innerHTML=`<h3>${esc(batch)} custody history</h3>`+rows.map(x=>`<div class="audit-item"><strong>${esc(formatDate(x.created_at))}</strong><div>${esc(x.event_type)} — ${esc(nameFor(x.actor_id))}<br><small>${esc(nameFor(x.from_user_id))} → ${esc(nameFor(x.to_user_id))} • ${esc(hubFor(x.hub_id))} • ${x.amount==null?'':`AED ${Number(x.amount).toFixed(2)}`}${x.notes?` • ${esc(x.notes)}`:''}</small></div></div>`).join('');$('auditPanel').scrollIntoView({behavior:'smooth'})}catch(e){notice('cashStatus',e.message)}};

window.showVerification=async(id,batch)=>{try{state.verificationBatch=id;$('verificationTitle').textContent=`${batch} AWB verification`;$('verificationPanel').classList.remove('hidden');const result=await api('/rest/v1/rpc/get_batch_verification',{method:'POST',body:{p_batch:id}});renderVerification(result);$('verificationPanel').scrollIntoView({behavior:'smooth',block:'start'})}catch(e){notice('cashStatus',e.message)}};
function renderVerification(result){const items=result?.items||[];$('verificationCount').textContent=`${result?.verified_count||0} / ${result?.expected_count||0} verified`;$('verificationItems').innerHTML=items.map(x=>`<div class="verification-item ${x.verified?'done':''}"><div><strong>${esc(x.awb)} — AED ${Number(x.amount||0).toFixed(2)}</strong><small>Order facility: ${esc(hubFor(x.order_hub_id))} • Collected by: ${esc(nameFor(x.collected_by))} • First received: ${esc(hubFor(x.first_receiving_hub_id))}</small></div><span class="verify-state">${x.verified?'Verified ✓':'Missing'}</span></div>`).join('')||'<p>No AWBs are attached to this batch.</p>'}
async function verifyCurrentAwb(){const awb=cleanAwb($('verifyAwbInput').value);notice('verificationStatus','');if(!state.verificationBatch||!awb){notice('verificationStatus','Enter or scan an AWB first.');return}try{const result=await api('/rest/v1/rpc/verify_batch_awb',{method:'POST',body:{p_batch:state.verificationBatch,p_awb:awb}});$('verifyAwbInput').value='';notice('verificationStatus',`${awb} verified.`,true);renderVerification(result)}catch(e){notice('verificationStatus',e.message)}}
$('verifyAwbButton').onclick=verifyCurrentAwb;$('verifyAwbInput').addEventListener('keydown',e=>{if(e.key==='Enter')verifyCurrentAwb()});
$('verifyScanButton').onclick=startBatchScanner;$('stopBatchScanner').onclick=stopBatchScanner;
async function startBatchScanner(){notice('verificationStatus','');if(!state.verificationBatch){notice('verificationStatus','Open a batch verification first.');return}if(typeof Html5Qrcode==='undefined'){notice('verificationStatus','Camera scanner is unavailable. Enter the AWB manually.');return}$('batchScannerWrap').classList.remove('hidden');state.batchScanner=new Html5Qrcode('batchReader');try{await state.batchScanner.start({facingMode:'environment'},{fps:12,qrbox:{width:290,height:150},aspectRatio:1.7},async text=>{$('verifyAwbInput').value=cleanAwb(text);await stopBatchScanner();await verifyCurrentAwb()},()=>{})}catch{notice('verificationStatus','Allow camera permission or enter the AWB manually.');await stopBatchScanner()}}
async function stopBatchScanner(){if(state.batchScanner){try{if(state.batchScanner.isScanning)await state.batchScanner.stop()}catch{}try{state.batchScanner.clear()}catch{}state.batchScanner=null}if($('batchScannerWrap'))$('batchScannerWrap').classList.add('hidden')}

window.addEventListener('online',setOnline);window.addEventListener('offline',setOnline);setOnline();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('service-worker.js'));
if(state.token)start().catch(e=>{logout();notice('loginStatus',e.message)});
