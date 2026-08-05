/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

export interface CommandAllowlist {
	exact?: string[];
	prefixes?: string[];
}

const BUILT_IN_ALLOW_EXACT = new Set([
	"pwd",
	"ls",
	"git status",
	"git branch --show-current",
	"node --version",
	"node -v",
	"python --version",
	"python -V",
	"python3 --version",
	"python3 -V",
]);

const BUILT_IN_ALLOW_PREFIXES = [
	"cd",
	"echo",
	"for",
	"do",
	"done",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"in",
	"case",
	"esac",
	"rg",
	"grep",
	"find",
	"ls",
	"cat",
	"head",
	"tail",
	"sed -n",
	"awk",
	"jq",
	"fd",
	"xargs",
	"wc",
	"sort",
	"uniq",
	"diff",
	"file",
	"stat",
	"git status",
	"git log",
	"git diff",
	"git show",
	"git ls-tree",
	"git branch -a",
	"npm list",
	"npm ls",
	"npm view",
	"npm info",
	"npm outdated",
	"npm audit",
	"yarn list",
	"yarn info",
	"pnpm list",
	"pnpm view",
	"pnpm info",
];

/** Common commands with side effects — always rejected in Plan Mode with no approval path. */
const DESTRUCTIVE_COMMAND_PREFIXES = [
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"install",
	"curl",
	"wget",
	"ssh",
	"scp",
	"rsync",
	"docker",
	"kill",
	"pkill",
	"killall",
	"apt",
	"apt-get",
	"yum",
	"dnf",
	"brew",
	"snap",
	"pip install",
	"pip3 install",
	"pipx install",
	"uv pip install",
	"cargo install",
	"go install",
	"gem install",
	"npm install",
	"npm i ",
	"npm ci",
	"npm uninstall",
	"npm publish",
	"npm run",
	"npm start",
	"npm restart",
	"npm stop",
	"yarn add",
	"yarn install",
	"yarn remove",
	"yarn run",
	"pnpm add",
	"pnpm install",
	"pnpm remove",
	"pnpm run",
	"bun install",
	"bun add",
	"bun remove",
	"bun run",
	"npx",
	"bunx",
	"uvx",
	"git push",
	"git pull",
	"git merge",
	"git rebase",
	"git reset",
	"git checkout",
	"git switch",
	"git stash",
	"git cherry-pick",
	"git revert",
	"git commit",
	"git tag",
	"git clean",
	"git worktree",
	"git am",
	"git apply",
	"git bisect",
	"make",
	"cmake",
	"gradle",
	"mvn",
	"cargo",
	"go run",
	"go build",
	"python ",
	"python3 ",
	"node ",
	"node -e",
	"bun ",
	"ts-node",
	"tsx ",
	"jest",
	"vitest",
	"pytest",
	"mvn",
	"gradle",
	"terraform",
	"kubectl",
	"helm",
	"ansible",
];

export function isDestructiveCommand(command: string): boolean {
	const normalized = normalizeCommand(stripGitPathFlag(command));
	// Read-only inspection subcommands must remain available for explicit manual
	// allowlisting (e.g. `git stash list`), while mutating stash operations stay
	// destructive.
	if (/^git\s+stash\s+(?:list|show)(?:\s|$)/i.test(normalized)) return false;
	return DESTRUCTIVE_COMMAND_PREFIXES.some((prefix) => {
		return normalized === prefix || normalized.startsWith(`${prefix} `);
	});
}

// Fail closed on shell syntax and command forms that can execute arbitrary code.
const UNSAFE_SHELL_PATTERN = /(?:[<>`() ]?\$\(|[<>`()]|\b(?:eval|exec|source|bash|sh|zsh|fish|powershell|pwsh)\b|\b(?:system|getline)\s*\(|\b(?:-exec|--exec|-execdir|--checkpoint-action|--checkpoint)\b)/i;
const UNSAFE_EMBEDDED_EXECUTION_PATTERN = /\b(?:system|getline)\s*\(|\b(?:-exec|--exec|-execdir|--checkpoint-action|--checkpoint)\b/i;

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function stripHarmlessRedirection(command: string): string {
	let result = command.replace(/\s+2>>?\s*\/dev\/null\b/g, "");
	// Strip harmless display-only redirects that otherwise trigger UNSAFE_SHELL_PATTERN.
	result = result.replace(/\s+2>&1\b/g, "");
	result = result.replace(/\s+(?:1)?>&2\b/g, "");
	return result;
}

/**
 * Strip content inside single and double quotes to avoid
 * false positives from UNSAFE_SHELL_PATTERN (e.g. `grep "<style"`).
 */
function stripQuotedContent(command: string): string {
	return command.replace(/'[^']*'/g, "").replace(/"([^"\\]|\\.)*"/g, "");
}

function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let i = 0;

	while (i < command.length) {
		const ch = command[i];

		// Track quoting — content inside quotes is never a delimiter
		if (ch === "'") {
			// Single-quoted: no escaping inside, consume until closing '
			current += ch;
			i++;
			while (i < command.length && command[i] !== "'") {
				current += command[i];
				i++;
			}
			if (i < command.length) {
				current += command[i]; // closing quote
				i++;
			}
			continue;
		}

		if (ch === '"') {
			// Double-quoted: backslash-escaped quotes only
			current += ch;
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < command.length) {
					current += command[i] + command[i + 1];
					i += 2;
				} else {
					current += command[i];
					i++;
				}
			}
			if (i < command.length) {
				current += command[i]; // closing quote
				i++;
			}
			continue;
		}

		// Outside quotes — check for shell delimiters
		const two = command.slice(i, i + 2);

		if (two === "&&" || two === "||") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			i += 2;
			// consume leading whitespace after delimiter
			while (i < command.length && command[i] === " ") i++;
			continue;
		}

		if (ch === "|" || ch === ";") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			i++;
			while (i < command.length && command[i] === " ") i++;
			continue;
		}

		current += ch;
		i++;
	}

	if (current.trim()) segments.push(current.trim());
	return segments;
}

/** Strip `git -C <path>` prefix so git subcommands are recognized regardless of working directory. */
function stripGitPathFlag(command: string): string {
	return command.replace(/^git\s+-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+/, "git ");
}

function hasAllowedPrefix(command: string, prefix: string): boolean {
	return command === prefix || command.startsWith(`${prefix} `);
}

function isAllowedSegment(command: string, allowlist: CommandAllowlist): boolean {
	const matchTarget = stripGitPathFlag(command);
	if (BUILT_IN_ALLOW_EXACT.has(matchTarget) || allowlist.exact?.includes(matchTarget)) return true;

	return [...BUILT_IN_ALLOW_PREFIXES, ...(allowlist.prefixes ?? [])].some((prefix) =>
		hasAllowedPrefix(matchTarget, normalizeCommand(prefix)),
	);
}

export function isReadOnlyCommand(command: string, allowlist: CommandAllowlist = {}): boolean {
	const normalized = normalizeCommand(stripHarmlessRedirection(command));
	if (!normalized) return false;
	if (UNSAFE_SHELL_PATTERN.test(stripQuotedContent(normalized)) || UNSAFE_EMBEDDED_EXECUTION_PATTERN.test(normalized)) return false;

	const segments = splitCommandSegments(normalized);
	return segments.length > 0 && segments.every((segment) => isAllowedSegment(segment, allowlist));
}

export interface TodoItem {
	id: string;
	step: number;
	text: string;
	completed: boolean;
	status: "pending" | "in_progress" | "completed" | "blocked";
	message?: string;
	source?: "plan";
}
