import { randomUUID } from "node:crypto";
import {
  connectLauncherBrowserHost, notifyLauncherTurn,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  type LauncherBrowserConnection,
} from "../launcher-browser-host";
import {
  assertAuthenticatedChatGptPage, assertNewChatPage, chatGptNewChatUrl,
  detectChatGptAccountCapabilities, waitForChatGptEffortControl, readChatGptEffortCapabilities,
} from "../chatgpt-session";
import { activateChatGptEffortMenu } from "../chatgpt-ui/model-picker";
import { CHATGPT_COMPOSER_SELECTOR } from "../chatgpt-ui/composer";
import type { FactoryInspection } from "./controller";

export interface FactoryInspectionDependencies {
  notify: typeof notifyLauncherTurn;
  connect: typeof connectLauncherBrowserHost;
  authenticate: typeof assertAuthenticatedChatGptPage;
  assertFresh: typeof assertNewChatPage;
  capabilities: typeof detectChatGptAccountCapabilities;
}
const dependencies: FactoryInspectionDependencies = {
  notify: notifyLauncherTurn, connect: connectLauncherBrowserHost,
  authenticate: assertAuthenticatedChatGptPage, assertFresh: assertNewChatPage,
  capabilities: async (page, options) => {
    process.stderr.write("[factory-inspection] stage=capability_control\n");
    const control = await waitForChatGptEffortControl(page, options);
    if (!control) return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
    process.stderr.write("[factory-inspection] stage=capability_menu\n");
    // Leased surfaces use the same owned-menu activation as real browser turns.
    const surface = await activateChatGptEffortMenu(page, control);
    try {
      process.stderr.write("[factory-inspection] stage=capability_range\n");
      return await readChatGptEffortCapabilities(surface, options);
    } finally { await page.keyboard.press("Escape").catch(() => {}); }
  },
};

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** At most 25s observation plus 5s cleanup. Never connects to the default surface. */
export async function inspectFactorySession(
  descriptorPath: string,
  deps: FactoryInspectionDependencies = dependencies,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FactoryInspection> {
  const timeoutMs = Math.min(options.timeoutMs ?? 25_000, 25_000);
  const started = Date.now();
  let current = "lease_start";
  const stage = (name: string) => {
    current = name;
    process.stderr.write(`[factory-inspection] stage=${name} elapsed_ms=${Date.now() - started}\n`);
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new DOMException("Factory inspection cancelled", "AbortError"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error(`Factory inspection timed out at ${current}`), { code: "inspection_timeout" })), timeoutMs);
  const signal = controller.signal;
  const owner = { traceId: `factory_inspect_${randomUUID().replaceAll("-", "")}`, helperPid: process.pid };
  let connection: LauncherBrowserConnection | undefined;
  let completed = false;
  let failed = false;
  let heartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    signal.throwIfAborted();
    stage("lease_start");
    const lease = await abortable(deps.notify(descriptorPath, { phase: "start", ...owner }, timeoutMs, signal), signal);
    if (!lease.surfaceId || lease.reused !== false) throw new Error("Factory inspection requires a fresh leased browser surface");
    timer = setInterval(() => {
      if (heartbeat || signal.aborted) return;
      heartbeat = deps.notify(descriptorPath, { phase: "heartbeat", ...owner }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS, signal)
        .then(() => {}, error => { controller.abort(error); })
        .finally(() => { heartbeat = undefined; });
    }, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
    stage("connect");
    connection = await abortable(deps.connect(descriptorPath, Math.min(timeoutMs, 20_000), lease.surfaceId, signal).then(async value => {
      if (signal.aborted) { await value.browser.close(); throw signal.reason; }
      return value;
    }), signal);
    if (!connection) throw new Error("Factory inspection did not obtain its leased connection");
    const { page } = connection;
    const result = await abortable((async () => {
      stage("navigate");
      await page.goto(chatGptNewChatUrl(false), { waitUntil: "domcontentloaded", timeout: timeoutMs });
      stage("composer");
      await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).waitFor({ state: "visible", timeout: timeoutMs });
      stage("authenticate"); await deps.authenticate(page);
      stage("fresh"); await deps.assertFresh(page, false);
      stage("capabilities");
      const capabilities = await deps.capabilities(page, { signal, selectorTimeoutMs: timeoutMs });
      signal.throwIfAborted();
      completed = true;
      return capabilities;
    })(), signal);
    return { authenticated: true, newChat: true, solAvailable: result.solAvailable === true,
      extraHighAvailable: result.extraHighAvailable === true, proAvailable: result.proAvailable === true };
  } catch (error) {
    failed = true;
    process.stderr.write(`[factory-inspection] stage=${current} outcome=${signal.aborted ? "aborted" : "failed"} elapsed_ms=${Date.now() - started}\n`);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (timer) clearInterval(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.abort(new DOMException("Factory inspection finished", "AbortError"));
    const cleanupErrors: unknown[] = [];
    stage("disconnect");
    try { await abortable(Promise.all([connection?.browser.close(), heartbeat]), AbortSignal.timeout(2_000)); } catch (error) { cleanupErrors.push(error); }
    stage("lease_end");
    const releaseSignal = AbortSignal.timeout(3_000);
    try {
      await abortable(deps.notify(descriptorPath, { phase: "end", ...owner,
        status: completed && cleanupErrors.length === 0 ? "completed" : "failed", retain: false }, 3_000, releaseSignal), releaseSignal);
    } catch (error) { cleanupErrors.push(error); }
    stage("finished");
    if (!failed && cleanupErrors.length) throw cleanupErrors[0];
  }
}
