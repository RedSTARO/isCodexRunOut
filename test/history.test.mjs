import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryStore,
  historyStorageKeys,
} from "../src/core/history.mjs";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("历史只保存额度采样并去重", () => {
  const storage = new MemoryStorage();
  const history = new HistoryStore(storage);
  const snapshot = {
    receivedAt: 100,
    source: "test",
    windows: [
      {
        id: "codex:primary",
        usedPercent: 40,
        remainingPercent: 60,
        resetsAt: 1_000,
      },
    ],
  };
  history.record(snapshot, { now: 100, retentionDays: 30 });
  history.record(snapshot, { now: 100, retentionDays: 30 });
  assert.equal(history.samplesFor("codex:primary").length, 1);
  assert.deepEqual(
    Object.keys(history.samplesFor("codex:primary")[0]).sort(),
    [
      "requestStatus",
      "remainingPercent",
      "resetsAt",
      "source",
      "t",
      "usedPercent",
      "valid",
      "windowId",
    ].sort(),
  );
});

test("损坏历史被隔离且不影响启动", () => {
  const storage = new MemoryStorage();
  storage.setItem(historyStorageKeys.current, "{broken");
  const history = new HistoryStore(storage);
  assert.deepEqual(history.load(), { version: 1, windows: {} });
  assert.equal(storage.getItem(historyStorageKeys.current), null);
  assert.ok(
    [...storage.values.keys()].some((key) =>
      key.startsWith(historyStorageKeys.corruptPrefix),
    ),
  );
});
