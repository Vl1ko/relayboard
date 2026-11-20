import {useEffect,useRef,useState} from 'react';
type Settings={revision:number;dialogueDays:number;eligibleRequests:number;protectedRequests:number};
export default function StorageSettings(){
 const [settings,setSettings]=useState<Settings|null>(null),[days,setDays]=useState(30),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');const mounted=useRef(true),active=useRef(false);
 async function load(){const response=await fetch('/api/ai/workspace/settings/storage',{credentials:'include'});const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось загрузить настройки');if(mounted.current){setSettings(data);setDays(data.dialogueDays);}}
 useEffect(()=>{mounted.current=true;void load().catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};},[]);
 async function save(){if(!settings||active.current)return;active.current=true;setBusy(true);setError('');setMessage('');try{const response=await fetch('/api/ai/workspace/settings/storage',{method:'PUT',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:settings.revision,dialogueDays:days})});const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось сохранить настройки');await load();if(mounted.current)setMessage('Срок сохранён. Очистка выполняется автоматически. Уже удалённые тексты не восстанавливаются.');}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Не удалось сохранить настройки');}finally{active.current=false;if(mounted.current)setBusy(false);}}
 return <section className="conversation-operation"><h3>Хранение переписки</h3><p>Полные тексты, цитаты и снимки завершённых заявок хранятся указанное число дней после закрытия. Активные заявки, ожидание менеджера и неизвестные результаты отправок сохраняются. Защита от повторных обращений остаётся после удаления текста.</p>
 <label>Дней после закрытия<input type="number" min={1} max={3650} value={days} onChange={e=>setDays(Number(e.target.value))} disabled={!settings||busy}/></label>
 <button disabled={!settings||busy||!Number.isInteger(days)||days<1||days>3650} onClick={()=>void save()}>Сохранить срок хранения</button>
 <button disabled={busy} onClick={()=>{setError('');void load().catch(e=>setError(e.message));}}>Обновить оценку</button>
 {settings&&<p>Готовы к очистке: {settings.eligibleRequests}. Защищены из-за незавершённых действий: {settings.protectedRequests}.</p>}
 <p className="conversation-muted">Карточка контакта и её реквизиты сохраняются. Настройка не удаляет сообщения из MAX или WhatsApp. Вложения публикаций очищаются отдельно.</p>
 {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
