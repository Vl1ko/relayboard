import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../core/db.js";

const schemaUrl = new URL("../../database/schema.sql", import.meta.url);
const sql = await readFile(fileURLToPath(schemaUrl), "utf8");

await pool.query(sql);
console.log("Database schema is up to date");
await pool.end();
