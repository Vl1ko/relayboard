import { pool } from "../core/db.js";
import { applyAiManagerMigration } from "../core/ai-manager-migration.js";

try { console.log("AI-manager migration", await applyAiManagerMigration(pool)); }
finally { await pool.end(); }
