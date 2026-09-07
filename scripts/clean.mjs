import { rmSync } from "node:fs";

for (const directory of ["../dist-node", "../dist-web"]) {
  rmSync(new URL(directory, import.meta.url), { recursive: true, force: true });
}
