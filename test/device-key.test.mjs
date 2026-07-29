import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const helperPath = path.resolve(
  import.meta.dirname,
  "..",
  "src",
  "native",
  "rc-device-key.cjs",
);

test(
  "Windows device-key 使用 DPAPI 保存并可完成 P-256 签名",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "isCodexRunOut-device-key-"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = directory;
      delete require.cache[require.resolve(helperPath)];
      const helper = require(helperPath);
      const created = await helper.createDeviceKey("hardware_only");
      assert.equal(created.algorithm, "ecdsa_p256_sha256");
      assert.equal(created.protectionClass, "os_protected_nonextractable");
      assert.match(created.keyId, /^dk_osn_[0-9a-f]{32}$/u);

      const payload = Buffer.from("isCodexRunOut device-key test");
      const signed = await helper.signDeviceKey(created.keyId, payload);
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(created.publicKeySpkiDerBase64, "base64"),
        format: "der",
        type: "spki",
      });
      assert.equal(
        crypto.verify(
          "sha256",
          payload,
          publicKey,
          Buffer.from(signed.signatureDerBase64, "base64"),
        ),
        true,
      );
      assert.deepEqual(
        await helper.getDeviceKeyPublic(created.keyId),
        created,
      );

      const storePath = path.join(
        directory,
        "remote-control-device-keys.windows.json",
      );
      const storeSource = await readFile(storePath, "utf8");
      assert.ok(storeSource.includes("encryptedPrivateKeyPkcs8DerBase64"));
      assert.ok(!storeSource.includes("PRIVATE KEY"));

      await helper.deleteDeviceKey(created.keyId);
      assert.deepEqual(
        JSON.parse(await readFile(storePath, "utf8")),
        {},
      );
    } finally {
      if (previousCodexHome == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      delete require.cache[require.resolve(helperPath)];
      await rm(directory, { recursive: true, force: true });
    }
  },
);
