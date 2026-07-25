import { randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFile } from "@electron/asar";
import {
  INJECTION_START,
  buildPatchedAsar,
  exists,
  inspectAsarCompatibility,
  replaceFile,
  sha256File,
} from "./patcher.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA 未定义");
const patchHome = path.join(localAppData, "isCodexRunOut");
const versionsDirectory = path.join(patchHome, "versions");
const backupsDirectory = path.join(patchHome, "backups");
const temporaryDirectory = path.join(patchHome, ".tmp");
const statePath = path.join(patchHome, "state.json");
const knownSourceHashes = new Map([
  [
    "44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7",
    "OpenAI.Codex 26.721.4979.0 / app 26.721.41059",
  ],
]);

function ensureInside(base, target, { allowBase = false } = {}) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (
    (!allowBase && relative === "") ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`拒绝操作补丁目录外路径：${target}`);
  }
}

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
    "Version = $pkg.Version.ToString()",
    "InstallLocation = $pkg.InstallLocation",
    "Publisher = $pkg.Publisher",
    "SignatureKind = $pkg.SignatureKind.ToString()",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  return JSON.parse(runPowerShell(script));
}

async function readState() {
  if (!(await exists(statePath))) return null;
  const parsed = JSON.parse(await readFile(statePath, "utf8"));
  if (!parsed || parsed.schema !== 1) {
    throw new Error("补丁状态文件版本不兼容");
  }
  return parsed;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function sourcePaths(appPackage) {
  const appRoot = path.join(appPackage.InstallLocation, "app");
  return {
    appRoot,
    executable: path.join(appRoot, "ChatGPT.exe"),
    asar: path.join(appRoot, "resources", "app.asar"),
  };
}

async function baseInspection() {
  const appPackage = detectCodexPackage();
  const source = sourcePaths(appPackage);
  for (const [label, filePath] of Object.entries({
    "Codex 可执行文件": source.executable,
    "Codex ASAR": source.asar,
  })) {
    if (!(await exists(filePath))) throw new Error(`${label}不存在：${filePath}`);
  }
  const sourceAsarHash = await sha256File(source.asar);
  const compatibility = inspectAsarCompatibility(source.asar);
  return {
    appPackage,
    source,
    sourceAsarHash,
    sourceCompatibility:
      knownSourceHashes.get(sourceAsarHash) ?? "structural-compatible",
    compatibility,
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
    asarSha256: inspection.sourceAsarHash,
    compatibility: inspection.sourceCompatibility,
    titlebarAnchor:
      inspection.compatibility.anchors["group/application-menu-top-bar"],
    usageEndpointAnchor: inspection.compatibility.anchors["/wham/usage"],
    unpackedFileCount: inspection.compatibility.unpackedPaths.length,
  };
}

async function commandInspect() {
  const inspection = await baseInspection();
  console.log(JSON.stringify(publicInspection(inspection), null, 2));
}

async function runBuild() {
  await execFileAsync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
    cwd: root,
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

async function commandInstall() {
  const inspection = await baseInspection();
  const existingState = await readState();
  if (existingState?.sourceAsarHash === inspection.sourceAsarHash) {
    const targetAsar = path.join(existingState.targetRoot, "resources", "app.asar");
    if (
      (await exists(targetAsar)) &&
      (await sha256File(targetAsar)) === existingState.patchedAsarHash
    ) {
      console.log("补丁已经安装，当前操作未修改任何文件。");
      console.log(JSON.stringify(await statusDetails(existingState), null, 2));
      return;
    }
  }
  if (existingState) {
    throw new Error(
      "检测到另一版本或不完整的补丁状态；请先运行 npm run uninstall:patch，再重新安装",
    );
  }

  const outputs = await runBuild();
  const versionId = `${inspection.appPackage.Version}-${inspection.sourceAsarHash.slice(0, 12)}`;
  const finalVersionRoot = path.join(versionsDirectory, versionId);
  const finalTargetRoot = path.join(finalVersionRoot, "app");
  const stagingRoot = path.join(
    versionsDirectory,
    `.staging-${versionId}-${randomUUID()}`,
  );
  const stagingTargetRoot = path.join(stagingRoot, "app");
  const workRoot = path.join(temporaryDirectory, `install-${randomUUID()}`);
  const backupRoot = path.join(backupsDirectory, versionId);
  const backupAsar = path.join(backupRoot, "app.asar");
  ensureInside(patchHome, stagingRoot);
  ensureInside(patchHome, workRoot);
  ensureInside(patchHome, finalVersionRoot);
  ensureInside(patchHome, backupRoot);

  if (await exists(finalVersionRoot)) {
    throw new Error(`目标版本目录已存在但没有有效状态：${finalVersionRoot}`);
  }
  await mkdir(backupRoot, { recursive: true });
  if (await exists(backupAsar)) {
    if ((await sha256File(backupAsar)) !== inspection.sourceAsarHash) {
      throw new Error("现有原版备份哈希不匹配");
    }
  } else {
    const backupTemporary = `${backupAsar}.${process.pid}.tmp`;
    try {
      await copyFile(inspection.source.asar, backupTemporary);
      if ((await sha256File(backupTemporary)) !== inspection.sourceAsarHash) {
        throw new Error("原版 ASAR 备份校验失败");
      }
      await rename(backupTemporary, backupAsar);
    } finally {
      await rm(backupTemporary, { force: true });
    }
  }

  let finalCreated = false;
  try {
    await mkdir(stagingRoot, { recursive: true });
    await cp(inspection.source.appRoot, stagingTargetRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const stagingAsar = path.join(
      stagingTargetRoot,
      "resources",
      "app.asar",
    );
    if ((await sha256File(stagingAsar)) !== inspection.sourceAsarHash) {
      throw new Error("应用副本中的 ASAR 与源文件不一致");
    }
    const patchedTemporaryAsar = path.join(
      stagingTargetRoot,
      "resources",
      "app.asar.isCodexRunOut",
    );
    const result = await buildPatchedAsar({
      sourceAsar: stagingAsar,
      destinationAsar: patchedTemporaryAsar,
      bundlePath: outputs.bundle,
      stylePath: outputs.style,
      workingDirectory: workRoot,
    });
    await rm(result.outputUnpackedRoot, { recursive: true, force: true });
    await rm(stagingAsar, { force: true });
    await rename(patchedTemporaryAsar, stagingAsar);
    if ((await sha256File(inspection.source.asar)) !== inspection.sourceAsarHash) {
      throw new Error("商店源 ASAR 在安装过程中发生变化");
    }

    await mkdir(versionsDirectory, { recursive: true });
    await rename(stagingRoot, finalVersionRoot);
    finalCreated = true;
    const state = {
      schema: 1,
      patchVersion: "0.1.0",
      status: "installed",
      installedAt: new Date().toISOString(),
      packageFullName: inspection.appPackage.PackageFullName,
      appxVersion: inspection.appPackage.Version,
      installSource: inspection.appPackage.SignatureKind,
      sourceRoot: inspection.source.appRoot,
      sourceAsar: inspection.source.asar,
      sourceAsarHash: inspection.sourceAsarHash,
      sourceCompatibility: inspection.sourceCompatibility,
      targetRoot: finalTargetRoot,
      patchedAsarHash: result.patchedAsarHash,
      backupAsar,
      titlebarAnchor:
        result.compatibility.anchors["group/application-menu-top-bar"],
      usageEndpointAnchor: result.compatibility.anchors["/wham/usage"],
      unpackedFileCount: result.compatibility.unpackedPaths.length,
    };
    await writeJsonAtomic(statePath, state);
    console.log("补丁安装完成。商店原目录未被修改。");
    console.log(JSON.stringify(await statusDetails(state), null, 2));
  } catch (error) {
    if (finalCreated) await rm(finalVersionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (await exists(stagingRoot)) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    if (await exists(workRoot)) {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
}

async function statusDetails(state) {
  const activeState = state === undefined ? await readState() : state;
  const appPackage = detectCodexPackage();
  const currentSource = sourcePaths(appPackage);
  const currentSourceHash = (await exists(currentSource.asar))
    ? await sha256File(currentSource.asar)
    : null;
  if (!activeState) {
    return {
      installed: false,
      appxVersion: appPackage.Version,
      sourceAsar: currentSource.asar,
      sourceAsarHash: currentSourceHash,
    };
  }
  const targetAsar = path.join(activeState.targetRoot, "resources", "app.asar");
  const targetHash = (await exists(targetAsar))
    ? await sha256File(targetAsar)
    : null;
  let injectionPresent = false;
  if (targetHash) {
    try {
      injectionPresent = extractFile(
        targetAsar,
        path.join("webview", "index.html"),
      )
        .toString("utf8")
        .includes(INJECTION_START);
    } catch {
      injectionPresent = false;
    }
  }
  const backupHash = (await exists(activeState.backupAsar))
    ? await sha256File(activeState.backupAsar)
    : null;
  return {
    installed:
      activeState.status === "installed" &&
      targetHash === activeState.patchedAsarHash &&
      injectionPresent,
    state: activeState.status,
    patchVersion: activeState.patchVersion,
    installSource: activeState.installSource,
    sourceRoot: activeState.sourceRoot,
    technology: "Owl/Chromium 150, Electron-compatible ASAR renderer",
    appxVersion: activeState.appxVersion,
    currentAppxVersion: appPackage.Version,
    updateDetected:
      activeState.packageFullName !== appPackage.PackageFullName ||
      activeState.sourceAsarHash !== currentSourceHash,
    sourceUntouched: currentSourceHash === activeState.sourceAsarHash,
    sourceAsarHash: currentSourceHash,
    backupValid: backupHash === activeState.sourceAsarHash,
    targetRoot: activeState.targetRoot,
    targetAsarHash: targetHash,
    expectedPatchedAsarHash: activeState.patchedAsarHash,
    injectionPresent,
    titlebarAnchor: activeState.titlebarAnchor,
    titlebarLayout: "normal-flow flex child",
    dragModel: "slot=drag, widget=no-drag",
    nativeWindowControls: "preserved by existing titlebar safe padding",
    executable: path.join(activeState.targetRoot, "ChatGPT.exe"),
  };
}

async function commandStatus() {
  console.log(JSON.stringify(await statusDetails(), null, 2));
}

function runningCodexProcesses() {
  const script = [
    "$items = Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | ForEach-Object {",
    "  $path = $null",
    "  try { $path = $_.ExecutablePath } catch {}",
    "  [pscustomobject]@{ ProcessId = $_.ProcessId; ExecutablePath = $path }",
    "}",
    "@($items) | ConvertTo-Json -Compress",
  ].join("\n");
  const output = runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function runningTargetProcesses(targetRoot) {
  const normalizedRoot = `${path.resolve(targetRoot).toLowerCase()}${path.sep}`;
  return runningCodexProcesses().filter(
    (entry) =>
      typeof entry.ExecutablePath === "string" &&
      `${path.resolve(entry.ExecutablePath).toLowerCase()}${path.sep}`.startsWith(
        normalizedRoot,
      ),
  );
}

async function commandLaunch() {
  const state = await readState();
  if (!state || state.status !== "installed") {
    throw new Error("补丁尚未安装");
  }
  const status = await statusDetails(state);
  if (!status.installed) {
    throw new Error("补丁文件校验失败，拒绝启动");
  }
  if (status.updateDetected) {
    throw new Error("检测到 Codex 已更新；请先卸载旧补丁并重新安装");
  }
  const executable = path.join(state.targetRoot, "ChatGPT.exe");
  const running = runningCodexProcesses();
  const normalizedTarget = path.resolve(executable).toLowerCase();
  const alreadyRunning = running.find(
    (entry) =>
      typeof entry.ExecutablePath === "string" &&
      path.resolve(entry.ExecutablePath).toLowerCase() === normalizedTarget,
  );
  if (alreadyRunning) {
    console.log(`补丁版 Codex 已在运行（PID ${alreadyRunning.ProcessId}）。`);
    return;
  }
  if (running.length > 0) {
    throw new Error(
      "检测到 Codex Desktop 正在运行。请先正常退出所有 Codex 窗口，再运行 npm run launch",
    );
  }
  const child = spawn(executable, [], {
    cwd: state.targetRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  console.log(`已启动补丁版 Codex：${executable}`);
}

async function commandRestore() {
  const state = await readState();
  if (!state) {
    console.log("没有补丁状态，当前操作未修改任何文件。");
    return;
  }
  const running = runningTargetProcesses(state.targetRoot);
  if (running.length > 0) {
    throw new Error(
      `补丁版 Codex 正在运行（PID ${running.map((entry) => entry.ProcessId).join(", ")}），请先正常退出再恢复`,
    );
  }
  const targetAsar = path.join(state.targetRoot, "resources", "app.asar");
  if (!(await exists(state.backupAsar))) {
    throw new Error("原版 ASAR 备份不存在，拒绝恢复");
  }
  if ((await sha256File(state.backupAsar)) !== state.sourceAsarHash) {
    throw new Error("原版 ASAR 备份哈希不匹配，拒绝恢复");
  }
  if (!(await exists(targetAsar))) {
    throw new Error("补丁副本中的 ASAR 不存在");
  }
  const currentHash = await sha256File(targetAsar);
  if (currentHash === state.sourceAsarHash) {
    if (state.status !== "restored") {
      state.status = "restored";
      state.restoredAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
    }
    console.log("补丁副本已经恢复为原版，当前操作未修改应用文件。");
    return;
  }
  if (currentHash !== state.patchedAsarHash) {
    throw new Error("目标 ASAR 哈希既不是补丁版也不是已记录原版，拒绝覆盖");
  }
  await replaceFile(state.backupAsar, targetAsar);
  if ((await sha256File(targetAsar)) !== state.sourceAsarHash) {
    throw new Error("恢复后的 ASAR 校验失败");
  }
  state.status = "restored";
  state.restoredAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
  console.log("补丁副本已恢复为原版。商店原目录始终未被修改。");
}

async function commandUninstall() {
  const state = await readState();
  if (!state) {
    console.log("补丁未安装，当前操作未修改任何文件。");
    return;
  }
  const running = runningTargetProcesses(state.targetRoot);
  if (running.length > 0) {
    throw new Error(
      `补丁版 Codex 正在运行（PID ${running.map((entry) => entry.ProcessId).join(", ")}），请先正常退出再卸载`,
    );
  }
  if (state.status === "installed") await commandRestore();
  const versionRoot = path.dirname(state.targetRoot);
  const backupRoot = path.dirname(state.backupAsar);
  ensureInside(versionsDirectory, versionRoot);
  ensureInside(backupsDirectory, backupRoot);
  await rm(versionRoot, { recursive: true, force: true });
  await rm(backupRoot, { recursive: true, force: true });
  await rm(statePath, { force: true });
  console.log(
    "补丁副本、补丁状态和原版备份已删除；Codex 用户配置与额度历史未被清理。",
  );
}

const commands = {
  inspect: commandInspect,
  install: commandInstall,
  status: commandStatus,
  launch: commandLaunch,
  restore: commandRestore,
  uninstall: commandUninstall,
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
