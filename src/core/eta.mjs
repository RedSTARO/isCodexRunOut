const HOUR_MS = 3_600_000;

export function freshnessState(lastSuccessAt, now, intervalMs) {
  if (!Number.isFinite(lastSuccessAt)) return "missing";
  const effective = Math.max(30_000, intervalMs || 300_000);
  const age = Math.max(0, now - lastSuccessAt);
  if (age > effective * 5) return "expired";
  if (age > effective * 2) return "stale";
  return "fresh";
}

export function estimateEta({
  window,
  now = Date.now(),
  freshness = "fresh",
}) {
  if (freshness === "expired") {
    return { kind: "stale", model: "cycle-linear" };
  }

  const cycleDurationMs = window.durationMinutes * 60_000;
  if (
    !Number.isFinite(window.resetsAt) ||
    !Number.isFinite(cycleDurationMs) ||
    cycleDurationMs <= 0 ||
    !Number.isFinite(window.usedPercent)
  ) {
    return { kind: "insufficient", model: "cycle-linear" };
  }

  const cycleStartedAt = window.resetsAt - cycleDurationMs;
  const elapsedMs = now - cycleStartedAt;
  if (elapsedMs <= 0 || now >= window.resetsAt) {
    return {
      kind: "insufficient",
      model: "cycle-linear",
      cycleStartedAt,
      cycleEndsAt: window.resetsAt,
    };
  }

  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  const elapsedPercent = Math.min(100, (elapsedMs / cycleDurationMs) * 100);
  const base = {
    model: "cycle-linear",
    cycleStartedAt,
    cycleEndsAt: window.resetsAt,
    elapsedMs,
    elapsedPercent,
    cycleRatePercentPerHour:
      usedPercent > 0 ? (usedPercent / elapsedMs) * HOUR_MS : 0,
  };
  if (usedPercent === 0) {
    return { ...base, kind: "no-consumption" };
  }

  const remainingPercent = 100 - usedPercent;
  const remainingMs = (remainingPercent / usedPercent) * elapsedMs;
  const exhaustsAt = now + remainingMs;
  if (window.resetsAt != null && exhaustsAt >= window.resetsAt) {
    return { ...base, kind: "safe-through-reset", exhaustsAt };
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
