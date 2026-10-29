import { expect, test } from "bun:test";
import { FactoryController } from "../src/factory/controller";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const observed = { authenticated: true, newChat: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const request = (id = "turn_001") => ({ type: "run", id, prompt: "  exact\n ", modelFamily: "6", reasoning: "high" });
function fixture(autoSubmit = false) {
  const events: any[] = [];
  const turns: BrowserTurn[] = [];
  const pending: { resolve: (s: string) => void; reject: (e: unknown) => void }[] = [];
  let closed = 0;
  const controller = new FactoryController({ inspect: async () => observed, run: turn => { turns.push(turn); if (autoSubmit) void turn.onSubmitted?.(); return new Promise<string>((resolve, reject) => pending.push({ resolve, reject })); }, close: async () => { closed++; }, emit: e => { events.push(e); } });
  return { controller, events, turns, pending, closed: () => closed };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
test("strict requests fail closed; inspection gates run", async () => {
  const f = fixture();
  await f.controller.handle(request());
  expect(f.turns).toHaveLength(0);
  for (const extra of [{ tools: [] }, { context: "x" }, { instructions: "x" }, { prompt: "" }, { prompt: "x".repeat(200001) }, { id: "bad" }, { reasoning: "extra_high" }]) await f.controller.handle({ ...request(), ...extra });
  expect(f.turns).toHaveLength(0);
  expect(f.events.every(e => e.type === "error")).toBe(true);
  expect(JSON.stringify(f.events)).not.toContain("exact");
  await f.controller.shutdown();
});
test("raw fresh turn, lifecycle events, completion only after browser resolves", async () => {
  const f = fixture();
  await f.controller.handle({ type: "inspect", id: "inspect1" });
  expect(f.events[0]).toEqual({ type: "result", id: "inspect1", value: observed });
  await f.controller.handle(request());
  await settle();
  const t = f.turns[0]!;
  expect((await t.prepare()).text).toBe(request().prompt);
  expect((await t.prepare()).images).toEqual([]);
  expect(t.nativeConnector).toBe(false);
  expect(t.retainConversation).toBe(false);
  expect(t.modelFamily).toBe("6");
  await t.onPreparedSelected!(false); await t.onSendActivated!(); await t.onSubmitted!();
  t.onTextDelta("partial");
  expect(f.events.filter(e => e.type === "result" && "text" in e)).toHaveLength(0);
  f.pending[0]!.resolve("complete"); await settle();
  expect(f.events.at(-1)).toEqual({ type: "result", id: "turn_001", text: "complete" });
  await f.controller.handle(request());
  expect(f.turns).toHaveLength(1);
  await f.controller.shutdown();
});
test("three slots, cancel race, and shutdown await actual jobs", async () => {
  const f = fixture(true); await f.controller.handle({ type: "inspect", id: "inspect1" });
  for (let i = 0; i < 4; i++) await f.controller.handle(request(`turn_00${i}`));
  await settle();
  expect(f.turns).toHaveLength(3);
  await f.controller.handle({ type: "cancel", id: "turn_000" });
  expect(f.turns[0]!.abortSignal!.aborted).toBe(true);
  expect(() => f.turns[0]!.onSubmitted!()).toThrow();
  f.pending[0]!.resolve("late"); await settle();
  const shutting = f.controller.shutdown();
  expect(f.closed()).toBe(0);
  f.pending[1]!.resolve("late"); f.pending[2]!.resolve("late");
  await shutting;
  expect(f.closed()).toBe(1);
  expect(f.events.some(e => e.type === "result" && "text" in e)).toBe(false);
  await f.controller.shutdown(); expect(f.closed()).toBe(1);
});
test("reject reused conversation and preserve browser failures", async () => {
  const f = fixture(); await f.controller.handle({ type: "inspect", id: "inspect1" }); await f.controller.handle(request()); await settle();
  expect(() => f.turns[0]!.onPreparedSelected!(true)).toThrow();
  f.pending[0]!.reject(Object.assign(new Error("selector failed"), { code: "selector_failure" })); await settle();
  expect(f.events.at(-1)).toMatchObject({ type: "error", message: "selector failed", code: "selector_failure" });
  await f.controller.shutdown();
});
test("failed and unauthenticated inspection never authorizes a run", async () => {
  for (const inspect of [async () => ({ ...observed, authenticated: false }), async () => { throw Object.assign(new Error("inspection failed"), { code: "inspect_failed" }); }]) {
    const events: any[] = []; let runs = 0;
    const c = new FactoryController({ inspect, run: async () => { runs++; return "bad"; }, close: async () => {}, emit: e => { events.push(e); } });
    await c.handle({ type: "inspect", id: "inspect1" }); await c.handle(request());
    expect(runs).toBe(0); expect(events.at(-1).code).toBe("inspection_required"); await c.shutdown();
  }
});
test("shutdown waits for inspection and prevents late authorization", async () => {
  let resolve!: (v: typeof observed) => void; let closed = false; const events: any[] = [];
  const c = new FactoryController({ inspect: () => new Promise(r => { resolve = r; }), run: async () => "bad", close: async () => { closed = true; }, emit: e => { events.push(e); } });
  const inspecting = c.handle({ type: "inspect", id: "inspect1" }); await settle();
  const closing = c.shutdown(); expect(closed).toBe(false);
  resolve(observed); await inspecting; await closing;
  expect(closed).toBe(true); expect(events).toEqual([]);
  await c.handle(request()); expect(events.at(-1).code).toBe("shutdown");
});
test("bounded configuration rejects unsupported limits", () => {
  for (const maxConcurrent of [0, 4, 1.5, NaN]) expect(() => new FactoryController({ inspect: async () => observed, run: async () => "", close: () => {}, emit: () => {}, maxConcurrent })).toThrow();
});
test("shutdown aborts the signal owned by an active inspection", async () => {
  let signal: AbortSignal | undefined;
  const c = new FactoryController({ inspect: async s => { signal = s; return new Promise((_resolve, reject) => s!.addEventListener("abort", () => reject(s!.reason), { once: true })); }, run: async () => "", close: () => {}, emit: () => {} });
  const inspecting = c.handle({ type: "inspect", id: "inspect1" }); await settle();
  await c.shutdown(); await inspecting;
  expect(signal!.aborted).toBe(true);
});


test("preparation is serialized until submission while responses remain concurrent", async () => {
  const f = fixture(); await f.controller.handle({type:'inspect', id:'inspect1'});
  for (let i=1;i<=3;i++) await f.controller.handle(request(`serial_00${i}`));
  await settle(); expect(f.turns).toHaveLength(1);
  await f.turns[0]!.onSubmitted!(); await settle(); expect(f.turns).toHaveLength(2);
  await f.turns[1]!.onSubmitted!(); await settle(); expect(f.turns).toHaveLength(3);
  expect(f.events.filter(e=>e.type==='result' && 'text' in e)).toHaveLength(0);
  for (const p of f.pending) p.resolve('complete');
  await settle(); await f.controller.shutdown();
});


test("cancelling queued preparation never starts its browser job or blocks shutdown", async () => {
  const f = fixture(); await f.controller.handle({type:'inspect', id:'inspect1'});
  await f.controller.handle(request('queued_001')); await f.controller.handle(request('queued_002'));
  await settle(); await f.controller.handle({type:'cancel', id:'queued_002'}); await settle();
  expect(f.turns).toHaveLength(1);
  await f.turns[0]!.onSubmitted!(); await settle(); expect(f.turns).toHaveLength(1);
  f.pending[0]!.resolve('complete'); await settle(); await f.controller.shutdown();
  expect(f.events.some(e=>e.id==='queued_002' && e.code==='cancelled')).toBe(true);
});


test("Extra High requires observed capability and reaches the exact browser effort", async () => {
  const f = fixture(); await f.controller.handle({type:'inspect',id:'inspect1'});
  await f.controller.handle({...request('extra_001'),reasoning:'xhigh'}); await settle();
  expect(f.turns).toHaveLength(0); expect(f.events.at(-1).code).toBe('effort_unavailable');
  let effort = ''; const c = new FactoryController({inspect:async()=>({...observed,extraHighAvailable:true}),run:async t=>{effort=t.reasoning!; return 'done';},close:()=>{},emit:()=>{}});
  await c.handle({type:'inspect',id:'inspect1'}); await c.handle({...request(),reasoning:'xhigh'}); await settle();
  expect(effort).toBe('xhigh'); await c.shutdown(); await f.controller.shutdown();
});
