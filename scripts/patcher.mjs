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

export const INJECTION_START = "<!-- isCodexRunOut:start v0.2.0 -->";
export const INJECTION_END = "<!-- isCodexRunOut:end -->";
export const REMOTE_CONTROL_GATE_ID = "782640499";
export const REMOTE_CONTROL_HELPER_NAME = "rc-device-key.cjs";

const REMOTE_CONTROL_REQUIRED_TOKEN = "showControlOtherDevices";
const DEVICE_KEY_MACOS_ERROR =
  "Remote control device keys are only available on macOS";

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

export function stripInjection(source) {
  const pattern =
    /<!-- isCodexRunOut:start v[^>]+ -->[\s\S]*?<!-- isCodexRunOut:end -->\s*/g;
  return source.replace(pattern, "");
}

function occurrences(source, token) {
  return source.split(token).length - 1;
}

export function patchRemoteControlVisibility(input) {
  const original = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const source = original.toString("latin1");
  if (occurrences(source, REMOTE_CONTROL_GATE_ID) !== 1) {
    throw new Error(
      `远程控制 gate ${REMOTE_CONTROL_GATE_ID} 数量不是 1`,
    );
  }
  const gatePattern = new RegExp(
    "(?<gate>[A-Za-z_$][A-Za-z0-9_$]*)=" +
      "[A-Za-z_$][A-Za-z0-9_$]*\\(`" +
      REMOTE_CONTROL_GATE_ID +
      "`\\)",
    "gu",
  );
  const gateMatches = [...source.matchAll(gatePattern)];
  if (gateMatches.length !== 1) {
    throw new Error("无法唯一定位远程控制 gate 绑定");
  }
  const gateMatch = gateMatches[0];
  const gateAlias = gateMatch.groups.gate;
  const windowStart = gateMatch.index + gateMatch[0].length;
  const requiredAt = source.indexOf(
    REMOTE_CONTROL_REQUIRED_TOKEN,
    windowStart,
  );
  if (requiredAt < 0 || requiredAt - windowStart > 12_000) {
    throw new Error("远程控制 gate 未关联 showControlOtherDevices");
  }
  const windowEnd =
    requiredAt + REMOTE_CONTROL_REQUIRED_TOKEN.length;
  const window = source.slice(windowStart, windowEnd);
  const already = [
    ...window.matchAll(
      /(?<visible>[A-Za-z_$][A-Za-z0-9_$]*)=!0\s*(?=,)/gu,
    ),
  ];
  if (already.length === 1) {
    return {
      buffer: original,
      metadata: {
        status: "already-patched",
        visibilityAlias: already[0].groups.visible,
      },
    };
  }
  const derivedPattern = new RegExp(
    "(?<visible>[A-Za-z_$][A-Za-z0-9_$]*)=" +
      `(?<expression>!${gateAlias})(?=,)`,
    "gu",
  );
  const derived = [...window.matchAll(derivedPattern)];
  if (derived.length !== 1) {
    throw new Error(
      `远程控制可见性表达式数量不是 1：${derived.length}`,
    );
  }
  const match = derived[0];
  const expression = match.groups.expression;
  const expressionStart =
    windowStart + match.index + match[0].indexOf(expression);
  const replacement = `!0${" ".repeat(expression.length - 2)}`;
  const patched =
    source.slice(0, expressionStart) +
    replacement +
    source.slice(expressionStart + expression.length);
  const buffer = Buffer.from(patched, "latin1");
  if (buffer.length !== original.length) {
    throw new Error("远程控制可见性补丁改变了 bundle 长度");
  }
  return {
    buffer,
    metadata: {
      status: "patched",
      gateAlias,
      visibilityAlias: match.groups.visible,
      offset: expressionStart,
    },
  };
}

export function patchWindowsDeviceKeyClient(input) {
  const original = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const source = original.toString("latin1");
  const errorCount = occurrences(source, DEVICE_KEY_MACOS_ERROR);
  if (errorCount === 0) {
    if (occurrences(source, REMOTE_CONTROL_HELPER_NAME) === 1) {
      return {
        buffer: original,
        metadata: { status: "already-patched", shape: "class" },
      };
    }
    throw new Error("未找到 Windows device-key 的 macOS 平台限制");
  }
  if (errorCount !== 1) {
    throw new Error(`device-key macOS 限制数量不是 1：${errorCount}`);
  }

  const errorAt = source.indexOf(DEVICE_KEY_MACOS_ERROR);
  const methodAt = source.lastIndexOf(
    "getAddon(){",
    errorAt,
  );
  if (methodAt < 0) {
    throw new Error("无法定位 device-key getAddon 方法");
  }
  const methodWindow = source.slice(
    methodAt,
    Math.min(source.length, errorAt + 1_600),
  );
  const escapedError = DEVICE_KEY_MACOS_ERROR.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const methodPattern = new RegExp(
    "getAddon\\(\\)\\{if\\(process\\.platform!==`darwin`\\)" +
      `throw Error\\(\`${escapedError}\`\\);` +
      "(?<body>.*?this\\.addon)\\}",
    "gsu",
  );
  const methodMatches = [...methodWindow.matchAll(methodPattern)];
  if (methodMatches.length !== 1) {
    throw new Error(
      `device-key getAddon 方法数量不是 1：${methodMatches.length}`,
    );
  }
  const methodMatch = methodMatches[0];
  const body = methodMatch.groups.body;
  const pathMatches = [
    ...body.matchAll(
      /\(0,(?<path>[A-Za-z_$][A-Za-z0-9_$]*)\.join\)\(/gu,
    ),
  ];
  if (pathMatches.length !== 1) {
    throw new Error("无法唯一定位 device-key path.join 绑定");
  }
  const pathAlias = pathMatches[0].groups.path;

  const prefixStart = Math.max(0, methodAt - 1_600);
  const prefix = source.slice(prefixStart, methodAt);
  const requireMatches = [
    ...prefix.matchAll(
      /var (?<require>[A-Za-z_$][A-Za-z0-9_$]*)=\(0,[A-Za-z_$][A-Za-z0-9_$]*\.createRequire\)\(__filename\)/gu,
    ),
  ].filter((match) => {
    const after = prefix.slice(
      match.index + match[0].length,
      match.index + match[0].length + 500,
    );
    return after.includes("remote-control-device-key.node");
  });
  if (requireMatches.length !== 1) {
    throw new Error("无法唯一定位 device-key createRequire 绑定");
  }
  const requireAlias = requireMatches[0].groups.require;
  const stub =
    "getAddon(){if(this.resourcesPath==null)throw Error(" +
    "`Remote control device keys require resourcesPath`);" +
    `return this.addon??=${requireAlias}((0,${pathAlias}.join)(` +
    "this.resourcesPath,`native`," +
    `\`${REMOTE_CONTROL_HELPER_NAME}\`)),this.addon}`;
  if (stub.length > methodMatch[0].length) {
    throw new Error(
      `device-key stub 超出字节预算：${stub.length}/${methodMatch[0].length}`,
    );
  }
  const methodStart = methodAt + methodMatch.index;
  const replacement =
    stub + " ".repeat(methodMatch[0].length - stub.length);
  const patched =
    source.slice(0, methodStart) +
    replacement +
    source.slice(methodStart + methodMatch[0].length);
  const buffer = Buffer.from(patched, "latin1");
  if (
    buffer.length !== original.length ||
    buffer.includes(Buffer.from(DEVICE_KEY_MACOS_ERROR)) ||
    occurrences(buffer.toString("latin1"), REMOTE_CONTROL_HELPER_NAME) !== 1
  ) {
    throw new Error("device-key bundle 补丁校验失败");
  }
  return {
    buffer,
    metadata: {
      status: "patched",
      shape: "class",
      offset: methodStart,
      originalBytes: methodMatch[0].length,
      stubBytes: stub.length,
    },
  };
}

function extractText(asarPath, archivePath) {
  return extractFile(
    asarPath,
    path.join(...archivePath.split("/")),
  ).toString("utf8");
}

export function inspectAsarCompatibility(
  asarPath,
  { allowPatched = false } = {},
) {
  const { header } = getRawHeader(asarPath);
  const files = listArchiveFiles(header);
  const fileNames = new Set(files.map((entry) => entry.path));
  const indexPath = "webview/index.html";
  if (!fileNames.has(indexPath)) {
    throw new Error("ASAR 中不存在 webview/index.html");
  }
  const index = extractText(asarPath, indexPath);
  if (!allowPatched && index.includes(INJECTION_START)) {
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

  const remoteUiBodies = files
    .map((entry) => entry.path)
    .filter((archivePath) =>
      /^webview\/assets\/[^/]+\.js$/u.test(archivePath),
    )
    .map((archivePath) => ({
      archivePath,
      source: extractText(asarPath, archivePath),
    }));
  const remoteUiMatches = remoteUiBodies.filter(
    ({ source }) =>
      source.includes(REMOTE_CONTROL_GATE_ID) &&
      source.includes(REMOTE_CONTROL_REQUIRED_TOKEN),
  );
  if (remoteUiMatches.length !== 1) {
    throw new Error(
      `远程控制 UI bundle 数量不是 1：${remoteUiMatches.length}`,
    );
  }
  const mainBodies = files
    .map((entry) => entry.path)
    .filter((archivePath) =>
      /^\.vite\/build\/[^/]+\.js$/u.test(archivePath),
    )
    .map((archivePath) => ({
      archivePath,
      source: extractText(asarPath, archivePath),
    }));
  const deviceKeyMatches = mainBodies.filter(
    ({ source }) =>
      source.includes(DEVICE_KEY_MACOS_ERROR) ||
      source.includes(REMOTE_CONTROL_HELPER_NAME),
  );
  if (deviceKeyMatches.length !== 1) {
    throw new Error(
      `device-key 主进程 bundle 数量不是 1：${deviceKeyMatches.length}`,
    );
  }
  return {
    compatible: true,
    indexPath,
    candidates,
    anchors,
    remoteControl: {
      uiBundle: remoteUiMatches[0].archivePath,
      mainBundle: deviceKeyMatches[0].archivePath,
      helperName: REMOTE_CONTROL_HELPER_NAME,
    },
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
  const compatibility = inspectAsarCompatibility(sourceAsar, {
    allowPatched: true,
  });
  const extractedDirectory = path.join(workingDirectory, "extracted");
  await mkdir(workingDirectory, { recursive: true });
  extractAll(sourceAsar, extractedDirectory);

  const indexPath = path.join(extractedDirectory, "webview", "index.html");
  const index = stripInjection(await readFile(indexPath, "utf8"));
  await writeFile(indexPath, patchIndexHtml(index), "utf8");
  const assetDirectory = path.join(extractedDirectory, "webview", "assets");
  await Promise.all([
    copyFile(bundlePath, path.join(assetDirectory, "is-codex-run-out.js")),
    copyFile(stylePath, path.join(assetDirectory, "is-codex-run-out.css")),
  ]);

  const remoteUiPath = path.join(
    extractedDirectory,
    ...compatibility.remoteControl.uiBundle.split("/"),
  );
  const remoteUiPatch = patchRemoteControlVisibility(
    await readFile(remoteUiPath),
  );
  await writeFile(remoteUiPath, remoteUiPatch.buffer);
  const deviceKeyBundlePath = path.join(
    extractedDirectory,
    ...compatibility.remoteControl.mainBundle.split("/"),
  );
  const deviceKeyPatch = patchWindowsDeviceKeyClient(
    await readFile(deviceKeyBundlePath),
  );
  await writeFile(deviceKeyBundlePath, deviceKeyPatch.buffer);

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
    remoteControl: {
      visibility: remoteUiPatch.metadata,
      deviceKey: deviceKeyPatch.metadata,
    },
    patchedAsarHash: await sha256File(destinationAsar),
    outputUnpackedRoot,
  };
}

export async function buildUnpatchedAsar({
  sourceAsar,
  originalAsar,
  destinationAsar,
  workingDirectory,
}) {
  const compatibility = inspectAsarCompatibility(sourceAsar, {
    allowPatched: true,
  });
  const currentIndex = extractText(sourceAsar, "webview/index.html");
  if (!currentIndex.includes(INJECTION_START)) {
    throw new Error("当前 ASAR 没有 isCodexRunOut 注入标记");
  }
  const extractedDirectory = path.join(workingDirectory, "extracted");
  await mkdir(workingDirectory, { recursive: true });
  extractAll(sourceAsar, extractedDirectory);

  const indexPath = path.join(extractedDirectory, "webview", "index.html");
  await writeFile(
    indexPath,
    stripInjection(await readFile(indexPath, "utf8")),
    "utf8",
  );
  const assetDirectory = path.join(extractedDirectory, "webview", "assets");
  await Promise.all([
    rm(path.join(assetDirectory, "is-codex-run-out.js"), { force: true }),
    rm(path.join(assetDirectory, "is-codex-run-out.css"), { force: true }),
  ]);

  if (!originalAsar) {
    throw new Error("完整卸载需要 originalAsar 以恢复远程控制 bundle");
  }
  const originalCompatibility = inspectAsarCompatibility(originalAsar, {
    allowPatched: true,
  });
  for (const key of ["uiBundle", "mainBundle"]) {
    const archivePath = compatibility.remoteControl[key];
    if (archivePath !== originalCompatibility.remoteControl[key]) {
      throw new Error(`原版远程控制 bundle 路径不匹配：${key}`);
    }
    await writeFile(
      path.join(extractedDirectory, ...archivePath.split("/")),
      extractFile(
        originalAsar,
        path.join(...archivePath.split("/")),
      ),
    );
  }

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
    throw new Error("卸载重打包后的 unpacked 文件集合与当前应用不一致");
  }
  for (const key of ["uiBundle", "mainBundle"]) {
    const archivePath = compatibility.remoteControl[key];
    const restoredHash = createHash("sha256")
      .update(
        extractFile(
          destinationAsar,
          path.join(...archivePath.split("/")),
        ),
      )
      .digest("hex");
    const originalHash = createHash("sha256")
      .update(
        extractFile(
          originalAsar,
          path.join(...archivePath.split("/")),
        ),
      )
      .digest("hex");
    if (restoredHash !== originalHash) {
      throw new Error(`远程控制 bundle 恢复校验失败：${key}`);
    }
  }
  await compareUnpackedFiles(
    `${sourceAsar}.unpacked`,
    `${destinationAsar}.unpacked`,
    compatibility.unpackedPaths,
  );

  const { header } = getRawHeader(destinationAsar);
  const files = new Set(listArchiveFiles(header).map((entry) => entry.path));
  if (
    extractText(destinationAsar, "webview/index.html").includes(
      "isCodexRunOut:",
    ) ||
    files.has("webview/assets/is-codex-run-out.js") ||
    files.has("webview/assets/is-codex-run-out.css")
  ) {
    throw new Error("卸载重打包后仍存在补丁资源");
  }
  return {
    compatibility,
    unpatchedAsarHash: await sha256File(destinationAsar),
    outputUnpackedRoot: `${destinationAsar}.unpacked`,
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
