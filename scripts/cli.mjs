import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";
import {
  INJECTION_START,
  buildPatchedAsar,
  exists,
  inspectAsarCompatibility,
  replaceFile,
  sha256File,
} from "./patcher.mjs";

const root = path.resolve(import.meta.dirname, "..");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA 未定义");
const patchHome = path.join(localAppData, "isCodexRunOut");
const backupRoot = path.join(patchHome, "codex_backup");
const activeRoot = path.join(patchHome, "codex");
const backupAsar = path.join(backupRoot, "app", "resources", "app.asar");
const activeAsar = path.join(activeRoot, "app", "resources", "app.asar");
const activeExecutable = path.join(activeRoot, "app", "ChatGPT.exe");
const activeDeviceKeyHelper = path.join(
  activeRoot,
  "app",
  "resources",
  "native",
  "rc-device-key.cjs",
);
const temporaryDirectory = path.join(patchHome, ".tmp");
const copyStatePath = path.join(patchHome, "copy-state.json");
const redirectStatePath = path.join(patchHome, "redirect-state.json");
const knownSourceHashes = new Map([
  [
    "44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7",
    "OpenAI.Codex 26.721.4979.0 / app 26.721.41059",
  ],
]);

function runPowerShell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    },
  ).trim();
}

function detectCodexPackage() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$pkg = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1",
    "if ($null -eq $pkg) { throw 'OpenAI.Codex AppX package not found' }",
    "[pscustomobject]@{",
    "Name = $pkg.Name",
    "PackageFullName = $pkg.PackageFullName",
    "PackageFamilyName = $pkg.PackageFamilyName",
    "Version = $pkg.Version.ToString()",
    "InstallLocation = $pkg.InstallLocation",
    "SignatureKind = $pkg.SignatureKind.ToString()",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  return JSON.parse(runPowerShell(script));
}

function sourcePaths(appPackage) {
  return {
    executable: path.join(appPackage.InstallLocation, "app", "ChatGPT.exe"),
    asar: path.join(
      appPackage.InstallLocation,
      "app",
      "resources",
      "app.asar",
    ),
  };
}

function ensureExactLayoutPath(actual, expected) {
  if (path.resolve(actual).toLowerCase() !== path.resolve(expected).toLowerCase()) {
    throw new Error(`布局路径不匹配：${actual}`);
  }
}

async function readJson(filePath) {
  if (!(await exists(filePath))) return null;
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function archiveFileHash(asarPath, archivePath) {
  try {
    return createHash("sha256")
      .update(extractFile(asarPath, path.join(...archivePath.split("/"))))
      .digest("hex");
  } catch {
    return null;
  }
}

function hasInjection(asarPath) {
  try {
    return extractFile(asarPath, path.join("webview", "index.html"))
      .toString("utf8")
      .includes(INJECTION_START);
  } catch {
    return false;
  }
}

async function runBuild() {
  execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const outputs = {
    bundle: path.join(root, "dist", "is-codex-run-out.js"),
    style: path.join(root, "dist", "is-codex-run-out.css"),
    deviceKeyHelper: path.join(root, "dist", "rc-device-key.cjs"),
  };
  if (
    !(await exists(outputs.bundle)) ||
    !(await exists(outputs.style)) ||
    !(await exists(outputs.deviceKeyHelper))
  ) {
    throw new Error("补丁构建产物不存在");
  }
  return outputs;
}

async function commandInspect() {
  const appPackage = detectCodexPackage();
  const source = sourcePaths(appPackage);
  const compatibility = inspectAsarCompatibility(source.asar, {
    allowPatched: true,
  });
  const asarHash = await sha256File(source.asar);
  console.log(
    JSON.stringify(
      {
        packageName: appPackage.Name,
        packageFullName: appPackage.PackageFullName,
        appxVersion: appPackage.Version,
        installSource: appPackage.SignatureKind,
        installLocation: appPackage.InstallLocation,
        asar: source.asar,
        asarSha256: asarHash,
        compatibility:
          knownSourceHashes.get(asarHash) ?? "structural-compatible",
        titlebarAnchor:
          compatibility.anchors["group/application-menu-top-bar"],
        usageEndpointAnchor: compatibility.anchors["/wham/usage"],
      },
      null,
      2,
    ),
  );
}

async function commandCopyPatch() {
  ensureExactLayoutPath(process.argv[3] ?? backupRoot, backupRoot);
  ensureExactLayoutPath(process.argv[4] ?? activeRoot, activeRoot);
  for (const filePath of [backupAsar, activeAsar, activeExecutable]) {
    if (!(await exists(filePath))) {
      throw new Error(`副本文件不存在：${filePath}`);
    }
  }

  const appPackage = detectCodexPackage();
  const source = sourcePaths(appPackage);
  const sourceHash = await sha256File(source.asar);
  const backupHash = await sha256File(backupAsar);
  const activeOriginalHash = await sha256File(activeAsar);
  if (sourceHash !== backupHash || sourceHash !== activeOriginalHash) {
    throw new Error("codex_backup、codex 活动副本与 Store 源 ASAR 哈希不一致");
  }
  const compatibility = inspectAsarCompatibility(backupAsar);
  const outputs = await runBuild();
  const bundleHash = await sha256File(outputs.bundle);
  const styleHash = await sha256File(outputs.style);
  const deviceKeyHelperHash = await sha256File(outputs.deviceKeyHelper);
  const workingDirectory = path.join(
    temporaryDirectory,
    `copy-install-${randomUUID()}`,
  );
  const stagedAsar = path.join(workingDirectory, "app.asar");
  await mkdir(workingDirectory, { recursive: true });
  try {
    const result = await buildPatchedAsar({
      sourceAsar: backupAsar,
      destinationAsar: stagedAsar,
      bundlePath: outputs.bundle,
      stylePath: outputs.style,
      workingDirectory: path.join(workingDirectory, "work"),
    });
    await rm(result.outputUnpackedRoot, { recursive: true, force: true });
    if ((await sha256File(backupAsar)) !== backupHash) {
      throw new Error("构建期间 codex_backup ASAR 发生变化");
    }
    await copyFile(stagedAsar, activeAsar);
    if ((await sha256File(activeAsar)) !== result.patchedAsarHash) {
      throw new Error("活动副本 ASAR 覆盖后哈希校验失败");
    }
    await mkdir(path.dirname(activeDeviceKeyHelper), { recursive: true });
    await copyFile(outputs.deviceKeyHelper, activeDeviceKeyHelper);
    if (
      (await sha256File(activeDeviceKeyHelper)) !== deviceKeyHelperHash
    ) {
      throw new Error("Windows device-key helper 覆盖后哈希校验失败");
    }
    if (
      !hasInjection(activeAsar) ||
      archiveFileHash(activeAsar, "webview/assets/is-codex-run-out.js") !==
        bundleHash ||
      archiveFileHash(activeAsar, "webview/assets/is-codex-run-out.css") !==
        styleHash
    ) {
      throw new Error("活动副本中的注入资源校验失败");
    }
    await writeJsonAtomic(copyStatePath, {
      schema: 1,
      mode: "copy-redirect",
      status: "installed",
      patchVersion: "0.2.0",
      installedAt: new Date().toISOString(),
      packageFullName: appPackage.PackageFullName,
      packageFamilyName: appPackage.PackageFamilyName,
      appxVersion: appPackage.Version,
      sourceRoot: appPackage.InstallLocation,
      sourceAsar: source.asar,
      sourceAsarHash: sourceHash,
      backupRoot,
      backupAsar,
      activeRoot,
      activeAsar,
      activeExecutable,
      patchedAsarHash: result.patchedAsarHash,
      bundleHash,
      styleHash,
      deviceKeyHelperPath: activeDeviceKeyHelper,
      deviceKeyHelperHash,
      remoteControl: result.remoteControl,
      titlebarAnchor:
        compatibility.anchors["group/application-menu-top-bar"],
      usageEndpointAnchor: compatibility.anchors["/wham/usage"],
    });
    console.log("活动副本已覆盖为最新补丁，Store 源目录未修改。");
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function statusDetails() {
  const state = await readJson(copyStatePath);
  const appPackage = detectCodexPackage();
  const source = sourcePaths(appPackage);
  const sourceHash = (await exists(source.asar))
    ? await sha256File(source.asar)
    : null;
  if (!state || state.schema !== 1 || state.mode !== "copy-redirect") {
    return {
      installed: false,
      mode: "copy-redirect",
      appxVersion: appPackage.Version,
      sourceAsar: source.asar,
      sourceAsarHash: sourceHash,
    };
  }
  const activeHash = (await exists(state.activeAsar))
    ? await sha256File(state.activeAsar)
    : null;
  const backupHash = (await exists(state.backupAsar))
    ? await sha256File(state.backupAsar)
    : null;
  const redirects = await readJson(redirectStatePath);
  const deviceKeyHelperHash = (
    state.deviceKeyHelperPath &&
    (await exists(state.deviceKeyHelperPath))
  )
    ? await sha256File(state.deviceKeyHelperPath)
    : null;
  const remoteControlEnabled =
    activeHash != null &&
    activeHash === state.patchedAsarHash &&
    deviceKeyHelperHash != null &&
    deviceKeyHelperHash === state.deviceKeyHelperHash;
  return {
    installed:
      state.status === "installed" &&
      activeHash === state.patchedAsarHash &&
      hasInjection(state.activeAsar) &&
      remoteControlEnabled,
    mode: state.mode,
    patchVersion: state.patchVersion,
    appxVersion: state.appxVersion,
    currentAppxVersion: appPackage.Version,
    sourceUntouched: sourceHash === state.sourceAsarHash,
    backupValid: backupHash === state.sourceAsarHash,
    backupRoot: state.backupRoot,
    activeRoot: state.activeRoot,
    activeExecutable: state.activeExecutable,
    activeAsarHash: activeHash,
    expectedPatchedAsarHash: state.patchedAsarHash,
    injectionPresent: activeHash ? hasInjection(state.activeAsar) : false,
    remoteControlEnabled,
    deviceKeyHelperPath: state.deviceKeyHelperPath ?? null,
    shortcutsRedirected: Boolean(redirects?.shortcuts?.length),
    environmentRedirected: Boolean(redirects?.environment),
    titlebarLayout: "adaptive normal-flow flex child, right aligned",
    etaModel: "cycle-linear",
  };
}

async function commandStatus() {
  console.log(JSON.stringify(await statusDetails(), null, 2));
}

async function commandLaunch() {
  const state = await readJson(copyStatePath);
  const status = await statusDetails();
  if (!state || !status.installed) {
    throw new Error("补丁活动副本未安装或校验失败");
  }
  const child = spawn(state.activeExecutable, [], {
    cwd: path.dirname(state.activeExecutable),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`已启动补丁副本：${state.activeExecutable}`);
}

async function commandRestore() {
  const state = await readJson(copyStatePath);
  if (!state) throw new Error("补丁状态不存在");
  if ((await sha256File(state.backupAsar)) !== state.sourceAsarHash) {
    throw new Error("codex_backup ASAR 哈希不匹配");
  }
  await replaceFile(state.backupAsar, state.activeAsar);
  if ((await sha256File(state.activeAsar)) !== state.sourceAsarHash) {
    throw new Error("活动副本恢复校验失败");
  }
  if (state.deviceKeyHelperPath) {
    await rm(state.deviceKeyHelperPath, { force: true });
  }
  state.status = "restored";
  state.restoredAt = new Date().toISOString();
  await writeJsonAtomic(copyStatePath, state);
  console.log("活动副本已从 codex_backup 恢复为原始 ASAR。");
}

async function commandForget() {
  await rm(copyStatePath, { force: true });
}

const commands = {
  inspect: commandInspect,
  "copy-patch": commandCopyPatch,
  status: commandStatus,
  launch: commandLaunch,
  restore: commandRestore,
  forget: commandForget,
};

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!commands[command]) {
    throw new Error(
      `未知命令：${command ?? "(空)"}；可用命令：${Object.keys(commands).join(", ")}`,
    );
  }
  await commands[command]();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`isCodexRunOut: ${error.message}`);
    process.exitCode = 1;
  });
}
