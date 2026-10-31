import { expect, test } from "bun:test";
import { planVerification, sha256 } from "../src/factory/verification-packets";
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

function largeVerification() {
  const rows=Array.from({length:8},(_,i)=>({original:{candidate_id:`candidate_${i}`},primary_audit_proposal:{candidate_id:`candidate_${i}`}}));
  const neighbors=Array.from({length:40},(_,i)=>({candidate_id:`neighbor_${i}`,row_sha256:i.toString(16).padStart(64,'0'),content:'evidence '.repeat(100)}));
  return '# SYNAPSESPEAK INDEPENDENT SECOND-PASS AUDIT VERIFICATION — BINDING\nORIGINAL SOURCE ROWS AND PRIMARY-AUDIT PROPOSALS:\n'+JSON.stringify(rows)+'\n# CONTENT-BOUND DUPLICATE REVIEW\nEmpty list only if no neighbors.\n'+JSON.stringify(Object.fromEntries(rows.map(r=>[r.original.candidate_id,neighbors])));
}
const assigned = (text:string):string[] => JSON.parse(/"assigned_candidate_ids":(\[[^\]]*\])/.exec(text)![1]!);
const validPacketRows = (text:string) => assigned(text).map(candidate_id=>JSON.stringify({candidate_id,verification_status:'PASS',reason_codes:[],duplicate_verdicts:Array.from({length:40},(_,i)=>({other_id:`neighbor_${i}`,other_sha256:i.toString(16).padStart(64,'0'),verdict:'DISTINCT',reason:'fixture evidence difference'}))})).join('\n');


test('large verification uses fresh bounded turns with one final parent result and durable packet evidence',async()=>{
 const messages:any[]=[],evidence:any[]=[],prompts:string[]=[],traces:string[]=[];
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:e=>evidence.push(e),run:async turn=>{
  const text=(await turn.prepare()).text;prompts.push(text);traces.push(turn.traceId!);
  expect(text.length).toBeLessThanOrEqual(200000);expect(turn.modelFamily).toBe('6');expect(turn.reasoning).toBe('high');expect(turn.retainConversation).toBe(false);
  await turn.onPreparedSelected!(false);await turn.onSubmitted!();
  expect(messages.filter(e=>e.type==='result'&&'text' in e)).toHaveLength(0);
  return validPacketRows(text);
 }});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('packet_001'),prompt:largeVerification()});
 for(let i=0;i<20&&!messages.some(e=>e.type==='result'&&'text' in e);i++)await settle();
 expect(prompts.length).toBeGreaterThan(1);expect(new Set(traces).size).toBe(prompts.length);
 expect(messages.filter(e=>e.event==='submitted')).toHaveLength(1);
 expect(messages.filter(e=>e.type==='result'&&'text' in e)).toHaveLength(1);
 expect(evidence.filter(e=>e.stage==='result')).toHaveLength(prompts.length);
 expect(evidence[0].stage).toBe('plan');expect(evidence.at(-1).stage).toBe('complete');
 for(let i=0;i<8;i++)expect(messages.at(-1).text).toContain(`candidate_${i}`);
 await c.shutdown();
});

test('packetized verification fails closed without an evidence sink or on incomplete response',async()=>{
 for(const missingSink of [true,false]){
  const messages:any[]=[];let calls=0;
  const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),...(missingSink?{}:{packetEvidence:()=>{}}),run:async turn=>{calls++;await turn.onSubmitted!();return '{}';}});
  await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('packet_bad'),prompt:largeVerification()});
  for(let i=0;i<10&&!messages.some(e=>e.type==='error');i++)await settle();
  expect(messages.some(e=>e.type==='result'&&'text' in e)).toBe(false);expect(messages.at(-1).type).toBe('error');expect(calls).toBe(missingSink?0:1);
  await c.shutdown();
 }
});

test('cancelling a later verification packet stops the logical request without resend or partial result',async()=>{
 const messages:any[]=[];let calls=0;
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:()=>{},run:async turn=>{
  calls++;const text=(await turn.prepare()).text;await turn.onSubmitted!();
  if(calls===1)return validPacketRows(text);
  return new Promise<string>((_resolve,reject)=>turn.abortSignal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
 }});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('packet_cancel'),prompt:largeVerification()});
 for(let i=0;i<20&&calls<2;i++)await settle();expect(calls).toBe(2);
 await c.handle({type:'cancel',id:'packet_cancel'});await settle();await c.shutdown();
 expect(calls).toBe(2);expect(messages.some(e=>e.type==='result'&&'text' in e)).toBe(false);expect(messages.some(e=>e.code==='cancelled')).toBe(true);
});

test('invalid missing-only response prevents every remaining packet',async()=>{
 const messages:any[]=[],evidence:any[]=[];let calls=0;
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:e=>evidence.push(e),run:async turn=>{
  calls++; const text=(await turn.prepare()).text; await turn.onSubmitted!();
  return assigned(text).map(candidate_id=>JSON.stringify({candidate_id,verification_status:'PASS',duplicate_verdicts:[]})).join('\n');
 }});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('packet_missing'),prompt:largeVerification()});
 for(let i=0;i<20&&!messages.some(e=>e.type==='error');i++)await settle();
 expect(calls).toBe(2);expect(messages.some(e=>e.type==='result'&&'text' in e)).toBe(false);
 expect(messages.at(-1).message).toContain('Incomplete duplicate verdict coverage');
 expect(evidence.map(e=>e.stage)).toEqual(['plan','submitted','result','supplement_plan','submitted','result','failure']);await c.shutdown();
});

test('missing-only recovery retains a single parent result and GPT6 High across fresh supplementary turns',async()=>{
 const messages:any[]=[],evidence:any[]=[];let calls=0,supplements=0;
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:e=>evidence.push(e),run:async turn=>{
  calls++;const text=(await turn.prepare()).text;expect(turn.modelFamily).toBe('6');expect(turn.reasoning).toBe('high');expect(turn.retainConversation).toBe(false);await turn.onPreparedSelected!(false);await turn.onSubmitted!();
  if(text.includes('# MISSING COMPARISONS ONLY')){supplements++;return JSON.stringify({candidate_id:'candidate_0',duplicate_verdicts:[{other_id:'neighbor_39',other_sha256:'0'.repeat(62)+'27',verdict:'DISTINCT',reason:'independent fixture evidence'}]});}
  const rows=validPacketRows(text).split('\n').map(x=>JSON.parse(x));if(calls===1)rows[0].duplicate_verdicts.pop();return rows.map(x=>JSON.stringify(x)).join('\n');
 }});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('packet_recover'),prompt:largeVerification()});
 for(let i=0;i<30&&!messages.some(e=>e.type==='result'&&'text' in e || e.type==='error');i++)await settle();
 expect(supplements).toBe(1);expect(messages.filter(e=>e.event==='submitted')).toHaveLength(1);expect(messages.filter(e=>e.type==='result'&&'text' in e)).toHaveLength(1);
 expect(evidence.some(e=>e.stage==='supplement_plan')).toBe(true);await c.shutdown();
});


test('indexed transport reuses exact legacy cache and normalizes fresh indexed decisions',async()=>{
 const messages:any[]=[],evidence:any[]=[],lookups:any[]=[];let browserCalls=0;
 const plan=planVerification(largeVerification())!;
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:e=>evidence.push(e),loadPacketResponse:(packet,family,effort)=>{
  lookups.push({packet,family,effort});
  if(packet.prompt!==plan.packets[0]!.legacyPrompt)return undefined;
  const text=validPacketRows(packet.prompt);
  return {text,sourceResponsePath:'exact-old.response.txt',sourcePromptPath:'exact-old.prompt.txt',sourceManifestSha256:'a'.repeat(64),responseSha256:sha256(text)};
 },run:async turn=>{
  browserCalls++;const text=(await turn.prepare()).text;await turn.onSubmitted!();
  expect(text).toContain('INDEXED DUPLICATE VERDICTS');
  return validPacketRows(text).split('\n').map(line=>{const row=JSON.parse(line);row.duplicate_verdicts=row.duplicate_verdicts.map((v:any,other_index:number)=>({other_index,verdict:v.verdict,reason:v.reason}));return JSON.stringify(row);}).join('\n');
 }});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('indexed_cache'),prompt:largeVerification()});
 for(let i=0;i<30&&!messages.some(e=>e.type==='result'&&'text' in e || e.type==='error');i++)await settle();
 const result=messages.find(e=>e.type==='result'&&'text' in e);expect(result).toBeDefined();expect(result.text).not.toContain('other_index');expect(result.text).toContain('other_sha256');
 expect(browserCalls).toBe(plan.packets.length-1);expect(evidence.filter(e=>e.stage==='reused')).toHaveLength(1);
 expect(lookups[0].packet.replyFormat).toBe('indexed-neighbor-verdicts/v1');expect(lookups[1].packet.replyFormat).toBeUndefined();
 expect(lookups.every(x=>x.family==='6'&&x.effort==='high')).toBe(true);await c.shutdown();
});


test('cached packet replay leaves I/O turns for helper startup and heartbeats',async()=>{
 const messages:any[]=[];let loads=0,ioObserved=false;
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:()=>{},loadPacketResponse:packet=>{
  if(loads++===0)setImmediate(()=>{ioObserved=true;});else expect(ioObserved).toBe(true);
  const text=validPacketRows(packet.prompt);
  return {text,sourceResponsePath:'cached.response',sourcePromptPath:'cached.prompt',sourceManifestSha256:'a'.repeat(64),responseSha256:sha256(text)};
 },run:async()=>{throw new Error('cached packets must not submit a browser request');}});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('cache_io_replay'),prompt:largeVerification()});
 for(let i=0;i<30&&!messages.some(e=>e.type==='result'&&'text' in e||e.type==='error');i++)await settle();
 expect(loads).toBeGreaterThan(1);expect(messages.some(e=>e.type==='error')).toBe(false);expect(messages.some(e=>e.type==='result'&&'text' in e)).toBe(true);await c.shutdown();
});


test('only uncached reviews receive bounded initial output and every complement finishes before delivery',async()=>{
 const messages:any[]=[],evidence:any[]=[],prompts:string[]=[];
 const original=planVerification(largeVerification())!;
 const c=new FactoryController({inspect:async()=>observed,close:()=>{},emit:e=>messages.push(e),packetEvidence:e=>evidence.push(e),loadPacketResponse:packet=>{
  if(packet.prompt!==original.packets[0]!.prompt)return undefined;
  const text=validPacketRows(packet.prompt);return {text,sourceResponsePath:'cached.response',sourcePromptPath:'cached.prompt',sourceManifestSha256:'a'.repeat(64),responseSha256:sha256(text)};
 },run:async turn=>{
  const text=(await turn.prepare()).text;prompts.push(text);await turn.onSubmitted!();
  expect(messages.some(e=>e.type==='result'&&'text' in e)).toBe(false);
  if(turn.traceId!.includes('_s')){
   const extra=evidence.findLast(e=>e.stage==='supplement_plan').packet;
   return extra.candidateIds.map((candidate_id:string)=>JSON.stringify({candidate_id,duplicate_verdicts:extra.neighborIdentities[candidate_id].map((ref:any)=>({other_id:ref.candidate_id,other_sha256:ref.row_sha256,verdict:'DISTINCT',reason:'offline fixture distinction'}))})).join('\n');
  }
  expect(text).toContain('# BOUNDED INITIAL COMPARISON REPLY');
  return validPacketRows(text).split('\n').map(line=>{const row=JSON.parse(line);row.duplicate_verdicts=row.duplicate_verdicts.slice(0,12);return JSON.stringify(row);}).join('\n');
 }});
 await c.handle({type:'inspect',id:'inspect1'});await c.handle({...request('bounded_uncached'),prompt:largeVerification()});
 for(let i=0;i<100&&!messages.some(e=>e.type==='result'&&'text' in e||e.type==='error');i++)await settle();
 expect(messages.some(e=>e.type==='error')).toBe(false);expect(messages.filter(e=>e.type==='result'&&'text' in e)).toHaveLength(1);
 const recorded=evidence.find(e=>e.stage==='plan').plan;
 expect(recorded.packets[0].prompt).toBe(original.packets[0]!.prompt);
 expect(recorded.packets[1].neighborIdentities).toEqual(original.packets[1]!.neighborIdentities);
 expect(evidence.filter(e=>e.stage==='reused')).toHaveLength(1);
 expect(evidence.filter(e=>e.stage==='supplement_plan')).toHaveLength(4);
 expect(prompts).toHaveLength(5);expect(evidence.at(-1).stage).toBe('complete');
 await c.shutdown();
});
