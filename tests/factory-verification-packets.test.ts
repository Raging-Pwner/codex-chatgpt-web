import { expect, test } from "bun:test";
import { planVerification, readPacketResponse, mergePacketResponses, PHYSICAL_PROMPT_LIMIT, completePacketResponse } from "../src/factory/verification-packets";

function fixture(count = 8, neighbors = 40, bodyChars = 900) {
  const candidates = Array.from({length: count}, (_,i) => ({original:{candidate_id:`candidate_${i}`,content:'source context'},primary_audit_proposal:{candidate_id:`candidate_${i}`,content:'proposal context'}}));
  const pool = Array.from({length:neighbors}, (_,i) => ({candidate_id:`neighbor_${i}`,row_sha256:i.toString(16).padStart(64,'0'),content:'evidence '.repeat(Math.ceil(bodyChars/9))}));
  const map = Object.fromEntries(candidates.map(c => [c.original.candidate_id,pool]));
  const prompt = '# SYNAPSESPEAK INDEPENDENT SECOND-PASS AUDIT VERIFICATION — BINDING\nGROUP_ID: fixture\nORIGINAL SOURCE ROWS AND PRIMARY-AUDIT PROPOSALS:\n'+JSON.stringify(candidates,null,2)+'\n\nThe final acceptance threshold is high.\nReturn one fenced JSONL block.\n# CONTENT-BOUND DUPLICATE REVIEW\nReview every neighbor. Empty list only if no neighbors.\n'+JSON.stringify(map,null,2);
  return {prompt,candidates,map};
}

test('oversized verification shares all context and preserves every required neighbor',()=>{
  const f=fixture();expect(f.prompt.length).toBeGreaterThan(PHYSICAL_PROMPT_LIMIT);
  const plan=planVerification(f.prompt)!;expect(plan.packets.length).toBeGreaterThan(1);
  expect(plan.packets.flatMap(p=>p.candidateIds)).toEqual(f.candidates.map(c=>c.original.candidate_id));
  for(const packet of plan.packets){
    expect(packet.prompt.length).toBeLessThanOrEqual(PHYSICAL_PROMPT_LIMIT);
    for(const c of f.candidates) expect(packet.prompt).toContain(JSON.stringify(c));
    for(const cid of packet.candidateIds){
      expect(packet.neighborIdentities[cid]).toEqual(f.map[cid]!.map(n=>({candidate_id:n.candidate_id,row_sha256:n.row_sha256})));
      for(const n of f.map[cid]!) expect(packet.prompt).toContain(JSON.stringify(n));
    }
  }
});

test('ordinary small prompts remain exact and oversized ordinary prompts fail closed',()=>{
  expect(planVerification('  exact\n ')).toBeUndefined();
  expect(()=>planVerification('x'.repeat(PHYSICAL_PROMPT_LIMIT+1))).toThrow();
});

test('unknown or malformed oversized verification cannot be partly submitted',()=>{
  const f=fixture();
  expect(()=>planVerification(f.prompt+'\nunknown trailer')).toThrow();
  expect(()=>planVerification(f.prompt.replace('"candidate_id": "candidate_1"','"candidate_id": "candidate_0"'))).toThrow();
  expect(()=>planVerification(f.prompt.replace('"neighbor_0"','"different_neighbor"'))).toThrow();
  const huge=fixture(1,1,10);expect(()=>planVerification(huge.prompt.replace('source context','x'.repeat(PHYSICAL_PROMPT_LIMIT)))).toThrow();
});

test('packet responses need exact assigned IDs; aggregation never invents missing rows',()=>{
  const plan=planVerification(fixture().prompt)!;
  const parts=plan.packets.map(p=>readPacketResponse('```jsonl\n'+p.candidateIds.map(candidate_id=>JSON.stringify({candidate_id,verification_status:'PASS',reason_codes:[],duplicate_verdicts:p.neighborIdentities[candidate_id]!.map(n=>({other_id:n.candidate_id,other_sha256:n.row_sha256,verdict:'DISTINCT',reason:'fixture evidence difference'}))})).join('\n')+'\n```',p));
  expect(mergePacketResponses(plan,parts)).toContain('candidate_7');
  expect(()=>readPacketResponse('{"candidate_id":"unassigned"}',plan.packets[0]!)).toThrow();
  expect(()=>readPacketResponse('{}',plan.packets[0]!)).toThrow();
  expect(()=>readPacketResponse('prose\n{}',plan.packets[0]!)).toThrow();
  expect(()=>mergePacketResponses(plan,parts.slice(1))).toThrow();
});

test('Windows persisted verification envelopes preserve coverage',()=>{
  const f=fixture(); const plan=planVerification(f.prompt.replaceAll('\n','\r\n'))!;
  expect(plan.candidateIds).toEqual(f.candidates.map(c=>c.original.candidate_id));
  expect(plan.packets.every(p=>p.prompt.length<=PHYSICAL_PROMPT_LIMIT)).toBe(true);
});

test('PASS missing a required pair stops delivery; substantive repair/reject remains for core gates',()=>{
 const packet=planVerification(fixture().prompt)!.packets[0]!;
 const rows=packet.candidateIds.map(candidate_id=>({candidate_id,verification_status:'PASS',duplicate_verdicts:packet.neighborIdentities[candidate_id]!.map(n=>({other_id:n.candidate_id,other_sha256:n.row_sha256,verdict:'DISTINCT',reason:'fixture evidence difference'}))}));
 rows[0]!.duplicate_verdicts.pop();
 for(const status of ['PASS','pass','Pass']){ rows[0]!.verification_status=status; expect(()=>readPacketResponse(rows.map(r=>JSON.stringify(r)).join('\n'),packet)).toThrow('Incomplete duplicate verdict coverage'); }
 rows[0]!.verification_status='REPAIR';
 expect(readPacketResponse(rows.map(r=>JSON.stringify(r)).join('\n'),packet).size).toBe(rows.length);
 rows[0]!.verification_status='REJECT';
 expect(readPacketResponse(rows.map(r=>JSON.stringify(r)).join('\n'),packet).size).toBe(rows.length);
});

test('omission recovery preserves valid returned judgments but rejects invented identities',()=>{
 const packet={prompt:'fixture',candidateIds:['candidate_1'],neighborIdentities:{candidate_1:[{candidate_id:'neighbor_1',row_sha256:'a'.repeat(64)},{candidate_id:'neighbor_2',row_sha256:'b'.repeat(64)}]}};
 const line=JSON.stringify({candidate_id:'candidate_1',verification_status:'PASS',en:'immutable fixture source',duplicate_verdicts:[{other_id:'neighbor_1',other_sha256:'a'.repeat(64),verdict:'DISTINCT',reason:'different fixture evidence'}]});
 expect(readPacketResponse(line,packet,true).get('candidate_1')).toBe(line);
 expect(JSON.parse(readPacketResponse(line.replace('neighbor_1','foreign_id'),packet,true).get('candidate_1')!).duplicate_verdicts).toEqual([]);
 expect(()=>readPacketResponse(line,packet)).toThrow('Incomplete duplicate verdict coverage');
});

test('completion requests only absent pairs, retains source context, and preserves every reviewed field',async()=>{
 const f=fixture();const p=planVerification(f.prompt)!.packets[0]!;
 const originals=p.candidateIds.map(candidate_id=>({candidate_id,verification_status:'PASS',reason_codes:[],en:'immutable source fixture',other_field:{value:42},duplicate_verdicts:p.neighborIdentities[candidate_id]!.map(n=>({other_id:n.candidate_id,other_sha256:n.row_sha256,verdict:'DISTINCT',reason:'fixture material difference'}))}));
 originals[0]!.duplicate_verdicts.splice(0,2); let calls=0;
 const rows=await completePacketResponse(originals.map(r=>JSON.stringify(r)).join('\n'),p,async packet=>{
  calls++;expect(packet.candidateIds).toEqual(['candidate_0']);expect(packet.neighborIdentities.candidate_0!.map(x=>x.candidate_id)).toEqual(['neighbor_0','neighbor_1']);
  for(const c of f.candidates)expect(packet.prompt).toContain(JSON.stringify(c));
  expect(packet.prompt.length).toBeLessThanOrEqual(200000);
  return JSON.stringify({candidate_id:'candidate_0',duplicate_verdicts:[{other_id:'neighbor_0',other_sha256:'0'.repeat(64),verdict:'DISTINCT',reason:'independent fixture difference'},{other_id:'neighbor_1',other_sha256:'0'.repeat(63)+'1',verdict:'DUPLICATE',reason:'independent fixture overlap'}]});
 });
 expect(calls).toBe(1);const changed=JSON.parse(rows.get('candidate_0')!);
 expect({...changed,duplicate_verdicts:undefined}).toEqual({...originals[0],duplicate_verdicts:undefined});
 expect(changed.duplicate_verdicts.slice(0,38)).toEqual(originals[0]!.duplicate_verdicts);expect(changed.duplicate_verdicts.at(-1).verdict).toBe('DUPLICATE');
 expect(rows.get('candidate_1')).toBe(JSON.stringify(originals[1]));
});

test('completion cannot rewrite triplets, fabricate absent verdicts, or resend an unchanged request',async()=>{
 const p=planVerification(fixture().prompt)!.packets[0]!;
 const rows=p.candidateIds.map(candidate_id=>({candidate_id,verification_status:'PASS',duplicate_verdicts:p.neighborIdentities[candidate_id]!.map(n=>({other_id:n.candidate_id,other_sha256:n.row_sha256,verdict:'DISTINCT',reason:'fixture difference'}))}));rows[0]!.duplicate_verdicts.pop();
 for(const extra of [{en:'forbidden rewrite'},{duplicate_verdicts:[]},{duplicate_verdicts:[{other_id:'foreign',other_sha256:'0'.repeat(64),verdict:'DISTINCT',reason:'invalid fixture'}]}]){
  let calls=0;await expect(completePacketResponse(rows.map(r=>JSON.stringify(r)).join('\n'),p,async()=>{calls++;return JSON.stringify({candidate_id:'candidate_0',duplicate_verdicts:[{other_id:'neighbor_39',other_sha256:'0'.repeat(62)+'27',verdict:'DISTINCT',reason:'fixture difference'}],...extra});})).rejects.toThrow();
  if(Object.keys(extra).length===0)throw new Error('fixture needs an invalid response');expect(calls).toBe(1);
 }
});

test('small recognized verification also gets complete packet lifecycle',()=>{
 expect(planVerification(fixture(1,1,10).prompt)!.packets).toHaveLength(1);
});

test('recovery quarantines invalid DISTINCT judgments, never counts them, and never discards a duplicate finding',()=>{
 const packet={prompt:'fixture',candidateIds:['c'],neighborIdentities:{c:[{candidate_id:'n',row_sha256:'a'.repeat(64)}]}};
 const line=(verdict:string)=>JSON.stringify({candidate_id:'c',verification_status:'PASS',en:'unchanged fixture',duplicate_verdicts:[{other_id:'unassigned',other_sha256:'b'.repeat(64),verdict,reason:'unassigned fixture comparison'}]});
 expect(JSON.parse(readPacketResponse(line('DISTINCT'),packet,true).get('c')!).duplicate_verdicts).toEqual([]);
 expect(()=>readPacketResponse(line('DISTINCT'),packet)).toThrow();
 expect(()=>readPacketResponse(line('DUPLICATE'),packet,true)).toThrow();
});

test('ambiguous pair gets one independent adjudication with prior concern preserved; negative result is never retried away',async()=>{
 const packet=planVerification(fixture().prompt)!.packets[0]!;
 const rows=packet.candidateIds.map(candidate_id=>({candidate_id,verification_status:'PASS',en:'immutable fixture',duplicate_verdicts:packet.neighborIdentities[candidate_id]!.map(n=>({other_id:n.candidate_id,other_sha256:n.row_sha256,verdict:'DISTINCT',reason:'fixture meaning difference'}))}));rows[0]!.duplicate_verdicts[0]!.verdict='OVERLAP';rows[0]!.duplicate_verdicts[0]!.reason='Both concern a broad fixture theme';
 let calls=0;const result=await completePacketResponse(rows.map(r=>JSON.stringify(r)).join('\n'),packet,async p=>{calls++;expect(p.prompt).toContain('prior_ambiguous_judgments');expect(p.prompt).toContain('Both concern a broad fixture theme');expect(p.neighborIdentities.candidate_0).toHaveLength(1);return JSON.stringify({candidate_id:'candidate_0',duplicate_verdicts:[{other_id:'neighbor_0',other_sha256:'0'.repeat(64),verdict:'DUPLICATE',reason:'Fresh independent fixture judgment confirms same complete meaning'}]});});
 expect(calls).toBe(1);expect(JSON.parse(result.get('candidate_0')!).duplicate_verdicts.at(-1).verdict).toBe('DUPLICATE');
});
