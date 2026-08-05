import { describe, expect, it } from "vitest";
import { transition, transitionApproval } from "../constants.js";

const plan = {
	title: "Plan",
	summary: "Summary",
	steps: ["Change code"],
	assumptions: [],
	verification: [],
	risks: [],
	files: [],
	references: [],
};

describe("approval transitions", () => {
	it("defers approval UI until agent_end after a new proposal", () => {
		const result = transition("planning", { type: "PROPOSE", plan });

		expect(result.mode).toBe("approval");
		expect(result.actions.map((action) => action.type)).toEqual([
			"persist",
			"update_status",
		]);
	});

	it("supports a replacement proposal while approval is open", () => {
		const result = transition("approval", { type: "PROPOSE", plan });

		expect(result.mode).toBe("approval");
		expect(result.actions.map((action) => action.type)).toEqual([
			"persist",
			"update_status",
		]);
	});

	it("keeps refine and edit as distinct approval actions", () => {
		expect(transitionApproval("Refine plan").effect).toBe("open_refinement");
		expect(transitionApproval("Edit plan").effect).toBe("open_editor");
		expect(transitionApproval("Execute plan").effect).toBe("start_execution");
		expect(transitionApproval("Start new session").effect).toBe("start_new_session");
	});
});
