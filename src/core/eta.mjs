const MIN_SAMPLE_SPAN_MS = 120_000;
const MIN_RATE_PER_MS = 0.000001 / 3_600_000;

export function freshnessState(lastSuccessAt, now, intervalMs) {
  if (!Number.isFinite(lastSuccessAt)) return "missing";
  const effective = Math.max(30_000, intervalMs || 300_000);
  const age = Math.max(0, now - lastSuccessAt);
  if (age > effective * 5) return "expired";
  if (age > effective * 2) return "stale";
  return "fresh";
}

function selectCycleSamples(samples, window) {
  const valid = samples
    .filter(
      (sample) =>
        sample &&
        sample.windowId === window.id &&
        Number.isFinite(sample.t) &&
        Number.isFinite(sample.usedPercent) &&
        sample.usedPercent >= 0 &&
        sample.usedPercent <= 100 &&
        sample.valid !== false,
    )
    .sort((left, right) => left.t - right.t);
  if (valid.length === 0) return [];

  const currentReset = window.resetsAt;
  const cycle = [];
  for (const sample of valid) {
    if (
      currentReset != null &&
      sample.resetsAt != null &&
      Math.abs(sample.resetsAt - currentReset) > 60_000
    ) {
      continue;
    }
    const previous = cycle.at(-1);
    if (previous) {
      const dt = sample.t - previous.t;
      const delta = sample.usedPercent - previous.usedPercent;
      if (dt <= 0) continue;
      if (delta < -5) {
        cycle.length = 0;
      } else if (delta > 80 && dt < 60_000) {
        continue;
      }
    }
    cycle.push(sample);
  }
  return cycle;
}

function changedSamples(samples) {
  const result = [];
  for (const sample of samples) {
    const previous = result.at(-1);
    if (!previous || sample.usedPercent !== previous.usedPercent) {
      result.push(sample);
    }
  }
  return result;
}

function positiveAdjacentRates(samples) {
  const rates = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const delta = current.usedPercent - previous.usedPercent;
    const duration = current.t - previous.t;
    if (delta > 0 && duration >= 1_000) rates.push(delta / duration);
  }
  return rates;
}

function weightedMedian(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function confidenceFor(changes, spanMs) {
  if (changes >= 8 && spanMs >= 6 * 3_600_000) return "high";
  if (changes >= 4 && spanMs >= 30 * 60_000) return "medium";
  return "low";
}

export function estimateEta({
  window,
  samples,
  now = Date.now(),
  freshness = "fresh",
  effectiveIntervalMs = 300_000,
}) {
  if (freshness === "expired") {
    return { kind: "stale", sampleCount: samples.length };
  }
  const cycle = selectCycleSamples(samples, window);
  const changed = changedSamples(cycle);
  const lastSample = cycle.at(-1);
  const lastChanged = changed.at(-1);
  if (!lastSample) {
    return { kind: "insufficient", sampleCount: cycle.length };
  }

  const noChangeFor = now - lastChanged.t;
  if (
    cycle.length >= 3 &&
    cycle.at(-1).t - cycle[0].t >= MIN_SAMPLE_SPAN_MS &&
    (positiveAdjacentRates(changed).length === 0 ||
      noChangeFor > Math.max(30 * 60_000, effectiveIntervalMs * 3))
  ) {
    return { kind: "no-consumption", sampleCount: cycle.length };
  }
  if (changed.length < 3) {
    return { kind: "insufficient", sampleCount: cycle.length };
  }

  const recentCutoff = lastChanged.t - 6 * 3_600_000;
  const recent = changed.filter((sample) => sample.t >= recentCutoff);
  const recentRates = positiveAdjacentRates(recent);
  const allRates = positiveAdjacentRates(changed);
  const recentRate = weightedMedian(recentRates);
  const first = changed[0];
  const spanMs = lastChanged.t - first.t;
  if (spanMs < MIN_SAMPLE_SPAN_MS || allRates.length < 2) {
    return { kind: "insufficient", sampleCount: cycle.length };
  }
  const cycleDelta = lastChanged.usedPercent - first.usedPercent;
  const cycleRate = cycleDelta > 0 ? cycleDelta / spanMs : null;
  const rate =
    recentRate != null && cycleRate != null
      ? recentRate * 0.7 + cycleRate * 0.3
      : recentRate ?? cycleRate;
  if (rate == null || rate <= MIN_RATE_PER_MS) {
    return { kind: "no-consumption", sampleCount: cycle.length };
  }

  const remaining = Math.max(0, window.remainingPercent);
  const remainingMs = remaining / rate;
  const exhaustsAt = now + remainingMs;
  const base = {
    sampleCount: cycle.length,
    changedSampleCount: changed.length,
    recentRatePercentPerHour: rate * 3_600_000,
    cycleRatePercentPerHour:
      cycleRate == null ? null : cycleRate * 3_600_000,
    confidence: confidenceFor(changed.length, spanMs),
  };
  if (window.resetsAt != null && exhaustsAt >= window.resetsAt) {
    return { ...base, kind: "safe-through-reset" };
  }
  return {
    ...base,
    kind: "estimated",
    remainingMs,
    exhaustsAt,
  };
}

export function selectPrimaryWindow(windows, estimates, config) {
  const visible = windows.filter(
    (window) => !config.hiddenWindowIds.includes(window.id),
  );
  if (visible.length === 0) return null;
  if (config.primaryMode === "fixed" && config.fixedWindowId) {
    const fixed = visible.find((window) => window.id === config.fixedWindowId);
    if (fixed) return fixed;
  }

  return [...visible].sort((left, right) => {
    const leftExhausted = left.remainingPercent <= 0 ? 0 : 1;
    const rightExhausted = right.remainingPercent <= 0 ? 0 : 1;
    if (leftExhausted !== rightExhausted) return leftExhausted - rightExhausted;
    const leftEta = estimates.get(left.id);
    const rightEta = estimates.get(right.id);
    const leftDuration =
      leftEta?.kind === "estimated" ? leftEta.remainingMs : Infinity;
    const rightDuration =
      rightEta?.kind === "estimated" ? rightEta.remainingMs : Infinity;
    if (leftDuration !== rightDuration) return leftDuration - rightDuration;
    if (left.remainingPercent !== right.remainingPercent) {
      return left.remainingPercent - right.remainingPercent;
    }
    return (left.resetsAt ?? Infinity) - (right.resetsAt ?? Infinity);
  })[0];
}
