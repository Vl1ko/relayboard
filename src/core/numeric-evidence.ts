function canonical(value:string){
 let text=value.replace(',','.').replace(/^\+/u,''),negative=text.startsWith('-');if(negative)text=text.slice(1);
 const parts=text.split('.'),whole=parts[0].replace(/^0+(?=\d)/u,''),fraction=(parts[1]??'').replace(/0+$/u,'');
 return(negative&&(whole!=='0'||fraction)?'-':'')+whole+(fraction?'.'+fraction:'');
}
function renderedNumber(value:number){
 const raw=String(value);if(!/[eE]/u.test(raw))return canonical(raw);
 const [coefficient,exponent]=raw.toLowerCase().split('e'),negative=coefficient.startsWith('-'),plain=coefficient.replace('-',''),digits=plain.replace('.',''),point=(plain.includes('.')?plain.indexOf('.'):plain.length)+Number(exponent);
 const expanded=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
 return canonical((negative?'-':'')+expanded);
}
/** Literal decimal notation only: no units, arithmetic, exponent or precision loss. */
export function literalNumbers(text:string):number[]{
 const values=new Set<number>();
 for(const match of text.matchAll(/(?<![\p{L}\p{N}.,+\-])[+\-]?[0-9]+(?:[.,][0-9]+)?(?![0-9.,])/gu)){
  const after=text.slice(match.index!+match[0].length);if(/^[eE][+\-]?[0-9]/u.test(after))continue;
  const value=Number(match[0].replace(',','.'));if(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))continue;
  if(canonical(match[0])===renderedNumber(value))values.add(value);
 }
 return [...values];
}
export function hasLiteralNumber(text:string,expected:number):boolean{return Number.isFinite(expected)&&literalNumbers(text).includes(expected);}
