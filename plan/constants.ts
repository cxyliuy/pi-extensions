import type { PhaseName, PlanModeStateName, ApprovalTransition, PlanEvent, TransitionResult } from './types.js';
import type { TodoItem } from './utils.js';

export const PLAN_PROPOSAL_TOOL = 'propose_plan';
export const PLAN_TASK_UPDATE_TOOL = 'plan_task_update';
export const PLAN_STATE_SCHEMA_VERSION = 3;
export const NORMAL_MODE_TOOLS = ['read', 'bash', 'edit', 'write'];
export const PLAN_MODE_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'ask_user_question', PLAN_PROPOSAL_TOOL];
export const EXECUTE_MODE_TOOLS = [...NORMAL_MODE_TOOLS, PLAN_TASK_UPDATE_TOOL];
export const PLAN_MODE_WRITE_TOOLS = new Set(['edit', 'write', 'apply_patch']);
export const APPROVAL_CHOICES = ['Execute plan', 'Start new session', 'Refine plan', 'Edit plan', 'Quit plan'] as const;
export const MAX_AUTO_CONTINUATIONS = 8;
export const MAX_NO_PROGRESS_CONTINUATIONS = 2;

export const PLAN_PROPOSAL_PARAMETERS = {
	type: 'object',
	properties: {
		title: {
			type: 'string',
			description: 'Short title for the proposed plan.',
		},
		summary: {
			type: 'string',
			description:
				'Brief summary of what the plan will accomplish, including key code findings, constraints, and implementation judgment that execution should preserve. Newlines are normalized to spaces.',
		},
		steps: {
			type: 'array',
			minItems: 1,
			items: { type: 'string' },
			description: 'Ordered implementation steps. Each item becomes one tracked todo.',
		},
		verification: {
			type: 'array',
			items: { type: 'string' },
			description: 'Optional verification commands or scenarios.',
		},
		assumptions: {
			type: 'array',
			items: { type: 'string' },
			description: 'Low-risk defaults and why no material clarification was needed.',
		},
		risks: {
			type: 'array',
			items: { type: 'string' },
			description: 'Optional risk notes to display with the plan.',
		},
		files: {
			type: 'array',
			items: { type: 'string' },
			description: 'Optional likely touched files or modules for display only.',
		},
		references: {
			type: 'array',
			items: { type: 'string' },
			description: 'Optional reference projects, issues, or docs that informed the plan. Display only.',
		},
	},
	required: ['title', 'summary', 'steps'],
	additionalProperties: false,
} as const;

export const PLAN_TASK_UPDATE_PARAMETERS = {
	type: 'object',
	properties: {
		taskId: {
			type: 'string',
			description: 'Task id of a single approved plan task to update, e.g. task-1. Required when not using the `plan` field to replace the whole plan.',
		},
		status: {
			type: 'string',
			enum: ['pending', 'in_progress', 'completed', 'blocked'],
			description: 'New status for the single task identified by `taskId`. Required when not using the `plan` field.',
		},
		message: {
			type: 'string',
			description: 'Optional short progress or blocker note for a single-task update.',
		},
		plan: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					step: { type: 'string', description: 'Task step text.' },
					status: {
						type: 'string',
						enum: ['pending', 'in_progress', 'completed', 'blocked'],
						description: 'Step status.',
					},
				},
				required: ['step', 'status'],
				additionalProperties: false,
			},
			description: 'Optional whole-plan replacement (living plan): the full ordered step list with statuses. Use this to add, remove, reorder, or split steps during execution. Existing task ids are reused by matching step text. At most one step may be in_progress.',
		},
		explanation: {
			type: 'string',
			description: 'Short rationale for a whole-plan change (which steps were added/removed/reordered/split).',
		},
	},
	required: [],
	additionalProperties: false,
} as const;

export function phaseForMode(mode: PlanModeStateName): PhaseName {
	if (mode === 'executing') return 'execute';
	if (mode === 'normal') return 'normal';
	return 'plan';
}

export function isPlanModeActive(mode: PlanModeStateName): boolean {
	return mode !== 'normal' && mode !== 'executing';
}

export function transitionApproval(choice: string | undefined): ApprovalTransition {
	if (choice === 'Execute plan') {
		return { mode: 'executing', effect: 'start_execution' };
	}
	if (choice === 'Start new session') {
		return { mode: 'approval', effect: 'start_new_session' };
	}
	if (choice === 'Refine plan') {
		return { mode: 'approval', effect: 'open_refinement' };
	}
	if (choice === 'Edit plan') {
		return { mode: 'approval', effect: 'open_editor' };
	}
	if (choice === 'Quit plan') {
		return { mode: 'normal', effect: 'quit_plan' };
	}
	return { mode: 'planning', effect: 'dismiss_approval' };
}

/**
 * Central state machine. Returns the new mode and actions to execute.
 * No side effects — callers execute the actions.
 */
export function transition(mode: PlanModeStateName, event: PlanEvent): TransitionResult {
	switch (mode) {
		case 'normal': {
			if (event.type === 'TOGGLE') {
				return {
					mode: 'planning',
					actions: [
						{ type: 'reset_state', mode: 'planning', clearTodos: true },
						{ type: 'apply_phase', phase: 'plan' },
						{ type: 'notify', message: 'Plan mode enabled. Read-only tools active — inspect code, then propose a plan for approval.', level: 'info' },
						{ type: 'persist' },
					],
				};
			}
			break;
		}

		case 'planning': {
			if (event.type === 'TOGGLE') {
				return {
					mode: 'normal',
					actions: [
						{ type: 'reset_state', mode: 'normal', clearTodos: true },
						{ type: 'apply_phase', phase: 'normal' },
						{ type: 'notify', message: 'Plan mode disabled. Full access restored.', level: 'info' },
						{ type: 'persist' },
					],
				};
			}
			if (event.type === 'PROPOSE') {
				return {
					mode: 'approval',
					actions: [
						{ type: 'persist' },
						{ type: 'update_status' },
					],
				};
			}
			break;
		}

		case 'approval': {
			if (event.type === 'APPROVAL_CHOICE') {
				if (event.effect === 'start_execution') {
					return {
						mode: 'executing',
						actions: [
							{ type: 'apply_phase', phase: 'execute' },
							{ type: 'persist' },
							{ type: 'update_status' },
						],
					};
				}
				if (event.effect === 'quit_plan') {
					return {
						mode: 'normal',
						actions: [
							{ type: 'reset_state', mode: 'normal', clearTodos: true },
							{ type: 'apply_phase', phase: 'normal' },
							{ type: 'notify', message: 'Plan mode exited.', level: 'info' },
							{ type: 'persist' },
						],
					};
				}
				if (event.effect === 'dismiss_approval') {
					return {
						mode: 'planning',
						actions: [
							{ type: 'persist' },
							{ type: 'update_status' },
						],
					};
				}
				// open_refinement and open_editor are handled by the caller because they need async UI.
			}
			if (event.type === 'REFINE_SUBMITTED') {
				return {
					mode: 'planning',
					actions: [
						{ type: 'persist' },
						{ type: 'update_status' },
					],
				};
			}
			if (event.type === 'PROPOSE') {
				return {
					mode: 'approval',
					actions: [
						{ type: 'persist' },
						{ type: 'update_status' },
					],
				};
			}
			break;
		}

		case 'executing': {
			if (event.type === 'ALL_COMPLETE') {
				return {
					mode: 'normal',
					actions: [
						{ type: 'finish_execution', completed: true },
					],
				};
			}
			if (event.type === 'TASK_BLOCKED') {
				return {
					mode: 'normal',
					actions: [
						{ type: 'finish_execution', completed: false },
					],
				};
			}
			if (event.type === 'CONTINUE') {
				return {
					mode: 'executing',
					actions: [
						{ type: 'persist' },
						{ type: 'update_status' },
						{ type: 'send_handoff', todo: event.todo, reason: 'continue' },
					],
				};
			}
			if (event.type === 'NO_PROGRESS_RETRY') {
				return {
					mode: 'executing',
					actions: [
						{ type: 'persist' },
						{ type: 'update_status' },
						{ type: 'send_no_progress_continuation', todo: event.todo },
					],
				};
			}
			if (event.type === 'CONTINUATION_LIMIT') {
				return {
					mode: 'normal',
					actions: [
						{ type: 'finish_execution', completed: false },
					],
				};
			}
			break;
		}
	}

	// Unhandled: no transition
	return { mode, actions: [] };
}
