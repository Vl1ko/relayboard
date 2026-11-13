export const DEFAULT_GREETING='Здравствуйте!';
export const DEFAULT_QUALIFIED='Спасибо! Информация по заявке принята. Пожалуйста, ожидайте ответа менеджера.';
export const DEFAULT_UNQUALIFIED='Спасибо за обращение! К сожалению, сейчас мы не сможем помочь с этой заявкой. Всего доброго!';
export function completionTemplate(settings:{qualifiedMessage?:string;unqualifiedMessage?:string},status:string){return status==='qualified'?(settings.qualifiedMessage??DEFAULT_QUALIFIED):(settings.unqualifiedMessage??DEFAULT_UNQUALIFIED);}
