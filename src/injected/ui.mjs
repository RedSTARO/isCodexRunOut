import { PATCH_VERSION, POLL_PRESETS_MS } from "../core/config.mjs";
import { selectPrimaryWindow } from "../core/eta.mjs";

const ANCHOR_CLASS = "group/application-menu-top-bar";
const SLOT_ID = "is-codex-run-out-titlebar-slot";
const PANEL_ID = "is-codex-run-out-panel";

const STATUS_TEXT = {
  fresh: "最新",
  stale: "数据较旧",
  expired: "数据已过期",
  missing: "等待数据",
  offline: "离线",
  refreshing: "正在刷新",
  failed: "请求失败",
  "rate-limited": "接口限流",
  "auth-failed": "认证失效",
  incompatible: "接口不兼容",
};

function node(tag, className = null, text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function button(text, className = "icr-button") {
  const element = node("button", className, text);
  element.type = "button";
  return element;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

function formatClock(timestamp, absolute = false) {
  if (!Number.isFinite(timestamp)) return "未知";
  if (!absolute) {
    const delta = timestamp - Date.now();
    if (delta >= 0) return `${formatDuration(delta)}后`;
    return `${formatDuration(-delta)}前`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function formatRate(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%/h` : "—";
}

function etaText(estimate) {
  switch (estimate?.kind) {
    case "estimated":
      return `预计${formatDuration(estimate.remainingMs)}后耗尽`;
    case "safe-through-reset":
      return "本周期预计不会耗尽";
    case "no-consumption":
      return "无明显消耗";
    case "stale":
      return "数据过期";
    case "insufficient":
      return "数据不足";
    default:
      return "无法估算";
  }
}

function requestStatus(state) {
  if (!state.windowState.online) return "offline";
  if (state.coordinator.requestStatus !== "idle") {
    return state.coordinator.requestStatus;
  }
  if (state.compatibility.status === "incompatible") return "incompatible";
  return state.freshness;
}

function labeledControl(labelText, control, description = null) {
  const label = node("label", "icr-setting-row");
  const copy = node("span", "icr-setting-copy");
  copy.append(node("span", "icr-setting-label", labelText));
  if (description) copy.append(node("span", "icr-setting-help", description));
  label.append(copy, control);
  return label;
}

function checkbox(checked, onChange) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function select(options, selected, onChange) {
  const control = node("select", "icr-select");
  for (const [value, label] of options) {
    const option = node("option", null, label);
    option.value = String(value);
    option.selected = String(value) === String(selected);
    control.append(option);
  }
  control.addEventListener("change", () => onChange(control.value));
  return control;
}

function metric(label, value, className = "") {
  const wrapper = node("div", `icr-metric ${className}`.trim());
  wrapper.append(
    node("dt", "icr-metric-label", label),
    node("dd", "icr-metric-value", value),
  );
  return wrapper;
}

export class QuotaTitlebarUi {
  constructor(runtime) {
    this.runtime = runtime;
    this.state = runtime.getState();
    this.slot = null;
    this.widget = null;
    this.panel = null;
    this.anchor = null;
    this.mountObserver = null;
    this.resizeObserver = null;
    this.anchorDeadlineTimer = null;
    this.raf = null;
    this.unsubscribe = null;
    this.previousActiveElement = null;
    this.handleDocumentPointer = this.handleDocumentPointer.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);
    this.handleWindowBlur = this.handleWindowBlur.bind(this);
  }

  start() {
    this.unsubscribe = this.runtime.subscribe((state) => {
      this.state = state;
      this.renderWidget();
      if (this.panel && !this.panel.contains(document.activeElement)) {
        this.renderPanel();
      }
    });
    this.mountObserver = new MutationObserver(() => this.queueMount());
    this.mountObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("keydown", this.handleKeydown, true);
    window.addEventListener("resize", this.handleWindowResize);
    window.addEventListener("blur", this.handleWindowBlur);
    this.queueMount();
    this.anchorDeadlineTimer = window.setTimeout(() => {
      if (!this.slot) {
        this.runtime.setCompatibility({
          status: "incompatible",
          anchor: "missing",
          lastError: "当前版本标题栏锚点不存在，已停止注入",
        });
      }
    }, 15_000);
  }

  stop() {
    this.unsubscribe?.();
    this.mountObserver?.disconnect();
    this.resizeObserver?.disconnect();
    clearTimeout(this.anchorDeadlineTimer);
    document.removeEventListener("keydown", this.handleKeydown, true);
    document.removeEventListener("pointerdown", this.handleDocumentPointer, true);
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.closePanel();
    this.slot?.remove();
  }

  queueMount() {
    if (this.raf != null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.ensureMounted();
    });
  }

  findAnchor() {
    return [...document.querySelectorAll("div")].find((element) =>
      element.classList.contains(ANCHOR_CLASS),
    );
  }

  ensureMounted() {
    const anchor = this.findAnchor();
    if (!anchor) return;
    if (this.slot?.parentElement === anchor) {
      this.anchor = anchor;
      return;
    }
    this.resizeObserver?.disconnect();
    this.slot?.remove();
    this.anchor = anchor;
    this.slot = node("div", "icr-titlebar-slot");
    this.slot.id = SLOT_ID;
    this.slot.dataset.mode = "full";
    this.widget = button("", "icr-widget");
    this.widget.setAttribute("aria-haspopup", "dialog");
    this.widget.setAttribute("aria-expanded", "false");
    this.widget.addEventListener("pointerdown", (event) => {
      if (event.button === 0) event.preventDefault();
    });
    this.widget.addEventListener("click", () => this.togglePanel());
    this.slot.append(this.widget);
    anchor.append(this.slot);
    this.resizeObserver = new ResizeObserver(() => {
      this.updateResponsiveMode();
      this.updateSafeArea();
      this.positionPanel();
    });
    this.resizeObserver.observe(this.slot);
    clearTimeout(this.anchorDeadlineTimer);
    this.anchorDeadlineTimer = null;
    this.runtime.setCompatibility(
      this.state.compatibility.anchor === "missing"
        ? { status: "compatible", anchor: "mounted", lastError: null }
        : { anchor: "mounted" },
    );
    this.renderWidget();
    this.updateResponsiveMode();
    this.updateSafeArea();
  }

  updateResponsiveMode() {
    if (!this.slot || !this.widget || this.slot.hidden) return;
    const slotWidth = this.slot.getBoundingClientRect().width;
    const dragReserve = Math.min(160, Math.max(48, slotWidth * 0.2));
    const available = Math.max(0, slotWidth - dragReserve);
    const modes = ["full", "reset", "eta", "bar", "compact", "percent"];
    let selected = "hidden";
    for (const mode of modes) {
      this.slot.dataset.mode = mode;
      const required = Math.ceil(this.widget.getBoundingClientRect().width);
      if (required <= available) {
        selected = mode;
        break;
      }
    }
    this.slot.dataset.mode = selected;
  }

  updateSafeArea() {
    if (!this.widget || !this.anchor) return;
    const widget = this.widget.getBoundingClientRect();
    const previous = this.slot.previousElementSibling?.getBoundingClientRect();
    let left = 0;
    let right = window.innerWidth;
    const overlay = navigator.windowControlsOverlay;
    if (overlay?.visible) {
      const rect = overlay.getTitlebarAreaRect();
      left = rect.x;
      right = rect.x + rect.width;
    }
    const valid =
      this.slot.dataset.mode === "hidden" ||
      (widget.left >= Math.max(left, previous?.right ?? 0) - 1 &&
        widget.right <= right + 1);
    this.runtime.setCompatibility({ safeArea: valid ? "valid" : "invalid" });
    if (!valid) this.slot.dataset.mode = "hidden";
  }

  renderWidget() {
    if (!this.widget || !this.slot) return;
    if (!this.state.config.enabled) {
      this.slot.hidden = true;
      return;
    }
    this.slot.hidden = false;
    const snapshot = this.state.snapshot;
    const status = requestStatus(this.state);
    const primary = snapshot
      ? selectPrimaryWindow(
          snapshot.windows,
          this.state.estimates,
          this.state.config,
        )
      : null;
    this.widget.replaceChildren();

    if (!primary) {
      this.widget.append(
        node(
          "span",
          "icr-widget-empty",
          status === "incompatible" ? "额度 · 接口不兼容" : "额度 · 正在读取",
        ),
      );
      this.widget.title =
        status === "incompatible"
          ? "额度字段与当前补丁不兼容"
          : "等待 Codex 返回额度数据";
      return;
    }

    const estimate = this.state.estimates.get(primary.id);
    const name = node("span", "icr-widget-name", primary.displayName);
    const percent = node(
      "span",
      "icr-widget-percent",
      formatPercent(primary.remainingPercent),
    );
    const separator = node("span", "icr-widget-separator", "·");
    const progress = node("span", "icr-widget-progress");
    const fill = node("span", "icr-widget-progress-fill");
    fill.style.width = `${primary.remainingPercent}%`;
    progress.append(fill);
    const eta = node("span", "icr-widget-eta", etaText(estimate));
    const reset = node(
      "span",
      "icr-widget-reset",
      primary.resetsAt
        ? `${formatClock(primary.resetsAt, this.state.config.absoluteTime)}重置`
        : "重置未知",
    );
    const stateText = node(
      "span",
      `icr-widget-status icr-status-${status}`,
      STATUS_TEXT[status] ?? status,
    );
    this.widget.append(name, separator, percent);
    if (this.state.config.showProgress) this.widget.append(progress);
    if (this.state.config.showEta && this.state.config.etaEnabled) {
      this.widget.append(eta);
    }
    if (this.state.config.showReset) this.widget.append(reset);
    if (this.state.config.showStatus) this.widget.append(stateText);
    this.widget.title = `${primary.displayName}，剩余 ${formatPercent(primary.remainingPercent)}，${etaText(estimate)}`;
    this.slot.dataset.density = this.state.config.density;
    if (status === "fresh") stateText.remove();
    requestAnimationFrame(() => {
      this.updateResponsiveMode();
      this.updateSafeArea();
    });
  }

  togglePanel() {
    if (this.panel) this.closePanel();
    else this.openPanel();
  }

  openPanel() {
    if (this.panel) return;
    this.previousActiveElement = document.activeElement;
    this.panel = node("section", "icr-panel");
    this.panel.id = PANEL_ID;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Codex 额度详情");
    document.body.append(this.panel);
    this.widget?.setAttribute("aria-expanded", "true");
    this.renderPanel();
    this.positionPanel();
    document.addEventListener("pointerdown", this.handleDocumentPointer, true);
  }

  closePanel() {
    if (!this.panel) return;
    document.removeEventListener("pointerdown", this.handleDocumentPointer, true);
    this.panel.remove();
    this.panel = null;
    this.widget?.setAttribute("aria-expanded", "false");
  }

  handleDocumentPointer(event) {
    if (
      this.panel?.contains(event.target) ||
      this.widget?.contains(event.target)
    ) {
      return;
    }
    this.closePanel();
  }

  handleKeydown(event) {
    if (
      event.ctrlKey &&
      event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === "q"
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.togglePanel();
      return;
    }
    if (event.key === "Escape" && this.panel) {
      event.stopPropagation();
      this.closePanel();
    }
  }

  handleWindowResize() {
    this.updateResponsiveMode();
    this.updateSafeArea();
    this.positionPanel();
  }

  handleWindowBlur() {
    if (this.panel) this.closePanel();
  }

  positionPanel() {
    if (!this.panel) return;
    const anchor =
      this.widget && !this.slot?.hidden
        ? this.widget.getBoundingClientRect()
        : {
            left: window.innerWidth / 2,
            right: window.innerWidth / 2,
            bottom: 32,
          };
    const panel = this.panel.getBoundingClientRect();
    const margin = 8;
    const center = (anchor.left + anchor.right) / 2;
    const left = Math.max(
      margin,
      Math.min(window.innerWidth - panel.width - margin, center - panel.width / 2),
    );
    const top = Math.max(
      margin,
      Math.min(window.innerHeight - panel.height - margin, anchor.bottom + 6),
    );
    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
  }

  renderPanel() {
    if (!this.panel) return;
    const state = this.state;
    const snapshot = state.snapshot;
    this.panel.replaceChildren();

    const header = node("header", "icr-panel-header");
    const titleWrap = node("div");
    titleWrap.append(
      node("h2", "icr-panel-title", "Codex 额度"),
      node(
        "p",
        "icr-panel-subtitle",
        snapshot
          ? `${snapshot.windows.length} 个额度窗口 · ${STATUS_TEXT[requestStatus(state)] ?? requestStatus(state)}`
          : STATUS_TEXT[requestStatus(state)] ?? "等待数据",
      ),
    );
    const refresh = button(
      state.coordinator.inFlight ? "刷新中…" : "立即刷新",
      "icr-button icr-button-primary",
    );
    refresh.disabled = state.coordinator.inFlight || !state.windowState.online;
    refresh.addEventListener("click", () => {
      this.runtime.refresh("manual").catch(() => {});
      this.renderPanel();
    });
    header.append(titleWrap, refresh);
    this.panel.append(header);

    const body = node("div", "icr-panel-body");
    if (!snapshot) {
      body.append(
        node(
          "div",
          "icr-empty-state",
          state.compatibility.status === "incompatible"
            ? "当前额度接口字段不兼容，补丁已停止解析和自动预测。"
            : "尚未收到有效额度数据。补丁会先等待 Codex 自身请求，再按配置补充刷新。",
        ),
      );
    } else {
      const windows = node("div", "icr-window-list");
      for (const quotaWindow of snapshot.windows.filter(
        (entry) => !state.config.hiddenWindowIds.includes(entry.id),
      )) {
        windows.append(this.renderWindowCard(quotaWindow));
      }
      body.append(windows);
      if (snapshot.credits.length > 0) {
        body.append(this.renderCredits(snapshot.credits));
      }
    }

    body.append(this.renderDiagnostics(), this.renderSettings());
    this.panel.append(body);
    requestAnimationFrame(() => this.positionPanel());
  }

  renderWindowCard(quotaWindow) {
    const estimate = this.state.estimates.get(quotaWindow.id);
    const card = node("article", "icr-window-card");
    const top = node("div", "icr-window-top");
    const label = node("div");
    label.append(
      node("h3", "icr-window-name", quotaWindow.displayName),
      node(
        "p",
        "icr-window-id",
        quotaWindow.limitName
          ? quotaWindow.limitId || quotaWindow.bucketId
          : quotaWindow.limitId || "Codex",
      ),
    );
    top.append(
      label,
      node(
        "strong",
        "icr-window-remaining",
        `${formatPercent(quotaWindow.remainingPercent)} 剩余`,
      ),
    );
    const bar = node("div", "icr-detail-progress");
    const fill = node("div", "icr-detail-progress-fill");
    fill.style.width = `${quotaWindow.remainingPercent}%`;
    bar.append(fill);
    const metrics = node("dl", "icr-metric-grid");
    metrics.append(
      metric("已使用", formatPercent(quotaWindow.usedPercent)),
      metric(
        "周期",
        quotaWindow.durationMinutes
          ? formatDuration(quotaWindow.durationMinutes * 60_000)
          : "未知",
      ),
      metric(
        "重置",
        quotaWindow.resetsAt
          ? formatClock(quotaWindow.resetsAt, this.state.config.absoluteTime)
          : "未知",
      ),
      metric(
        "周期起点",
        estimate?.cycleStartedAt
          ? formatClock(
              estimate.cycleStartedAt,
              this.state.config.absoluteTime,
            )
          : "未知",
      ),
      metric("周期均速", formatRate(estimate?.cycleRatePercentPerHour)),
      metric(
        "周期进度",
        Number.isFinite(estimate?.elapsedPercent)
          ? formatPercent(estimate.elapsedPercent)
          : "未知",
      ),
      metric("预计耗尽", etaText(estimate), "icr-metric-wide"),
      metric("估算模型", "周期线性"),
      metric("数据来源", quotaWindow.source),
    );
    card.append(top, bar, metrics);
    return card;
  }

  renderCredits(credits) {
    const section = node("section", "icr-section");
    section.append(node("h3", "icr-section-title", "Credits"));
    const list = node("div", "icr-credit-list");
    for (const credit of credits) {
      const row = node("div", "icr-credit-row");
      row.append(
        node(
          "span",
          null,
          credit.limitName || credit.bucketId || "Codex Credits",
        ),
        node(
          "strong",
          null,
          credit.unlimited
            ? "无限"
            : credit.balance != null
              ? credit.balance
              : credit.hasCredits
                ? "可用"
                : "不可用",
        ),
      );
      list.append(row);
    }
    section.append(list);
    return section;
  }

  renderDiagnostics() {
    const state = this.state;
    const details = node("details", "icr-disclosure");
    const summary = node("summary", "icr-disclosure-summary", "兼容性与轮询诊断");
    const grid = node("dl", "icr-diagnostic-grid");
    const source = state.snapshot?.source ?? "尚无";
    const backoffUntil =
      state.coordinator.rateLimitedUntil ?? state.coordinator.backoffUntil;
    grid.append(
      metric("Codex Desktop", state.appVersion),
      metric("补丁版本", PATCH_VERSION),
      metric("兼容状态", state.compatibility.status),
      metric("标题栏注入", state.compatibility.anchor),
      metric("标题栏安全区", state.compatibility.safeArea),
      metric("额度 Hook", state.compatibility.dataHook),
      metric("数据来源", source),
      metric("历史存储", state.compatibility.history),
      metric(
        "配置轮询",
        state.config.pollIntervalMs
          ? formatDuration(state.config.pollIntervalMs)
          : "关闭",
      ),
      metric(
        "补充实际轮询",
        state.actualPollIntervalMs
          ? formatDuration(state.actualPollIntervalMs)
          : "尚无样本",
      ),
      metric("共享轮询角色", state.isLeader ? "Leader" : "Follower"),
      metric(
        "后台降频",
        state.config.backgroundThrottle ? "启用" : "关闭",
      ),
      metric("请求状态", STATUS_TEXT[requestStatus(state)] ?? requestStatus(state)),
      metric("失败次数", String(state.coordinator.failureCount)),
      metric(
        "退避",
        backoffUntil && Number.isFinite(backoffUntil)
          ? formatClock(backoffUntil)
          : "否",
      ),
      metric(
        "上次刷新",
        state.coordinator.lastAttemptAt
          ? formatClock(state.coordinator.lastAttemptAt)
          : "无",
      ),
      metric(
        "上次成功",
        state.coordinator.lastSuccessAt || state.snapshot?.receivedAt
          ? formatClock(
              state.coordinator.lastSuccessAt ?? state.snapshot.receivedAt,
            )
          : "无",
      ),
      metric(
        "下次计划",
        state.nextPlannedAt ? formatClock(state.nextPlannedAt) : "未计划",
      ),
      metric(
        "最近错误",
        state.coordinator.lastError?.code ??
          state.compatibility.lastError ??
          "无",
        "icr-metric-wide",
      ),
    );
    details.append(summary, grid);
    return details;
  }

  renderSettings() {
    const config = this.state.config;
    const details = node("details", "icr-disclosure");
    details.append(node("summary", "icr-disclosure-summary", "显示与刷新设置"));
    const settings = node("div", "icr-settings");

    settings.append(
      labeledControl(
        "启用标题栏组件",
        checkbox(config.enabled, (enabled) =>
          this.runtime.updateConfig({ enabled }),
        ),
        "关闭后可用 Ctrl+Alt+Q 重新打开设置",
      ),
      labeledControl(
        "显示密度",
        select(
          [
            ["standard", "标准"],
            ["compact", "紧凑"],
          ],
          config.density,
          (density) => this.runtime.updateConfig({ density }),
        ),
      ),
      labeledControl(
        "主额度选择",
        select(
          [
            ["auto", "自动选择最先耗尽"],
            ["fixed", "固定额度"],
          ],
          config.primaryMode,
          (primaryMode) => this.runtime.updateConfig({ primaryMode }),
        ),
      ),
    );

    const windowOptions = (this.state.snapshot?.windows ?? []).map((entry) => [
      entry.id,
      entry.displayName,
    ]);
    if (windowOptions.length > 0) {
      settings.append(
        labeledControl(
          "固定显示额度",
          select(
            [["", "未指定"], ...windowOptions],
            config.fixedWindowId ?? "",
            (fixedWindowId) =>
              this.runtime.updateConfig({
                fixedWindowId: fixedWindowId || null,
              }),
          ),
        ),
      );
      const visibility = node("fieldset", "icr-window-visibility");
      visibility.append(node("legend", null, "详情中显示的额度窗口"));
      for (const [id, label] of windowOptions) {
        const row = node("label", "icr-check-row");
        row.append(
          checkbox(!config.hiddenWindowIds.includes(id), (shown) => {
            const hidden = new Set(config.hiddenWindowIds);
            if (shown) hidden.delete(id);
            else hidden.add(id);
            this.runtime.updateConfig({ hiddenWindowIds: [...hidden] });
          }),
          node("span", null, label),
        );
        visibility.append(row);
      }
      settings.append(visibility);
    }

    for (const [key, label] of [
      ["showProgress", "显示进度条"],
      ["showEta", "显示预计耗尽"],
      ["showReset", "显示重置时间"],
      ["showStatus", "显示数据状态"],
      ["etaEnabled", "启用 ETA"],
      ["absoluteTime", "使用绝对时间"],
    ]) {
      settings.append(
        labeledControl(
          label,
          checkbox(config[key], (value) =>
            this.runtime.updateConfig({ [key]: value }),
          ),
        ),
      );
    }

    const pollOptions = POLL_PRESETS_MS.map((milliseconds) => [
      milliseconds,
      milliseconds === 0 ? "关闭" : formatDuration(milliseconds),
    ]);
    const pollPreset = POLL_PRESETS_MS.includes(config.pollIntervalMs)
      ? config.pollIntervalMs
      : "custom";
    const pollSelect = select(
      [...pollOptions, ["custom", "自定义"]],
      pollPreset,
      (value) => {
        if (value !== "custom") {
          this.runtime.updateConfig({ pollIntervalMs: Number(value) });
        }
      },
    );
    settings.append(labeledControl("补充轮询周期", pollSelect));

    const customPoll = node("input", "icr-input");
    customPoll.type = "number";
    customPoll.min = "30";
    customPoll.max = "86400";
    customPoll.step = "1";
    customPoll.value = String(Math.round(config.pollIntervalMs / 1_000));
    customPoll.addEventListener("change", () => {
      const seconds = Number(customPoll.value);
      if (!Number.isFinite(seconds) || seconds < 30 || seconds > 86_400) {
        customPoll.setCustomValidity("请输入 30 到 86400 秒");
        customPoll.reportValidity();
        return;
      }
      customPoll.setCustomValidity("");
      this.runtime.updateConfig({ pollIntervalMs: seconds * 1_000 });
    });
    settings.append(
      labeledControl(
        "自定义轮询（秒）",
        customPoll,
        "最短 30 秒，最长 24 小时；修改立即生效",
      ),
      labeledControl(
        "后台降频",
        checkbox(config.backgroundThrottle, (backgroundThrottle) =>
          this.runtime.updateConfig({ backgroundThrottle }),
        ),
      ),
    );

    const multiplier = node("input", "icr-input");
    multiplier.type = "number";
    multiplier.min = "1";
    multiplier.max = "100";
    multiplier.step = "0.5";
    multiplier.value = String(config.backgroundMultiplier);
    multiplier.addEventListener("change", () => {
      const value = Number(multiplier.value);
      if (value >= 1 && value <= 100) {
        this.runtime.updateConfig({ backgroundMultiplier: value });
      }
    });
    const backgroundFixed = node("input", "icr-input");
    backgroundFixed.type = "number";
    backgroundFixed.min = "30";
    backgroundFixed.max = "86400";
    backgroundFixed.step = "1";
    backgroundFixed.placeholder = "按倍率";
    backgroundFixed.value =
      config.backgroundIntervalMs == null
        ? ""
        : String(Math.round(config.backgroundIntervalMs / 1_000));
    backgroundFixed.addEventListener("change", () => {
      if (backgroundFixed.value.trim() === "") {
        backgroundFixed.setCustomValidity("");
        this.runtime.updateConfig({ backgroundIntervalMs: null });
        return;
      }
      const seconds = Number(backgroundFixed.value);
      if (!Number.isFinite(seconds) || seconds < 30 || seconds > 86_400) {
        backgroundFixed.setCustomValidity("请输入 30 到 86400 秒，或留空");
        backgroundFixed.reportValidity();
        return;
      }
      backgroundFixed.setCustomValidity("");
      this.runtime.updateConfig({ backgroundIntervalMs: seconds * 1_000 });
    });
    settings.append(
      labeledControl("后台降频倍率", multiplier),
      labeledControl(
        "后台固定周期（秒）",
        backgroundFixed,
        "留空时使用后台降频倍率；固定周期优先",
      ),
      labeledControl(
        "窗口隐藏时暂停",
        checkbox(config.pauseWhenHidden, (pauseWhenHidden) =>
          this.runtime.updateConfig({ pauseWhenHidden }),
        ),
        "当前版本用 Chromium visibility 状态判断最小化/隐藏",
      ),
      labeledControl(
        "网络恢复后刷新",
        checkbox(config.refreshOnOnline, (refreshOnOnline) =>
          this.runtime.updateConfig({ refreshOnOnline }),
        ),
      ),
      labeledControl(
        "启动后立即刷新",
        checkbox(config.refreshOnStartup, (refreshOnStartup) =>
          this.runtime.updateConfig({ refreshOnStartup }),
        ),
      ),
    );

    const timeout = node("input", "icr-input");
    timeout.type = "number";
    timeout.min = "3";
    timeout.max = "120";
    timeout.value = String(config.requestTimeoutMs / 1_000);
    timeout.addEventListener("change", () => {
      const seconds = Number(timeout.value);
      if (seconds >= 3 && seconds <= 120) {
        this.runtime.updateConfig({ requestTimeoutMs: seconds * 1_000 });
      }
    });
    const retention = node("input", "icr-input");
    retention.type = "number";
    retention.min = "1";
    retention.max = "365";
    retention.value = String(config.historyRetentionDays);
    retention.addEventListener("change", () => {
      const days = Number(retention.value);
      if (days >= 1 && days <= 365) {
        this.runtime.updateConfig({ historyRetentionDays: days });
      }
    });
    settings.append(
      labeledControl("请求超时（秒）", timeout),
      labeledControl("历史保留（天）", retention),
      labeledControl(
        "调试日志",
        checkbox(config.debugLogging, (debugLogging) =>
          this.runtime.updateConfig({ debugLogging }),
        ),
        "默认关闭；仅记录脱敏状态码，不记录请求或响应正文",
      ),
    );

    const actions = node("div", "icr-setting-actions");
    const clear = button("清空历史");
    clear.addEventListener("click", () => {
      this.runtime.clearHistory();
      this.renderPanel();
    });
    const reset = button("恢复默认设置");
    reset.addEventListener("click", () => {
      this.runtime.resetConfig();
      this.renderPanel();
    });
    actions.append(clear, reset);
    settings.append(actions);
    details.append(settings);
    return details;
  }
}
