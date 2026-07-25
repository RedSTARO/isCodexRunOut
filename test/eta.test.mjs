import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateEta,
  freshnessState,
  selectPrimaryWindow,
} from "../src/core/eta.mjs";

const hour = 3_600_000;
const now = 10 * hour;
const window = {
  id: "codex:primary",
  usedPercent: 30,
  remainingPercent: 70,
  resetsAt: now + 10 * hour,
};

function sample(t, usedPercent, resetsAt = window.resetsAt) {
  return {
    t,
    windowId: window.id,
    usedPercent,
    resetsAt,
    valid: true,
  };
}

test("样本不足、无消费和过期数据不输出具体 ETA", () => {
  assert.equal(
    estimateEta({ window, samples: [sample(now, 30)], now }).kind,
    "insufficient",
  );
  assert.equal(
    estimateEta({
      window,
      samples: [
        sample(now - 3 * hour, 20),
        sample(now - 2 * hour, 20),
        sample(now - hour, 20),
      ],
      now,
    }).kind,
    "no-consumption",
  );
  assert.equal(
    estimateEta({
      window,
      samples: [],
      now,
      freshness: "expired",
    }).kind,
    "stale",
  );
});

test("使用真实采样间隔估算 ETA", () => {
  const estimate = estimateEta({
    window,
    samples: [
      sample(now - 4 * hour, 10),
      sample(now - 2 * hour, 20),
      sample(now, 30),
    ],
    now,
  });
  assert.equal(estimate.kind, "safe-through-reset");
  assert.ok(estimate.recentRatePercentPerHour > 4.9);
  assert.ok(estimate.recentRatePercentPerHour < 5.1);
});

test("预计耗尽早于重置时返回具体 ETA", () => {
  const urgentWindow = { ...window, remainingPercent: 10 };
  const estimate = estimateEta({
    window: urgentWindow,
    samples: [
      sample(now - 4 * hour, 10),
      sample(now - 2 * hour, 20),
      sample(now, 30),
    ],
    now,
  });
  assert.equal(estimate.kind, "estimated");
  assert.ok(Math.abs(estimate.remainingMs - 2 * hour) < 1_000);
});

test("新重置周期不混用旧周期样本", () => {
  const estimate = estimateEta({
    window,
    samples: [
      sample(now - 4 * hour, 90, window.resetsAt - 7 * 24 * hour),
      sample(now - 2 * hour, 10),
      sample(now - hour, 20),
      sample(now, 30),
    ],
    now,
  });
  assert.equal(estimate.changedSampleCount, 3);
});

test("新鲜度及自动主窗口选择", () => {
  assert.equal(freshnessState(now - hour, now, hour), "fresh");
  assert.equal(freshnessState(now - 3 * hour, now, hour), "stale");
  assert.equal(freshnessState(now - 6 * hour, now, hour), "expired");
  const windows = [
    { id: "a", remainingPercent: 50, resetsAt: now + hour },
    { id: "b", remainingPercent: 10, resetsAt: now + 2 * hour },
  ];
  assert.equal(
    selectPrimaryWindow(windows, new Map(), {
      primaryMode: "auto",
      hiddenWindowIds: [],
    }).id,
    "b",
  );
});
