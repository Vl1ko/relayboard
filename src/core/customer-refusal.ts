/** Explicit, standalone opt-out only. Quoted requests and demand text are not refusals. */
export function isExplicitCustomerRefusal(text:string):boolean{
 let value=text.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase();
 for(let i=0;i<2;i++)value=value.replace(/^(?:спасибо|пожалуйста)(?:[,!.?]+\s*|\s+)/u,'');
 value=value.replace(/(?:,\s*|\s+)пожалуйста[.!?\s]*$/u,'').replace(/[.!?\s]+$/u,'').trim();
 return /^(?:стоп|stop|unsubscribe)$/u.test(value)
  || /^(?:больше )?не (?:пишите|звоните|связывайтесь|беспокойте)(?: (?:мне|меня|со мной|сюда|больше))*$/u.test(value)
  || /^отпишите меня(?: от рассылки)?$/u.test(value)
  || /^удалите (?:мой )?(?:номер|контакт)(?: из (?:базы|рассылки|списка))?$/u.test(value)
  || /^(?:прошу )?(?:больше )?(?:мне )?не (?:писать|звонить|связываться)(?: (?:мне|со мной|больше))*$/u.test(value)
  || /^(?:не надо|не нужно) (?:мне )?(?:писать|звонить)(?: (?:мне|больше))*$/u.test(value);
}
/** A temporary stop goes to the manager without permanently excluding the contact. */
export function isTemporaryContactPause(text:string):boolean{
 const value=text.trim().replace(/\s+/gu,' ').toLocaleLowerCase().replace(/^(?:пожалуйста|спасибо)[,! .]+/u,'');
 return /^(?:пока не (?:пишите|звоните|беспокойте)(?: мне| меня)?|не (?:пишите|звоните|беспокойте)(?: мне| меня)? пока)(?:[,!.\s]+(?:я )?(?:сам(?:а)? )?(?:напишу|отвечу|свяжусь)(?: (?:завтра|позже|потом))?)?[.!?\s]*$/u.test(value);
}
