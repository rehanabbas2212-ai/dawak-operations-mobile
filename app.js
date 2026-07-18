"use strict";
const cfg=window.DAWAK_CONFIG||{};
const $=id=>document.getElementById(id);
const state={token:sessionStorage.getItem('dawak_token')||'',me:null,hubs:[],profiles:[],delivery:null,scanner:null,photo:null};
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

$('loginForm').addEventListener('submit',async e=>{e.preventDefault();notice('loginStatus','');busy(true);try{
  const result=await api('/auth/v1/token?grant_type=password',{method:'POST',auth:false,body:{email:$('email').value.trim(),password:$('password').value}});
  state.token=result.access_token;sessionStorage.setItem('dawak_token',state.token);$('password').value='';await start();
}catch(error){notice('loginStatus',error.message)}finally{busy(false)}});

async function start(){
  const profileResult=await api('/rest/v1/rpc/my_profile',{method:'POST',body:{}});
  state.me=Array.isArray(profileResult)?profileResult[0]:profileResult;
  if(!state.me)throw new Error('Your account is inactive.');
  [state.hubs,state.profiles]=await Promise.all([
    api('/rest/v1/hubs?select=id,code,name&active=eq.true&order=name'),
    api('/rest/v1/profiles?select=id,full_name,email,role,hub_id,driver_name&active=eq.true&order=full_name')
  ]);
  $('loginCard').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');
  $('who').textContent=`${state.me.full_name||state.me.email} • ${state.me.role} • ${hubFor(state.me.hub_id)}`;
  document.querySelectorAll('.cash-admin').forEach(x=>x.classList.toggle('hidden',!['coordinator','hub_leader'].includes(state.me.role)));
  fillHubs();await refreshCash();
}
function logout(){state.token='';state.me=null;state.delivery=null;sessionStorage.removeItem('dawak_token');$('app').classList.add('hidden');$('logout').classList.add('hidden');$('loginCard').classList.remove('hidden');$('who').textContent='Secure pilot v0.3.0'}
$('logout').onclick=logout;

document.querySelectorAll('.tab').forEach(button=>button.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===button));
  $('deliveryTab').classList.toggle('hidden',button.dataset.tab!=='delivery');$('cashTab').classList.toggle('hidden',button.dataset.tab!=='cash');
});

function fillHubs(){for(const id of ['originHub','destinationHub','batchOrigin','batchDestination'])$(id).innerHTML=state.hubs.map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('')}

// DELIVERY ASSIST
$('lookupAwb').onclick=lookupDelivery;$('deliveryAwb').addEventListener('keydown',e=>{if(e.key==='Enter')lookupDelivery()});
async function lookupDelivery(){const awb=cleanAwb($('deliveryAwb').value);notice('deliveryStatus','');if(!awb){notice('deliveryStatus','Scan or enter an AWB first.');return}busy(true);try{
  const result=await api('/rest/v1/rpc/lookup_delivery',{method:'POST',body:{p_awb:awb}});state.delivery=Array.isArray(result)?result[0]:result;renderDelivery();
}catch(error){$('deliveryResult').classList.add('hidden');notice('deliveryStatus',error.message)}finally{busy(false)}}
function renderDelivery(){const r=state.delivery,o=r.current_order,l=r.previous_location;$('deliveryResult').classList.remove('hidden');$('patientName').textContent=o.patient_name||'Patient name unavailable';$('currentAwb').textContent=o.tracking_number;$('assignedDriver').textContent=o.driver_name||'Not assigned';$('orderStatus').textContent=[o.last_status,o.dropoff_status].filter(Boolean).join(' / ')||'Not available';$('previousBlock').classList.toggle('hidden',!r.location_found);$('locationBadge').textContent=r.location_found?'Previous location found':'No eligible location';if(l){$('previousAwb').textContent=l.tracking_number;$('previousDate').textContent=formatDate(l.delivery_complete_date);$('previousAddress').textContent=l.address||'Address not available';$('openMaps').dataset.url=l.google_maps_url}renderCalls(r.call_attempts||[]);state.photo=null;$('photo').value='';$('photoName').textContent='No photo selected';$('deliveryResult').scrollIntoView({behavior:'smooth',block:'start'})}
function renderCalls(attempts){const first=attempts.some(x=>Number(x.attempt_number)===1),second=attempts.some(x=>Number(x.attempt_number)===2);$('call1').disabled=first;$('call1').classList.toggle('done',first);$('call1').textContent=first?'Attempt 1 recorded ✓':'Call attempt 1';$('call2').disabled=!first||second;$('call2').classList.toggle('done',second);$('call2').textContent=second?'Attempt 2 recorded ✓':'Call attempt 2';$('callStatus').textContent=second?'Two calls are recorded.':first?'Attempt 1 recorded. Attempt 2 unlocks after 60 seconds.':'Both call attempts must be started here.'}
async function recordCall(){if(!state.delivery)return;try{const result=await api('/rest/v1/rpc/record_delivery_call',{method:'POST',body:{p_awb:state.delivery.current_order.tracking_number}});state.delivery.call_attempts.push({attempt_number:result.attempt_number,attempted_at:result.attempted_at});renderCalls(state.delivery.call_attempts);location.href=`tel:${String(result.phone||'').replace(/[^\d+]/g,'')}`}catch(error){$('callStatus').textContent=error.message}}
$('call1').onclick=recordCall;$('call2').onclick=recordCall;
$('openMaps').onclick=async()=>{if(!state.delivery)return;const url=$('openMaps').dataset.url;window.open(url,'_blank','noopener');await logDelivery('MAP_OPENED',url)};
$('photo').onchange=e=>{state.photo=e.target.files?.[0]||null;$('photoName').textContent=state.photo?`${state.photo.name} selected`:'No photo selected'};
function whatsappMessage(){const patient=state.delivery?.current_order?.patient_name||'Patient',driver=state.me?.full_name||'delivery driver';return `Hello ${patient}, this is ${driver} from Dawak medicine delivery. I tried calling regarding your delivery. Kindly share your current location and nearest landmark so I can reach you. Thank you.`}
$('sharePhoto').onclick=async()=>{if(!state.delivery)return;if(!state.photo){alert('Take or choose the photo first.');return}const share={title:'Dawak delivery',text:whatsappMessage(),files:[state.photo]};if(!navigator.share||(navigator.canShare&&!navigator.canShare(share))){alert('Photo sharing needs Chrome on Android. Use message only on this device.');return}try{await navigator.share(share);await logDelivery('PHOTO_SHARED',state.photo.name)}catch(e){if(e.name!=='AbortError')alert(e.message)}};
$('whatsappText').onclick=async()=>{if(!state.delivery)return;const phone=String(state.delivery.current_order.phone||'').replace(/\D/g,'');if(!phone){alert('No patient phone number is available.');return}await logDelivery('WHATSAPP_PREPARED','message-only');window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMessage())}`,'_blank','noopener')};
async function logDelivery(action,details){try{await api('/rest/v1/rpc/log_delivery_activity',{method:'POST',body:{p_awb:state.delivery.current_order.tracking_number,p_action:action,p_details:String(details||'').slice(0,500)}})}catch{}}

$('scanAwb').onclick=startScanner;$('stopScanner').onclick=stopScanner;
async function startScanner(){notice('deliveryStatus','');if(typeof Html5Qrcode==='undefined'){notice('deliveryStatus','Camera scanner is unavailable. Enter the AWB manually.');return}$('scannerWrap').classList.remove('hidden');state.scanner=new Html5Qrcode('reader');try{await state.scanner.start({facingMode:'environment'},{fps:12,qrbox:{width:290,height:150},aspectRatio:1.7},async text=>{$('deliveryAwb').value=cleanAwb(text);await stopScanner();await lookupDelivery()},()=>{})}catch{notice('deliveryStatus','Allow camera permission or enter the AWB manually.');await stopScanner()}}
async function stopScanner(){if(state.scanner){try{if(state.scanner.isScanning)await state.scanner.stop()}catch{}try{state.scanner.clear()}catch{}state.scanner=null}$('scannerWrap').classList.add('hidden')}

// CASH CUSTODY
$('addItem').onclick=async()=>{try{await api('/rest/v1/rpc/create_payment_line',{method:'POST',body:{p_awb:$('cashAwb').value,p_type:$('paymentType').value,p_amount:Number($('amount').value),p_origin:$('originHub').value,p_destination:$('destinationHub').value}});notice('itemStatus','Payment line added.',true);$('cashAwb').value='';$('amount').value=''}catch(e){notice('itemStatus',e.message)}};
$('createBatch').onclick=async()=>{try{const awbs=$('batchAwbs').value.split(',').map(cleanAwb).filter(Boolean);if(!awbs.length)throw new Error('Enter at least one cash AWB.');await api('/rest/v1/rpc/create_cash_batch',{method:'POST',body:{p_name:$('batchName').value,p_origin:$('batchOrigin').value,p_destination:$('batchDestination').value,p_awbs:awbs}});notice('batchStatus','Cash batch created.',true);await refreshCash()}catch(e){notice('batchStatus',e.message)}};
$('refreshCash').onclick=refreshCash;
async function refreshCash(){if(!state.token)return;try{notice('cashStatus','');const rows=await api('/rest/v1/cash_batches?select=*&order=created_at.desc&limit=100');$('batches').innerHTML=rows.map(renderBatch).join('')||'<tr><td colspan="8">No batches yet.</td></tr>'}catch(e){notice('cashStatus',e.message)}}
function renderBatch(b){let action='—';if(b.pending_to===state.me.id)action=`<button onclick="acceptCash('${b.id}')">Accept cash</button>`;else if(b.current_custodian===state.me.id&&!['RECEIVED','EXCEPTION','HANDOVER_PENDING'].includes(b.status)){const options=state.profiles.filter(p=>p.id!==state.me.id).map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)} (${esc(p.role)})</option>`).join('');action=`<div class="action-stack"><select id="to-${b.id}">${options}</select><input id="seal-${b.id}" placeholder="Seal / bag"><button onclick="handoverCash('${b.id}')">Hand over</button>`;if(state.me.role!=='driver'&&state.me.hub_id===b.destination_hub_id)action+=`<input id="count-${b.id}" type="number" step="0.01" placeholder="Counted AED"><button onclick="finalCash('${b.id}')">Final count & receive</button>`;action+='</div>'}return `<tr><td>${esc(b.batch_name)}</td><td>${esc(hubFor(b.origin_hub_id))} → ${esc(hubFor(b.destination_hub_id))}</td><td>AED ${Number(b.expected_amount).toFixed(2)}</td><td><span class="pill">${esc(b.status)}</span></td><td>${esc(nameFor(b.current_custodian))}<br><small>${esc(hubFor(b.current_hub_id))}</small></td><td>${esc(nameFor(b.pending_to))}</td><td>${action}</td><td><button class="secondary" onclick="showAudit('${b.id}','${esc(b.batch_name)}')">History</button></td></tr>`}
window.handoverCash=async id=>{try{await api('/rest/v1/rpc/initiate_handover',{method:'POST',body:{p_batch:id,p_to:$(`to-${id}`).value,p_seal:$(`seal-${id}`).value,p_notes:''}});await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.acceptCash=async id=>{try{await api('/rest/v1/rpc/accept_handover',{method:'POST',body:{p_batch:id}});await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.finalCash=async id=>{try{const amount=Number($(`count-${id}`).value);if(!Number.isFinite(amount))throw new Error('Enter the counted amount.');const result=await api('/rest/v1/rpc/final_receive',{method:'POST',body:{p_batch:id,p_counted:amount,p_notes:''}});notice('cashStatus',result==='RECEIVED'?'Final receipt confirmed.':'Amount differs. Batch is an exception.',result==='RECEIVED');await refreshCash()}catch(e){notice('cashStatus',e.message)}};
window.showAudit=async(id,batch)=>{try{const rows=await api(`/rest/v1/custody_events?select=*&batch_id=eq.${encodeURIComponent(id)}&order=id.asc`);$('auditPanel').classList.remove('hidden');$('auditPanel').innerHTML=`<h3>${esc(batch)} custody history</h3>`+rows.map(x=>`<div class="audit-item"><strong>${esc(formatDate(x.created_at))}</strong><div>${esc(x.event_type)} — ${esc(nameFor(x.actor_id))}<br><small>${esc(nameFor(x.from_user_id))} → ${esc(nameFor(x.to_user_id))} • ${esc(hubFor(x.hub_id))} • ${x.amount==null?'':`AED ${Number(x.amount).toFixed(2)}`}</small></div></div>`).join('');$('auditPanel').scrollIntoView({behavior:'smooth'})}catch(e){notice('cashStatus',e.message)}};

window.addEventListener('online',setOnline);window.addEventListener('offline',setOnline);setOnline();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('service-worker.js'));
if(state.token)start().catch(e=>{logout();notice('loginStatus',e.message)});
