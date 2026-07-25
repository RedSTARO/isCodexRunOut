import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  effectivePollIntervalMs,
  validateConfig,
  validatePollIntervalMs,
} from "../src/core/config.mjs";

test("轮询周期边界与关闭值", () => {
  assert.equal(validatePollIntervalMs(0), 0);
  assert.equal(validatePollIntervalMs(30_000), 30_000);
  assert.equal(validatePollIntervalMs(86_400_000), 86_400_000);
  assert.throws(() => validatePollIntervalMs(29_999), RangeError);
  assert.throws(() => validatePollIntervalMs(86_400_001), RangeError);
});

test("配置只接受白名单字段和有效范围", () => {
  const config = validateConfig({
    enabled: false,
    pollIntervalMs: 60_000,
    backgroundMultiplier: 7,
    requestTimeoutMs: 20_000,
    historyRetentionDays: 90,
    unknown: "ignored",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.backgroundMultiplier, 7);
  assert.equal(config.requestTimeoutMs, 20_000);
  assert.equal(config.historyRetentionDays, 90);
  assert.equal("unknown" in config, false);
  assert.equal(validateConfig({ pollIntervalMs: 1 }).pollIntervalMs, 300_000);
});

test("后台轮询支持倍率和固定周期", () => {
  assert.equal(
    effectivePollIntervalMs(
      { ...DEFAULT_CONFIG, pollIntervalMs: 60_000, backgroundMultiplier: 4 },
      { isBackground: true },
    ),
    240_000,
  );
  assert.equal(
    effectivePollIntervalMs(
      {
        ...DEFAULT_CONFIG,
        pollIntervalMs: 60_000,
        backgroundIntervalMs: 900_000,
      },
      { isBackground: true },
    ),
    900_000,
  );
  assert.equal(
    effectivePollIntervalMs(
      { ...DEFAULT_CONFIG, pollIntervalMs: 0 },
      { isBackground: true },
    ),
    0,
  );
});
