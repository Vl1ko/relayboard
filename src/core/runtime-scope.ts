export type RuntimeScope={testOnly:boolean;accountIds:readonly string[];authorIds:readonly string[]};
/** Test operation is explicitly allowlisted; missing scope never means all contacts. */
export function runtimeAllows(scope:RuntimeScope,accountId:string,authorId:string){
 return !scope.testOnly||(scope.accountIds.includes(accountId)&&scope.authorIds.includes(authorId));
}

import type {Pool,PoolClient} from 'pg';
export async function runtimeAllowsConversation(pool:Pool|PoolClient,scope:RuntimeScope,conversationId:string){
 const source=(await pool.query(`SELECT v.account_id,s.author_id,s.source_author_id,s.reader_account_id FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id JOIN LATERAL(SELECT recipient_id AS author_id,author_id AS source_author_id,reader_account_id FROM ai_request_sources WHERE request_id=p.request_id AND conversation_id=v.id ORDER BY created_at DESC LIMIT 1)s ON true WHERE v.id=$1`,[conversationId])).rows[0];
 return !!source&&runtimeAllows(scope,source.account_id,source.author_id)&&runtimeAllows(scope,source.reader_account_id,source.source_author_id);
}
