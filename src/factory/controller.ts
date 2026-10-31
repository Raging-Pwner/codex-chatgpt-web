import type { SavedVerificationResponse } from "./verification-evidence";
import { z } from "zod";
import { planVerification, partitionInitialComparisonContext, scheduleInitialComparisonReply, completePacketResponse, mergePacketResponses, LOGICAL_PROMPT_LIMIT, PHYSICAL_PROMPT_LIMIT, sha256, type VerificationPlan, type VerificationPacket } from "./verification-packets";
import type { BrowserTurn } from "../adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_BACKEND_MODEL } from "../chatgpt-web-models";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{6,128}$/);
const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect"), id: idSchema }).strict(),
  z.object({ type: z.literal("run"), id: idSchema, prompt: z.string().min(1).max(LOGICAL_PROMPT_LIMIT), modelFamily: z.enum(["5.6", "6"]), reasoning: z.enum(["high", "xhigh"]) }).strict(),
  z.object({ type: z.literal("cancel"), id: idSchema }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);
const inspectionSchema = z.object({ authenticated: z.boolean(), newChat: z.boolean(), solAvailable: z.boolean(), extraHighAvailable: z.boolean(), proAvailable: z.boolean() });
export type FactoryInspection = z.infer<typeof inspectionSchema>;
export type FactoryMessage = { type: "result"; id: string; text: string } | { type: "result"; id: string; value: FactoryInspection } | { type: "error"; id: string; message: string; code: string } | { type: "event"; id: string; event: string; text?: string; reused?: boolean; continuation?: boolean };
export type PacketEvidence = { stage:"supplement_plan"; logicalId:string; packet:VerificationPacket; packetTraceId:string; packetIndex:number; sourceResponseSha256:string } | { stage: "plan"; logicalId: string; plan: VerificationPlan; packetTraceIds: string[]; modelFamily: "5.6" | "6"; reasoning: "high" | "xhigh" } | { stage: "submitted" | "result" | "failure" | "complete" | "reused" | "quarantined"; logicalId: string; packetIndex?: number; packetTraceId?: string; text?: string; message?: string; responseSha256?: string; reuseSource?: Omit<SavedVerificationResponse,"text"> };
export interface FactoryControllerOptions {
  inspect: (signal?: AbortSignal) => Promise<FactoryInspection>;
  run: (turn: BrowserTurn) => Promise<string>;
  close: () => void | Promise<void>;
  emit: (message: FactoryMessage) => void;
  maxConcurrent?: number;
  serializeBrowserTurns?: boolean;
  packetEvidence?: (record: PacketEvidence) => void;
  loadPacketResponse?: (packet:VerificationPacket,family:string,effort:string,sourceResponseSha256?:string)=>SavedVerificationResponse|undefined;
}

/** Owns only injected worker jobs. The stdio reader must continue reading after handle(run). */
export class FactoryController {
  private readonly used = new Set<string>();
  private readonly jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly inspections = new Set<Promise<void>>();
  private readonly inspectionControllers = new Set<AbortController>();
  private observed?: FactoryInspection;
  private stopped = false;
  private preparationTail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly limit: number;
  constructor(private readonly options: FactoryControllerOptions) {
    this.limit = options.maxConcurrent ?? 3;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 3) throw new Error("maxConcurrent must be an integer from 1 to 3");
  }
  private error(id: string, code: string, message: string): void { this.options.emit({ type: "error", id, code, message }); }
  private failure(id: string, error: unknown): void {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "browser_error";
    this.error(id, code, error instanceof Error ? error.message : "Browser operation failed");
  }
  async handle(message: unknown): Promise<void> {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) {
      const candidate = typeof message === "object" && message !== null && "id" in message ? message.id : undefined;
      this.error(idSchema.safeParse(candidate).success ? candidate as string : "invalid", "invalid_request", "Invalid factory request");
      return;
    }
    const req = parsed.data;
    if (req.type === "shutdown") return this.shutdown();
    if (this.stopped) { this.error(req.id, "shutdown", "Factory is shut down"); return; }
    if (req.type === "cancel") {
      const job = this.jobs.get(req.id);
      if (job) job.abort.abort();
      else this.error(req.id, "unknown_job", "No active job for this id");
      return;
    }
    if (this.used.has(req.id)) { this.error(req.id, "duplicate_id", "Request id has already been used"); return; }
    this.used.add(req.id);
    if (req.type === "inspect") {
      this.observed = undefined;
      const inspectionAbort = new AbortController();
      this.inspectionControllers.add(inspectionAbort);
      const operation = Promise.resolve().then(async () => {
        try {
          const value = inspectionSchema.parse(await this.options.inspect(inspectionAbort.signal));
          if (!this.stopped) {
            if (value.authenticated && value.newChat && value.solAvailable) this.observed = value;
            this.options.emit({ type: "result", id: req.id, value });
          }
        } catch (error) { if (!this.stopped) this.failure(req.id, error); }
      });
      this.inspections.add(operation);
      try { await operation; } finally { this.inspections.delete(operation); this.inspectionControllers.delete(inspectionAbort); }
      return;
    }
    if (!this.observed) { this.error(req.id, "inspection_required", "A successful authenticated fresh-chat inspection is required"); return; }
    if (req.reasoning === "xhigh" && !this.observed.extraHighAvailable) { this.error(req.id, "effort_unavailable", "Extra High is unavailable; no fallback"); return; }
    if (this.jobs.size >= this.limit) { this.error(req.id, "capacity", "Factory concurrency limit reached"); return; }
    let plan: VerificationPlan | undefined;
    try { plan = planVerification(req.prompt); }
    catch (error) { this.failure(req.id, error); return; }
    if (plan && !this.options.packetEvidence) { this.error(req.id, "packet_evidence_required", "Packetized verification requires a private diagnostics directory"); return; }
    const observed = this.observed;
    const abort = new AbortController();
    const guard = () => { if (abort.signal.aborted || this.stopped) throw Object.assign(new Error("Factory job cancelled"), { code: "cancelled" }); };
    const event = (name: string, fields: { text?: string; reused?: boolean; continuation?: boolean } = {}) => {
      guard(); this.options.emit({ type: "event", id: req.id, event: name, ...fields });
    };
    let submitted = false;
    const runPhysical = async (prompt: string, traceId: string, packetIndex?: number): Promise<string> => {
      guard();
      if (prompt.length > PHYSICAL_PROMPT_LIMIT) throw Object.assign(new Error("Physical verification prompt exceeds its limit"), { code:"verification_packet_oversize" });
      // Each physical turn participates in the same preparation queue. A logical
      // multi-packet request never holds the queue while waiting for a response.
      const previousPreparation = this.preparationTail;
      let releasePreparation!: () => void;
      const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
      this.preparationTail = previousPreparation.then(() => preparation);
      const waitForPreparation = () => new Promise<void>((resolve, reject) => {
        const cancelled = () => { abort.signal.removeEventListener("abort", cancelled); reject(abort.signal.reason); };
        if (abort.signal.aborted) { cancelled(); return; }
        abort.signal.addEventListener("abort", cancelled, { once: true });
        void previousPreparation.then(() => { abort.signal.removeEventListener("abort", cancelled); resolve(); });
      });
      const turn: BrowserTurn = {
        traceId, modelId: CHATGPT_WEB_BACKEND_MODEL, modelFamily: req.modelFamily, reasoning: req.reasoning,
        capabilities: { localToolsEnabled: false, solAvailable: observed.solAvailable, extraHighAvailable: observed.extraHighAvailable, proAvailable: observed.proAvailable },
        nativeConnector: false, retainConversation: false, requireRetainedConversation: false, abortSignal: abort.signal,
        prepare: async () => { guard(); return { text: prompt, images: [], release: () => {} }; },
        onPreparedSelected: reused => { guard(); if (reused) throw Object.assign(new Error("Factory requires a fresh conversation"), { code: "reused_conversation" }); event("conversation_created", { reused: false }); },
        onSendActivated: () => event("send_activated"),
        onSubmitted: () => {
          if (!submitted) { submitted = true; event("submitted"); } else event("verification_packet_submitted");
          if (plan) this.options.packetEvidence!({ stage: "submitted", logicalId: req.id, packetIndex, packetTraceId: traceId });
          if (!this.options.serializeBrowserTurns) releasePreparation();
        },
        onHeartbeat: () => { if (!abort.signal.aborted && !this.stopped) event("heartbeat"); },
        onGenerationProgress: () => { if (!abort.signal.aborted && !this.stopped) event("generation_progress"); },
        onTextDelta: text => { if (!abort.signal.aborted && !this.stopped) event(plan ? "generation_progress" : "text", plan ? {} : { text }); },
        onCommentary: (text, continuation) => { if (!abort.signal.aborted && !this.stopped) event("commentary", { text, ...(continuation ? { continuation: true } : {}) }); },
      };
      try { await waitForPreparation(); guard(); const text = await this.options.run(turn); guard(); return text; }
      finally { releasePreparation(); }
    };
    const done = Promise.resolve().then(async () => {
      try {
        guard(); let text: string;
        if (plan) {
          // Resolve exact completed evidence before changing any reply schedule.
          // Only uncached work is repartitioned; sealed prior packet bytes stay intact.
          const prepared: {packet:VerificationPacket;saved?:SavedVerificationResponse}[] = [];
          for (const packet of plan.packets) {
            await new Promise<void>(resolve => setImmediate(resolve)); guard();
            const saved = this.options.loadPacketResponse?.(packet,req.modelFamily,req.reasoning) ?? (packet.legacyPrompt ? this.options.loadPacketResponse?.({...packet,prompt:packet.legacyPrompt,legacyPrompt:undefined,replyFormat:undefined},req.modelFamily,req.reasoning) : undefined);
            const scheduled = saved ? packet : scheduleInitialComparisonReply(packet);
            const scheduledSaved = saved ?? (scheduled !== packet ? this.options.loadPacketResponse?.(scheduled,req.modelFamily,req.reasoning) : undefined);
            const effective = scheduledSaved ? scheduled : partitionInitialComparisonContext(scheduled);
            prepared.push({packet:effective,saved:scheduledSaved ?? (effective !== scheduled ? this.options.loadPacketResponse?.(effective,req.modelFamily,req.reasoning) : undefined)});
          }
          plan = {...plan,packets:prepared.map(item=>item.packet)};
          const traces = plan.packets.map((_packet, index) => `vfy_${sha256(req.id).slice(0, 32)}_${index + 1}`);
          this.options.packetEvidence!({ stage: "plan", logicalId: req.id, plan, packetTraceIds: traces, modelFamily:req.modelFamily, reasoning:req.reasoning });
          const responses: Map<string, string>[] = [];
          for (const [index, packet] of plan.packets.entries()) {
            // A chain of fulfilled cache promises otherwise monopolizes microtasks:
            // helper-ready pipe data and lease heartbeats need a real I/O turn.
            await new Promise<void>(resolve => setImmediate(resolve));
            guard(); event("verification_packet_started");
            const saved = prepared[index]!.saved;
            let response:string;
            if(saved){
              const {text:prior,...reuseSource}=saved;
              this.options.packetEvidence!({stage:'reused',logicalId:req.id,packetIndex:index,packetTraceId:traces[index]!,reuseSource});
              event('verification_packet_reused');response=prior;
            } else response = await runPhysical(packet.prompt, traces[index]!, index);
            this.options.packetEvidence!({ stage: "result", logicalId: req.id, packetIndex: index, packetTraceId: traces[index]!, text: response, responseSha256: sha256(response) });
            responses.push(await completePacketResponse(response, packet, async (missing, supplementIndex) => {
              guard(); const trace = traces[index]! + '_s' + (supplementIndex + 1);
              this.options.packetEvidence!({stage:'supplement_plan',logicalId:req.id,packet:missing,packetTraceId:trace,packetIndex:index,sourceResponseSha256:sha256(response)});
              event('verification_missing_comparisons');
              const cached = this.options.loadPacketResponse?.(missing,req.modelFamily,req.reasoning,sha256(response));
              let extra:string;
              if(cached){const {text:prior,...reuseSource}=cached;this.options.packetEvidence!({stage:'reused',logicalId:req.id,packetIndex:index,packetTraceId:trace,reuseSource});event('verification_packet_reused');extra=prior;}
              else extra = await runPhysical(missing.prompt,trace,index);
              this.options.packetEvidence!({stage:'result',logicalId:req.id,packetIndex:index,packetTraceId:trace,text:extra,responseSha256:sha256(extra)});
              return extra;
            }, (candidateId,judgments)=>this.options.packetEvidence!({stage:'quarantined',logicalId:req.id,packetIndex:index,packetTraceId:traces[index]!,message:JSON.stringify({candidate_id:candidateId,excluded_distinct_claims:judgments,source_response_sha256:sha256(response)})})));
            event("verification_packet_completed");
          }
          text = mergePacketResponses(plan, responses);
          this.options.packetEvidence!({ stage: "complete", logicalId: req.id, responseSha256: sha256(text) });
        } else text = await runPhysical(req.prompt, req.id);
        guard(); this.options.emit({ type: "result", id: req.id, text });
      } catch (error) {
        if (plan) { try { this.options.packetEvidence!({ stage: "failure", logicalId: req.id, message: error instanceof Error ? error.message : "Packet operation failed" }); } catch {} }
        if (abort.signal.aborted || this.stopped) this.error(req.id, "cancelled", "Factory job cancelled"); else this.failure(req.id, error);
      } finally { this.jobs.delete(req.id); }
    });
    this.jobs.set(req.id, { abort, done });
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const inspection of this.inspectionControllers) inspection.abort();
    for (const job of this.jobs.values()) job.abort.abort();
    this.closing = (async () => {
      await Promise.allSettled([...this.inspections, ...Array.from(this.jobs.values(), job => job.done)]);
      await this.options.close();
    })();
    return this.closing;
  }
}
