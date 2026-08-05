/**
 * Plan Mode Extension with Centralized State Machine
 *
 * State flow: normal → planning → approval → executing → normal
 * - plan phase: broad tools with read-only bash allowlist + optional high-reasoning model/provider
 * - execute phase: full tools + optional cheaper/faster model/provider
 * - session restore: reapplies the active phase profile
 *
 * All state transitions go through the centralized transition() function in constants.ts.
 * Event handlers emit events, transition() returns the new mode + actions, callers execute them.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ReplacedSessionContext } from '@earendil-works/pi-coding-agent';
import { Key, Markdown, Text } from '@earendil-works/pi-tui';
import type {
	PlanModeStateName,
	PlanProposal,
	PlanProposalInput,
	PlanRuntimeState,
	PlanTaskUpdateInput,
	TaskStatus,
	TransitionAction,
} from './types.js';
import type { TodoItem } from './utils.js';
import type { PlanModeEntryData } from './state.js';
import {
	PLAN_PROPOSAL_TOOL,
	PLAN_TASK_UPDATE_TOOL,
	PLAN_MODE_TOOLS,
	APPROVAL_CHOICES,
	MAX_AUTO_CONTINUATIONS,
	MAX_NO_PROGRESS_CONTINUATIONS,
	PLAN_PROPOSAL_PARAMETERS,
	PLAN_TASK_UPDATE_PARAMETERS,
	phaseForMode,
	isPlanModeActive,
	transitionApproval,
	transition,
} from './constants.js';
import { readConfig, getProfile, getPlanModeTools, applyPhaseProfile, captureRuntimeSnapshot } from './config.js';
import { createPlanState, restorePlanState } from './state.js';
import { writeToolGuard, shellPlanGuard } from './guards.js';
import { buildPlanModeContext } from './context.js';
import {
	normalizePlanText,
	normalizePlanProposal,
	todosFromPlanProposal,
	formatTodoLine,
	formatPlanProposal,
	formatApprovedPlanContext,
	formatEditablePlan,
	parseEditablePlan,
	livingPlanFromUpdate,
} from './format.js';

/** Search/text-matching commands where exit code 1 means "no matches", not an error. */
const SEARCH_EXIT_ONE_RE = /^\s*(?:rg|grep|ag|ack|git\s+grep)\b[^;&|]*$/;

export default function planModeExtension(pi: ExtensionAPI): void {
	const { config, diagnostics: configDiagnostics } = readConfig();
	let state = createPlanState() as PlanRuntimeState;
	let working = false;
	let configDiagnosticsShown = false;
	let activeModel: Pick<RuntimeSnapshot, 'provider' | 'model'> | undefined;

	pi.registerFlag('plan', {
		description: 'Start in plan mode (read-only planning)',
		type: 'boolean',
		default: false,
	});

	// ── Status & widget ────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		const model = ctx.model as unknown as { provider?: string; id?: string };
		const provider = activeModel?.provider ?? model?.provider;
		const modelId = activeModel?.model ?? model?.id;
		const modelLabel = provider && modelId ? ` ${provider}/${modelId}` : '';
		const thinkingLabel = ` ${pi.getThinkingLevel()}`;
		const workIndicator = working ? '⏳ ' : '';

		if (state.mode === 'executing' && state.todos.length > 0) {
			const completed = state.todos.filter((t) => t.status === 'completed').length;
			ctx.ui.setStatus(
				'plan-mode',
				ctx.ui.theme.fg(
					'accent',
					`${workIndicator}📋 ${completed}/${state.todos.length}${modelLabel}${thinkingLabel}`,
				),
			);
		} else if (isPlanModeActive(state.mode)) {
			ctx.ui.setStatus(
				'plan-mode',
				ctx.ui.theme.fg('warning', `${workIndicator}⏸ plan${modelLabel}${thinkingLabel}`),
			);
		} else {
			ctx.ui.setStatus('plan-mode', undefined);
		}

		if (state.mode === 'executing' && state.todos.length > 0) {
			const activeTodo =
				state.todos.find((item) => item.status === 'in_progress') ??
				state.todos.find((item) => item.status === 'blocked') ??
				state.todos.find((item) => item.status === 'pending');
			if (activeTodo) {
				const label =
					activeTodo.status === 'blocked'
						? ctx.ui.theme.fg('warning', 'Blocked')
						: activeTodo.status === 'in_progress'
							? ctx.ui.theme.fg('accent', 'Current')
							: ctx.ui.theme.fg('muted', 'Next');
				ctx.ui.setWidget('plan-todos', [`${label}: ${activeTodo.text}`]);
			} else {
				ctx.ui.setWidget('plan-todos', undefined);
			}
		} else {
			ctx.ui.setWidget('plan-todos', undefined);
		}
	}

	// ── State helpers ──────────────────────────────────────────────

	async function enterMode(ctx: ExtensionContext, mode: PlanModeStateName): Promise<void> {
		state.mode = mode;
		activeModel =
			(await applyPhaseProfile(pi, ctx, config, phaseForMode(mode), state.runtimeSnapshot)) ??
			captureRuntimeSnapshot(pi, ctx);
		updateStatus(ctx);
	}

	function resetPlanState(mode: PlanModeStateName = 'normal', clearTodos = true): void {
		const todos = clearTodos ? [] : state.todos;
		state = {
			...createPlanState(mode),
			todos,
			runtimeSnapshot: state.runtimeSnapshot,
		} as PlanRuntimeState;
	}

	function persistState(): void {
		pi.appendEntry('plan-mode', {
			schemaVersion: state.schemaVersion,
			mode: state.mode,
			todos: state.todos,
			pendingPlan: state.pendingPlan,
			runtimeSnapshot: state.runtimeSnapshot,
			continuationCount: state.continuationCount,
			noProgressContinuationCount: state.noProgressContinuationCount,
		});
	}

	function remainingTodos(): TodoItem[] {
		return state.todos.filter((todo) => todo.status !== 'completed');
	}

	function getCurrentPlanForRefinement(): PlanProposal | undefined {
		if (state.pendingPlan) return state.pendingPlan;
		if (state.todos.length === 0) return undefined;
		return normalizePlanProposal({
			title: 'Current plan',
			summary: 'Current available plan steps.',
			steps: state.todos.map((todo) => todo.text),
			assumptions: [],
		});
	}

	// ── Action executor ────────────────────────────────────────────
	// Executes actions returned by the centralized transition() function.

	async function executeActions(ctx: ExtensionContext, actions: TransitionAction[]): Promise<void> {
		for (const action of actions) {
			switch (action.type) {
				case 'apply_phase':
					await enterMode(ctx, action.phase === 'execute' ? 'executing' : action.phase === 'plan' ? 'planning' : 'normal');
					break;
				case 'notify':
					ctx.ui.notify(action.message, action.level);
					break;
				case 'reset_state':
					resetPlanState(action.mode, action.clearTodos);
					break;
				case 'persist':
					persistState();
					break;
				case 'update_status':
					updateStatus(ctx);
					break;
				case 'send_handoff':
					sendExecutionHandoff(action.todo, action.reason);
					break;
				case 'send_no_progress_continuation':
					sendNoProgressContinuation(action.todo);
					break;
				case 'finish_execution':
					await finishExecution(ctx, action.completed);
					break;
			}
		}
	}

	// ── Domain functions ───────────────────────────────────────────

	async function finishExecution(ctx: ExtensionContext, completed: boolean): Promise<void> {
		if (completed && state.todos.length > 0) {
			pi.sendMessage(
				{ customType: 'plan-complete', content: '**Plan Complete!** ✓', display: true },
				{ triggerTurn: false },
			);
		} else if (!completed && state.todos.length > 0) {
			const blockedTodo = state.todos.find((t) => t.status === 'blocked') ?? state.todos.find((t) => t.status !== 'completed');
			const blockedText = blockedTodo
				? `\n\n${blockedTodo.text}${blockedTodo.message ? `\n${blockedTodo.message}` : ''}`
				: '';
			pi.sendMessage(
				{
					customType: 'plan-blocked',
					content: `**Plan Blocked**${blockedText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		working = false;
		if (ctx.hasUI) ctx.ui.setWorkingVisible(true);
		resetPlanState('normal');
		await enterMode(ctx, 'normal');
		persistState();
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (state.mode === 'executing') {
			working = false;
			if (ctx.hasUI) ctx.ui.setWorkingVisible(true);
			resetPlanState('normal');
			await enterMode(ctx, 'normal');
			ctx.ui.notify('Previous plan execution state cleared. Plan mode exited.', 'info');
			persistState();
			return;
		}

		const nextMode: PlanModeStateName = isPlanModeActive(state.mode) ? 'normal' : 'planning';
		if (nextMode === 'planning') {
			state.runtimeSnapshot = captureRuntimeSnapshot(pi, ctx);
		}
		resetPlanState(nextMode);

		if (nextMode === 'planning') {
			await enterMode(ctx, 'planning');
			ctx.ui.notify(
				'Plan mode enabled. Read-only tools active — inspect code, then propose a plan for approval.',
			);
		} else {
			await enterMode(ctx, 'normal');
			ctx.ui.notify('Plan mode disabled. Full access restored.');
		}
		persistState();
	}

	function sendExecutionHandoff(firstTodo: TodoItem | undefined, reason: 'start' | 'continue' = 'start'): void {
		const updateReminder =
			'IMPORTANT: You MUST call plan_task_update to report progress for every task:' +
			'\n  - Mark a task in_progress when you start working on it.' +
			'\n  - Mark a task completed only after it is fully implemented and verified.' +
			'\n  - If a task cannot proceed, mark it blocked with a short reason.' +
			'\n  - Failure to call plan_task_update will cause the plan to stall and retry.';
		const modeText = 'Execute autonomously while reporting structured task progress.';
		let execMessage: string;
		if (reason === 'continue') {
			execMessage = `Continue executing the approved plan.\n\nMode: ${modeText}\n\nNext task: ${firstTodo ? formatTodoLine(firstTodo) : 'the first remaining task'}\n\n${updateReminder}`;
		} else {
			execMessage = `Execute the approved plan.\n\nMode: ${modeText}\n\nStart with: ${firstTodo ? formatTodoLine(firstTodo) : 'the first task'}\n\n${updateReminder}`;
		}

		pi.sendMessage(
			{ customType: 'plan-mode-execute', content: execMessage, display: false },
			{ triggerTurn: true, deliverAs: 'followUp' },
		);
	}

	function sendNoProgressContinuation(firstTodo: TodoItem | undefined): void {
		pi.sendMessage(
			{
				customType: 'plan-mode-execute',
				content: `Continue executing the approved plan.\n\nThe previous turn ended without structured task progress. Work on ${firstTodo ? formatTodoLine(firstTodo) : 'the first remaining task'} and call plan_task_update before stopping. If no task can move forward, mark it blocked with a short reason.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: 'followUp' },
		);
	}

	function sendRefinementMessage(refinement: string, plan?: PlanProposal): void {
		const currentPlanText = plan
			? `\n\nCurrent proposal:\n${formatEditablePlan(plan)}`
			: '\n\nCurrent proposal: not available from structured state. Use the latest conversation context as the baseline.';
		pi.sendMessage(
			{
				customType: 'plan-refinement',
				content: `Refine the current Plan Mode proposal using the new user context below.${currentPlanText}\n\nNew user context:\n${refinement.trim()}\n\nPreserve current proposal content that does not conflict with the new context. Where they conflict, follow the new context. Return one complete revised proposal by calling propose_plan. Do not execute the plan, modify files, or return only a partial diff.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: 'followUp' },
		);
	}

	async function startPlanExecution(ctx: ExtensionContext): Promise<void> {
		state.continuationCount = 0;
		state.noProgressContinuationCount = 0;
		state.currentAgentProgressCount = 0;
		working = true;
		updateStatus(ctx);

		const result = transition(state.mode, { type: 'APPROVAL_CHOICE', effect: 'start_execution' });
		state.mode = result.mode;
		await executeActions(ctx, result.actions);

		sendExecutionHandoff(state.todos[0]);
	}

	async function startNewSessionHandoff(ctx: ExtensionCommandContext): Promise<void> {
		const currentSession = ctx.sessionManager.getSessionFile();
		const plan = state.pendingPlan;
		if (!currentSession || !plan) {
			ctx.ui.notify(
				!currentSession ? 'Cannot hand off: the current session is not persisted.' : 'Cannot hand off: no structured plan is available.',
				'warning',
			);
			return;
		}

		const handoff = [
			'Implement this approved plan in a new session.',
			'',
			formatApprovedPlanContext(plan),
			'',
			'Mark work complete only after the approved verification is run. Begin implementation directly; do not return to Plan Mode.',
		].join('\n');
		const result = await ctx.newSession({
			parentSession: currentSession,
			withSession: async (replacementCtx: ReplacedSessionContext) => {
				replacementCtx.ui.setEditorText(handoff);
				replacementCtx.ui.notify('Approved plan handed off. Review the draft and submit to begin.', 'info');
			},
		});
		if (result.cancelled) ctx.ui.notify('New session handoff cancelled.', 'info');
	}

	/**
	 * Show the approval UI. Called when entering the approval state.
	 * Handles Execute/Refine/Edit/Dismiss/Quit choices through the centralized state machine.
	 */
	function formatApprovalPlanContent(plan?: PlanProposal): string {
		if (plan) return formatPlanProposal(plan);
		const todoListText = state.todos.map((t, i) => `${i + 1}. ☐ ${t.text}`).join('\n');
		return `**Plan Steps (${state.todos.length}):**\n\n${todoListText}`;
	}

	function showPlanProposal(plan?: PlanProposal): void {
		const proposalContent = formatApprovalPlanContent(plan);
		pi.sendMessage(
			plan
				? {
						customType: 'plan-proposal',
						content: proposalContent,
						display: true,
						details: plan,
					}
				: {
						customType: 'plan-todo-list',
						content: proposalContent,
						display: true,
					},
			{ triggerTurn: false },
		);
	}

	async function promptForPlanExecution(ctx: ExtensionContext, plan?: PlanProposal): Promise<void> {
		state.mode = 'approval';
		state.pendingPlan = plan ?? state.pendingPlan;
		persistState();
		if (!ctx.hasUI) {
			state.mode = 'planning';
			persistState();
			updateStatus(ctx);
			return;
		}

		ctx.ui.setWorkingVisible(false);
		working = false;
		updateStatus(ctx);
		while (state.mode === 'approval') {
			const choice = await ctx.ui.select('Plan proposal - what next?', [...APPROVAL_CHOICES]);
			const approvalTransition = transitionApproval(choice);

			if (approvalTransition.effect === 'start_execution') {
				await startPlanExecution(ctx);
				return;
			}
			if (approvalTransition.effect === 'start_new_session') {
				await startNewSessionHandoff(ctx as ExtensionCommandContext);
				return;
			}
			if (approvalTransition.effect === 'open_refinement') {
				const refinement = await ctx.ui.editor('Refine plan with additional context:', '');
				if (!refinement?.trim()) continue;
				const currentPlan = getCurrentPlanForRefinement();
				const result = transition(state.mode, { type: 'REFINE_SUBMITTED' });
				state.mode = result.mode;
				await executeActions(ctx, result.actions);
				ctx.ui.setWorkingVisible(true);
				sendRefinementMessage(refinement, currentPlan);
				return;
			}
			if (approvalTransition.effect === 'open_editor') {
				const basePlan =
					state.pendingPlan ??
					normalizePlanProposal({
						title: 'Plan',
						summary: 'Edited plan.',
						steps: state.todos.map((todo) => todo.text),
						assumptions: [],
					});
				let editorText = formatEditablePlan(basePlan);
				while (state.mode === 'approval') {
					const edited = await ctx.ui.editor('Edit plan:', editorText);
					if (!edited?.trim() || edited === editorText) break;
					try {
						const editedPlan = parseEditablePlan(edited);
						state.pendingPlan = editedPlan;
						state.todos = todosFromPlanProposal(editedPlan);
						persistState();
						await startPlanExecution(ctx);
						return;
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning');
						editorText = edited;
					}
				}
				continue;
			}
			working = false;
			if (approvalTransition.effect === 'quit_plan') {
				ctx.ui.setWorkingVisible(true);
				const result = transition(state.mode, { type: 'APPROVAL_CHOICE', effect: 'quit_plan' });
				state.mode = result.mode;
				await executeActions(ctx, result.actions);
				return;
			}
			const result = transition(state.mode, { type: 'APPROVAL_CHOICE', effect: 'dismiss_approval' });
			state.mode = result.mode;
			await executeActions(ctx, result.actions);
			return;
		}
	}

	function assertTaskStatus(status: unknown): TaskStatus {
		if (!['pending', 'in_progress', 'completed', 'blocked'].includes(status as string)) {
			throw new Error('plan_task_update.status must be pending, in_progress, completed, or blocked.');
		}
		return status as TaskStatus;
	}

	function updateTaskStatus(update: PlanTaskUpdateInput): TodoItem {
		if (update.taskId === undefined || update.status === undefined) {
			throw new Error(
				'plan_task_update requires either a whole-plan `plan` array or both `taskId` and `status`.',
			);
		}
		const taskId = normalizePlanText(update.taskId, 'taskId');
		const status = assertTaskStatus(update.status);

		const task = state.todos.find((todo) => todo.id === taskId);
		if (!task) {
			throw new Error(`Unknown plan task id: ${taskId}`);
		}

		const message = update.message === undefined ? undefined : normalizePlanText(update.message, 'message');
		const changed = task.status !== status || (message !== undefined && task.message !== message);
		task.status = status;
		task.completed = status === 'completed';
		if (message !== undefined) {
			task.message = message;
		}
		if (changed) {
			state.currentAgentProgressCount += 1;
			state.noProgressContinuationCount = 0;
		}
		return task;
	}

	// ── Tool registration ──────────────────────────────────────────

	pi.registerTool({
		name: PLAN_PROPOSAL_TOOL,
		label: 'Propose Plan',
		description:
			'Submit a structured implementation plan while Plan Mode is active. This stores tracked steps and asks the user whether to execute them.',
		promptSnippet: 'Submit a structured Plan Mode proposal for implementation or refactor requests.',
		promptGuidelines: [
			'Use propose_plan when Plan Mode needs an executable implementation, fix, refactor, or verification plan.',
			'Before calling propose_plan, resolve any material decision that cannot be inferred from repository evidence.',
			'Use ask_user_question only as the interaction primitive: design the questions here, and decide whether to ask independent questions together or dependent questions one at a time.',
			'For dependent decisions, wait for each answer before designing the next question; do not pre-generate later branch questions.',
			'Put key code findings, constraints, tradeoffs, and execution-critical context in summary, assumptions, risks, verification, and files.',
			'Use assumptions only for low-risk implementation defaults; do not use assumptions to bypass unclear user intent.',
			'If no question was asked, explain in assumptions why no material clarification was needed.',
			'Do not ask the user to reply yes or no in chat for execution approval; propose_plan will trigger the harness approval UI.',
			'Do not ask the user to exit or switch Plan Mode. Finish planning and call propose_plan instead.',
		],
		parameters: PLAN_PROPOSAL_PARAMETERS,
		async execute(_toolCallId, params: PlanProposalInput, _signal, _onUpdate, ctx) {
			if (!isPlanModeActive(state.mode)) {
				throw new Error('propose_plan can only be used while Plan Mode is active.');
			}

			const plan = normalizePlanProposal(params);
			state.pendingPlan = plan;
			state.todos = todosFromPlanProposal(plan);

			const result = transition(state.mode, { type: 'PROPOSE', plan });
			state.mode = result.mode;
			await executeActions(ctx, result.actions);

			return {
				content: [
					{
						type: 'text',
						text: formatPlanProposal(plan),
					},
				],
				details: { plan, todos: state.todos },
				terminate: true,
			};
		},
		renderShell: 'self',
		renderCall() {
			return new Text('', 0, 0);
		},
		renderResult({ content }, _options, theme) {
			const text = (content ?? [])
				.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
				.map((block) => block.text)
				.join('\n');
			if (!text) return new Text('', 0, 0);
			// Mirror the core's getMarkdownTheme (md* color keys on the shared Theme instance),
			// so the proposal renders as proper markdown in the tool-result slot.
			return new Markdown(text, 1, 0, {
				heading: (t) => theme.fg('mdHeading', t),
				link: (t) => theme.fg('mdLink', t),
				linkUrl: (t) => theme.fg('mdLinkUrl', t),
				code: (t) => theme.fg('mdCode', t),
				codeBlock: (t) => theme.fg('mdCodeBlock', t),
				codeBlockBorder: (t) => theme.fg('mdCodeBlockBorder', t),
				quote: (t) => theme.fg('mdQuote', t),
				quoteBorder: (t) => theme.fg('mdQuoteBorder', t),
				hr: (t) => theme.fg('mdHr', t),
				listBullet: (t) => theme.fg('mdListBullet', t),
				bold: (t) => theme.bold(t),
				italic: (t) => theme.italic(t),
				underline: (t) => theme.underline(t),
				strikethrough: (t) => theme.strikethrough(t),
				highlightCode: (code) => code.split('\n').map((line) => theme.fg('mdCodeBlock', line)),
			});
		},
	});

	pi.registerTool({
		name: PLAN_TASK_UPDATE_TOOL,
		label: 'Plan Task Update',
		description:
			'Update the approved plan during execution: change one task status, or replace the whole plan (living plan) to add, remove, reorder, or split steps.',
		promptSnippet: 'Report approved plan task progress or revise the step list mid-execution.',
		promptGuidelines: [
			'Call plan_task_update when starting, completing, or blocking an approved plan task.',
			'Use task ids shown in the execution context, such as task-1.',
			'If a task cannot continue, mark it blocked with a short message instead of silently stopping.',
			'To add, remove, reorder, or split steps during execution, pass a full `plan` array (every step with a status) and an `explanation` of the change; existing task ids are reused by matching step text.',
			'Keep at most one step in_progress at a time.',
		],
		parameters: PLAN_TASK_UPDATE_PARAMETERS,
		async execute(_toolCallId, params: PlanTaskUpdateInput, _signal, _onUpdate, ctx) {
			if (state.mode !== 'executing') {
				throw new Error('plan_task_update can only be used while executing an approved plan.');
			}
			// Living plan: replace the whole approved plan with a revised step list.
			if (Array.isArray(params.plan) && params.plan.length > 0) {
				const incoming = params.plan.map((item) => ({
					step: normalizePlanText(item.step, 'step'),
					status: assertTaskStatus(item.status),
				}));
				state.todos = livingPlanFromUpdate(state.todos, incoming);
				state.currentAgentProgressCount += 1;
				state.noProgressContinuationCount = 0;
				persistState();
				updateStatus(ctx);
				const total = state.todos.length;
				const completed = state.todos.filter((t) => t.status === 'completed').length;
				const inProgress = state.todos.filter((t) => t.status === 'in_progress').length;
				const executionBlocked = state.todos.some((t) => t.status === 'blocked');
				const allCompleted = total > 0 && completed === total;
				const terminal = allCompleted || executionBlocked;
				const reason = params.explanation?.trim() || 'steps reordered';
				const hint = inProgress > 1 ? '\nNote: keep at most one step in_progress at a time.' : '';
				return {
					content: [
						{
							type: 'text',
							text: `Plan updated: ${reason}. ${completed}/${total} done, ${inProgress} in progress.${hint}${terminal ? ' Ending the execution turn.' : ''}`,
						},
					],
					details: { plan: incoming, explanation: params.explanation, todos: state.todos },
					terminate: terminal,
				};
			}

			// Single-task update.
			const task = updateTaskStatus(params);
			persistState();
			updateStatus(ctx);
			const allCompleted = state.todos.every((todo) => todo.status === 'completed');
			const executionBlocked = state.todos.some((todo) => todo.status === 'blocked');
			const terminal = allCompleted || executionBlocked;
			const inProgress = state.todos.filter((t) => t.status === 'in_progress').length;
			const hint = inProgress > 1 ? '\nNote: keep at most one step in_progress at a time.' : '';
			return {
				content: [
					{
						type: 'text',
						text: terminal
							? `Task ${task.id} marked ${task.status}. Ending the execution turn.`
							: `Task ${task.id} marked ${task.status}.${hint}`,
					},
				],
				details: { task },
				terminate: terminal,
			};
		},
		renderShell: 'self',
		renderCall() {
			return new Text('', 0, 0);
		},
		renderResult() {
			return new Text('', 0, 0);
		},
	});

	// ── Commands & shortcuts ───────────────────────────────────────

	pi.registerCommand('plan', {
		description: 'Toggle plan mode (read-only planning)',
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand('todos', {
		description: 'Show current plan todo list',
		handler: async (_args, ctx) => {
			if (state.todos.length === 0) {
				ctx.ui.notify('No todos. Create a plan first with /plan', 'info');
				return;
			}
			const list = state.todos
				.map(
					(item, i) =>
						`${i + 1}. ${item.status === 'completed' ? '✓' : item.status === 'blocked' ? '!' : '○'} ${item.id} ${item.text}`,
				)
				.join('\n');
			ctx.ui.notify(`Plan Progress:\n${list}`, 'info');
		},
	});

	pi.registerShortcut(Key.alt('i'), {
		description: 'Toggle plan mode',
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ── Event handlers ─────────────────────────────────────────────

	// Suppress error display for search commands that exit with code 1 (no matches).
	pi.on('tool_result', async (event) => {
		if (!isPlanModeActive(state.mode) || event.toolName !== 'bash' || !event.isError) return;
		const command = event.input?.command as string | undefined;
		if (!command || !SEARCH_EXIT_ONE_RE.test(command)) return;

		// Check that the error is specifically "exit code 1" — higher codes are real errors.
		const hasExitOne = event.content.some(
			(c) => c.type === 'text' && /Command exited with code 1$/.test((c as { text: string }).text),
		);
		if (!hasExitOne) return;

		return {
			content: event.content.map((c) => {
				if (c.type !== 'text') return c;
				const text = (c as { text: string }).text.replace(/\n\nCommand exited with code 1$/, '');
				return { ...c, text };
			}),
			isError: false,
		};
	});

	pi.on('tool_call', async (event, ctx) => {
		if (!isPlanModeActive(state.mode)) return;

		const writeDecision = writeToolGuard(event.toolName);
		if (writeDecision) {
			return writeDecision;
		}

		if (event.toolName !== 'bash') return;

		const command = event.input.command as string;
		const profile = getProfile(config, 'plan');
		const shellDecision = shellPlanGuard(command, profile.planCommandAllow, config.tirith);
		if (shellDecision) {
			return {
				block: shellDecision.block,
				reason: shellDecision.reason,
			};
		}
	});

	pi.on('context', async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (
					msg.customType === 'plan-mode-context' ||
					msg.customType === 'phase-profile-context' ||
					msg.customType === 'plan-execution-context'
				) {
					return false;
				}
				if (msg.role !== 'user') return true;

				const content = msg.content;
				if (typeof content === 'string') {
					return (
						!content.includes('[PLAN MODE ACTIVE]') &&
						!content.includes('[PHASE PROFILE]') &&
						!content.includes('[EXECUTING PLAN')
					);
				}
				if (Array.isArray(content)) {
					return !content.some((c) => {
						const text = c.type === 'text' ? (c as TextContent).text : undefined;
						return (
							text?.includes('[PLAN MODE ACTIVE]') ||
							text?.includes('[PHASE PROFILE]') ||
							text?.includes('[EXECUTING PLAN')
						);
					});
				}
				return true;
			}),
		};
	});

	pi.on('before_agent_start', async () => {
		const phase = phaseForMode(state.mode);
		const profile = getProfile(config, phase);
		const phaseContext = profile.context ? `\n\n[PHASE PROFILE: ${phase}]\n${profile.context}` : '';
		const supplementalInstructions = profile.instructions?.length
			? `\n\n[SUPPLEMENTAL ${phase.toUpperCase()} INSTRUCTIONS]\n${profile.instructions.map((item) => `- ${item}`).join('\n')}`
			: '';
		const activePlanTools = phase === 'plan' ? getPlanModeTools(profile) : (profile.tools ?? PLAN_MODE_TOOLS);

		if (isPlanModeActive(state.mode)) {
			return {
				message: {
					customType: 'plan-mode-context',
					content: buildPlanModeContext({
						activePlanTools,
						phase,
						phaseContext,
						supplementalInstructions,
						pendingPlan: state.pendingPlan,
					}),
					display: false,
				},
			};
		}

		if (state.mode === 'executing' && state.todos.length > 0) {
			const remaining = remainingTodos();
			const todoList = remaining.map((t) => `${t.id} [${t.status}] ${t.text}`).join('\n');
			const approvedPlanContext = formatApprovedPlanContext(state.pendingPlan);
			return {
				message: {
					customType: 'plan-execution-context',
					content: `[EXECUTING APPROVED PLAN]
${approvedPlanContext}

Remaining steps:
${todoList}

Execute each step in order.

MANDATORY: You MUST call plan_task_update to report progress for every task:
- Mark a task in_progress when you start working on it.
- Mark a task completed only after it is fully implemented and verified.
- If a task cannot proceed, mark it blocked with a short reason.
- Complete the approved verification before marking the final task completed.
- Failure to call plan_task_update will cause the plan to stall and retry.${phaseContext}${supplementalInstructions}`,
					display: false,
				},
			};
		}

		if (phaseContext || supplementalInstructions) {
			return {
				message: {
					customType: 'phase-profile-context',
					content: `[PHASE PROFILE: ${phase}]${phaseContext}${supplementalInstructions}`,
					display: false,
				},
			};
		}
	});

	pi.on('agent_end', async (_event, ctx) => {
		if (state.mode === 'approval') {
			// The proposal is rendered as the propose_plan tool result (visible during the turn).
			// Do NOT call showPlanProposal() here: sendMessage() inside the agent_end handler
			// runs while isStreaming is still true, so a display:true message is steer()-queued
			// instead of rendered, and is later fed back to the LLM as a user turn.
			await promptForPlanExecution(ctx, state.pendingPlan);
			return;
		}

		// ── Execution continuation logic ──
		if (state.mode === 'executing' && state.todos.length > 0) {
			if (state.todos.every((t) => t.status === 'completed')) {
				const result = transition(state.mode, { type: 'ALL_COMPLETE' });
				state.mode = result.mode;
				await executeActions(ctx, result.actions);
				return;
			}

			const remaining = remainingTodos();

			if (state.todos.some((todo) => todo.status === 'blocked')) {
				const blocked = state.todos.filter((todo) => todo.status === 'blocked');
				ctx.ui.notify(
					`Plan execution blocked: ${blocked.length} task(s) blocked. Run /plan to create a revised plan.`,
					'warning',
				);
				const result = transition(state.mode, { type: 'TASK_BLOCKED' });
				state.mode = result.mode;
				await executeActions(ctx, result.actions);
				return;
			}

			if (state.currentAgentProgressCount === 0) {
				if (state.noProgressContinuationCount < MAX_NO_PROGRESS_CONTINUATIONS) {
					state.noProgressContinuationCount += 1;
					state.currentAgentProgressCount = 0;
					const result = transition(state.mode, { type: 'NO_PROGRESS_RETRY', todo: remaining[0] });
					state.mode = result.mode;
					await executeActions(ctx, result.actions);
					return;
				}

				ctx.ui.notify(
					`Plan execution blocked: no task progress was reported after ${MAX_NO_PROGRESS_CONTINUATIONS} retries.`,
					'warning',
				);
				if (remaining[0]) {
					remaining[0].status = 'blocked';
					remaining[0].completed = false;
					remaining[0].message = `No structured task progress was reported after ${MAX_NO_PROGRESS_CONTINUATIONS} retries.`;
				}
				const result = transition(state.mode, { type: 'TASK_BLOCKED' });
				state.mode = result.mode;
				await executeActions(ctx, result.actions);
				return;
			}

			if (state.continuationCount >= MAX_AUTO_CONTINUATIONS) {
				ctx.ui.notify(
					`Plan execution blocked after ${MAX_AUTO_CONTINUATIONS} automatic continuations.`,
					'warning',
				);
				if (remaining[0]) {
					remaining[0].status = 'blocked';
					remaining[0].completed = false;
					remaining[0].message = `Automatic continuation limit reached with ${remaining.length} remaining task(s).`;
				}
				const result = transition(state.mode, { type: 'CONTINUATION_LIMIT' });
				state.mode = result.mode;
				await executeActions(ctx, result.actions);
				return;
			}

			state.continuationCount += 1;
			state.noProgressContinuationCount = 0;
			state.currentAgentProgressCount = 0;
			const result = transition(state.mode, { type: 'CONTINUE', todo: remaining[0] });
			state.mode = result.mode;
			await executeActions(ctx, result.actions);
			return;
		}

	});

	async function restoreCurrentBranch(ctx: ExtensionContext, forcePlan = false): Promise<void> {
		const entries = ctx.sessionManager.getBranch();
		const planModeEntry = [...entries].reverse().find((entry) => {
			const candidate = entry as { type: string; customType?: string };
			return candidate.type === 'custom' && candidate.customType === 'plan-mode';
		}) as { data?: PlanModeEntryData } | undefined;

		state = forcePlan
			? ({ ...createPlanState('planning'), runtimeSnapshot: captureRuntimeSnapshot(pi, ctx) } as PlanRuntimeState)
			: (restorePlanState(planModeEntry?.data) as PlanRuntimeState);

		if (
			state.mode === 'executing' &&
			(state.todos.length === 0 || state.todos.every((todo) => todo.status === 'completed'))
		) {
			resetPlanState('normal');
			persistState();
		}

		await enterMode(ctx, state.mode);
		if (state.mode === 'approval') {
			if (ctx.hasUI) {
				showPlanProposal(state.pendingPlan);
				await promptForPlanExecution(ctx, state.pendingPlan);
			} else {
				state.mode = 'planning';
				persistState();
			}
		}
	}

	pi.on('session_start', async (_event, ctx) => {
		if (!configDiagnosticsShown && configDiagnostics.length > 0 && ctx.hasUI) {
			configDiagnosticsShown = true;
			for (const diagnostic of configDiagnostics) ctx.ui.notify(diagnostic.message, 'warning');
		}
		const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
		for (const phase of ['plan', 'execute', 'normal'] as const) {
			const tools = config.profiles?.[phase]?.tools;
			if (!tools) continue;
			const validTools = tools.filter((tool) => knownTools.has(tool));
			for (const tool of tools.filter((tool) => !knownTools.has(tool))) {
				if (ctx.hasUI) ctx.ui.notify(`Plan config: unknown tool in ${phase} profile: ${tool}`, 'warning');
			}
			if (validTools.length > 0 || tools.length === 0) {
				config.profiles![phase]!.tools = validTools;
			} else {
				delete config.profiles![phase]!.tools;
			}
		}
		await restoreCurrentBranch(ctx, pi.getFlag('plan') === true);
	});

	pi.on('model_select', (event, ctx) => {
		const model = event.model as { provider?: unknown; id?: unknown; modelId?: unknown; name?: unknown };
		const provider = typeof model.provider === 'string' ? model.provider : undefined;
		const modelId =
			typeof model.id === 'string' ? model.id : typeof model.modelId === 'string' ? model.modelId : model.name;
		activeModel = provider && typeof modelId === 'string' ? { provider, model: modelId } : undefined;
		updateStatus(ctx);
	});

	pi.on('session_tree', async (_event, ctx) => {
		await restoreCurrentBranch(ctx);
	});
}
