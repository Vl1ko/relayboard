import {parsePhoneNumberWithError} from 'libphonenumber-js';
import type {MaxConnection} from './max-connections.js';
import {assertMaxAuthorDialog} from './max-author-route.js';

export function verifiedWirePhone(value:unknown){
 if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<=0))return undefined;
 if(typeof value!=='string'&&typeof value!=='number')return undefined;
 const text=String(value);if(!/^\+?[1-9][0-9]{6,14}$/.test(text))return undefined;
 try{const phone=parsePhoneNumberWithError(text.startsWith('+')?text:'+'+text);return phone.isValid()?phone.number:undefined;}catch{return undefined;}
}
function maxUserId(value:unknown){
 const text=String(value),n=Number(value);
 if(!/^[1-9][0-9]*$/.test(text)||!Number.isSafeInteger(n)||String(n)!==text)throw Error('max_user_id_unverified');
 return text;
}
function profile(raw:any){
 const id=maxUserId(raw?.id),name=raw?.names?.[0]??{};
 return{authorId:id,phone:verifiedWirePhone(raw.phone),name:[name.firstName??raw.firstName??'',name.lastName??raw.lastName??''].filter(v=>typeof v==='string').join(' ').slice(0,255)};
}
export async function resolveMaxPhone(connection:MaxConnection,phone:string){
 if(verifiedWirePhone(phone)!==phone)throw Error('phone_not_canonical');
 const result=await connection.socket.send(37,{query:phone,count:30}) as any;
 if(!Array.isArray(result?.result))throw Error('max_contact_response_invalid');
 const matches=result.result.filter((c:any)=>verifiedWirePhone(c.phone)===phone).map(profile);
 const ids=[...new Set(matches.map((c:any)=>c.authorId))];
 if(result.result.length===0)throw Error('max_phone_not_found');
 if(ids.length!==1||ids[0]===String(connection.selfId))throw Error('max_phone_not_uniquely_verified');
 return matches.find((c:any)=>c.authorId===ids[0])!;
}
export async function resolveMaxAuthor(connection:MaxConnection,authorId:string){
 maxUserId(authorId);if(authorId===String(connection.selfId))throw Error('max_self_contact_forbidden');
 const result=await connection.socket.send(32,{contactIds:[Number(authorId)]}) as any;
 if(!Array.isArray(result?.contacts))throw Error('max_contact_response_invalid');
 const matches=result.contacts.filter((c:any)=>String(c.id)===authorId);
 if(matches.length!==1)throw Error('max_author_unverified');return profile(matches[0]);
}
export async function openVerifiedMaxPrivate(connection:MaxConnection,authorId:string,sourceChatId:string){
 maxUserId(authorId);if(authorId===String(connection.selfId)||!connection.openDialog)throw Error('max_private_route_unavailable');
 const id=await connection.openDialog(Number(authorId));
 if(!/^-?\d+$/.test(id)||!Number.isSafeInteger(Number(id)))throw Error('max_private_target_unverified');
 const result=await connection.socket.send(48,{chatIds:[Number(id)]}) as any;
 const chat=result?.chats?.find((c:any)=>String(c.id)===id);
 if(!chat)throw Error('max_private_target_unverified');
 return assertMaxAuthorDialog(chat,connection.selfId,authorId,sourceChatId);
}
