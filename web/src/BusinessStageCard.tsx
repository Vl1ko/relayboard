import {useRef,useState} from 'react';
export type BusinessDetail={state:{revision:number;booking_state:string;order_state:string;followups_stopped:boolean;requested_contact_at:string|null}|null;events:{id:string;kind:string;actor:string;note:string;created_at:string;not_before:string|null}[]};
export default function BusinessStageCard({conversationId,requestId,epoch,data,labels,closed,onChange}:{conversationId:string;requestId?:string;epoch:string;data:BusinessDetail;labels:{scenario:string;label:string}[];closed:boolean;onChange:()=>void}){
 const [kind,setKind]=useState('booking_offered'),[note,setNote]=useState(''),[when,setWhen]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef(false),operation=useRef<{signature:string;id:string}|null>(null);
 const label=(scenario:string,fallback:string)=>labels.find(r=>r.scenario===scenario)?.label||fallback;
 const first=label('not_booked','Этап 1'),second=label('not_completed','Этап 2');
 const names:Record<string,string>={booking_offered:first+' — начат',booking_confirmed:first+' — завершён',order_started:second+' — начат',order_completed:second+' — завершён',requested_later:'Связаться позже',stop_followups:'Остановить дожимы'};
 async function save(){
  if(active.current)return;active.current=true;setBusy(true);setError('');
  try{
   const body={expectedRevision:data.state?.revision??0,expectedRequestId:requestId,expectedEpoch:epoch,kind,note,...(kind==='requested_later'&&when?{notBefore:new Date(when).toISOString()}: {})};
   const signature=JSON.stringify(body);if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()};
   const response=await fetch('/api/ai/workspace/conversations/'+conversationId+'/business-events',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({...body,operationId:operation.current.id})});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось сохранить отметку');setNote('');setWhen('');operation.current=null;onChange();
  }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить отметку');}finally{active.current=false;setBusy(false);}
 }
 return <section className="conversation-operation"><h4>Этапы заявки</h4>
  {!data.state?<p>У диалога нет активной заявки.</p>:<><p>{first}: {data.state.booking_state==='booked'?'завершён':data.state.booking_state==='offered'?'начат':'не начат'} · {second}: {data.state.order_state==='completed'?'завершён':data.state.order_state==='started'?'начат':'не начат'}</p>
  {data.state.requested_contact_at&&<p>Связаться не раньше: {new Date(data.state.requested_contact_at).toLocaleString('ru-RU')}</p>}
  {data.state.followups_stopped&&<p>Дожимы остановлены.</p>}
  <p className="conversation-muted">Завершение этапа приостанавливает автоматические ответы. После передачи менеджеру ИИ остаётся заблокирован до закрытия заявки.</p>
  <fieldset disabled={busy||closed}><div className="conversation-settings-grid"><label>Отметка<select value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(names).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
  {kind==='requested_later'&&<label>Не раньше — время устройства<input type="datetime-local" value={when} onChange={e=>setWhen(e.target.value)}/></label>}
  <label>Комментарий<input maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label></div><button onClick={()=>void save()}>Сохранить отметку</button></fieldset></>}
  {error&&<p role="alert">{error}</p>}
  <details><summary>История отметок</summary>{data.events.length?data.events.map(e=><p key={e.id}>{names[e.kind]||e.kind} · {e.actor==='customer'?'Просьба клиента':'Менеджер'} · {new Date(e.created_at).toLocaleString('ru-RU')}{e.note?' · '+e.note:''}</p>):<p>Отметок пока нет.</p>}</details>
 </section>;
}
