import assert from "node:assert/strict";
import test from "node:test";
import {
  CompatibilityError,
  normalizeUsagePayload,
} from "../src/core/normalize.mjs";

test("归一化真实 wham usage 结构及附加额度桶", () => {
  const snapshot = normalizeUsagePayload(
    {
      plan_type: "pro",
      rate_limit_name: "Codex",
      rate_limit: {
        primary_window: {
          used_percent: 31.5,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 82,
          limit_window_seconds: 604_800,
          reset_at: 1_800_500_000,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
      additional_rate_limits: [
        {
          limit_id: "spark",
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: {
              used_percent: 4,
              limit_window_seconds: 604_800,
              reset_at: 1_800_600_000,
            },
          },
        },
      ],
    },
    { source: "test", receivedAt: 123 },
  );
  assert.equal(snapshot.schema, "wham-usage-v1");
  assert.equal(snapshot.receivedAt, 123);
  assert.equal(snapshot.windows.length, 3);
  assert.deepEqual(
    snapshot.windows.map((window) => window.displayName),
    ["Codex · 5h", "Codex · 7d", "GPT-5.3-Codex-Spark"],
  );
  assert.equal(snapshot.windows[0].resetsAt, 1_800_000_000_000);
  assert.equal(snapshot.windows[1].remainingPercent, 18);
  assert.equal(snapshot.credits[0].balance, "12.5");
});

test("归一化 app-server rateLimitsByLimitId 结构", () => {
  const snapshot = normalizeUsagePayload({
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: {
        usedPercent: 87,
        windowDurationMins: 10_080,
        resetsAt: 1_785_258_131,
      },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "pro",
        primary: {
          usedPercent: 87,
          windowDurationMins: 10_080,
          resetsAt: 1_785_258_131,
        },
      },
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: {
          usedPercent: 0,
          windowDurationMins: 10_080,
          resetsAt: 1_785_567_930,
        },
      },
    },
  });
  assert.equal(snapshot.schema, "app-server-rate-limits-v2");
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0].displayName, "7d");
  assert.equal(snapshot.windows[1].displayName, "GPT-5.3-Codex-Spark");
});

test("无有效窗口时 fail-fast，不生成伪数据", () => {
  assert.throws(
    () => normalizeUsagePayload({ rate_limit: {} }),
    CompatibilityError,
  );
  assert.throws(
    () =>
      normalizeUsagePayload({
        rate_limit: { primary_window: { used_percent: 130 } },
      }),
    CompatibilityError,
  );
});
