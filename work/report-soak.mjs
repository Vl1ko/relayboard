// One-run evidence collector; never sends messages, changes runtime state or declares production ready.
import {readFile,writeFile} from 'node:fs/promises';import {resolve,relative} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(process.argv[2]||'outputs/res09-soak-24h-2026-11-15');
if(!relative(resolve('outputs'),root)||relative(resolve('outputs'),root).startsWith('..'))throw Error('Use a dedicated outputs subdirectory');
const wait=process.argv.includes('--wait'),deadline=Date.now()+30*3600000;let status;
for(;;){status=JSON.parse(await readFile(root+'/status.json','utf8'));if(status.status!=='running')break;if(!wait){console.log(JSON.stringify({status:'running',updatedAt:status.updatedAt,requests:status.requests,productionReady:false}));process.exit(2);}if(Date.now()>=deadline)throw Error('Soak collection deadline reached; no PASS');await delay(60000);}
const samples=(await readFile(root+'/metrics.jsonl','utf8')).trim().split('\n').map(line=>JSON.parse(line));const errors=[];
if(status.status!=='passed'||!status.full24Hours||status.requestedDurationMs<86400000||status.elapsedMs<86400000)errors.push('A full successful24h runtime report is required');
if(status.simulatedAccounts?.max!==5||status.simulatedAccounts?.whatsapp!==5||status.parallelRequests!==20||status.dialogues?.max<20||status.dialogues?.whatsapp<20)errors.push('Required synthetic account/dialogue profile was not completed');
if(!samples.length||samples.length!==status.cycles||samples.at(-1)?.requests!==status.requests||status.duplicateStarts!==0)errors.push('Summary/sample accounting mismatch');
let maxGapMs=0;
for(let i=0;i<samples.length;i++){const row=samples[i];if(row.active_requests!==20||row.queue!==0||row.unknown!==0||row.duplicateStarts!==0||row.requests!==(i+1)*20||row.cycles!==i)errors.push('Invalid cycle '+i);const gap=i?Date.parse(row.at)-Date.parse(samples[i-1].at):Date.parse(row.at)-Date.parse(status.startedAt);if(!Number.isFinite(gap)||gap<0)errors.push('Invalid timestamp '+i);maxGapMs=Math.max(maxGapMs,gap);}
maxGapMs=Math.max(maxGapMs,Date.parse(status.finishedAt)-Date.parse(samples.at(-1)?.at));
// A sleeping Mac must not turn24h of elapsed wall time into a continuous soak PASS.
if(maxGapMs>120000)errors.push('Sampling gap exceeds two1-minute intervals');
const report={result:errors.length?'FAIL':'PASS',source:'synthetic runtime baseline started2026-11-15; final RC branches have separate regression evidence',runtimeReport:status,samples:samples.length,maxGapMs,minRssBytes:Math.min(...samples.map(s=>s.rss)),maxRssBytes:Math.max(...samples.map(s=>s.rss)),firstInboxBytes:Number(samples[0]?.inbox_bytes),lastInboxBytes:Number(samples.at(-1)?.inbox_bytes),firstOutboxBytes:Number(samples[0]?.outbox_bytes),lastOutboxBytes:Number(samples.at(-1)?.outbox_bytes),errors,productionReady:false,limitations:['No real model or messenger requests','No proof of10 real authorized browser sessions','Durable history grows until configured retention; whole PG database includes unrelated tests']};
await writeFile(root+'/final-report.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({result:report.result,report:root+'/final-report.json',productionReady:false}));if(errors.length)process.exitCode=1;
