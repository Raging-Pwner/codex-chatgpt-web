import { appendFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { VerificationPacket } from "./verification-packets";
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
        return { trace_id:trace, candidate_ids:packet.candidateIds, characters:packet.prompt.length, review_context:packet.contextMode ?? "full-batch-source-and-proposals", reply_format:packet.replyFormat ?? "full-neighbor-identities",
          prompt_sha256:sha256(packet.prompt), required_neighbor_identities:packet.neighborIdentities };
      });
      const manifestText = JSON.stringify({
        protocol:'factory-verification-partitions/v1', logical_id:event.logicalId,
        logical_prompt_sha256:event.plan.logicalPromptSha256, physical_prompt_limit:PHYSICAL_PROMPT_LIMIT,
        candidate_ids:event.plan.candidateIds, requested_model_family:event.modelFamily, requested_reasoning:event.reasoning, source, packets,
      },null,2)+'\n';
      writeFileSync(join(folder, 'manifest.json'),manifestText,{encoding:'utf8',flag:'wx'});
      writeFileSync(join(folder, 'manifest.sha256'),sha256(manifestText)+'\n',{encoding:'utf8',flag:'wx'});
      appendFileSync(join(folder,'events.jsonl'), JSON.stringify({stage:'plan',recorded_at:new Date().toISOString(),packet_count:packets.length})+'\n');
      return;
    }
    if (event.stage === 'supplement_plan') {
      const trace = event.packetTraceId;
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(trace) || event.packet.prompt.length > PHYSICAL_PROMPT_LIMIT) throw new Error('Invalid missing-comparison packet');
      writeFileSync(join(folder,trace+'.prompt.txt'),event.packet.prompt,{encoding:'utf8',flag:'wx'});
      const metadata = {stage:event.stage,logicalId:event.logicalId,packetIndex:event.packetIndex,packetTraceId:trace,sourceResponseSha256:event.sourceResponseSha256,prompt_sha256:sha256(event.packet.prompt),candidate_ids:event.packet.candidateIds,required_neighbor_identities:event.packet.neighborIdentities};
      const supplementText=JSON.stringify(metadata,null,2)+'\n';
      writeFileSync(join(folder,trace+'.supplement.json'),supplementText,{encoding:'utf8',flag:'wx'});
      writeFileSync(join(folder,trace+'.supplement.sha256'),sha256(supplementText)+'\n',{encoding:'utf8',flag:'wx'});
      appendFileSync(join(folder,'events.jsonl'),JSON.stringify({...metadata,recorded_at:new Date().toISOString()})+'\n');
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

export type SavedVerificationResponse = {text:string; sourceResponsePath:string; sourcePromptPath:string; sourceManifestSha256:string; sourceSupplementSha256?:string; responseSha256:string};
/** Raw model output may be resumed, never accepted from cache without all current gates. */
export function verificationResponseReader(root:string): (packet:VerificationPacket,family:string,effort:string,sourceResponseSha256?:string)=>SavedVerificationResponse|undefined {
  if (!isAbsolute(root)) throw new Error('Verification evidence root must be absolute');
  return (packet,family,effort,parentResponseHash) => {
    const base=join(root,'verification_packets');let folders:string[];
    try { folders=readdirSync(base).filter(n=>/^[A-Za-z0-9_-]{6,128}$/.test(n)); } catch {return;}
    const promptHash=sha256(packet.prompt);
    for (const folder of folders.reverse()) {
      try {
        const dir=join(base,folder);const manifestText=readFileSync(join(dir,'manifest.json'),'utf8');const manifest=JSON.parse(manifestText);
        if(readFileSync(join(dir,'manifest.sha256'),'utf8').trim()!==sha256(manifestText) || !/^[a-f0-9]{64}$/.test(manifest.source?.bridge_entry_sha256) || !/^[a-f0-9]{64}$/.test(manifest.source?.browser_helper_sha256)) continue;
        if(manifest.requested_model_family!==family || manifest.requested_reasoning!==effort || !Array.isArray(manifest.packets)) continue;
        const events=readFileSync(join(dir,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x));
        const items = parentResponseHash ? readdirSync(dir).filter(n=>/^[A-Za-z0-9_-]+\.supplement\.json$/.test(n)).flatMap(name=>{
          try {
          const text=readFileSync(join(dir,name),'utf8');const meta=JSON.parse(text);
          const trace=meta.packetTraceId;
          if(!/^[A-Za-z0-9_-]{6,128}$/.test(trace) || name!==trace+'.supplement.json' || meta.sourceResponseSha256!==parentResponseHash || readFileSync(join(dir,trace+'.supplement.sha256'),'utf8').trim()!==sha256(text))return [];
          return [{...meta,trace_id:trace,sourceSupplementSha256:sha256(text)}];
          } catch {return [];}
        }) : manifest.packets;
        for(const item of items){
          if(item.prompt_sha256!==promptHash || !/^[A-Za-z0-9_-]{6,128}$/.test(item.trace_id) || !isDeepStrictEqual(item.candidate_ids,packet.candidateIds) || !isDeepStrictEqual(JSON.parse(JSON.stringify(item.required_neighbor_identities)),JSON.parse(JSON.stringify(packet.neighborIdentities)))) continue;
          const sourcePromptPath=join(dir,item.trace_id+'.prompt.txt');const sourceResponsePath=join(dir,item.trace_id+'.response.txt');
          if(readFileSync(sourcePromptPath,'utf8')!==packet.prompt) continue;
          const text=readFileSync(sourceResponsePath,'utf8');const responseSha256=sha256(text);
          if(!events.some(e=>e.stage==='submitted'&&e.packetTraceId===item.trace_id) || !events.some(e=>e.stage==='result'&&e.packetTraceId===item.trace_id&&e.responseSha256===responseSha256)) continue;
          return {text,sourcePromptPath,sourceResponsePath,sourceManifestSha256:sha256(manifestText),...(item.sourceSupplementSha256?{sourceSupplementSha256:item.sourceSupplementSha256}:{}),responseSha256};
        }
      } catch { /* Missing, tampered or incomplete evidence cannot authorize reuse. */ }
    }
  };
}
