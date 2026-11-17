import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { SearchSourcesStore, searchSourcesSchema } from "./search-sources.js";
import { applyAiManagerMigration } from "./ai-manager-migration.js";
const url = process.env.SEARCH_TEST_DATABASE_URL,
  skip = !url;
let pool: pg.Pool, schema: string, store: SearchSourcesStore;
before(async () => {
  if (!url) return;
  if (new URL(url).pathname != "/relayboard_search_test")
    throw Error("Dedicated search test DB required");
  schema = "search_" + randomUUID().replaceAll("-", "");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE SCHEMA " + schema);
  await c.end();
  pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  await pool.query(
    await readFile(
      new URL("../../database/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await applyAiManagerMigration(pool);
  store = new SearchSourcesStore(pool);
});
after(async () => {
  if (pool) {
    await pool.query("DROP SCHEMA " + schema + " CASCADE");
    await pool.end();
  }
});
test("source selections reject duplicate identities rather than silently duplicating monitors", () => {
  const s = { accountId: randomUUID(), chatId: "chat", platform: "max" };
  assert.throws(() =>
    searchSourcesSchema.parse({ revision: 0, sources: [s, s] }),
  );
});
test(
  "selected chats persist, require registered account routes and detect concurrent edits",
  { skip },
  async () => {
    const a = (
      await pool.query(
        "INSERT INTO integrations(platform,name,credential_ciphertext)VALUES('max','Fixture','fake') RETURNING id",
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO destinations(integration_id,external_id,title,kind)VALUES($1,'chat','Fixture chat','group')",
      [a],
    );
    const initial = await store.get();
    assert.equal(initial.choices[0].chatId, "chat");
    const input = {
      revision: initial.revision,
      sources: [{ accountId: a, chatId: "chat", platform: "max" as const }],
    };
    const r = await store.save(input);
    assert.equal(r.monitoringActive, false);
    assert.deepEqual(
      (await new SearchSourcesStore(pool).get()).sources,
      input.sources,
    );
    await assert.rejects(store.save(input), { code: "sources_changed" });
    await assert.rejects(
      store.save({
        revision: r.revision,
        sources: [{ accountId: a, chatId: "unknown", platform: "max" }],
      }),
      { code: "source_not_available" },
    );
    assert.deepEqual((await store.get()).sources, input.sources);
    const cleared = await store.save({ revision: r.revision, sources: [] });
    assert.equal(cleared.sources.length, 0);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_requests")).rows[0].n,
      0,
    );
  },
);


test('AI source list accepts more than ten total sources while preserving one reader per chat',()=>{
 const source={accountId:randomUUID(),chatId:'chat',platform:'max' as const};
 assert.throws(()=>searchSourcesSchema.parse({revision:0,sources:[source,{...source,accountId:randomUUID()}]}));
 assert.equal(searchSourcesSchema.parse({revision:0,sources:Array.from({length:100},(_,i)=>({...source,chatId:String(i)}))}).sources.length,100);
 assert.throws(()=>searchSourcesSchema.parse({revision:0,sources:[{...source,platform:'telegram'}]}));
 assert.equal(searchSourcesSchema.safeParse({revision:0,sources:['max','whatsapp'].flatMap(platform=>Array.from({length:25},(_,i)=>({...source,platform,chatId:String(i)})))}).success,true);
});

test('saving more than five chats per messenger persists the complete source list',{skip},async()=>{const sources=[];for(const platform of ['max','whatsapp'] as const){const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES($1,'many chats','fake') RETURNING id",[platform])).rows[0].id;for(let i=0;i<12;i++){const chatId=platform+'-many-'+i;await pool.query("INSERT INTO destinations(integration_id,external_id,title,kind) VALUES($1,$2,$2,'group')",[account,chatId]);sources.push({accountId:account,chatId,platform});}}const before=await store.get(),saved=await store.save({revision:before.revision,sources});assert.equal(saved.sources.length,24);assert.equal((await store.get()).sources.length,24);});
