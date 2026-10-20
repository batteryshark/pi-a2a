# pi-a2a

<p><a href="assets/workstack-mark-full.png"><img src="assets/workstack-mark.png" alt="Comic fox courier running with an oversized envelope" width="160"></a></p>

Local messaging for Pi sessions, bounded single-use Pi workers, and Pi-initiated
requests to an existing OpenCode session—with automatic final replies to the
initiating Pi. Send a task, continue other work or end the turn, and let the
runtime deliver the answer. The recipient answers normally, not with a second
send back.

This is a Pi extension with a shared local mailbox and an independent loopback
HTTP/SSE client for OpenCode. It needs no broker or OpenCode a2a plugin. Its
envelopes are specific to this extension, not a general A2A protocol or MCP
transport. The Workstack comic badge depicts a fox courier carrying an envelope.
The linked full image preserves the native 1254×1254 pixels; the displayed badge
is a 320×320 alpha-aware resampled derivative, not a separately designed tiny icon.

## Requirements and setup

Use **Pi 1.0.4** and **Node 22.19.0+**. Other Pi versions need
verification. Native Windows storage/launch is a **candidate, unproven until
native proof**; portable mocks do not establish Windows acceptance. Unsupported
security configurations fail closed with `UNSUPPORTED_SECURITY`.
POSIX workers require `pi` on PATH (or `PI_A2A_PI_BIN`)
and existing authorized Pi model configuration. `--offline` disables startup
network discovery; it does not make model requests offline or sandbox code.

The package is source-only and `private: true`: no npm registry publication,
build step or bundled runtime dependencies. Pi supplies its extension imports.
`package.json` explicitly exposes `./index.ts` through `pi.extensions`; its
host-provided imports are declared as peers, not bundled dependencies.

Install from Git in the project where you want to use it:

```sh
pi install git:github.com/batteryshark/pi-a2a --local
```

Review the code and trust the project-local package declaration when prompted.
Pi writes `.pi/settings.json`; omit `--local` only if you intentionally want a
personal installation. For reproducible deployments, append `@<commit-or-tag>`
to the Git source, replacing the placeholder with an actual published ref.
Git installation may run Pi's dependency reconciliation for the package.

Alternatively, clone and review the source, then install from its root:

```sh
git clone https://github.com/batteryshark/pi-a2a.git
cd pi-a2a
pi install . --local
```

For a single invocation with no package-setting changes, from that clone's root:

```sh
pi --no-extensions --no-mcp -e ./index.ts
```

Explicit `-e` loads even with extension discovery disabled. Don't combine an
installed copy and a different explicit copy in the same process. Normal Pi
model configuration and context still apply; extra isolation flags are used
in the optional probe below.

### One shared mailbox

Every participating Pi process and the CLI must use **the same absolute,
canonical, non-symlinked `PI_A2A_STATE` directory**. It must be owner-only
(0700) on POSIX; state files are 0600. Windows uses the ACL policy below, not
chmod/mode bits. Choose a private location outside the checkout:

```sh
# Fictional path: provision a private directory appropriate for your account.
export PI_A2A_STATE=/workspace/private-mailbox
pi --no-extensions --no-mcp -e ./index.ts
```

Set that same variable in the second Pi's environment before starting it.
Without an override, the extension uses `.state-v2` next to its own `index.ts`;
separate installed copies would otherwise have separate mailboxes. Do not open
the same Pi transcript in two processes. A mailbox is not a process launcher.

## Tools and addressing

| Tool | Input and behavior |
| --- | --- |
| `a2a_list` | `{}`. Lists the shared mailbox's Pi registry and PID-based online state, not OpenCode sessions or network hosts. |
| `a2a_send` | `to`, `text`, optional `id`, `expectReply` (default `true`), `delivery` (default `"followUp"`). Returns admission status/ID, not a completed answer. `"steer"` explicitly requests interruption. `"queue"` is not a Pi tool delivery value. |
| `a2a_read` | `to`, optional `limit` (default 5, clamped 1–30). Bounded untrusted Pi mailbox request/outcome history, or an OpenCode transcript excerpt; not full Pi transcripts. Not for waiting on replies. |
| `a2a_create` | Required `model`, `directory`, `tools`; optional `nest` (default `true`). Creates one bounded Pi RPC worker without prompting it. Send to the returned address next. No OpenCode creation. |

Addresses are `pi/<session-id>`, `oc/ses_…`, or the optional `chief` alias.
Get real Pi addresses from `a2a_list`; OpenCode IDs must be supplied explicitly.
There is no title lookup, bare-ID resolution, remote transport or host discovery.
These tool-input examples use **fake IDs**, not existing recipients:

```json
{"to":"pi/fake_receiver","text":"Review the parser and summarize risks."}
```

```json
{"to":"oc/ses_fake_review","text":"Review the parser and summarize risks.","delivery":"followUp"}
```

After sending, continue other work or end the turn. Don't sleep, poll or call
`a2a_read` to await completion. The sender runtime wakes Pi with a follow-up
reply. `expectReply:false` disables that automatic return. Reusing an `id`
deduplicates an identical admission; changed fields with the same ID fail.

### Workers and reply ownership

Provide an existing absolute working directory, a full `provider/model`, and
an explicit tool list (`[]` means none). Allowed provider prefixes are
`openai`, `openai-codex`, `google`, and `google-gemini-cli`; prefix acceptance
is not proof that a particular model exists or authentication is ready.
Choose an available model using your installed Pi configuration.

Worker tool allowlist: `read`, `grep`, `find`, `ls`, `a2a_list`, `a2a_read`,
`a2a_send`. No bash/write/edit, recursive worker creation, discovered
extensions, MCP, skills, context files, templates or themes. This is an
explicit tool policy, **not an OS sandbox**; extension code is trusted code,
and workers inherit the parent's environment and host filesystem access.

At most two live/reserved workers share a mailbox. Each is single-use and
exits after its logical task settles. `nest:false` changes nesting metadata
only: both nested children and root/non-nested workers retain the creating
Pi as owner. Automatic replies belong to the actual initiating sender, never
an invented parent. Creation is not replayed after an uncertain spawn.

## OpenCode configuration

Set `PI_A2A_OC_URL` to your **existing OpenCode server's explicit loopback
origin**, for example the shape `http://127.0.0.1:PORT` (replace `PORT` with
your configured port). No default is guessed and no server is started.
Only `127.0.0.1`, `localhost`, or `[::1]` are allowed; URL userinfo, non-root
paths, query strings, fragments and redirects are refused.

Basic-auth password is inherited from `PI_A2A_OC_PASSWORD`, then
`OPENCODE_SERVER_PASSWORD`, then `OPENCODE_PASSWORD`. Username comes from
`PI_A2A_OC_USERNAME`, default `opencode`. Supply these through your approved
launcher/environment, not prompts, URL credentials or checked-in settings.
No password is sent if none is configured; unauthorized errors aren't bypassed.
The extension doesn't search config files for credentials.

The adapter expects OpenCode V2 `/api/session/<id>/prompt`, `/message`,
`/api/session/active`, and `/api/event`, including paginated message data,
explicit prompt IDs, and closing `idle` records. It maps Pi `followUp` to
OpenCode `queue`, and requests `resume:true`. API compatibility needs checking
when upgrading. It doesn't create OpenCode sessions or install/change plugins.

### Optional chief alias

An operator may supply `~/.chief-of-staff/chief.json` with a `sessionId`
(`sessionID` or `session` are also accepted) and an absolute `directory`.
A fictional pointer is:

```json
{"sessionId":"ses_fake_chief","directory":"/workspace/coordination"}
```

No pointer data is bundled or installed. Every new `chief` send rereads and
validates the file, then pins the resolved session, directory metadata and
configured server origin. The directory is metadata, not an alternate routing
endpoint. Rotation affects only new sends; uncertain work isn't replayed to
a replacement chief. Replies return to the initiating Pi. OpenCode remains
responsible for its own model/auth routing.

### Machine companion v1 (0.2.0 candidate)

From the clone root, with the same `PI_A2A_STATE` as the receiving Pi:

```sh
node cli.mjs machine < private-request.json
```

Supply **exactly one flat JSON object on stdin, then EOF**. Never put the text,
reason, context, or routing identity in argv. These are complete example objects
with fictional identities (send, then independent status/cancel invocations):

```json
{"v":1,"op":"send","caller":"docket","id":"example:1","to":"pi/fake_receiver","text":"Synthetic wake","delivery":"queue","expectReply":false}
```
```json
{"v":1,"op":"status","caller":"docket","id":"example:1"}
```
```json
{"v":1,"op":"cancel","caller":"docket","id":"example:1"}
```

All shown fields are required; all other fields are rejected. `caller` matches
`[a-z][a-z0-9-]{0,47}`; `id` matches `[A-Za-z0-9._:-]{1,96}`. Text is preserved
exactly, must be nonblank, and is limited to 32768 UTF-8 bytes. Stdin is limited
to 262144 bytes and 10 seconds through EOF. Nested values, duplicate keys,
malformed UTF-8, BOM, lone surrogates and trailing frames are rejected.
`expectReply` must be **false**; v1 never subscribes to replies or waits for an
answer. Only an existing capable `pi/<id>` is allowed, not OpenCode, chief,
titles or launch. `queue` maps to Pi `followUp`; `steer` maps to `steer`.
External wakes bypass native reply-bearing serialization, including while busy.

One newline-terminated JSON object (at most 8192 bytes) is written to stdout;
machine errors never echo input, exception text, paths, transcripts or answers.
Success shape (fact values vary):

```json
{"v":1,"ok":true,"receipt":{"state":"admitted","facts":{"admitted":true,"claimed":false,"injected":false,"observed":false,"consumed":false,"historicalUncertainty":false},"evidence":"not_checked","cancelAvailable":true,"retry":"same_key_only"}}
```

Error shape: `{"v":1,"ok":false,"error":"CONFLICT","retry":"same_key_only"}`.
Exit 0 means the operation was answered, **not delivery or task success**.

| Exit | Fixed machine error codes |
| --- | --- |
| 2 | `INVALID_JSON`, `SCHEMA`, `INPUT_LIMIT`, `INPUT_TIMEOUT` |
| 3 | `UNKNOWN`, `UNAVAILABLE`, `UNSUPPORTED_TARGET`, `UNSUPPORTED_SECURITY`, `CAPACITY` |
| 4 | `CONFLICT`, `CANCELLED`, `TOO_LATE` |
| 5 | `A2A_BUSY` (retry same caller/id) |
| 6 | `STORAGE_UNCERTAIN` (potentially committed; look up same caller/id) |

Caller namespace derives from the trusted POSIX UID or internally verified
Windows SID and application label;
the label is not executable authentication. A domain-separated key identifies
caller/id, and a canonical digest pins to/text/delivery/expectReply. Identical
send returns the retained receipt **before** target liveness checks, even offline;
any immutable change conflicts. Different caller labels are independent.
Unknown status is `UNKNOWN`, not a cancellation barrier.

### Pure inspection v1 (freeze before creating a reminder)

Two additional strict stdin frames use the same command, input/output bounds,
fixed error envelope and exits. No caller/id is needed or accepted:

```json
{"v":1,"op":"capabilities"}
```
```json
{"v":1,"op":"lookup","to":"pi/fake_receiver"}
```

Capabilities returns `{v:1,ok:true,capabilities:{protocol:1,
contract:"pi-a2a-external-v1",operations:["capabilities","lookup","send","status","cancel"],
delivery:["queue","steer"],expectReply:false,maxCaller:48,maxRequestId:96,
maxTextBytes:32768,maxInputBytes:262144,maxOutputBytes:8192,
maxRetainedIdentities:50000,maxActivePayloads:128,capacityScope:"shared_ledger",maxStateBytes:134217728,
inspection:"read_only",targetSnapshot:true,reservation:false}}`.
It is a static supported contract: **no filesystem access or store creation**.
Caller `docket-<32 lowercase hex>` and request `msg_<32 hex>` fit the bounds.

Lookup returns `{v:1,ok:true,target:{to:"pi/fake_receiver",exists:false,
live:false,capable:false,snapshot:true,reservation:false}}` (booleans vary).
It verifies an existing root/state read-only and never creates a missing root,
locks, requests, claims, admissions or heartbeats; existing bytes are unchanged.
Absent target/root returns `exists:false`. Schema-v1 state fails closed without
upgrade. `capable` means external-v1 + persistence + owner epoch are advertised;
old owners return false. `live` independently means online, a valid positive
PID not known dead, and a heartbeat within 65 seconds (at most 1 second future
skew). Unknown process liveness is conservative, **not proof of ownership**.
Offline capable owners can return `capable:true,live:false`. Busy/idle,
directory, transcript paths and payloads are deliberately omitted.

This is a **non-reserving snapshot**, not a liveness/delivery guarantee. Admission
and claim still validate capability/liveness/epoch inside their transactions.
Docket uses only this public companion, never the mailbox or source internals.

Current `state` is `admitted`, `injected`, `consumed`, `cancelled`, `uncertain`, or
`failed`. (`pending` is reserved; not currently emitted.) Facts are monotonic:
admitted means committed ledger admission; claimed means irreversible exclusive
injection intent; injected means facade return or stronger saved evidence;
observed means exact message event or stronger saved evidence. **Consumed alone
means exact saved-session intake**: a complete newline JSONL entry under the
right session header, distinct `pi-a2a-external-v1` custom type, internal ID,
claim token, immutable digest and cryptographically exact deterministic content, with receipt proof
persisted before reporting it. Neither message_start/end, in-memory entries,
facade return, assistant output nor settlement is saved-consumption proof.
Pi 1.0.4 emits message_end before its writer appends. Hooks return before deferred
reconciliation reads the file; status may safely advance saved-proof scanning.

`evidence` is one of `not_checked`, `missing`, `unsafe`, `changed`,
`partial_header`, `session_mismatch`, `oversized_record`, `invalid_record`,
`partial_record`, `scanning`, `absent`, `unreadable`, `saved_exact`, `deadline`,
`owner_unavailable`. Scans read at most 256 KiB per reconciliation, with 8 KiB
header and 224 KiB record bounds (including worst-case escaped valid text).
One file window is scanned per transaction, round-robin across unresolved files.
Oversized records persist bounded discard offsets across restarts and EOF;
discarded bytes are never parsed as proof, and scanning resumes only after their
newline. An unfinished discard never reports `absent`. Missing/partial/oversized/ambiguous evidence
never proves intake; progress may require subsequent status calls/sweeps.
The receipt contains no payload or transcript path. Saved intake is historical,
not model understanding, execution success, or an fsync/power-loss guarantee.

Admission, cancel and claim use the **same transaction lock**. Cancel before
claim persists a permanent barrier; unknown cancellation creates a tombstone.
Delayed sends cannot revive it. After claim cancellation is `TOO_LATE`, even
before the facade call. No queue clearing or record deletion occurs. One key
permits at most one claim and facade attempt; lost queues, crashes and async
facade failures are never automatically replayed. Claim initially records
uncertainty about the effect; historicalUncertainty stays true even if later
proof resolves to consumed. Restart/async failure resolves to uncertain without
proof, including when a proof scan finds no exact saved entry. The five-minute deadline is definite failed only before claim; after
claim it is uncertain, not cancellation. Never silently retry with a new ID.

Owners advertise capability, persistence path, random epoch and heartbeat;
admission and claim both check them. A live PID alone does not qualify an old
owner. Changed owner epoch fails pending work rather than retargeting it.
No-session mode cannot receive new machine wakes. There is no lock stealing.
External identities and tombstones are retained permanently: **50,000 globally
per shared ledger**, not per caller or target. Active payloads have a separate
128-slot bound; cancellation, failure or irreversible claim releases a slot.
This admits five finite 100-wake jobs without lifetime exhaustion; five/minute
continuously still exhausts 50,000 identities in just under seven days. Choose
capacity explicitly; there is no indefinitely reusable identity budget.

The single JSON ledger is capped at **128 MiB**, native collections at 8 MiB.
New identities are rejected if their actual external JSON bytes (including
escaped payload/path and scanner state) plus **1 KiB per retained identity**
exceed 112 MiB, or either count/active-slot limit is reached. Candidate bytes
are charged before commit, not one record after the ceiling. Transcript paths
are bounded to 4096 UTF-8 bytes and owner epochs to 96 characters. This reserve
covers bounded claim/fact/proof/cursor growth even when new IDs are full;
scanner metadata is outside native accounting. Count capacity is not a promise
that arbitrary worst-case paths/payloads fit the byte cap. All operations read
the bounded ledger into memory and transactions rewrite it; this is not a
throughput/latency benchmark or a database service.

Compaction is part of the **same locked atomic Store transaction** as terminal
or irreversible claim facts, never a multi-file migration. Finished/claimed
payload text is dropped only with immutable body and framed-content SHA-256
digests retained. Claimed receipts retain internal ID, claim token and original
file/session association until exact saved evidence resolves uncertainty;
later content must hash identically, as well as match all exact association
fields. Saved entry IDs and raw records are retained only as SHA-256 digests.
Proof releases now-unneeded file cursors, not identity barriers or receipt facts.
Same-key/same-body remains lookup-only; changed bodies still conflict even
after payload compaction. Capacity rejects **new identities**, not
status/transitions/idempotent operations on existing ones. There is no TTL,
eviction, automatic archive, or ID reuse. Reserve IDs in the caller's durable
outbox; status UNKNOWN after a lost commit response is not authority to mint a
new ID. Same-key lookup/retry is the recovery path.

### Explicit 0.1 upgrade boundary

Schema v2 rejects v1 state; **there is no automatic migration**. Stop all old
owners and reconcile legacy work first. Retain the old mailbox unchanged for
manual inspection; configure every upgraded participant to the same **empty new
private root** (default `.state-v2`). Do not point 0.1 owners at it. Old readers
reject v2. Native tool/worker/bridge collections remain separate and retain their
original semantics; legacy seen/notified flags are never external intake proof.

### Legacy human companion (deprecated)

From the clone root, with the same `PI_A2A_STATE` as the receiving Pi:

```sh
node cli.mjs list
node cli.mjs send pi/fake_receiver 'Synthetic example task'
node cli.mjs read fake_request_id
```

Replace the fake recipient with a listed live address and the fake request ID
with the send result. The CLI admits a request and exits; the live Pi watcher
wakes the recipient and records its outcome. `read` is later inspection, not
a polling recipe. CLI identity is minted as `pi/cli-<uuid>` and cannot claim
to be chief or an OpenCode session. This does **not** automatically wake or
return to an initiating OpenCode session. The unchanged OpenCode a2a plugin
doesn't understand Pi addresses. Offline Pi needs its real owner process
resumed before a new send can be admitted.

## Delivery, recovery and trust

This section describes the **native tool/reply** lifecycle. Machine external
wakes instead use the stricter, no-automatic-replay contract above.

Admission is persisted by file flush and rename (plus directory fsync on POSIX) before injection, spawning
or HTTP submission. Delivery is **at-least-once with admission deduplication**,
not exactly-once execution or reply injection. Busy Pi follow-up queues are
volatile: `sendMessage` returning isn't consumption. Stable reply IDs are
acknowledged only when found in the sender's saved JSONL transcript. One
enqueue per process prevents an endless live retry loop; restart retries a
missing reply ID, or acknowledges an existing saved ID without a new turn.

A crash between consumption and transcript append can redeliver. Pi's append
isn't an fsynced transaction with this ledger. No-session mode, missing files
or transcripts over the 16 MiB scan cap cannot earn durable acknowledgment.
Async facade failures are also ambiguous; inspect/reconcile rather than
assuming a failed enqueue. Legacy notification flags aren't proof of saved
consumption. Mailbox replies retained while the sender is offline require
that sender's same transcript and a running owner to resume.

Interrupted **request injection** takes the opposite safety policy: reload
marks it blocked and never blindly reruns the model. Uncertain HTTP admission
isn't re-POSTed. Reconcile transcripts manually; resumption doesn't reconstruct
an interrupted synthesis. A stale/incomplete transaction lock fails closed.
Stop participating owners, confirm the recorded process has exited, inspect
the ledger, transcripts and create reservations, and remove only a confirmed
stale lock. There is no automatic lock stealing or recovery-edit command.

Reply-bearing requests are serialized per target within this mailbox only.
Pi correlation requires the exact custom request and final `agent_settled`,
not `agent_end`. Nested work waits for every correlated reply-bearing
dependency, its exact stable reply event, and subsequent assistant synthesis.
Human/unrelated input revokes synthesis focus; unrelated assistant text isn't
guessed to be the answer. UI waits are blocked, not final. A busy completion
write retains its candidate in memory, retrying on root filesystem events up
to 32 busy attempts within the original deadline. Crash, non-contention I/O
failure, exhausted retries or mixed turns can require inspection or timeout.

Each request has a three-minute deadline. Workers also have parent/child
watchdogs and a ten-minute total limit, including idle startup; shutdown
terminates only owned child processes, escalating after two seconds. A timeout
doesn't prove an interactive Pi or OpenCode target stopped. OpenCode collection
uses events plus a 30-second reconciliation sweep, ten-second ordinary HTTP
call timeouts, at most 1,000 message records, the actual admitted request ID,
its closing idle record, and an inactive session. Off-page/ambiguous history
is not guessed. A restarted origin must match the pinned configuration.

State is bounded to 128 sessions, 2,048 native requests and 128 MiB total (8 MiB native collections); text is bounded to
32 KiB, and routes to four hops. History is retained until offline operator
archival, not silently garbage-collected. Full stores reject new admissions.
No state deletion is part of installation or normal recovery.

The OS account is the trust boundary. Same-user malicious code can alter the
mailbox or invoke Pi APIs; owner-only modes aren't protection from that code.
Requests/replies/transcripts are marked untrusted but framing cannot enforce
model behavior. OpenCode credentials can convey broad session/tool authority.
Keep the endpoint restricted, use only trusted recipients, and consider model
cost and confidentiality. Runtime state contains sensitive messages and paths;
never commit or publish it, credentials, pointers or real session transcripts.

### Native Windows candidate security and launch policy

Initial scope: **local fixed NTFS**, current-user-owned storage, Windows
PowerShell **5.1**/.NET Framework and Node **22.19.0+**. No WSL, UNC/network,
device/extended paths, ADS, drive-relative paths, dot components, trailing dots/
spaces, reserved device names, reparse ancestors/targets or payload hardlinks.
Fully qualified drive paths are checked case-insensitively by the native helper.
Paths are bounded to 240 characters. Unsupported volume/ACL/helper failures are
fixed errors, not a fallback to POSIX permissions. Same-user code and privileged
SYSTEM/Administrators remain inside the OS trust boundary.

`src/windows-security.ps1` derives the current SID internally. It is a fixed
trusted package script launched with absolute system PowerShell, `-NoProfile
-NonInteractive -File`, JSON stdin, no generated code or private values in argv,
10-second timeout and 8 KiB output bound. `SystemRoot` is trusted launcher
environment identifying the genuine Windows installation; do not override it.
No installs, execution-policy changes, ACL repairs or permission widening occur.

The immediate parent must exist. A **new dedicated leaf** is created with
`DirectorySecurity` passed to `Directory.CreateDirectory(path, security)`:
current user owner, protected DACL, inheritable user FullControl, before payload.
Existing roots must already meet that policy; they are never silently repaired.
SYSTEM/Administrators grants are allowed, other grants refused. Null/empty DACL,
unknown/object/callback ACEs, payload deny ACEs, absent user FullControl,
unprotected root, reparse points and wrong owner fail closed. New files/lock/
temporary state and worker transcripts inherit only from verified directories;
files are verified before payload write, and existing files/transcripts checked.
Directory FullControl must be inheritable by both files and directories.

Ancestors and launch files may additionally be owned by the exact Windows
TrustedInstaller service SID and carry its privileged grants. This exception is
OS-role-only: TrustedInstaller ownership or grants on payloads still fail.
Ancestors must be owned by the user/SYSTEM/Administrators/TrustedInstaller, non-reparse, and must
not grant ordinary principals delete/delete-child, ACL/owner change or write
attributes/extended attributes. Ordinary ancestor read/traverse and create-sibling
rights are not treated as access to the protected leaf. Launch files additionally
reject ordinary write/append grants. An existing unsafe Temp is **not private**:
select a fresh protected leaf under a verified ancestor, never repair Temp or
an existing user's directories. External transcript locations must also pass
security checks; worker transcripts live beneath the protected store.

Transactions flush the temporary file once, then replace by rename. Windows
does **not** claim POSIX directory fsync or power-loss durability of directory
metadata. Only sharing/EPERM/EACCES/EBUSY replacement/cleanup errors receive at
most three retries (10/20/30 ms); the transaction callback is never rerun.
Post-rename flush/cleanup failure is `STORAGE_UNCERTAIN`, never definite rejection.
Lock owner creation is cleanup-protected. Invalid/missing PID, liveness unknown,
stale or incomplete locks are never stolen. Watch errors/missing/coalesced names
schedule reconciliation; the existing 30-second sweep reattaches watches after
invalidation/recreation. It never reconstructs lost state or replays claims.

Windows workers and the optional probe use the **current native `process.execPath`
Node executable** and a separate absolute Pi JavaScript entry argument, never
`pi.cmd`, `shell:true`, or shell quoting. Version is checked before spawn. The
current Pi host's `process.argv[1]` is validated against its package's `bin.pi`
metadata (`@earendil-works/pi-coding-agent`). Alternatively set trusted
`PI_A2A_PI_ENTRY` to a reviewed absolute installed JS entry (also metadata/ACL
checked). `PI_A2A_PI_BIN` is POSIX-only. Node/entry/package metadata must be on
supported paths with secure ancestors, no reparse points or hardlinks. This
checks installed metadata; it does not attest package provenance/version.

For the next native proof worker, first discover/verify the installed Pi JS
entry/package and execute the supported native Node, **not an older PATH Node**.
Using PowerShell, with fictional reviewed paths replaced:

```powershell
$env:PI_A2A_STATE = 'C:\PrivateLeaf\fresh-mailbox'
$env:PI_A2A_PI_ENTRY = 'C:\ReviewedPi\dist\cli.js'
& 'C:\SupportedNode\node.exe' .\cli.mjs machine # send one JSON stdin frame, EOF
$env:PI_A2A_PROBE_ROOT = 'C:\PrivateLeaf\fresh-disposable-probe'
& 'C:\SupportedNode\node.exe' .\tests\load-probe.mjs
```

For the probe, `PI_A2A_PROBE_ROOT` is mandatory on Windows and must be absent;
it is protected before any fixture payload, and only that owned disposable leaf
is removed afterward. The mailbox leaf's parent must also already exist and
pass checks. The CLI alone is not launch proof: prove actual native worker RPC,
ACL inheritance for files/temp/lock/transcripts, controlled unsafe/reparse/hardlink
negatives, sharing/rename/watch/restart behavior and exact saved Pi intake.
No native acceptance is claimed here; installed-shim/version discovery and
these runtime checks remain the next lane.

## Tests and limits

From the source root, with Node 22.19.0+, no install is required:

```sh
npm test
```

The portable suite uses temporary canonical state roots, synthetic messages,
fake HTTP/event and RPC boundaries, injected lifecycle callbacks, and a short
owned Node process for real lock contention. External race tests use two
overlapping, barrier-controlled owned processes at most, covering send/send,
send/cancel, both cancel/claim orders and claim/claim. Busy operations retry
only the same key after both processes exit, never runtime injection replay.
Coverage includes unknown-cancel/restart/delayed retry, multi-window oversize
discard/restart/EOF/append, near-8-MiB native state plus proof and ordinary
reconciliation, 128 active slots, and a realistically sized 50,000-identity
compact fixture with known-key conflicts/cancel and late exact proof at full
count. This is fixture metadata, not 50,000 model/CLI requests. Test runners
must have an outer 120-second watchdog (the capacity case also has a 120-second
test timeout). No model/auth calls are made.
Windows path/account/helper/launcher checks in this suite are clearly labeled
portable mocks or source-policy assertions: they do not execute PowerShell or
prove native ACLs. Native fixture provisioning must use dedicated protected
leaves, not the portable suite's POSIX temporary-root helpers.

### Reusable native Windows tests

Run in native Windows PowerShell with an already supported Node executable.
Provision a **new protected NTFS proof parent at creation**, using the same
reviewed DirectorySecurity/CreateDirectory policy as the helper; do not repair
an existing directory or use ambient Temp. Verify its ancestors first. Replace
these fictional paths with reviewed local paths:

```powershell
$env:PI_A2A_TEST_PARENT = 'C:\PrivateProof\owned-parent'
& .\tests\windows-parent.ps1 -Path $env:PI_A2A_TEST_PARENT # must not exist
$env:PI_A2A_PI_PACKAGE = 'C:\ReviewedPi\node_modules\@earendil-works\pi-coding-agent'
$env:PI_A2A_PI_ENTRY = 'C:\ReviewedPi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
& 'C:\SupportedNode\node.exe' --test --test-concurrency=1 tests/windows-native.test.mjs
& 'C:\SupportedNode\node.exe' --test --test-concurrency=1 tests/installed-pi.test.mjs
```

`npm run test:windows` is the equivalent focused native command when PATH Node
is supported. Use an outer 180-second watchdog per command. Native fixture
creation fails closed without `PI_A2A_TEST_PARENT`; all suite fixture roots use
protected creation on Windows, never mkdtemp-then-ACL-repair. The POSIX chmod/
symlink assertions are inapplicable there; native tests instead exercise real
extra ordinary Read/Modify/delete-child grants, junctions and hardlinks.
Descriptor tests execute the actual shared PowerShell policy with genuine .NET
ACL objects, including TrustedInstaller positive OS roles and rejected payload/
untrusted owners; synthetic owners are **not** filesystem-owner proof. The
focused test also verifies actual OS launch descriptors without modifying them.
It does not claim null/unknown-ACE, foreign filesystem-owner, sharing-violation,
RPC worker or consumption coverage; installed-Pi and probe commands are separate.
Tests modify only newly owned fixtures. Do not bypass execution policy if a
helper is blocked. Native acceptance still requires successful host evidence,
not a passing non-Windows skip or portable mock. Full portable suites may be
much slower on Windows because each security check launches PowerShell.
An elevated token whose default new-file owner is Administrators can fail the
current-user payload-owner check even below a protected current-user-owned root.
That is unsupported, not authority to accept privileged-owned payloads or change
the token/ACL policy. Likewise, an installed Node with ordinary-user write grants
fails trusted launch verification; do not repair its installation to run a test.

Optional installed-Pi checks are separate from `npm test`. Point the package
variable at your already installed **Pi 1.0.4 package directory**, not its
executable; paths below are fictional and must be replaced:

```sh
PI_A2A_PI_PACKAGE=/workspace/pi-install/node_modules/@earendil-works/pi-coding-agent npm run test:installed
PI_A2A_PI_BIN=pi npm run probe
```

The first includes the original synthetic native reply regression plus a genuine
installed AgentSession/Agent loop and writer with a local synthetic stream and
network access explicitly forbidden. It proves external message_end is not
consumed before append and three queue/steer wakes become consumed after real
saved writes. It is not a live provider test. The second loads the package directory through
its public manifest in an isolated temporary project/agent directory, verifies
all four tools and session registration/shutdown, and makes zero model
requests. It has a 20-second watchdog with bounded owned-process escalation.
It doesn't run `pi install`, change global settings or prove Git network access.

Bounded live Pi-to-Pi and Pi-initiated OpenCode flows have been tested on Pi
1.0.4, including automatic return and synthesis. Those observations aren't
reliability benchmarks or live crash-recovery guarantees. This release doesn't
claim full Workstack kit/goal parity or unrelated integrations. No remote
transport, OpenCode creation/title resolution, offline process launcher,
automatic reverse bridge, OS sandbox or exactly-once guarantee is provided.

Source map: `index.ts` registers tools/hooks; `src/runtime.mjs` handles mailbox
delivery and settlement; `store.mjs` owns transactions; `protocol.mjs` owns
envelopes and correlation; `opencode.mjs` owns HTTP/SSE; `worker.mjs` owns RPC
workers; `external.mjs` owns external claims/receipts/proof; `ledger.mjs` owns
compact retention and capacity constants; `machine.mjs` owns
strict stdin parsing; `platform.mjs` and `windows-security.ps1` implement the
account/security seam; `launch.mjs` validates native Node/Pi JS launch;
`cli.mjs` is the trusted local companion. Bug reports should use a
minimal synthetic reproduction and host versions, never private state.

## License

Owned source, tests and documentation are [MIT licensed](LICENSE). Included
AI-generated Workstack comic artwork is offered under MIT to the extent
applicable; no exclusive copyright in AI-generated elements is asserted.
See [RIGHTS.md](RIGHTS.md) for asset details, scope and third-party rights.
