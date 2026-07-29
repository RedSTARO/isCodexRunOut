"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ALGORITHM = "ecdsa_p256_sha256";
const PROTECTION_CLASS = "os_protected_nonextractable";
const KEY_ID_PATTERN = /^dk_osn_[0-9a-f]{32}$/u;
const storePath = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "remote-control-device-keys.windows.json",
);

function transformWithDpapi(operation, input) {
  const command = [
    "Add-Type -AssemblyName System.Security",
    "$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())",
    `$outputBytes=[Security.Cryptography.ProtectedData]::${operation}(` +
      "$inputBytes,$null," +
      "[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($outputBytes))",
  ].join("; ");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      input: input.toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trim();
}

function readStore() {
  let source;
  try {
    source = fs.readFileSync(storePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const store = JSON.parse(source.replace(/^\uFEFF/u, ""));
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new Error("remote-control device-key store is invalid");
  }
  return store;
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(store), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, storePath);
    try {
      fs.chmodSync(storePath, 0o600);
    } catch {
      // DPAPI protects the private key even when chmod has no effect on NTFS.
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function requireEntry(keyId) {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("invalid remote-control device-key id");
  }
  const entry = readStore()[keyId];
  if (
    !entry ||
    entry.algorithm !== ALGORITHM ||
    entry.protectionClass !== PROTECTION_CLASS ||
    typeof entry.publicKeySpkiDerBase64 !== "string" ||
    typeof entry.encryptedPrivateKeyPkcs8DerBase64 !== "string"
  ) {
    throw new Error("remote-control device key was not found or is invalid");
  }
  return entry;
}

function publicView(entry) {
  return {
    algorithm: entry.algorithm,
    keyId: entry.keyId,
    protectionClass: entry.protectionClass,
    publicKeySpkiDerBase64: entry.publicKeySpkiDerBase64,
  };
}

async function createDeviceKey() {
  const keyPair = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const keyId = `dk_osn_${crypto.randomBytes(16).toString("hex")}`;
  const publicEntry = {
    algorithm: ALGORITHM,
    keyId,
    protectionClass: PROTECTION_CLASS,
    publicKeySpkiDerBase64: keyPair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
  const privateKey = keyPair.privateKey.export({
    type: "pkcs8",
    format: "der",
  });
  const store = readStore();
  store[keyId] = {
    ...publicEntry,
    encryptedPrivateKeyPkcs8DerBase64: transformWithDpapi(
      "Protect",
      privateKey,
    ),
  };
  writeStore(store);
  return publicEntry;
}

async function deleteDeviceKey(keyId) {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("invalid remote-control device-key id");
  }
  const store = readStore();
  delete store[keyId];
  writeStore(store);
}

async function getDeviceKeyPublic(keyId) {
  return publicView(requireEntry(keyId));
}

async function signDeviceKey(keyId, payload) {
  const entry = requireEntry(keyId);
  const privateKeyDer = Buffer.from(
    transformWithDpapi(
      "Unprotect",
      Buffer.from(entry.encryptedPrivateKeyPkcs8DerBase64, "base64"),
    ),
    "base64",
  );
  const signature = crypto.sign(
    "sha256",
    Buffer.from(payload),
    {
      key: privateKeyDer,
      format: "der",
      type: "pkcs8",
    },
  );
  return {
    algorithm: ALGORITHM,
    signatureDerBase64: signature.toString("base64"),
  };
}

module.exports = {
  createDeviceKey,
  deleteDeviceKey,
  getDeviceKeyPublic,
  signDeviceKey,
};
