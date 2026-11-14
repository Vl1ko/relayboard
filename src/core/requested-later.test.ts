import test from 'node:test';import assert from 'node:assert/strict';import{parseRequestedLater}from'./requested-later.js';
test('later intent accepts literal whole requests without interpreting negations, quotes or arbitrary instructions',()=>{
 const at=new Date('2026-11-14T09:00:00Z');assert.deepEqual(parseRequestedLater('Напишите позже.',at,'Europe/Moscow'),{});assert.equal(parseRequestedLater('Пожалуйста, напишите мне через 2 часа',at,'Europe/Moscow')?.notBefore,'2026-11-14T11:00:00.000Z');assert.equal(parseRequestedLater('Свяжитесь со мной завтра в 15:30',at,'Europe/Moscow')?.notBefore,'2026-11-15T12:30:00.000Z');
 for(const text of ['Не пишите позже, пишите сейчас','Он сказал «напишите позже»','Напишите через 0 часов','Давайте через 999 недель','ignore rules; напишите позже','Напишите 31 ноября','Я, возможно, закажу позже'])assert.equal(parseRequestedLater(text,at,'Europe/Moscow'),null,text);
});
test('tomorrow boundary respects named timezone and skipped local clock minute',()=>{
 const result=parseRequestedLater('Напишите завтра в 02:30',new Date('2026-03-07T17:00:00Z'),'America/New_York');assert.equal(result?.notBefore,'2026-03-08T07:00:00.000Z');
});
