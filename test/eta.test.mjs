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
  durationMinutes: (20 * hour) / 60_000,
  resetsAt: now + 10 * hour,
};

test("按周期起止时间和当前使用进度估算 ETA", () => {
  const estimate = estimateEta({ window, now });
  assert.equal(estimate.kind, "safe-through-reset");
  assert.equal(estimate.cycleStartedAt, 0);
  assert.equal(estimate.elapsedPercent, 50);
  assert.equal(estimate.cycleRatePercentPerHour, 3);
  assert.ok(Math.abs(estimate.exhaustsAt - (100 / 3) * hour) < 1_000);
});

test("零使用、缺少周期字段和过期数据不输出具体 ETA", () => {
  assert.equal(
    estimateEta({
      window: { ...window, usedPercent: 0, remainingPercent: 100 },
      now,
    }).kind,
    "no-consumption",
  );
  assert.equal(
    estimateEta({
      window: { ...window, durationMinutes: null },
      now,
    }).kind,
    "insufficient",
  );
  assert.equal(
    estimateEta({
      window,
      now,
      freshness: "expired",
    }).kind,
    "stale",
  );
});

test("预计耗尽早于重置时返回具体 ETA", () => {
  const urgentWindow = {
    ...window,
    usedPercent: 80,
    remainingPercent: 20,
  };
  const estimate = estimateEta({
    window: urgentWindow,
    now,
  });
  assert.equal(estimate.kind, "estimated");
  assert.ok(Math.abs(estimate.remainingMs - 2.5 * hour) < 1_000);
  assert.ok(Math.abs(estimate.exhaustsAt - 12.5 * hour) < 1_000);
});

test("历史样本不参与周期线性估算", () => {
  const estimate = estimateEta({ window, now, samples: [{ usedPercent: 99 }] });
  assert.equal(estimate.cycleRatePercentPerHour, 3);
  assert.equal(estimate.model, "cycle-linear");
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
