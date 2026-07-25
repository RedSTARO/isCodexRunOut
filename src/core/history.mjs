const HISTORY_KEY = "isCodexRunOut.history.v1";
const CORRUPT_PREFIX = "isCodexRunOut.history.corrupt.";
const MAX_SAMPLES_PER_WINDOW = 5_000;

function emptyHistory() {
  return { version: 1, windows: {} };
}

function validHistory(value) {
  return (
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    value.windows &&
    typeof value.windows === "object" &&
    !Array.isArray(value.windows)
  );
}

export class HistoryStore {
  constructor(storage) {
    this.storage = storage;
  }

  load() {
    const raw = this.storage.getItem(HISTORY_KEY);
    if (!raw) return emptyHistory();
    try {
      const parsed = JSON.parse(raw);
      if (!validHistory(parsed)) throw new Error("unsupported history schema");
      return parsed;
    } catch {
      const quarantineKey = `${CORRUPT_PREFIX}${Date.now()}`;
      try {
        this.storage.setItem(quarantineKey, raw.slice(0, 2_000_000));
      } finally {
        this.storage.removeItem(HISTORY_KEY);
      }
      return emptyHistory();
    }
  }

  save(history) {
    this.storage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  record(snapshot, { retentionDays = 30, now = Date.now() } = {}) {
    const history = this.load();
    const cutoff = now - retentionDays * 86_400_000;
    for (const window of snapshot.windows) {
      const current = Array.isArray(history.windows[window.id])
        ? history.windows[window.id]
        : [];
      const sample = {
        t: snapshot.receivedAt,
        windowId: window.id,
        usedPercent: window.usedPercent,
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAt,
        source: snapshot.source,
        valid: true,
        requestStatus: "success",
      };
      const previous = current.at(-1);
      if (
        !previous ||
        previous.t !== sample.t ||
        previous.usedPercent !== sample.usedPercent ||
        previous.resetsAt !== sample.resetsAt
      ) {
        current.push(sample);
      }
      history.windows[window.id] = current
        .filter((entry) => entry.t >= cutoff)
        .slice(-MAX_SAMPLES_PER_WINDOW);
    }
    for (const [windowId, samples] of Object.entries(history.windows)) {
      const retained = samples.filter((entry) => entry.t >= cutoff);
      if (retained.length === 0) delete history.windows[windowId];
      else history.windows[windowId] = retained.slice(-MAX_SAMPLES_PER_WINDOW);
    }
    this.save(history);
    return history;
  }

  samplesFor(windowId) {
    return this.load().windows[windowId] ?? [];
  }

  clear() {
    this.storage.removeItem(HISTORY_KEY);
  }
}

export const historyStorageKeys = {
  current: HISTORY_KEY,
  corruptPrefix: CORRUPT_PREFIX,
};
