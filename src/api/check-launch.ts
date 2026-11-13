import { config } from "../core/config.js";
import { pool } from "../core/db.js";
const mode = process.argv[2] ?? "review";
const blockers: string[] = [];
try {
  if (!["review", "yandex-test", "live"].includes(mode))
    throw Error("Use review, yandex-test or live");
  const result = await pool.query(
    "SELECT version FROM ai_schema_migrations ORDER BY version",
  );
  for (let version = 1; version <= 10; version++)
    if (!result.rows.some((r) => r.version === version))
      blockers.push("Missing AI migration " + version);
  if (!config.CONTACT_IMPORT_ENABLED)
    blockers.push("CONTACT_IMPORT_ENABLED must be true for new workspace");
  if (mode !== "review") {
    if (config.AI_PROVIDER_MODE !== "yandex")
      blockers.push("Select Yandex provider mode");
    if (!config.AI_ALLOW_EXTERNAL_REQUESTS)
      blockers.push("External Yandex requests are disabled");
    if (!config.YANDEX_API_KEY?.trim() || !config.YANDEX_FOLDER_ID?.trim())
      blockers.push("Yandex server credentials are missing");
    const s = await pool.query(
      "SELECT settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1",
    );
    if (
      s.rows[0]?.settings?.provider !== "yandex" ||
      !s.rows[0]?.settings?.model
    )
      blockers.push("Save Yandex model URI in AI settings");
  }
  if (mode === "live")
    blockers.push(
      "Real AI send/receive transports are not implemented; synthetic mode is not a live transport",
    );
  console.log(
    JSON.stringify(
      {
        mode,
        ready: blockers.length === 0,
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
