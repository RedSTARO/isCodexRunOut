import { QuotaRuntime } from "./runtime.mjs";
import { QuotaTitlebarUi } from "./ui.mjs";

const INSTANCE_KEY = "__isCodexRunOutInstanceV1";

function start() {
  if (window[INSTANCE_KEY]) return;
  const initialRoute = new URLSearchParams(location.search).get("initialRoute");
  if (
    initialRoute === "/avatar-overlay" ||
    (window.codexWindowType != null &&
      window.codexWindowType !== "electron") ||
    (document.documentElement.dataset.codexOs != null &&
      document.documentElement.dataset.codexOs !== "win32")
  ) {
    return;
  }
  const runtime = new QuotaRuntime();
  const ui = new QuotaTitlebarUi(runtime);
  const instance = {
    runtime,
    ui,
    stop() {
      ui.stop();
      runtime.stop();
      delete window[INSTANCE_KEY];
    },
  };
  Object.defineProperty(window, INSTANCE_KEY, {
    configurable: true,
    value: instance,
  });
  runtime.start();
  ui.start();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
