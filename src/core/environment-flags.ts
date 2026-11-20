import { z } from "zod";
// Environment variables are strings: Boolean('false') would enable the flag.
export const environmentBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
