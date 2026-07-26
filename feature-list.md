# Pi Container Sandbox Roadmap

## 1. Automated integration tests

Add repeatable tests for both target modes, all checkpoint frequencies, concurrent sessions, host-branch advancement, rebase conflicts, crash recovery, container reuse, and malicious Git behavior. This is the highest-priority work before publishing the extension.

## 2. Container metadata and `/sandbox list`

Expand the existing managed-container labels with session and branch display metadata, then add `/sandbox list` to show active and stopped sandboxes. Reuse already validates image, cache mount, repository/target identity, and configuration labels.

## 3. `/sandbox gc`

Add dry-run and age-filtered cleanup for stale containers, temporary refs, recovery refs, and sandbox branches that never advanced beyond their base commit. Cleanup should use container metadata and avoid deleting active or recoverable work.

## 4. `/sandbox diff` and `/sandbox log`

Provide safe, read-only commands for inspecting the current sandbox changes and checkpoint history without manually locating refs or entering the container. Their output should be bounded and should never expose unrestricted host Git arguments.

## 5. `/sandbox patch`

Allow users to export a sandbox branch as a patch without changing the checked-out worktree. Require an explicit destination and bounded, validated revision selection.

## 6. `/sandbox apply`

Offer a confirmed, user-only operation for applying sandbox-branch work to the checked-out host branch. It should refuse dirty worktrees, validate ancestry, and preserve the sandbox branch if cherry-picking or fast-forwarding fails.

## 7. Explicit crash recovery

On startup, detect a preserved container whose tracked tree or commits are ahead of its authoritative host target and explain how to recover it. A `/sandbox recover` command could validate and import that work instead of waiting for a later checkpoint or requiring manual inspection.

## 8. Lockfile-aware dependency bootstrap

Record hashes of supported lockfiles and rerun dependency installation only when those inputs change. This would make reused containers faster while still refreshing dependencies when required.

## 9. `/sandbox doctor`

Diagnose runtime availability, image presence, cache permissions, repository cleanliness, lock ownership, ref consistency, container workspace health, and stale resources. The command should be read-only unless the user explicitly requests a repair.

## 10. Dirty tracked-host snapshot mode

Optionally snapshot tracked host modifications into the sandbox without committing them on the host. This needs clear attribution rules so pre-existing host changes are never silently mixed with or credited to sandbox-generated work.

## 11. Automated review/fix loop

Build on the read-only review agent by passing actionable findings back to the main agent for a bounded number of fix-and-review cycles. Define strict stop conditions and decide whether host publication happens on every cycle or only after reviewer approval.

## 12. Vault-style secret management

Add trusted, host-only secret profiles that map environment-variable names to Vault-like references. When a profile is approved for a command, agent run, or session, wrap each sandbox Bash and user `!` execution with a small helper that receives resolved values over stdin, sets the child environment, and `exec`s the shell so code using `getenv()` inherits the secrets. Keep Vault authentication outside the container, never expose secrets to fixed Git or read/write operations, avoid runtime command-line arguments and persisted session data, redact output, audit profile use without values, and clearly warn that any process in the granted scope can read or exfiltrate the injected secrets.

## 13. Stronger host-worktree publication guard

Reduce the low-probability race between checking whether a sandbox target branch is present in `git worktree list` and updating its ref. Investigate a Git-native update operation or additional repository-level coordination that refuses branches checked out by an external Git process without weakening compare-and-swap publication.
