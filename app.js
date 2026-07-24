"use strict";
const cfg=window.DAWAK_CONFIG||{};
const $=id=>document.getElementById(id);
const state={token:sessionStorage.getItem('dawak_token')||'',me:null,hubs:[],profiles:[],hubAccess:[],arrivalScanner:null,arrivalBatch:null,arrivalItems:[],availableAwbs:[],batches:[],cashEditRecord:null,canDeleteAwbs:false,auditBatchId:null,auditBatchName:'',auditItems:[]};
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
  const [referenceData,hubAccess,canDeleteAwbs]=await Promise.all([
    api('/rest/v1/rpc/get_cash_reference_data',{method:'POST',body:{}}),
    api(`/rest/v1/profile_hubs?select=hub_id,can_view_cash,can_manage_cash,can_receive_cash&profile_id=eq.${encodeURIComponent(state.me.id)}`),
    api('/rest/v1/rpc/is_awb_delete_owner',{method:'POST',body:{}})
  ]);
  state.hubs=referenceData?.hubs||[];
  state.profiles=referenceData?.profiles||[];
  state.hubAccess=hubAccess||[];
  state.canDeleteAwbs=Boolean(canDeleteAwbs);
  $('loginCard').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');
  $('who').textContent=`${state.me.full_name||state.me.email} • ${state.me.role} • ${myHubNames()}`;
  document.querySelectorAll('.cash-admin').forEach(x=>x.classList.toggle('hidden',!isCashAdmin()));
  fillHubs();await refreshCash();
  if(isCashAdmin()&&$('bagFromHub').value)await loadAvailableAwbs();
}
function logout(){stopArrivalScanner();state.token='';state.me=null;state.hubAccess=[];state.arrivalBatch=null;state.availableAwbs=[];state.cashEditRecord=null;state.canDeleteAwbs=false;state.auditBatchId=null;state.auditBatchName='';state.auditItems=[];sessionStorage.removeItem('dawak_token');$('app').classList.add('hidden');$('logout').classList.add('hidden');$('loginCard').classList.remove('hidden');$('who').textContent='Cash Custody v0.7.7';$('batches').innerHTML='';$('auditPanel').innerHTML='';$('auditPanel').classList.add('hidden');$('arrivalPanel').classList.add('hidden');closeCashEdit()}
$('logout').onclick=logout;

function fillHubs(){
  const all=state.hubs.map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('');
  const managed=state.hubs.filter(h=>canManageHub(h.id)).map(h=>`<option value="${h.id}">${esc(h.name)}</option>`).join('');
  for(const id of ['receivingHub','bagFromHub'])$(id).innerHTML=managed;
  for(const id of ['orderFacility','destinationHub','bagNextHub'])$(id).innerHTML=all;
  const drivers=state.profiles.filter(p=>p.role==='driver').map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)}</option>`).join('');
  $('collectedBy').innerHTML=drivers||'<option value="">No active drivers</option>';
  for(const id of ['editOrderFacility','editReceivingHub','editDestinationHub'])$(id).innerHTML=all;
  $('editCollectedBy').innerHTML='<option value="">—</option>'+drivers;
}

// CASH CUSTODY
// INDIVIDUAL PAYMENT RECORDS
function updatePaymentButton(){const type=$('paymentType').value||'CASH';$('addItem').textContent=`Record ${type} AWB`}
$('paymentType').addEventListener('change',updatePaymentButton);updatePaymentButton();
$('addItem').onclick=async()=>{busy(true);try{
  const type=$('paymentType').value,rawAmount=$('amount').value.trim();if(rawAmount==='')throw new Error('Enter the payment amount.');
  await api('/rest/v1/rpc/create_payment_line',{method:'POST',body:{p_awb:$('cashAwb').value,p_type:type,p_amount:Number(rawAmount),p_order_facility:$('orderFacility').value,p_collected_by:$('collectedBy').value||null,p_receiving_hub:$('receivingHub').value,p_destination:$('destinationHub').value}});
  notice('itemStatus',type==='CASH'?'Cash AWB recorded and ready for transport.':'Card AWB recorded and ready for the same transport bag.',true);$('cashAwb').value='';$('amount').value='';
  await loadAvailableAwbs();
}catch(e){notice('itemStatus',e.message)}finally{busy(false)}};

// SEARCH ONE AWB
$('cashSearchButton').onclick=searchCashAwb;$('cashSearchAwb').addEventListener('keydown',e=>{if(e.key==='Enter')searchCashAwb()});
async function searchCashAwb(){const awb=cleanAwb($('cashSearchAwb').value);notice('cashSearchStatus','');$('cashSearchResult').classList.add('hidden');state.cashEditRecord=null;if(!awb){notice('cashSearchStatus','Enter an SD / AWB number.');return}busy(true);try{const result=await api('/rest/v1/rpc/search_cash_awb',{method:'POST',body:{p_awb:awb}});if(isCashAdmin()||state.canDeleteAwbs){try{state.cashEditRecord=await api('/rest/v1/rpc/get_payment_line_for_edit',{method:'POST',body:{p_awb:awb}})}catch(error){state.cashEditRecord=null;console.warn('Edit details unavailable:',error.message)}}renderCashSearch(result)}catch(e){notice('cashSearchStatus',e.message)}finally{busy(false)}}
function renderCashSearch(r){
  const history=r.history||[];
  const editRecord=state.cashEditRecord;
  let adminActions='';
  let historyAction='';
  if(editRecord){
    const editButton=isCashAdmin()?'<button class="secondary" onclick="openCashEdit()">Edit AWB</button>':'';
    const deleteButton=state.canDeleteAwbs?'<button class="danger" onclick="deleteCashAwb()">Delete AWB</button>':'';
    if(editRecord.bag_id&&state.canDeleteAwbs){
      const count=Number(editRecord.bag_awb_count||0);
      historyAction=`<button class="danger bag-delete history-delete-button" onclick="deleteWholeCashBag('${editRecord.bag_id}')">Delete Whole Bag${count?` (${count} AWB${count===1?'':'s'})`:''}</button>`;
    }
    if(editButton||deleteButton)adminActions=`<div class="awb-admin-actions">${editButton}${deleteButton}</div>`;
  }
  $('cashSearchResult').classList.remove('hidden');
  $('cashSearchResult').innerHTML=`<div class="awb-detail"><div class="section-heading"><div><p class="eyebrow">${esc(r.payment_type)} AWB</p><h3>${esc(r.awb)}</h3></div><span class="pill">${esc(r.cash_status||r.payment_type)}</span></div><div class="info-grid"><div><span>Amount</span><strong>AED ${Number(r.amount||0).toFixed(2)}</strong></div><div><span>Collected by</span><strong>${esc(nameFor(r.collected_by))}</strong></div><div><span>First received at</span><strong>${esc(hubFor(r.first_receiving_hub_id))}</strong></div><div><span>Current location</span><strong>${esc(hubFor(r.current_cash_hub_id))}</strong></div><div><span>Final destination</span><strong>${esc(hubFor(r.final_destination_hub_id))}</strong></div><div><span>Current holder / bag</span><strong>${esc(nameFor(r.current_cash_custodian))}${r.active_batch_name?` • ${esc(r.active_batch_name)}`:''}</strong></div></div>${adminActions}<div class="history-title-row"><h3>AWB custody history</h3>${historyAction}</div>${history.length?history.map(x=>`<div class="audit-item"><strong>${esc(formatDate(x.created_at))}</strong><div>${esc(eventLabel(x.event_type))}${x.batch_name?` • Bag ${esc(x.batch_name)}`:''}<br><small>${esc(nameFor(x.from_user_id))} → ${esc(nameFor(x.to_user_id))} • ${esc(hubFor(x.from_hub_id))} → ${esc(hubFor(x.to_hub_id))}${x.notes?` • ${esc(x.notes)}`:''}</small></div></div>`).join(''):'<p class="muted">No custody events yet.</p>'}</div>`;
  $('cashSearchResult').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function setEditCoreEnabled(enabled){for(const id of ['editPaymentType','editOrderFacility','editCollectedBy','editReceivingHub','editDestinationHub'])$(id).disabled=!enabled}
window.openCashEdit=()=>{const r=state.cashEditRecord;if(!r)return;$('editAwb').value=r.awb||'';$('editPaymentType').value=r.payment_type||'CASH';$('editAmount').value=Number(r.amount||0).toFixed(2);$('editOrderFacility').value=r.order_hub_id||'';$('editCollectedBy').value=r.collected_by||'';$('editReceivingHub').value=r.first_receiving_hub_id||'';$('editDestinationHub').value=r.destination_hub_id||'';$('editReason').value='';setEditCoreEnabled(Boolean(r.core_fields_editable));$('editRestriction').textContent=r.core_fields_editable?'All fields may be corrected because this AWB is not yet in a transport bag.':'This AWB already has custody history. Only AWB number and amount may be corrected.';$('cashEditModal').classList.remove('hidden')};
window.closeCashEdit=()=>{if($('cashEditModal'))$('cashEditModal').classList.add('hidden')};
$('saveCashEdit').onclick=async()=>{const r=state.cashEditRecord;if(!r)return;const reason=$('editReason').value.trim();if(!reason){notice('editCashStatus','Enter the correction reason.');return}busy(true);notice('editCashStatus','');try{await api('/rest/v1/rpc/edit_payment_line',{method:'POST',body:{p_payment_line:r.id,p_awb:$('editAwb').value,p_type:$('editPaymentType').value,p_amount:Number($('editAmount').value),p_order_facility:$('editOrderFacility').value,p_collected_by:$('editCollectedBy').value||null,p_receiving_hub:$('editReceivingHub').value,p_destination:$('editDestinationHub').value,p_reason:reason}});closeCashEdit();$('cashSearchAwb').value=cleanAwb($('editAwb').value);await Promise.all([searchCashAwb(),loadAvailableAwbs(),refreshCash()]);notice('cashSearchStatus','AWB updated and the correction was added to the audit log.',true)}catch(e){notice('editCashStatus',e.message)}finally{busy(false)}};
async function deletePaymentAwbById(paymentLineId,awb,bagName='',afterBatchId=null,statusId='cashSearchStatus'){
  if(!state.canDeleteAwbs||!paymentLineId)return false;
  const place=bagName?` from bag ${bagName}`:'';
  const reason=prompt(`Reason for permanently deleting ${awb}${place}:`);
  if(!reason?.trim())return false;
  if(!confirm(`Permanently delete AWB ${awb}${place}, remove its custody history, and update all affected bag totals? This cannot be undone.`))return false;
  busy(true);
  try{
    const result=await api('/rest/v1/rpc/delete_payment_line',{method:'POST',body:{p_payment_line:paymentLineId,p_reason:reason.trim()}});
    let proofMessage='';
    const proofPaths=result?.proof_paths||[];
    if(proofPaths.length){
      try{const removed=await deleteCustodyProofFiles(proofPaths);proofMessage=` ${removed} proof file${removed===1?'':'s'} removed from empty deleted bag(s).`}
      catch(error){proofMessage=` AWB data was deleted, but ${proofPaths.length} proof file${proofPaths.length===1?'':'s'} could not be removed automatically: ${error.message}`}
    }
    const successMessage=`AWB ${awb} deleted. ${Number(result?.affected_batches||0)} bag leg(s) updated.${Number(result?.removed_empty_batches||0)?` ${result.removed_empty_batches} empty bag leg(s) removed.`:''}${proofMessage}`;
    await Promise.all([loadAvailableAwbs(),refreshCash()]);
    notice(statusId,successMessage,!proofMessage.includes('could not'));
    if(afterBatchId){
      if(result?.batch_removed){
        $('auditPanel').innerHTML='';$('auditPanel').classList.add('hidden');state.auditBatchId=null;state.auditItems=[];
      }else{
        try{await window.showAudit(afterBatchId)}catch{}
      }
    }
    return true;
  }catch(e){notice(statusId,e.message);return false}finally{busy(false)}
}
window.deleteCashAwb=async()=>{
  const r=state.cashEditRecord;
  if(!state.canDeleteAwbs||!r)return;
  const deleted=await deletePaymentAwbById(r.id,r.awb,r.bag_name||'',r.bag_id||null,'cashSearchStatus');
  if(deleted){state.cashEditRecord=null;$('cashSearchResult').innerHTML='';$('cashSearchResult').classList.add('hidden');$('cashSearchAwb').value=''}
};
window.deleteAuditAwb=async paymentLineId=>{
  const item=state.auditItems.find(x=>(x.payment_line_id||x.id)===paymentLineId);
  if(!item)return;
  await deletePaymentAwbById(paymentLineId,item.awb,state.auditBatchName,state.auditBatchId,'cashStatus');
};

async function deleteCustodyProofFiles(paths){
  const clean=[...new Set((paths||[]).map(x=>String(x||'').trim()).filter(Boolean))];
  if(!clean.length)return 0;
  const response=await fetch(`${cfg.supabaseUrl}/storage/v1/object/dawak-custody-proofs`,{
    method:'DELETE',
    headers:{apikey:cfg.anonKey,Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'},
    body:JSON.stringify({prefixes:clean})
  });
  const text=await response.text();
  if(!response.ok){let data;try{data=JSON.parse(text)}catch{data=null}throw new Error(data?.message||text||'Proof-file cleanup failed.');}
  return clean.length;
}

window.deleteWholeCashBag=async batchId=>{
  if(!state.canDeleteAwbs||!batchId)return;
  let batch=state.batches.find(x=>x.id===batchId)||null;
  let history=null;
  try{history=await api('/rest/v1/rpc/get_batch_history',{method:'POST',body:{p_batch:batchId}})}catch{}
  batch=history?.batch||batch||{};
  const bagName=String(batch.batch_name||state.auditBatchName||'').trim();
  const awbCount=Number(history?.items?.length||batch.item_count||0);
  if(!bagName){notice('cashStatus','Could not identify this bag. Refresh and try again.');return}
  const reason=prompt(`Reason for deleting the whole bag ${bagName} and all ${awbCount} AWB${awbCount===1?'':'s'}:`);
  if(!reason?.trim())return;
  const typed=prompt(`Type the exact bag name to confirm permanent deletion:\n\n${bagName}`);
  if(String(typed||'').trim()!==bagName){notice('cashStatus','Whole-bag deletion cancelled because the bag name did not match.');return}
  if(!confirm(`Permanently delete the complete bag/journey ${bagName}, every AWB inside it, and all custody history? This cannot be undone.`))return;
  busy(true);
  try{
    const result=await api('/rest/v1/rpc/delete_whole_cash_bag',{method:'POST',body:{p_batch:batchId,p_reason:reason.trim(),p_confirm_name:bagName}});
    let proofMessage='';
    const proofPaths=result?.proof_paths||[];
    if(proofPaths.length){
      try{const removed=await deleteCustodyProofFiles(proofPaths);proofMessage=` ${removed} proof file${removed===1?'':'s'} removed.`}
      catch(error){proofMessage=` Bag data was deleted, but ${proofPaths.length} proof file${proofPaths.length===1?'':'s'} could not be removed automatically: ${error.message}`}
    }
    state.cashEditRecord=null;state.auditBatchId=null;state.auditBatchName='';state.auditItems=[];
    $('cashSearchResult').innerHTML='';$('cashSearchResult').classList.add('hidden');$('cashSearchAwb').value='';
    $('auditPanel').innerHTML='';$('auditPanel').classList.add('hidden');
    await Promise.all([loadAvailableAwbs(),refreshCash()]);
    notice('cashStatus',`Whole bag deleted: ${Number(result?.deleted_batches||0)} bag leg(s), ${Number(result?.deleted_awbs||0)} AWB(s).${proofMessage}`,!proofMessage.includes('could not'));
  }catch(e){notice('cashStatus',e.message)}finally{busy(false)}
};
function eventLabel(v){return ({CREATED:'Bag created',HANDOVER_REQUESTED:'Bag handover requested',ACCEPTED:'Bag accepted',PROOF_UPLOADED:'Custody proof photo added',DRIVER_CASH_RECEIVED:'Cash received from collecting driver',CARD_RECORDED:'Card payment recorded',ADDED_TO_BAG:'Added to transport bag',BAG_HANDOVER_REQUESTED:'Bag handover requested',BAG_ACCEPTED_BY_DRIVER:'Bag accepted by driver',ARRIVED_AT_HUB:'Bag arrived at hub',FINAL_RECEIVED:'Final cash received',CARD_ACKNOWLEDGED:'Card record acknowledged',READY_FOR_ONWARD:'Checked; awaiting onward transport',EXCEPTION:'Exception reported'})[v]||String(v||'').replaceAll('_',' ')}


// CREATE A MIXED-DESTINATION TRANSPORT BAG
$('refreshAvailableAwbs').onclick=loadAvailableAwbs;$('bagFromHub').addEventListener('change',loadAvailableAwbs);
async function loadAvailableAwbs(){if(!state.token||!isCashAdmin()||!$('bagFromHub').value)return;notice('availableStatus','');try{state.availableAwbs=await api('/rest/v1/rpc/list_available_transport_awbs',{method:'POST',body:{p_hub:$('bagFromHub').value}});renderAvailableAwbs()}catch(e){state.availableAwbs=[];renderAvailableAwbs();notice('availableStatus',e.message)}}
function renderAvailableAwbs(){const rows=state.availableAwbs||[];$('availableAwbs').innerHTML=rows.map(x=>{const type=String(x.payment_type||'CASH').toUpperCase(),local=x.final_destination_hub_id===$('bagFromHub').value,action=type==='CASH'?'Receive cash':'Acknowledge card';return `<label class="available-awb ${type==='CARD'?'card':''}"><input class="bag-awb-check" type="checkbox" value="${x.payment_line_id}"><span><strong><span class="payment-badge">${esc(type)}</span> ${esc(x.awb)} • AED ${Number(x.amount||0).toFixed(2)}</strong><small>Collected by ${esc(nameFor(x.collected_by))} • Final: ${esc(hubFor(x.final_destination_hub_id))}</small></span>${local?`<button type="button" class="local-receive" onclick="event.preventDefault();receiveLocalAwb('${x.payment_line_id}')">${action}</button>`:''}</label>`}).join('')||'<p class="muted">No CASH or CARD AWBs are waiting for transport at this hub.</p>';document.querySelectorAll('.bag-awb-check').forEach(x=>x.addEventListener('change',updateBagSummary));updateBagSummary()}
function selectedAwbs(){const ids=[...document.querySelectorAll('.bag-awb-check:checked')].map(x=>x.value);return state.availableAwbs.filter(x=>ids.includes(x.payment_line_id))}
function updateBagSummary(){const rows=selectedAwbs(),cash=rows.filter(x=>x.payment_type==='CASH'),card=rows.filter(x=>x.payment_type==='CARD'),cashTotal=cash.reduce((n,x)=>n+Number(x.amount||0),0),cardTotal=card.reduce((n,x)=>n+Number(x.amount||0),0);$('selectedBagSummary').textContent=`${rows.length} AWB${rows.length===1?'':'s'} • CASH ${cash.length} / AED ${cashTotal.toFixed(2)} • CARD ${card.length} / AED ${cardTotal.toFixed(2)} (not cash)`}
window.receiveLocalAwb=async id=>{const item=state.availableAwbs.find(x=>x.payment_line_id===id),awb=item?.awb||'this AWB',type=item?.payment_type||'CASH',action=type==='CARD'?'acknowledge this card record':'confirm final cash receipt';if(!confirm(`Confirm ${action} for ${awb} at ${hubFor($('bagFromHub').value)}?`))return;busy(true);try{await api('/rest/v1/rpc/final_receive_local_awb',{method:'POST',body:{p_payment_line:id}});notice('availableStatus',type==='CARD'?`${awb} card record acknowledged.`:`${awb} cash marked final received.`,true);await loadAvailableAwbs();await refreshCash()}catch(e){notice('availableStatus',e.message)}finally{busy(false)}};
$('createTransportBag').onclick=async()=>{const rows=selectedAwbs();notice('bagStatus','');if(!rows.length){notice('bagStatus','Select at least one ready CASH or CARD AWB.');return}if(!$('bagName').value.trim()){notice('bagStatus','Enter the physical bag or seal number.');return}if($('bagFromHub').value===$('bagNextHub').value){notice('bagStatus','Choose a different next checkpoint hub.');return}busy(true);try{await api('/rest/v1/rpc/create_transport_batch',{method:'POST',body:{p_name:$('bagName').value,p_from_hub:$('bagFromHub').value,p_next_hub:$('bagNextHub').value,p_payment_lines:rows.map(x=>x.payment_line_id)}});const cash=rows.filter(x=>x.payment_type==='CASH'),card=rows.filter(x=>x.payment_type==='CARD'),cashTotal=cash.reduce((n,x)=>n+Number(x.amount||0),0);notice('bagStatus',`Transport bag created: ${cash.length} CASH AWBs (AED ${cashTotal.toFixed(2)}) and ${card.length} CARD AWBs.`,true);$('bagName').value='';await Promise.all([loadAvailableAwbs(),refreshCash()])}catch(e){notice('bagStatus',e.message)}finally{busy(false)}};

// LIVE TRANSPORT BAGS
$('refreshCash').onclick=refreshCash;
async function refreshCash(){if(!state.token)return;try{notice('cashStatus','');state.batches=await api('/rest/v1/cash_batches?select=*&order=created_at.desc&limit=100');renderCashSummary(state.batches);$('batches').innerHTML=state.batches.map(renderBatch).join('')||'<tr><td colspan="10">No transport bags yet.</td></tr>';await loadRecipientMenus()}catch(e){notice('cashStatus',e.message)}}
function renderCashSummary(rows){const active=rows.filter(x=>!['RECONCILED','RECEIVED','EXCEPTION'].includes(x.status)),done=rows.filter(x=>['RECONCILED','RECEIVED'].includes(x.status)),exceptions=rows.filter(x=>x.status==='EXCEPTION'),activeCash=active.reduce((n,x)=>n+Number(x.expected_amount||0),0),activeCards=active.reduce((n,x)=>n+Number(x.card_item_count||0),0);$('cashSummary').innerHTML=`<div><span>Active bags</span><strong>${active.length}</strong></div><div><span>Physical cash in custody</span><strong>AED ${activeCash.toFixed(2)}</strong></div><div><span>Card records travelling</span><strong>${activeCards}</strong></div><div><span>Exceptions</span><strong>${exceptions.length}</strong></div>`}
function proofInput(id,stage){return `<label class="proof-upload">📷 Add proof photo (optional)<input id="proof-${stage}-${id}" type="file" accept="image/*" capture="environment"></label>`}
function renderBatch(b){
  let action='—';
  if(state.me.role!=='viewer'&&b.pending_to===state.me.id)action=`<div class="action-stack">${proofInput(b.id,'accept')}<button onclick="acceptBag('${b.id}')">Accept whole bag</button></div>`;
  else if(state.me.role!=='viewer'&&b.current_custodian===state.me.id&&['OPEN','IN_TRANSIT'].includes(b.status))action=`<div class="action-stack"><select id="to-${b.id}"><option value="">Loading recipients…</option></select><input id="seal-${b.id}" placeholder="Seal / bag">${proofInput(b.id,'handover')}<button onclick="handoverBag('${b.id}')">Hand over whole bag</button></div>`;
  else if(['coordinator','hub_leader'].includes(state.me.role)&&b.current_custodian===state.me.id&&['ARRIVED','EXCEPTION'].includes(b.status))action=`<button onclick="showArrival('${b.id}')">Check AWBs individually</button>`;
  const auditActions=`<div class="batch-row-actions"><button class="secondary" onclick="showAudit('${b.id}')">History & AWBs</button>${state.canDeleteAwbs?`<button class="danger bag-delete" onclick="deleteWholeCashBag('${b.id}')">Delete Whole Bag</button>`:''}</div>`;
  return `<tr><td>${esc(b.batch_name)}</td><td>${esc(hubFor(b.origin_hub_id))} → ${esc(hubFor(b.destination_hub_id))}<br><small>Next checkpoint</small></td><td>${Number(b.item_count||0)}<br><small>${Number(b.cash_item_count||0)} CASH / ${Number(b.card_item_count||0)} CARD</small></td><td>AED ${Number(b.expected_amount||0).toFixed(2)}</td><td>${Number(b.card_item_count||0)}<br><small>AED ${Number(b.card_amount||0).toFixed(2)} reference</small></td><td><span class="pill">${esc(b.status)}</span></td><td>${esc(nameFor(b.current_custodian))}<br><small>${esc(hubFor(b.current_hub_id))}</small></td><td>${esc(nameFor(b.pending_to))}</td><td>${action}</td><td>${auditActions}</td></tr>`
}
async function loadRecipientMenus(){
  const actionable=state.batches.filter(b=>b.current_custodian===state.me.id&&['OPEN','IN_TRANSIT'].includes(b.status));
  await Promise.all(actionable.map(async b=>{
    const select=$(`to-${b.id}`);
    if(!select)return;
    try{
      const rows=await api('/rest/v1/rpc/list_custody_recipients',{method:'POST',body:{p_batch:b.id}});
      select.innerHTML=rows.map(p=>`<option value="${p.id}">${esc(p.full_name||p.email)} (${esc(p.role)})</option>`).join('')||'<option value="">No authorized recipient</option>';
    }catch(e){
      select.innerHTML=`<option value="">${esc(e.message)}</option>`;
    }
  }));
}

window.handoverBag=async id=>{const to=$(`to-${id}`).value,file=$(`proof-handover-${id}`)?.files?.[0];if(!to){notice('cashStatus','Choose an authorized recipient.');return}busy(true);try{await api('/rest/v1/rpc/initiate_handover',{method:'POST',body:{p_batch:id,p_to:to,p_seal:$(`seal-${id}`).value,p_notes:''}});let message='Whole bag handover requested.';if(file){try{await saveCustodyProof(id,file,'HANDOVER')}catch(e){message+=` The handover is saved, but the photo failed: ${e.message}`}}await refreshCash();notice('cashStatus',message,!message.includes('failed'))}catch(e){notice('cashStatus',e.message)}finally{busy(false)}};
window.acceptBag=async id=>{const file=$(`proof-accept-${id}`)?.files?.[0];busy(true);try{await api('/rest/v1/rpc/accept_handover',{method:'POST',body:{p_batch:id}});let message=state.me.role==='driver'?'You accepted the whole sealed bag.':'Bag arrived. Check its AWBs one by one.';if(file){try{await saveCustodyProof(id,file,'ACCEPTANCE')}catch(e){message+=` The acceptance is saved, but the photo failed: ${e.message}`}}await refreshCash();notice('cashStatus',message,!message.includes('failed'))}catch(e){notice('cashStatus',e.message)}finally{busy(false)}};

// ARRIVAL: COORDINATOR CHECKS EACH AWB
window.showArrival=async id=>{try{const batch=state.batches.find(x=>x.id===id)?.batch_name||'Transport bag';state.arrivalBatch=id;$('arrivalTitle').textContent=`${batch} — check arrived AWBs`;$('arrivalPanel').classList.remove('hidden');const result=await api('/rest/v1/rpc/get_arrival_manifest',{method:'POST',body:{p_batch:id}});renderArrival(result);$('arrivalPanel').scrollIntoView({behavior:'smooth',block:'start'})}catch(e){notice('cashStatus',e.message)}};
function renderArrival(result){const items=result?.items||[];state.arrivalItems=items;$('arrivalCount').textContent=`${result?.processed_count||0} / ${result?.expected_count||0} checked`;$('arrivalItems').innerHTML=items.map(x=>{const type=String(x.payment_type||'CASH'),local=x.recommended_action!=='ONWARD';const label=x.processed?(x.processing_result==='FINAL_RECEIVED'?'Cash received ✓':x.processing_result==='CARD_ACKNOWLEDGED'?'Card record acknowledged ✓':x.processing_result==='READY_FOR_ONWARD'?'Ready for onward bag ✓':'Exception recorded'):(x.recommended_action==='CARD_ACKNOWLEDGE'?`Acknowledge card record at ${hubFor(result.arrival_hub_id)}`:local?`Receive cash at ${hubFor(result.arrival_hub_id)}`:`Check here, then onward to ${hubFor(x.final_destination_hub_id)}`);return `<div class="verification-item ${x.processed?'done':''}"><div><strong><span class="payment-badge">${esc(type)}</span> ${esc(x.awb)} — AED ${Number(x.amount||0).toFixed(2)}</strong><small>Final destination: ${esc(hubFor(x.final_destination_hub_id))} • Collected by: ${esc(nameFor(x.collected_by))}</small></div><div class="arrival-actions"><span class="verify-state">${esc(label)}</span>${!x.processed?`<button class="problem" onclick="reportAwbProblem('${x.payment_line_id}')">Problem</button>`:''}</div></div>`}).join('')||'<p>No AWBs are attached to this bag.</p>';if(Number(result?.processed_count||0)===Number(result?.expected_count||0)){notice('arrivalStatus','Bag reconciliation is complete. Onward AWBs are now available for a new transport bag.',true);refreshCash();if(isCashAdmin())loadAvailableAwbs()}}
async function processArrival(){const awb=cleanAwb($('arrivalAwbInput').value);notice('arrivalStatus','');if(!state.arrivalBatch||!awb){notice('arrivalStatus','Enter or scan an AWB first.');return}busy(true);try{const result=await api('/rest/v1/rpc/process_arrived_awb',{method:'POST',body:{p_batch:state.arrivalBatch,p_awb:awb}});$('arrivalAwbInput').value='';notice('arrivalStatus',`${awb} checked.`,true);renderArrival(result)}catch(e){notice('arrivalStatus',e.message)}finally{busy(false)}}
$('processArrivalAwb').onclick=processArrival;$('arrivalAwbInput').addEventListener('keydown',e=>{if(e.key==='Enter')processArrival()});
window.reportAwbProblem=async id=>{const awb=state.arrivalItems.find(x=>x.payment_line_id===id)?.awb||'';if(!awb)return;const notes=prompt(`Describe the problem with ${awb}:`);if(!notes)return;busy(true);try{const result=await api('/rest/v1/rpc/report_awb_exception',{method:'POST',body:{p_batch:state.arrivalBatch,p_awb:awb,p_notes:notes}});notice('arrivalStatus',`${awb} exception recorded.`);renderArrival(result)}catch(e){notice('arrivalStatus',e.message)}finally{busy(false)}};
$('arrivalScanButton').onclick=startArrivalScanner;$('stopArrivalScanner').onclick=stopArrivalScanner;
async function startArrivalScanner(){notice('arrivalStatus','');if(!state.arrivalBatch){notice('arrivalStatus','Open an arrived bag first.');return}if(typeof Html5Qrcode==='undefined'){notice('arrivalStatus','Camera scanner is unavailable. Enter the AWB manually.');return}$('arrivalScannerWrap').classList.remove('hidden');state.arrivalScanner=new Html5Qrcode('arrivalReader');try{await state.arrivalScanner.start({facingMode:'environment'},{fps:12,qrbox:{width:290,height:150},aspectRatio:1.7},async text=>{$('arrivalAwbInput').value=cleanAwb(text);await stopArrivalScanner();await processArrival()},()=>{})}catch{notice('arrivalStatus','Allow camera permission or enter the AWB manually.');await stopArrivalScanner()}}
async function stopArrivalScanner(){if(state.arrivalScanner){try{if(state.arrivalScanner.isScanning)await state.arrivalScanner.stop()}catch{}try{state.arrivalScanner.clear()}catch{}state.arrivalScanner=null}if($('arrivalScannerWrap'))$('arrivalScannerWrap').classList.add('hidden')}

async function loadProofImage(file){if(typeof createImageBitmap==='function'){try{const bitmap=await createImageBitmap(file);return{source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close?.()}}catch{}}const url=URL.createObjectURL(file),image=new Image();try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Could not read this photo.'));image.src=url});return{source:image,width:image.naturalWidth,height:image.naturalHeight,close:()=>URL.revokeObjectURL(url)}}catch(e){URL.revokeObjectURL(url);throw e}}
async function compressProof(file){if(!file||!String(file.type).startsWith('image/'))throw new Error('Choose an image file.');if(file.size>15*1024*1024)throw new Error('The original photo is too large. Choose one below 15 MB.');const picture=await loadProofImage(file),scale=Math.min(1,1600/Math.max(picture.width,picture.height)),width=Math.max(1,Math.round(picture.width*scale)),height=Math.max(1,Math.round(picture.height*scale)),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(picture.source,0,0,width,height);picture.close();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));if(!blob)throw new Error('Could not prepare the photo.');if(blob.size>2*1024*1024)throw new Error('The compressed photo is still above 2 MB.');return blob}
function encodedObjectPath(path){return String(path).split('/').map(encodeURIComponent).join('/')}
async function saveCustodyProof(batchId,file,stage){const blob=await compressProof(file),stamp=new Date().toISOString().slice(0,7),nonce=crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`,path=`${state.me.id}/${stamp}/${batchId}/${Date.now()}-${nonce}.jpg`,url=`${cfg.supabaseUrl}/storage/v1/object/dawak-custody-proofs/${encodedObjectPath(path)}`;const response=await fetch(url,{method:'POST',headers:{apikey:cfg.anonKey,Authorization:`Bearer ${state.token}`,'Content-Type':'image/jpeg','x-upsert':'false'},body:blob});const text=await response.text();if(!response.ok){let data;try{data=JSON.parse(text)}catch{data=null}throw new Error(data?.message||text||'Photo upload failed.')}await api('/rest/v1/rpc/attach_custody_proof',{method:'POST',body:{p_batch:batchId,p_path:path,p_name:String(file.name||'proof.jpg').slice(0,180),p_stage:stage,p_size:blob.size,p_mime:'image/jpeg'}});return path}
window.addHistoryProof=async(id,input)=>{const file=input?.files?.[0];if(!file)return;busy(true);try{await saveCustodyProof(id,file,'HISTORY');await showAudit(id);notice('cashStatus','Proof photo saved in the secure batch history.',true)}catch(e){notice('cashStatus',e.message)}finally{input.value='';busy(false)}};
window.openProof=async path=>{const tab=window.open('about:blank','_blank');try{const response=await fetch(`${cfg.supabaseUrl}/storage/v1/object/authenticated/dawak-custody-proofs/${encodedObjectPath(path)}`,{headers:{apikey:cfg.anonKey,Authorization:`Bearer ${state.token}`}});if(!response.ok)throw new Error('The proof photo could not be opened.');const url=URL.createObjectURL(await response.blob());if(tab)tab.location.href=url;else window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),120000)}catch(e){tab?.close();notice('cashStatus',e.message)}};
function renderAwbHistory(item){
  const history=item.history||[];
  const paymentLineId=item.payment_line_id||item.id||'';
  const deleteButton=state.canDeleteAwbs&&paymentLineId?`<button class="danger delete-awb-inline" onclick="event.preventDefault();event.stopPropagation();deleteAuditAwb('${paymentLineId}')">Delete AWB</button>`:'';
  return `<details class="awb-history"><summary><span><strong><span class="payment-badge">${esc(item.payment_type)}</span> ${esc(item.awb)}</strong><small>AED ${Number(item.amount||0).toFixed(2)} • Final: ${esc(hubFor(item.final_destination_hub_id))} • Collected by: ${esc(nameFor(item.collected_by))}</small></span><span class="awb-summary-actions"><span class="pill">${esc(item.processing_result||item.cash_status||'IN BAG')}</span>${deleteButton}</span></summary><div class="awb-events">${history.length?history.map(x=>`<div class="audit-item compact"><strong>${esc(formatDate(x.created_at))}</strong><div>${esc(eventLabel(x.event_type))}<br><small>${esc(nameFor(x.from_user_id))} → ${esc(nameFor(x.to_user_id))} • ${esc(hubFor(x.from_hub_id))} → ${esc(hubFor(x.to_hub_id))}${x.notes?` • ${esc(x.notes)}`:''}</small></div></div>`).join(''):'<p class="muted">No individual movement events recorded.</p>'}</div></details>`
}
function renderBagEvent(item){const amount=item.amount==null?'':` • AED ${Number(item.amount).toFixed(2)}`,notes=item.notes?` • ${esc(item.notes)}`:'',photo=item.proof_path?`<br><button class="photo-button" onclick="openProof('${esc(item.proof_path)}')">View proof photo</button>`:'';return `<div class="audit-item"><strong>${esc(formatDate(item.created_at))}</strong><div>${esc(eventLabel(item.event_type))} — ${esc(nameFor(item.actor_id))}<br><small>${esc(nameFor(item.from_user_id))} → ${esc(nameFor(item.to_user_id))} • ${esc(hubFor(item.hub_id))}${amount}${notes}</small>${photo}</div></div>`}
window.showAudit=async id=>{try{
  const result=await api('/rest/v1/rpc/get_batch_history',{method:'POST',body:{p_batch:id}}),b=result.batch||{},items=result.items||[],events=result.events||[];
  state.auditBatchId=id;state.auditBatchName=b.batch_name||'Transport bag';state.auditItems=items;
  const addPhoto=state.me.role!=='viewer'?`<label class="proof-upload history-proof">📷 Add proof photo<input type="file" accept="image/*" capture="environment" onchange="addHistoryProof('${id}',this)"></label>`:'';
  const deleteBag=state.canDeleteAwbs?`<button class="danger bag-delete" onclick="deleteWholeCashBag('${id}')">Delete Whole Bag</button>`:'';
  const awbList=items.map(renderAwbHistory).join('')||'<p>No AWBs are attached to this bag.</p>';
  const timeline=events.map(renderBagEvent).join('')||'<p class="muted">No bag events recorded.</p>';
  $('auditPanel').classList.remove('hidden');
  $('auditPanel').innerHTML=`<div class="section-heading"><div><p class="eyebrow">FULL BAG AUDIT</p><h3>${esc(b.batch_name||'Transport bag')} history</h3></div><div class="audit-heading-actions">${addPhoto}${deleteBag}</div></div><div class="history-summary"><div><span>Total AWBs</span><strong>${items.length}</strong></div><div><span>CASH</span><strong>${items.filter(x=>x.payment_type==='CASH').length} • AED ${Number(b.expected_amount||0).toFixed(2)}</strong></div><div><span>CARD</span><strong>${items.filter(x=>x.payment_type==='CARD').length} • AED ${Number(b.card_amount||0).toFixed(2)}</strong></div><div><span>Status</span><strong>${esc(b.status||'—')}</strong></div></div><h3>Tracking bills in this bag</h3><p class="muted">Open any AWB to see its individual custody trail. The authorized owner can delete an individual AWB here.</p><div class="awb-history-list">${awbList}</div><h3 class="timeline-title">Bag custody timeline</h3>${timeline}`;
  $('auditPanel').scrollIntoView({behavior:'smooth',block:'start'});
}catch(e){notice('cashStatus',e.message);throw e}};

window.addEventListener('online',setOnline);window.addEventListener('offline',setOnline);setOnline();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('service-worker.js'));
if(state.token)start().catch(e=>{logout();notice('loginStatus',e.message)});
