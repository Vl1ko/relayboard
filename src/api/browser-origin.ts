import type {RequestHandler} from 'express';
/** Browser cookie requests stay on the app origin; API clients without Origin remain supported. */
export function browserOriginGuard(options:{publicAppUrl?:string;development?:boolean}):RequestHandler{
 const configured=options.publicAppUrl?new URL(options.publicAppUrl).origin:undefined;
 return(req,res,next)=>{
  const raw=req.get('origin'),fetchSite=req.get('sec-fetch-site');
  if(!raw){if(fetchSite==='cross-site')return res.status(403).json({error:'Запрос с постороннего сайта запрещён'});return next();}
  let origin:URL;try{origin=new URL(raw);if(origin.origin!==raw||!['https:','http:'].includes(origin.protocol))throw Error();}catch{return res.status(403).json({error:'Недопустимый источник запроса'});}
  const requestOrigin=req.protocol+'://'+req.get('host');
  const dev=options.development&&['http://localhost:5173','http://127.0.0.1:5173'].includes(raw);
  if(raw!==(configured??requestOrigin)&&!dev)return res.status(403).json({error:'Запрос с постороннего сайта запрещён'});
  res.setHeader('Access-Control-Allow-Origin',raw);res.setHeader('Access-Control-Allow-Credentials','true');res.vary('Origin');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Admin-Key');return res.sendStatus(204);}
  next();
 };
}
