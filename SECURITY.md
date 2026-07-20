# Container Sandbox Security

This document describes the security boundary, host-side protections, data exposure, and known limitations of the Pi Container Sandbox extension. See [README.md](README.md) for installation and configuration.

> [!WARNING]
> The sandbox reduces accidental host access; it does not make arbitrary code safe. The container runtime, image, kernel or VM, network, Git parsers, and Pi process remain trusted components.

## Security goals

The extension is designed to:

- keep Pi credentials, model authentication, sessions, and the TUI on the host;
- run Pi's standard file and shell tools against a container copy of the repository;
- avoid mounting the host repository or its `.git` directory into the container;
- expose only narrowly scoped, fixed host operations for workspace creation, checkpoint import, ref publication, review, rebase, and lifecycle management;
- validate container-produced Git history before publishing it on the host;
- leave the checked-out host branch and worktree unchanged when using the default `sandbox-ref` target.

These goals do not cover other Pi extensions, manually executed host commands, runtime vulnerabilities, or deliberate data exfiltration through allowed network and model access.

## Trust boundaries

### Host process

Pi, this extension, provider credentials, model requests, configuration, sessions, and host Git orchestration run with the user's normal host permissions. A compromise of Pi, this extension, another loaded extension, or the runtime CLI is outside the sandbox boundary.

There are no model-callable host Git or host shell tools provided by this extension. The host invokes fixed Git and container-runtime commands internally. `--no-sandbox` intentionally disables routing and restores Pi's normal host tools.

### Container workspace

The container receives a copied local clone with its own `.git` directory. It does not receive the host worktree or host `.git` directory as a bind mount.

Pi's `read`, `write`, `edit`, `bash`, `ls`, `find`, and `grep` tools, plus user `!` commands, are routed into the container while sandboxing is enabled. Most tool commands run as the image's configured user; selected workspace setup and cleanup operations run as root inside the container.

The image and all code executed in it should be treated as untrusted relative to the host but trusted relative to data deliberately exposed through mounts, copied files, environment variables, networking, and model requests.

### Host bridges

The sandbox deliberately has several controlled bridges to the host:

- a writable package-cache bind mount under `~/.pi/agent/cache/container-sandbox/packages`;
- Git bundles copied between host temporary directories and the container;
- optional copied host-untracked files;
- optional allowlisted environment variables;
- optional Docker loopback port publication;
- optional Docker `host-gateway` connectivity;
- validated host Git ref updates and, in `current-branch` mode, host worktree updates.

These bridges are part of the trusted design surface, not isolation guarantees.

## Git publication security

### `sandbox-ref` — safer default

Validated commits are imported under `refs/pi-sandbox/*`. The checked-out host branch, index, and worktree remain unchanged. The host repository's ref database is still intentionally modified.

Use this target when repository checkout filters are untrusted, host-worktree changes are undesirable, or sandbox output should be reviewed before integration.

### `current-branch`

This mode has a larger host-side trust boundary. It guarded-fast-forwards and materializes validated commits in the checked-out host worktree.

The extension:

- requires an attached branch and clean tracked host files;
- records and verifies the expected branch and baseline commit;
- uses a per-worktree process lock;
- refuses publication if the branch or tracked worktree changes unexpectedly;
- requires an in-container rebase after compatible host advancement;
- preserves imported work under `refs/pi-sandbox-recovery/*` if final publication fails.

Host checkout can invoke repository-configured Git LFS, smudge/process filters, attributes, and line-ending conversion. Prefer `sandbox-ref` when those behaviors are not trusted.

### Checkpoint validation

For normal checkpoints, the extension does not trust commits created directly by sandbox code. It rebuilds one commit from the staged tree against an authoritative parent, using host-resolved author identity and disabling commit signing.

Before publication, it:

1. removes copied host-untracked overlays from the checkpoint index;
2. transfers objects through a temporary Git bundle and ref;
3. verifies the imported tip and runs `git fsck --strict`;
4. validates parentage, ancestry, and expected commit count;
5. publishes with compare-and-swap or a guarded fast-forward.

Host Git orchestration disables prompting, pagers, hooks, fsmonitor, external diff commands, automatic maintenance, and global/system Git configuration where applicable. The author-identity lookup intentionally reads normal host repository/global `user.name` and `user.email` values.

Git object parsing remains a trusted host component. A runtime or Git vulnerability can bypass these higher-level validations.

## Data and secret exposure

### Model providers

Normal Pi operation may send prompts, file contents, and tool results to the selected model provider. The sandbox does not prevent that data flow.

Additionally:

- commit-message generation sends a bounded staged diff to the active model;
- `/sandbox review` sends the selected patch and lets the reviewer model inspect additional sandbox files through read-only tools.

Do not place secrets in files or output that an agent or reviewer can inspect. Review provider retention and privacy policies separately.

### Host-untracked files

`hostUntrackedFiles: "copy"` copies non-ignored host-untracked files into the sandbox. Discovery follows `.gitignore` and optional `.pi-sandboxignore` rules, but those rules are not a substitute for secret management.

Copied overlay paths are excluded from checkpoints, and manifests are reconciled on reuse so host-deleted or newly ignored files do not become later checkpoints. Sandbox processes can still read and transmit copied content.

Use the safer default, `hostUntrackedFiles: "ignore"`, unless the overlay is required.

### Environment variables

Every name in `passEnv` exposes its host value to sandbox shell commands. A sandbox process can read, retain, print, or transmit those values. The extension does not provide output redaction or scoped secret injection.

Keep `passEnv` empty unless a variable is required, and do not pass broad credentials to untrusted code.

### Preserved containers

With `lifecycle: "stopped"` or `"running"`, the container filesystem and copied data remain on disk for reuse. `running` also leaves processes and resource consumption active after Pi exits. Use `lifecycle: "remove"` when persistence is unnecessary.

## Network exposure

The extension does not disable container network egress. Sandbox code may contact external services unless the runtime is configured separately to prevent it.

For Docker:

- `dockerPortMode: "disabled"` publishes no container ports;
- `dynamic` and `fixed` bind published ports only to host `127.0.0.1`;
- loopback prevents direct LAN exposure but does not authenticate services or block other local processes;
- fixed ports can collide with existing host listeners;
- a non-empty `hostGateway` lets sandbox processes connect to services reachable through Docker's host gateway.

Leave Docker port publication disabled when host access is unnecessary, and leave `hostGateway` empty unless the sandbox must contact a host service.

## Shared package cache

The package cache is the extension's only persistent writable host bind mount. A malicious sandbox can poison cache entries consumed by later sandboxes. It cannot directly write elsewhere through this mount, but package-manager behavior and later dependency installation remain part of the risk.

Do not treat the shared cache as trusted evidence. Remove it if compromise is suspected:

```text
~/.pi/agent/cache/container-sandbox/packages
```

## Concurrency and recovery limitations

- `current-branch` sessions use a per-worktree lock.
- Explicitly named `sandbox-ref` containers are not yet locked across Pi processes. Concurrent reuse can interfere inside the container even though compare-and-swap prevents silent host-ref overwrite.
- A stopped or running container can contain work newer than its host target after a crash. Explicit automated crash-recovery tooling is not yet implemented; preserve and inspect such a container rather than deleting it blindly.
- Container and model workflows currently rely on manual integration testing; the permanent automated suite covers the control plane without starting containers or calling models.

See [feature-list.md](feature-list.md) for planned locking, recovery, diagnostics, and cleanup work.

## Recommended conservative configuration

For stronger isolation within the extension's current design, start with:

```json
{
  "commitTarget": "sandbox-ref",
  "hostUntrackedFiles": "ignore",
  "passEnv": [],
  "dockerPortMode": "disabled",
  "hostGateway": "",
  "installDeps": "never",
  "lifecycle": "remove"
}
```

Also:

- use a minimal, pinned, trusted image;
- avoid privileged containers and extra runtime mounts outside this extension;
- restrict container networking at the runtime level when egress is unnecessary;
- review sandbox refs before integrating them into a normal branch;
- keep Pi and the container runtime updated;
- do not load unrelated or untrusted Pi extensions in the same process.
