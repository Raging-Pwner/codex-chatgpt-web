<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.17/codex-web-gpt-6.1.17-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.17/codex-web-gpt-6.1.17-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.17/codex-web-gpt-6.1.17-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.17/codex-web-gpt-6.1.17-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">What’s new</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex’s native model picker. Messages run through your signed-in ChatGPT Web session and are subject to the limits applied to that account. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your Codex task, so you can keep working as the context grows.

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Paid accounts → **GPT-6 Sol** and **GPT-5.6 Sol**, with **Instant–High**, plus **Extra High** and **Pro** when available. Each version has its own entry; existing GPT-5.6 chats keep GPT-5.6. Availability depends on your account and workspace.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models** and restart Codex once. In automatic mode, choose a model ending in **(Web)**. Pro versions have separate entries; Sol reasoning is selected through Effort. Zero Risk keeps its dedicated entry.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `Codex Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic models ending in **(Web)** expose their supported Effort choices in Codex. Instant and each Pro version have separate entries to preserve their context budgets; older saved model entries keep their original fixed mode.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher uses your system proxy for the tunnel. Explicitly configured proxy
environment variables take priority; local connections stay local.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window.
> GPT-5.6 supports up to 270,000 tokens with experimental **3× context** enabled, with native
> Codex compaction supported throughout.
>
> GPT-6 Sol supports Bigger Context at Medium, High and available Extra High: **120,000 tokens
> on Plus**, with compaction at **110,000**, and **240,000 on Pro**, with compaction at **220,000**.
> GPT-6 Instant uses standard context.
> GPT-5.6 and GPT-6 Pro keep their existing Bigger Context limits.

1. Finish the required setup, open **MCP**, create the Tunnel and regular API key, then press
   **Connect harness**.
2. Enable ChatGPT **Developer Mode** and create a new Tunnel connector named exactly
   **Codex Native2**, with **Authentication: None** and **Allow all actions**.
3. Run **Verify runtime** to confirm that **Codex Native2** is attached and available.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings can also cancel a retained browser turn or remove the Codex integration before uninstall.
**Settings → Temporary Chat** is on by default and keeps new task conversations out of ChatGPT
history. Turn it off to use ordinary saved chats or if your connector is unavailable in that mode.
ChatGPT memory and custom instructions may apply in either mode. **New browser chat for each turn**
separately controls conversation reuse. An explicit choice to disable Temporary Chat is preserved when updating.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Task prompts are processed by OpenAI and conversations remain in your ChatGPT history.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal Codex route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Also by me: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — local, near-real-time custom voices for ChatGPT and Codex.


### Triplet Factory mode (local fork)

`codex-chatgpt-web factory` is an opt-in JSONL command for the SynapseSpeak factory.
It reads the existing launcher configuration without saving it. It requires automatic
browser interaction and a signed-in launcher. Build with the pinned Bun version and
run `dist/runtime/runtime/bun.exe dist/runtime/app/cli.js factory`.
For source development supply `--browser-helper ABSOLUTE_BUILT_HELPER_PATH`.
`--diagnostics-dir ABSOLUTE_PATH` keeps browser diagnostics in the caller's private output.

The first stdout message is `{"type":"ready","protocol":"triplet-factory/v1","version":"6.1.17"}`.
Send `{"type":"inspect","id":"inspect_001"}` and await its result before running work.
A run is `{"type":"run","id":"request_001","prompt":"exact factory prompt","modelFamily":"6","reasoning":"high"}`. Use `"reasoning":"xhigh"` only after observed Extra High capability; unavailable efforts fail without fallback.
Model family is explicit; there is no fallback. Ordinary prompts remain exact text, with no
Codex context, attachments, connector, or local tools. Each run creates a fresh ordinary
conversation, so account chat history applies. Browser preparation and submission are serialized to avoid overlapping native input; submitted responses still run concurrently. At most three jobs run concurrently;
capacity rejection is immediate. IDs cannot be reused in one process. Events are progress;
only a `result` containing `text` means completion. Errors never trigger automatic resend.
Send `{"type":"cancel","id":"request_001"}` to abort an owned job, or
`{"type":"shutdown"}` to abort owned work and close this command's helper. EOF also
shuts it down. This does not stop the launcher or cancel other clients' requests.
This transport does not certify triplet quality or authorize bulk generation.

Factory model selection waits for a visible, enabled effort control inside the active composer, within the existing readiness timeout. A disabled or aria-disabled hydration placeholder does not authorize menu activation; exact model-family and effort verification still precede Send. The 2026-10-30 Synapse pilot reproduced this readiness gap before submission; both delayed-enable DOM regressions and the affected 56-test suite passed after repair.

Oversized structured SynapseSpeak independent verification requests alone use lossless
transport partitions (logical limit 8,000,000 characters; each physical prompt remains
at most 200,000). Every packet retains all original rows and primary proposals as
read-only context. Assigned candidates reference a pool containing every required
neighbor body and content hash; nothing is sampled or truncated. Each packet uses a
fresh independent conversation with the requested model family and effort. At most
six candidates and a target of 256 duplicate decisions are assigned per packet; a
single candidate exceeding the hard prompt limit fails closed.

The parent reports submission only once and completes only after every packet has
returned its exact assigned candidate inventory. Original response rows are merged
without rewriting verdicts; the Python factory still applies its quality and duplicate
gates. Cancellation or failure stops remaining packets without resending. Ordinary
oversized requests and unknown verification envelopes fail closed.
`--diagnostics-dir` is mandatory for partitioning: its private `verification_packets/ID/`
ledger preserves exact physical prompts and responses, a manifest binding logical
prompt, candidate/neighbor identities and bridge/helper artifact hashes, and events.
A ledger write failure blocks completion. Transport tests do not certify model quality.

A monitored 2026-10-30 live packet returned 96 of 98 required pair verdicts for
one PASS row. The operator stopped the audit; no rows were accepted. Packet
response validation now detects incomplete PASS pair inventories immediately,
before submitting a later packet, while retaining substantive REPAIR/REJECT
handling in the Python factory. This is a completeness gate, not a semantic
uniqueness certificate. Raw failed output remains in the private packet ledger.

Missing-verdict recovery is bounded and content-preserving. A valid PASS response
that omits comparison identities is retained; unknown, repeated or wrong-hash
judgments still fail. Fresh independent turns request only absent pairs, at most
24 per turn and 16 supplemental turns per physical packet. They retain the full
original/source and primary-proposal inventory and the required full neighbor
bodies. Supplement output may contain only candidate_id and duplicate_verdicts;
it cannot rewrite translations, metadata, reason codes or review status. Existing
judgments and every substantive DUPLICATE/REPAIR/REJECT decision remain intact.
Final exact-coverage and the Python factory's quality gates still apply. A failed
supplement is not resent automatically.

`verification_packets/` also supports restart reuse of raw model responses only
when the exact physical prompt, candidate/neighbor inventory, model family, effort,
submitted evidence and response hash match. Raw reused input/output and its source
manifest/path/hash are recorded in the new ledger; cache hits never certify a row.
Small recognized verification requests use the same lifecycle. Ordinary factory
prompts remain unchanged. This repairs workflow omissions; a genuine quality
finding still requires factory repair and fresh independent review.

Misassigned positive judgments are recoverable too: an invalid DISTINCT claim
(unassigned/wrong-hash/repeated identity or missing reason) is quarantined in the
private ledger and never counts as required evidence. The original raw response
remains immutable. The factory requests every still-missing required comparison
from GPT-6 High and applies strict final coverage. DUPLICATE or unknown decisions
are never discarded by this path. No translation/review field is rewritten by the
transport. The observed residence packet retained 104 valid judgments, quarantined
2 unassigned DISTINCT claims, and requires 4 fresh judgments; its other candidate
already had all 97 required judgments. This repairs response handling without
removing any required neighbor or weakening final acceptance.

Durable verification evidence lives at `ABSOLUTE_DIAGNOSTICS_PATH.verification/`
(`verification_packets/` inside it), as a sibling of rotating browser captures.
Browser cleanup recognizes only its lifecycle records or explicit regular legacy
checkpoint files; it cannot rotate arbitrary nested ledgers or unrelated folders.
A 2026-10-30 run exposed the earlier namespace collision and deleted local packet
receipts before any row was accepted. Remaining files were hash-preserved and the
incident recorded locally; missing raw judgments must be re-obtained, never recreated
or silently treated as cached evidence. Generated corpus and primary audit proposals
were unaffected. This fixes evidence lifecycle ownership, not triplet content.

An explicit OVERLAP/UNCERTAIN pair judgment can receive one bounded independent
adjudication. Its exact prior claim and reason accompany both full texts and hashes;
the factory cannot infer DISTINCT from different wording or DUPLICATE from topic
similarity alone. Definitive DUPLICATE findings are never overridden by this path.
A fresh negative or still-uncertain result reaches the original quality hold without
another attempt to obtain PASS. Reviewed triplet fields stay unchanged. Ordinary
omission requests remain byte-compatible so prior completed evidence is reused.

If a batch cannot fit even one target with all originals repeated, the planner uses
assigned-source context for that otherwise-impossible batch. Every assigned target
retains its complete original and complete primary proposal; every full peer proposal
is retained for cross-candidate consistency, and every required neighbor body/hash is
unchanged. Each peer is independently reviewed against its complete original in its
own assigned packet. The complete original batch remains in the hash-bound logical
request. No candidate can be accepted until all assigned packets and the Python gates
pass. The private manifest records this context mode. Already-viable plans retain their
original partition assignments and exact legacy-cache lookup. The physical limit stays 200,000.

Verification requests now label each required neighbor with a candidate-local zero-based
`other_index`. GPT returns that index, its verdict and its material reason instead of
recopying long IDs and hashes. The transport resolves only those identifiers against
the frozen neighbor inventory; it never supplies judgments or changes triplet fields.
Raw model output remains in the private ledger, whose manifest records `reply_format`.
Invalid/conflicting indices and missing coverage fail closed. Exact prior full-identity
packet responses remain reusable under the original prompt/model/hash checks. Packets
without enough space for the indexed instructions retain the full-identity format.

Plain full-prompt attachment replaces the complete editor selection in a single native
editing transaction. This prevents a foreign draft restored after the separate clear
from being appended to the request. Exact composer readback remains mandatory before
Send. Connector insertion and staged append behavior retain their existing paths.
