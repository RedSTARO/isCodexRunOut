export class RefreshError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RefreshError";
    this.code = options.code ?? "REQUEST_FAILED";
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function computeBackoffMs(failureCount, random = Math.random) {
  const base = 5_000;
  const maximum = 30 * 60_000;
  const exponent = Math.min(10, Math.max(0, failureCount - 1));
  const withoutJitter = Math.min(maximum, base * 2 ** exponent);
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(withoutJitter * jitter);
}

export class RefreshCoordinator {
  constructor({ request, now = Date.now, random = Math.random, onState }) {
    this.request = request;
    this.now = now;
    this.random = random;
    this.onState = onState ?? (() => {});
    this.inFlight = null;
    this.state = {
      requestStatus: "idle",
      failureCount: 0,
      backoffUntil: null,
      rateLimitedUntil: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
    };
  }

  snapshot() {
    return { ...this.state, inFlight: Boolean(this.inFlight) };
  }

  emit() {
    this.onState(this.snapshot());
  }

  noteExternalSuccess(at = this.now()) {
    this.state.requestStatus = "idle";
    this.state.failureCount = 0;
    this.state.backoffUntil = null;
    this.state.rateLimitedUntil = null;
    this.state.lastSuccessAt = at;
    this.state.lastError = null;
    this.emit();
  }

  canAttempt({ manual = false } = {}) {
    const now = this.now();
    if (
      manual &&
      this.state.lastAttemptAt != null &&
      now - this.state.lastAttemptAt < 3_000
    ) {
      return false;
    }
    if (this.state.rateLimitedUntil && now < this.state.rateLimitedUntil) {
      return false;
    }
    if (
      !manual &&
      this.state.backoffUntil &&
      now < this.state.backoffUntil
    ) {
      return false;
    }
    return true;
  }

  async trigger(reason, { manual = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!this.canAttempt({ manual })) {
      throw new RefreshError("刷新仍处于等待期", {
        code:
          manual &&
          this.state.lastAttemptAt != null &&
          this.now() - this.state.lastAttemptAt < 3_000
            ? "COOLDOWN_ACTIVE"
            : "BACKOFF_ACTIVE",
      });
    }
    this.state.requestStatus = "refreshing";
    this.state.lastAttemptAt = this.now();
    this.emit();
    this.inFlight = this.request({ reason, manual })
      .then((result) => {
        this.state.requestStatus = "idle";
        this.state.failureCount = 0;
        this.state.backoffUntil = null;
        this.state.rateLimitedUntil = null;
        this.state.lastSuccessAt = this.now();
        this.state.lastError = null;
        return result;
      })
      .catch((error) => {
        this.state.failureCount += 1;
        const isRateLimit = error?.status === 429;
        const retryAfterMs =
          Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0
            ? error.retryAfterMs
            : null;
        if (isRateLimit) {
          this.state.requestStatus = "rate-limited";
          this.state.rateLimitedUntil =
            this.now() + (retryAfterMs ?? computeBackoffMs(this.state.failureCount));
        } else if (error?.status === 401 || error?.status === 403) {
          this.state.requestStatus = "auth-failed";
          this.state.backoffUntil = this.now() + 30 * 60_000;
        } else if (error?.code === "INCOMPATIBLE_SCHEMA") {
          this.state.requestStatus = "incompatible";
          this.state.backoffUntil = Number.POSITIVE_INFINITY;
        } else {
          this.state.requestStatus = "failed";
          this.state.backoffUntil =
            this.now() +
            (retryAfterMs ??
              computeBackoffMs(this.state.failureCount, this.random));
        }
        this.state.lastError = {
          code: error?.code ?? "REQUEST_FAILED",
          status: Number.isFinite(error?.status) ? error.status : null,
          at: this.now(),
        };
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
        this.emit();
      });
    return this.inFlight;
  }
}
