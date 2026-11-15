import { config } from "../core/config.js";
import { pool } from "../core/db.js";
import {loadAiManagerMigrations} from "../core/ai-manager-migration.js";
import {migrationReadinessBlockers} from "../core/launch-readiness.js";
const mode = process.argv[2] ?? "review";
const blockers: string[] = [];
try {
  if (!["review", "yandex-test", "gigachat-test", "live"].includes(mode))
    throw Error("Use review, yandex-test, gigachat-test or live");
  const result = await pool.query(
    "SELECT version,checksum FROM ai_schema_migrations ORDER BY version",
  );
  blockers.push(...migrationReadinessBlockers(result.rows,await loadAiManagerMigrations()));
  if (!config.CONTACT_IMPORT_ENABLED)
    blockers.push("CONTACT_IMPORT_ENABLED must be true for new workspace");
  if (mode !== "review") {
    const expected = mode === "yandex-test" ? "yandex" : mode === "gigachat-test" ? "gigachat" : config.AI_PROVIDER_MODE;
    if (expected === "fixture" || config.AI_PROVIDER_MODE !== expected)
      blockers.push("Select the requested external provider mode");
    if (!config.AI_ALLOW_EXTERNAL_REQUESTS)
      blockers.push("External model requests are disabled");
    if (expected === "gigachat" && !config.GIGACHAT_AUTH_KEY?.trim())
      blockers.push("GigaChat server credentials are missing");
    if (expected === "yandex" && (!config.YANDEX_API_KEY?.trim() || !config.YANDEX_FOLDER_ID?.trim()))
      blockers.push("Yandex server credentials are missing");
    const s = await pool.query(
      "SELECT settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1",
    );
    if (
      s.rows[0]?.settings?.provider !== expected ||
      !s.rows[0]?.settings?.model
    )
      blockers.push("Save matching provider and model in AI settings");
  }
  if (mode === "live") {
    if(config.AI_SEND_MODE!=='live')blockers.push('AI_SEND_MODE must be live');
    if(!config.MAX_WORKER_ENABLED||!config.MAX_WORKER_URL||!config.MAX_WORKER_SECRET)blockers.push('Configure the permanent MAX owner for manager notifications');
    if(config.AI_TEST_ONLY&&(!config.AI_TEST_ACCOUNT_IDS.length||!config.AI_TEST_AUTHOR_IDS.length))blockers.push('Test account and author allowlists must be explicit');
    if(!config.AI_TEST_ONLY&&config.GIGACHAT_SCOPE==='GIGACHAT_API_PERS'&&config.AI_PROVIDER_MODE==='gigachat')blockers.push('Personal GigaChat scope is not commercial release access');
    if(config.SOURCE_MONITOR_ENABLED&&config.AI_PROVIDER_MODE!=='gigachat')blockers.push('Source monitoring requires the configured GigaChat scorer');
    if(!blockers.length){
      const target=await pool.query("SELECT 1 FROM ai_manager_target t JOIN integrations i ON i.id=t.account_id WHERE t.id=1 AND i.enabled AND i.platform='max'");
      if(!target.rowCount)blockers.push('Configure an enabled MAX manager notification target');
    }
  }
  console.log(
    JSON.stringify(
      {
        mode,
        ready: blockers.length === 0,
        scope: "read-only configuration and schema checks only",
        liveAcceptance: false,
        blockers,
        notes: [
          "Read-only check; no messages or model requests sent",
          "This check does not establish live acceptance or authorize deployment",
        ],
      },
      null,
      2,
    ),
  );
  if (blockers.length) process.exitCode = 1;
} catch {
  console.error(
    "Readiness check failed: verify database access and applied migrations; no secrets or database error details printed",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
