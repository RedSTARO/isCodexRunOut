import {
  DEFAULT_CONFIG,
  effectivePollIntervalMs,
  validateConfig,
} from "../core/config.mjs";
import { estimateEta, freshnessState } from "../core/eta.mjs";
import { HistoryStore } from "../core/history.mjs";
import {
  CompatibilityError,
  normalizeUsagePayload,
} from "../core/normalize.mjs";
import { RefreshCoordinator, RefreshError } from "../core/polling.mjs";
import { BridgeUsageClient } from "./bridge-client.mjs";

const CONFIG_KEY = "isCodexRunOut.config.v1";
const SNAPSHOT_KEY = "isCodexRunOut.snapshot.v1";
const CONFIG_CORRUPT_PREFIX = "isCodexRunOut.config.corrupt.";
const CHANNEL_NAME = "isCodexRunOut.runtime.v1";
const LEADER_LOCK = "isCodexRunOut.poller.v1";

function safeSnapshot(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isFinite(value.receivedAt) &&
    Array.isArray(value.windows) &&
    Array.isArray(value.credits)
  );
}

function loadJson(storage, key, fallback, corruptPrefix = null) {
  const raw = storage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    if (corruptPrefix) {
      try {
        storage.setItem(`${corruptPrefix}${Date.now()}`, raw.slice(0, 1_000_000));
      } finally {
        storage.removeItem(key);
      }
    }
    return fallback;
  }
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class QuotaRuntime {
  constructor() {
    this.startedAt = Date.now();
    this.storage = window.localStorage;
    this.config = validateConfig(
      loadJson(
        this.storage,
        CONFIG_KEY,
        DEFAULT_CONFIG,
        CONFIG_CORRUPT_PREFIX,
      ),
    );
    const cached = loadJson(this.storage, SNAPSHOT_KEY, null);
    this.snapshot = safeSnapshot(cached) ? cached : null;
    this.history = new HistoryStore(this.storage);
    this.listeners = new Set();
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.isLeader = false;
    this.leadershipAttemptRunning = false;
    this.releaseLeadership = null;
    this.pollTimer = null;
    this.leaderRetryTimer = null;
    this.nextPlannedAt = null;
    this.lastTimerTickAt = Date.now();
    this.attemptTimes = [];
    this.compatibility = {
      status: "compatible",
      anchor: "pending",
      dataHook: this.snapshot ? "cached" : "pending",
      history: "ok",
      safeArea: "pending",
      lastError: null,
    };
    this.windowState = {
      online: navigator.onLine,
      focused: document.hasFocus(),
      hidden: document.hidden,
    };
    this.coordinator = new RefreshCoordinator({
      request: () => this.requestFreshData(),
      onState: () => {
        this.emit();
        this.scheduleNext();
      },
    });
    this.client = new BridgeUsageClient({
      onObserved: (payload) => this.handlePayload(payload, "codex-existing"),
      onError: (error) => this.handleBridgeError(error),
    });
    this.handleChannel = this.handleChannel.bind(this);
    this.handleStorage = this.handleStorage.bind(this);
    this.handleOnline = this.handleOnline.bind(this);
    this.handleOffline = this.handleOffline.bind(this);
    this.handleVisibility = this.handleVisibility.bind(this);
    this.handleFocus = this.handleFocus.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleHostMessage = this.handleHostMessage.bind(this);
  }

  start() {
    this.client.start();
    this.channel.addEventListener("message", this.handleChannel);
    window.addEventListener("storage", this.handleStorage);
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    window.addEventListener("focus", this.handleFocus);
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("message", this.handleHostMessage);
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.tryLeadership();
    this.leaderRetryTimer = window.setInterval(
      () => this.tryLeadership(),
      5_000,
    );
    this.emit();
  }

  stop() {
    this.client.stop();
    this.channel.close();
    window.removeEventListener("storage", this.handleStorage);
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    window.removeEventListener("focus", this.handleFocus);
    window.removeEventListener("blur", this.handleBlur);
    window.removeEventListener("message", this.handleHostMessage);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    clearInterval(this.leaderRetryTimer);
    clearTimeout(this.pollTimer);
    this.releaseLeadership?.();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  emit() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  getState() {
    const now = Date.now();
    const effectiveInterval = effectivePollIntervalMs(this.config, {
      isBackground: !this.windowState.focused,
    });
    const freshness = freshnessState(
      this.coordinator.state.lastSuccessAt ??
        this.snapshot?.receivedAt ??
        null,
      now,
      effectiveInterval || 300_000,
    );
    const estimates = new Map();
    for (const window of this.snapshot?.windows ?? []) {
      estimates.set(
        window.id,
        estimateEta({
          window,
          now,
          freshness,
        }),
      );
    }
    const intervals = this.attemptTimes
      .slice(-10)
      .map((time, index, times) => (index === 0 ? null : time - times[index - 1]))
      .filter(Number.isFinite);
    return {
      config: this.config,
      snapshot: this.snapshot,
      estimates,
      freshness,
      coordinator: this.coordinator.snapshot(),
      isLeader: this.isLeader,
      nextPlannedAt: this.nextPlannedAt,
      actualPollIntervalMs: median(intervals),
      effectivePollIntervalMs: effectiveInterval,
      compatibility: { ...this.compatibility },
      windowState: { ...this.windowState },
      appVersion:
        window.electronBridge?.getSentryInitOptions?.()?.appVersion ?? "unknown",
    };
  }

  setCompatibility(patch) {
    const next = { ...this.compatibility, ...patch };
    const changed = Object.keys(next).some(
      (key) => next[key] !== this.compatibility[key],
    );
    if (!changed) return;
    this.compatibility = next;
    if (next.status === "incompatible") {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.nextPlannedAt = null;
    }
    this.emit();
  }

  updateConfig(patch) {
    this.config = validateConfig({ ...this.config, ...patch });
    this.storage.setItem(CONFIG_KEY, JSON.stringify(this.config));
    this.channel.postMessage({ type: "config", config: this.config });
    this.debug("config-updated", {
      pollIntervalMs: this.config.pollIntervalMs,
      backgroundThrottle: this.config.backgroundThrottle,
    });
    this.scheduleNext({ immediate: false });
    this.emit();
  }

  debug(event, fields = {}) {
    if (!this.config.debugLogging) return;
    console.debug("[isCodexRunOut]", event, fields);
  }

  resetConfig() {
    this.updateConfig({ ...DEFAULT_CONFIG });
  }

  clearHistory() {
    this.history.clear();
    this.emit();
  }

  tryLeadership() {
    if (
      this.isLeader ||
      this.leadershipAttemptRunning ||
      !navigator.locks?.request
    ) {
      if (!navigator.locks?.request) {
        this.setCompatibility({
          status: "incompatible",
          lastError: "Web Locks API 不可用，已停止补充轮询",
        });
      }
      return;
    }
    this.leadershipAttemptRunning = true;
    navigator.locks
      .request(LEADER_LOCK, { ifAvailable: true }, async (lock) => {
        this.leadershipAttemptRunning = false;
        if (!lock) return;
        this.isLeader = true;
        this.channel.postMessage({ type: "leader-online", at: Date.now() });
        this.emit();
        if (this.config.refreshOnStartup) {
          window.setTimeout(() => {
            if (
              this.isLeader &&
              (this.snapshot?.receivedAt ?? 0) < this.startedAt
            ) {
              this.refresh("startup").catch(() => {});
            }
          }, 3_000);
        }
        this.scheduleNext();
        await new Promise((resolve) => {
          this.releaseLeadership = resolve;
        });
        this.releaseLeadership = null;
        this.isLeader = false;
        clearTimeout(this.pollTimer);
        this.nextPlannedAt = null;
        this.emit();
      })
      .catch((error) => {
        this.leadershipAttemptRunning = false;
        this.setCompatibility({
          lastError: error instanceof Error ? error.message : "leader lock failed",
        });
      });
  }

  handlePayload(payload, source) {
    let normalized;
    try {
      normalized = normalizeUsagePayload(payload, {
        source,
        receivedAt: Date.now(),
      });
    } catch (error) {
      this.handleBridgeError(error);
      return;
    }
    this.debug("usage-normalized", {
      source,
      windowCount: normalized.windows.length,
      creditBucketCount: normalized.credits.length,
    });
    if (this.isLeader) {
      this.ingest(normalized, true);
    } else {
      this.channel.postMessage({ type: "observed", snapshot: normalized });
      this.applySnapshot(normalized);
    }
  }

  handleBridgeError(error) {
    const incompatible =
      error instanceof CompatibilityError ||
      error?.code === "INCOMPATIBLE_SCHEMA";
    this.setCompatibility({
      status: incompatible ? "incompatible" : this.compatibility.status,
      dataHook: incompatible ? "incompatible" : this.compatibility.dataHook,
      lastError: incompatible
        ? "额度接口字段不兼容"
        : error?.code ?? "额度读取失败",
    });
    this.debug("usage-error", {
      code: error?.code ?? "REQUEST_FAILED",
      status: Number.isFinite(error?.status) ? error.status : null,
    });
  }

  ingest(snapshot, broadcast) {
    this.applySnapshot(snapshot);
    try {
      this.history.record(snapshot, {
        retentionDays: this.config.historyRetentionDays,
      });
    } catch {
      this.compatibility.history = "failed";
    }
    this.coordinator.noteExternalSuccess(snapshot.receivedAt);
    this.compatibility.dataHook =
      snapshot.source === "codex-existing"
        ? "existing-client-result"
        : "supplemental-bridge";
    this.storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    if (broadcast) this.channel.postMessage({ type: "snapshot", snapshot });
    this.scheduleNext();
    this.emit();
  }

  applySnapshot(snapshot) {
    if (
      !this.snapshot ||
      snapshot.receivedAt >= this.snapshot.receivedAt ||
      snapshot.source === "codex-existing"
    ) {
      this.snapshot = snapshot;
    }
    this.emit();
  }

  async requestFreshData() {
    if (!navigator.onLine) {
      throw new RefreshError("网络离线", { code: "OFFLINE" });
    }
    this.attemptTimes.push(Date.now());
    this.attemptTimes = this.attemptTimes.slice(-20);
    const payload = await this.client.request({
      timeoutMs: this.config.requestTimeoutMs,
    });
    const normalized = normalizeUsagePayload(payload, {
      source: "supplemental-bridge",
      receivedAt: Date.now(),
    });
    this.ingest(normalized, true);
    return normalized;
  }

  refresh(reason = "manual") {
    if (!this.isLeader) {
      this.channel.postMessage({ type: "manual-refresh", reason });
      return Promise.resolve(null);
    }
    return this.coordinator.trigger(reason, { manual: reason === "manual" });
  }

  scheduleNext({ immediate = false } = {}) {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.nextPlannedAt = null;
    if (
      !this.isLeader ||
      !this.windowState.online ||
      this.compatibility.status === "incompatible"
    ) {
      this.emit();
      return;
    }
    if (this.config.pauseWhenHidden && this.windowState.hidden) {
      this.emit();
      return;
    }
    const interval = effectivePollIntervalMs(this.config, {
      isBackground: !this.windowState.focused,
    });
    if (interval === 0) {
      this.emit();
      return;
    }
    const delay = immediate ? 0 : interval;
    this.nextPlannedAt = Date.now() + delay;
    this.lastTimerTickAt = Date.now();
    this.pollTimer = window.setTimeout(() => {
      const now = Date.now();
      const drift = now - this.lastTimerTickAt - delay;
      this.lastTimerTickAt = now;
      if (drift > Math.max(60_000, interval * 2)) {
        this.scheduleNext();
        return;
      }
      this.refresh("scheduled")
        .catch(() => {})
        .finally(() => this.scheduleNext());
    }, delay);
    this.emit();
  }

  handleChannel(event) {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "observed" && this.isLeader) {
      if (safeSnapshot(message.snapshot)) this.ingest(message.snapshot, true);
      return;
    }
    if (message.type === "snapshot" && safeSnapshot(message.snapshot)) {
      this.applySnapshot(message.snapshot);
      this.coordinator.noteExternalSuccess(message.snapshot.receivedAt);
      return;
    }
    if (message.type === "config") {
      this.config = validateConfig(message.config);
      this.scheduleNext();
      this.emit();
      return;
    }
    if (message.type === "manual-refresh" && this.isLeader) {
      this.refresh("manual").catch(() => {});
    }
  }

  handleStorage(event) {
    if (event.key === CONFIG_KEY && event.newValue) {
      try {
        this.config = validateConfig(JSON.parse(event.newValue));
        this.scheduleNext();
        this.emit();
      } catch {
        // The writer validates before persistence; a broken external write is ignored.
      }
    }
  }

  handleOnline() {
    this.windowState.online = true;
    if (this.config.refreshOnOnline && this.isLeader) {
      this.refresh("online").catch(() => {});
    }
    this.scheduleNext();
  }

  handleOffline() {
    this.windowState.online = false;
    this.scheduleNext();
  }

  handleVisibility() {
    this.windowState.hidden = document.hidden;
    this.scheduleNext();
  }

  handleFocus() {
    this.windowState.focused = true;
    this.scheduleNext();
  }

  handleBlur() {
    this.windowState.focused = false;
    this.scheduleNext();
  }

  handleHostMessage(event) {
    const message = event.data;
    if (message?.type !== "electron-window-focus-changed") return;
    const focused =
      typeof message.focused === "boolean"
        ? message.focused
        : typeof message.isFocused === "boolean"
          ? message.isFocused
          : null;
    if (focused != null) {
      this.windowState.focused = focused;
      this.scheduleNext();
    }
  }
}
