import test from 'node:test';
import assert from 'node:assert/strict';
import {hasLiteralNumber} from './numeric-evidence.js';
test('numeric evidence accepts decimal comma and dot without losing sign or whole-token boundaries',()=>{
 for(const [quote,value] of [['12,5 тонн',12.5],['12.50 tonnes',12.5],['-12,5',-12.5],['+12.5',12.5],['0,25',0.25]] as const)assert.equal(hasLiteralNumber(quote,value),true,quote);
 for(const [quote,value] of [['112,5',12.5],['12,50',12],['-12,5',12.5],['12,5',12500],['12.5.3',12.5],['1e3',1],['1e3',3],['1e3',1000],['12,5',5],['+112',12],['12,5,7',12.5],['м3',3],['x12.5',12.5],['0.100000000000000005',0.1],['9007199254740993',9007199254740992]] as const)assert.equal(hasLiteralNumber(quote,value),false,quote+':'+value);
});

test('dimensions, ranges and arithmetic do not prove a scalar quantity',()=>{
 for(const quote of ['20х10','20 х 10','20x10','20×10×5','20 на 10','20*10=200','10–20','20/10','20 + 10','Размер 20х10, уточню позже'])for(const value of [2,5,10,20,30,200])assert.equal(hasLiteralNumber(quote,value),false,quote+':'+value);
 assert.equal(hasLiteralNumber('Нужно 20 м3',20),true);
 assert.equal(hasLiteralNumber('Размер 20х10. Объём 25 м3',25),true);
});
