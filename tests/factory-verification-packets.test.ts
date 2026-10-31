import { expect, test } from "bun:test";
import { planVerification, readPacketResponse, mergePacketResponses, partitionInitialComparisonContext, PHYSICAL_PROMPT_LIMIT, completePacketResponse, sha256, scheduleInitialComparisonReply } from "../src/factory/verification-packets";

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

test('large batch context is projected per target while all peer proposals and every required neighbor remain',()=>{
 const f=fixture(44,80,900);
 const candidates=f.candidates.map((c,i)=>({...c,original:{...c.original,content:`distinct original ${i}: `+'x'.repeat(4000)}}));
 const input=f.prompt.replace(JSON.stringify(f.candidates,null,2),JSON.stringify(candidates,null,2));
 const plan=planVerification(input)!;
 expect(plan.candidateIds).toHaveLength(44);expect(plan.packets.length).toBeLessThan(44);
 expect(plan.packets.flatMap(p=>p.candidateIds)).toEqual(candidates.map(c=>c.original.candidate_id));
 for(const packet of plan.packets){
  expect(packet.prompt.length).toBeLessThanOrEqual(200000);expect(packet.contextMode).toBe('assigned-source-and-all-peer-proposals');
  for(const cid of packet.candidateIds){
   const candidate=candidates.find(c=>c.original.candidate_id===cid)!;
   expect(packet.prompt).toContain(JSON.stringify(candidate));
   expect(packet.neighborIdentities[cid]).toHaveLength(80);
   for(const n of f.map[cid]!)expect(packet.prompt).toContain(JSON.stringify(n));
  }
  for(const candidate of candidates)expect(packet.prompt).toContain(JSON.stringify(candidate.primary_audit_proposal));
 }
});

test('indexed judgments resolve only against the frozen per-candidate neighbors without changing reviewed content',()=>{
 const packet={prompt:'fixture',candidateIds:['c'],neighborIdentities:{c:[{candidate_id:'n',row_sha256:'a'.repeat(64)}]},replyFormat:'indexed-neighbor-verdicts/v1' as const};
 const raw={candidate_id:'c',verification_status:'PASS',en:'unchanged source fixture',duplicate_verdicts:[{other_index:0,verdict:'DUPLICATE',reason:'independent same-meaning finding'}]};
 const row=JSON.parse(readPacketResponse(JSON.stringify(raw),packet).get('c')!);
 expect(row.en).toBe(raw.en);expect(row.duplicate_verdicts).toEqual([{other_id:'n',other_sha256:'a'.repeat(64),verdict:'DUPLICATE',reason:'independent same-meaning finding'}]);
 for(const other_index of [-1,1,0.5,null]) expect(()=>readPacketResponse(JSON.stringify({...raw,duplicate_verdicts:[{...raw.duplicate_verdicts[0],other_index}]}),packet,true)).toThrow();
 expect(()=>readPacketResponse(JSON.stringify({...raw,duplicate_verdicts:[{...raw.duplicate_verdicts[0],other_id:'forged'}]}),packet)).toThrow();
 expect(()=>readPacketResponse(JSON.stringify(raw),{...packet,replyFormat:undefined})).toThrow();
});


test('neighbor indices are candidate-local and duplicate index coverage is rejected',()=>{
 const refs=[{candidate_id:'n1',row_sha256:'a'.repeat(64)},{candidate_id:'n2',row_sha256:'b'.repeat(64)}];
 const packet={prompt:'fixture',candidateIds:['c1','c2'],neighborIdentities:{c1:refs,c2:[refs[1]!,refs[0]!]},replyFormat:'indexed-neighbor-verdicts/v1' as const};
 const row=(candidate_id:string)=>({candidate_id,verification_status:'PASS',duplicate_verdicts:[1,0].map(other_index=>({other_index,verdict:'DISTINCT',reason:'independent fixture distinction'}))});
 const rows=readPacketResponse([row('c1'),row('c2')].map(x=>JSON.stringify(x)).join('\n'),packet);
 expect(JSON.parse(rows.get('c1')!).duplicate_verdicts.map((v:any)=>v.other_id)).toEqual(['n2','n1']);
 expect(JSON.parse(rows.get('c2')!).duplicate_verdicts.map((v:any)=>v.other_id)).toEqual(['n1','n2']);
 const bad=row('c1');bad.duplicate_verdicts[1]!.other_index=1;
 expect(()=>readPacketResponse([bad,row('c2')].map(x=>JSON.stringify(x)).join('\n'),packet)).toThrow();
});


test("large single-target projection keeps assignments, peers, neighbors and untouched hashes",async()=>{
  const cs=Array.from({length:3},(_,i)=>({original:{candidate_id:`c_${i}`,content:`original_${i} `+'o'.repeat(2800)},primary_audit_proposal:{candidate_id:`c_${i}`,content:`proposal_${i} `+'p'.repeat(700)}}));
  const ns=Object.fromEntries(cs.map((c,i)=>[c.original.candidate_id,Array.from({length:i===1?164:128},(_,j)=>({candidate_id:`n_${i}_${j}`,row_sha256:(i*1000+j).toString(16).padStart(64,'0'),content:'v'.repeat(i===1?850:500)}))]));
  const prompt='# SYNAPSESPEAK INDEPENDENT SECOND-PASS AUDIT VERIFICATION\nORIGINAL SOURCE ROWS AND PRIMARY-AUDIT PROPOSALS:\n'+JSON.stringify(cs)+'\n# CONTENT-BOUND DUPLICATE REVIEW\nEmpty list only if no neighbors.\n'+JSON.stringify(ns);
  const packets=planVerification(prompt)!.packets;
  expect(packets.map(p=>p.candidateIds)).toEqual([['c_0'],['c_1'],['c_2']]);
  expect(sha256(packets[0]!.prompt)).toBe('b8c3c6d18cf9318ad4c8db7ade34067f77ee8e10225a37cf38e89fe0df9e2acc');
  expect(sha256(packets[2]!.prompt)).toBe('ede61aacdbb952d968bfac16b8e892fd36cedd639a7c1af3f33391451fbc986e');
  const p=packets[1]!;expect(p.contextMode).toBe('assigned-source-and-all-peer-proposals');
  expect(p.prompt.length).toBeLessThan(191885);expect(p.prompt).toContain(JSON.stringify(cs[1]));
  for(const i of [0,2]){expect(p.prompt).toContain(JSON.stringify(cs[i]!.primary_audit_proposal));expect(p.prompt).not.toContain(JSON.stringify(cs[i]!.original));}
  expect(p.neighborIdentities.c_1).toEqual(ns.c_1!.map(n=>({candidate_id:n.candidate_id,row_sha256:n.row_sha256})));
  for(const n of ns.c_1!)expect(p.prompt).toContain(JSON.stringify(n));
  expect(p.prompt).toContain('# BOUNDED INITIAL COMPARISON REPLY');
  expect(p.prompt).toContain('other_index 0 through 23');
  const base={candidate_id:'c_1',verification_status:'PASS',fixture_field:'immutable',duplicate_verdicts:Array.from({length:24},(_,other_index)=>({other_index,verdict:'DISTINCT',reason:'offline fixture distinction'}))};
  const batches:number[]=[];
  const result=await completePacketResponse(JSON.stringify(base),p,async extra=>{
    const refs=extra.neighborIdentities.c_1!;batches.push(refs.length);
    expect(extra.prompt).not.toContain('# BOUNDED INITIAL COMPARISON REPLY');
    expect(extra.prompt).toContain(JSON.stringify(cs[1]));
    for(const i of [0,2])expect(extra.prompt).toContain(JSON.stringify(cs[i]!.primary_audit_proposal));
    return JSON.stringify({candidate_id:'c_1',duplicate_verdicts:refs.map((ref,index)=>({other_id:ref.candidate_id,other_sha256:ref.row_sha256,verdict:batches.length===6&&index===19?'DUPLICATE':'DISTINCT',reason:'offline fixture comparison'}))});
  });
  expect(batches).toEqual([24,24,24,24,24,20]);
  const full=JSON.parse(result.get('c_1')!);expect(full.fixture_field).toBe('immutable');
  expect(full.duplicate_verdicts).toHaveLength(164);expect(new Set(full.duplicate_verdicts.map((v:any)=>v.other_id)).size).toBe(164);
  expect(full.duplicate_verdicts.at(-1).verdict).toBe('DUPLICATE');

});

const SINGLE_SUFFIX = '\n# BOUNDED INITIAL COMPARISON REPLY\nFor this INITIAL physical reply only, return the complete independently reviewed row and duplicate_verdicts for other_index 0 through 23. This initial output schedule supersedes the earlier instruction to emit every comparison in one reply. All supplied neighbors remain full read-only evidence. Do not omit any material concern: preserve REPAIR, REJECT, DUPLICATE or unresolved findings as required. The factory will independently request each remaining required comparison in bounded follow-up calls, and cannot deliver a complete logical PASS until every required comparison has an actual judgment. Do not emit remaining indices in this initial reply or invent their results. Every source-fidelity, identity, quality and negative-finding rule remains unchanged.\n';

function scheduledIndices(packet: {prompt:string}): Record<string, number[]> {
  return JSON.parse(packet.prompt.split('Candidate-local initial comparison schedule (JSON):\n')[1]!.split('\n')[0]!);
}

test('pure initial schedule shares 24 decisions across six candidates without mutating evidence',async()=>{
  const packet=planVerification(fixture(6,40,100).prompt)!.packets[0]!;
  const before=JSON.stringify(packet);const scheduled=scheduleInitialComparisonReply(packet);
  const indices=scheduledIndices(scheduled);
  expect(Object.keys(indices)).toEqual(packet.candidateIds);
  for(const cid of packet.candidateIds)expect(indices[cid]).toEqual([0,1,2,3]);
  expect(Object.values(indices).flat()).toHaveLength(24);
  expect(scheduled.prompt.startsWith(packet.prompt)).toBeTrue();
  expect(scheduled.neighborIdentities).toBe(packet.neighborIdentities);
  expect(JSON.stringify(packet)).toBe(before);
  const initial=packet.candidateIds.map(candidate_id=>({candidate_id,verification_status:'PASS',en:'immutable source',duplicate_verdicts:indices[candidate_id]!.map(other_index=>({other_index,verdict:'DISTINCT',reason:'fixture distinction'}))}));
  const calls:number[]=[];
  const result=await completePacketResponse(initial.map(r=>JSON.stringify(r)).join('\n'),scheduled,async extra=>{
    const candidate_id=extra.candidateIds[0]!;const refs=extra.neighborIdentities[candidate_id]!;calls.push(refs.length);
    return JSON.stringify({candidate_id,duplicate_verdicts:refs.map(ref=>({other_id:ref.candidate_id,other_sha256:ref.row_sha256,verdict:'DISTINCT',reason:'fixture comparison'}))});
  });
  expect(calls.length).toBe(12);expect(calls.every(n=>n<=24)).toBeTrue();
  for(const cid of packet.candidateIds){const r=JSON.parse(result.get(cid)!);expect(r.en).toBe('immutable source');expect(r.duplicate_verdicts).toHaveLength(40);}
});

test('single indexed schedule preserves the exact previously published suffix and is idempotent',()=>{
  const packet=planVerification(fixture(1,164,100).prompt)!.packets[0]!;
  const scheduled=scheduleInitialComparisonReply(packet);
  expect(scheduled.prompt).toBe(packet.prompt+SINGLE_SUFFIX);
  expect(scheduleInitialComparisonReply(scheduled)).toBe(scheduled);
});

test('small initial schedules stay byte-identical and sparse candidates receive deterministic budget',()=>{
  const packet=planVerification(fixture(6,4,100).prompt)!.packets[0]!;
  expect(scheduleInitialComparisonReply(packet)).toBe(packet);
  const large=planVerification(fixture(3,40,100).prompt)!.packets[0]!;const ids=large.candidateIds;
  const sparse={...large,neighborIdentities:{[ids[0]!]:[],[ids[1]!]:large.neighborIdentities[ids[1]!]!.slice(0,1),[ids[2]!]:large.neighborIdentities[ids[2]!]!}};
  const indices=scheduledIndices(scheduleInitialComparisonReply(sparse));
  expect(indices[ids[0]!]).toEqual([]);expect(indices[ids[1]!]).toEqual([0]);
  expect(indices[ids[2]!]).toEqual(Array.from({length:23},(_,i)=>i));
});

test('nonindexed initial schedule names exact supplied identities and never invents indices',()=>{
  const packet=planVerification(fixture(2,40,100).prompt)!.packets[0]!;
  const legacy={...packet,prompt:packet.legacyPrompt!,replyFormat:undefined};
  const scheduled=scheduleInitialComparisonReply(legacy);
  const selected=JSON.parse(scheduled.prompt.split('Candidate-local initial comparison schedule (JSON):\n')[1]!.split('\n')[0]!);
  for(const cid of packet.candidateIds)expect(selected[cid]).toEqual(packet.neighborIdentities[cid]!.slice(0,12).map(n=>({other_id:n.candidate_id,other_sha256:n.row_sha256})));
});

test('initial schedule fails closed when the physical prompt has no suffix headroom',()=>{
  const packet=planVerification(fixture(1,40,100).prompt)!.packets[0]!;
  expect(()=>scheduleInitialComparisonReply({...packet,prompt:'x'.repeat(PHYSICAL_PROMPT_LIMIT)})).toThrow();
});


test('near-limit unindexed scheduling shortens only the recognized assignment prose',async()=>{
  const indexed=planVerification(fixture(1,174,100).prompt)!.packets[0]!;
  const raw=indexed.legacyPrompt!;
  const packet={...indexed,prompt:raw.replace('GROUP_ID: fixture\n','GROUP_ID: fixture\n'+'x'.repeat(199995-raw.length)),replyFormat:undefined,legacyPrompt:undefined};
  expect(packet.prompt.length).toBe(199995);
  const boundary='\n# VERIFICATION TRANSPORT ASSIGNMENT\n';
  const prefix=packet.prompt.slice(0,packet.prompt.indexOf(boundary));
  const scheduled=scheduleInitialComparisonReply(packet);
  expect(scheduled.prompt.length).toBeLessThanOrEqual(PHYSICAL_PROMPT_LIMIT);
  expect(scheduled.prompt.slice(0,scheduled.prompt.indexOf(boundary))).toBe(prefix);
  expect(scheduled.prompt).toContain('first 24 neighbors_by_candidate references');
  expect(scheduled.neighborIdentities).toBe(packet.neighborIdentities);
  expect(scheduleInitialComparisonReply(scheduled)).toBe(scheduled);
  const cid=packet.candidateIds[0]!;const refs=packet.neighborIdentities[cid]!;
  const judgments=(values:typeof refs)=>values.map(ref=>({other_id:ref.candidate_id,other_sha256:ref.row_sha256,verdict:'DISTINCT',reason:'fixture comparison'}));
  let calls=0;
  const result=await completePacketResponse(JSON.stringify({candidate_id:cid,verification_status:'PASS',en:'immutable',duplicate_verdicts:judgments(refs.slice(0,24))}),scheduled,async extra=>{
    calls++;expect(extra.prompt.length).toBeLessThanOrEqual(PHYSICAL_PROMPT_LIMIT);
    const duplicate_verdicts=judgments(extra.neighborIdentities[cid]!);
    if(calls===7)duplicate_verdicts.at(-1)!.verdict='DUPLICATE';
    return JSON.stringify({candidate_id:cid,duplicate_verdicts});
  });
  expect(calls).toBe(7);const full=JSON.parse(result.get(cid)!);
  expect(full.en).toBe('immutable');expect(full.duplicate_verdicts).toHaveLength(174);
  expect(full.duplicate_verdicts.at(-1).verdict).toBe('DUPLICATE');
  expect(()=>scheduleInitialComparisonReply({...packet,prompt:packet.prompt+'\nUNRECOGNIZED GATE'})).toThrow();
});


test('deferred comparison context supplies only initial full bodies and seals every complement before PASS',async()=>{
 const full=planVerification(fixture(1,164,900).prompt)!.packets[0]!;
 const packet=partitionInitialComparisonContext(full);
 expect(packet.comparisonMode).toBe('initial-subset-with-sealed-complements/v1');
 expect(packet.neighborIdentities).toBe(full.neighborIdentities);
 expect(packet.initialNeighborIdentities!.candidate_0).toHaveLength(24);
 expect(packet.comparisonPrompt).toContain('neighbor_163');
 const marker='Empty list only if no neighbors.\n';
 const jsonStart=packet.prompt.indexOf(marker)+marker.length;
 const data=JSON.parse(packet.prompt.slice(jsonStart,packet.prompt.indexOf('\n# VERIFICATION TRANSPORT ASSIGNMENT',jsonStart)));
 expect(data.neighbor_pool).toHaveLength(24);expect(data.neighbors_by_candidate.candidate_0).toHaveLength(24);
 expect(packet.prompt).not.toContain('"candidate_id":"neighbor_163"');
 expect(packet.prompt.slice(0,jsonStart)).toBe(full.prompt.slice(0,full.prompt.indexOf(marker)+marker.length));
 const base={candidate_id:'candidate_0',verification_status:'PASS',en:'immutable fixture',duplicate_verdicts:Array.from({length:24},(_,other_index)=>({other_index,verdict:'DISTINCT',reason:'offline fixture distinction'}))};
 const calls:number[]=[];
 const result=await completePacketResponse(JSON.stringify(base),packet,async extra=>{
  const refs=extra.neighborIdentities.candidate_0!;calls.push(refs.length);
  for(const ref of refs)expect(extra.prompt).toContain(ref.candidate_id);
  return JSON.stringify({candidate_id:'candidate_0',duplicate_verdicts:refs.map((ref,i)=>({other_id:ref.candidate_id,other_sha256:ref.row_sha256,verdict:calls.length===6&&i===19?'DUPLICATE':'DISTINCT',reason:'offline fixture comparison'}))});
 });
 expect(calls).toEqual([24,24,24,24,24,20]);const row=JSON.parse(result.get('candidate_0')!);
 expect(row.en).toBe('immutable fixture');expect(row.duplicate_verdicts).toHaveLength(164);expect(row.duplicate_verdicts.at(-1).verdict).toBe('DUPLICATE');
 const foreign={...base,duplicate_verdicts:[{other_index:24,verdict:'DISTINCT',reason:'not supplied'}]};
 await expect(completePacketResponse(JSON.stringify(foreign),packet,async()=>{throw Error('must not call');})).rejects.toThrow('index');
});
