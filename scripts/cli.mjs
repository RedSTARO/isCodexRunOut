import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extractFile } from "@electron/asar";
import {
  INJECTION_START,
  buildPatchedAsar,
  buildUnpatchedAsar,
  exists,
  inspectAsarCompatibility,
  sha256File,
} from "./patcher.mjs";

const root = path.resolve(import.meta.dirname, "..");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA 未定义");
const patchHome = path.join(localAppData, "isCodexRunOut");
const temporaryDirectory = path.join(patchHome, ".tmp");
const directStatePath = path.join(patchHome, "direct-state.json");
const legacyStatePath = path.join(patchHome, "state.json");
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
  const appRoot = path.join(appPackage.InstallLocation, "app");
  return {
    appRoot,
    executable: path.join(appRoot, "ChatGPT.exe"),
    asar: path.join(appRoot, "resources", "app.asar"),
  };
}

async function readDirectState() {
  if (!(await exists(directStatePath))) return null;
  const state = JSON.parse(await readFile(directStatePath, "utf8"));
  if (!state || state.schema !== 1 || state.mode !== "direct") {
    throw new Error("原位补丁状态文件版本不兼容");
  }
  return state;
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

async function baseInspection() {
  const appPackage = detectCodexPackage();
  const source = sourcePaths(appPackage);
  if (!(await exists(source.executable)) || !(await exists(source.asar))) {
    throw new Error("当前 Codex AppX 缺少可执行文件或 app.asar");
  }
  const asarHash = await sha256File(source.asar);
  const compatibility = inspectAsarCompatibility(source.asar, {
    allowPatched: true,
  });
  const injectionPresent = hasInjection(source.asar);
  return {
    appPackage,
    source,
    asarHash,
    injectionPresent,
    compatibility,
    sourceCompatibility:
      knownSourceHashes.get(asarHash) ??
      (injectionPresent ? "direct-patched-structural-compatible" : "structural-compatible"),
  };
}

function publicInspection(inspection) {
  return {
    packageName: inspection.appPackage.Name,
    packageFullName: inspection.appPackage.PackageFullName,
    appxVersion: inspection.appPackage.Version,
    installSource: inspection.appPackage.SignatureKind,
    installLocation: inspection.appPackage.InstallLocation,
    executable: inspection.source.executable,
    asar: inspection.source.asar,
    asarSha256: inspection.asarHash,
    directPatchInstalled: inspection.injectionPresent,
    compatibility: inspection.sourceCompatibility,
    titlebarAnchor:
      inspection.compatibility.anchors["group/application-menu-top-bar"],
    usageEndpointAnchor: inspection.compatibility.anchors["/wham/usage"],
    unpackedFileCount: inspection.compatibility.unpackedPaths.length,
    backupCreated: false,
    byteExactRestoreAvailable: false,
  };
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
  };
  if (!(await exists(outputs.bundle)) || !(await exists(outputs.style))) {
    throw new Error("补丁构建产物不存在");
  }
  return outputs;
}

async function assertDirectWriteAccess(asarPath) {
  try {
    const handle = await open(asarPath, "r+");
    await handle.close();
  } catch {
    throw new Error(
      "WindowsApps app.asar 不可写；请使用仓库根目录 patch.cmd 或 uninstall.cmd 并批准 UAC",
    );
  }
}

async function removeLegacyCopyAndBackup() {
  const targets = [
    path.join(patchHome, "versions"),
    path.join(patchHome, "backups"),
    legacyStatePath,
  ];
  for (const target of targets) {
    const relative = path.relative(patchHome, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`拒绝清理补丁目录外路径：${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

async function overwriteWithoutBackup(source, destination, expectedHash) {
  if ((await sha256File(source)) !== expectedHash) {
    throw new Error("待写入 ASAR 的哈希在覆盖前发生变化");
  }
  await copyFile(source, destination);
  const writtenHash = await sha256File(destination);
  if (writtenHash !== expectedHash) {
    throw new Error("原位覆盖后的 ASAR 哈希校验失败；此模式没有备份可自动恢复");
  }
}

async function commandInspect() {
  console.log(JSON.stringify(publicInspection(await baseInspection()), null, 2));
}

async function commandDirectInstall() {
  const inspection = await baseInspection();
  await assertDirectWriteAccess(inspection.source.asar);
  const outputs = await runBuild();
  const expectedBundleHash = await sha256File(outputs.bundle);
  const expectedStyleHash = await sha256File(outputs.style);
  if (
    inspection.injectionPresent &&
    archiveFileHash(
      inspection.source.asar,
      "webview/assets/is-codex-run-out.js",
    ) === expectedBundleHash &&
    archiveFileHash(
      inspection.source.asar,
      "webview/assets/is-codex-run-out.css",
    ) === expectedStyleHash
  ) {
    await removeLegacyCopyAndBackup();
    console.log("当前 AppX 已安装同一补丁；未改写 app.asar，旧副本和备份已清理。");
    return;
  }

  const previousState = await readDirectState();
  const workingDirectory = path.join(
    temporaryDirectory,
    `direct-install-${randomUUID()}`,
  );
  const stagedAsar = path.join(workingDirectory, "app.asar");
  await mkdir(workingDirectory, { recursive: true });
  try {
    const result = await buildPatchedAsar({
      sourceAsar: inspection.source.asar,
      destinationAsar: stagedAsar,
      bundlePath: outputs.bundle,
      stylePath: outputs.style,
      workingDirectory: path.join(workingDirectory, "work"),
    });
    await rm(result.outputUnpackedRoot, { recursive: true, force: true });
    if ((await sha256File(inspection.source.asar)) !== inspection.asarHash) {
      throw new Error("构建期间当前 AppX app.asar 发生变化");
    }
    await overwriteWithoutBackup(
      stagedAsar,
      inspection.source.asar,
      result.patchedAsarHash,
    );
    const state = {
      schema: 1,
      mode: "direct",
      patchVersion: "0.1.0",
      installedAt: new Date().toISOString(),
      packageFullName: inspection.appPackage.PackageFullName,
      appxVersion: inspection.appPackage.Version,
      installLocation: inspection.appPackage.InstallLocation,
      asarPath: inspection.source.asar,
      originalSourceHash:
        previousState?.originalSourceHash ??
        (inspection.injectionPresent ? null : inspection.asarHash),
      patchedAsarHash: result.patchedAsarHash,
      bundleHash: expectedBundleHash,
      styleHash: expectedStyleHash,
      backupCreated: false,
      byteExactRestoreAvailable: false,
    };
    await writeJsonAtomic(directStatePath, state);
    await removeLegacyCopyAndBackup();
    console.log("已直接修改当前 AppX app.asar；未创建备份。");
    console.log(JSON.stringify(await statusDetails(), null, 2));
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function commandDirectUninstall() {
  const inspection = await baseInspection();
  await assertDirectWriteAccess(inspection.source.asar);
  if (!inspection.injectionPresent) {
    await rm(directStatePath, { force: true });
    await removeLegacyCopyAndBackup();
    console.log("当前 AppX 没有补丁注入；未改写 app.asar。");
    return;
  }
  const workingDirectory = path.join(
    temporaryDirectory,
    `direct-uninstall-${randomUUID()}`,
  );
  const stagedAsar = path.join(workingDirectory, "app.asar");
  await mkdir(workingDirectory, { recursive: true });
  try {
    const result = await buildUnpatchedAsar({
      sourceAsar: inspection.source.asar,
      destinationAsar: stagedAsar,
      workingDirectory: path.join(workingDirectory, "work"),
    });
    await rm(result.outputUnpackedRoot, { recursive: true, force: true });
    if ((await sha256File(inspection.source.asar)) !== inspection.asarHash) {
      throw new Error("卸载构建期间当前 AppX app.asar 发生变化");
    }
    await overwriteWithoutBackup(
      stagedAsar,
      inspection.source.asar,
      result.unpatchedAsarHash,
    );
    await rm(directStatePath, { force: true });
    await removeLegacyCopyAndBackup();
    console.log(
      "补丁资源已从当前 AppX 移除；未恢复微软原始字节级哈希，也没有备份可恢复。",
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function statusDetails() {
  const inspection = await baseInspection();
  const state = await readDirectState();
  return {
    installed: inspection.injectionPresent,
    mode: "direct-no-backup",
    patchVersion: state?.patchVersion ?? null,
    appxVersion: inspection.appPackage.Version,
    packageFullName: inspection.appPackage.PackageFullName,
    installLocation: inspection.appPackage.InstallLocation,
    asarPath: inspection.source.asar,
    currentAsarHash: inspection.asarHash,
    expectedPatchedAsarHash: state?.patchedAsarHash ?? null,
    stateMatches:
      inspection.injectionPresent &&
      state?.packageFullName === inspection.appPackage.PackageFullName &&
      state?.patchedAsarHash === inspection.asarHash,
    injectionPresent: inspection.injectionPresent,
    backupCreated: false,
    byteExactRestoreAvailable: false,
    titlebarLayout: "normal-flow flex child, right aligned",
    dragModel: "slot=drag, widget=no-drag",
    warning:
      "AppX 已被原位修改；卸载只能去掉注入，微软原始哈希需通过商店修复或重装恢复。",
  };
}

async function commandStatus() {
  console.log(JSON.stringify(await statusDetails(), null, 2));
}

function runningCodexProcesses() {
  const output = runPowerShell(
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ExecutablePath = $_.ExecutablePath } }) | ConvertTo-Json -Compress",
  );
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function commandLaunch() {
  const inspection = await baseInspection();
  if (!inspection.injectionPresent) {
    throw new Error("当前 AppX 尚未安装补丁");
  }
  if (runningCodexProcesses().length > 0) {
    throw new Error("Codex 正在运行；请先退出后再启动");
  }
  const child = spawn(inspection.source.executable, [], {
    cwd: inspection.source.appRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`已启动原位补丁 AppX：${inspection.source.executable}`);
}

async function commandRestoreUnsupported() {
  throw new Error(
    "原位无备份模式不支持字节级恢复；可运行 uninstall.cmd 移除注入，或用微软商店修复/重装恢复原包",
  );
}

const commands = {
  inspect: commandInspect,
  "direct-install": commandDirectInstall,
  "direct-uninstall": commandDirectUninstall,
  status: commandStatus,
  launch: commandLaunch,
  restore: commandRestoreUnsupported,
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
