import { describe, expect, it } from "vitest";
import { isReadOnlyCommand, isDestructiveCommand } from "../utils.js";

describe("isReadOnlyCommand", () => {
	it("allows git log", () => {
		expect(isReadOnlyCommand("git log --oneline -5")).toBe(true);
	});

	it("allows git status", () => {
		expect(isReadOnlyCommand("git status")).toBe(true);
	});

	it("allows git diff", () => {
		expect(isReadOnlyCommand("git diff HEAD~1")).toBe(true);
	});

	it("allows git show", () => {
		expect(isReadOnlyCommand("git show HEAD")).toBe(true);
	});

	it("allows git ls-tree", () => {
		expect(isReadOnlyCommand("git ls-tree -r --name-only origin/main")).toBe(true);
	});

	it("allows git branch -a", () => {
		expect(isReadOnlyCommand("git branch -a")).toBe(true);
	});

	it("allows git branch -a with merged filter", () => {
		expect(isReadOnlyCommand("git branch -a --merged main")).toBe(true);
	});

	it("allows git -C <path> log", () => {
		expect(isReadOnlyCommand("git -C /home/user/repo log --oneline -5")).toBe(true);
	});

	it("allows git -C <path> status", () => {
		expect(isReadOnlyCommand("git -C /home/user/repo status")).toBe(true);
	});

	it("allows git -C <path> diff", () => {
		expect(isReadOnlyCommand("git -C /home/user/repo diff HEAD~1")).toBe(true);
	});

	it("allows git -C <path> show", () => {
		expect(isReadOnlyCommand("git -C /home/user/repo show HEAD")).toBe(true);
	});

	it("allows git -C with quoted path", () => {
		expect(isReadOnlyCommand('git -C "/path/with spaces/repo" log --oneline')).toBe(true);
	});

	it("allows git -C with single-quoted path", () => {
		expect(isReadOnlyCommand("git -C '/path/with spaces/repo' status")).toBe(true);
	});

	it("rejects git add (not read-only)", () => {
		expect(isReadOnlyCommand("git add AGENTS.md")).toBe(false);
	});

	it("rejects git commit (not read-only)", () => {
		expect(isReadOnlyCommand('git commit -m "msg"')).toBe(false);
	});

	it("rejects git -C <path> add (not read-only)", () => {
		expect(isReadOnlyCommand("git -C /home/user/repo add AGENTS.md")).toBe(false);
	});

	it("rejects git -C <path> commit (not read-only)", () => {
		expect(isReadOnlyCommand('git -C /home/user/repo commit -m "msg"')).toBe(false);
	});

	it("rejects mixed pipeline with destructive command when one segment fails", () => {
		expect(isReadOnlyCommand("cd /home/user && git add .")).toBe(false);
	});

	it("allows piped read-only commands", () => {
		expect(isReadOnlyCommand("git log --oneline | head -5")).toBe(true);
	});

	it("allows commands with harmless 2>&1 stderr redirect", () => {
		expect(isReadOnlyCommand("git branch -a 2>&1 | head -20")).toBe(true);
	});

	it("allows find with 2>/dev/null redirect", () => {
		expect(isReadOnlyCommand("find /home/user/project -maxdepth 2 -type d 2>/dev/null | head -50")).toBe(true);
	});

	it("allows complex pipeline with 2>&1 redirects", () => {
		expect(isReadOnlyCommand("cd /home/user && ls project/ 2>&1; git ls-tree -r --name-only origin/main 2>&1 | head -5")).toBe(true);
	});

	it("accepts custom allowlist prefixes", () => {
		expect(isReadOnlyCommand("git stash list", { prefixes: ["git stash"] })).toBe(true);
	});

	it("accepts custom allowlist exact match", () => {
		expect(isReadOnlyCommand("git stash", { exact: ["git stash"] })).toBe(true);
	});

	it("rejects command substitution and embedded shell execution", () => {
		expect(isReadOnlyCommand("echo $(git status)")).toBe(false);
		expect(isReadOnlyCommand("find . -exec sh -c 'cat {}' \\;" )).toBe(false);
		expect(isReadOnlyCommand("awk 'BEGIN { system(\"id\") }' file")).toBe(false);
	});
});

describe("isDestructiveCommand", () => {
	it("rejects git push", () => {
		expect(isDestructiveCommand("git push")).toBe(true);
	});

	it("rejects git commit", () => {
		expect(isDestructiveCommand("git commit -m 'msg'")).toBe(true);
	});

	it("rejects git -C <path> push", () => {
		expect(isDestructiveCommand("git -C /home/user/repo push")).toBe(true);
	});

	it("rejects git -C <path> commit", () => {
		expect(isDestructiveCommand("git -C /home/user/repo commit -m 'msg'")).toBe(true);
	});

	it("rejects git -C <path> merge", () => {
		expect(isDestructiveCommand("git -C /home/user/repo merge feature-branch")).toBe(true);
	});

	it("allows git log (not destructive)", () => {
		expect(isDestructiveCommand("git log")).toBe(false);
	});

	it("allows git -C <path> log (not destructive)", () => {
		expect(isDestructiveCommand("git -C /home/user/repo log")).toBe(false);
	});

	it("rejects npx", () => {
		expect(isDestructiveCommand("npx vitest run")).toBe(true);
	});

	it("rejects rm -rf", () => {
		expect(isDestructiveCommand("rm -rf /tmp/test")).toBe(true);
	});
});
