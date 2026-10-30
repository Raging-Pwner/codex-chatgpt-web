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
export type VerificationPacket = { prompt: string; candidateIds: string[]; neighborIdentities: Record<string, NeighborIdentity[]> };
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
  if (prompt.length <= PHYSICAL_PROMPT_LIMIT) return undefined;
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
  const render = (assigned: string[]): VerificationPacket => {
    const required: Record<string, NeighborIdentity[]> = Object.create(null); const pool = new Map<string, ObjectValue>();
    for (const cid of assigned) {
      required[cid] = identities[cid]!;
      for (const ref of required[cid]!) { const key = JSON.stringify([ref.candidate_id, ref.row_sha256]); pool.set(key, byIdentity.get(key)!); }
    }
    const data = { assigned_candidate_ids: assigned, neighbors_by_candidate: required, neighbor_pool: [...pool.values()] };
    const assignment = '\n# VERIFICATION TRANSPORT ASSIGNMENT\nAll original/source and primary-proposal rows above remain read-only review context. Return exactly one verification row for EACH assigned_candidate_ids entry, and no unassigned rows. The neighbor_pool contains each full neighbor once; resolve every neighbors_by_candidate reference by candidate_id AND row_sha256. Return every required duplicate_verdict with its supplied hash and a specific material reason. This lossless transport partition changes output assignment only; all quality, identity, rejection and independent-verification rules remain in force. Do not generate examples, omit evidence or rubber-stamp a proposal.\n';
    return { prompt: prompt.slice(0, start) + JSON.stringify(candidates) + prompt.slice(parsed.end, mapStart) + JSON.stringify(data) + assignment, candidateIds: assigned, neighborIdentities: required };
  };
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
  return { logicalPromptSha256: sha256(prompt), candidateIds, packets };
}

export function readPacketResponse(text: string, packet: VerificationPacket): Map<string, string> {
  let body = text.trim();
  if (body.startsWith('```')) {
    const fence = /^```(?:jsonl|json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(body);
    if (!fence) invalid('Invalid verification response fence'); body = fence[1]!;
  }
  const rows = new Map<string, string>();
  for (const line of body.split(/\r?\n/).filter(line => line.trim())) {
    let row: unknown; try { row = JSON.parse(line); } catch { invalid('Malformed verification JSONL response'); }
    if (!object(row) || typeof row.candidate_id !== 'string' || !packet.candidateIds.includes(row.candidate_id) || rows.has(row.candidate_id)) invalid('Unassigned or repeated verification response identity');
    // Reject an incomplete PASS before spending time on later packets. Substantive
    // REPAIR/REJECT decisions still reach the Python factory's original hold gates.
    if (typeof row.verification_status === 'string' && row.verification_status.toUpperCase() === 'PASS') {
      const required = packet.neighborIdentities[row.candidate_id]!;
      const verdicts = row.duplicate_verdicts;
      if (!Array.isArray(verdicts) || verdicts.length !== required.length) invalid('Incomplete duplicate verdict coverage for ' + row.candidate_id);
      const expected = new Set(required.map(n => JSON.stringify([n.candidate_id, n.row_sha256])));
      for (const verdict of verdicts) {
        if (!object(verdict) || typeof verdict.reason !== 'string' || !verdict.reason.trim() || typeof verdict.verdict !== 'string' || !verdict.verdict.trim()
          || !expected.delete(JSON.stringify([verdict.other_id, verdict.other_sha256]))) invalid('Invalid duplicate verdict identity or reason for ' + row.candidate_id);
      }
      if (expected.size) invalid('Incomplete duplicate verdict coverage for ' + row.candidate_id);
    }
    rows.set(row.candidate_id, line);
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
