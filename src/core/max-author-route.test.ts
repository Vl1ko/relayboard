import test from 'node:test';
import assert from 'node:assert/strict';
import {maxSourceAuthor,assertMaxAuthorDialog} from './max-author-route.js';
const message={id:'source-1',sender:202,text:'Тестовая заявка',time:Date.now(),type:'USER'};
test('recipient is actual remote sender; own, unknown and service messages are excluded',()=>{
 assert.equal(maxSourceAuthor(message,101)?.authorId,'202');
 assert.equal(maxSourceAuthor({...message,sender:101},101),null);
 assert.equal(maxSourceAuthor({...message,sender:undefined},101),null);
 assert.equal(maxSourceAuthor({...message,type:'SYSTEM'},101),null);
 assert.equal(maxSourceAuthor({...message,text:' '},101),null);
});
test('only server-confirmed personal dialog with exact sender and author is permitted',()=>{
 const dialog={id:303,type:'DIALOG',participants:{'101':0,'202':0}};
 assert.equal(assertMaxAuthorDialog(dialog,101,'202','-123'),'303');
 for(const chat of [{...dialog,type:'CHAT'},{...dialog,id:-123},{...dialog,id:0},{...dialog,participants:{'101':0,'999':0}},{...dialog,participants:{'101':0,'202':0,'999':0}}])assert.throws(()=>assertMaxAuthorDialog(chat,101,'202','-123'),/unverified/);
 assert.throws(()=>assertMaxAuthorDialog(dialog,101,'101','-123'),/unverified/);
});
