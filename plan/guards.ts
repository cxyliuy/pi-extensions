import type { ToolGuardDecision } from './types.js';
import type { CommandAllowlist } from './utils.js';
import type { TirithConfig } from './types.js';
import { isReadOnlyCommand, isDestructiveCommand } from './utils.js';
import { PLAN_MODE_WRITE_TOOLS } from './constants.js';
import { runTirithCheck, resolveTirithWarnAction, tirithEnabled, mergeTirithVerdict, type PlanSeverity } from './tirith.js';

export function isPlanModeWriteTool(toolName: string): boolean {
	const normalized = toolName.toLowerCase();
	const shortName = normalized.split('.').pop() ?? normalized;
	return PLAN_MODE_WRITE_TOOLS.has(normalized) || PLAN_MODE_WRITE_TOOLS.has(shortName);
}

function planInstructionGuard(prefix: string): string {
	return `${prefix} Continue with read-only inspection and call propose_plan for the requested change when the approach is clear. Do not ask the user to exit or switch Plan Mode. Add only recurring read-only commands to profiles.plan.planCommandAllow.`;
}

export function writeToolGuard(toolName: string): ToolGuardDecision | undefined {
	if (!isPlanModeWriteTool(toolName)) return undefined;
	return {
		block: true,
		reason: planInstructionGuard(
			`Plan mode: ${toolName} is disabled. Do not edit files while Plan Mode is active.`,
		),
	};
}

/**
 * Guard for bash commands in Plan Mode.
 *
 * Read-only allowlisted commands pass through. Everything else is blocked:
 * - `destructive` severity hard-blocks (side effects, never confirmed).
 * - `unknown` severity is hard-blocked. Plan Mode is fail-closed.
 *
 * When tirith enrichment is enabled, blocked commands are additionally scanned
 * by `tirith check --json`. Tirith is enrichment-only and can only strengthen:
 * - block verdict, or warn verdict with warnAction `deny` → escalate to
 *   `destructive` (no confirmation offered) and append findings to the reason.
 * - warn verdict with warnAction `allow` → keep the caller's severity, append
 *   findings to the reason so they reach the agent and the approval prompt.
 * - clean/error → plan's own decision stands unchanged. A missing or erroring
 *   tirith binary must not weaken the block.
 *
 * Allowlisted read-only commands skip tirith entirely (no overhead); tirith's
 * command-structure analysis is most valuable on commands plan already blocks.
 */
export function shellPlanGuard(
	command: string,
	allowlist: CommandAllowlist = {},
	tirith?: TirithConfig,
): ToolGuardDecision | undefined {
	const destructive = isDestructiveCommand(command);
	// Destructive commands are never overridable by the manual allowlist.
	if (!destructive && isReadOnlyCommand(command, allowlist)) return undefined;
	const baseReason = destructive
		? `Plan mode: this command has side effects and cannot run in Plan Mode.\nCommand: ${command}`
		: `Plan mode: bash command is not in the read-only allowlist.\nCommand: ${command}`;
	const severity: PlanSeverity = destructive ? 'destructive' : 'unknown';

	if (!tirithEnabled(tirith)) {
		return { block: true, severity, reason: planInstructionGuard(baseReason) };
	}

	const enriched = enrichWithTirith(baseReason, severity, command, tirith);
	return { block: true, severity: enriched.severity, reason: planInstructionGuard(enriched.reason) };
}

function enrichWithTirith(
	baseReason: string,
	severity: PlanSeverity,
	command: string,
	config: TirithConfig,
): { severity: PlanSeverity; reason: string } {
	const verdict = runTirithCheck(command, config);
	return mergeTirithVerdict(baseReason, severity, verdict, resolveTirithWarnAction(config));
}
