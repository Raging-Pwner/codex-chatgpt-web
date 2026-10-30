import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationEvidenceWriter } from "../src/factory/verification-evidence";
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
