import test from 'node:test';
import assert from 'node:assert/strict';
import {hasLiteralNumber} from './numeric-evidence.js';
test('numeric evidence accepts decimal comma and dot without losing sign or whole-token boundaries',()=>{
 for(const [quote,value] of [['12,5 тонн',12.5],['12.50 tonnes',12.5],['-12,5',-12.5],['+12.5',12.5],['0,25',0.25]] as const)assert.equal(hasLiteralNumber(quote,value),true,quote);
 for(const [quote,value] of [['112,5',12.5],['12,50',12],['-12,5',12.5],['12,5',12500],['12.5.3',12.5],['1e3',1],['1e3',3],['1e3',1000],['12,5',5],['+112',12],['12,5,7',12.5]] as const)assert.equal(hasLiteralNumber(quote,value),false,quote+':'+value);
});
