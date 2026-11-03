# ADR-003: Apply Ownership — Kernel-Backed Locking and Process Control

## Status

Proposed (accompanies `specs/apply-ownership.yaml`, digest `a68c9e1b`)

## Context

The workspace apply lease (`specs/apply-lease.yaml`, shipped 2026-11-02) had three architectural defects that produced real lockouts:

1. **Non-atomic acquisition** — `readLease()` → check → `writeLease()` is a check-then-act race; two processes could both acquire.
2. **Unowned release** — any process's `rmSync` deleted any lease; overlapping holders cascaded.
3. **PID-based liveness conflating ownership with health** — a cancelled-but-alive process held the workspace for up to its full window (incident: `run-mvx79enc`, 2026-11-02; zombie process 54114 locked the repo for 22 minutes).

The replacement separates three authorities (kernel lock for ownership, durable intent record for safety, advisory metadata for diagnostics) and treats cancellation as execution control.

## Decision

### Locking mechanism: `flock(2)` via `fs-ext`

**Chosen:** `fs-ext` npm package (v2.1.1), exposing `flock(fd, LOCK_EX | LOCK_NB)`.

**Why not alternatives:**

| Option | Rejected because |
|--------|-----------------|
| `proper-lockfile` | Uses mkdir + heartbeat + stale-timeout — recreates the exact timeout-based lease pattern this spec replaces; can leave a lock directory after SIGKILL requiring stale recovery |
| `mkdir()` atomicity | Atomic creation, not kernel-backed exclusion; no automatic release on process death |
| `O_EXCL` open | Atomic create, but not a held lock; a crashed process leaves the file requiring cleanup |
| Node `SharedArrayBuffer` + `Atomics` | Userspace only; no kernel semantics; doesn't survive process death |

**`flock` properties that matter:**

- Kernel arbitrates acquisition — no userspace race window.
- Released automatically when the owning file description closes (process death, any cause).
- Advisory (not mandatory) — appropriate for cooperative tooling; we don't need to prevent file access, just detect contention.
- Associated with an open file description, not a PID — the lock can't be "stolen" by knowing a number.

**Close-on-exec:** the lock file descriptor is opened with `FD_CLOEXEC` set, preventing spawned subprocesses from inheriting the lock and holding it after the coordinator exits.

### Lock location: `.spc/apply.lock` (per worktree)

Each git worktree has its own `.spc/` directory (own harness queue, plans, runs), making it the natural execution domain. Two applies in different worktrees of the same repository lock independently — the lock guards shared execution resources inside one checkout, not the repository's git directory.

**Why not the common `.git/` directory:** would block agents in different worktrees from applying concurrently, which the spec explicitly preserves (AO-004). The contention that motivated this work (har's double-start, the zombie) was always two processes in the SAME checkout.

### Process control: identity-bound termination

**Problem:** `process.kill(pid, signal)` after a PID + start-time check has a TOCTOU race — the process can die and the PID be reused between check and signal.

**On Linux:** `pidfd_open()` + `pidfd_send_signal()` — the pidfd is bound to the specific process instance; if that process dies, the pidfd becomes invalid and signalling it returns ESRCH, not a signal to an unrelated process.

**On macOS:** no pidfd equivalent. No identity-bound process handle is available through Node.js. Options evaluated:
- `proc_pidinfo()` + `kill()` — has a TOCTOU race (check-then-signal); the spec prohibits this
- Process ports (Mach) — not exposed in Node
- **Decision: macOS does NOT support hard escalation. Cancellation reports INCOMPLETE when cooperative cancellation fails and escalation is needed.** The spec permits this: "where the platform cannot provide identity-bound termination, cancellation reports INCOMPLETE rather than risk signalling an unverified target." Cooperative cancellation still works (the owner observes and stops voluntarily); only the hard-stop path is unavailable.

### Platform support matrix

| Platform | Lock | Process control | Status |
|----------|------|-----------------|--------|
| Linux (local FS) | `flock` via fs-ext | `pidfd` | Fully supported |
| macOS (local FS) | `flock` via fs-ext | cooperative only; escalation → INCOMPLETE | Lock fully supported; hard escalation unavailable |
| Windows | No `flock` | Different API entirely | **Not supported** — explicit `PLATFORM_LOCK_UNSUPPORTED` error |
| NFS/SMB/network FS | Varies by version/config | N/A | **Not supported** — explicit error at lock acquisition |
| Docker/containers (local storage) | Passes through to host FS | Depends on host | Supported if underlying FS supports flock |

### Arbitration lock

A **separate stable lock file** (`.spc/execution-intent.lock`) serializes the terminalization-vs-escalation decision — distinct from the workspace lock (which the owner holds for its entire transaction, making it unavailable to the cancellation process). The arbitration lock uses the same kernel flock mechanism but guards only the intent record's cause transitions and terminal-event commit:

- **Owner cooperative terminalization:** acquire arbitration lock → check escalation hasn't won (cause != CANCEL_ESCALATED) → durably write terminal event → release arbitration lock.
- **Cancellation escalation:** acquire arbitration lock → check cooperative terminalization hasn't committed (no terminal event) → durably write CANCEL_ESCALATED → release arbitration lock → signal.
- **Whoever commits first wins.** Recovery reads the durable result and never produces a contradictory event.

The JSON intent file is never locked directly (atomic replacement via rename changes the underlying file object); the arbitration lock is on a separate, never-renamed file.

### Process containment

Every managed worker is spawned through a **ManagedProcessSupervisor** that:
- Opens an identity-bound handle (pidfd on Linux) BEFORE the process can mutate the worktree
- Durably registers the worker's identity in the intent record
- Tracks descendants via process groups (Linux `setpgid`/macOS `setpgid`) or explicit registration
- On coordinator death: reparented descendants remain discoverable via the durable registry + OS process-tree inspection
- If the complete descendant set cannot be established from the registry plus process-tree inspection, recovery fails closed

The supervisor is a contract, not a specific implementation — the ADR defers the platform mechanism to the implementation plan.

### The durable intent record

A JSON file at `.spc/execution-intent.json` (name TBD by implementation) written with:
1. Write to temporary file
2. `fsync()` the file
3. `rename()` over the target (atomic on POSIX)
4. `fsync()` the containing directory (ensures the rename is durable)

The record carries:
- `cause`: `"NONE"` | `"CANCEL_REQUESTED"` | `"CANCEL_ESCALATED"` (required, monotonic)
- `coordinator`: `{ pid, processStartTime, host }` (written before any mutation)
- `workers`: array of `{ pid, processStartTime, host, startedAt }` (each registered before the worker can mutate)
- `startedAt`, `runId`, `planId`
- Restoration context (original branch, HEAD, target) — committed before the first branch/worktree mutation

Malformed, truncated, or unreadable → treated as UNSAFE, never as absent. Missing `cause` field → UNSAFE (intentional and accidental absence are indistinguishable).

### Cancellation protocol summary

```
User: spc run cancel
  ↓
Cancellation process:
  1. Read intent record → coordinator identity
  2. Verify coordinator alive (PID + startTime + host)
  3. Durably write CANCEL_REQUESTED (before acknowledging)
  4. Notify via harness queue retirement
  5. Wait (bounded, documented, tested upper limit)
  ↓ (cooperative path)
Owner:
  - Poll loop notices retirement → throws REQUEST_RETIRED
  - Scheduler receives cancellation input → stops dispatching
  - Terminates and reaps workers (full process tree)
  - Writes CANCELLED terminal event
  - Completes finalization (attest, restore branch)
  - Clears intent record
  - Exits → kernel lock released
  ↓ (escalation path, if cooperative deadline expires)
Cancellation process:
  6. Durably write CANCEL_ESCALATED (before any signal)
  7. Identity-bound termination of owner AND workers
  8. Acquire kernel lock
  9. Perform AO-005 recovery (5-step, outcome-aware)
  10. Report success only after full finalization
```

Retry: idempotent for both CANCEL_REQUESTED and CANCEL_ESCALATED. The cause is never downgraded. CANCEL_ESCALATED is a resumable operation, not just a marker.

### Atomic arbitration

The single decision point: the owner's terminal event write and the cancellation process's CANCEL_ESCALATED write compete. Exactly one wins:

- If the owner wins: CANCELLED terminal event exists; the cancellation process observes it and stands down from escalation.
- If escalation wins: CANCEL_ESCALATED is committed; the owner cannot write a cooperative terminal event.
- Indeterminate: INCOMPLETE; safety block preserved.

The cause and terminal event must agree — `CANCEL_ESCALATED` with a `CANCELLED` terminal event is contradictory evidence and must be impossible by construction.

Implementation: the intent record's cause field is the linearization point. The owner checks it immediately before writing its terminal event; if CANCEL_ESCALATED is present, it cannot proceed. The cancellation process checks for a terminal event before writing CANCEL_ESCALATED. Both reads and writes happen under the kernel lock or the intent record's own atomic serialization.

## Consequences

### Positive

- Zombie holders impossible: process death → lock released by kernel, immediately.
- Concurrent apply acquisition impossible: kernel arbitrates atomically.
- Cancelled runs stop executing: the poll loop notices retirement; the scheduler stops; workers are terminated.
- Honest records: terminal events reflect what actually happened (RECOVERED vs CANCELLED vs CANCELLED-AFTER-ESCALATION).
- Workspace safety survives process death: the durable intent record blocks entry until verified recovery.

### Negative

- New native dependency (`fs-ext`) — must compile on supported platforms; adds install time.
- Windows unsupported (no `flock`) — explicit error, not a silent fallback.
- Cancellation on macOS may report INCOMPLETE more often (no pidfd for identity-bound termination).
- The intent record adds one synchronous fsync per apply start (measurable but small).

### Mitigations

- `fs-ext` has no transitive dependencies and supports Linux/macOS.
- Windows users get a clear error with the reason, not a silently broken lock.
- macOS INCOMPLETE reports are honest; the operator can retry or use `spc apply recover`.
- The fsync cost is O(1) per apply, not per task.

## Retirement

The following are removed by this ADR's implementation:

- `specs/apply-lease.yaml` (the superseded spec)
- `packages/runtime/src/apply-lease.ts` (the lease module)
- `packages/runtime/src/apply-lease.test.ts` (the lease oracle)
- `--allow-concurrent` CLI flag
- `packages/runtime/src/lock.ts` 15-minute stale-takeover mechanism (per-run lock retained only as a crash marker)

## References

- `specs/apply-ownership.yaml` (digest `a68c9e1b`) — the desired-state contract
- Incident: `run-mvx79enc` (2026-11-02) — zombie process held workspace for 22 minutes
- Incident: har workspace double-start (2026-11-01) — two live applies sharing one queue
- `flock(2)` Linux man page — lock released when all file descriptions referring to it are closed
- `pidfd_open(2)` Linux man page — identity-bound process handles
- Node.js `fs-ext` package: https://github.com/baudehlo/node-fs-ext/
