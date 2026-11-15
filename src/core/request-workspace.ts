import type {Pool,PoolClient} from 'pg';
type Database=Pool|PoolClient;
export async function requestList(db:Database,contactId:string){
 const rows=(await db.query(`SELECT r.id,r.lifecycle,r.created_at AS "createdAt",r.closed_at AS "closedAt",r.content_expired_at AS "contentExpiredAt",
  (SELECT d.business_status FROM ai_engine_decisions d JOIN ai_request_phases p ON p.id=d.request_phase_id WHERE p.request_id=r.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) AS "lastDecision"
  FROM ai_requests r WHERE r.contact_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 101`,[contactId])).rows;
 return{requests:rows.slice(0,100),more:rows.length>100};
}
export async function requestDetail(db:Database,contactId:string,requestId:string){
 const request=(await db.query('SELECT id,lifecycle,created_at AS "createdAt",closed_at AS "closedAt",content_expired_at AS "contentExpiredAt" FROM ai_requests WHERE id=$1 AND contact_id=$2',[requestId,contactId])).rows[0];if(!request)return null;
 const sources=(await db.query(`SELECT s.platform,s.external_chat_id AS "chatId",s.external_message_id AS "messageId",s.created_at AS "createdAt",a.name AS "readerAccount",d.title AS "chatTitle",l.source_link AS link,
  coalesce(l.original_text,(SELECT i.text FROM ai_inbox i WHERE i.conversation_id=s.conversation_id AND i.external_message_id='group-source:'||s.external_chat_id||':'||s.external_message_id LIMIT 1)) AS text
  FROM ai_request_sources s LEFT JOIN integrations a ON a.id=s.reader_account_id LEFT JOIN destinations d ON d.integration_id=s.reader_account_id AND d.external_id=s.external_chat_id LEFT JOIN ai_leads l ON l.id=s.lead_id
  WHERE s.request_id=$1 ORDER BY s.created_at,s.external_message_id LIMIT 100`,[requestId])).rows;
 const phases=(await db.query(`SELECT p.id,p.conversation_id AS "conversationId",v.platform,a.name AS "accountName",p.started_at AS "startedAt",p.closed_at AS "closedAt",p.settings_version AS "settingsVersion",k.settings->'fields' AS "fieldDefinitions",
  CASE WHEN v.active_phase_id=p.id AND p.closed_at IS NULL THEN s.fields ELSE p.fields_snapshot END AS fields,
  (SELECT d.business_status FROM ai_engine_decisions d WHERE d.request_phase_id=p.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) AS "lastDecision",
  (SELECT d.reply FROM ai_engine_decisions d WHERE d.request_phase_id=p.id AND d.disposition='reply' ORDER BY d.created_at DESC,d.id DESC LIMIT 1) AS "lastReply"
  FROM ai_request_phases p JOIN ai_conversations v ON v.id=p.conversation_id LEFT JOIN integrations a ON a.id=v.account_id JOIN ai_engine_settings k ON k.version=p.settings_version LEFT JOIN ai_engine_state s ON s.conversation_id=v.id WHERE p.request_id=$1 ORDER BY p.started_at DESC,p.id DESC LIMIT 100`,[requestId])).rows;
 const events=(await db.query('SELECT id,kind,actor,note,not_before AS "notBefore",created_at AS "createdAt" FROM ai_business_events WHERE request_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[requestId])).rows;
 return{request,sources,phases,events,limits:{sources:100,phases:100,events:100}};
}
