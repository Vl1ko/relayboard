import type {Pool,PoolClient} from 'pg';
export async function latestRequestCustomerSequence(db:Pool|PoolClient,conversationId:string){return String((await db.query('SELECT ai_latest_request_customer_sequence($1) AS n',[conversationId])).rows[0].n);}
