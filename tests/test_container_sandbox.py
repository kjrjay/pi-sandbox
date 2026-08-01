#!/usr/bin/env python3
"""Fast control-plane tests for the container-sandbox Pi extension.

The suite deliberately avoids starting containers or calling models and should
finish comfortably within 30 seconds. It loads this checkout explicitly with an
isolated PI_CODING_AGENT_DIR, so user credentials, sessions, settings, and
extensions are untouched.
"""

from __future__ import annotations

import base64
import json
import os
import select
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

EXTENSION_DIR = Path(__file__).resolve().parents[1]
EXTENSION_PATH = EXTENSION_DIR / "index.ts"
PI = os.environ.get("PI_BIN", "pi")
RPC_TIMEOUT = min(20, int(os.environ.get("PI_SANDBOX_TEST_TIMEOUT", "20")))


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)


def init_repo() -> Path:
    root = Path(tempfile.mkdtemp(prefix="pi-container-sandbox-test-")).resolve()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Container Sandbox Test"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "container-sandbox-test@example.invalid"], cwd=root, check=True)
    (root / "tracked.txt").write_text("base\n")
    subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=root, check=True)
    return root


class RpcPi:
    def __init__(self, cwd: Path, agent_dir: Path, *extra_args: str) -> None:
        env = os.environ.copy()
        env["PI_CODING_AGENT_DIR"] = str(agent_dir)
        self.process = subprocess.Popen(
            [
                PI,
                "--mode",
                "rpc",
                "--no-session",
                "--no-extensions",
                "--extension",
                str(EXTENSION_PATH),
                "--approve",
                *extra_args,
            ],
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def command(self, request_id: str, message: str) -> list[dict[str, Any]]:
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write(json.dumps({"id": request_id, "type": "prompt", "message": message}) + "\n")
        self.process.stdin.flush()
        events: list[dict[str, Any]] = []
        deadline = time.monotonic() + RPC_TIMEOUT
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.process.stdout], [], [], 0.25)
            if not ready:
                if self.process.poll() is not None:
                    break
                continue
            line = self.process.stdout.readline()
            if not line:
                break
            event = json.loads(line)
            events.append(event)
            if event.get("type") == "response" and event.get("id") == request_id:
                return events
        stderr = self.process.stderr.read() if self.process.stderr and self.process.poll() is not None else ""
        raise AssertionError(f"Pi did not answer {message!r} within {RPC_TIMEOUT}s: {stderr}")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class ContainerSandboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which(PI) is None:
            raise unittest.SkipTest(f"Pi executable not found: {PI}")

    def setUp(self) -> None:
        self.root = init_repo()
        self.agent_dir = Path(tempfile.mkdtemp(prefix="pi-container-sandbox-agent-")).resolve()
        (self.agent_dir / "extensions").mkdir(parents=True)
        self.processes: list[RpcPi] = []
        self.write_global_config({})

    def tearDown(self) -> None:
        for process in reversed(self.processes):
            process.close()
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.agent_dir, ignore_errors=True)

    def write_global_config(self, overrides: dict[str, Any]) -> None:
        config = {
            "runtime": "container",
            "image": "test-image:latest",
            "dockerPortMode": "dynamic",
            "dockerPortRange": "8000-8010",
            "hostGateway": "",
            "target": "sandbox",
            "checkpointFrequency": "agent",
            "hostUntrackedFiles": "ignore",
            "gitCloneDepth": 1,
            "gitCommitCoAuthor": "",
            "gitCommitAiMaxDiffBytes": 20_000,
            "installDeps": "never",
            "lifecycle": "stopped",
            "passEnv": [],
            "review": {"model": "", "thinkingLevel": "off", "maxDiffBytes": 100_000},
        }
        config.update(overrides)
        (self.agent_dir / "extensions" / "pi-sandbox.json").write_text(json.dumps(config))

    def pi(self, *args: str) -> RpcPi:
        process = RpcPi(self.root, self.agent_dir, *args)
        self.processes.append(process)
        return process

    @staticmethod
    def errors(events: list[dict[str, Any]]) -> list[str]:
        return [str(event.get("error", "")) for event in events if event.get("type") == "extension_error"]

    @staticmethod
    def notifications(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            event
            for event in events
            if event.get("type") == "extension_ui_request" and event.get("method") == "notify"
        ]

    def test_extension_loads_without_discovered_extensions(self) -> None:
        env = os.environ.copy()
        env["PI_CODING_AGENT_DIR"] = str(self.agent_dir)
        result = run([PI, "--no-extensions", "--extension", str(EXTENSION_PATH), "--list-models"], cwd=self.root, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_empty_and_explicit_status_commands_match(self) -> None:
        process = self.pi()
        implicit = self.notifications(process.command("implicit", "/sandbox"))
        explicit = self.notifications(process.command("explicit", "/sandbox status"))
        self.assertTrue(implicit)
        self.assertTrue(explicit)
        self.assertEqual(implicit[-1].get("message"), explicit[-1].get("message"))

    def test_attach_without_path_reports_usage_without_starting_container(self) -> None:
        events = self.pi().command("attach-usage", "/sandbox attach")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        self.assertTrue(
            any(
                event.get("notifyType") == "warning"
                and "Usage: /sandbox attach <host-image-path> [-- message]" in str(event.get("message", ""))
                for event in notifications
            )
        )
        self.assertFalse(self.errors(events))

    def test_attach_sends_host_image_and_message_without_starting_container(self) -> None:
        image_path = self.root / "screenshot -- with spaces.png"
        image_path.write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        ))
        capture_extension = self.agent_dir / "capture-attachment.ts"
        capture_extension.write_text(
            """
export default function (pi: any) {
  pi.registerProvider("attachment-test", {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test",
    api: "openai-completions",
    models: [{
      id: "image-model",
      name: "Image Model",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000,
      maxTokens: 1000,
    }],
  });
  pi.on("input", (event: any, ctx: any) => {
    if (event.source !== "extension" || !event.images?.length) return;
    ctx.ui.notify(`Captured attachment: ${event.text}; ${event.images[0].mimeType}`, "info");
    return { action: "handled" };
  });
}
"""
        )
        events = self.pi(
            "--extension", str(capture_extension),
            "--provider", "attachment-test",
            "--model", "image-model",
        ).command(
            "attach-image",
            f'/sandbox attach "{image_path}" -- Explain this screenshot',
        )
        notifications = self.notifications(events)
        self.assertTrue(
            any(
                "Captured attachment: Explain this screenshot; image/png" in str(event.get("message", ""))
                for event in notifications
            ),
            notifications,
        )
        self.assertFalse(self.errors(events))

    def test_builtin_runtime_defaults_to_docker(self) -> None:
        (self.agent_dir / "extensions" / "pi-sandbox.json").write_text("{}")
        events = self.pi().command("default-runtime", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Runtime: docker", message)
        self.assertIn("Target: sandbox", message)
        self.assertFalse(self.errors(events))

    def test_named_target_lock_is_reported_before_prompt(self) -> None:
        self.write_global_config({"target": "sandbox:feat-123"})
        first_events = self.pi().command("first-owner", "/sandbox status")
        self.assertFalse(self.errors(first_events))

        second_events = self.pi().command("second-owner", "/sandbox status")
        self.assertTrue(
            any(
                event.get("notifyType") == "error"
                and "Sandbox target feat-123 is already owned by Pi session" in str(event.get("message", ""))
                for event in self.notifications(second_events)
            ),
            second_events,
        )
        self.assertTrue(
            any(
                event.get("type") == "extension_ui_request"
                and event.get("method") == "setStatus"
                and "sandbox: locked (feat-123)" in str(event.get("statusText", ""))
                for event in second_events
            ),
            second_events,
        )
        status_message = str(self.notifications(second_events)[-1].get("message", ""))
        self.assertIn("Target lock: Sandbox target feat-123 is already owned by Pi session", status_message)
        self.assertFalse(self.errors(second_events))

    def test_status_reports_lifecycle_and_checkpoint_frequency(self) -> None:
        self.write_global_config({"lifecycle": "running", "checkpointFrequency": "settled", "target": "current"})
        events = self.pi().command("status", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Container lifecycle: running", message)
        self.assertIn("Checkpoint frequency: settled", message)
        self.assertIn("Target: current", message)
        self.assertIn("Sandbox identity: (current branch)", message)
        self.assertFalse(self.errors(events))

    def test_docker_network_configuration_is_reported_without_starting_docker(self) -> None:
        self.write_global_config({
            "runtime": "docker",
            "dockerPortMode": "fixed",
            "dockerPortRange": "08000-08002",
            "hostGateway": "host.docker.internal",
        })
        events = self.pi().command("docker-status", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Docker port mode: fixed", message)
        self.assertIn("Docker container port range: 8000-8002", message)
        self.assertIn("Docker host mappings: (available after container starts)", message)
        self.assertIn("Docker host gateway: host.docker.internal", message)
        self.assertFalse(self.errors(events))

    def test_docker_port_cli_overrides_are_reported(self) -> None:
        events = self.pi(
            "--sandbox-runtime", "docker",
            "--sandbox-docker-port-mode", "fixed",
            "--sandbox-docker-port-range", "09000-09001",
            "--sandbox-target", "sandbox:feat/feature-b",
        ).command("docker-cli", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Docker port mode: fixed", message)
        self.assertIn("Docker container port range: 9000-9001", message)
        self.assertIn("Target: sandbox:feat/feature-b", message)
        self.assertFalse(self.errors(events))

    def test_disabled_docker_ports_are_reported(self) -> None:
        self.write_global_config({"runtime": "docker", "dockerPortMode": "disabled"})
        events = self.pi().command("docker-disabled", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Docker port mode: disabled", message)
        self.assertIn("Docker container port range: (not published)", message)
        self.assertIn("Docker host mappings: (disabled)", message)
        self.assertFalse(self.errors(events))

    def test_current_baseline_refresh_requires_a_clean_synchronized_workspace(self) -> None:
        policy_extension = self.agent_dir / "baseline-policy-test.ts"
        policy_extension.write_text(
            f"""
import {{ synchronizedCurrentBaseline }} from {json.dumps(str(EXTENSION_PATH))};

export default function (pi: any) {{
  pi.registerCommand("baseline-policy-test", {{
    handler: async (_args: string, ctx: any) => {{
      const common = {{
        commitTarget: "current" as const,
        baseCommit: "aaaaaaaa",
        hostHead: "bbbbbbbb",
        containerHead: "bbbbbbbb",
        workspaceStatus: "",
        pendingRebase: false,
      }};
      const cases = [
        ["new clean container", common, "bbbbbbbb"],
        ["existing clean container", {{ ...common }}, "bbbbbbbb"],
        ["tracked changes", {{ ...common, workspaceStatus: " M tracked.txt" }}, undefined],
        ["untracked changes", {{ ...common, workspaceStatus: "?? scratch.txt" }}, undefined],
        ["unpublished history", {{ ...common, containerHead: "cccccccc" }}, undefined],
        ["pending rebase", {{ ...common, pendingRebase: true }}, undefined],
        ["sandbox target", {{ ...common, commitTarget: "sandbox" as const }}, undefined],
      ] as const;
      for (const [name, input, expected] of cases) {{
        const actual = synchronizedCurrentBaseline(input);
        if (actual !== expected) throw new Error(`${{name}}: expected ${{expected}}, got ${{actual}}`);
      }}
      ctx.ui.notify("baseline policy passed", "info");
    }},
  }});
}}
"""
        )
        events = self.pi("--extension", str(policy_extension)).command(
            "baseline-policy", "/baseline-policy-test"
        )
        self.assertFalse(self.errors(events), self.errors(events))
        self.assertTrue(
            any("baseline policy passed" in str(event.get("message", "")) for event in self.notifications(events)),
            events,
        )

    def test_unknown_subcommand_is_rejected(self) -> None:
        events = self.pi().command("unknown", "/sandbox rebsae")
        self.assertTrue(
            any(
                event.get("notifyType") == "error"
                and "Unknown sandbox command: rebsae" in str(event.get("message", ""))
                for event in self.notifications(events)
            )
        )

    def test_invalid_cli_choices_are_rejected(self) -> None:
        cases = [
            (["--sandbox-runtime", "invalid-runtime"], "--sandbox-runtime must be one of"),
            (["--sandbox-runtime", "podman"], "--sandbox-runtime must be one of"),
            (["--sandbox-target", "sandbox:"], "sandbox branch must be a valid"),
            (["--sandbox-target", "sandbox:HEAD"], "sandbox branch must be a valid"),
            (["--sandbox-target", f"sandbox:{'a' * 97}"], "must not exceed 96 characters"),
            (["--sandbox-target", "sandbox name"], "must be sandbox, sandbox:<branch>, or current"),
            (["--sandbox-target", "branch"], "must be sandbox, sandbox:<branch>, or current"),
            (["--sandbox-lifecycle", "paused"], "--sandbox-lifecycle must be one of"),
            (["--sandbox-checkpoint-frequency", "prompt"], "--sandbox-checkpoint-frequency must be one of"),
            (["--sandbox-docker-port-mode", "random"], "--sandbox-docker-port-mode must be one of"),
            (["--sandbox-docker-port-range", "0-10"], "must contain ports from 1 through 65535"),
            (["--sandbox-docker-port-range", "9000-8000"], "must contain ports from 1 through 65535"),
            (["--sandbox-docker-port-range", "8000-8100"], "must contain no more than 100 ports"),
            (["--sandbox-git-clone-depth", "abc"], "--sandbox-git-clone-depth must be a non-negative integer"),
            (["--sandbox-env", "GOOD,NOT-VALID"], "invalid environment variable name"),
        ]
        for index, (arguments, expected) in enumerate(cases):
            with self.subTest(arguments=arguments):
                process = self.pi(*arguments)
                try:
                    events = process.command(f"invalid-{index}", "/sandbox status")
                    self.assertTrue(any(expected in error for error in self.errors(events)), self.errors(events))
                finally:
                    process.close()
                    self.processes.remove(process)

    def test_unknown_configuration_key_is_rejected(self) -> None:
        self.write_global_config({"lifecyle": "stopped"})
        events = self.pi().command("unknown-config", "/sandbox status")
        self.assertTrue(any("unknown option: lifecyle" in error for error in self.errors(events)))

    def test_invalid_docker_host_gateway_is_rejected(self) -> None:
        self.write_global_config({"hostGateway": "not_a_hostname"})
        events = self.pi().command("invalid-gateway", "/sandbox status")
        self.assertTrue(any("hostGateway must be a valid hostname" in error for error in self.errors(events)))


if __name__ == "__main__":
    unittest.main()
