import { z } from "zod";
import type { BrowserTurn } from "../adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_BACKEND_MODEL } from "../chatgpt-web-models";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{6,128}$/);
const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect"), id: idSchema }).strict(),
  z.object({ type: z.literal("run"), id: idSchema, prompt: z.string().min(1).max(200000), modelFamily: z.enum(["5.6", "6"]), reasoning: z.literal("high") }).strict(),
  z.object({ type: z.literal("cancel"), id: idSchema }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);
const inspectionSchema = z.object({ authenticated: z.boolean(), newChat: z.boolean(), solAvailable: z.boolean(), extraHighAvailable: z.boolean(), proAvailable: z.boolean() });
export type FactoryInspection = z.infer<typeof inspectionSchema>;
export type FactoryMessage = { type: "result"; id: string; text: string } | { type: "result"; id: string; value: FactoryInspection } | { type: "error"; id: string; message: string; code: string } | { type: "event"; id: string; event: string; text?: string; reused?: boolean; continuation?: boolean };
export interface FactoryControllerOptions {
  inspect: (signal?: AbortSignal) => Promise<FactoryInspection>;
  run: (turn: BrowserTurn) => Promise<string>;
  close: () => void | Promise<void>;
  emit: (message: FactoryMessage) => void;
  maxConcurrent?: number;
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
    if (this.jobs.size >= this.limit) { this.error(req.id, "capacity", "Factory concurrency limit reached"); return; }
    const abort = new AbortController();
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
    const guard = () => { if (abort.signal.aborted || this.stopped) throw Object.assign(new Error("Factory job cancelled"), { code: "cancelled" }); };
    const event = (name: string, fields: { text?: string; reused?: boolean; continuation?: boolean } = {}) => {
      guard(); this.options.emit({ type: "event", id: req.id, event: name, ...fields });
    };
    const turn: BrowserTurn = {
      traceId: req.id, modelId: CHATGPT_WEB_BACKEND_MODEL, modelFamily: req.modelFamily, reasoning: req.reasoning,
      capabilities: { localToolsEnabled: false, solAvailable: this.observed.solAvailable, extraHighAvailable: this.observed.extraHighAvailable, proAvailable: this.observed.proAvailable },
      nativeConnector: false, retainConversation: false, requireRetainedConversation: false, abortSignal: abort.signal,
      prepare: async () => { guard(); return { text: req.prompt, images: [], release: () => {} }; },
      onPreparedSelected: reused => { guard(); if (reused) throw Object.assign(new Error("Factory requires a fresh conversation"), { code: "reused_conversation" }); event("conversation_created", { reused: false }); },
      onSendActivated: () => event("send_activated"), onSubmitted: () => { event("submitted"); releasePreparation(); },
      onHeartbeat: () => { if (!abort.signal.aborted && !this.stopped) event("heartbeat"); },
      onGenerationProgress: () => { if (!abort.signal.aborted && !this.stopped) event("generation_progress"); },
      onTextDelta: text => { if (!abort.signal.aborted && !this.stopped) event("text", { text }); },
      onCommentary: (text, continuation) => { if (!abort.signal.aborted && !this.stopped) event("commentary", { text, ...(continuation ? { continuation: true } : {}) }); },
    };
    const done = Promise.resolve().then(async () => {
      try { await waitForPreparation(); guard(); const text = await this.options.run(turn); guard(); this.options.emit({ type: "result", id: req.id, text }); }
      catch (error) { if (abort.signal.aborted || this.stopped) this.error(req.id, "cancelled", "Factory job cancelled"); else this.failure(req.id, error); }
      finally { releasePreparation(); this.jobs.delete(req.id); }
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
