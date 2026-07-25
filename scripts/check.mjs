import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "src/injected/main.mjs",
  "src/injected/runtime.mjs",
  "src/injected/bridge-client.mjs",
  "src/injected/ui.mjs",
  "src/core/config.mjs",
  "src/core/normalize.mjs",
  "src/core/eta.mjs",
  "src/core/history.mjs",
  "src/core/polling.mjs",
  "scripts/build.mjs",
  "scripts/patcher.mjs",
  "scripts/cli.mjs",
].map((file) => path.join(root, file));

const forbidden = [
  /\bAuthorization\b\s*:/i,
  /\baccess[_-]?token\b\s*[:=]/i,
  /\bcookie\b\s*[:=]/i,
];

for (const file of files) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && file.endsWith("cli.mjs")) continue;
    throw error;
  }
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      throw new Error(
        `Forbidden credential-like literal in ${path.relative(root, file)}: ${pattern}`,
      );
    }
  }
}

console.log("Static safety checks passed");
