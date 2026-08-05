/**
 * ask-user-question — Pi extension.
 *
 * Forked (精简) from @juicesharp/rpiv-ask-user-question v2.0.0 (MIT, juicesharp).
 * This is an independent, self-contained reimplementation: zero external npm
 * dependencies (no @juicesharp/rpiv-config, rpiv-i18n, or typebox), bilingual
 * zh/en locale resolved from the environment, and a minimal dialog built on
 * pi's built-in ctx.ui.select / ctx.ui.input / ctx.ui.custom primitives.
 *
 * Dropped vs upstream (tracked as deliberate fork differences): preview pane,
 * per-option notes, submit-tab review, 9-locale SDK, RPC dialog walker,
 * reconciler, collapse-key toggle, session-graph prewarm.
 *
 * Registers the `ask_user_question` tool: present 1-4 structured questions,
 * each with 2-4 options plus an auto-appended "Type something." custom row on
 * every single-select question. Returns the user's selections or a decline.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { buildQuestionnaireResponse, buildToolResult } from './envelope.js';
import { runQuestionnaire, type DialogContext } from './dialog.js';
import { detectLocale, stringsFor } from './i18n.js';
import {
	ASK_USER_QUESTION_TOOL_NAME,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	QuestionParamsSchema,
	type QuestionParams,
} from './types.js';
import { validateQuestionnaire } from './validate.js';

const ERROR_NO_UI = 'Error: UI not available (running in non-interactive mode)';

const DEFAULT_PROMPT_SNIPPET = `Present 1-${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) and collect the user's answers`;

const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Present the caller-supplied questions and collect the user's answers. The caller decides when to ask, how many questions to provide, and whether to continue with follow-up questions.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description. The user can type a custom answer via the automatically appended "Type something." row, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels — reserved labels are rejected at runtime.`,
	'Set multiSelect: true when the caller permits multiple selections; otherwise use the default single-select behavior.',
];

export default function (pi: ExtensionAPI): void {
	const locale = detectLocale();
	const str = stringsFor(locale);

	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: 'Ask User Question',
		description: [
			"Present one or more caller-supplied structured questions and collect the user's answers.",
			'This tool is an interaction primitive: the caller decides when to ask, how many questions to provide, and whether to ask follow-ups.',
			'',
			'Usage notes:',
			'- Users type a custom answer via the auto-appended "Type something." row on every single-select question, or press Esc to cancel.',
			'- Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.',
			'- Use multiSelect: true when multiple selections are permitted.',
		].join('\n'),
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) {
				return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: 'no_ui' });
			}
			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}
			const dialogCtx: DialogContext = {
				hasUI: ctx.hasUI,
				ui: ctx.ui as unknown as DialogContext['ui'],
			};
			const result = await runQuestionnaire(dialogCtx, typed, str);
			if (result.cancelled) ctx.ui.notify?.(str.cancelledNotify, 'info');
			return buildQuestionnaireResponse(result, typed);
		},
	});
}

export { ASK_USER_QUESTION_TOOL_NAME } from './types.js';
export { detectLocale, stringsFor } from './i18n.js';
export { validateQuestionnaire } from './validate.js';
