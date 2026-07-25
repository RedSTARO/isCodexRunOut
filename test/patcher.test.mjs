import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPackageWithOptions,
  extractFile,
} from "@electron/asar";
import {
  INJECTION_START,
  buildPatchedAsar,
  buildUnpatchedAsar,
  inspectAsarCompatibility,
  patchIndexHtml,
  replaceFile,
  sha256File,
  unpackedArchivePaths,
} from "../scripts/patcher.mjs";

const indexHtml = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39;">
<script type="module" src="./assets/index-test.js"></script>`;

const anchors = [
  "group/application-menu-top-bar",
  "data-app-shell-header-edge-scroll",
  "/wham/usage",
  "fetch-response",
  "X-OpenAI-Attach-Auth",
  "primary_window",
].join("\n");

test("HTML 注入只允许执行一次", () => {
  const patched = patchIndexHtml(indexHtml);
  assert.ok(patched.includes(INJECTION_START));
  assert.ok(
    patched.indexOf(INJECTION_START) <
      patched.indexOf('<script type="module"'),
  );
  assert.throws(() => patchIndexHtml(patched));
});

test("ASAR 重打包保留 unpacked 集合与内容", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "isCodexRunOut-patcher-test-"),
  );
  try {
    const source = path.join(directory, "source");
    await mkdir(path.join(source, "webview", "assets"), { recursive: true });
    await mkdir(path.join(source, "native"), { recursive: true });
    await writeFile(path.join(source, "webview", "index.html"), indexHtml);
    await writeFile(
      path.join(source, "webview", "assets", "index-test.js"),
      "import './app-initial-test.js';",
    );
    await writeFile(
      path.join(source, "webview", "assets", "app-initial-test.js"),
      anchors,
    );
    await writeFile(path.join(source, "native", "fixture.node"), "native");
    const sourceAsar = path.join(directory, "source.asar");
    await createPackageWithOptions(source, sourceAsar, {
      unpack: "*.node",
    });
    const compatibility = inspectAsarCompatibility(sourceAsar);
    assert.equal(compatibility.compatible, true);
    assert.deepEqual(compatibility.unpackedPaths, ["native/fixture.node"]);

    const bundle = path.join(directory, "bundle.js");
    const style = path.join(directory, "style.css");
    await writeFile(bundle, "globalThis.fixture = true;");
    await writeFile(style, ".fixture { display: block; }");
    const destinationAsar = path.join(directory, "patched.asar");
    const result = await buildPatchedAsar({
      sourceAsar,
      destinationAsar,
      bundlePath: bundle,
      stylePath: style,
      workingDirectory: path.join(directory, "work"),
    });
    assert.deepEqual(unpackedArchivePaths(destinationAsar), [
      "native/fixture.node",
    ]);
    assert.equal(
      await sha256File(
        path.join(`${destinationAsar}.unpacked`, "native", "fixture.node"),
      ),
      await sha256File(
        path.join(`${sourceAsar}.unpacked`, "native", "fixture.node"),
      ),
    );
    assert.ok(
      extractFile(
        destinationAsar,
        path.join("webview", "index.html"),
      )
        .toString("utf8")
        .includes(INJECTION_START),
    );
    assert.equal(
      extractFile(
        destinationAsar,
        path.join("webview", "assets", "is-codex-run-out.js"),
      ).toString("utf8"),
      await readFile(bundle, "utf8"),
    );
    assert.equal(result.compatibility.compatible, true);

    assert.throws(() => inspectAsarCompatibility(destinationAsar));
    assert.equal(
      inspectAsarCompatibility(destinationAsar, { allowPatched: true })
        .compatible,
      true,
    );

    const reappliedAsar = path.join(directory, "reapplied.asar");
    await buildPatchedAsar({
      sourceAsar: destinationAsar,
      destinationAsar: reappliedAsar,
      bundlePath: bundle,
      stylePath: style,
      workingDirectory: path.join(directory, "reapply-work"),
    });
    const reappliedIndex = extractFile(
      reappliedAsar,
      path.join("webview", "index.html"),
    ).toString("utf8");
    assert.equal(reappliedIndex.split(INJECTION_START).length - 1, 1);

    const unpatchedAsar = path.join(directory, "unpatched.asar");
    const unpatched = await buildUnpatchedAsar({
      sourceAsar: reappliedAsar,
      destinationAsar: unpatchedAsar,
      workingDirectory: path.join(directory, "uninstall-work"),
    });
    assert.equal(
      extractFile(unpatchedAsar, path.join("webview", "index.html"))
        .toString("utf8")
        .includes(INJECTION_START),
      false,
    );
    assert.equal(unpatched.compatibility.compatible, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("恢复替换先校验临时副本并清理旧文件", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "isCodexRunOut-replace-test-"),
  );
  try {
    const source = path.join(directory, "backup.asar");
    const destination = path.join(directory, "app.asar");
    await writeFile(source, "original");
    await writeFile(destination, "patched");
    await replaceFile(source, destination);
    assert.equal(await readFile(destination, "utf8"), "original");
    assert.deepEqual((await readdir(directory)).sort(), [
      "app.asar",
      "backup.asar",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
