# Container sandbox tests

Run the permanent test suite from the extension directory:

```bash
./tests/run.sh
```

The suite is intentionally limited to fast control-plane tests and is expected to finish within 30 seconds. It:

- uses Python's standard `unittest` runner;
- loads this checkout explicitly with `pi --no-extensions --extension ./index.ts`;
- uses an isolated temporary `PI_CODING_AGENT_DIR`;
- does not start containers or call models;
- does not read or modify the user's Pi credentials, sessions, settings, or discovered extensions;
- creates temporary Git repositories and removes them during teardown.

Covered behavior includes extension loading, status and attachment dispatch, target parsing, early named-target lock reporting, unknown-command rejection, lifecycle and checkpoint-frequency reporting, stale current-target baseline reconciliation safety, Docker network configuration and validation, and strict CLI/configuration validation.

Override the Pi executable or per-request timeout when necessary:

```bash
PI_BIN=pi PI_SANDBOX_TEST_TIMEOUT=20 ./tests/run.sh
```

Container and model workflows remain covered by explicit manual integration checks because starting multiple Apple containers cannot reliably meet the 30-second suite limit.
