"use strict";
const cfg=window.DAWAK_CONFIG||{};
const $=id=>document.getElementById(id);
const state={token:sessionStorage.getItem('dawak_token')||'',me:null,hubs:[],profiles:[],hubAccess:[],delivery:null,scanner:null,arrivalScanner:null,arrivalBatch:null,arrivalItems:[],availableAwbs:[],batches:[]};
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
function myHubNames(){const names=state.hubAccess.filter(x=>x.can_view_cash).map(x=>hubFor(x.hub_id)).filter(x=>x!=='—');return names.length?names.join(', '):hubFor(state.me?.hub_id)}
function isCashAdmin(){return ['coordinator','hub_leader'].includes(state.me?.role)&&state.hubAccess.some(x=>x.can_manage_cash)}

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
  document.querySelectorAll('.cash-admin').forEach(x=>x.classList.toggle('hidden',!isCashAdmin()));
  fillHubs();await refreshCash();
  if(isCashAdmin()&&$('bagFromHub').value)await loadAvailableAwbs();
}
function logout(){stopArrivalScanner();stopScanner();state.token='';state.me=null;state.delivery=null;state.hubAccess=[];state.arrivalBatch=null;state.availableAwbs=[];sessionStorage.removeItem('dawak_token');$('app').classList.add('hidden');$('logout').classList.add('hidden');$('loginCard').classList.remove('hidden');$('who').textContent='Secure pilot v0.6.0';$('batches').innerHTML='';$('auditPanel').innerHTML='';$('auditPanel').classList.add('hidden');$('arrivalPanel').classList.add('hidden')}
$('logout').onclick=logout;

document.querySelectorAll('.tab').forEach(button=>button.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===button));
  $('deliveryTab').classList.toggle('hidden',button.dataset.tab!=='delivery');$('cashTab').classList.toggle('hidden',button.dataset.tab!=='cash');
});

function fillHubs(){
  const all=state.hubs.map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('');
  const managed=state.hubs.filter(h=>canManageHub(h.id)).map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('');
  for(const id of ['receivingHub','bagFromHub'])$(id).innerHTML=managed;
  for(const id of ['orderFacility','destinationHub','bagNextHub'])$(id).innerHTML=all;
  const drivers=state.profiles.filter(p=>p.role==='driver').map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)}</option>`).join('');
  $('collectedBy').innerHTML=drivers||'<option value="">No active drivers</option>';
}

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
function whatsappMessage(){const patient=state.delivery?.current_order?.patient_name||'Patient name unavailable';return `Aslam Alikum, Good Day Ma'am/Sir,\n\nI’m from DAWAK Pharmacy. Your medicine is ready for delivery. Could you please send your location and villa number. Thank you and wishing you good health and wellness.\n\nالسلام عليكم يومك سعيد أنا من صيدلية دواك.\nدواك جاهز للتوصيل الرجاء منك مشاركة الموقع ورقم الفيلا من خلال الرقم الذي سأتواصل معك من خلاله وشكرا لك مع تمنياتنا لك بدوام الصحة والعافية.\n\nThe delivery is for Patient Name: ${patient}`}
$('whatsappText').onclick=async()=>{if(!state.delivery)return;const phone=String(state.delivery.current_order.phone||'').replace(/\D/g,'');if(!phone){alert('No patient phone number is available.');return}await logDelivery('WHATSAPP_PREPARED','message-only');window.open(`https://wa.me/${phone}?text=${encodeURIComponent(whatsappMessage())}`,'_blank','noopener')};
async function logDelivery(action,details){try{await api('/rest/v1/rpc/log_delivery_activity',{method:'POST',body:{p_awb:state.delivery.current_order.tracking_number,p_action:action,p_details:String(details||'').slice(0,500)}})}catch{}}

$('scanAwb').onclick=startScanner;$('stopScanner').onclick=stopScanner;
async function startScanner(){notice('deliveryStatus','');if(typeof Html5Qrcode==='undefined'){notice('deliveryStatus','Camera scanner is unavailable. Enter the AWB manually.');return}$('scannerWrap').classList.remove('hidden');state.scanner=new Html5Qrcode('reader');try{await state.scanner.start({facingMode:'environment'},{fps:12,qrbox:{width:290,height:150},aspectRatio:1.7},async text=>{$('deliveryAwb').value=cleanAwb(text);await stopScanner();await lookupDelivery()},()=>{})}catch{notice('deliveryStatus','Allow camera permission or enter the AWB manually.');await stopScanner()}}
async function stopScanner(){if(state.scanner){try{if(state.scanner.isScanning)await state.scanner.stop()}catch{}try{state.scanner.clear()}catch{}state.scanner=null}$('scannerWrap').classList.add('hidden')}

// INDIVIDUAL PAYMENT RECORDS
$('addItem').onclick=async()=>{busy(true);try{
  const type=$('paymentType').value,rawAmount=$('amount').value.trim();if(rawAmount==='')throw new Error('Enter the payment amount.');
  await api('/rest/v1/rpc/create_payment_line',{method:'POST',body:{p_awb:$('cashAwb').value,p_type:type,p_amount:Number(rawAmount),p_order_facility:$('orderFacility').value,p_collected_by:$('collectedBy').value||null,p_receiving_hub:$('receivingHub').value,p_destination:$('destinationHub').value}});
  notice('itemStatus',type==='CASH'?'Cash AWB recorded and ready for transport.':'Card payment recorded separately.',true);$('cashAwb').value='';$('amount').value='';
  if(type==='CASH')await loadAvailableAwbs();
}catch(e){notice('itemStatus',e.message)}finally{busy(false)}};

// SEARCH ONE AWB
$('cashSearchButton').onclick=searchCashAwb;$('cashSearchAwb').addEventListener('keydown',e=>{if(e.key==='Enter')searchCashAwb()});
async function searchCashAwb(){const awb=cleanAwb($('cashSearchAwb').value);notice('cashSearchStatus','');$('cashSearchResult').classList.add('hidden');if(!awb){notice('cashSearchStatus','Enter an SD / AWB number.');return}busy(true);try{const result=await api('/rest/v1/rpc/search_cash_awb',{method:'POST',body:{p_awb:awb}});renderCashSearch(result)}catch(e){notice('cashSearchStatus',e.message)}finally{busy(false)}}
function renderCashSearch(r){const history=r.history||[];$('cashSearchResult').classList.remove('hidden');$('cashSearchResult').innerHTML=`<div class="awb-detail"><div class="section-heading"><div><p class="eyebrow">${esc(r.payment_type)} AWB</p><h3>${esc(r.awb)}</h3></div><span class="pill">${esc(r.cash_status||r.payment_type)}</span></div><div class="info-grid"><div><span>Amount</span><strong>AED ${Number(r.amount||0).toFixed(2)}</strong></div><div><span>Collected by</span><strong>${esc(nameFor(r.collected_by))}</strong></div><div><span>First received at</span><strong>${esc(hubFor(r.first_receiving_hub_id))}</strong></div><div><span>Current location</span><strong>${esc(hubFor(r.current_cash_hub_id))}</strong></div><div><span>Final destination</span><strong>${esc(hubFor(r.final_destination_hub_id))}</strong></div><div><span>Current holder / bag</span><strong>${esc(nameFor(r.current_cash_custodian))}${r.active_batch_name?` • ${esc(r.active_batch_name)}`:''}</strong></div></div><h3>AWB custody history</h3>${history.length?history.map(x=>`<div class="audit-item"><strong>${esc(formatDate(x.created_at))}</strong><div>${esc(eventLabel(x.event_type))}${x.batch_name?` • Bag ${esc(x.batch_name)}`:''}<br><small>${esc(nameFor(x.from_user_id))} → ${esc(nameFor(x.to_user_id))} • ${esc(hubFor(x.from_hub_id))} → ${esc(hubFor(x.to_hub_id))}${x.notes?` • ${esc(x.notes)}`:''}</small></div></div>`).join(''):'<p class="muted">No custody events yet.</p>'}</div>`;$('cashSearchResult').scrollIntoView({behavior:'smooth',block:'nearest'})}
function eventLabel(v){return ({DRIVER_CASH_RECEIVED:'Received from collecting driver',ADDED_TO_BAG:'Added to transport bag',BAG_HANDOVER_REQUESTED:'Bag handover requested',BAG_ACCEPTED_BY_DRIVER:'Bag accepted by driver',ARRIVED_AT_HUB:'Bag arrived at hub',FINAL_RECEIVED:'Final cash received',READY_FOR_ONWARD:'Checked; awaiting onward transport',EXCEPTION:'Exception reported'})[v]||String(v||'').replaceAll('_',' ')}

// CREATE A MIXED-DESTINATION TRANSPORT BAG
$('refreshAvailableAwbs').onclick=loadAvailableAwbs;$('bagFromHub').addEventListener('change',loadAvailableAwbs);
async function loadAvailableAwbs(){if(!state.token||!isCashAdmin()||!$('bagFromHub').value)return;notice('availableStatus','');try{state.availableAwbs=await api('/rest/v1/rpc/list_available_cash_awbs',{method:'POST',body:{p_hub:$('bagFromHub').value}});renderAvailableAwbs()}catch(e){state.availableAwbs=[];renderAvailableAwbs();notice('availableStatus',e.message)}}
function renderAvailableAwbs(){const rows=state.availableAwbs||[];$('availableAwbs').innerHTML=rows.map(x=>`<label class="available-awb"><input class="bag-awb-check" type="checkbox" value="${x.payment_line_id}"><span><strong>${esc(x.awb)} • AED ${Number(x.amount||0).toFixed(2)}</strong><small>Collected by ${esc(nameFor(x.collected_by))} • Final: ${esc(hubFor(x.final_destination_hub_id))}</small></span>${x.final_destination_hub_id===$('bagFromHub').value?`<button type="button" class="local-receive" onclick="event.preventDefault();receiveLocalAwb('${x.payment_line_id}')">Receive here</button>`:''}</label>`).join('')||'<p class="muted">No cash AWBs are waiting for transport at this hub.</p>';document.querySelectorAll('.bag-awb-check').forEach(x=>x.addEventListener('change',updateBagSummary));updateBagSummary()}
function selectedAwbs(){const ids=[...document.querySelectorAll('.bag-awb-check:checked')].map(x=>x.value);return state.availableAwbs.filter(x=>ids.includes(x.payment_line_id))}
function updateBagSummary(){const rows=selectedAwbs();$('selectedBagSummary').textContent=`${rows.length} AWB${rows.length===1?'':'s'} selected • AED ${rows.reduce((n,x)=>n+Number(x.amount||0),0).toFixed(2)}`}
window.receiveLocalAwb=async id=>{const awb=state.availableAwbs.find(x=>x.payment_line_id===id)?.awb||'this AWB';if(!confirm(`Confirm final cash receipt for ${awb} at ${hubFor($('bagFromHub').value)}?`))return;busy(true);try{await api('/rest/v1/rpc/final_receive_local_awb',{method:'POST',body:{p_payment_line:id}});notice('availableStatus',`${awb} marked final received.`,true);await loadAvailableAwbs();await refreshCash()}catch(e){notice('availableStatus',e.message)}finally{busy(false)}};
$('createTransportBag').onclick=async()=>{const rows=selectedAwbs();notice('bagStatus','');if(!rows.length){notice('bagStatus','Select at least one ready cash AWB.');return}if(!$('bagName').value.trim()){notice('bagStatus','Enter the physical bag or seal number.');return}if($('bagFromHub').value===$('bagNextHub').value){notice('bagStatus','Choose a different next checkpoint hub.');return}busy(true);try{await api('/rest/v1/rpc/create_transport_batch',{method:'POST',body:{p_name:$('bagName').value,p_from_hub:$('bagFromHub').value,p_next_hub:$('bagNextHub').value,p_payment_lines:rows.map(x=>x.payment_line_id)}});notice('bagStatus',`Transport bag created with ${rows.length} AWBs.`,true);$('bagName').value='';await Promise.all([loadAvailableAwbs(),refreshCash()])}catch(e){notice('bagStatus',e.message)}finally{busy(false)}};

// LIVE TRANSPORT BAGS
$('refreshCash').onclick=refreshCash;
async function refreshCash(){if(!state.token)return;try{notice('cashStatus','');state.batches=await api('/rest/v1/cash_batches?select=*&order=created_at.desc&limit=100');renderCashSummary(state.batches);$('batches').innerHTML=state.batches.map(renderBatch).join('')||'<tr><td colspan="9">No transport bags yet.</td></tr>';await loadRecipientMenus()}catch(e){notice('cashStatus',e.message)}}
function renderCashSummary(rows){const active=rows.filter(x=>!['RECONCILED','RECEIVED','EXCEPTION'].includes(x.status)),done=rows.filter(x=>['RECONCILED','RECEIVED'].includes(x.status)),exceptions=rows.filter(x=>x.status==='EXCEPTION'),activeCash=active.reduce((n,x)=>n+Number(x.expected_amount||0),0);$('cashSummary').innerHTML=`<div><span>Active bags</span><strong>${active.length}</strong></div><div><span>Cash in custody</span><strong>AED ${activeCash.toFixed(2)}</strong></div><div><span>Reconciled bags</span><strong>${done.length}</strong></div><div><span>Exceptions</span><strong>${exceptions.length}</strong></div>`}
function renderBatch(b){let action='—';if(state.me.role!=='viewer'&&b.pending_to===state.me.id)action=`<button onclick="acceptBag('${b.id}')">Accept whole bag</button>`;else if(state.me.role!=='viewer'&&b.current_custodian===state.me.id&&['OPEN','IN_TRANSIT'].includes(b.status))action=`<div class="action-stack"><select id="to-${b.id}"><option value="">Loading recipients…</option></select><input id="seal-${b.id}" placeholder="Seal / bag"><button onclick="handoverBag('${b.id}')">Hand over whole bag</button></div>`;else if(['coordinator','hub_leader'].includes(state.me.role)&&b.current_custodian===state.me.id&&['ARRIVED','EXCEPTION'].includes(b.status))action=`<button onclick="showArrival('${b.id}')">Check AWBs individually</button>`;return `<tr><td>${esc(b.batch_name)}</td><td>${esc(hubFor(b.origin_hub_id))} → ${esc(hubFor(b.destination_hub_id))}<br><small>Next checkpoint</small></td><td>${Number(b.item_count||0)}</td><td>AED ${Number(b.expected_amount||0).toFixed(2)}</td><td><span class="pill">${esc(b.status)}</span></td><td>${esc(nameFor(b.current_custodian))}<br><small>${esc(hubFor(b.current_hub_id))}</small></td><td>${esc(nameFor(b.pending_to))}</td><td>${action}</td><td><button class="secondary" onclick="showAudit('${b.id}')">History</button></td></tr>`}
async function loadRecipientMenus(){const actionable=state.batches.filter(b=>b.current_custodian===state.me.id&&['OPEN','IN_TRANSIT'].includes(b.status));await Promise.all(actionable.map(async b=>{const select=$(`to-${b.id}`);if(!select)return;try{const rows=await api('/rest/v1/rpc/list_custody_recipients',{method:'POST',body:{p_batch:b.id}});select.innerHTML=rows.map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)} (${esc(p.role)})</option>`).join('')||'<option value="">No authorized recipient</option>'}catch(e){select.innerHTML=`<option value="">${esc(e.message)}</option>`}}))}
window.handoverBag=async id=>{const to=$(`to-${id}`).value;if(!to){notice('cashStatus','Choose an authorized recipient.');return}busy(true);try{await api('/rest/v1/rpc/initiate_handover',{method:'POST',body:{p_batch:id,p_to:to,p_seal:$(`seal-${id}`).value,p_notes:''}});notice('cashStatus','Whole bag handover requested.',true);await refreshCash()}catch(e){notice('cashStatus',e.message)}finally{busy(false)}};
window.acceptBag=async id=>{busy(true);try{await api('/rest/v1/rpc/accept_handover',{method:'POST',body:{p_batch:id}});notice('cashStatus',state.me.role==='driver'?'You accepted the whole sealed bag.':'Bag arrived. Check its AWBs one by one.',true);await refreshCash()}catch(e){notice('cashStatus',e.message)}finally{busy(false)}};

// ARRIVAL: COORDINATOR CHECKS EACH AWB
window.showArrival=async id=>{try{const batch=state.batches.find(x=>x.id===id)?.batch_name||'Transport bag';state.arrivalBatch=id;$('arrivalTitle').textContent=`${batch} — check arrived AWBs`;$('arrivalPanel').classList.remove('hidden');const result=await api('/rest/v1/rpc/get_arrival_manifest',{method:'POST',body:{p_batch:id}});renderArrival(result);$('arrivalPanel').scrollIntoView({behavior:'smooth',block:'start'})}catch(e){notice('cashStatus',e.message)}};
function renderArrival(result){const items=result?.items||[];state.arrivalItems=items;$('arrivalCount').textContent=`${result?.processed_count||0} / ${result?.expected_count||0} checked`;$('arrivalItems').innerHTML=items.map(x=>{const local=x.recommended_action==='FINAL_RECEIVE';const label=x.processed?(x.processing_result==='FINAL_RECEIVED'?'Final received ✓':x.processing_result==='READY_FOR_ONWARD'?'Ready for onward bag ✓':'Exception recorded'):(local?`Receive finally at ${hubFor(result.arrival_hub_id)}`:`Check here, then onward to ${hubFor(x.final_destination_hub_id)}`);return `<div class="verification-item ${x.processed?'done':''}"><div><strong>${esc(x.awb)} — AED ${Number(x.amount||0).toFixed(2)}</strong><small>Final destination: ${esc(hubFor(x.final_destination_hub_id))} • Collected by: ${esc(nameFor(x.collected_by))}</small></div><div class="arrival-actions"><span class="verify-state">${esc(label)}</span>${!x.processed?`<button class="problem" onclick="reportAwbProblem('${x.payment_line_id}')">Problem</button>`:''}</div></div>`}).join('')||'<p>No AWBs are attached to this bag.</p>';if(Number(result?.processed_count||0)===Number(result?.expected_count||0)){notice('arrivalStatus','Bag reconciliation is complete. Onward AWBs are now available for a new transport bag.',true);refreshCash();if(isCashAdmin())loadAvailableAwbs()}}
async function processArrival(){const awb=cleanAwb($('arrivalAwbInput').value);notice('arrivalStatus','');if(!state.arrivalBatch||!awb){notice('arrivalStatus','Enter or scan an AWB first.');return}busy(true);try{const result=await api('/rest/v1/rpc/process_arrived_awb',{method:'POST',body:{p_batch:state.arrivalBatch,p_awb:awb}});$('arrivalAwbInput').value='';notice('arrivalStatus',`${awb} checked.`,true);renderArrival(result)}catch(e){notice('arrivalStatus',e.message)}finally{busy(false)}}
$('processArrivalAwb').onclick=processArrival;$('arrivalAwbInput').addEventListener('keydown',e=>{if(e.key==='Enter')processArrival()});
window.reportAwbProblem=async id=>{const awb=state.arrivalItems.find(x=>x.payment_line_id===id)?.awb||'';if(!awb)return;const notes=prompt(`Describe the problem with ${awb}:`);if(!notes)return;busy(true);try{const result=await api('/rest/v1/rpc/report_awb_exception',{method:'POST',body:{p_batch:state.arrivalBatch,p_awb:awb,p_notes:notes}});notice('arrivalStatus',`${awb} exception recorded.`);renderArrival(result)}catch(e){notice('arrivalStatus',e.message)}finally{busy(false)}};
$('arrivalScanButton').onclick=startArrivalScanner;$('stopArrivalScanner').onclick=stopArrivalScanner;
async function startArrivalScanner(){notice('arrivalStatus','');if(!state.arrivalBatch){notice('arrivalStatus','Open an arrived bag first.');return}if(typeof Html5Qrcode==='undefined'){notice('arrivalStatus','Camera scanner is unavailable. Enter the AWB manually.');return}$('arrivalScannerWrap').classList.remove('hidden');state.arrivalScanner=new Html5Qrcode('arrivalReader');try{await state.arrivalScanner.start({facingMode:'environment'},{fps:12,qrbox:{width:290,height:150},aspectRatio:1.7},async text=>{$('arrivalAwbInput').value=cleanAwb(text);await stopArrivalScanner();await processArrival()},()=>{})}catch{notice('arrivalStatus','Allow camera permission or enter the AWB manually.');await stopArrivalScanner()}}
async function stopArrivalScanner(){if(state.arrivalScanner){try{if(state.arrivalScanner.isScanning)await state.arrivalScanner.stop()}catch{}try{state.arrivalScanner.clear()}catch{}state.arrivalScanner=null}if($('arrivalScannerWrap'))$('arrivalScannerWrap').classList.add('hidden')}

window.showAudit=async id=>{try{const batch=state.batches.find(x=>x.id===id)?.batch_name||'Transport bag';const rows=await api(`/rest/v1/custody_events?select=*&batch_id=eq.${encodeURIComponent(id)}&order=id.asc`);$('auditPanel').classList.remove('hidden');$('auditPanel').innerHTML=`<h3>${esc(batch)} bag history</h3>`+rows.map(x=>`<div class="audit-item"><strong>${esc(formatDate(x.created_at))}</strong><div>${esc(eventLabel(x.event_type))} — ${esc(nameFor(x.actor_id))}<br><small>${esc(nameFor(x.from_user_id))} → ${esc(nameFor(x.to_user_id))} • ${esc(hubFor(x.hub_id))} • ${x.amount==null?'':`AED ${Number(x.amount).toFixed(2)}`}${x.notes?` • ${esc(x.notes)}`:''}</small></div></div>`).join('');$('auditPanel').scrollIntoView({behavior:'smooth'})}catch(e){notice('cashStatus',e.message)}};

window.addEventListener('online',setOnline);window.addEventListener('offline',setOnline);setOnline();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('service-worker.js'));
if(state.token)start().catch(e=>{logout();notice('loginStatus',e.message)});
