import test from 'node:test';import assert from 'node:assert/strict';import {isExplicitCustomerRefusal,isTemporaryContactPause} from './customer-refusal.js';
test('polite standalone opt-outs stop contact without treating quotes, questions or demand as a refusal',()=>{
 for(const text of ['стоп',' STOP! ','unsubscribe','Не пишите мне, пожалуйста.','Пожалуйста, больше не пишите мне.','Спасибо, не звоните мне больше!','Удалите мой номер из базы.','Отпишите меня от рассылки','Прошу больше не писать мне','Не надо мне звонить','Больше не беспокойте меня','Не связывайтесь со мной','Спасибо! Пожалуйста, удалите мой контакт из списка.'])assert.equal(isExplicitCustomerRefusal(text),true,text);
 for(const text of ['Нужно 12 тонн, не пишите цену без доставки','Он сказал «не пишите мне»','«Не пишите мне»','Почему вы мне не пишите?','Пожалуйста, напишите завтра','Не пишите пока, напишу завтра','Стоп-кран нужен','Спасибо','Удалите мой номер заказа 126','Не звоните клиенту, напишите мне','НЕ НАДО 5 тонн, нужно 12'])assert.equal(isExplicitCustomerRefusal(text),false,text);
});

test('temporary no-contact request is held for a manager without being mistaken for a permanent opt-out',()=>{
 for(const text of ['Не пишите пока, напишу завтра','Пока не пишите мне','Пожалуйста, пока не беспокойте меня.']){assert.equal(isExplicitCustomerRefusal(text),false);assert.equal(isTemporaryContactPause(text),true);}
 for(const text of ['Напишите завтра','Он сказал «пока не пишите»','Нужно12 тонн, пока не пишите цену'])assert.equal(isTemporaryContactPause(text),false);
});
