import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "dist");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "injected", "main.mjs")],
  outfile: path.join(outputDirectory, "is-codex-run-out.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome150"],
  sourcemap: false,
  legalComments: "none",
  minify: false,
  charset: "utf8",
});
await copyFile(
  path.join(root, "src", "injected", "style.css"),
  path.join(outputDirectory, "is-codex-run-out.css"),
);
await copyFile(
  path.join(root, "src", "native", "rc-device-key.cjs"),
  path.join(outputDirectory, "rc-device-key.cjs"),
);

console.log(`Built ${path.relative(root, outputDirectory)}`);
