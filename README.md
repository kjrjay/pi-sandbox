# Pi Container Sandbox

A Pi extension that runs file and shell tools inside an isolated container workspace while keeping Pi, authentication, model calls, sessions, and the TUI on the host.

The extension routes `read`, `write`, `edit`, `bash`, `ls`, `find`, `grep`, and user `!` commands into the container. The host repository's `.git` directory is never mounted into it.

> [!IMPORTANT]
> A container reduces accidental host modification; it is not an absolute security boundary. Review [SECURITY.md](SECURITY.md) before using untrusted images or repositories.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Uninstallation](#uninstallation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Commit targets](#commit-targets)
- [Checkpoints](#checkpoints)
- [Workspace and lifecycle](#workspace-and-lifecycle)
- [Host-untracked files](#host-untracked-files)
- [Docker networking](#docker-networking)
- [Dependencies and package caches](#dependencies-and-package-caches)
- [Review agent](#review-agent)
- [Rebasing](#rebasing)
- [Commands](#commands)
- [Configuration](#configuration)
- [CLI flags](#cli-flags)
- [Tests](#tests)
- [Security and limitations](#security-and-limitations)

## Features

- Routes Pi's standard file and shell tools into Apple Container, Docker, or Podman.
- Keeps host credentials, sessions, model calls, and the repository `.git` directory outside the container.
- Creates validated Git checkpoints under an isolated sandbox ref or fast-forwards the current branch.
- Supports automatic checkpoints after a model turn, agent run, or fully settled cycle.
- Preserves or removes containers according to configurable lifecycle policy.
- Supports protected host-untracked overlays, lockfile-based dependency bootstrap, and shared package caches.
- Provides a read-only review agent and guarded in-container rebasing.
- Supports disabled, dynamic, or fixed Docker port publication on host loopback.

## Requirements

- Pi with Git package support.
- A supported runtime: Apple `container`, `docker`, or `podman`.
- A Git repository with an existing `HEAD` commit.
- A clean tracked host worktree. Untracked files are handled separately by `hostUntrackedFiles`.
- A container image with the tools needed by the project. Core sandbox operations require common shell utilities, Bash, Git, and tar; sandbox `grep` requires ripgrep.

## Installation

Pi packages execute with the installing user's full permissions. Review [`index.ts`](index.ts) and [SECURITY.md](SECURITY.md) before installation.

### Install from GitHub

Install globally for the current user:

```bash
pi install https://github.com/kjrjay/pi-sandbox
```

Or use Pi's Git shorthand:

```bash
pi install git:github.com/kjrjay/pi-sandbox
```

Install only for the current trusted project:

```bash
pi install -l https://github.com/kjrjay/pi-sandbox
```

Project-local installation writes to `.pi/settings.json`, which can be shared with the project. Pi installs the package after the project is trusted.

To pin a release, append a tag or commit:

```bash
pi install git:github.com/kjrjay/pi-sandbox@v0.1.0
```

Pinned refs remain fixed during package updates. Install a newer ref explicitly when upgrading a pinned installation.

### Try without installing

Load the extension temporarily for one Pi invocation:

```bash
pi -e https://github.com/kjrjay/pi-sandbox
```

### Update

Update an unpinned installation:

```bash
pi update --extensions
```

Use `pi list` to inspect installed package sources. Restart Pi after installation, or run `/reload` in an existing session.

### Manual installation

Alternatively, clone the repository into Pi's global extension directory:

```bash
git clone https://github.com/kjrjay/pi-sandbox.git \
  ~/.pi/agent/extensions/container-sandbox
```

Pi auto-discovers `index.ts` from that directory. Pull updates with Git and run `/reload` afterward.

## Uninstallation

Before uninstalling, checkpoint or preserve any work needed from `refs/pi-sandbox/*`, then stop active sandbox operations.

Remove a global Pi package using the same unpinned source form used for installation:

```bash
pi remove https://github.com/kjrjay/pi-sandbox
```

For a project-local installation:

```bash
pi remove -l https://github.com/kjrjay/pi-sandbox
```

If the package was installed with Git shorthand, use:

```bash
pi remove git:github.com/kjrjay/pi-sandbox
```

Use `pi list` when unsure which source is recorded. Restart Pi or run `/reload` after removal.

For a manual clone, remove its directory:

```bash
rm -rf ~/.pi/agent/extensions/container-sandbox
```

Package removal intentionally does not delete configuration, caches, containers, or Git refs. Remove these only after reviewing anything that may contain recoverable work.

Optional configuration and cache cleanup:

```bash
rm -f ~/.pi/agent/extensions/container-sandbox.json
rm -rf ~/.pi/agent/cache/container-sandbox
```

Docker containers created by the extension can be listed by their managed label:

```bash
docker ps -a --filter label=pi.container-sandbox.managed=true
```

Sandbox and recovery refs can be reviewed in each affected repository with:

```bash
git for-each-ref refs/pi-sandbox/ refs/pi-sandbox-recovery/
```

Do not delete containers or refs until their work is committed, exported, or no longer needed.

## Quick start

After installation, add a partial global configuration at:

```text
~/.pi/agent/extensions/container-sandbox.json
```

Example Docker configuration:

```json
{
  "runtime": "docker",
  "image": "pi-tool-sandbox:latest",
  "commitTarget": "sandbox-ref",
  "checkpointFrequency": "agent",
  "dockerPortMode": "dynamic",
  "dockerPortRange": "8000-8010",
  "lifecycle": "stopped"
}
```

A trusted project can override global values with:

```text
<project>/.pi/container-sandbox.json
```

Start Pi from a clean Git worktree. The container is created lazily before the first agent run. Use `/sandbox status` to inspect the effective configuration and active container.

## How it works

1. The extension validates the repository and runtime configuration.
2. It creates a local clone from the authoritative host Git ref and copies that workspace into the container.
3. Pi's normal file and shell tools execute against the container copy.
4. At the configured boundary, the extension stages and validates sandbox changes.
5. It transfers Git objects through a temporary bundle and publishes them to the selected commit target.

Runtime command capture is bounded on the host. Bash output streams through Pi without retaining an unbounded duplicate buffer.

## Commit targets

### `sandbox-ref` — default

Each session checkpoints into an isolated host ref:

```text
refs/pi-sandbox/<base-branch>/<sandbox-name-or-session-id>
```

The checked-out host branch, index, and worktree remain unchanged. Session-derived names support parallel feature work. An explicit `sandboxName` provides stable ref and container identity, but two processes must not concurrently reuse the same named sandbox.

### `current-branch`

Validated checkpoints fast-forward the branch that was checked out when the sandbox started, updating the host index and worktree. This mode:

- requires an attached local branch;
- ignores `sandboxName`;
- uses a per-worktree lock to prevent concurrent sessions;
- refuses publication if the host branch or tracked worktree changes unexpectedly.

If the branch advances, run `/sandbox rebase`. The rebase occurs inside the container before the host branch is fast-forwarded.

## Checkpoints

`checkpointFrequency` controls automatic checkpoint timing:

| Value | Boundary |
|---|---|
| `turn` | After each internal model response and its tool calls. This is the default and gives the finest-grained recovery. |
| `agent` | After one low-level agent tool loop, normally one checkpoint per submitted prompt. |
| `settled` | After retries, compaction retries, and queued continuations have finished. |

At each checkpoint, the extension:

1. Stages the sandbox tree against the authoritative baseline.
2. Generates a commit message with the active model, with a timestamp fallback.
3. Reconstructs one commit using the expected parent and host Git author identity.
4. Transfers it through a temporary Git bundle and host ref.
5. Validates object integrity, parentage, ancestry, and commit count.
6. Advances the sandbox ref with compare-and-swap or guarded-fast-forwards the current branch.

Copied host-untracked overlay files are removed from the checkpoint index. `/sandbox checkpoint` runs the same operation manually.

## Workspace and lifecycle

New workspaces come from a local host clone and are shallow by default. No remote clone or remote Git authentication is required.

Existing containers are reused only after validating their image, package-cache mount, managed metadata, repository identity, configuration, and authoritative Git ref. Clean stale workspaces are reseeded. Mismatched or recoverable containers are preserved and rejected rather than silently overwritten.

`lifecycle` controls shutdown behavior:

| Value | Behavior |
|---|---|
| `remove` | Checkpoint and remove the container. This is the default. |
| `stopped` | Checkpoint and stop the container for reuse. |
| `running` | Checkpoint and leave the container running. |

`/sandbox stop` checkpoints and then stops `stopped` or `running` containers, or removes `remove` containers. A later sandbox tool call can start the sandbox again.

## Host-untracked files

`hostUntrackedFiles` controls files already untracked on the host:

| Value | Behavior |
|---|---|
| `ignore` | Do not copy them. This is the default. Host files are not deleted or modified. |
| `copy` | Copy non-ignored files into the container as a checkpoint-protected overlay. |

Discovery follows `.gitignore` and optional `.pi-sandboxignore` rules. On reuse, previous and current overlay manifests are reconciled so files removed or newly ignored on the host are removed from the container before checkpointing.

Copied files remain readable by sandbox processes. Exclude credentials and other sensitive files.

## Docker networking

When `runtime` is `docker`, `dockerPortMode` controls publication of every container port in `dockerPortRange`:

| Mode | Behavior |
|---|---|
| `disabled` | Publish no ports. |
| `dynamic` | Map each container port to a Docker-assigned host port on `127.0.0.1`. This is the default and avoids port conflicts. |
| `fixed` | Map each container port to the same numbered host port on `127.0.0.1`. Startup fails when a selected host port is occupied. |

Examples:

```text
Dynamic: 127.0.0.1:49153 -> container:8000
Fixed:   127.0.0.1:8000  -> container:8000
```

In both publishing modes, the server inside the container must bind to `0.0.0.0` on a configured container port. Resolved mappings appear in the startup notification, `/sandbox status`, and the agent system prompt. They remain stable while a stopped container is preserved.

`dockerPortRange` accepts one port or an ascending range of at most 100 ports. Set `hostGateway` to a hostname such as `host.docker.internal` to add Docker's `host-gateway` mapping. Host-gateway access is disabled by default because it lets sandbox processes connect to services on the Docker host.

These options do not affect Apple Container or Podman.

## Dependencies and package caches

`installDeps` supports:

| Value | Behavior |
|---|---|
| `never` | Do not install dependencies. This is the default. |
| `auto` | Run fixed lockfile-based bootstrap logic for npm, pnpm, Yarn, Bun, uv, or pip. |

New containers bind-mount the extension-owned cache directory:

```text
~/.pi/agent/cache/container-sandbox/packages:/var/cache/pi-packages
```

Download caches are shared across containers. Project `node_modules` and virtual environments remain inside each workspace. `installDepsOnReuse` controls whether bootstrap runs again for reused containers.

## Review agent

`/sandbox review` creates an isolated, in-memory reviewer session. With no instructions, it reviews the latest sandbox commit. Text after `--` can select a scope and provide guidance:

```text
/sandbox review -- check the last 3 commits for security issues
/sandbox review -- commit hash 21e81311a
```

The reviewer has a separate context and read-only tools routed into the existing container. It cannot use host filesystem or shell tools. The completed report records the resolved commits, instructions, tool activity, diff stat, model, and usage metadata without modifying files or starting a fix loop.

Requested commits must exist in the sandbox clone. Set `gitCloneDepth: 0` when reviews need older host history.

## Rebasing

`/sandbox rebase` checkpoints pending work and rebases it inside the container onto the latest commit of the original host branch. A clean result is bundled to the host, validated, and published to the selected target.

If conflicts occur, automatic checkpoints pause. Resolve conflicts inside the container, stage them, and continue the rebase. Use `/sandbox rebase-status` to inspect progress or `/sandbox rebase-abort` to restore the pre-rebase sandbox state.

Non-fast-forward rewrites of the host base branch are rejected. If the host branch advances during final `current-branch` publication, the rebased work is preserved under `refs/pi-sandbox-recovery/*`.

## Commands

| Command | Description |
|---|---|
| `/sandbox` | Show status. |
| `/sandbox status` | Show effective configuration and runtime status. |
| `/sandbox checkpoint` | Create and publish a checkpoint immediately. |
| `/sandbox review [-- instructions]` | Review sandbox commits with the read-only reviewer. |
| `/sandbox rebase` | Rebase sandbox work onto the latest host base. |
| `/sandbox rebase-status` | Show pending rebase state. |
| `/sandbox rebase-abort` | Abort the pending rebase. |
| `/sandbox stop` | Checkpoint and stop or remove the container. |

Mutating commands wait for the active agent to become idle.

## Configuration

Configuration precedence, from lowest to highest:

1. Built-in defaults.
2. Global `~/.pi/agent/extensions/container-sandbox.json`.
3. Trusted project `<project>/.pi/container-sandbox.json`.
4. CLI flags.

Both JSON files may contain only the values they override. Unknown keys and invalid values are rejected.

| Option | Default | Description |
|---|---:|---|
| `runtime` | `"container"` | `container`, `docker`, or `podman`. |
| `image` | `"pi-tool-sandbox:latest"` | Container image used by the sandbox. |
| `dockerPortMode` | `"dynamic"` | `disabled`, `dynamic`, or `fixed`. |
| `dockerPortRange` | `"8000-8010"` | Docker container port or ascending range, up to 100 ports. |
| `hostGateway` | `""` | Optional Docker hostname mapped to `host-gateway`. |
| `sandboxName` | `""` | Stable sandbox-ref/container identity; empty uses the session ID. |
| `commitTarget` | `"sandbox-ref"` | `sandbox-ref` or `current-branch`. |
| `checkpointFrequency` | `"turn"` | `turn`, `agent`, or `settled`. |
| `installDepsOnReuse` | `false` | Run dependency bootstrap again after container reuse. |
| `hostUntrackedFiles` | `"ignore"` | `ignore` or `copy`. |
| `gitCloneDepth` | `1` | Local clone depth; `0` uses full history. |
| `gitCommitCoAuthor` | `"Pi <pi@localhost>"` | Optional commit-message co-author trailer. |
| `gitCommitAiMaxDiffBytes` | `20000` | Maximum staged diff sent for commit-message generation. |
| `installDeps` | `"never"` | `never` or `auto`. |
| `lifecycle` | `"remove"` | `remove`, `stopped`, or `running`. |
| `passEnv` | `[]` | Allowlist of host environment-variable names exposed to sandbox commands. |
| `review.model` | `""` | Reviewer model; empty uses the current session model. |
| `review.thinkingLevel` | `"high"` | Reviewer thinking level. |
| `review.maxDiffBytes` | `100000` | Maximum patch included directly in the review prompt. |

Example complete configuration:

```json
{
  "runtime": "docker",
  "image": "pi-tool-sandbox:latest",
  "dockerPortMode": "dynamic",
  "dockerPortRange": "8000-8010",
  "hostGateway": "",
  "sandboxName": "",
  "commitTarget": "sandbox-ref",
  "checkpointFrequency": "agent",
  "installDepsOnReuse": false,
  "hostUntrackedFiles": "ignore",
  "gitCloneDepth": 1,
  "gitCommitCoAuthor": "Pi <pi@localhost>",
  "gitCommitAiMaxDiffBytes": 20000,
  "installDeps": "never",
  "lifecycle": "stopped",
  "passEnv": [],
  "review": {
    "model": "",
    "thinkingLevel": "high",
    "maxDiffBytes": 100000
  }
}
```

Commit author and committer identity come from host Git configuration. The extension does not interpret Mise or other host tool-version configuration; required tools must exist in the image.

## CLI flags

| Flag | Description |
|---|---|
| `--no-sandbox` | Disable sandbox routing for this run. Standard tools execute on the host. |
| `--sandbox-runtime <container\|docker\|podman>` | Override the runtime. |
| `--sandbox-image <image>` | Override the image. |
| `--sandbox-docker-port-mode <disabled\|dynamic\|fixed>` | Override Docker port publication mode. |
| `--sandbox-docker-port-range <port\|start-end>` | Override Docker container ports. |
| `--sandbox-name <name>` | Override stable sandbox identity. |
| `--sandbox-commit-target <sandbox-ref\|current-branch>` | Override checkpoint target. |
| `--sandbox-checkpoint-frequency <turn\|agent\|settled>` | Override checkpoint boundary. |
| `--sandbox-git-clone-depth <n>` | Override local clone depth. |
| `--sandbox-install-deps <auto\|never>` | Override dependency bootstrap. |
| `--sandbox-lifecycle <remove\|stopped\|running>` | Override shutdown behavior. |
| `--sandbox-env FOO,BAR` | Add an environment-variable allowlist. |

## Tests

Run the permanent control-plane suite from the extension directory:

```bash
./tests/run.sh
```

The suite uses isolated Pi state, starts no containers, calls no models, and is designed to finish within 30 seconds. Container and model workflows currently require explicit manual integration checks; see [tests/README.md](tests/README.md).

## Security and limitations

There are no model-callable host shell or host Git tools. Host commands use fixed internal operations. `current-branch` has a larger trust boundary because materializing commits can invoke repository-configured Git LFS or checkout filters.

The runtime, image, networking, shared writable package cache, forwarded environment variables, Git parsers, and other Pi extensions remain outside this extension's isolation guarantee.

See:

- [SECURITY.md](SECURITY.md) for the security model and remaining caveats.
- [feature-list.md](feature-list.md) for planned improvements and known gaps.
