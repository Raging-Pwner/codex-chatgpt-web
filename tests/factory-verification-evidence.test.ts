import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationEvidenceWriter, verificationResponseReader } from "../src/factory/verification-evidence";
import { sha256 } from "../src/factory/verification-packets";

test("private ledger preserves exact packet inputs, outputs and source hashes without overwrite",()=>{
 const root=mkdtempSync(join(tmpdir(),"factory-ledger-"));
 try {
  const write=verificationEvidenceWriter(root,{bridge_entry_sha256:"sourcehash"});
  const plan={logicalPromptSha256:sha256("logical"),candidateIds:["candidate_1"],packets:[{prompt:"exact input\n",candidateIds:["candidate_1"],neighborIdentities:{candidate_1:[]}}]};
  const event={stage:"plan" as const,logicalId:"logical_001",modelFamily:"6" as const,reasoning:"high" as const,plan,packetTraceIds:["packet_001"]};
  write(event);const folder=join(root,"verification_packets","logical_001");
  expect(readFileSync(join(folder,"packet_001.prompt.txt"),"utf8")).toBe("exact input\n");
  const manifest=JSON.parse(readFileSync(join(folder,"manifest.json"),"utf8"));
  expect(manifest.requested_model_family).toBe("6"); expect(manifest.requested_reasoning).toBe("high");
  expect(manifest.source.bridge_entry_sha256).toBe("sourcehash");
  expect(manifest.packets[0].prompt_sha256).toBe(sha256("exact input\n"));
  const result={stage:"result" as const,logicalId:"logical_001",packetTraceId:"packet_001",text:"exact output\n",responseSha256:sha256("exact output\n")};
  write(result);expect(readFileSync(join(folder,"packet_001.response.txt"),"utf8")).toBe(result.text);
  expect(()=>write(event)).toThrow(); expect(()=>write(result)).toThrow();
  expect(()=>write({...result,packetTraceId:"packet_002",responseSha256:"bad"})).toThrow();
  expect(existsSync(join(folder,"packet_002.response.txt"))).toBe(false);
  expect(()=>write({...result,logicalId:"../escape"})).toThrow();
  expect(()=>verificationEvidenceWriter("relative",{})).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('resume reuses only hash-bound matching-model physical responses, including incomplete ones',()=>{
 const root=mkdtempSync(join(tmpdir(),'factory-resume-'));
 try {
  const packet={prompt:'exact saved prompt',candidateIds:['candidate_1'],neighborIdentities:{candidate_1:[]}};
  const write=verificationEvidenceWriter(root,{bridge_entry_sha256:'a'.repeat(64),browser_helper_sha256:'b'.repeat(64)});
  write({stage:'plan',logicalId:'logical_001',modelFamily:'6',reasoning:'high',plan:{logicalPromptSha256:sha256('logical'),candidateIds:['candidate_1'],packets:[packet]},packetTraceIds:['packet_001']});
  const response='{"candidate_id":"candidate_1"}';write({stage:'submitted',logicalId:'logical_001',packetTraceId:'packet_001'});write({stage:'result',logicalId:'logical_001',packetTraceId:'packet_001',text:response,responseSha256:sha256(response)});
  const read=verificationResponseReader(root);expect(read(packet,'6','high')!.text).toBe(response);
  const manifestPath=join(root,'verification_packets','logical_001','manifest.json');const manifestOriginal=readFileSync(manifestPath,'utf8');
  require('node:fs').writeFileSync(manifestPath,manifestOriginal.replace('"requested_model_family": "6"','"requested_model_family": "5.6"'));
  expect(read(packet,'5.6','high')).toBeUndefined();
  require('node:fs').writeFileSync(manifestPath,manifestOriginal);
  const supplemental={...packet,prompt:'missing only prompt'};
  write({stage:'supplement_plan',logicalId:'logical_001',packet:supplemental,packetTraceId:'packet_001_s1',packetIndex:0,sourceResponseSha256:sha256(response)});
  write({stage:'submitted',logicalId:'logical_001',packetTraceId:'packet_001_s1'});
  write({stage:'result',logicalId:'logical_001',packetTraceId:'packet_001_s1',text:'supplement result',responseSha256:sha256('supplement result')});
  expect(read(supplemental,'6','high',sha256(response))!.text).toBe('supplement result');
  require('node:fs').writeFileSync(join(root,'verification_packets','logical_001','broken_sibling.supplement.json'),'{broken');
  expect(read(supplemental,'6','high',sha256(response))!.text).toBe('supplement result');
  expect(read(supplemental,'6','high',sha256('different parent'))).toBeUndefined();

  expect(read(packet,'5.6','high')).toBeUndefined();expect(read(packet,'6','xhigh')).toBeUndefined();
  expect(read({...packet,prompt:'changed prompt'},'6','high')).toBeUndefined();
  expect(read({...packet,neighborIdentities:{candidate_1:[{candidate_id:'foreign',row_sha256:'0'.repeat(64)}]}},'6','high')).toBeUndefined();
  const path=join(root,'verification_packets','logical_001','packet_001.response.txt');
  require('node:fs').writeFileSync(path,'tampered');expect(read(packet,'6','high')).toBeUndefined();
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('deferred initial identity scope is sealed and required for cache reuse',()=>{
 const root=mkdtempSync(join(tmpdir(),'factory-deferred-'));
 try{
  const refs=[{candidate_id:'neighbor_1',row_sha256:'a'.repeat(64)},{candidate_id:'neighbor_2',row_sha256:'b'.repeat(64)}];
  const packet={prompt:'exact deferred initial prompt',candidateIds:['candidate_1'],neighborIdentities:{candidate_1:refs},initialNeighborIdentities:{candidate_1:refs.slice(0,1)},comparisonMode:'initial-subset-with-sealed-complements/v1' as const,comparisonPrompt:'private complete comparison envelope'};
  const write=verificationEvidenceWriter(root,{bridge_entry_sha256:'a'.repeat(64),browser_helper_sha256:'b'.repeat(64)});
  write({stage:'plan',logicalId:'deferred_001',modelFamily:'6',reasoning:'high',plan:{logicalPromptSha256:sha256('logical'),candidateIds:packet.candidateIds,packets:[packet]},packetTraceIds:['physical_001']});
  const manifest=JSON.parse(readFileSync(join(root,'verification_packets','deferred_001','manifest.json'),'utf8'));
  expect(manifest.packets[0].comparison_mode).toBe(packet.comparisonMode);expect(manifest.packets[0].initial_neighbor_identities).toEqual(packet.initialNeighborIdentities);
  expect(JSON.stringify(manifest)).not.toContain(packet.comparisonPrompt);
  const text='raw fixture result';write({stage:'submitted',logicalId:'deferred_001',packetTraceId:'physical_001'});write({stage:'result',logicalId:'deferred_001',packetTraceId:'physical_001',text,responseSha256:sha256(text)});
  const read=verificationResponseReader(root);expect(read(packet,'6','high')!.text).toBe(text);
  expect(read({...packet,initialNeighborIdentities:{candidate_1:refs.slice(1)}},'6','high')).toBeUndefined();
  expect(read({...packet,comparisonMode:undefined,initialNeighborIdentities:undefined},'6','high')).toBeUndefined();
 }finally{rmSync(root,{recursive:true,force:true});}
});
