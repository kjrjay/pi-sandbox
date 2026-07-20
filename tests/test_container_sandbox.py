#!/usr/bin/env python3
"""Fast control-plane tests for the container-sandbox Pi extension.

The suite deliberately avoids starting containers or calling models and should
finish comfortably within 30 seconds. It loads this checkout explicitly with an
isolated PI_CODING_AGENT_DIR, so user credentials, sessions, settings, and
extensions are untouched.
"""

from __future__ import annotations

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
            "sandboxName": "",
            "commitTarget": "sandbox-ref",
            "checkpointFrequency": "agent",
            "installDepsOnReuse": False,
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

    def test_status_reports_lifecycle_and_checkpoint_frequency(self) -> None:
        self.write_global_config({"lifecycle": "running", "checkpointFrequency": "settled"})
        events = self.pi().command("status", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Container lifecycle: running", message)
        self.assertIn("Checkpoint frequency: settled", message)
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
        ).command("docker-cli", "/sandbox status")
        notifications = self.notifications(events)
        self.assertTrue(notifications)
        message = str(notifications[-1].get("message", ""))
        self.assertIn("Docker port mode: fixed", message)
        self.assertIn("Docker container port range: 9000-9001", message)
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
                events = self.pi(*arguments).command(f"invalid-{index}", "/sandbox status")
                self.assertTrue(any(expected in error for error in self.errors(events)), self.errors(events))

    def test_auto_remove_configuration_has_migration_error(self) -> None:
        config_path = self.agent_dir / "extensions" / "pi-sandbox.json"
        config_path.write_text(json.dumps({"runtime": "container", "image": "test-image:latest", "autoRemove": False}))
        events = self.pi().command("migration", "/sandbox status")
        self.assertTrue(any("autoRemove was replaced by lifecycle" in error for error in self.errors(events)))

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
