const MAX_ID_LENGTH = 200;

export class CompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompatibilityError";
    this.code = "INCOMPATIBLE_SCHEMA";
  }
}

const finiteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const firstDefined = (...values) =>
  values.find((value) => value !== undefined && value !== null);

function clampPercent(value) {
  const number = finiteNumber(value);
  if (number == null || number < 0 || number > 100) return null;
  return Math.round(number * 100) / 100;
}

function epochToMs(value) {
  const number = finiteNumber(value);
  if (number == null || number <= 0) return null;
  return Math.round(number < 1_000_000_000_000 ? number * 1_000 : number);
}

function cleanText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_ID_LENGTH ? text : null;
}

function slug(value) {
  return (
    cleanText(value)
      ?.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || null
  );
}

export function formatWindowDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "额度";
  if (minutes % 10_080 === 0) {
    const weeks = minutes / 10_080;
    return weeks === 1 ? "7d" : `${weeks}w`;
  }
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function normalizeCredits(raw) {
  if (!raw || typeof raw !== "object") return null;
  const hasCredits = firstDefined(raw.has_credits, raw.hasCredits);
  const unlimited = raw.unlimited;
  const balance = raw.balance;
  if (
    typeof hasCredits !== "boolean" &&
    typeof unlimited !== "boolean" &&
    balance == null
  ) {
    return null;
  }
  return {
    hasCredits: typeof hasCredits === "boolean" ? hasCredits : null,
    unlimited: typeof unlimited === "boolean" ? unlimited : null,
    balance:
      typeof balance === "string" || typeof balance === "number"
        ? String(balance)
        : null,
  };
}

function normalizeWindow(raw, context) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = clampPercent(
    firstDefined(raw.used_percent, raw.usedPercent),
  );
  if (usedPercent == null) return null;

  const seconds = finiteNumber(raw.limit_window_seconds);
  const minutes = finiteNumber(raw.windowDurationMins);
  const durationMinutes =
    minutes != null
      ? minutes
      : seconds != null && seconds > 0
        ? seconds / 60
        : null;
  const resetsAt = epochToMs(firstDefined(raw.reset_at, raw.resetsAt));
  const durationLabel = formatWindowDuration(durationMinutes);
  const bucketLabel = cleanText(context.limitName);
  const displayName = bucketLabel
    ? context.hasMultipleWindows
      ? `${bucketLabel} · ${durationLabel}`
      : bucketLabel
    : durationLabel;

  return {
    id: `${context.bucketId}:${context.kind}`,
    bucketId: context.bucketId,
    limitId: cleanText(context.limitId),
    limitName: bucketLabel,
    kind: context.kind,
    displayName,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    durationMinutes,
    resetsAt,
    planType: cleanText(context.planType),
    rateLimitReachedType: cleanText(context.rateLimitReachedType),
    spendControlReached:
      typeof context.spendControlReached === "boolean"
        ? context.spendControlReached
        : null,
  };
}

function normalizeBucket(snapshot, metadata) {
  if (!snapshot || typeof snapshot !== "object") {
    return { windows: [], credits: null };
  }
  const primary = firstDefined(snapshot.primary_window, snapshot.primary);
  const secondary = firstDefined(snapshot.secondary_window, snapshot.secondary);
  const context = {
    ...metadata,
    hasMultipleWindows: Boolean(primary && secondary),
    planType: firstDefined(snapshot.plan_type, snapshot.planType, metadata.planType),
    rateLimitReachedType: firstDefined(
      snapshot.rate_limit_reached_type,
      snapshot.rateLimitReachedType,
    ),
    spendControlReached: firstDefined(
      snapshot.spend_control_reached,
      snapshot.spendControlReached,
    ),
  };
  return {
    windows: [
      normalizeWindow(primary, { ...context, kind: "primary" }),
      normalizeWindow(secondary, { ...context, kind: "secondary" }),
    ].filter(Boolean),
    credits: normalizeCredits(snapshot.credits),
  };
}

function normalizeRawUsage(raw, receivedAt) {
  const buckets = [];
  const rootLimitName = cleanText(raw.rate_limit_name);
  const rootLimitId = cleanText(raw.limit_id) || "codex";
  if (raw.rate_limit && typeof raw.rate_limit === "object") {
    buckets.push({
      snapshot: { ...raw.rate_limit, credits: raw.credits },
      limitId: rootLimitId,
      limitName: rootLimitName,
      bucketId: slug(rootLimitId) || slug(rootLimitName) || "codex",
    });
  }

  if (Array.isArray(raw.additional_rate_limits)) {
    raw.additional_rate_limits.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || !entry.rate_limit) return;
      const limitName = cleanText(entry.limit_name);
      const limitId = cleanText(entry.limit_id);
      buckets.push({
        snapshot: { ...entry.rate_limit, credits: entry.credits },
        limitId,
        limitName,
        bucketId:
          slug(limitId) || slug(limitName) || `additional-${index + 1}`,
      });
    });
  }

  if (buckets.length === 0 && !raw.credits) {
    throw new CompatibilityError("usage 响应中没有可识别的额度窗口");
  }

  const windows = [];
  const credits = [];
  for (const bucket of buckets) {
    const normalized = normalizeBucket(bucket.snapshot, {
      bucketId: bucket.bucketId,
      limitId: bucket.limitId,
      limitName: bucket.limitName,
      planType: raw.plan_type,
    });
    windows.push(...normalized.windows);
    if (normalized.credits) {
      credits.push({
        bucketId: bucket.bucketId,
        limitName: bucket.limitName,
        ...normalized.credits,
      });
    }
  }
  const rootCredits = normalizeCredits(raw.credits);
  if (rootCredits && !credits.some((entry) => entry.bucketId === "codex")) {
    credits.push({ bucketId: "codex", limitName: rootLimitName, ...rootCredits });
  }
  if (windows.length === 0 && credits.length === 0) {
    throw new CompatibilityError("usage 响应字段存在，但没有有效额度数值");
  }
  return {
    schema: "wham-usage-v1",
    receivedAt,
    planType: cleanText(raw.plan_type),
    windows,
    credits,
  };
}

function normalizeAppServerUsage(raw, receivedAt) {
  const snapshots =
    raw.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === "object"
      ? Object.entries(raw.rateLimitsByLimitId)
      : raw.rateLimits
        ? [[raw.rateLimits.limitId || "codex", raw.rateLimits]]
        : [];
  const windows = [];
  const credits = [];
  for (const [mapId, snapshot] of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const limitId = cleanText(snapshot.limitId) || cleanText(mapId);
    const limitName = cleanText(snapshot.limitName);
    const bucketId = slug(limitId) || slug(limitName) || "codex";
    const normalized = normalizeBucket(snapshot, {
      bucketId,
      limitId,
      limitName,
      planType: snapshot.planType,
    });
    windows.push(...normalized.windows);
    if (normalized.credits) {
      credits.push({ bucketId, limitName, ...normalized.credits });
    }
  }
  if (windows.length === 0 && credits.length === 0) {
    throw new CompatibilityError("app-server 响应中没有有效额度数值");
  }
  return {
    schema: "app-server-rate-limits-v2",
    receivedAt,
    planType: cleanText(raw.rateLimits?.planType),
    windows,
    credits,
  };
}

export function normalizeUsagePayload(raw, options = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CompatibilityError("额度响应不是对象");
  }
  const receivedAt = options.receivedAt ?? Date.now();
  const source = options.source ?? "codex-client";
  const normalized =
    "rateLimits" in raw || "rateLimitsByLimitId" in raw
      ? normalizeAppServerUsage(raw, receivedAt)
      : normalizeRawUsage(raw, receivedAt);
  return {
    ...normalized,
    source,
    windows: normalized.windows.map((window) => ({ ...window, source })),
  };
}
