import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PHYSICAL_PROMPT_LIMIT = 200_000;
export const LOGICAL_PROMPT_LIMIT = 8_000_000;
const HEADER = '# SYNAPSESPEAK INDEPENDENT SECOND-PASS AUDIT VERIFICATION';
const PACKET = 'ORIGINAL SOURCE ROWS AND PRIMARY-AUDIT PROPOSALS:\n';
const DUPLICATES = '\n# CONTENT-BOUND DUPLICATE REVIEW\n';
const MAP_START = 'Empty list only if no neighbors.\n';
type ObjectValue = Record<string, unknown>;
type NeighborIdentity = { candidate_id: string; row_sha256: string };
export type VerificationPacket = { prompt: string; candidateIds: string[]; neighborIdentities: Record<string, NeighborIdentity[]>; contextMode?: "assigned-source-and-all-peer-proposals"; replyFormat?: "indexed-neighbor-verdicts/v1"; legacyPrompt?: string };
export type VerificationPlan = { logicalPromptSha256: string; candidateIds: string[]; packets: VerificationPacket[] };
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (x: unknown): x is ObjectValue => typeof x === 'object' && x !== null && !Array.isArray(x);
function invalid(message: string): never { throw Object.assign(new Error(message), { code: 'verification_packet_invalid' }); }

// Parse only the JSON value, rather than searching for delimiters inside quoted corpus strings.
function jsonAt(text: string, start: number): { value: unknown; end: number } {
  while (/\s/.test(text[start] ?? '') && start < text.length) start++;
  if (!['[', '{'].includes(text[start] ?? '')) invalid('Expected structured verification data');
  const stack: string[] = []; let quoted = false; let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '[' || c === '{') stack.push(c);
    else if (c === ']' || c === '}') {
      if (stack.pop() !== (c === ']' ? '[' : '{')) invalid('Unbalanced verification JSON');
      if (!stack.length) { try { return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }; } catch { invalid('Malformed verification JSON'); } }
    }
  }
  return invalid('Incomplete verification JSON');
}

/** Large verification only: no removed context, neighbor truncation, or ordinary-prompt rewriting. */
export function planVerification(prompt: string): VerificationPlan | undefined {
  if (prompt.length <= PHYSICAL_PROMPT_LIMIT && !prompt.startsWith(HEADER)) return undefined;
  if (prompt.length > LOGICAL_PROMPT_LIMIT || !prompt.startsWith(HEADER)) invalid('Oversized ordinary prompt; only structured factory verification can be packetized');
  const newline = prompt.includes('\r\n') ? '\r\n' : '\n';
  const packetMarker = PACKET.replaceAll('\n', newline);
  const marker = prompt.indexOf(packetMarker); if (marker < 0) invalid('Missing verification candidate inventory');
  const start = marker + packetMarker.length; const parsed = jsonAt(prompt, start);
  if (!Array.isArray(parsed.value) || !parsed.value.length) invalid('Empty verification inventory');
  const candidates = parsed.value as unknown[]; const candidateIds: string[] = [];
  for (const entry of candidates) {
    if (!object(entry) || !object(entry.original) || !object(entry.primary_audit_proposal)) invalid('Invalid verification candidate envelope');
    const cid = entry.original.candidate_id;
    if (typeof cid !== 'string' || !cid || cid !== entry.primary_audit_proposal.candidate_id || candidateIds.includes(cid)) invalid('Verification candidate identity mismatch');
    candidateIds.push(cid);
  }
  const duplicateMarker = prompt.indexOf(DUPLICATES.replaceAll('\n', newline), parsed.end); if (duplicateMarker < 0) invalid('Missing duplicate review contract');
  const mapMarker = prompt.indexOf(MAP_START.replaceAll('\n', newline), duplicateMarker); if (mapMarker < 0) invalid('Unknown duplicate review envelope');
  const mapStart = mapMarker + MAP_START.replaceAll('\n', newline).length; const parsedMap = jsonAt(prompt, mapStart);
  if (prompt.slice(parsedMap.end).trim() || !object(parsedMap.value)) invalid('Unexpected verification trailer');
  const neighbors = parsedMap.value;
  if (Object.keys(neighbors).length !== candidateIds.length || Object.keys(neighbors).some(cid => !candidateIds.includes(cid))) invalid('Duplicate review inventory mismatch');
  const byIdentity = new Map<string, ObjectValue>(); const hashOwners = new Map<string, string>();
  const identities: Record<string, NeighborIdentity[]> = Object.create(null);
  for (const cid of candidateIds) {
    const values = neighbors[cid]; if (!Array.isArray(values)) invalid('Missing required duplicate neighbors');
    const seen = new Set<string>(); identities[cid] = [];
    for (const value of values) {
      if (!object(value) || typeof value.candidate_id !== 'string' || typeof value.row_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.row_sha256) || value.protected || value.hold) invalid('Invalid or protected duplicate evidence');
      const key = JSON.stringify([value.candidate_id, value.row_sha256]);
      if (seen.has(key)) invalid('Repeated duplicate neighbor identity'); seen.add(key);
      const owner = hashOwners.get(value.row_sha256); if (owner && owner !== value.candidate_id) invalid('Conflicting content-hash owner');
      hashOwners.set(value.row_sha256, value.candidate_id);
      const prior = byIdentity.get(key); if (prior && !isDeepStrictEqual(prior, value)) invalid('Conflicting duplicate content');
      byIdentity.set(key, value); identities[cid]!.push({ candidate_id: value.candidate_id, row_sha256: value.row_sha256 });
    }
  }
  let projectContext = false;
  const render = (assigned: string[]): VerificationPacket => {
    const required: Record<string, NeighborIdentity[]> = Object.create(null); const pool = new Map<string, ObjectValue>();
    for (const cid of assigned) {
      required[cid] = identities[cid]!;
      for (const ref of required[cid]!) { const key = JSON.stringify([ref.candidate_id, ref.row_sha256]); pool.set(key, byIdentity.get(key)!); }
    }
    const data = { assigned_candidate_ids: assigned, neighbors_by_candidate: required, neighbor_pool: [...pool.values()] };
    const assignment = '\n# VERIFICATION TRANSPORT ASSIGNMENT\nAll original/source and primary-proposal rows above remain read-only review context. Return exactly one verification row for EACH assigned_candidate_ids entry, and no unassigned rows. The neighbor_pool contains each full neighbor once; resolve every neighbors_by_candidate reference by candidate_id AND row_sha256. Return every required duplicate_verdict with its supplied hash and a specific material reason. This lossless transport partition changes output assignment only; all quality, identity, rejection and independent-verification rules remain in force. Do not generate examples, omit evidence or rubber-stamp a proposal.\n';
    const fullPrompt = prompt.slice(0, start) + JSON.stringify(candidates) + prompt.slice(parsed.end, mapStart) + JSON.stringify(data) + assignment;
    if (projectContext) {
      // Every target is checked against its COMPLETE original in its own packet.
      // Other targets retain their FULL proposals here for cross-candidate review;
      // their originals remain in the bound logical input and their own packets.
      const own = candidates.filter((_entry,index)=>assigned.includes(candidateIds[index]!));
      const peers = candidates.filter(entry=>!own.includes(entry)).map(entry=>(entry as ObjectValue).primary_audit_proposal);
      const projected = prompt.slice(0,start)+JSON.stringify(own)+
        '\n# READ-ONLY PEER PRIMARY PROPOSALS\nEach peer is independently checked against its complete original in its own assigned packet. Use these complete peer proposals for cross-candidate consistency; do not output peer rows here.\n'+JSON.stringify(peers)+
        prompt.slice(parsed.end,mapStart)+JSON.stringify(data)+assignment;
      return {prompt:projected,candidateIds:assigned,neighborIdentities:required,contextMode:'assigned-source-and-all-peer-proposals'};
    }
    return { prompt:fullPrompt, candidateIds: assigned, neighborIdentities: required };
  };
  // Preserve every currently viable plan byte-for-byte. Projection is enabled only
  // if the original whole-batch context cannot fit even a single required target.
  projectContext = candidateIds.some(cid=>render([cid]).prompt.length>PHYSICAL_PROMPT_LIMIT);
  const packets: VerificationPacket[] = []; let assigned: string[] = []; let decisions = 0;
  for (const cid of candidateIds) {
    const count = identities[cid]!.length;
    let trial = render([...assigned, cid]);
    if (assigned.length && (trial.prompt.length > PHYSICAL_PROMPT_LIMIT || assigned.length >= 6 || decisions + count > 256)) {
      packets.push(render(assigned)); assigned = []; decisions = 0; trial = render([cid]);
    }
    if (trial.prompt.length > PHYSICAL_PROMPT_LIMIT) invalid('One verification candidate plus required context exceeds the physical prompt limit; evidence was not truncated');
    assigned.push(cid); decisions += count;
  }
  if (assigned.length) packets.push(render(assigned));
  return { logicalPromptSha256: sha256(prompt), candidateIds, packets:packets.map(packet => {
    const indexed = indexVerificationPacket(packet);
    // Preserve assignments and untouched cache hashes; headroom is experimental.
    if (indexed.contextMode || indexed.candidateIds.length !== 1 || indexed.prompt.length <= 190_000) return indexed;
    const prior = projectContext;
    try {
      projectContext = true;
      const projected = indexVerificationPacket(render(indexed.candidateIds));
      if (projected.prompt.length >= indexed.prompt.length) return indexed;
      return scheduleInitialComparisonReply(projected);
    } finally { projectContext = prior; }
  }) };
}


/** Output scheduling only: all review evidence and final coverage requirements stay intact. */
export function scheduleInitialComparisonReply(packet: VerificationPacket): VerificationPacket {
  const marker = '\n# BOUNDED INITIAL COMPARISON REPLY\n';
  if (packet.prompt.includes(marker)) return packet;
  const ids = packet.candidateIds;
  if (!ids.length || new Set(ids).size !== ids.length
      || ids.some(cid => !Array.isArray(packet.neighborIdentities[cid]))) invalid('Invalid initial comparison assignment');
  const total = ids.reduce((sum,cid) => sum + packet.neighborIdentities[cid]!.length,0);
  if (total <= 24) return packet;
  const perCandidate = Math.floor(24 / ids.length);
  const budgets = ids.map(cid => Math.min(perCandidate,packet.neighborIdentities[cid]!.length));
  let remaining = 24 - budgets.reduce((sum,count) => sum + count,0);
  while (remaining > 0) {
    for (let i=0;i<ids.length && remaining>0;i++) {
      if (budgets[i]! < packet.neighborIdentities[ids[i]!]!.length) { budgets[i]! += 1; remaining -= 1; }
    }
  }
  let suffix: string;
  if (ids.length === 1 && packet.replyFormat === 'indexed-neighbor-verdicts/v1') {
    // Exact historical bytes preserve the already completed projected single-target cache.
    suffix = '\n# BOUNDED INITIAL COMPARISON REPLY\nFor this INITIAL physical reply only, return the complete independently reviewed row and duplicate_verdicts for other_index 0 through 23. This initial output schedule supersedes the earlier instruction to emit every comparison in one reply. All supplied neighbors remain full read-only evidence. Do not omit any material concern: preserve REPAIR, REJECT, DUPLICATE or unresolved findings as required. The factory will independently request each remaining required comparison in bounded follow-up calls, and cannot deliver a complete logical PASS until every required comparison has an actual judgment. Do not emit remaining indices in this initial reply or invent their results. Every source-fidelity, identity, quality and negative-finding rule remains unchanged.\n';
  } else {
    const indexed = packet.replyFormat === 'indexed-neighbor-verdicts/v1';
    const schedule = Object.fromEntries(ids.map((cid,i) => [cid,indexed
      ? Array.from({length:budgets[i]!},(_,other_index)=>other_index)
      : packet.neighborIdentities[cid]!.slice(0,budgets[i]!).map(ref=>({other_id:ref.candidate_id,other_sha256:ref.row_sha256}))]));
    suffix = marker + 'For this INITIAL physical reply only, return the complete independently reviewed row for EACH assigned candidate, and duplicate_verdicts ONLY for that candidate\'s entries in the schedule below. '
      + (indexed ? 'Numbers are candidate-local other_index values. ' : 'Objects identify the exact supplied other_id and other_sha256. ')
      + 'An empty schedule means return duplicate_verdicts:[] for that candidate. This initial output schedule supersedes the earlier instruction to emit every comparison in one reply. '
      + 'All supplied neighbors remain full read-only evidence. Do not omit any material concern: preserve REPAIR, REJECT, DUPLICATE or unresolved findings as required. '
      + 'The factory will independently request every remaining required comparison in bounded follow-up calls, and cannot deliver a complete logical PASS until every required comparison has an actual judgment. '
      + 'Do not emit unscheduled comparisons in this initial reply or invent their results. Every source-fidelity, identity, quality and negative-finding rule remains unchanged.\n'
      + 'Candidate-local initial comparison schedule (JSON):\n' + JSON.stringify(schedule) + '\n';
  }
  let prompt = packet.prompt + suffix;
  if (prompt.length > PHYSICAL_PROMPT_LIMIT && packet.replyFormat !== 'indexed-neighbor-verdicts/v1') {
    // Only replace the exact known transport prose after the complete JSON value.
    // Never shorten source, peer or neighbor data, or an unfamiliar instruction.
    const assignment = '\n# VERIFICATION TRANSPORT ASSIGNMENT\nAll original/source and primary-proposal rows above remain read-only review context. Return exactly one verification row for EACH assigned_candidate_ids entry, and no unassigned rows. The neighbor_pool contains each full neighbor once; resolve every neighbors_by_candidate reference by candidate_id AND row_sha256. Return every required duplicate_verdict with its supplied hash and a specific material reason. This lossless transport partition changes output assignment only; all quality, identity, rejection and independent-verification rules remain in force. Do not generate examples, omit evidence or rubber-stamp a proposal.\n';
    const boundary = /Empty list only if no neighbors\.\r?\n/.exec(packet.prompt);
    if (boundary && boundary.index !== undefined) {
      const parsed = jsonAt(packet.prompt,boundary.index+boundary[0].length);
      if (packet.prompt.slice(parsed.end) === assignment) {
        const selection = ids.length === 1 ? 'first 24 neighbors_by_candidate references only, in supplied order. '
          : 'first N neighbors_by_candidate references per candidate; N in assigned_candidate_ids order is '+JSON.stringify(budgets)+'. ';
        const compact = '\n# VERIFICATION TRANSPORT ASSIGNMENT\n' + marker
          + 'Return one independently reviewed row per assigned_candidate_ids; no peer rows. Initial reply: ' + selection
          + 'Use exact other_id/other_sha256. All full source/peer/neighbor data remains required read-only evidence. '
          + 'Preserve REPAIR/REJECT and every negative or unresolved finding; invent nothing. '
          + 'Independent follow-ups must cover every remaining comparison before logical PASS. '
          + 'All source-fidelity, identity, quality and rejection gates remain unchanged.\n';
        prompt = packet.prompt.slice(0,parsed.end) + compact;
      }
    }
  }
  if (prompt.length > PHYSICAL_PROMPT_LIMIT) invalid('Initial comparison schedule exceeds the physical prompt limit; no unbounded fallback');
  return {...packet,prompt};
}

/** Index identifiers are immutable transport references, never model-authored judgments. */
function indexVerificationPacket(packet:VerificationPacket):VerificationPacket {
  const marker=/Empty list only if no neighbors\.\r?\n/.exec(packet.prompt);
  if(!marker || marker.index===undefined) invalid('Missing indexed comparison envelope');
  const start=marker.index+marker[0].length;const parsed=jsonAt(packet.prompt,start);
  if(!object(parsed.value) || !object(parsed.value.neighbors_by_candidate)) invalid('Invalid indexed comparison inventory');
  const refs=Object.fromEntries(packet.candidateIds.map(cid=>[cid,packet.neighborIdentities[cid]!.map((ref,other_index)=>({...ref,other_index}))]));
  const data={...parsed.value,neighbors_by_candidate:refs};
  const prompt=packet.prompt.slice(0,start)+JSON.stringify(data)+packet.prompt.slice(parsed.end)+
    '\n# INDEXED DUPLICATE VERDICTS v1 — OUTPUT FORMAT\nFor duplicate_verdicts ONLY, return other_index instead of copying other_id and other_sha256. Each other_index is the explicit zero-based reference in THIS candidate\'s neighbors_by_candidate list. The factory resolves it to the exact supplied ID/hash; never invent or substitute an index. Return exactly one judgment per supplied index, with verdict DISTINCT, DUPLICATE or OVERLAP and a specific material reason. Keep every reviewed triplet field and candidate_id exactly as required above. Example duplicate_verdicts:[{"other_index":0,"verdict":"DISTINCT","reason":"specific material comparison"}]. Do not return other_id or other_sha256 alongside other_index. This format changes identifiers only; all scope, quality, independence and duplicate gates remain.\n';
  if(prompt.length>PHYSICAL_PROMPT_LIMIT) return packet;
  return {...packet,prompt,legacyPrompt:packet.prompt,replyFormat:'indexed-neighbor-verdicts/v1'};
}

export function readPacketResponse(text: string, packet: VerificationPacket, allowMissing = false, quarantine?: (candidateId:string,judgments:unknown[])=>void): Map<string, string> {
  let body = text.trim();
  if (body.startsWith('```')) {
    const fence = /^```(?:jsonl|json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(body);
    if (!fence) invalid('Invalid verification response fence'); body = fence[1]!;
  }
  const rows = new Map<string, string>();
  for (const line of body.split(/\r?\n/).filter(line => line.trim())) {
    let row: unknown; try { row = JSON.parse(line); } catch { invalid('Malformed verification JSONL response'); }
    if (!object(row) || typeof row.candidate_id !== 'string' || !packet.candidateIds.includes(row.candidate_id) || rows.has(row.candidate_id)) invalid('Unassigned or repeated verification response identity');
    let decoded=false;
    if(packet.replyFormat==='indexed-neighbor-verdicts/v1' && Array.isArray(row.duplicate_verdicts)){
      const required=packet.neighborIdentities[row.candidate_id]!;
      row.duplicate_verdicts=row.duplicate_verdicts.map(value=>{
        if(!object(value) || !Object.prototype.hasOwnProperty.call(value,'other_index'))return value;
        const index=value.other_index;
        if(typeof index!=='number' || !Number.isSafeInteger(index) || index<0 || index>=required.length || Object.keys(value).some(k=>!['other_index','verdict','reason'].includes(k)))invalid('Invalid or conflicting comparison index');
        decoded=true;const ref=required[index]!;
        return {other_id:ref.candidate_id,other_sha256:ref.row_sha256,verdict:value.verdict,reason:value.reason};
      });
    }

    // Reject an incomplete PASS before spending time on later packets. Substantive
    // REPAIR/REJECT decisions still reach the Python factory's original hold gates.
    if (typeof row.verification_status === 'string' && row.verification_status.toUpperCase() === 'PASS') {
      const required = packet.neighborIdentities[row.candidate_id]!;
      const verdicts = row.duplicate_verdicts;
      if (!Array.isArray(verdicts)) invalid('Incomplete duplicate verdict coverage for ' + row.candidate_id);
      const expected = new Set(required.map(n => JSON.stringify([n.candidate_id, n.row_sha256])));
      const retained:unknown[] = [], rejected:unknown[] = [];
      for (const verdict of verdicts) {
        const key=object(verdict)?JSON.stringify([verdict.other_id,verdict.other_sha256]):'';
        if(allowMissing && object(verdict) && ['OVERLAP','UNCERTAIN'].includes(String(verdict.verdict)) && expected.has(key) && typeof verdict.reason==='string' && verdict.reason.trim()){
          rejected.push(verdict);continue;
        }
        const valid=object(verdict) && typeof verdict.reason==='string' && !!verdict.reason.trim() && typeof verdict.verdict==='string' && !!verdict.verdict.trim() && expected.has(key);
        if(!valid){
          // Invalid DISTINCT claims never count as evidence. A duplicate finding,
          // unknown decision, or malformed object cannot be silently discarded.
          if(allowMissing && object(verdict) && verdict.verdict==='DISTINCT'){rejected.push(verdict);continue;}
          invalid('Invalid duplicate verdict identity or reason for '+row.candidate_id);
        }
        expected.delete(key);retained.push(verdict);
      }
      if(rejected.length){row.duplicate_verdicts=retained;quarantine?.(row.candidate_id,rejected);}
      if (expected.size && !allowMissing) invalid('Incomplete duplicate verdict coverage for ' + row.candidate_id);
    }
    rows.set(row.candidate_id, decoded || (allowMissing && Array.isArray(row.duplicate_verdicts) && row.duplicate_verdicts.length !== (JSON.parse(line).duplicate_verdicts?.length)) ? JSON.stringify(row) : line);
  }
  if (rows.size !== packet.candidateIds.length) invalid('Incomplete verification packet response');
  return rows;
}

export function mergePacketResponses(plan: VerificationPlan, responses: Map<string, string>[]): string {
  if (responses.length !== plan.packets.length) invalid('Incomplete logical verification response');
  const rows = new Map<string, string>();
  for (const response of responses) for (const [cid, line] of response) {
    if (rows.has(cid)) invalid('Repeated logical verification identity'); rows.set(cid, line);
  }
  if (rows.size !== plan.candidateIds.length || plan.candidateIds.some(cid => !rows.has(cid))) invalid('Logical verification coverage mismatch');
  return '```jsonl\n' + plan.candidateIds.map(cid => rows.get(cid)!).join('\n') + '\n```';
}

/** Resolve omissions only. Never rewrite reviewed fields or synthesize a pair verdict. */
export async function completePacketResponse(text: string, packet: VerificationPacket,
  runMissing: (packet: VerificationPacket, index: number) => Promise<string>,
  quarantine?: (candidateId:string,judgments:unknown[])=>void): Promise<Map<string,string>> {
  const excluded = new Map<string,unknown[]>();
  const rows = readPacketResponse(text, packet, true, (cid,judgments)=>{excluded.set(cid,judgments);quarantine?.(cid,judgments);});
  let calls = 0;
  for (const [cid, line] of rows) {
    const row = JSON.parse(line) as ObjectValue;
    if (typeof row.verification_status !== 'string' || row.verification_status.toUpperCase() !== 'PASS') continue;
    const verdicts = row.duplicate_verdicts as ObjectValue[];
    const returned = new Set(verdicts.map(v => JSON.stringify([v.other_id, v.other_sha256])));
    const missing = packet.neighborIdentities[cid]!.filter(n => !returned.has(JSON.stringify([n.candidate_id,n.row_sha256])));
    if (!missing.length) continue;
    const marker = /Empty list only if no neighbors\.\r?\n/.exec(packet.prompt);
    if (!marker || marker.index === undefined) invalid('Missing completion evidence envelope');
    const dataStart = marker.index + marker[0].length;
    const parsed = jsonAt(packet.prompt, dataStart);
    if (!object(parsed.value) || !Array.isArray(parsed.value.neighbor_pool)) invalid('Missing pooled comparison evidence');
    const pool = parsed.value.neighbor_pool as unknown[];
    for (let offset = 0; offset < missing.length; offset += 24) {
      if (++calls > 16) invalid('Missing comparison completion budget exceeded');
      const refs = missing.slice(offset,offset+24);
      const keys = new Set(refs.map(n=>JSON.stringify([n.candidate_id,n.row_sha256])));
      const bodies = pool.filter(n=>object(n) && keys.has(JSON.stringify([n.candidate_id,n.row_sha256])));
      if (bodies.length !== refs.length) invalid('Missing full comparison evidence');
      let prompt = packet.prompt.slice(0,dataStart) + JSON.stringify({assigned_candidate_ids:[cid],neighbors_by_candidate:{[cid]:refs},neighbor_pool:bodies,...((excluded.get(cid)||[]).some(v=>object(v)&&['OVERLAP','UNCERTAIN'].includes(String(v.verdict)))?{prior_ambiguous_judgments:(excluded.get(cid)||[]).filter(v=>object(v)&&['OVERLAP','UNCERTAIN'].includes(String(v.verdict))&&keys.has(JSON.stringify([v.other_id,v.other_sha256])))}:{})}) +
        '\n# MISSING COMPARISONS ONLY — OUTPUT CONTRACT\nThe original/source and primary-proposal inventory above is read-only context. Compare the PRIMARY-AUDIT PROPOSAL for the assigned candidate against EACH listed full neighbor. This request covers only previously omitted comparisons; do not generate, correct, echo or rewrite triplets and do not infer any verdict from an earlier PASS. Return one fenced JSONL row with ONLY candidate_id and duplicate_verdicts. Return exactly '+refs.length+' judgments, one for every supplied (other_id, other_sha256), each with verdict DISTINCT or DUPLICATE and a specific material reason. No extra IDs, hashes or fields. Example shape only: {"candidate_id":"assigned ID","duplicate_verdicts":[{"other_id":"supplied neighbor ID","other_sha256":"supplied hash","verdict":"DISTINCT|DUPLICATE","reason":"specific material comparison"}]}. Never omit, rubber-stamp or invent a judgment.\n';
      if((excluded.get(cid)||[]).some(v=>object(v)&&['OVERLAP','UNCERTAIN'].includes(String(v.verdict))&&keys.has(JSON.stringify([v.other_id,v.other_sha256])))) prompt += '\n# AMBIGUOUS COMPARISON ADJUDICATION\nWhere prior_ambiguous_judgments is supplied, independently resolve its concern using the complete meanings and information in both texts. Broad thematic similarity alone is not a duplicate finding, and wording differences alone do not establish distinct meaning. Preserve any real duplicate concern: return DUPLICATE for equivalent meaning and UNCERTAIN if the evidence cannot support a final decision. A negative or still-uncertain adjudication remains a quality hold; it will not be retried until PASS.\n';
      if (prompt.length > PHYSICAL_PROMPT_LIMIT) invalid('Completion prompt exceeds hard physical limit');
      const completion: VerificationPacket = {prompt,candidateIds:[cid],neighborIdentities:{[cid]:refs}};
      const result = readPacketResponse(await runMissing(completion,calls-1),completion);
      const addition = JSON.parse(result.get(cid)!) as ObjectValue;
      if (Object.keys(addition).some(k=>!['candidate_id','duplicate_verdicts'].includes(k)) || !Array.isArray(addition.duplicate_verdicts)) invalid('Completion attempted to alter reviewed fields');
      // Reuse strict PASS coverage validation without changing the actual verdicts.
      readPacketResponse(JSON.stringify({...addition,verification_status:'PASS'}),completion);
      verdicts.push(...addition.duplicate_verdicts as ObjectValue[]);
    }
    rows.set(cid,JSON.stringify(row));
  }
  return readPacketResponse([...rows.values()].join('\n'),packet);
}
