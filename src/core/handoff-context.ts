import type {Pool} from 'pg';
export const singleLine=(value:unknown,max=200)=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
export function workspaceLink(base:string|undefined,contactId:string,conversationId:string,requestId?:string){
 if(!base)return;try{const url=new URL(base);if(url.username||url.password||base.length>500||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return;url.hash='';url.search='';url.searchParams.set('view','dialogs');url.searchParams.set('contact',contactId);url.searchParams.set('conversation',conversationId);if(requestId)url.searchParams.set('request',requestId);return url.href;}catch{return;}
}
const reasons:Record<string,string>={qualified:'Параметры подтверждены. Заявка соответствует настроенным критериям.',criteria_not_met:'Заявка не соответствует настроенным критериям.',contact_pause_requested:'Клиент попросил временно не связываться с ним',requested_human:'Клиент попросил подключить менеджера.',reply_limit:'Достигнут лимит автоматических ответов.',unknown_commercial_fact:'Нужен ответ менеджера на коммерческий вопрос.',unknown_question:'Вопрос требует ответа менеджера.',provider_failure:'Не удалось получить проверенный ответ модели.',invalid_model_output:'Ответ модели не прошёл проверку.',ungrounded_extraction:'Параметры не удалось подтвердить по словам клиента.',qualification_not_proven:'Не хватает подтверждённых данных для квалификации.'};
/** Factual snapshot only: accepted fields and exact source quote, no new model request. */
export async function handoffContext(pool:Pool,decision:any,publicAppUrl?:string){
 const settings=(await pool.query('SELECT settings FROM ai_engine_settings WHERE version=$1',[decision.settings_version])).rows[0]?.settings;
 const v=(await pool.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[decision.conversation_id])).rows[0];
 const source=(await pool.query(`SELECT p.request_id,s.platform,a.name AS account_name,d.title AS chat_title,l.source_link,l.original_text,l.classification FROM ai_request_phases p
 LEFT JOIN LATERAL(SELECT * FROM ai_request_sources s WHERE s.request_id=p.request_id ORDER BY s.created_at,s.external_message_id LIMIT 1)s ON true
 LEFT JOIN integrations a ON a.id=s.reader_account_id LEFT JOIN destinations d ON d.integration_id=s.reader_account_id AND d.external_id=s.external_chat_id LEFT JOIN ai_leads l ON l.id=s.lead_id WHERE p.id=$1`,[decision.request_phase_id])).rows[0];
 const labels:Record<string,string>={},fields=decision.fields as Record<string,{value:unknown}>;
 for(const f of settings?.fields??[]){const next={...labels,[f.key]:singleLine(f.question,72)};if(JSON.stringify(next).length<=3800)Object.assign(labels,next);}
 const parameters=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,singleLine(value.value,500)]));
 const missing=(settings?.fields??[]).filter((f:any)=>f.required&&!Object.hasOwn(fields,f.key)).map((f:any)=>singleLine(f.question,72));
 const quote=source?.classification?.demandQuote;const parts=[reasons[decision.reason]??'Требуется проверка менеджера.'];
 if(typeof quote==='string'&&quote&&source.original_text?.includes(quote))parts.push('Обращение: «'+singleLine(quote,300)+'».');
 if(missing.length)parts.push('Не уточнено: '+missing.join('; ')+'.');
 const snapshot:Record<string,string>={eventKey:decision.event_key,fieldLabelsJson:JSON.stringify(labels)};
 if(source?.chat_title)snapshot.chatTitle=singleLine(source.chat_title);if(source?.account_name)snapshot.readerAccount=singleLine(source.account_name);if(source?.platform)snapshot.platform=source.platform;
 if(typeof source?.source_link==='string'&&source.source_link.length<=1000){try{if(['http:','https:'].includes(new URL(source.source_link).protocol))snapshot.sourceLink=source.source_link;}catch{}}
 const link=workspaceLink(publicAppUrl,v?.contact_id,decision.conversation_id,source?.request_id);if(link)snapshot.cardLink=link;
 return{summary:parts.join(' ').slice(0,4000),parameters,source:snapshot};
}
