import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer-core';
import {prepareWhatsAppAiText} from '../dist-node/core/adapters/whatsapp-ai-text.js';
const profile=await mkdtemp(join(tmpdir(),'relayboard-wa-synthetic-'));
let browser;
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,args:['--no-first-run','--disable-background-networking']});
 const page=await browser.newPage();await page.goto('about:blank');
 await page.evaluate(`(()=>{
 window.synthetic={sends:0,ack:1,state:'CONNECTED',self:'100@c.us'};
 const wid=id=>({_serialized:id,isLid:()=>id.endsWith('@lid')});
 class Key{static next=0;static async newId(){return 'synthetic-'+(++this.next);}constructor(data){this._serialized='true_'+data.to._serialized+'_'+data.id;}}
 const messages=new Map();
 const modules={WAWebSocketModel:{Socket:{get state(){return synthetic.state;}}},
 WAWebUserPrefsMeUser:{getMaybeMePnUser:()=>wid(synthetic.self),getMaybeMeLidUser:()=>null},
 WAWebMsgKey:Key,WAWebGetEphemeralFieldsMsgActionsUtils:{getEphemeralFields:()=>({})},
 WAWebSendMsgChatAction:{addAndSendMsgToChat(chat,message){if(this!==modules.WAWebSendMsgChatAction)throw Error('binding');synthetic.sends++;message.ack=synthetic.ack;messages.set(message.id._serialized,message);return [Promise.resolve(message),Promise.resolve()];}},
 WAWebCollections:{Msg:{get:id=>messages.get(id)}}};
 window.require=name=>modules[name];window.WWebJS={getChat:async id=>({id:wid(id),isGroup:false})};
 })()`);
 const cdp=await page.createCDPSession();
 const options={cdp,accountId:'synthetic-account',conversationId:'synthetic-conversation',operationId:'synthetic-operation',externalId:'200@c.us',recipientAliases:['200@c.us'],selfAliases:['100@c.us'],isActive:()=>true};
 const action={operationId:options.operationId,conversationId:options.conversationId,text:'Synthetic test, no WhatsApp connection'};
 const prepared=await prepareWhatsAppAiText(options);assert.equal(await page.evaluate('synthetic.sends'),0);
 const result=await prepared.prepared.start(action).acknowledgement;assert.equal(result.outcome,'confirmed');assert.equal(result.externalMessageId,prepared.reservedMessageId);
 await prepared.prepared.start(action).acknowledgement;assert.equal(await page.evaluate('synthetic.sends'),1);await prepared.release();
 await page.evaluate('synthetic.ack=0');const ack0=await prepareWhatsAppAiText(options);assert.equal((await ack0.prepared.start(action).acknowledgement).outcome,'unknown');await ack0.release();
 const changed=await prepareWhatsAppAiText(options);await page.evaluate("synthetic.self='300@c.us'");assert.equal((await changed.prepared.start(action).acknowledgement).outcome,'rejected');assert.equal(await page.evaluate('synthetic.sends'),2);await changed.release();
 await cdp.detach();console.log('PASS: actual isolated Chrome/CDP; preparation sends zero; exact reserved receipt; no duplicate; ack0 unknown; changed self rejected. Synthetic modules only, no WhatsApp login or network messages.');
}finally{await browser?.close();await rm(profile,{recursive:true,force:true});}
