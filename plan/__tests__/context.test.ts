import { describe, expect, it } from "vitest";
import { buildPlanModeContext } from "../context.js";

const baseInput = {
	activePlanTools: ["read", "bash", "questionnaire", "propose_plan"],
	phase: "plan" as const,
	phaseContext: "",
	supplementalInstructions: "",
};

describe("buildPlanModeContext", () => {
	it("directs execute-style requests to propose_plan instead of prose-only steps", () => {
		const context = buildPlanModeContext(baseInput);

		expect(context).toContain("execute, continue, proceed, or apply changes");
		expect(context).toContain("执行, 继续, 应用, or 开始改");
		expect(context).toContain("call propose_plan");
		expect(context).toContain("Do not answer an execution request by only decomposing execution steps in plain text");
		expect(context).toContain("For independent material decisions, you may provide multiple questions in one call");
		expect(context).toContain("For dependent decisions, ask one question, wait for the answer");
	});

	it("preserves a pending proposal as the basis for execution requests", () => {
		const context = buildPlanModeContext({
			...baseInput,
			pendingPlan: {
				title: "Fix plan",
				summary: "Use the existing plan.",
				steps: ["Update the prompt", "Verify the behavior"],
				assumptions: [],
				verification: [],
				risks: [],
				files: [],
			},
		});

		expect(context).toContain("Pending proposal already exists");
		expect(context).toContain("Title: Fix plan");
		expect(context).toContain("If the user says execute, continue, proceed, apply, 执行, 继续, 应用, or 开始改");
		expect(context).toContain("Call propose_plan with the complete current or revised proposal");
		expect(context).toContain("do not produce a new prose-only task breakdown");
	});
});
