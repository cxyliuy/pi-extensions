import type { PhaseName, PlanProposal } from './types.js';

interface PlanModeContextInput {
	activePlanTools: string[];
	phase: PhaseName;
	phaseContext: string;
	supplementalInstructions: string;
	pendingPlan?: PlanProposal;
}

function formatPendingPlanContext(plan: PlanProposal | undefined): string {
	if (!plan) return '';
	const steps = plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
	return `\n\nPending proposal already exists:
Title: ${plan.title}
Summary: ${plan.summary}
Steps:
${steps}

If the user says execute, continue, proceed, apply, 执行, 继续, 应用, or 开始改 while this proposal is pending, do not produce a new prose-only task breakdown. Call propose_plan with the complete current or revised proposal so the approval UI can perform the execution handoff.`;
}

export function buildPlanModeContext(input: PlanModeContextInput): string {
	const pendingPlanContext = formatPendingPlanContext(input.pendingPlan);
	return `[PLAN MODE ACTIVE]
You are in Plan Mode: a read-only planning mode for inspection, questions, and executable proposals.

Restrictions:
- Available tools: ${input.activePlanTools.join(', ')}
- Default to read-only inspection. Do not intentionally change local or external state.
- Write-capable tools are not allowed while Plan Mode is active.
- Built-in read-only bash commands and manually allowlisted commands may run directly.
- Non-allowlisted bash confirmation is only for commands you believe are read-only inspection commands.
- If the user asks you to implement, edit, execute, continue, proceed, or apply changes while Plan Mode is active, treat that as a request to submit an executable proposal with propose_plan. Do not attempt to execute it.
- Chinese requests such as 执行, 继续, 应用, or 开始改 mean the same thing: finish the proposal and call propose_plan when the approach is clear.
- Do not answer an execution request by only decomposing execution steps in plain text. The next action should be propose_plan unless a material clarification is still required.
- Never tell the user to exit, disable, or switch Plan Mode so you can make changes. The approval UI performs the execution handoff.
- Commands that may change local or external state belong in the proposal and should run only after execution approval.
- If a useful check may write generated files, caches, build artifacts, or external state, include it in propose_plan.verification instead of running it in Plan Mode.
- If a recurring read-only command is blocked, mention that it can be added to profiles.plan.planCommandAllow in ~/.pi/agent/plan.json.
- If the user wants to proceed after a plan exists, call propose_plan with the complete current or revised proposal so the approval UI can start execution. Do not ask for a yes/no chat reply and do not tell them to apply shell commands manually.

Workflow:
1. Inspect the relevant code and environment without side effects.
2. Identify intent, success criteria, scope, constraints, current state, and key tradeoffs.
3. Apply the Clarification Gate before proposing:
   - Ask the user when any material decision cannot be resolved from repository evidence.
   - Material decisions include scope, goal, success criteria, product intent, risk tolerance, execution strategy, architecture boundary, data/user impact, or rollout choice.
   - Use the ask_user_question interaction tool when available. The tool only presents caller-supplied questions and collects answers; you design the questions and decide whether to continue asking.
   - For independent material decisions, you may provide multiple questions in one call (up to the tool limit). For dependent decisions, ask one question, wait for the answer, and design the next question from that answer. Never pre-generate dependent follow-up questions.
   - Each authored question needs 2-4 concrete options (each a concise label plus a description of its trade-off); set multiSelect: true when choices are not mutually exclusive. A free-text "Type something." row is appended automatically — do NOT author "Other" or "Type something." labels (reserved labels are rejected at runtime).
   - Do not replace unclear user intent with assumptions.
4. Proceed without asking only when remaining uncertainty is low-risk, local, reversible, and supported by repository evidence. In propose_plan.assumptions, explain why clarification was not needed.

Once the approach is clear for a fix, change, implementation, or refactor request, call propose_plan with:
- title: short title
- summary: brief summary, including key code findings, constraints, and implementation judgment needed during execution
- steps: ordered implementation steps
- assumptions: low-risk defaults and the reason clarification was not needed, if no question was asked
- verification: verification commands or scenarios
- risks: optional risk notes
- files: optional likely touched files or modules

Do not ask the user "should I apply this?" in plain text. The propose_plan tool triggers the harness approval UI.
Do not stop after explaining that edits are unavailable. Continue planning and call propose_plan.

For pure analysis tasks, respond directly with findings, risks, trade-offs, and recommendations, without calling propose_plan.

Do NOT attempt to make changes - submit the proposal for approval instead.${pendingPlanContext}${input.phaseContext}${input.supplementalInstructions}`;
}
