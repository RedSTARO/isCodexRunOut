import assert from "node:assert/strict";
import test from "node:test";
import {
  RefreshCoordinator,
  RefreshError,
  computeBackoffMs,
} from "../src/core/polling.mjs";

test("并发刷新共享一个 in-flight 请求", async () => {
  let calls = 0;
  let resolveRequest;
  const coordinator = new RefreshCoordinator({
    request: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
  });
  const first = coordinator.trigger("scheduled");
  const second = coordinator.trigger("manual", { manual: true });
  assert.equal(calls, 1);
  resolveRequest("ok");
  assert.equal(await first, "ok");
  assert.equal(await second, "ok");
});

test("429、认证错误和结构不兼容进入不同停止状态", async () => {
  let now = 1_000;
  const errors = [
    new RefreshError("rate", { status: 429, retryAfterMs: 60_000 }),
    new RefreshError("auth", { status: 401 }),
    new RefreshError("schema", { code: "INCOMPATIBLE_SCHEMA" }),
  ];
  const coordinator = new RefreshCoordinator({
    now: () => now,
    random: () => 0.5,
    request: async () => {
      throw errors.shift();
    },
  });
  await assert.rejects(coordinator.trigger("scheduled"));
  assert.equal(coordinator.state.requestStatus, "rate-limited");
  assert.equal(coordinator.state.rateLimitedUntil, 61_000);
  now = 61_001;
  await assert.rejects(coordinator.trigger("scheduled"));
  assert.equal(coordinator.state.requestStatus, "auth-failed");
  now += 30 * 60_000 + 1;
  await assert.rejects(coordinator.trigger("scheduled"));
  assert.equal(coordinator.state.requestStatus, "incompatible");
  assert.equal(coordinator.state.backoffUntil, Infinity);
});

test("指数退避带有有界抖动和上限", () => {
  assert.equal(computeBackoffMs(1, () => 0.5), 5_000);
  assert.equal(computeBackoffMs(2, () => 0), 8_000);
  assert.ok(computeBackoffMs(99, () => 1) <= 2_160_000);
});
