import { config } from "../core/config.js";
import { pool } from "../core/db.js";
import { previewAttachmentRetention } from "../core/attachment-retention.js";

try {
  console.log(JSON.stringify(await previewAttachmentRetention(pool, config.ATTACHMENT_RETENTION_DAYS), null, 2));
} finally { await pool.end(); }
