import { expect, test } from "bun:test";
import { inspectFactorySession, type FactoryInspectionDependencies } from "../src/factory/inspection";

function fixture() {
  const calls: any[] = [];
  const page = { url: () => "about:blank", goto: async (...args: any[]) => { calls.push(["goto", ...args]); }, locator: () => ({ filter: () => ({ waitFor: async () => { calls.push(["composer"]); } }) }) };
  const deps: FactoryInspectionDependencies = {
    notify: async (_path, activity) => { calls.push(["notify", activity]); return activity.phase === "start" ? { surfaceId: "s".repeat(32), reused: false } : {}; },
    connect: async (...args) => { calls.push(["connect", ...args]); return { page, browser: { close: async () => { calls.push(["close"]); } } } as any; },
    authenticate: async p => { expect(p).toBe(page as any); calls.push(["auth"]); },
    assertFresh: async (p, temporary) => { expect(p).toBe(page as any); expect(temporary).toBe(false); calls.push(["fresh"]); },
    capabilities: async p => { expect(p).toBe(page as any); calls.push(["capabilities"]); return { solAvailable: true, extraHighAvailable: false, proAvailable: false }; },
  };
  return { calls, deps };
}
test("inspection connects only the new lease, checks it, disconnects and releases", async () => {
  const f = fixture();
  expect(await inspectFactorySession("descriptor", f.deps)).toEqual({ authenticated: true, newChat: true, solAvailable: true, extraHighAvailable: false, proAvailable: false });
  expect(f.calls.find(c => c[0] === "connect")[3]).toBe("s".repeat(32));
  const activities = f.calls.filter(c => c[0] === "notify").map(c => c[1]);
  expect(activities[0].phase).toBe("start"); expect(activities[0].conversationKey).toBeUndefined();
  expect(activities.at(-1)).toMatchObject({ phase: "end", status: "completed", retain: false, traceId: activities[0].traceId, helperPid: process.pid });
  expect(f.calls.at(-2)[0]).toBe("close");
});
test("inspection failure preserves source and always disconnects/releases", async () => {
  const f = fixture(); const failure = new Error("capability selector failed");
  f.deps.capabilities = async () => { throw failure; };
  await expect(inspectFactorySession("descriptor", f.deps)).rejects.toBe(failure);
  expect(f.calls.at(-2)[0]).toBe("close"); expect(f.calls.at(-1)[1]).toMatchObject({ phase: "end", status: "failed", retain: false });
});
test("connection failure still releases acquired lease", async () => {
  const f = fixture(); f.deps.connect = async () => { throw new Error("connect failed"); };
  await expect(inspectFactorySession("descriptor", f.deps)).rejects.toThrow("connect failed");
  expect(f.calls.at(-1)[1]).toMatchObject({ phase: "end", status: "failed" });
});
test("reused or missing surface never reaches connection/default page", async () => {
  for (const lease of [{ surfaceId: "s".repeat(32), reused: true }, { reused: false }]) {
    const f = fixture(); f.deps.notify = async (_path, activity) => { f.calls.push(["notify", activity]); return activity.phase === "start" ? lease : {}; };
    await expect(inspectFactorySession("descriptor", f.deps)).rejects.toThrow();
    expect(f.calls.some(c => c[0] === "connect")).toBe(false);
    expect(f.calls.at(-1)[1].phase).toBe("end");
  }
});
test("disconnect failure still releases and prevents successful inspection", async () => {
  const f = fixture(); const connect = f.deps.connect;
  f.deps.connect = async (...args) => { const c = await connect(...args); c.browser.close = async () => { throw new Error("disconnect failed"); }; return c; };
  await expect(inspectFactorySession("descriptor", f.deps)).rejects.toThrow("disconnect failed");
  expect(f.calls.at(-1)[1].phase).toBe("end");
});
test("acquisition failure never opens a connection", async () => {
  const f = fixture(); f.deps.notify = async () => { throw new Error("lease unavailable"); };
  await expect(inspectFactorySession("descriptor", f.deps)).rejects.toThrow("lease unavailable");
  expect(f.calls).toEqual([]);
});
test("release failure cannot become a successful inspection", async () => {
  const f = fixture(); const notify = f.deps.notify;
  f.deps.notify = async (...args) => { if (args[1].phase === "end") throw new Error("release failed"); return notify(...args); };
  await expect(inspectFactorySession("descriptor", f.deps)).rejects.toThrow("release failed");
  expect(f.calls.at(-1)[0]).toBe("close");
});
test("observation timeout cancels capability probe and releases within its bound", async () => {
  const f = fixture(); let signal: AbortSignal | undefined;
  f.deps.capabilities = async (_page, options) => {
    signal = options!.signal;
    return new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); });
  };
  await expect(inspectFactorySession("descriptor", f.deps, { timeoutMs: 20 })).rejects.toMatchObject({ code: "inspection_timeout" });
  expect(signal!.aborted).toBe(true);
  expect(f.calls.at(-1)[1]).toMatchObject({ phase: "end", status: "failed" });
});
test("caller cancellation closes connection and releases its exact owner", async () => {
  const f = fixture(); const abort = new AbortController();
  f.deps.capabilities = async (_page, options) => {
    abort.abort(new Error("caller cancelled"));
    options!.signal!.throwIfAborted();
    throw new Error("unreachable");
  };
  await expect(inspectFactorySession("descriptor", f.deps, { signal: abort.signal })).rejects.toThrow("caller cancelled");
  expect(f.calls.at(-2)[0]).toBe("close");
  expect(f.calls.at(-1)[1]).toMatchObject({ phase: "end", status: "failed", traceId: f.calls[0][1].traceId });
});
