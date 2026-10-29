import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { format } from "node:util";
import { loadConfig, providerConfig } from "../config";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";
import { VERSION } from "../version";
import { FactoryController } from "./controller";
import { inspectFactorySession } from "./inspection";

/** Browser-only, exact-text JSONL transport. Never saves global configuration. */
export async function runFactoryMain(args: string[]): Promise<void> {
  const options = new Map<string, string>();
  while (args.length) {
    const name = args.shift()!;
    if (!["--browser-helper", "--diagnostics-dir"].includes(name) || options.has(name)) throw new Error("Invalid factory option");
    const value = args.shift();
    if (!value || !isAbsolute(value)) throw new Error(`${name} requires an absolute path`);
    options.set(name, value);
  }
  const config = loadConfig();
  if (config.browserHost !== "launcher" || config.browserInteractionMode !== "automatic") throw new Error("Factory mode requires the automatic launcher browser service");
  // Source runs must name a newly built helper; never fall back to an older installed helper.
  const helper = options.get("--browser-helper") ?? join(import.meta.dir, "browser-helper.cjs");
  if (!existsSync(helper)) throw new Error("Factory browser helper is missing; build the runtime or supply --browser-helper");
  const provider = providerConfig(config);
  provider.chatgptWeb = {
    ...provider.chatgptWeb!, localToolsEnabled: false, autoApproveToolCalls: false,
    useTemporaryChats: false, browserHelperScriptPath: resolve(helper),
    ...(options.has("--diagnostics-dir") ? { browserDiagnosticsPath: options.get("--diagnostics-dir")! } : {}),
  };
  const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const diagnostic = (...values: unknown[]) => { process.stderr.write(format(...values) + "\n"); };
  Object.assign(console, { log: diagnostic, info: diagnostic, warn: diagnostic, error: diagnostic, debug: diagnostic });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const controller = new FactoryController({
    inspect: signal => inspectFactorySession(provider.chatgptWeb!.browserHostDescriptorPath!, undefined, { signal }), run: turn => worker.run(turn),
    close: () => closeChatGptBrowserWorkers(), emit: write,
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => { lines.close(); void controller.shutdown(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    write({ type: "ready", protocol: "triplet-factory/v1", version: VERSION });
    for await (const line of lines) {
      let message: unknown;
      try {
        if (line.length > 1200000) throw new Error("Factory request too large");
        message = JSON.parse(line);
      } catch {
        write({ type: "error", id: "invalid", code: "invalid_json", message: "Invalid factory JSON request" });
        continue;
      }
      await controller.handle(message);
      if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown" && Object.keys(message).length === 1) break;
    }
  } finally {
    lines.close();
    await controller.shutdown();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    Object.assign(console, saved);
  }
}
