/** Strict, whole-message intent; unrelated mentions/negations/quoted instructions do not schedule. */
export function parseRequestedLater(text:string,at:Date,timezone:string):{notBefore?:string}|null{
 const value=text.trim().replace(/[.!?]+$/u,'').trim().toLocaleLowerCase();
 const tail=value==='позже'||value==='попозже'?value:value.match(/^(?:пожалуйста[,\s]+)?(?:напишите|напомните|свяжитесь(?:\s+со\s+мной)?|перезвоните|давайте)(?:[,\s]+пожалуйста)?(?:\s+мне)?[,\s]+(.+)$/u)?.[1];
 if(!tail)return null;if(/^(?:позже|попозже)$/u.test(tail))return{};
 const relative=tail.match(/^через\s+(?:(\d{1,3})\s+)?(минуту|минуты|минут|час|часа|часов|день|дня|дней|неделю|недели|недель)$/u);
 if(relative){const n=Number(relative[1]??1),unit=relative[2],seconds=n*(unit.startsWith('минут')?60:unit.startsWith('час')?3600:unit.startsWith('недел')?604800:86400);if(n<1||seconds>31536000)return null;return{notBefore:new Date(at.getTime()+seconds*1000).toISOString()};}
 const day=tail.match(/^(завтра|послезавтра)(?:\s+в\s+([01]?\d|2[0-3])(?::([0-5]\d))?)?$/u);if(!day)return null;
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const parts=(time:number)=>Object.fromEntries(formatter.formatToParts(new Date(time)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 const current=parts(at.getTime()),calendar=new Date(Date.UTC(current.year,current.month-1,current.day+(day[1]==='завтра'?1:2))),minute=Number(day[2]??0)*60+Number(day[3]??0);
 for(let t=Math.floor(at.getTime()/60000)*60000+60000;t<=at.getTime()+72*3600000;t+=60000){const p=parts(t);if(p.year===calendar.getUTCFullYear()&&p.month===calendar.getUTCMonth()+1&&p.day===calendar.getUTCDate()&&p.hour*60+p.minute>=minute)return{notBefore:new Date(t).toISOString()};}
 return null;
}
