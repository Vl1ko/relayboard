import test from 'node:test';import assert from 'node:assert/strict';
import {migrationReadinessBlockers} from './launch-readiness.js';import {loadAiManagerMigrations} from './ai-manager-migration.js';
test('release preflight rejects the formerly accepted schema12 and changed or newer history',async()=>{
 const expected=await loadAiManagerMigrations();assert.ok(expected.length>=23);assert.deepEqual(migrationReadinessBlockers(expected,expected),[]);
 const old=migrationReadinessBlockers(expected.slice(0,12),expected);assert.equal(old.length,expected.length-12);assert.ok(old.includes('Missing AI migration 23'));
 assert.deepEqual(migrationReadinessBlockers(expected.map(m=>m.version===1?{...m,checksum:'changed'}:m),expected),['AI migration checksum mismatch 1']);
 assert.deepEqual(migrationReadinessBlockers([...expected,{version:expected.length+1,checksum:'future'}],expected),['Database has a newer or unrecognized AI migration '+(expected.length+1)]);
});
