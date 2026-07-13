/**
 * Container Sandbox extension for pi.
 *
 * Keeps pi itself on the host for auth, sessions, model calls, and TUI, while
 * routing built-in tools and user ! commands into a container workspace. In
 * git-ref mode, each Pi session gets its own sandbox git clone; every turn is
 * committed in the sandbox and imported into refs/pi-sandbox/* on the host,
 * without moving the checked-out host branch/worktree. The model still sees
 * normal tools: read, write, edit, bash, grep, find, ls.
 *
 * Config files, merged with project taking precedence when trusted:
 *   ~/.pi/agent/extensions/container-sandbox.json
 *   <cwd>/.pi/container-sandbox.json
 *
 * Useful flags:
 *   --no-sandbox                         Disable this extension for one run
 *   --sandbox-runtime container|docker|podman
 *   --sandbox-image <image>               Image to use/build
 *   --sandbox-name <name>                 Stable sandbox/ref name (container is derived)
 *   --sandbox-git-clone-depth <n>          1 = shallow default, 0 = full history
 *   --sandbox-install-deps auto|never
 *   --sandbox-auto-remove                 Remove container after shutdown
 *   --sandbox-env FOO,BAR                 Allowlist host env vars for tool commands
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TextContent } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	formatSize,
	getAgentDir,
	truncateHead,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type HostUntrackedFilesMode = "ignore" | "copy";
type InstallDepsMode = "auto" | "never";

interface GitRefState {
	sessionId: string;
	sessionKey: string;
	baseBranch: string;
	baseCommit: string;
	sandboxRef: string;
	containerName: string;
	sandboxBranch: string;
	repoRoot: string;
	vcsBackend: "git";
}

interface GitRefCheckpointResult {
	committed: boolean;
	imported: boolean;
	message: string;
	commitHash?: string;
	sandboxRef?: string;
}

interface PendingRebase {
	oldBase: string;
	newBase: string;
	oldSandboxTip: string;
	expectedCommitCount: number;
	containerBaseRef: string;
	startedAt: string;
}

interface RebaseResult {
	completed: boolean;
	conflicted: boolean;
	message: string;
	conflictFiles?: string[];
}

interface SandboxConfig {
	runtime: "container" | "docker" | "podman" | string;
	image: string;
	sandboxName: string;
	installDepsOnReuse: boolean;
	hostUntrackedFiles: HostUntrackedFilesMode;
	gitCloneDepth: number;
	gitCommitCoAuthor: string;
	gitCommitAiMaxDiffBytes: number;
	installDeps: InstallDepsMode;
	autoRemove: boolean;
	passEnv: string[];
}

const DEFAULT_IMAGE = "pi-tool-sandbox:latest";
const GIT_REF_NAMESPACE = "refs/pi-sandbox";
const FALLBACK_COMMIT_PREFIX = "pi sandbox";
const PACKAGE_CACHE_VOLUME = "pi-sandbox-package-cache";
const PACKAGE_CACHE_ROOT = "/var/cache/pi-packages";
const PACKAGE_CACHE_ENV: Record<string, string> = {
	npm_config_cache: `${PACKAGE_CACHE_ROOT}/npm`,
	npm_config_store_dir: `${PACKAGE_CACHE_ROOT}/pnpm`,
	PNPM_STORE_DIR: `${PACKAGE_CACHE_ROOT}/pnpm`,
	BUN_INSTALL_CACHE_DIR: `${PACKAGE_CACHE_ROOT}/bun`,
	PIP_CACHE_DIR: `${PACKAGE_CACHE_ROOT}/pip`,
	UV_CACHE_DIR: `${PACKAGE_CACHE_ROOT}/uv`,
};
const DEFAULT_CONFIG: SandboxConfig = {
	runtime: "container",
	image: DEFAULT_IMAGE,
	sandboxName: "",
	installDepsOnReuse: false,
	hostUntrackedFiles: "ignore",
	gitCloneDepth: 1,
	gitCommitCoAuthor: "Pi <pi@localhost>",
	gitCommitAiMaxDiffBytes: 20_000,
	installDeps: "never",
	autoRemove: true,
	passEnv: [],
};

interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string | Buffer;
	signal?: AbortSignal;
	timeoutMs?: number;
	onData?: (data: Buffer) => void;
	streamStdoutOnly?: boolean;
}

interface ExecResult {
	code: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

function uniq(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function parseList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
	if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
	return undefined;
}

function mergeConfig(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	return {
		...base,
		...overrides,
		passEnv: parseList(overrides.passEnv) ?? base.passEnv,
	};
}

function readJson(pathName: string): Partial<SandboxConfig> {
	if (!existsSync(pathName)) return {};
	try {
		return JSON.parse(readFileSync(pathName, "utf8"));
	} catch (error) {
		console.error(`container-sandbox: could not parse ${pathName}: ${error}`);
		return {};
	}
}

function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadConfig(cwd: string, projectTrusted: boolean, pi: ExtensionAPI): SandboxConfig {
	const globalConfig = readJson(path.join(getAgentDir(), "extensions", "container-sandbox.json"));
	const projectConfig = projectTrusted ? readJson(path.join(cwd, CONFIG_DIR_NAME, "container-sandbox.json")) : {};
	let config = mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
	config.hostUntrackedFiles = normalizeChoice(
		config.hostUntrackedFiles,
		["ignore", "copy"] as const,
		DEFAULT_CONFIG.hostUntrackedFiles,
	);
	config.installDeps = normalizeChoice(config.installDeps, ["auto", "never"] as const, DEFAULT_CONFIG.installDeps);
	config.gitCloneDepth = normalizeNonNegativeInteger(config.gitCloneDepth, DEFAULT_CONFIG.gitCloneDepth);
	config.gitCommitAiMaxDiffBytes = normalizeNonNegativeInteger(config.gitCommitAiMaxDiffBytes, DEFAULT_CONFIG.gitCommitAiMaxDiffBytes);

	const runtime = pi.getFlag("sandbox-runtime") as string | undefined;
	if (runtime) config.runtime = runtime;
	const image = pi.getFlag("sandbox-image") as string | undefined;
	if (image) config.image = image;
	const sandboxName = pi.getFlag("sandbox-name") as string | undefined;
	if (sandboxName) config.sandboxName = sandboxName;
	const gitCloneDepth = pi.getFlag("sandbox-git-clone-depth") as string | undefined;
	if (gitCloneDepth !== undefined) config.gitCloneDepth = normalizeNonNegativeInteger(gitCloneDepth, config.gitCloneDepth);
	const installDeps = pi.getFlag("sandbox-install-deps") as string | undefined;
	if (installDeps) config.installDeps = normalizeChoice(installDeps, ["auto", "never"] as const, config.installDeps);
	if (pi.getFlag("sandbox-auto-remove")) config.autoRemove = true;
	const passEnv = parseList(pi.getFlag("sandbox-env"));
	if (passEnv) config.passEnv = passEnv;

	config.passEnv = uniq(config.passEnv);
	return config;
}

function text(content: string): TextContent[] {
	return [{ type: "text", text: content }];
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function resolveToolPath(cwd: string, inputPath: string): string {
	const clean = stripAtPrefix(inputPath.trim());
	if (!clean) return cwd;
	return path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd, clean);
}

function globToRegExp(pattern: string): RegExp {
	let out = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		const next = pattern[i + 1];
		if (char === "*" && next === "*") {
			const after = pattern[i + 2];
			if (after === "/") {
				out += "(?:.*/)?";
				i += 2;
			} else {
				out += ".*";
				i++;
			}
		} else if (char === "*") {
			out += "[^/]*";
		} else if (char === "?") {
			out += "[^/]";
		} else if ("\\^$+?.()|{}[]".includes(char)) {
			out += `\\${char}`;
		} else {
			out += char;
		}
	}
	out += "$";
	return new RegExp(out);
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	const normalizedPath = toPosix(relativePath).replace(/^\.\//, "");
	if (normalizedPattern.includes("/")) {
		return globToRegExp(normalizedPattern).test(normalizedPath) || globToRegExp(`**/${normalizedPattern}`).test(normalizedPath);
	}
	return globToRegExp(normalizedPattern).test(path.posix.basename(normalizedPath));
}

function safeName(value: string, fallback = "x"): string {
	const safe = value
		.replace(/[^A-Za-z0-9_.-]+/g, "-")
		.replace(/\.\.+/g, ".")
		.replace(/\.lock$/i, "")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 64);
	return safe || fallback;
}

function safeRefPath(value: string): string {
	const parts = value
		.split(/\/+/)
		.filter(Boolean)
		.map((part) => safeName(part, "x"));
	return parts.length > 0 ? parts.join("/") : "x";
}

function shortSessionKey(sessionId: string): string {
	const key = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
	return key || randomBytes(4).toString("hex");
}

function tarEnv(): NodeJS.ProcessEnv {
	return { ...process.env, COPYFILE_DISABLE: "1" };
}

function getCustomEntryData(entry: unknown, customType: string): unknown | undefined {
	const candidate = entry as { type?: string; customType?: string; data?: unknown };
	return candidate.type === "custom" && candidate.customType === customType ? candidate.data : undefined;
}

async function run(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		const kill = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		};

		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.timeoutMs && options.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, options.timeoutMs);
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			options.onData?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			if (!options.streamStdoutOnly) options.onData?.(chunk);
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => {
			finish(() => {
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error("timeout"));
				else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
			});
		});

		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
	});
}

async function runChecked(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	const result = await run(command, args, options);
	if (result.code !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `${command} ${args.join(" ")} exited with ${result.code}`);
	}
	return result;
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
}

const INTERNAL_GIT_PREFIX = [
	"--no-pager",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"diff.external=",
	"-c",
	"maintenance.auto=false",
	"-c",
	"gc.auto=0",
];

async function runGit(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	return run("git", [...INTERNAL_GIT_PREFIX, ...args], { ...options, env: sanitizedGitEnv() });
}

async function runGitChecked(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	const result = await runGit(args, options);
	if (result.code !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `git ${args.join(" ")} exited with ${result.code}`);
	}
	return result;
}

async function commandOk(command: string, args: string[]): Promise<boolean> {
	try {
		const result = await run(command, args, { timeoutMs: 10_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

class ContainerSandbox {
	private config: SandboxConfig = DEFAULT_CONFIG;
	private enabled = true;
	private cwd = process.cwd();
	private containerName: string | undefined;
	private starting: Promise<void> | undefined;
	private depsInstalled = false;
	private started = false;
	private reusedContainer = false;
	private gitRefState: GitRefState | undefined;
	private pendingRebase: PendingRebase | undefined;
	private preflightError: string | undefined;
	private checkpointTail: Promise<unknown> = Promise.resolve();

	constructor(private readonly pi: ExtensionAPI) {}

	isEnabled() {
		return this.enabled;
	}

	hasPendingRebase() {
		return this.pendingRebase !== undefined;
	}

	getName() {
		return this.containerName;
	}

	getConfig() {
		return this.config;
	}

	getGitRefState() {
		return this.gitRefState;
	}

	restoreGitRefState(ctx: ExtensionContext) {
		this.gitRefState = undefined;
		this.pendingRebase = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const state = getCustomEntryData(entry, "container-sandbox.git-ref-state") as GitRefState | undefined;
			if (
				!this.config.sandboxName.trim() &&
				state?.sandboxRef.startsWith(`${GIT_REF_NAMESPACE}/`) &&
				state.containerName
			) {
				this.gitRefState = state;
			}
			const rebase = getCustomEntryData(entry, "container-sandbox.rebase-state") as
				| { active?: boolean; pending?: PendingRebase }
				| undefined;
			if (rebase?.active && rebase.pending) this.pendingRebase = rebase.pending;
			else if (rebase?.active === false) this.pendingRebase = undefined;
		}
	}

	configure(ctx: ExtensionContext) {
		this.cwd = ctx.cwd;
		this.config = loadConfig(ctx.cwd, ctx.isProjectTrusted(), this.pi);
		this.enabled = !this.pi.getFlag("no-sandbox");
	}

	private async runtimeExec(args: string[], options: ExecOptions = {}) {
		return run(this.config.runtime, args, options);
	}

	private async runtimeExecChecked(args: string[], options: ExecOptions = {}) {
		return runChecked(this.config.runtime, args, options);
	}

	private envArgs(): string[] {
		const args: string[] = [];
		for (const [key, value] of Object.entries(PACKAGE_CACHE_ENV)) args.push("-e", `${key}=${value}`);
		for (const key of this.config.passEnv) {
			const value = process.env[key];
			if (value !== undefined) args.push("-e", `${key}=${value}`);
		}
		return args;
	}

	private async ensurePackageCacheVolume() {
		if ((await this.runtimeExec(["volume", "inspect", PACKAGE_CACHE_VOLUME], { timeoutMs: 10_000 })).code === 0) return;
		const created = await this.runtimeExec(["volume", "create", PACKAGE_CACHE_VOLUME], { timeoutMs: 60_000 });
		if (created.code !== 0 && (await this.runtimeExec(["volume", "inspect", PACKAGE_CACHE_VOLUME], { timeoutMs: 10_000 })).code !== 0) {
			throw new Error(created.stderr.toString().trim() || `Could not create package cache volume ${PACKAGE_CACHE_VOLUME}`);
		}
	}

	private async initializePackageCacheDirectories() {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		await this.runtimeExecChecked([
			"exec",
			"-u",
			"root",
			this.containerName,
			"sh",
			"-c",
			`mkdir -p ${PACKAGE_CACHE_ROOT}/npm ${PACKAGE_CACHE_ROOT}/pnpm ${PACKAGE_CACHE_ROOT}/bun ${PACKAGE_CACHE_ROOT}/pip ${PACKAGE_CACHE_ROOT}/uv && chmod 0777 ${PACKAGE_CACHE_ROOT} ${PACKAGE_CACHE_ROOT}/npm ${PACKAGE_CACHE_ROOT}/pnpm ${PACKAGE_CACHE_ROOT}/bun ${PACKAGE_CACHE_ROOT}/pip ${PACKAGE_CACHE_ROOT}/uv`,
		], { timeoutMs: 30_000 });
	}

	private async gitRepoRoot(): Promise<string | undefined> {
		const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: this.cwd, timeoutMs: 10_000 });
		return result.code === 0 ? result.stdout.toString().trim() : undefined;
	}

	private async gitHead(): Promise<string | undefined> {
		const result = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: this.cwd, timeoutMs: 10_000 });
		return result.code === 0 ? result.stdout.toString().trim() : undefined;
	}

	private async gitBranchName(baseCommit: string): Promise<string> {
		const result = await runGit(["branch", "--show-current"], { cwd: this.cwd, timeoutMs: 10_000 });
		const branch = result.stdout.toString().trim();
		if (result.code === 0 && branch) return branch;
		return `detached-${baseCommit.slice(0, 12)}`;
	}

	private hostUntrackedArgs(repoRoot: string, directoryMode = false): string[] {
		const args = ["ls-files", "--others", "--exclude-standard"];
		if (existsSync(path.join(repoRoot, ".pi-sandboxignore"))) args.push("--exclude-from=.pi-sandboxignore");
		if (directoryMode) args.push("--directory", "--no-empty-directory");
		args.push("-z");
		return args;
	}

	private async sandboxTrackedFiles(state: GitRefState): Promise<Set<string>> {
		if (!this.containerName) return new Set();
		const result = await this.runtimeExecChecked(["exec", "-w", state.repoRoot, this.containerName, "git", "ls-files", "-z"], {
			timeoutMs: 30_000,
		});
		return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
	}

	private async writeHostUntrackedList(repoRoot: string, destination: string, trackedInSandbox: Set<string>): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const output = createWriteStream(destination);
			const child = spawn("git", [...INTERNAL_GIT_PREFIX, ...this.hostUntrackedArgs(repoRoot)], {
				cwd: repoRoot,
				env: sanitizedGitEnv(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let remainder = Buffer.alloc(0);
			let stderr = "";
			let count = 0;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				output.destroy();
				reject(error);
			};
			const writeEntries = (chunk: Buffer) => {
				const combined = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
				const accepted: Buffer[] = [];
				let start = 0;
				for (let end = combined.indexOf(0, start); end >= 0; end = combined.indexOf(0, start)) {
					const entry = combined.subarray(start, end);
					start = end + 1;
					const relativePath = entry.toString("utf8");
					if (relativePath && !path.isAbsolute(relativePath) && !relativePath.startsWith("..") && !trackedInSandbox.has(relativePath)) {
						accepted.push(entry, Buffer.from([0]));
						count++;
					}
				}
				remainder = combined.subarray(start);
				if (accepted.length > 0 && !output.write(Buffer.concat(accepted))) {
					child.stdout.pause();
					output.once("drain", () => child.stdout.resume());
				}
			};
			child.stdout.on("data", writeEntries);
			child.stderr.on("data", (data) => (stderr += data.toString()));
			child.on("error", fail);
			output.on("error", fail);
			child.on("close", (code) => {
				if (settled) return;
				if (code !== 0) return fail(new Error(stderr.trim() || `git ls-files exited with ${code}`));
				if (remainder.length > 0) return fail(new Error("git ls-files returned an unterminated path"));
				output.end();
			});
			output.on("finish", () => {
				if (settled) return;
				settled = true;
				resolve(count);
			});
		});
	}

	private async copyListedHostFilesToContainer(listPath: string, repoRoot: string) {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		await new Promise<void>((resolve, reject) => {
			const source = spawn("tar", ["cf", "-", "-C", repoRoot, "--null", "-T", listPath], {
				stdio: ["ignore", "pipe", "pipe"],
				env: tarEnv(),
			});
			const dest = spawn(this.config.runtime, ["exec", "-i", "-u", "root", this.containerName!, "tar", "xf", "-", "-C", repoRoot], {
				stdio: ["pipe", "ignore", "pipe"],
			});
			let err = "";
			let sourceCode: number | null | undefined;
			let destCode: number | null | undefined;
			const done = () => {
				if (sourceCode === undefined || destCode === undefined) return;
				if (sourceCode !== 0) reject(new Error(err.trim() || `tar exited with ${sourceCode}`));
				else if (destCode !== 0) reject(new Error(err.trim() || `container tar exited with ${destCode}`));
				else resolve();
			};
			source.stderr.on("data", (data) => (err += data.toString()));
			dest.stderr.on("data", (data) => (err += data.toString()));
			source.on("error", reject);
			dest.on("error", reject);
			source.on("close", (code) => { sourceCode = code; done(); });
			dest.on("close", (code) => { destCode = code; done(); });
			source.stdout.pipe(dest.stdin);
		});
	}

	private async applyGitRefUntrackedFiles(state: GitRefState) {
		if (this.config.hostUntrackedFiles === "ignore") return;
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const trackedInSandbox = await this.sandboxTrackedFiles(state).catch(() => new Set<string>());
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-untracked-"));
		const listPath = path.join(temp, "host-untracked.zlist");
		try {
			const count = await this.writeHostUntrackedList(state.repoRoot, listPath, trackedInSandbox);
			if (count > 0) await this.copyListedHostFilesToContainer(listPath, state.repoRoot);
			await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "mkdir", "-p", path.posix.join(toPosix(state.repoRoot), ".git/info")]);
			await this.runtimeExecChecked([
				"cp",
				listPath,
				`${this.containerName}:${path.posix.join(toPosix(state.repoRoot), ".git/info/pi-sandbox-host-untracked")}`,
			], { timeoutMs: 30_000 });

			const compact = await runGitChecked(this.hostUntrackedArgs(state.repoRoot, true), { cwd: state.repoRoot, timeoutMs: 30_000 });
			const patterns = compact.stdout.toString("utf8").split("\0").filter((value) => value && !value.includes("\n"));
			const excludeText = [
				"# BEGIN pi sandbox host untracked files",
				...patterns.map((relativePath) => `/${toPosix(relativePath)}`),
				"# END pi sandbox host untracked files",
				"",
			].join("\n");
			await this.runtimeExecChecked([
				"exec", "-i", "-u", "root", "-w", state.repoRoot, this.containerName, "sh", "-c",
				"mkdir -p .git/info; touch .git/info/exclude; awk '/^# BEGIN pi sandbox host untracked files$/{skip=1;next} /^# END pi sandbox host untracked files$/{skip=0;next} !skip{print}' .git/info/exclude > .git/info/exclude.pi-tmp; cat >> .git/info/exclude.pi-tmp; mv .git/info/exclude.pi-tmp .git/info/exclude",
			], { input: excludeText, timeoutMs: 30_000 });
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}

	private async ensureGitRefState(ctx?: ExtensionContext): Promise<GitRefState> {
		if (this.gitRefState) return this.gitRefState;
		const sessionId = ctx?.sessionManager.getSessionId() ?? randomBytes(8).toString("hex");
		const configuredSandboxName = this.config.sandboxName.trim();
		const defaultSessionKey = shortSessionKey(sessionId);
		const refSuffix = configuredSandboxName ? safeRefPath(configuredSandboxName) : defaultSessionKey;
		const sessionKey = configuredSandboxName ? safeName(refSuffix.replace(/\//g, "-"), defaultSessionKey) : defaultSessionKey;
		const repoRoot = await this.gitRepoRoot();
		if (!repoRoot) throw new Error("current directory is not inside a git repository");
		const baseCommit = await this.gitHead();
		if (!baseCommit) throw new Error("git repository has no commits yet (HEAD is unborn)");
		const baseBranch = await this.gitBranchName(baseCommit);
		const branchRefPath = safeRefPath(baseBranch);
		const sandboxRef = `${GIT_REF_NAMESPACE}/${branchRefPath}/${refSuffix}`;
		const repoName = safeName(path.basename(repoRoot), "repo");
		const branchName = safeName(baseBranch.replace(/\//g, "-"), "branch");
		const containerName = `pi-${repoName}-${branchName}-${sessionKey}`.slice(0, 120);
		const sandboxBranch = `pi-sandbox/${sessionKey}`;
		this.gitRefState = { sessionId, sessionKey, baseBranch, baseCommit, sandboxRef, containerName, sandboxBranch, repoRoot, vcsBackend: "git" };
		this.pi.appendEntry("container-sandbox.git-ref-state", this.gitRefState);
		await this.ensureHostSandboxRef(this.gitRefState);
		return this.gitRefState;
	}

	private async ensureHostSandboxRef(state: GitRefState) {
		const exists = (await runGit(["show-ref", "--verify", "--quiet", state.sandboxRef], { cwd: this.cwd, timeoutMs: 10_000 })).code === 0;
		if (!exists) await runGitChecked(["update-ref", state.sandboxRef, state.baseCommit], { cwd: this.cwd, timeoutMs: 10_000 });
	}

	private async ensureCleanHostTrackedFiles() {
		const repoRoot = (await this.gitRepoRoot()) ?? this.cwd;
		const result = await runGitChecked(
			["status", "--porcelain", "--untracked-files=no", "--", "."],
			{ cwd: repoRoot, timeoutMs: 30_000 },
		);
		if (result.stdout.toString().trim()) {
			throw new Error("Cannot start sandbox. Commit or stash tracked changes before starting");
		}
	}

	async preflight(ctx: ExtensionContext) {
		this.preflightError = undefined;
		if (!this.isEnabled()) return;
		try {
			const repoRoot = await this.gitRepoRoot();
			if (!repoRoot) throw new Error("current directory is not inside a git repository");
			const head = await this.gitHead();
			if (!head) throw new Error("git repository has no commits yet (HEAD is unborn)");
			await this.ensureCleanHostTrackedFiles();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.preflightError = message;
			this.gitRefState = undefined;
			ctx.ui.notify(`Sandbox unavailable: ${message}`, "error");
		}
	}

	getPreflightError() {
		return this.preflightError;
	}

	private async ensureRuntime() {
		if (!(await commandOk(this.config.runtime, ["--version"]))) {
			throw new Error(`Container runtime not available: ${this.config.runtime}`);
		}
	}

	private async containerExists(name: string): Promise<boolean> {
		return (await this.runtimeExec(["inspect", name], { timeoutMs: 10_000 })).code === 0;
	}

	private async containerHasGitRepo(repoRoot: string): Promise<boolean> {
		if (!this.containerName) return false;
		return (await this.runtimeExec(["exec", "-w", repoRoot, this.containerName, "git", "rev-parse", "--is-inside-work-tree"], { timeoutMs: 10_000 })).code === 0;
	}

	private localCloneSourceUrl(repoRoot: string): string {
		return pathToFileURL(repoRoot).href;
	}

	private gitDepthArgs(): string[] {
		return this.config.gitCloneDepth > 0 ? [`--depth=${this.config.gitCloneDepth}`] : [];
	}

	private async prepareGitRefWorkspace(ctx?: ExtensionContext) {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const state = await this.ensureGitRefState(ctx);
		const identity = (await this.runtimeExecChecked(["exec", this.containerName, "sh", "-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""])).stdout
			.toString()
			.trim();
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "mkdir", "-p", state.repoRoot, "/tmp/pi-home"]);
		if (await this.containerHasGitRepo(state.repoRoot)) {
			await this.applyGitRefUntrackedFiles(state);
			await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "chown", "-R", identity || "0:0", state.repoRoot, "/tmp/pi-home"]);
			await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "chmod", "u+rwx", state.repoRoot, "/tmp/pi-home"]);
			return;
		}

		await this.ensureCleanHostTrackedFiles();
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "rm", "-rf", state.repoRoot]);
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "mkdir", "-p", state.repoRoot, "/tmp/pi-home"]);
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-gitref-"));
		try {
			const cloneDir = path.join(temp, "repo");
			const sourceUrl = this.localCloneSourceUrl(state.repoRoot);
			const sandboxRefCommit = (await runGitChecked(["rev-parse", "--verify", state.sandboxRef], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
				.toString()
				.trim();
			await runGitChecked(["clone", "--no-tags", "--template=", ...this.gitDepthArgs(), sourceUrl, cloneDir], {
				timeoutMs: 10 * 60 * 1000,
			});
			const hasSandboxRefCommit =
				(await runGit(["cat-file", "-e", `${sandboxRefCommit}^{commit}`], { cwd: cloneDir, timeoutMs: 10_000 })).code === 0;
			if (!hasSandboxRefCommit) {
				await runGitChecked(
					["fetch", "--no-tags", ...this.gitDepthArgs(), sourceUrl, `${state.sandboxRef}:refs/remotes/pi-sandbox/resume`],
					{
						cwd: cloneDir,
						timeoutMs: 5 * 60 * 1000,
					},
				);
			}
			await runGitChecked(["switch", "-C", state.sandboxBranch, sandboxRefCommit], { cwd: cloneDir, timeoutMs: 60_000 });
			await runGit(["remote", "remove", "origin"], { cwd: cloneDir, timeoutMs: 10_000 }).catch(() => undefined);
			// Future note: this is the seam where the sandbox backend can switch to jj.
			// A colocated jj repo would run `jj git init --colocate` here, then each
			// turn would describe/export changes before the host fetches Git commits.
			await this.copyDirectoryToContainer(cloneDir, state.repoRoot);
			await this.applyGitRefUntrackedFiles(state);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "chown", "-R", identity || "0:0", state.repoRoot, "/tmp/pi-home"]);
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "chmod", "u+rwx", state.repoRoot, "/tmp/pi-home"]);
	}

	private async copyDirectoryToContainer(sourceDir: string, targetDir: string) {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		await new Promise<void>((resolve, reject) => {
			const source = spawn("tar", ["cf", "-", "-C", sourceDir, "."], { stdio: ["ignore", "pipe", "pipe"], env: tarEnv() });
			const dest = spawn(this.config.runtime, ["exec", "-i", "-u", "root", this.containerName!, "tar", "xf", "-", "-C", targetDir], {
				stdio: ["pipe", "ignore", "pipe"],
			});
			let err = "";
			let sourceCode: number | null | undefined;
			let destCode: number | null | undefined;
			const done = () => {
				if (sourceCode === undefined || destCode === undefined) return;
				if (sourceCode !== 0) reject(new Error(err.trim() || `tar exited with ${sourceCode}`));
				else if (destCode !== 0) reject(new Error(err.trim() || `container tar exited with ${destCode}`));
				else resolve();
			};
			source.stderr.on("data", (d) => (err += d.toString()));
			dest.stderr.on("data", (d) => (err += d.toString()));
			source.on("error", reject);
			dest.on("error", reject);
			source.on("close", (code) => {
				sourceCode = code;
				done();
			});
			dest.on("close", (code) => {
				destCode = code;
				done();
			});
			source.stdout.pipe(dest.stdin);
		});
	}

	private async createContainer(ctx?: ExtensionContext) {
		await this.ensureRuntime();
		await this.ensurePackageCacheVolume();

		const state = await this.ensureGitRefState(ctx);
		const targetName = state.containerName || `pi-sandbox-${process.pid}-${randomBytes(4).toString("hex")}`;
		this.containerName = targetName;
		this.reusedContainer = false;
		this.depsInstalled = false;

		if (await this.containerExists(targetName)) {
			this.reusedContainer = true;
			await this.runtimeExecChecked(["start", targetName]);
			await this.initializePackageCacheDirectories();
			await this.prepareGitRefWorkspace(ctx);
			this.started = true;
			ctx?.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `sandbox: ${targetName} (reused)`));
			ctx?.ui.notify(`Reusing container sandbox: ${targetName}`, "info");
			return;
		}

		await this.runtimeExecChecked([
			"create",
			"--name",
			targetName,
			"-e",
			"HOME=/tmp/pi-home",
			"-e",
			"CI=1",
			...Object.entries(PACKAGE_CACHE_ENV).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
			"-v",
			`${PACKAGE_CACHE_VOLUME}:${PACKAGE_CACHE_ROOT}`,
			this.config.image,
			"sleep",
			"infinity",
		]);
		await this.runtimeExecChecked(["start", targetName]);
		await this.initializePackageCacheDirectories();
		await this.prepareGitRefWorkspace(ctx);
		this.started = true;
		ctx?.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `sandbox: ${targetName}`));
		ctx?.ui.notify(`Container sandbox ready: ${targetName}`, "info");
	}

	async ensure(ctx?: ExtensionContext) {
		if (!this.isEnabled()) return;
		if (this.started) return;
		if (!this.starting) {
			this.starting = (async () => {
				await this.createContainer(ctx);
				if (this.config.installDeps !== "never" && (!this.reusedContainer || this.config.installDepsOnReuse)) {
					await this.installDependencies(ctx);
				}
			})().finally(() => {
				this.starting = undefined;
			});
		}
		await this.starting;
	}

	private async installDependencies(ctx?: ExtensionContext) {
		if (this.depsInstalled || !this.containerName) return;
		this.depsInstalled = true;
		ctx?.ui.notify("Sandbox dependency bootstrap started", "info");
		const script = `set -e
if [ -f package-lock.json ]; then
  npm ci
elif [ -f pnpm-lock.yaml ]; then
  corepack enable && pnpm install --frozen-lockfile
elif [ -f bun.lock ] || [ -f bun.lockb ]; then
  bun install --frozen-lockfile
elif [ -f yarn.lock ]; then
  corepack enable && yarn install --frozen-lockfile
elif [ -f package.json ]; then
  npm install
fi
if [ -f uv.lock ]; then
  uv sync --frozen
elif [ -f requirements.txt ]; then
  python3 -m pip install -r requirements.txt || python3 -m pip install --break-system-packages -r requirements.txt
fi
`;
		const result = await this.execShell(script, this.cwd, { timeout: 20 * 60, onData: () => {} });
		if (result.exitCode === 0) ctx?.ui.notify("Sandbox dependency bootstrap finished", "info");
		else ctx?.ui.notify(`Sandbox dependency bootstrap exited with ${result.exitCode}`, "warning");
	}

	async execShell(
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
	): Promise<{ exitCode: number | null }> {
		await this.ensure();
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const args = [
			"exec",
			"-i",
			"-w",
			cwd,
			...this.envArgs(),
			this.containerName,
			"bash",
			"-lc",
			command,
		];
		const result = await this.runtimeExec(args, {
			signal: options.signal,
			timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
			onData: options.onData,
		});
		return { exitCode: result.code };
	}

	async execChecked(args: string[], options: ExecOptions = {}) {
		await this.ensure();
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const execArgs = options.input === undefined ? ["exec", this.containerName] : ["exec", "-i", this.containerName];
		return this.runtimeExecChecked([...execArgs, ...args], options);
	}

	async execCode(args: string[], options: ExecOptions = {}) {
		await this.ensure();
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const execArgs = options.input === undefined ? ["exec", this.containerName] : ["exec", "-i", this.containerName];
		return this.runtimeExec([...execArgs, ...args], options);
	}

	private gitPathspec(paths?: string[]): string[] {
		return paths && paths.length > 0 ? paths : ["."];
	}

	private async unstageCopiedHostFiles(state: GitRefState, expectedParent: string) {
		const metadataPath = path.posix.join(toPosix(state.repoRoot), ".git/info/pi-sandbox-host-untracked");
		if ((await this.execCode(["test", "-s", metadataPath], { timeoutMs: 10_000 })).code !== 0) return;
		await this.containerGitChecked([
			"reset",
			"-q",
			expectedParent,
			`--pathspec-from-file=${metadataPath}`,
			"--pathspec-file-nul",
		], { timeoutMs: 60_000 });
	}

	private autoCommitMessage(): string {
		const timestamp = new Date().toISOString().replace(/T/, " ").replace(/\.\d+Z$/, " UTC");
		return this.withCommitCoAuthor(`${FALLBACK_COMMIT_PREFIX}: ${timestamp}`);
	}

	private withCommitCoAuthor(message: string): string {
		const cleaned = message.trim();
		const coAuthor = this.config.gitCommitCoAuthor.trim();
		if (!coAuthor || /^Co-authored-by:/im.test(cleaned)) return cleaned;
		return `${cleaned}\n\nCo-authored-by: ${coAuthor}`;
	}

	private sanitizeCommitMessage(message: string): string {
		let cleaned = message
			.replace(/\r/g, "")
			.replace(/\0/g, "")
			.trim();
		cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/\n?```$/, "").trim();
		cleaned = cleaned.replace(/^commit message:\s*/i, "").trim();
		cleaned = cleaned.replace(/^['"]+|['"]+$/g, "").trim();
		let lines = cleaned.split("\n").map((line) => line.trimEnd());
		while (lines.length > 0 && !lines[0].trim()) lines.shift();
		while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
		if (lines.length === 0) return this.autoCommitMessage();
		lines[0] = lines[0].replace(/^[-*]\s+/, "").trim();
		if (lines[0].length > 100) lines[0] = lines[0].slice(0, 97).trimEnd() + "...";
		cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
		return this.withCommitCoAuthor(cleaned || this.autoCommitMessage());
	}

	private async stagedDiffForCommitMessage(pathspec: string[], expectedParent: string): Promise<string> {
		const [nameStatus, stat, diff] = await Promise.all([
			this.containerGitChecked(["diff", "--cached", "--name-status", expectedParent, "--", ...pathspec], { timeoutMs: 60_000 }),
			this.containerGitChecked(["diff", "--cached", "--stat", expectedParent, "--", ...pathspec], { timeoutMs: 60_000 }),
			this.containerGitChecked(["diff", "--cached", "--no-ext-diff", "--unified=3", expectedParent, "--", ...pathspec], { timeoutMs: 120_000 }),
		]);
		const raw = [
			"Changed files:",
			nameStatus.stdout.toString().trim() || "(none)",
			"",
			"Diff stat:",
			stat.stdout.toString().trim() || "(none)",
			"",
			"Diff:",
			diff.stdout.toString().trim() || "(no textual diff)",
		].join("\n");
		const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: this.config.gitCommitAiMaxDiffBytes });
		return truncation.truncated ? `${truncation.content}\n\n[Diff truncated at ${formatSize(this.config.gitCommitAiMaxDiffBytes)}]` : truncation.content;
	}

	private async generateCommitMessage(ctx: ExtensionContext | undefined, pathspec: string[], expectedParent: string): Promise<string | undefined> {
		if (!ctx?.model) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) throw new Error(auth.error);
		const diffText = await this.stagedDiffForCommitMessage(pathspec, expectedParent);
		const coAuthor = this.config.gitCommitCoAuthor.trim();
		const trailerRule = coAuthor ? `- End with exactly this trailer line: Co-authored-by: ${coAuthor}` : "- Do not include co-author trailers.";
		const stream = streamSimple(
			ctx.model,
			{
				systemPrompt: [
					"You write high-quality Git commit messages for code changes.",
					"Return only the commit message text. Do not use Markdown fences or explanations.",
					"Use this shape:",
					"<type>: <brief description>",
					"",
					"A short body with useful details, if helpful.",
					"",
					coAuthor ? `Co-authored-by: ${coAuthor}` : "",
					"",
					"Rules:",
					"- First line must be a conventional commit summary, e.g. fix: handle sandbox permissions.",
					"- Choose an accurate type such as fix, feat, docs, refactor, test, chore, build, ci, perf, or style.",
					"- Keep the first line concise, ideally 72 characters or less.",
					"- Mention the user-visible intent of the change, not implementation noise.",
					trailerRule,
				].filter(Boolean).join("\n"),
				messages: [
					{
						role: "user",
						content: `Generate a Git commit message for this staged diff.\n\n${diffText}`,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				timeoutMs: 60_000,
				maxRetries: 1,
			},
		);
		const assistant = await stream.result();
		const content = assistant.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return content ? this.sanitizeCommitMessage(content) : undefined;
	}

	private async containerGit(args: string[], options: ExecOptions = {}) {
		await this.ensure();
		if (!this.containerName) throw new Error("Sandbox container is not running");
		return this.runtimeExec(["exec", "-w", this.cwd, this.containerName, "git", ...args], options);
	}

	private async containerGitChecked(args: string[], options: ExecOptions = {}) {
		const result = await this.containerGit(args, options);
		if (result.code !== 0) {
			const stderr = result.stderr.toString().trim();
			throw new Error(stderr || `container git ${args.join(" ")} exited with ${result.code}`);
		}
		return result;
	}

	private async hostSandboxHead(state: GitRefState): Promise<string> {
		await this.ensureHostSandboxRef(state);
		return (await runGitChecked(["rev-parse", "--verify", `${state.sandboxRef}^{commit}`], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
			.toString()
			.trim();
	}

	private async importSandboxHeadToHost(state: GitRefState, expectedParent: string): Promise<{ imported: boolean; commitHash: string }> {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const sandboxHead = (await this.containerGitChecked(["rev-parse", "--verify", "HEAD^{commit}"], { timeoutMs: 10_000 })).stdout
			.toString()
			.trim();
		if (sandboxHead === expectedParent) return { imported: false, commitHash: sandboxHead.slice(0, 12) };

		const nonce = randomBytes(16).toString("hex");
		const bundlePath = `/tmp/pi-sandbox-${state.sessionKey}-${nonce}.bundle`;
		const importRef = `refs/pi-sandbox-import/${state.sessionKey}/${nonce}`;
		await this.containerGitChecked(["bundle", "create", bundlePath, "HEAD", `^${expectedParent}`], { timeoutMs: 5 * 60 * 1000 });
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-bundle-"));
		const hostBundle = path.join(temp, "sandbox.bundle");
		let importedHead: string | undefined;
		try {
			await this.runtimeExecChecked(["cp", `${this.containerName}:${bundlePath}`, hostBundle], { timeoutMs: 5 * 60 * 1000 });
			await runGitChecked(["fetch", "--no-write-fetch-head", hostBundle, `+HEAD:${importRef}`], {
				cwd: state.repoRoot,
				timeoutMs: 5 * 60 * 1000,
			});
			importedHead = (await runGitChecked(["rev-parse", "--verify", `${importRef}^{commit}`], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
				.toString()
				.trim();
			if (importedHead !== sandboxHead) throw new Error("Imported checkpoint does not match the sandbox HEAD");

			await runGitChecked(["fsck", "--strict", "--no-reflogs", importedHead], { cwd: state.repoRoot, timeoutMs: 5 * 60 * 1000 });
			const importedParent = (await runGitChecked(["rev-parse", "--verify", `${importedHead}^`], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
				.toString()
				.trim();
			if (importedParent !== expectedParent) {
				throw new Error(`Refusing non-linear sandbox checkpoint: expected parent ${expectedParent}, got ${importedParent}`);
			}
			const commitCount = (await runGitChecked(["rev-list", "--count", `${expectedParent}..${importedHead}`], {
				cwd: state.repoRoot,
				timeoutMs: 30_000,
			})).stdout.toString().trim();
			if (commitCount !== "1") throw new Error(`Refusing sandbox checkpoint containing ${commitCount} commits; expected exactly 1`);

			// Compare-and-swap prevents concurrent sessions sharing a ref from
			// silently overwriting one another.
			await runGitChecked(["update-ref", state.sandboxRef, importedHead, expectedParent], { cwd: state.repoRoot, timeoutMs: 30_000 });
		} finally {
			await runGit(["update-ref", "-d", importRef], { cwd: state.repoRoot, timeoutMs: 30_000 }).catch(() => undefined);
			await rm(temp, { recursive: true, force: true });
			await this.runtimeExec(["exec", this.containerName, "rm", "-f", bundlePath]).catch(() => undefined);
		}
		return { imported: true, commitHash: sandboxHead.slice(0, 12) };
	}

	private async checkpointGitRefUnlocked(message?: string, ctx?: ExtensionContext, paths?: string[]): Promise<GitRefCheckpointResult> {
		if (!this.isEnabled()) throw new Error("Sandbox is disabled by --no-sandbox");
		if (this.pendingRebase) throw new Error("Sandbox rebase is pending; complete or abort it before checkpointing");
		await this.ensure(ctx);
		const state = await this.ensureGitRefState(ctx);
		const expectedParent = await this.hostSandboxHead(state);
		const pathspec = this.gitPathspec(paths);
		let committed = false;
		let commitMessage = message?.trim();

		// Rebuild the checkpoint from the index and the authoritative host
		// parent. This deliberately ignores any commits or history rewrites the
		// agent may have created with unrestricted Git commands in the container.
		await this.containerGitChecked(["add", "-A", "--", ...pathspec], { timeoutMs: 60_000 });
		await this.unstageCopiedHostFiles(state, expectedParent);
		const hasStaged = (await this.containerGit(["diff", "--cached", "--quiet", "--exit-code", expectedParent, "--", ...pathspec], { timeoutMs: 60_000 })).code !== 0;
		if (hasStaged) {
			if (!commitMessage) {
				try {
					commitMessage = await this.generateCommitMessage(ctx, pathspec, expectedParent);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					ctx?.ui.notify(`AI commit message generation failed; using fallback: ${reason}`, "warning");
				}
			}
			commitMessage = this.sanitizeCommitMessage(commitMessage || this.autoCommitMessage());
			const tree = (await this.containerGitChecked(["write-tree"], { timeoutMs: 60_000 })).stdout.toString().trim();
			const commit = (await this.containerGitChecked(
				[
					"-c",
					"user.name=pi sandbox",
					"-c",
					"user.email=pi-sandbox@localhost",
					"-c",
					"commit.gpgsign=false",
					"commit-tree",
					tree,
					"-p",
					expectedParent,
					"-F",
					"-",
				],
				{ input: commitMessage, timeoutMs: 120_000 },
			)).stdout.toString().trim();
			await this.containerGitChecked(["update-ref", "HEAD", commit], { timeoutMs: 30_000 });
			committed = true;
		} else {
			// Discard container-only empty commits or rewritten history. There is
			// no tree change to import for this checkpoint.
			await this.containerGitChecked(["update-ref", "HEAD", expectedParent], { timeoutMs: 30_000 });
		}
		const imported = await this.importSandboxHeadToHost(state, expectedParent);
		return {
			committed,
			imported: imported.imported,
			message: `${committed ? "Committed" : "No new commit"}; ${imported.imported ? "imported" : "ref already current"} ${state.sandboxRef} @ ${imported.commitHash}`,
			commitHash: imported.commitHash,
			sandboxRef: state.sandboxRef,
		};
	}

	async checkpointGitRef(message?: string, ctx?: ExtensionContext, paths?: string[]): Promise<GitRefCheckpointResult> {
		const operation = this.checkpointTail.then(() => this.checkpointGitRefUnlocked(message, ctx, paths));
		this.checkpointTail = operation.catch(() => undefined);
		return operation;
	}

	private setPendingRebase(pending: PendingRebase | undefined) {
		this.pendingRebase = pending;
		this.pi.appendEntry("container-sandbox.rebase-state", pending ? { active: true, pending } : { active: false });
	}

	private async containerRebaseInProgress(): Promise<boolean> {
		const result = await this.execCode([
			"sh",
			"-c",
			'cd "$1" && { test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"; }',
			"sh",
			this.cwd,
		], { timeoutMs: 10_000 });
		return result.code === 0;
	}

	private async rebaseConflictFiles(): Promise<string[]> {
		const result = await this.containerGit(["diff", "--name-only", "--diff-filter=U"], { timeoutMs: 30_000 });
		return result.stdout.toString().split("\n").map((value) => value.trim()).filter(Boolean);
	}

	private async containerTrackedStatus(): Promise<string> {
		return (await this.containerGitChecked(["status", "--porcelain", "--untracked-files=no"], { timeoutMs: 30_000 })).stdout
			.toString()
			.trim();
	}

	private async transferHostBaseToContainer(state: GitRefState, baseRef: string, newBase: string, containerBaseRef: string) {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-base-"));
		const hostBundle = path.join(temp, "base.bundle");
		const containerBundle = `/tmp/pi-sandbox-base-${state.sessionKey}-${randomBytes(8).toString("hex")}.bundle`;
		try {
			await runGitChecked(["bundle", "create", hostBundle, baseRef], { cwd: state.repoRoot, timeoutMs: 5 * 60 * 1000 });
			await this.runtimeExecChecked(["cp", hostBundle, `${this.containerName}:${containerBundle}`], { timeoutMs: 5 * 60 * 1000 });
			await this.containerGitChecked(["fetch", "--no-tags", containerBundle, `+${baseRef}:${containerBaseRef}`], {
				timeoutMs: 5 * 60 * 1000,
			});
			await this.containerGitChecked(["cat-file", "-e", `${newBase}^{commit}`], { timeoutMs: 30_000 });
		} finally {
			await rm(temp, { recursive: true, force: true });
			await this.runtimeExec(["exec", this.containerName, "rm", "-f", containerBundle]).catch(() => undefined);
		}
	}

	private async completeRebaseState(state: GitRefState, pending: PendingRebase) {
		state.baseCommit = pending.newBase;
		this.pi.appendEntry("container-sandbox.git-ref-state", state);
		await this.containerGit(["update-ref", "-d", pending.containerBaseRef]).catch(() => undefined);
		this.setPendingRebase(undefined);
	}

	async rebaseHost(ctx?: ExtensionContext): Promise<RebaseResult> {
		await this.ensure(ctx);
		if (this.pendingRebase) return this.rebaseStatus();

		// Capture all current work before selecting the old sandbox tip.
		await this.checkpointGitRef(undefined, ctx);
		const state = await this.ensureGitRefState(ctx);
		const baseRef = `refs/heads/${state.baseBranch}`;
		const baseExists = (await runGit(["show-ref", "--verify", "--quiet", baseRef], { cwd: state.repoRoot, timeoutMs: 10_000 })).code === 0;
		if (!baseExists) throw new Error(`Cannot rebase sandbox: host base branch does not exist: ${baseRef}`);

		const oldSandboxTip = await this.hostSandboxHead(state);
		const newBase = (await runGitChecked(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
			.toString()
			.trim();
		const recordedBaseOnSandbox = (await runGit(["merge-base", "--is-ancestor", state.baseCommit, oldSandboxTip], {
			cwd: state.repoRoot,
			timeoutMs: 30_000,
		})).code === 0;
		const recordedBaseOnHost = (await runGit(["merge-base", "--is-ancestor", state.baseCommit, newBase], {
			cwd: state.repoRoot,
			timeoutMs: 30_000,
		})).code === 0;
		if (recordedBaseOnSandbox && !recordedBaseOnHost) {
			throw new Error("Cannot automatically rebase after a non-fast-forward update of the host base branch");
		}
		let oldBase = state.baseCommit;
		if (!recordedBaseOnSandbox) {
			// A stable --sandbox-name can be resumed in a new Pi session without
			// the original session metadata. Recover its base from graph ancestry.
			oldBase = (await runGitChecked(["merge-base", oldSandboxTip, newBase], { cwd: state.repoRoot, timeoutMs: 30_000 })).stdout
				.toString()
				.trim();
		}
		if (!oldBase) throw new Error("Cannot determine a common base for the sandbox and host branch");
		if (newBase === oldBase) return { completed: true, conflicted: false, message: `Sandbox is already based on ${state.baseBranch} @ ${newBase.slice(0, 12)}` };
		const expectedCommitCount = Number((await runGitChecked(["rev-list", "--count", `${oldBase}..${oldSandboxTip}`], {
			cwd: state.repoRoot,
			timeoutMs: 30_000,
		})).stdout.toString().trim());
		if (!Number.isSafeInteger(expectedCommitCount) || expectedCommitCount < 0) throw new Error("Could not determine sandbox commit count");

		const containerBaseRef = `refs/pi-sandbox-base/${state.sessionKey}/${newBase.slice(0, 16)}`;
		await this.transferHostBaseToContainer(state, baseRef, newBase, containerBaseRef);
		await this.containerGitChecked(["switch", "-C", state.sandboxBranch, oldSandboxTip], { timeoutMs: 60_000 });

		const pending: PendingRebase = {
			oldBase,
			newBase,
			oldSandboxTip,
			expectedCommitCount,
			containerBaseRef,
			startedAt: new Date().toISOString(),
		};
		this.setPendingRebase(pending);
		ctx?.ui.setStatus("sandbox-rebase", ctx.ui.theme.fg("warning", `rebase: ${state.baseBranch}`));

		if (expectedCommitCount === 0) {
			await this.containerGitChecked(["reset", "--hard", newBase], { timeoutMs: 60_000 });
			return this.finalizePendingRebase(ctx);
		}

		const result = await this.containerGit(
			[
				"-c", "core.hooksPath=/dev/null",
				"-c", "commit.gpgsign=false",
				"-c", "core.editor=true",
				"-c", "sequence.editor=true",
				"-c", "rerere.enabled=true",
				"rebase",
				"--reapply-cherry-picks",
				"--empty=keep",
				"--onto", newBase,
				oldBase,
			],
			{ timeoutMs: 20 * 60 * 1000 },
		);
		if (result.code === 0) return this.finalizePendingRebase(ctx);
		if (await this.containerRebaseInProgress()) {
			const conflictFiles = await this.rebaseConflictFiles();
			return {
				completed: false,
				conflicted: true,
				message: `Rebase paused with ${conflictFiles.length} conflicted file(s). The agent will resolve them inside the container.`,
				conflictFiles,
			};
		}

		await this.abortRebase(ctx);
		throw new Error(result.stderr.toString().trim() || result.stdout.toString().trim() || "Container rebase failed");
	}

	async finalizePendingRebase(ctx?: ExtensionContext): Promise<RebaseResult> {
		const pending = this.pendingRebase;
		if (!pending) return { completed: true, conflicted: false, message: "No sandbox rebase is pending" };
		await this.ensure(ctx);
		if (await this.containerRebaseInProgress()) {
			const conflictFiles = await this.rebaseConflictFiles();
			return { completed: false, conflicted: true, message: "Sandbox rebase still has unresolved conflicts", conflictFiles };
		}
		const trackedStatus = await this.containerTrackedStatus();
		if (trackedStatus) {
			return { completed: false, conflicted: false, message: `Rebase completed but tracked changes remain; refusing host import:\n${trackedStatus}` };
		}

		const state = await this.ensureGitRefState(ctx);
		const sandboxHead = (await this.containerGitChecked(["rev-parse", "--verify", "HEAD^{commit}"], { timeoutMs: 10_000 })).stdout
			.toString()
			.trim();
		if ((await this.containerGit(["merge-base", "--is-ancestor", pending.newBase, sandboxHead], { timeoutMs: 30_000 })).code !== 0) {
			throw new Error("Rebased sandbox tip does not descend from the new host base");
		}
		const containerCount = (await this.containerGitChecked(["rev-list", "--count", `${pending.newBase}..${sandboxHead}`], { timeoutMs: 30_000 })).stdout
			.toString()
			.trim();
		if (containerCount !== String(pending.expectedCommitCount)) {
			throw new Error(`Rebased commit count changed: expected ${pending.expectedCommitCount}, got ${containerCount}`);
		}

		if (pending.expectedCommitCount === 0) {
			await runGitChecked(["update-ref", state.sandboxRef, pending.newBase, pending.oldSandboxTip], { cwd: state.repoRoot, timeoutMs: 30_000 });
			await this.completeRebaseState(state, pending);
			ctx?.ui.setStatus("sandbox-rebase", undefined);
			return { completed: true, conflicted: false, message: `Rebased ${state.sandboxRef} onto ${state.baseBranch} @ ${pending.newBase.slice(0, 12)}` };
		}

		const nonce = randomBytes(16).toString("hex");
		const bundlePath = `/tmp/pi-sandbox-rebase-${state.sessionKey}-${nonce}.bundle`;
		const importRef = `refs/pi-sandbox-import/${state.sessionKey}/rebase-${nonce}`;
		await this.containerGitChecked(["bundle", "create", bundlePath, "HEAD", `^${pending.newBase}`], { timeoutMs: 5 * 60 * 1000 });
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-rebase-"));
		const hostBundle = path.join(temp, "rebase.bundle");
		let importedHead: string | undefined;
		try {
			await this.runtimeExecChecked(["cp", `${this.containerName}:${bundlePath}`, hostBundle], { timeoutMs: 5 * 60 * 1000 });
			await runGitChecked(["fetch", "--no-write-fetch-head", hostBundle, `+HEAD:${importRef}`], { cwd: state.repoRoot, timeoutMs: 5 * 60 * 1000 });
			importedHead = (await runGitChecked(["rev-parse", "--verify", `${importRef}^{commit}`], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
				.toString()
				.trim();
			if (importedHead !== sandboxHead) throw new Error("Imported rebased tip does not match the container tip");
			await runGitChecked(["fsck", "--strict", "--no-reflogs", importedHead], { cwd: state.repoRoot, timeoutMs: 5 * 60 * 1000 });
			if ((await runGit(["merge-base", "--is-ancestor", pending.newBase, importedHead], { cwd: state.repoRoot, timeoutMs: 30_000 })).code !== 0) {
				throw new Error("Imported rebased history does not descend from the new base");
			}
			const importedCount = (await runGitChecked(["rev-list", "--count", `${pending.newBase}..${importedHead}`], { cwd: state.repoRoot, timeoutMs: 30_000 })).stdout
				.toString()
				.trim();
			if (importedCount !== String(pending.expectedCommitCount)) throw new Error(`Imported rebase has ${importedCount} commits; expected ${pending.expectedCommitCount}`);
			const mergeCount = (await runGitChecked(["rev-list", "--count", "--merges", `${pending.newBase}..${importedHead}`], { cwd: state.repoRoot, timeoutMs: 30_000 })).stdout
				.toString()
				.trim();
			if (mergeCount !== "0") throw new Error("Imported rebased history contains unexpected merge commits");
			await runGitChecked(["update-ref", state.sandboxRef, importedHead, pending.oldSandboxTip], { cwd: state.repoRoot, timeoutMs: 30_000 });
		} finally {
			await runGit(["update-ref", "-d", importRef], { cwd: state.repoRoot, timeoutMs: 30_000 }).catch(() => undefined);
			await rm(temp, { recursive: true, force: true });
			if (this.containerName) await this.runtimeExec(["exec", this.containerName, "rm", "-f", bundlePath]).catch(() => undefined);
		}

		await this.completeRebaseState(state, pending);
		ctx?.ui.setStatus("sandbox-rebase", undefined);
		return { completed: true, conflicted: false, message: `Rebased ${pending.expectedCommitCount} commit(s) onto ${state.baseBranch} @ ${pending.newBase.slice(0, 12)}` };
	}

	async rebaseStatus(): Promise<RebaseResult> {
		const pending = this.pendingRebase;
		if (!pending) return { completed: true, conflicted: false, message: "No sandbox rebase is pending" };
		await this.ensure();
		const conflicted = await this.containerRebaseInProgress();
		const conflictFiles = conflicted ? await this.rebaseConflictFiles() : [];
		return {
			completed: false,
			conflicted,
			message: [
				`Rebase started: ${pending.startedAt}`,
				`Old base: ${pending.oldBase}`,
				`New base: ${pending.newBase}`,
				`Original sandbox tip: ${pending.oldSandboxTip}`,
				`Expected commits: ${pending.expectedCommitCount}`,
				`Conflicts: ${conflictFiles.length}`,
			].join("\n"),
			conflictFiles,
		};
	}

	async abortRebase(ctx?: ExtensionContext): Promise<string> {
		const pending = this.pendingRebase;
		if (!pending) return "No sandbox rebase is pending";
		await this.ensure(ctx);
		if (await this.containerRebaseInProgress()) {
			await this.containerGit(["-c", "core.hooksPath=/dev/null", "rebase", "--abort"], { timeoutMs: 120_000 }).catch(() => undefined);
		}
		await this.containerGitChecked(["reset", "--hard", pending.oldSandboxTip], { timeoutMs: 120_000 });
		await this.containerGit(["update-ref", "-d", pending.containerBaseRef]).catch(() => undefined);
		this.setPendingRebase(undefined);
		ctx?.ui.setStatus("sandbox-rebase", undefined);
		return `Aborted sandbox rebase; restored ${pending.oldSandboxTip.slice(0, 12)}`;
	}

	async autoCheckpointSandboxChanges(ctx?: ExtensionContext) {
		if (!this.isEnabled() || this.pendingRebase) return;
		const result = await this.checkpointGitRef(undefined, ctx);
		if (result.committed || result.imported) ctx?.ui.notify(result.message, "info");
	}


	async checkpoint(ctx?: ExtensionContext) {
		return this.checkpointGitRef(undefined, ctx);
	}

	async shutdown(ctx?: ExtensionContext) {
		const containerToCleanup = this.containerName;
		try {
			// Do not auto-checkpoint unless the sandbox was actually started.
			// checkpointGitRef() calls ensure(), and on a resume/session
			// switch that would create a throwaway container for the session being
			// left, producing two containers for one visible resume.
			if (this.started && this.containerName) await this.autoCheckpointSandboxChanges(ctx);
		} finally {
			if (containerToCleanup) {
				if (this.config.autoRemove) {
					await this.runtimeExec(["rm", "-f", containerToCleanup]).catch(() => undefined);
				} else {
					// Preserve the container filesystem for reuse, but do not leave old
					// sessions consuming resources after resume/fork/new/quit.
					await this.runtimeExec(["stop", containerToCleanup]).catch(() => undefined);
				}
			}
			ctx?.ui.setStatus("sandbox", undefined);
			this.containerName = undefined;
			this.started = false;
			this.reusedContainer = false;
			this.depsInstalled = false;
		}
	}
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", { description: "Disable container sandbox tool backend", type: "boolean", default: false });
	pi.registerFlag("sandbox-runtime", { description: "Container runtime: container, docker, or podman", type: "string" });
	pi.registerFlag("sandbox-image", { description: "Container image for sandbox tools", type: "string" });
	pi.registerFlag("sandbox-name", { description: "Stable sandbox/ref name; container name is derived from repo, branch, and this name", type: "string" });
	pi.registerFlag("sandbox-git-clone-depth", { description: "Host local clone depth for new sandboxes: 1 shallow default, 0 full history", type: "string" });
	pi.registerFlag("sandbox-install-deps", { description: "Dependency bootstrap: auto or never", type: "string" });
	pi.registerFlag("sandbox-auto-remove", { description: "Remove the sandbox container after shutdown instead of preserving it for reuse", type: "boolean", default: false });
	pi.registerFlag("sandbox-env", { description: "Comma-separated host env vars to pass into sandbox commands", type: "string" });

	const sandbox = new ContainerSandbox(pi);

	const localRead = createReadTool(process.cwd());
	const localWrite = createWriteTool(process.cwd());
	const localEdit = createEditTool(process.cwd());
	const localBash = createBashTool(process.cwd());
	const localLs = createLsTool(process.cwd());
	const localFind = createFindTool(process.cwd());
	const localGrep = createGrepTool(process.cwd());

	function readOps(ctx: ExtensionContext): ReadOperations {
		return {
			readFile: async (filePath) => (await sandbox.execChecked(["cat", "--", filePath])).stdout,
			access: async (filePath) => {
				await sandbox.execChecked(["test", "-r", filePath]);
			},
			detectImageMimeType: async (filePath) => {
				const ext = path.extname(filePath).toLowerCase();
				if (ext === ".png") return "image/png";
				if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
				if (ext === ".gif") return "image/gif";
				if (ext === ".webp") return "image/webp";
				if (ext === ".bmp") return "image/bmp";
				return null;
			},
		};
	}

	function writeOps(ctx: ExtensionContext): WriteOperations {
		return {
			writeFile: async (filePath, content) => {
				await sandbox.execChecked(["sh", "-c", "cat > \"$1\"", "sh", filePath], { input: content });
			},
			mkdir: async (dir) => {
				await sandbox.execChecked(["mkdir", "-p", dir]);
			},
		};
	}

	function editOps(ctx: ExtensionContext): EditOperations {
		const r = readOps(ctx);
		const w = writeOps(ctx);
		return {
			readFile: r.readFile,
			writeFile: w.writeFile,
			access: async (filePath) => {
				await sandbox.execChecked(["test", "-r", filePath]);
				await sandbox.execChecked(["test", "-w", filePath]);
			},
		};
	}

	function bashOps(ctx: ExtensionContext): BashOperations {
		return {
			exec: async (command, cwd, options) => sandbox.execShell(command, cwd, options),
		};
	}

	function lsOps(ctx: ExtensionContext): LsOperations {
		return {
			exists: async (filePath) => (await sandbox.execCode(["test", "-e", filePath])).code === 0,
			stat: async (filePath) => {
				const exists = (await sandbox.execCode(["test", "-e", filePath])).code === 0;
				if (!exists) throw new Error(`Path not found: ${filePath}`);
				const isDir = (await sandbox.execCode(["test", "-d", filePath])).code === 0;
				return { isDirectory: () => isDir };
			},
			readdir: async (dirPath) => {
				const out = await sandbox.execChecked(["sh", "-c", "ls -A1 -- \"$1\"", "sh", dirPath]);
				const value = out.stdout.toString();
				return value.trim() ? value.replace(/\r/g, "").split("\n") : [];
			},
		};
	}

	function findOps(ctx: ExtensionContext): FindOperations {
		return {
			exists: async (filePath) => (await sandbox.execCode(["test", "-e", filePath])).code === 0,
			glob: async (pattern, searchPath, options) => {
				const out = await sandbox.execChecked([
					"find",
					searchPath,
					"-path",
					"*/node_modules/*",
					"-prune",
					"-o",
					"-path",
					"*/.git/*",
					"-prune",
					"-o",
					"-type",
					"f",
					"-print",
				]);
				const results: string[] = [];
				for (const filePath of out.stdout.toString().split("\n")) {
					if (!filePath) continue;
					const relative = toPosix(path.relative(searchPath, filePath));
					if (!matchesToolGlob(relative, pattern)) continue;
					results.push(filePath);
					if (results.length >= options.limit) break;
				}
				return results;
			},
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		sandbox.configure(ctx);
		sandbox.restoreGitRefState(ctx);
		await sandbox.preflight(ctx);
		if (sandbox.isEnabled()) {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("muted", "sandbox: pending"));
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		sandbox.configure(ctx);
		if (!sandbox.isEnabled()) return;
		await sandbox.preflight(ctx);
		if (sandbox.getPreflightError()) throw new Error(`Sandbox unavailable: ${sandbox.getPreflightError()}`);
		let config = sandbox.getConfig();
		await sandbox.ensure(ctx);
		config = sandbox.getConfig();
		const gitRefState = sandbox.getGitRefState();
		const gitNote = ` After each agent turn, sandbox changes receive an AI-generated commit message and are imported through a validated, hard-coded checkpoint operation into host ref ${gitRefState?.sandboxRef ?? `${GIT_REF_NAMESPACE}/...`}; the checked-out host branch/worktree is not modified. Host-untracked files are handled with hostUntrackedFiles=${config.hostUntrackedFiles}.`;
		const rebaseNote = sandbox.hasPendingRebase()
			? " A sandbox rebase is currently pending. Normal automatic checkpoints are paused. Resolve any conflicts inside the container, stage them, run GIT_EDITOR=true git rebase --continue until complete, and leave the tracked worktree clean; never attempt to modify the host ref directly."
			: "";
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nTool execution note: file and shell tools run inside an isolated container copy of the current working directory. Use the normal tool paths and commands; dependency installs and tests run in that container." +
				gitNote +
				rebaseNote,
		};
	});

	pi.on("turn_end", async (_event, ctx) => {
		await sandbox.autoCheckpointSandboxChanges(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!sandbox.hasPendingRebase()) return;
		try {
			const result = await sandbox.finalizePendingRebase(ctx);
			if (result.completed) ctx.ui.notify(result.message, "info");
			else ctx.ui.notify(result.message, "warning");
		} catch (error) {
			ctx.ui.notify(`Sandbox rebase was not imported: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await sandbox.shutdown(ctx);
	});

	pi.on("user_bash", async (_event, ctx) => {
		sandbox.configure(ctx);
		if (!sandbox.isEnabled()) return;
		await sandbox.ensure(ctx);
		return { operations: bashOps(ctx) };
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createReadTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			return createReadTool(ctx.cwd, { operations: readOps(ctx) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			return createWriteTool(ctx.cwd, { operations: writeOps(ctx) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		renderCall(args, theme) {
			// Avoid the built-in edit preview renderer here: it reads the host file to
			// compute a preview. The actual edit execution and result diff still happen
			// in the container through editOps().
			const filePath = typeof args?.path === "string" ? args.path : "(invalid path)";
			const count = Array.isArray(args?.edits) ? args.edits.length : 0;
			const suffix = count > 0 ? ` (${count} replacement${count === 1 ? "" : "s"})` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("edit")) + " " + theme.fg("accent", filePath) + theme.fg("toolOutput", suffix),
				0,
				0,
			);
		},
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			const result = await createEditTool(ctx.cwd, { operations: editOps(ctx) }).execute(id, params, signal, onUpdate);
			return result;
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createBashTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			return createBashTool(ctx.cwd, { operations: bashOps(ctx) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createLsTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			return createLsTool(ctx.cwd, { operations: lsOps(ctx) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createFindTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			return createFindTool(ctx.cwd, { operations: findOps(ctx) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		parameters: grepSchema,
		async execute(id, params, signal, onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return createGrepTool(ctx.cwd).execute(id, params, signal, onUpdate);
			await sandbox.ensure(ctx);
			const searchPath = resolveToolPath(ctx.cwd, params.path || ".");
			const args = [
				"rg",
				"--line-number",
				"--with-filename",
				"--color=never",
				"--hidden",
				"--glob",
				"!.git/**",
				"--glob",
				"!node_modules/**",
			];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.literal) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", params.glob);
			if (params.context && params.context > 0) args.push("-C", String(params.context));
			args.push("--", params.pattern, searchPath);

			const result = await sandbox.execCode(args, { signal, timeoutMs: 120_000 });
			if (result.code === 1) return { content: text("No matches found"), details: undefined };
			if (result.code !== 0) throw new Error(result.stderr.toString().trim() || `ripgrep exited with ${result.code}`);

			const isDir = (await sandbox.execCode(["test", "-d", searchPath])).code === 0;
			const rootPrefix = isDir ? searchPath.replace(/\/$/, "") + "/" : path.dirname(searchPath).replace(/\/$/, "") + "/";
			let lines = result.stdout
				.toString()
				.replace(/\r/g, "")
				.split("\n")
				.filter(Boolean)
				.map((line) => (line.startsWith(rootPrefix) ? line.slice(rootPrefix.length) : line));

			const limit = Math.max(1, params.limit ?? 100);
			const details: Record<string, unknown> = {};
			const notices: string[] = [];
			if (lines.length > limit) {
				lines = lines.slice(0, limit);
				details.matchLimitReached = limit;
				notices.push(`${limit} lines limit reached`);
			}
			const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			if (truncation.truncated) {
				details.truncation = truncation;
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return { content: text(output), details: Object.keys(details).length ? details : undefined };
		},
	});

	pi.registerCommand("sandbox", {
		description: "Show or control the container sandbox (status|checkpoint|rebase-host|rebase-status|rebase-abort|stop)",
		handler: async (args, ctx) => {
			sandbox.configure(ctx);
			const command = args.trim();
			if (command === "checkpoint") {
				const result = await sandbox.checkpoint(ctx);
				ctx.ui.notify(result.message, "info");
				return;
			}
			if (command === "rebase-host") {
				const result = await sandbox.rebaseHost(ctx);
				ctx.ui.notify(result.message, result.conflicted ? "warning" : "info");
				if (result.conflicted) {
					const listed = result.conflictFiles?.length ? `\n\nConflicted files:\n${result.conflictFiles.map((file) => `- ${file}`).join("\n")}` : "";
					pi.sendUserMessage(
						"A sandbox rebase onto the latest host base branch is paused by conflicts. Resolve the conflicts entirely inside the container. " +
						"Inspect both sides and preserve the intent of the feature and upstream changes. Stage each resolved file with git add, then run " +
						"GIT_EDITOR=true git rebase --continue. Repeat until the rebase completes, run appropriate tests, and leave no tracked changes. " +
						"Do not use blanket ours/theirs resolution and do not abort the rebase." +
						listed,
					);
				}
				return;
			}
			if (command === "rebase-status") {
				const result = await sandbox.rebaseStatus();
				ctx.ui.notify(result.message, result.conflicted ? "warning" : "info");
				return;
			}
			if (command === "rebase-abort") {
				ctx.ui.notify(await sandbox.abortRebase(ctx), "info");
				return;
			}
			if (command === "stop") {
				await sandbox.shutdown(ctx);
				return;
			}
			const config = sandbox.getConfig();
			const gitRefState = sandbox.getGitRefState();
			ctx.ui.notify(
				[
					`Container sandbox: ${sandbox.isEnabled() ? "enabled" : "disabled by --no-sandbox"}`,
					`Runtime: ${config.runtime}`,
					`Image: ${config.image}`,
					`Workspace mode: git-ref`,
					`Git ref namespace: ${GIT_REF_NAMESPACE} (fixed)`,
					`Git clone depth: ${config.gitCloneDepth === 0 ? "full" : config.gitCloneDepth}`,
					`Host untracked files: ${config.hostUntrackedFiles}`,
					`Sandbox ref: ${gitRefState?.sandboxRef ?? "(not initialized)"}`,
					`Sandbox name: ${config.sandboxName || "(session id)"}`,
					`Active container: ${sandbox.getName() ?? "not started"}`,
					`Install deps on reuse: ${config.installDepsOnReuse}`,
					`Install deps: ${config.installDeps}`,
					`Auto-remove container: ${config.autoRemove}`,
					`Package cache volume: ${PACKAGE_CACHE_VOLUME} -> ${PACKAGE_CACHE_ROOT}`,
					`Host git tool: removed (no model-callable host commands)`,
					`Git auto-commit: enabled (fixed)`,
					`Rebase pending: ${sandbox.hasPendingRebase()}`,
					`Git commit message mode: AI with timestamp fallback (fixed)`,
					`Git commit co-author: ${config.gitCommitCoAuthor || "(none)"}`,
					`Fallback commit prefix: ${FALLBACK_COMMIT_PREFIX} (fixed)`,
					`Pass env: ${config.passEnv.length ? config.passEnv.join(", ") : "(none)"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
