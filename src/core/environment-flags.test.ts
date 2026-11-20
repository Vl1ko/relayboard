import test from "node:test";
import assert from "node:assert/strict";
import { environmentBoolean } from "./environment-flags.js";
test("explicit false does not enable cookies or external requests", () => {
  assert.equal(environmentBoolean.parse("false"), false);
  assert.equal(environmentBoolean.parse("true"), true);
  assert.equal(environmentBoolean.parse(undefined), false);
  for (const bad of ["0", "1", "yes", "FALSE", ""])
    assert.throws(() => environmentBoolean.parse(bad));
});

test('application configuration fails closed when global TLS verification is disabled',async()=>{
 const {spawnSync}=await import('node:child_process');const source=import.meta.url.endsWith('.ts'),moduleUrl=new URL(source?'./config.ts':'./config.js',import.meta.url).href;const result=spawnSync(process.execPath,[...(source?['--import','tsx']:[]),'-e',`import(${JSON.stringify(moduleUrl)})`],{env:{...process.env,DOTENV_CONFIG_PATH:'/dev/null',NODE_TLS_REJECT_UNAUTHORIZED:'0'},encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/TLS certificate verification cannot be disabled/);
});
