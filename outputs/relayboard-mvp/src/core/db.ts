import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

pool.on("error", (error) => {
  console.error("Unexpected database error", error);
});
