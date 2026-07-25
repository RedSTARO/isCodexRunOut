import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createPackageWithOptions,
  extractAll,
  extractFile,
  getRawHeader,
} from "@electron/asar";

export const INJECTION_START = "<!-- isCodexRunOut:start v0.1.0 -->";
export const INJECTION_END = "<!-- isCodexRunOut:end -->";

const INJECTION = `${INJECTION_START}
<link rel="stylesheet" href="./assets/is-codex-run-out.css">
<script defer src="./assets/is-codex-run-out.js"></script>
${INJECTION_END}`;

const REQUIRED_BUNDLE_ANCHORS = Object.freeze([
  "group/application-menu-top-bar",
  "data-app-shell-header-edge-scroll",
  "/wham/usage",
  "fetch-response",
  "X-OpenAI-Attach-Auth",
  "primary_window",
]);

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function sha256File(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export function listArchiveFiles(header) {
  const files = [];
  const walk = (node, prefix = "") => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const archivePath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, archivePath);
      else files.push({ path: archivePath, unpacked: entry.unpacked === true });
    }
  };
  walk(header);
  return files;
}

export function unpackedArchivePaths(asarPath) {
  const { header } = getRawHeader(asarPath);
  return listArchiveFiles(header)
    .filter((entry) => entry.unpacked)
    .map((entry) => entry.path)
    .sort();
}

function escapeGlobPath(value) {
  return value.replace(/([*?[\]{}(),!+@])/g, "\\$1");
}

export function exactUnpackGlob(paths, sourceRoot = null) {
  if (paths.length === 0) return undefined;
  const escaped = paths.map((archivePath) => {
    const candidate = sourceRoot
      ? path.resolve(sourceRoot, ...archivePath.split("/"))
      : archivePath;
    return escapeGlobPath(candidate.replaceAll("\\", "/"));
  });
  return escaped.length === 1 ? escaped[0] : `{${escaped.join(",")}}`;
}

export function patchIndexHtml(source) {
  if (source.includes(INJECTION_START) || source.includes(INJECTION_END)) {
    throw new Error("源 ASAR 已包含 isCodexRunOut 注入标记");
  }
  const moduleScript = /<script\s+type="module"[^>]*>/i;
  if (!moduleScript.test(source)) {
    throw new Error("webview/index.html 中未找到模块入口脚本");
  }
  return source.replace(moduleScript, `${INJECTION}\n    $&`);
}

function extractText(asarPath, archivePath) {
  return extractFile(
    asarPath,
    path.join(...archivePath.split("/")),
  ).toString("utf8");
}

export function inspectAsarCompatibility(asarPath) {
  const { header } = getRawHeader(asarPath);
  const files = listArchiveFiles(header);
  const fileNames = new Set(files.map((entry) => entry.path));
  const indexPath = "webview/index.html";
  if (!fileNames.has(indexPath)) {
    throw new Error("ASAR 中不存在 webview/index.html");
  }
  const index = extractText(asarPath, indexPath);
  if (index.includes(INJECTION_START)) {
    throw new Error("商店源 ASAR 已被补丁修改，拒绝继续");
  }
  const decodedCspQuotes = index.replaceAll("&#39;", "'");
  if (!/script-src[^;]*'self'/i.test(decodedCspQuotes)) {
    throw new Error("当前 CSP 不允许加载同源脚本");
  }
  if (!/style-src[^;]*'self'/i.test(decodedCspQuotes)) {
    throw new Error("当前 CSP 不允许加载同源样式");
  }

  const candidates = files
    .map((entry) => entry.path)
    .filter(
      (archivePath) =>
        /^webview\/assets\/app-initial-[^/]+\.js$/.test(archivePath) ||
        /^webview\/assets\/index-[^/]+\.js$/.test(archivePath),
    );
  if (candidates.length === 0) {
    throw new Error("未找到 Codex WebView 主资源包");
  }
  const bodies = candidates.map((archivePath) => ({
    archivePath,
    source: extractText(asarPath, archivePath),
  }));
  const anchors = {};
  for (const anchor of REQUIRED_BUNDLE_ANCHORS) {
    const match = bodies.find(({ source }) => source.includes(anchor));
    anchors[anchor] = match?.archivePath ?? null;
  }
  const missing = Object.entries(anchors)
    .filter(([, archivePath]) => archivePath == null)
    .map(([anchor]) => anchor);
  if (missing.length > 0) {
    throw new Error(`Codex 结构不兼容，缺少锚点：${missing.join(", ")}`);
  }
  return {
    compatible: true,
    indexPath,
    candidates,
    anchors,
    unpackedPaths: files
      .filter((entry) => entry.unpacked)
      .map((entry) => entry.path)
      .sort(),
  };
}

async function compareUnpackedFiles(leftRoot, rightRoot, archivePaths) {
  for (const archivePath of archivePaths) {
    const relativePath = archivePath.split("/");
    const left = path.join(leftRoot, ...relativePath);
    const right = path.join(rightRoot, ...relativePath);
    if (!(await exists(left)) || !(await exists(right))) {
      throw new Error(`重打包后缺少 unpacked 文件：${archivePath}`);
    }
    const [leftHash, rightHash] = await Promise.all([
      sha256File(left),
      sha256File(right),
    ]);
    if (leftHash !== rightHash) {
      throw new Error(`重打包改变了 unpacked 文件：${archivePath}`);
    }
  }
}

export async function buildPatchedAsar({
  sourceAsar,
  destinationAsar,
  bundlePath,
  stylePath,
  workingDirectory,
}) {
  const compatibility = inspectAsarCompatibility(sourceAsar);
  const extractedDirectory = path.join(workingDirectory, "extracted");
  await mkdir(workingDirectory, { recursive: true });
  extractAll(sourceAsar, extractedDirectory);

  const indexPath = path.join(extractedDirectory, "webview", "index.html");
  const index = await readFile(indexPath, "utf8");
  await writeFile(indexPath, patchIndexHtml(index), "utf8");
  const assetDirectory = path.join(extractedDirectory, "webview", "assets");
  await Promise.all([
    copyFile(bundlePath, path.join(assetDirectory, "is-codex-run-out.js")),
    copyFile(stylePath, path.join(assetDirectory, "is-codex-run-out.css")),
  ]);

  const unpackGlob = exactUnpackGlob(
    compatibility.unpackedPaths,
    extractedDirectory,
  );
  await createPackageWithOptions(extractedDirectory, destinationAsar, {
    ...(unpackGlob ? { unpack: unpackGlob } : {}),
  });

  const outputUnpacked = unpackedArchivePaths(destinationAsar);
  if (
    JSON.stringify(outputUnpacked) !==
    JSON.stringify(compatibility.unpackedPaths)
  ) {
    throw new Error("重打包后的 unpacked 文件集合与原版不一致");
  }
  const originalUnpackedRoot = `${sourceAsar}.unpacked`;
  const outputUnpackedRoot = `${destinationAsar}.unpacked`;
  await compareUnpackedFiles(
    originalUnpackedRoot,
    outputUnpackedRoot,
    compatibility.unpackedPaths,
  );

  const patchedIndex = extractText(destinationAsar, "webview/index.html");
  if (
    !patchedIndex.includes(INJECTION_START) ||
    !patchedIndex.includes(INJECTION_END)
  ) {
    throw new Error("重打包后未找到注入标记");
  }
  const [builtBundleHash, packedBundleHash, builtStyleHash, packedStyleHash] =
    await Promise.all([
      sha256File(bundlePath),
      Promise.resolve(
        createHash("sha256")
          .update(
            extractFile(
              destinationAsar,
              path.join("webview", "assets", "is-codex-run-out.js"),
            ),
          )
          .digest("hex"),
      ),
      sha256File(stylePath),
      Promise.resolve(
        createHash("sha256")
          .update(
            extractFile(
              destinationAsar,
              path.join("webview", "assets", "is-codex-run-out.css"),
            ),
          )
          .digest("hex"),
      ),
    ]);
  if (
    builtBundleHash !== packedBundleHash ||
    builtStyleHash !== packedStyleHash
  ) {
    throw new Error("注入资源在重打包后校验失败");
  }

  return {
    compatibility,
    patchedAsarHash: await sha256File(destinationAsar),
    outputUnpackedRoot,
  };
}

export async function replaceFile(source, destination) {
  const temporary = `${destination}.isCodexRunOut-${process.pid}.tmp`;
  const previous = `${destination}.isCodexRunOut-${process.pid}.previous`;
  await copyFile(source, temporary);
  if ((await sha256File(source)) !== (await sha256File(temporary))) {
    await rm(temporary, { force: true });
    throw new Error("替换文件的临时副本哈希不匹配");
  }
  await rm(previous, { force: true });
  await rename(destination, previous);
  try {
    await rename(temporary, destination);
    await rm(previous, { force: true });
  } catch (error) {
    if (!(await exists(destination)) && (await exists(previous))) {
      await rename(previous, destination);
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
