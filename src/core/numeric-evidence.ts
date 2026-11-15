/** Literal decimal notation only: no units, arithmetic, exponent or sign changes. */
export function hasLiteralNumber(text:string,expected:number):boolean{
 if(!Number.isFinite(expected))return false;
 const tokens=text.matchAll(/(?<![0-9.,+\-])[+\-]?[0-9]+(?:[.,][0-9]+)?(?![0-9.,])/gu);
 for(const match of tokens){
  const at=match.index!,before=text.slice(Math.max(0,at-1),at),after=text.slice(at+match[0].length,at+match[0].length+1);
  if(/[eE]/.test(before)||/[eE]/.test(after))continue;
  if(Number(match[0].replace(',','.'))===expected)return true;
 }
 return false;
}
