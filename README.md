# pi-a2a

<img src="assets/workstack-mark.png" alt="Fox courier carrying an envelope" width="160">

pi-a2a adds local session messaging to Pi, with asynchronous replies, bounded single-use Pi sessions and requests to existing OpenCode sessions. Participating Pi processes share a private mailbox; the OpenCode adapter uses an explicitly configured loopback server. Send a request and continue working while the extension delivers the answer back to the initiating session.

## Requirements

- Pi 1.0.4 and Node.js 22.19.0+.
- A private shared mailbox directory for participating processes.
- Existing Pi model configuration for spawned sessions; POSIX requires `pi` on PATH or `PI_A2A_PI_BIN`.
- Windows requires the supported local NTFS, ownership and PowerShell configuration described in the [reference](docs/reference.md#native-windows-security-and-launch-policy).

There is no build step or bundled runtime dependency. Pi provides the extension imports.

## Install

From the project where you want the extension:

```sh
pi install git:github.com/batteryshark/pi-a2a --local
```

This writes project-local Pi settings. Append `@<published-ref>` to pin a revision. Alternatively, clone this repository and run `pi install . --local` from its root.

## Quick start

Provision a private canonical directory outside the checkout and set the same path before starting each participating Pi:

```sh
export PI_A2A_STATE=/absolute/private/mailbox
pi
```

On POSIX the directory must be owner-only (0700), with no symlink components. Ask the agent to call `a2a_list`, then send to a listed address:

```json
{"to":"pi/RECEIVER_ID","text":"Review the parser and summarize risks."}
```

Continue work or end the turn after sending. Replies arrive automatically; do not poll `a2a_read` to wait. The recipient answers normally rather than sending another request back.

## Configuration

- `PI_A2A_STATE`: shared private mailbox; the default `.state-v2` is beside the extension, so separate installed copies need an explicit shared path.
- `PI_A2A_OC_URL`: explicit existing OpenCode loopback origin for `oc/ses_ID` destinations.
- `PI_A2A_OC_PASSWORD`, `PI_A2A_OC_USERNAME`: optional OpenCode authentication; keep credentials outside source control.
- `PI_A2A_PI_BIN` (POSIX) or `PI_A2A_PI_ENTRY` (Windows): reviewed Pi launcher override.

## Tools and commands

| Tool | Purpose |
| --- | --- |
| `a2a_list` | List registered Pi sessions |
| `a2a_send` | Send with `followUp` or `steer` delivery |
| `a2a_read` | Inspect recent request/outcome history |
| `a2a_create` | Create a bounded Pi session with explicit model, directory and tools |

For external applications, `node cli.mjs machine` accepts one JSON request on stdin. See the [machine-companion contract](docs/reference.md#machine-companion-v1-020) for capabilities, lookup, send, status and cancel. Admission is not saved intake or task completion, and uncertain sends must not be retried with a new identity.

## Documentation and license

The [reference](docs/reference.md) covers storage, permissions, delivery, capacity, Windows setup and recovery. Source, tests and documentation are [MIT licensed](LICENSE); see [RIGHTS.md](RIGHTS.md) for artwork and third-party terms.
