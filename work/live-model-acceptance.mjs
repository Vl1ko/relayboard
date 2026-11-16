// Bounded, synthetic-only model acceptance. No messenger operations or business writes.
import{readFile,mkdir,writeFile}from'node:fs/promises';import{resolve}from'node:path';import dotenv from'dotenv';import pg from'pg';
if(!process.argv.includes('--execute-synthetic')||!process.env.LIVE_TEST_ENV_FILE)throw Error('Explicit synthetic model test and private environment file required');
const env=dotenv.parse(await readFile(process.env.LIVE_TEST_ENV_FILE));if(env.AI_TEST_ONLY!=='true'||env.AI_PROVIDER_MODE!=='gigachat'||env.AI_ALLOW_EXTERNAL_REQUESTS!=='true')throw Error('Only the configured test model is allowed');
process.env.DOTENV_CONFIG_PATH='/dev/null';Object.assign(process.env,env);
const{createGigaChatProvider}=await import('../dist-node/core/gigachat-provider.js'),{AI_SYSTEM_PROMPT,validateAiDecision}=await import('../dist-node/core/ai-engine.js');
const corpus=JSON.parse(await readFile(new URL('./fixtures/release-corpus.json',import.meta.url),'utf8'));if(corpus.syntheticOnly!==true||corpus.unknownCommercialQuestions.length!==20)throw Error('Versioned20-case synthetic corpus required');
const db=new pg.Pool({connectionString:env.DATABASE_URL}),out=resolve(process.env.MODEL_TEST_OUTPUT_DIR||'outputs/res09-live-model-2026-11-16');await mkdir(out,{recursive:true});
const results=[];try{
 const saved=(await db.query('SELECT settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1')).rows[0].settings;
 const settings={...saved,knowledge:[],replyLimit:10},provider=createGigaChatProvider({pool:db,authKey:env.GIGACHAT_AUTH_KEY,scope:env.GIGACHAT_SCOPE});
 for(const c of corpus.unknownCommercialQuestions){if(typeof c.text!=='string'||c.text.length>1000)throw Error('Invalid corpus');const start=Date.now();try{
 const messages=[{messageId:c.id,text:c.text,origin:'customer'}],proposal=await provider.runExclusive(signal=>provider.complete({system:AI_SYSTEM_PROMPT,data:{settings,messages,fields:{}},signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])}));
 const d=validateAiDecision({settings,messages,previousFields:{},replyCount:0,proposal});results.push({id:c.id,result:d.disposition==='handoff'&&d.reply===null?'PASS':'FAIL',disposition:d.disposition,businessStatus:d.businessStatus,reason:d.reason,clientReply:d.reply,elapsedMs:Date.now()-start});
 }catch{results.push({id:c.id,result:'FAIL',reason:'provider_or_validation_failure',elapsedMs:Date.now()-start});}
 await writeFile(out+'/progress.json',JSON.stringify({completed:results.length,total:20,results},null,2)+'\n');console.log(c.id+': '+results.at(-1).result);
 }
 const report={scope:'20 versioned synthetic unknown commercial questions; real configured GigaChat; no messenger operations',model:settings.model,passed:results.filter(r=>r.result==='PASS').length,failed:results.filter(r=>r.result!=='PASS').length,results,productionReady:false};await writeFile(out+'/result.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});if(report.failed)process.exitCode=1;
}finally{await db.end();}
