import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { PacketEvidence } from "./controller";
import { PHYSICAL_PROMPT_LIMIT, sha256 } from "./verification-packets";

/** Private exact-input/output ledger. A logical result is not emitted if recording fails. */
export function verificationEvidenceWriter(root: string, source: Record<string, string>): (event: PacketEvidence) => void {
  if (!isAbsolute(root)) throw new Error('Verification evidence root must be absolute');
  return event => {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(event.logicalId)) throw new Error('Invalid verification evidence identity');
    const folder = join(root, 'verification_packets', event.logicalId);
    mkdirSync(folder, { recursive: true });
    if (event.stage === 'plan') {
      const packets = event.plan.packets.map((packet, index) => {
        const trace = event.packetTraceIds[index];
        if (!trace || !/^[A-Za-z0-9_-]{6,128}$/.test(trace) || packet.prompt.length > PHYSICAL_PROMPT_LIMIT) throw new Error('Invalid physical verification packet');
        writeFileSync(join(folder, trace + '.prompt.txt'), packet.prompt, { encoding:'utf8', flag:'wx' });
        return { trace_id:trace, candidate_ids:packet.candidateIds, characters:packet.prompt.length,
          prompt_sha256:sha256(packet.prompt), required_neighbor_identities:packet.neighborIdentities };
      });
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({
        protocol:'factory-verification-partitions/v1', logical_id:event.logicalId,
        logical_prompt_sha256:event.plan.logicalPromptSha256, physical_prompt_limit:PHYSICAL_PROMPT_LIMIT,
        candidate_ids:event.plan.candidateIds, requested_model_family:event.modelFamily, requested_reasoning:event.reasoning, source, packets,
      },null,2)+'\n', { encoding:'utf8', flag:'wx' });
      appendFileSync(join(folder,'events.jsonl'), JSON.stringify({stage:'plan',recorded_at:new Date().toISOString(),packet_count:packets.length})+'\n');
      return;
    }
    const {text, ...metadata} = event;
    if (event.stage === 'result') {
      if (!event.packetTraceId || !/^[A-Za-z0-9_-]{6,128}$/.test(event.packetTraceId) || typeof text !== 'string' || sha256(text) !== event.responseSha256) throw new Error('Invalid verification result evidence');
      writeFileSync(join(folder,event.packetTraceId+'.response.txt'),text,{encoding:'utf8',flag:'wx'});
    }
    appendFileSync(join(folder,'events.jsonl'),JSON.stringify({...metadata,recorded_at:new Date().toISOString()})+'\n');
  };
}
