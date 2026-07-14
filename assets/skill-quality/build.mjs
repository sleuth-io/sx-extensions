// Bundle src/ into the single ES module the app loads (the loader
// blob-imports main.js, so relative imports can't resolve at runtime).
// Usage: node build.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = [
  join(here, "src/index.js"),
  "--bundle",
  "--format=esm",
  `--outfile=${join(here, "main.js")}`,
];

// Prefer a PATH esbuild, fall back to npx (downloads on first use).
try {
  execFileSync("esbuild", args, { stdio: "inherit" });
} catch {
  execFileSync("npx", ["-y", "esbuild", ...args], { stdio: "inherit" });
}
console.log("bundled main.js");
