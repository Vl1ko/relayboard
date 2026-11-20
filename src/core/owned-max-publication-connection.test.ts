import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {MaxConnections} from './max-connections.js';
import {DeliveryError} from './delivery-policy.js';
import {dispatchOwnedMaxPublication} from './owned-max-publication.js';

test('connection failure before send remains safely waiting',async()=>{
 let queries=0;
 const pool={async query(){queries++;return queries===1?{rows:[{status:'sending',account_id:'account',external_id:'-123'}]}:{rows:[]};}} as unknown as Pool;
 const connections={async get(){throw Error('max_connection_timeout_or_cancelled');}} as unknown as MaxConnections;
 await assert.rejects(dispatchOwnedMaxPublication(pool,connections,'delivery',new AbortController().signal,60000),(error:unknown)=>error instanceof DeliveryError&&error.kind==='waiting');
 assert.equal(queries,2);
});
