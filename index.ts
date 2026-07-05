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
 *   --sandbox-install-deps auto|copy|never
 *   --sandbox-keep                        Keep container after shutdown
 *   --sandbox-env FOO,BAR                 Allowlist host env vars for tool commands
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TextContent } from "@earendil-works/pi-ai";
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

type GitRefUntrackedMode = "ignore" | "overlay" | "commit";
type InstallDepsMode = "auto" | "copy" | "never";
type MiseMode = "auto" | "never";

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

interface GitCommitResult {
	committed: boolean;
	message: string;
	commitHash?: string;
	sandboxRef?: string;
}

interface SandboxConfig {
	enabled: boolean;
	runtime: "container" | "docker" | "podman" | string;
	image: string;
	sandboxName: string;
	installDepsOnReuse: boolean;
	gitRefNamespace: string;
	gitRefRequireCleanWorktree: boolean;
	gitRefUntrackedMode: GitRefUntrackedMode;
	gitCloneDepth: number;
	autoBuildImage: boolean;
	gitCommitTool: boolean;
	gitAutoCommit: boolean;
	gitCommitMessagePrefix: string;
	gitCommitNoVerify: boolean;
	gitCommitNoGpgSign: boolean;
	gitHostTool: boolean;
	gitHostAllowedCommands: string[];
	installDeps: InstallDepsMode;
	installDepsCopyPaths: string[];
	mise: MiseMode;
	keep: boolean;
	passEnv: string[];
}

const DEFAULT_IMAGE = "pi-tool-sandbox:latest";
const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	runtime: "container",
	image: DEFAULT_IMAGE,
	sandboxName: "",
	installDepsOnReuse: false,
	gitRefNamespace: "refs/pi-sandbox",
	gitRefRequireCleanWorktree: true,
	gitRefUntrackedMode: "ignore",
	gitCloneDepth: 1,
	autoBuildImage: true,
	gitCommitTool: true,
	gitAutoCommit: true,
	gitCommitMessagePrefix: "pi sandbox",
	gitCommitNoVerify: true,
	gitCommitNoGpgSign: true,
	gitHostTool: true,
	gitHostAllowedCommands: ["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "describe"],
	installDeps: "never",
	installDepsCopyPaths: ["node_modules", ".venv", "venv"],
	mise: "auto",
	keep: false,
	passEnv: [],
};

interface ExecOptions {
	cwd?: string;
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
		installDepsCopyPaths: parseList(overrides.installDepsCopyPaths) ?? base.installDepsCopyPaths,
		gitHostAllowedCommands: parseList(overrides.gitHostAllowedCommands) ?? base.gitHostAllowedCommands,
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
	config.gitRefUntrackedMode = normalizeChoice(
		config.gitRefUntrackedMode,
		["ignore", "overlay", "commit"] as const,
		DEFAULT_CONFIG.gitRefUntrackedMode,
	);
	config.installDeps = normalizeChoice(config.installDeps, ["auto", "copy", "never"] as const, DEFAULT_CONFIG.installDeps);
	config.mise = normalizeChoice(config.mise, ["auto", "never"] as const, DEFAULT_CONFIG.mise);
	config.gitCloneDepth = normalizeNonNegativeInteger(config.gitCloneDepth, DEFAULT_CONFIG.gitCloneDepth);

	if (pi.getFlag("sandbox")) config.enabled = true;
	if (pi.getFlag("no-sandbox")) config.enabled = false;

	const runtime = pi.getFlag("sandbox-runtime") as string | undefined;
	if (runtime) config.runtime = runtime;
	const image = pi.getFlag("sandbox-image") as string | undefined;
	if (image) config.image = image;
	const sandboxName = pi.getFlag("sandbox-name") as string | undefined;
	if (sandboxName) config.sandboxName = sandboxName;
	if (pi.getFlag("sandbox-install-deps-on-reuse")) config.installDepsOnReuse = true;
	const gitCloneDepth = pi.getFlag("sandbox-git-clone-depth") as string | undefined;
	if (gitCloneDepth !== undefined) config.gitCloneDepth = normalizeNonNegativeInteger(gitCloneDepth, config.gitCloneDepth);
	const gitRefUntrackedMode = pi.getFlag("sandbox-git-ref-untracked") as string | undefined;
	if (gitRefUntrackedMode) {
		config.gitRefUntrackedMode = normalizeChoice(
			gitRefUntrackedMode,
			["ignore", "overlay", "commit"] as const,
			config.gitRefUntrackedMode,
		);
	}
	const installDeps = pi.getFlag("sandbox-install-deps") as string | undefined;
	if (installDeps) config.installDeps = normalizeChoice(installDeps, ["auto", "copy", "never"] as const, config.installDeps);
	const mise = pi.getFlag("sandbox-mise") as string | undefined;
	if (mise) config.mise = normalizeChoice(mise, ["auto", "never"] as const, config.mise);
	if (pi.getFlag("sandbox-keep")) config.keep = true;
	if (pi.getFlag("sandbox-git-auto-commit")) config.gitAutoCommit = true;
	if (pi.getFlag("sandbox-no-git-auto-commit")) config.gitAutoCommit = false;
	const gitCommitPrefix = pi.getFlag("sandbox-git-commit-prefix") as string | undefined;
	if (gitCommitPrefix) config.gitCommitMessagePrefix = gitCommitPrefix;
	const passEnv = parseList(pi.getFlag("sandbox-env"));
	if (passEnv) config.passEnv = passEnv;

	config.passEnv = uniq(config.passEnv);
	config.installDepsCopyPaths = uniq(config.installDepsCopyPaths);
	config.gitHostAllowedCommands = uniq(config.gitHostAllowedCommands);
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

function parseShellWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (quote === char) {
			quote = undefined;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (escaping) current += "\\";
	if (current) words.push(current);
	return words;
}

async function run(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
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

async function commandOk(command: string, args: string[]): Promise<boolean> {
	try {
		const result = await run(command, args, { timeoutMs: 10_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

function dockerfile(): string {
	return `FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
  && apt-get install -y --no-install-recommends \\
     bash ca-certificates git ripgrep fd-find findutils coreutils curl \\
     python3 python3-pip python3-venv build-essential procps tar \\
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \\
  && rm -rf /var/lib/apt/lists/*
WORKDIR /
CMD ["sleep", "infinity"]
`;
}

async function buildDefaultImage(runtime: string, image: string, ctx?: ExtensionContext): Promise<void> {
	if (await commandOk(runtime, ["image", "inspect", image])) return;
	if (image !== DEFAULT_IMAGE) {
		throw new Error(`Sandbox image not found: ${image}`);
	}
	ctx?.ui.notify(`Building sandbox image ${image} (first run only)...`, "info");
	const dir = await mkdtemp(path.join(tmpdir(), "pi-sandbox-image-"));
	try {
		await import("node:fs/promises").then((fs) => fs.writeFile(path.join(dir, "Dockerfile"), dockerfile(), "utf8"));
		await runChecked(runtime, ["build", "-t", image, dir], { timeoutMs: 20 * 60 * 1000 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

class ContainerSandbox {
	private config: SandboxConfig = DEFAULT_CONFIG;
	private cwd = process.cwd();
	private containerName: string | undefined;
	private starting: Promise<void> | undefined;
	private depsInstalled = false;
	private started = false;
	private reusedContainer = false;
	private gitRefState: GitRefState | undefined;
	private preflightError: string | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	isEnabled() {
		return this.config.enabled;
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
		// An explicit sandbox name is the source of truth for both the ref suffix
		// and derived container name. Do not let an older session entry override it.
		if (this.config.sandboxName.trim()) return;
		for (const entry of ctx.sessionManager.getBranch()) {
			const data = getCustomEntryData(entry, "container-sandbox.git-ref-state") as GitRefState | undefined;
			if (data?.sandboxRef && data?.containerName) this.gitRefState = data;
		}
	}

	configure(ctx: ExtensionContext) {
		this.cwd = ctx.cwd;
		this.config = loadConfig(ctx.cwd, ctx.isProjectTrusted(), this.pi);
	}

	private async runtimeExec(args: string[], options: ExecOptions = {}) {
		return run(this.config.runtime, args, options);
	}

	private async runtimeExecChecked(args: string[], options: ExecOptions = {}) {
		return runChecked(this.config.runtime, args, options);
	}

	private envArgs(): string[] {
		const args: string[] = [];
		for (const key of this.config.passEnv) {
			const value = process.env[key];
			if (value !== undefined) args.push("-e", `${key}=${value}`);
		}
		return args;
	}

	private async gitRepoRoot(): Promise<string | undefined> {
		const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, timeoutMs: 10_000 });
		return result.code === 0 ? result.stdout.toString().trim() : undefined;
	}

	private async gitHead(): Promise<string | undefined> {
		const result = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: this.cwd, timeoutMs: 10_000 });
		return result.code === 0 ? result.stdout.toString().trim() : undefined;
	}

	private async gitBranchName(baseCommit: string): Promise<string> {
		const result = await run("git", ["branch", "--show-current"], { cwd: this.cwd, timeoutMs: 10_000 });
		const branch = result.stdout.toString().trim();
		if (result.code === 0 && branch) return branch;
		return `detached-${baseCommit.slice(0, 12)}`;
	}

	private async hostUntrackedFiles(repoRoot: string): Promise<string[]> {
		const result = await runChecked("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd: repoRoot,
			timeoutMs: 30_000,
		});
		return result.stdout
			.toString("utf8")
			.split("\0")
			.map((value) => value.trim())
			.filter((value) => value && !path.isAbsolute(value) && !value.startsWith(".."));
	}

	private async sandboxTrackedFiles(state: GitRefState): Promise<Set<string>> {
		if (!this.containerName) return new Set();
		const result = await this.runtimeExecChecked(["exec", "-w", state.repoRoot, this.containerName, "git", "ls-files", "-z"], {
			timeoutMs: 30_000,
		});
		return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
	}

	private async applyGitRefUntrackedFiles(state: GitRefState) {
		if (this.config.gitRefUntrackedMode === "ignore") return;
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const untracked = await this.hostUntrackedFiles(state.repoRoot);
		if (untracked.length === 0) return;
		const trackedInSandbox = await this.sandboxTrackedFiles(state).catch(() => new Set<string>());
		const overlayPaths = untracked.filter((relativePath) => !trackedInSandbox.has(relativePath));
		if (overlayPaths.length === 0) return;

		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-untracked-"));
		try {
			for (const relativePath of overlayPaths) {
				const source = path.join(state.repoRoot, relativePath);
				const target = path.join(temp, relativePath);
				await mkdir(path.dirname(target), { recursive: true });
				await cp(source, target, { recursive: true, dereference: false, preserveTimestamps: true, force: true });
			}
			await this.copyDirectoryToContainer(temp, state.repoRoot);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}

		if (this.config.gitRefUntrackedMode === "overlay") {
			const excludeText =
				"\n# pi sandbox untracked overlay (copied from host, intentionally not committed)\n" +
				overlayPaths.map((relativePath) => `/${toPosix(relativePath)}`).join("\n") +
				"\n";
			// copyDirectoryToContainer untars as root, and a freshly seeded repo is
			// chowned only after untracked overlay is applied. Append as root here;
			// prepareGitRefWorkspace chowns the repo back to the container user.
			await this.runtimeExecChecked(["exec", "-i", "-u", "root", "-w", state.repoRoot, this.containerName, "sh", "-c", "mkdir -p .git/info && cat >> .git/info/exclude"], {
				input: excludeText,
				timeoutMs: 10_000,
			});
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
		const namespace = this.config.gitRefNamespace.replace(/\/+$/g, "") || "refs/pi-sandbox";
		const sandboxRef = `${namespace}/${branchRefPath}/${refSuffix}`;
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
		const exists = (await run("git", ["show-ref", "--verify", "--quiet", state.sandboxRef], { cwd: this.cwd, timeoutMs: 10_000 })).code === 0;
		if (!exists) await runChecked("git", ["update-ref", state.sandboxRef, state.baseCommit], { cwd: this.cwd, timeoutMs: 10_000 });
	}

	private async ensureCleanForGitRef() {
		if (!this.config.gitRefRequireCleanWorktree) return;
		const repoRoot = (await this.gitRepoRoot()) ?? this.cwd;
		const result = await runChecked(
			"git",
			["status", "--porcelain", "--untracked-files=no", "--", "."],
			{ cwd: repoRoot, timeoutMs: 30_000 },
		);
		const status = result.stdout.toString().trim();
		if (status) {
			throw new Error(
				`Sandbox git-ref mode requires no tracked host changes before starting. Untracked files are handled by gitRefUntrackedMode. Commit/stash tracked changes first:\n${status}`,
			);
		}
	}

	async preflight(ctx: ExtensionContext) {
		this.preflightError = undefined;
		if (!this.config.enabled) return;
		try {
			const repoRoot = await this.gitRepoRoot();
			if (!repoRoot) throw new Error("current directory is not inside a git repository");
			const head = await this.gitHead();
			if (!head) throw new Error("git repository has no commits yet (HEAD is unborn)");
			await this.ensureCleanForGitRef();
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

		await this.ensureCleanForGitRef();
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "rm", "-rf", state.repoRoot]);
		await this.runtimeExecChecked(["exec", "-u", "root", this.containerName, "mkdir", "-p", state.repoRoot, "/tmp/pi-home"]);
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-gitref-"));
		try {
			const cloneDir = path.join(temp, "repo");
			const sourceUrl = this.localCloneSourceUrl(state.repoRoot);
			const sandboxRefCommit = (await runChecked("git", ["rev-parse", "--verify", state.sandboxRef], { cwd: state.repoRoot, timeoutMs: 10_000 })).stdout
				.toString()
				.trim();
			await runChecked("git", ["clone", "--no-tags", ...this.gitDepthArgs(), sourceUrl, cloneDir], {
				timeoutMs: 10 * 60 * 1000,
			});
			const hasSandboxRefCommit =
				(await run("git", ["cat-file", "-e", `${sandboxRefCommit}^{commit}`], { cwd: cloneDir, timeoutMs: 10_000 })).code === 0;
			if (!hasSandboxRefCommit) {
				await runChecked(
					"git",
					["fetch", "--no-tags", ...this.gitDepthArgs(), sourceUrl, `${state.sandboxRef}:refs/remotes/pi-sandbox/resume`],
					{
						cwd: cloneDir,
						timeoutMs: 5 * 60 * 1000,
					},
				);
			}
			await runChecked("git", ["switch", "-C", state.sandboxBranch, sandboxRefCommit], { cwd: cloneDir, timeoutMs: 60_000 });
			await run("git", ["remote", "remove", "origin"], { cwd: cloneDir, timeoutMs: 10_000 }).catch(() => undefined);
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
		if (this.config.autoBuildImage) {
			await buildDefaultImage(this.config.runtime, this.config.image, ctx);
		}

		const state = await this.ensureGitRefState(ctx);
		const targetName = state.containerName || `pi-sandbox-${process.pid}-${randomBytes(4).toString("hex")}`;
		this.containerName = targetName;
		this.reusedContainer = false;
		this.depsInstalled = false;

		if (await this.containerExists(targetName)) {
			this.reusedContainer = true;
			await this.runtimeExecChecked(["start", targetName]);
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
			this.config.image,
			"sleep",
			"infinity",
		]);
		await this.runtimeExecChecked(["start", targetName]);
		await this.prepareGitRefWorkspace(ctx);
		this.started = true;
		ctx?.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `sandbox: ${targetName}`));
		ctx?.ui.notify(`Container sandbox ready: ${targetName}`, "info");
	}

	async ensure(ctx?: ExtensionContext) {
		if (!this.config.enabled) return;
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

	private async copyDependencyPaths(ctx?: ExtensionContext) {
		const state = await this.ensureGitRefState(ctx);
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-deps-"));
		let copied = 0;
		const copiedPaths: string[] = [];
		try {
			for (const relativePath of this.config.installDepsCopyPaths) {
				const cleaned = relativePath.trim();
				if (!cleaned || path.isAbsolute(cleaned) || cleaned.startsWith("..")) continue;
				const source = path.join(state.repoRoot, cleaned);
				if (!existsSync(source)) continue;
				const target = path.join(temp, cleaned);
				await mkdir(path.dirname(target), { recursive: true });
				await cp(source, target, { recursive: true, dereference: false, preserveTimestamps: true, force: true });
				copiedPaths.push(cleaned);
				copied++;
			}
			if (copied > 0) {
				await this.copyDirectoryToContainer(temp, state.repoRoot);
				const identity = (await this.runtimeExecChecked(["exec", this.containerName!, "sh", "-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""])).stdout
					.toString()
					.trim();
				const owner = identity || "0:0";
				// Tar archives include the source directory metadata. When copying a
				// temp dir into the workspace, that can reset the workspace root to
				// host uid/mode and make `ls .` fail for the container user.
				await this.runtimeExecChecked(["exec", "-u", "root", this.containerName!, "chown", owner, state.repoRoot]);
				await this.runtimeExecChecked(["exec", "-u", "root", this.containerName!, "chmod", "u+rwx", state.repoRoot]);
				await this.runtimeExecChecked([
					"exec",
					"-u",
					"root",
					this.containerName!,
					"chown",
					"-R",
					owner,
					...copiedPaths.map((relativePath) => path.posix.join(toPosix(state.repoRoot), toPosix(relativePath))),
				]);
			}
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
		ctx?.ui.notify(copied > 0 ? `Copied ${copied} dependency path(s) into sandbox` : "No configured dependency paths found on host to copy", "info");
	}

	private async installDependencies(ctx?: ExtensionContext) {
		if (this.depsInstalled || !this.containerName) return;
		this.depsInstalled = true;
		if (this.config.installDeps === "copy") {
			await this.copyDependencyPaths(ctx);
			return;
		}
		ctx?.ui.notify("Sandbox dependency bootstrap started", "info");
		const script = `set -e
if [ -f package-lock.json ]; then
  npm ci
elif [ -f pnpm-lock.yaml ]; then
  corepack enable && pnpm install --frozen-lockfile
elif [ -f yarn.lock ]; then
  corepack enable && yarn install --frozen-lockfile
elif [ -f package.json ]; then
  npm install
fi
if [ -f requirements.txt ]; then
  python3 -m pip install -r requirements.txt || python3 -m pip install --break-system-packages -r requirements.txt
fi
`;
		const result = await this.execShell(script, this.cwd, { timeout: 20 * 60, onData: () => {} });
		if (result.exitCode === 0) ctx?.ui.notify("Sandbox dependency bootstrap finished", "info");
		else ctx?.ui.notify(`Sandbox dependency bootstrap exited with ${result.exitCode}`, "warning");
	}

	private shellCommand(command: string): { env: string[]; command: string } {
		if (this.config.mise === "never") return { env: [], command };
		const encoded = Buffer.from(command, "utf8").toString("base64");
		return {
			env: [`PI_SANDBOX_COMMAND_B64=${encoded}`],
			command: `set -e
cmd=$(printf '%s' "$PI_SANDBOX_COMMAND_B64" | base64 -d)
has_mise_config=0
dir=$PWD
while :; do
  if [ -f "$dir/.mise.toml" ] || [ -f "$dir/mise.toml" ] || [ -f "$dir/.tool-versions" ]; then
    has_mise_config=1
    break
  fi
  [ "$dir" = "/" ] && break
  dir=$(dirname "$dir")
done
if [ "$has_mise_config" = "1" ] && command -v mise >/dev/null 2>&1; then
  exec mise exec -- bash -lc "$cmd"
fi
exec bash -lc "$cmd"`,
		};
	}

	async execShell(
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
	): Promise<{ exitCode: number | null }> {
		await this.ensure();
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const shell = this.shellCommand(command);
		const args = [
			"exec",
			"-i",
			"-w",
			cwd,
			...this.envArgs(),
			...shell.env.flatMap((value) => ["-e", value]),
			this.containerName,
			"bash",
			"-lc",
			shell.command,
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

	private resolveContainerPath(inputPath: string): string {
		const cleaned = inputPath.trim();
		if (!cleaned) return this.cwd;
		return path.posix.isAbsolute(cleaned) ? path.posix.normalize(cleaned) : path.posix.resolve(toPosix(this.cwd), toPosix(cleaned));
	}

	private resolveHostPath(inputPath: string): string {
		const cleaned = inputPath.trim();
		if (!cleaned) return this.cwd;
		return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(this.cwd, cleaned);
	}

	async copyOut(containerPath: string, hostPath: string | undefined, ctx?: ExtensionContext): Promise<string> {
		await this.ensure(ctx);
		if (!this.containerName) throw new Error("Sandbox container is not running");
		const source = this.resolveContainerPath(containerPath);
		const destination = this.resolveHostPath(hostPath || containerPath);
		await mkdir(path.dirname(destination), { recursive: true });
		await this.runtimeExecChecked(["cp", `${this.containerName}:${source}`, destination], { timeoutMs: 10 * 60 * 1000 });
		return `Copied ${this.containerName}:${source} to ${destination}`;
	}

	private gitPathspec(paths?: string[]): string[] {
		return paths && paths.length > 0 ? paths : ["."];
	}

	private autoCommitMessage(): string {
		const timestamp = new Date().toISOString().replace(/T/, " ").replace(/\.\d+Z$/, " UTC");
		return `${this.config.gitCommitMessagePrefix}: ${timestamp}`;
	}

	private validateHostGitArgs(args: string[]): string | undefined {
		if (args.length === 0) return "host_git requires at least one git argument, for example ['status', '--short'].";
		const command = args[0];
		if (!command || command.startsWith("-")) return "host_git requires the first argument to be a git subcommand, not a flag.";
		if (!this.config.gitHostAllowedCommands.includes(command)) {
			return `git ${command} is not allowed on the host. Allowed commands: ${this.config.gitHostAllowedCommands.join(", ")}`;
		}
		const blocked = args.find((arg) => {
			return (
				arg === "--output" ||
				arg.startsWith("--output=") ||
				arg === "--ext-diff" ||
				arg === "--textconv" ||
				arg === "-O" ||
				arg === "--open-files-in-pager"
			);
		});
		if (blocked) return `host_git blocked unsafe/read-write git option: ${blocked}`;
		return undefined;
	}

	async runHostGit(args: string[]): Promise<{ content: TextContent[]; details: Record<string, unknown> }> {
		if (!this.config.gitHostTool) {
			return { content: text("host_git is disabled by sandbox config."), details: { disabled: true } };
		}
		const validationError = this.validateHostGitArgs(args);
		if (validationError) return { content: text(validationError), details: { blocked: true } };

		const command = args[0];
		const rest = args.slice(1);
		const safeArgs = [
			"--no-pager",
			"-c",
			"core.pager=cat",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			command,
		];
		if (command === "diff" || command === "log" || command === "show") safeArgs.push("--no-ext-diff");
		safeArgs.push(...rest);

		const result = await run("git", safeArgs, {
			cwd: this.cwd,
			timeoutMs: 120_000,
		});
		const rawOutput = [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join("\n");
		const truncation = truncateHead(rawOutput || `(git exited with code ${result.code})`, { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;
		const details: Record<string, unknown> = { exitCode: result.code, args: safeArgs };
		if (truncation.truncated) {
			details.truncation = truncation;
			output += `\n\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)}]`;
		}
		return { content: text(output), details };
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

	private async importSandboxHeadToHost(state: GitRefState): Promise<{ imported: boolean; commitHash: string }> {
		if (!this.containerName) throw new Error("Sandbox container is not running");
		await this.ensureHostSandboxRef(state);
		const hostBase = (await runChecked("git", ["rev-parse", "--verify", state.sandboxRef], { cwd: this.cwd, timeoutMs: 10_000 })).stdout
			.toString()
			.trim();
		const sandboxHead = (await this.containerGitChecked(["rev-parse", "HEAD"], { timeoutMs: 10_000 })).stdout.toString().trim();
		if (sandboxHead === hostBase) return { imported: false, commitHash: sandboxHead.slice(0, 12) };

		const bundlePath = `/tmp/pi-sandbox-${state.sessionKey}.bundle`;
		await this.containerGitChecked(["bundle", "create", bundlePath, "HEAD", `^${hostBase}`], { timeoutMs: 5 * 60 * 1000 });
		const temp = await mkdtemp(path.join(tmpdir(), "pi-sandbox-bundle-"));
		const hostBundle = path.join(temp, "sandbox.bundle");
		try {
			await this.runtimeExecChecked(["cp", `${this.containerName}:${bundlePath}`, hostBundle], { timeoutMs: 5 * 60 * 1000 });
			await runChecked("git", ["fetch", hostBundle, `+HEAD:${state.sandboxRef}`], { cwd: this.cwd, timeoutMs: 5 * 60 * 1000 });
		} finally {
			await rm(temp, { recursive: true, force: true });
			await this.runtimeExec(["exec", this.containerName, "rm", "-f", bundlePath]).catch(() => undefined);
		}
		return { imported: true, commitHash: sandboxHead.slice(0, 12) };
	}

	async checkpointGitRef(message?: string, ctx?: ExtensionContext, paths?: string[]): Promise<GitRefCheckpointResult> {
		await this.ensure(ctx);
		const state = await this.ensureGitRefState(ctx);
		const pathspec = this.gitPathspec(paths);
		const status = (await this.containerGitChecked(["status", "--porcelain", "--untracked-files=all", "--", ...pathspec], { timeoutMs: 30_000 })).stdout
			.toString()
			.trim();
		let committed = false;
		let commitMessage = message?.trim() || this.autoCommitMessage();
		if (status) {
			await this.containerGitChecked(["add", "-A", "--", ...pathspec], { timeoutMs: 60_000 });
			const hasStaged = (await this.containerGit(["diff", "--cached", "--quiet", "--exit-code"], { timeoutMs: 60_000 })).code !== 0;
			if (hasStaged) {
				const commitArgs = [
					"-c",
					"user.name=pi sandbox",
					"-c",
					"user.email=pi-sandbox@localhost",
					"-c",
					"commit.gpgsign=false",
					"commit",
				];
				if (this.config.gitCommitNoVerify) commitArgs.push("--no-verify");
				if (this.config.gitCommitNoGpgSign) commitArgs.push("--no-gpg-sign");
				commitArgs.push("-m", commitMessage);
				await this.containerGitChecked(commitArgs, { timeoutMs: 120_000 });
				committed = true;
			}
		}
		const imported = await this.importSandboxHeadToHost(state);
		return {
			committed,
			imported: imported.imported,
			message: `${committed ? "Committed" : "No new commit"}; ${imported.imported ? "imported" : "ref already current"} ${state.sandboxRef} @ ${imported.commitHash}`,
			commitHash: imported.commitHash,
			sandboxRef: state.sandboxRef,
		};
	}

	async checkpointSandboxChanges(params: { message?: string; paths?: string[] }, ctx?: ExtensionContext): Promise<GitCommitResult> {
		const result = await this.checkpointGitRef(params.message, ctx, params.paths);
		return {
			committed: result.committed || result.imported,
			message: result.message,
			commitHash: result.commitHash,
			sandboxRef: result.sandboxRef,
		};
	}

	async autoCheckpointSandboxChanges(ctx?: ExtensionContext) {
		if (!this.config.gitAutoCommit) return;
		const result = await this.checkpointGitRef(this.autoCommitMessage(), ctx);
		if (result.committed || result.imported) ctx?.ui.notify(result.message, "info");
	}


	async checkpoint(ctx?: ExtensionContext) {
		await this.checkpointGitRef(this.autoCommitMessage(), ctx);
	}

	async shutdown(ctx?: ExtensionContext) {
		const containerToCleanup = this.containerName;
		try {
			// Do not auto-checkpoint unless the sandbox was actually started.
			// checkpointGitRef() calls ensure(), and on a resume/session
			// switch that would create a throwaway container for the session being
			// left, producing two containers for one visible resume.
			if (this.config.gitAutoCommit && this.started && this.containerName) await this.autoCheckpointSandboxChanges(ctx);
		} finally {
			if (containerToCleanup) {
				if (!this.config.keep && !this.reusedContainer) {
					await this.runtimeExec(["rm", "-f", containerToCleanup]).catch(() => undefined);
				} else {
					// Keep the container filesystem for reuse, but do not leave old
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

const gitCommitSchema = Type.Object({
	message: Type.String({ description: "Git commit message for the sandbox checkpoint" }),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Optional sandbox paths to stage. Defaults to the project." })),
});

const hostGitSchema = Type.Object({
	args: Type.Array(Type.String(), {
		description:
			"Arguments to pass to git on the host, excluding the leading 'git'. First argument must be an allowed read-only subcommand such as status, diff, log, show, rev-parse, ls-files, grep, or describe.",
	}),
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag("sandbox", { description: "Enable container sandbox tool backend", type: "boolean", default: false });
	pi.registerFlag("no-sandbox", { description: "Disable container sandbox tool backend", type: "boolean", default: false });
	pi.registerFlag("sandbox-runtime", { description: "Container runtime: container, docker, or podman", type: "string" });
	pi.registerFlag("sandbox-image", { description: "Container image for sandbox tools", type: "string" });
	pi.registerFlag("sandbox-name", { description: "Stable sandbox/ref name; container name is derived from repo, branch, and this name", type: "string" });
	pi.registerFlag("sandbox-install-deps-on-reuse", { description: "Run installDeps bootstrap even when reusing a container", type: "boolean", default: false });
	pi.registerFlag("sandbox-git-clone-depth", { description: "Host local clone depth for new sandboxes: 1 shallow default, 0 full history", type: "string" });
	pi.registerFlag("sandbox-git-ref-untracked", { description: "Untracked files in git-ref mode: ignore, overlay, or commit", type: "string" });
	pi.registerFlag("sandbox-install-deps", { description: "Dependency bootstrap: auto, copy, or never", type: "string" });
	pi.registerFlag("sandbox-mise", { description: "Apply .mise.toml/.tool-versions with mise exec: auto or never", type: "string" });
	pi.registerFlag("sandbox-keep", { description: "Keep sandbox container after shutdown", type: "boolean", default: false });
	pi.registerFlag("sandbox-git-auto-commit", { description: "Auto-checkpoint sandbox changes after each agent turn", type: "boolean", default: false });
	pi.registerFlag("sandbox-no-git-auto-commit", { description: "Disable automatic sandbox checkpoints", type: "boolean", default: false });
	pi.registerFlag("sandbox-git-commit-prefix", { description: "Prefix for automatic sandbox checkpoint messages", type: "string" });
	pi.registerFlag("sandbox-env", { description: "Comma-separated host env vars to pass into sandbox commands", type: "string" });

	const sandbox = new ContainerSandbox(pi);
	const sandboxOnlyTools = new Set(["host_git", "git_commit"]);

	function applySandboxToolActivation() {
		const config = sandbox.getConfig();
		let active = pi.getActiveTools();
		const before = active.length;
		active = active.filter((name) => {
			if (!sandboxOnlyTools.has(name)) return true;
			if (!config.enabled) return false;
			if (name === "host_git") return config.gitHostTool;
			if (name === "git_commit") return config.gitCommitTool;
			return true;
		});
		if (active.length !== before) pi.setActiveTools(active);
	}

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

	pi.registerTool({
		name: "host_git",
		label: "git (host)",
		description:
			"Run an allowlisted read-only git command on the host repository, including inspecting refs/pi-sandbox/* imported from sandbox sessions. This tool never stages, commits, resets, checks out, or pushes.",
		promptSnippet: "Inspect the host git repository and imported sandbox refs with allowlisted read-only commands",
		promptGuidelines: [
			"Use host_git for read-only inspection of host repository state and refs/pi-sandbox/* imported from sandbox sessions.",
			"host_git is only for read-only git inspection such as status, diff, log, show, rev-parse, ls-files, grep, and describe; use git_commit to checkpoint/import sandbox work and never push.",
		],
		parameters: hostGitSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return { content: text("host_git is disabled because sandbox is disabled."), details: { disabled: true } };
			return sandbox.runHostGit(params.args);
		},
	});

	pi.registerTool({
		name: "git_commit",
		label: "git checkpoint",
		description:
			"Checkpoint sandbox changes by committing inside the sandbox repo and importing the commit into refs/pi-sandbox/* on the host without modifying the checked-out host branch. It never pushes.",
		promptSnippet: "Checkpoint sandbox changes locally without pushing",
		promptGuidelines: [
			"Use git_commit only when the user explicitly asks for a local commit or when automatic sandbox commits are not sufficient; git_commit never pushes.",
			"Do not call git_commit in the same tool batch as file-changing tools; wait until file changes have finished so the host sync can include them.",
		],
		parameters: gitCommitSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			sandbox.configure(ctx);
			if (!sandbox.isEnabled()) return { content: text("git_commit is disabled because sandbox is disabled."), details: { disabled: true } };
			const result = await sandbox.checkpointSandboxChanges({ message: params.message, paths: params.paths }, ctx);
			const details = { commitHash: result.commitHash, sandboxRef: result.sandboxRef };
			return { content: text(result.message), details };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sandbox.configure(ctx);
		applySandboxToolActivation();
		sandbox.restoreGitRefState(ctx);
		await sandbox.preflight(ctx);
		if (sandbox.isEnabled()) {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("muted", "sandbox: pending"));
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		sandbox.configure(ctx);
		applySandboxToolActivation();
		if (!sandbox.isEnabled()) return;
		await sandbox.preflight(ctx);
		if (sandbox.getPreflightError()) throw new Error(`Sandbox unavailable: ${sandbox.getPreflightError()}`);
		let config = sandbox.getConfig();
		await sandbox.ensure(ctx);
		config = sandbox.getConfig();
		const gitRefState = sandbox.getGitRefState();
		const gitNote = ` After each agent turn, sandbox changes are committed inside the sandbox repo and imported into host ref ${gitRefState?.sandboxRef ?? `${config.gitRefNamespace}/...`}; the checked-out host branch/worktree is not modified. Untracked host files are handled with gitRefUntrackedMode=${config.gitRefUntrackedMode}.`;
		const hostGitNote = config.gitHostTool
			? " Use host_git for read-only inspection of the host repository and imported sandbox refs; use git_commit to checkpoint/import sandbox work. Never push."
			: "";
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nTool execution note: file and shell tools run inside an isolated container copy of the current working directory. Use the normal tool paths and commands; dependency installs and tests run in that container." +
				hostGitNote +
				gitNote,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		await sandbox.autoCheckpointSandboxChanges(ctx);
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
		description: "Show or control the container sandbox (status|checkpoint|copy-out|stop)",
		handler: async (args, ctx) => {
			sandbox.configure(ctx);
			const command = args.trim();
			if (command === "checkpoint") {
				await sandbox.checkpoint(ctx);
				return;
			}
			if (command.startsWith("copy-out ")) {
				const parts = parseShellWords(command.slice("copy-out ".length));
				if (parts.length < 1 || parts.length > 2) {
					ctx.ui.notify("Usage: /sandbox copy-out <container-path> [host-path]", "error");
					return;
				}
				const message = await sandbox.copyOut(parts[0], parts[1], ctx);
				ctx.ui.notify(message, "info");
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
					`Container sandbox: ${config.enabled ? "enabled" : "disabled"}`,
					`Runtime: ${config.runtime}`,
					`Image: ${config.image}`,
					`Workspace mode: git-ref`,
					`Git ref namespace: ${config.gitRefNamespace}`,
					`Git clone depth: ${config.gitCloneDepth === 0 ? "full" : config.gitCloneDepth}`,
					`Git ref untracked mode: ${config.gitRefUntrackedMode}`,
					`Sandbox ref: ${gitRefState?.sandboxRef ?? "(not initialized)"}`,
					`Sandbox name: ${config.sandboxName || "(session id)"}`,
					`Active container: ${sandbox.getName() ?? "not started"}`,
					`Install deps on reuse: ${config.installDepsOnReuse}`,
					`Install deps: ${config.installDeps}`,
					`Mise: ${config.mise}`,
					`Host git tool: ${config.gitHostTool}`,
					`Host git allowed commands: ${config.gitHostAllowedCommands.join(", ")}`,
					`Git commit tool: ${config.gitCommitTool}`,
					`Git auto-commit: ${config.gitAutoCommit}`,
					`Git commit prefix: ${config.gitCommitMessagePrefix}`,
					`Pass env: ${config.passEnv.length ? config.passEnv.join(", ") : "(none)"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
