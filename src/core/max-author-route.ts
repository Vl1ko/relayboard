/** Use only connector-attested metadata; never infer recipients from message text or group ID. */
export function maxSourceAuthor(message:{id:unknown;sender:unknown;text:unknown;time:unknown;type?:unknown},selfId:number){
 const sender=Number(message.sender),time=Number(message.time);
 if(!Number.isSafeInteger(selfId)||selfId<=0||!Number.isSafeInteger(sender)||sender<=0||sender===selfId||!String(message.id??'').trim()||typeof message.text!=='string'||!message.text.trim()||message.text.length>4000||!Number.isFinite(time)||time<=0||(message.type!==undefined&&message.type!=='USER'))return null;
 return {messageId:String(message.id),authorId:String(sender),text:message.text,occurredAt:new Date(time).toISOString()};
}
export function assertMaxAuthorDialog(chat:{id:unknown;type:unknown;participants:unknown},selfId:number,authorId:string,sourceChatId:string){
 if(chat.type!=='DIALOG'||String(chat.id)===sourceChatId||!Number.isSafeInteger(Number(chat.id))||Number(chat.id)===0||String(selfId)===authorId)throw Error('max_private_target_unverified');
 const participants=chat.participants;
 if(!participants||typeof participants!=='object')throw Error('max_private_target_unverified');
 const ids=Object.keys(participants).sort();
 if(ids.length!==2||!ids.includes(String(selfId))||!ids.includes(authorId))throw Error('max_private_target_unverified');
 return String(chat.id);
}
