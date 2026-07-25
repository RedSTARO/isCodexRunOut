import { RefreshError } from "../core/polling.mjs";

const USAGE_ENDPOINT = "/wham/usage";

function isUsageUrl(value) {
  if (typeof value !== "string") return false;
  return value.split("?", 1)[0] === USAGE_ENDPOINT;
}

function retryAfterMs(headers) {
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "retry-after",
  );
  if (!entry) return null;
  const seconds = Number(entry[1]);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(String(entry[1]));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function responseError(message) {
  const status = Number.isFinite(message.status) ? message.status : null;
  return new RefreshError(
    status === 401 || status === 403
      ? "Codex 认证失效"
      : status === 429
        ? "额度接口限流"
        : "额度请求失败",
    {
      code:
        status === 401 || status === 403
          ? "AUTH_FAILED"
          : status === 429
            ? "RATE_LIMITED"
            : "REQUEST_FAILED",
      status,
      retryAfterMs: retryAfterMs(message.headers),
    },
  );
}

function parseSuccessfulResponse(message) {
  if (
    message.responseType !== "success" ||
    !Number.isFinite(message.status) ||
    message.status < 200 ||
    message.status >= 300
  ) {
    throw responseError(message);
  }
  try {
    return JSON.parse(message.bodyJsonString);
  } catch {
    throw new RefreshError("额度响应不是有效 JSON", {
      code: "INCOMPATIBLE_SCHEMA",
      status: message.status,
    });
  }
}

export class BridgeUsageClient {
  constructor({ onObserved, onError }) {
    this.onObserved = onObserved;
    this.onError = onError;
    this.observedRequestIds = new Set();
    this.pending = new Map();
    this.started = false;
    this.handleOutgoing = this.handleOutgoing.bind(this);
    this.handleIncoming = this.handleIncoming.bind(this);
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener("codex-message-from-view", this.handleOutgoing);
    window.addEventListener("message", this.handleIncoming);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener("codex-message-from-view", this.handleOutgoing);
    window.removeEventListener("message", this.handleIncoming);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new RefreshError("窗口已关闭", { code: "REQUEST_CANCELLED" }),
      );
    }
    this.pending.clear();
    this.observedRequestIds.clear();
  }

  handleOutgoing(event) {
    const message = event?.detail;
    if (
      message?.type === "fetch" &&
      typeof message.requestId === "string" &&
      isUsageUrl(message.url)
    ) {
      this.observedRequestIds.add(message.requestId);
    }
  }

  handleIncoming(event) {
    const message = event?.data;
    if (
      !message ||
      typeof message !== "object" ||
      message.type !== "fetch-response" ||
      typeof message.requestId !== "string"
    ) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (pending) {
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      try {
        pending.resolve(parseSuccessfulResponse(message));
      } catch (error) {
        pending.reject(error);
      }
      return;
    }

    if (!this.observedRequestIds.delete(message.requestId)) return;
    try {
      this.onObserved(parseSuccessfulResponse(message));
    } catch (error) {
      this.onError(error);
    }
  }

  request({ timeoutMs }) {
    const bridge = window.electronBridge;
    if (typeof bridge?.sendMessageFromView !== "function") {
      return Promise.reject(
        new RefreshError("Codex 内部请求桥不可用", {
          code: "BRIDGE_UNAVAILABLE",
        }),
      );
    }
    const requestId = crypto.randomUUID();
    const message = {
      type: "fetch",
      requestId,
      method: "GET",
      url: USAGE_ENDPOINT,
      headers: {
        "OAI-Language":
          document.documentElement.lang || navigator.language || "en",
        "X-OpenAI-Attach-Auth": "1",
        "X-OpenAI-Attach-Integrity-State": "1",
        originator: "Codex Desktop",
      },
    };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        bridge
          .sendMessageFromView({ type: "cancel-fetch", requestId })
          .catch(() => {});
        reject(
          new RefreshError("额度请求超时", {
            code: "REQUEST_TIMEOUT",
          }),
        );
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      bridge.sendMessageFromView(message).catch(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new RefreshError("Codex 内部请求桥调用失败", {
            code: "BRIDGE_FAILED",
          }),
        );
      });
    });
  }
}
