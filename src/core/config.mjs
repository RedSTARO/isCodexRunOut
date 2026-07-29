export const PATCH_VERSION = "0.2.0";

export const POLL_PRESETS_MS = Object.freeze([
  0,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  3_600_000,
]);

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: true,
  primaryMode: "auto",
  fixedWindowId: null,
  hiddenWindowIds: [],
  density: "standard",
  showProgress: true,
  showEta: true,
  showReset: true,
  showStatus: true,
  absoluteTime: false,
  pollIntervalMs: 300_000,
  backgroundThrottle: true,
  backgroundMultiplier: 4,
  backgroundIntervalMs: null,
  pauseWhenHidden: true,
  refreshOnOnline: true,
  refreshOnStartup: true,
  requestTimeoutMs: 15_000,
  historyRetentionDays: 30,
  etaEnabled: true,
  debugLogging: false,
});

const numberInRange = (value, minimum, maximum) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= minimum &&
  value <= maximum;

const stringArray = (value) =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((entry) => typeof entry === "string" && entry.length <= 200);

export function validatePollIntervalMs(value, { allowOff = true } = {}) {
  if (allowOff && value === 0) return 0;
  if (!numberInRange(value, 30_000, 86_400_000)) {
    throw new RangeError("轮询周期必须在 30 秒到 24 小时之间");
  }
  return Math.round(value);
}

export function validateConfig(candidate) {
  const source =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate
      : {};
  const config = { ...DEFAULT_CONFIG };

  for (const key of [
    "enabled",
    "showProgress",
    "showEta",
    "showReset",
    "showStatus",
    "absoluteTime",
    "backgroundThrottle",
    "pauseWhenHidden",
    "refreshOnOnline",
    "refreshOnStartup",
    "etaEnabled",
    "debugLogging",
  ]) {
    if (typeof source[key] === "boolean") config[key] = source[key];
  }

  if (source.primaryMode === "auto" || source.primaryMode === "fixed") {
    config.primaryMode = source.primaryMode;
  }
  if (
    source.fixedWindowId === null ||
    (typeof source.fixedWindowId === "string" &&
      source.fixedWindowId.length <= 200)
  ) {
    config.fixedWindowId = source.fixedWindowId;
  }
  if (stringArray(source.hiddenWindowIds)) {
    config.hiddenWindowIds = [...new Set(source.hiddenWindowIds)];
  }
  if (source.density === "standard" || source.density === "compact") {
    config.density = source.density;
  }

  try {
    config.pollIntervalMs = validatePollIntervalMs(source.pollIntervalMs);
  } catch {
    config.pollIntervalMs = DEFAULT_CONFIG.pollIntervalMs;
  }

  if (numberInRange(source.backgroundMultiplier, 1, 100)) {
    config.backgroundMultiplier = source.backgroundMultiplier;
  }
  if (source.backgroundIntervalMs === null) {
    config.backgroundIntervalMs = null;
  } else {
    try {
      config.backgroundIntervalMs = validatePollIntervalMs(
        source.backgroundIntervalMs,
        { allowOff: false },
      );
    } catch {
      config.backgroundIntervalMs = null;
    }
  }
  if (numberInRange(source.requestTimeoutMs, 3_000, 120_000)) {
    config.requestTimeoutMs = Math.round(source.requestTimeoutMs);
  }
  if (numberInRange(source.historyRetentionDays, 1, 365)) {
    config.historyRetentionDays = Math.round(source.historyRetentionDays);
  }

  return config;
}

export function effectivePollIntervalMs(config, { isBackground = false } = {}) {
  if (config.pollIntervalMs === 0) return 0;
  if (!isBackground || !config.backgroundThrottle) {
    return config.pollIntervalMs;
  }
  if (config.backgroundIntervalMs != null) {
    return config.backgroundIntervalMs;
  }
  return Math.min(
    86_400_000,
    Math.round(config.pollIntervalMs * config.backgroundMultiplier),
  );
}
