# Plan Mode Extension

Planning mode for safe code analysis, with a read-only bash allowlist, phase-based model routing, and a centralized state machine.

## State Machine

```
normal ──/plan──→ planning ──propose_plan──→ approval ──Execute──→ executing ──all done──→ normal
                     ↑                          │  │                                      │
                     │        ┌──dismiss/Escape──┘  └──Quit──→ normal                       │
                     │        ├──refine/context──→ planning                                │
                     │        └──edit/save──→ executing; cancel stays in approval          │
                     └──toggle──────────────────────────blocked/limit──→ normal
```

All transitions are centralized in `transition()` (`constants.ts`). Event handlers emit `PlanEvent` values; `transition()` returns the new mode + actions; callers execute them via `executeActions()`.

States: `normal | planning | approval | executing`

## Features

- **Centralized state machine**: All mode transitions go through `transition(mode, event) → { mode, actions[] }`
- **Broad planning tools**: Keeps configured read-only plan tools available and always adds `propose_plan`
- **Fail-closed bash allowlist**: Auto-allows only known read-only commands and blocks every non-whitelisted command; supports manual exact/prefix extensions for reviewed inspection commands
- **Write-tool hard block**: Blocks edit, write, and apply_patch tool calls while Plan Mode is active
- **Structured plan approval**: Renders the complete `propose_plan` result before opening the harness approval UI
- **Proposal refinement**: Accepts additional context and asks the agent for one complete revised proposal without adding another runtime state
- **Structured task progress**: Uses `plan_task_update` during execution as the canonical progress protocol
- **Living plan**: During execution the agent may call `plan_task_update` with a full `plan` array (plus `explanation`) to add, remove, reorder, or split steps; existing task ids are reused by matching step text, so the approved plan adapts to reality without re-approval (mirrors Codex `update_plan`). At most one step should be `in_progress` at a time.
- **Auto-continuation**: Continues approved execution while structured task progress is reported, with two no-progress retry turns and a safety limit
- **Progress tracking**: Widget shows completion status during execution
- **Session persistence**: Current-schema state survives session resume and branch navigation
- **Runtime restoration**: Restores the model, thinking level, and active tools that were active before Plan Mode
- **Phase profiles**: Per-phase override of provider, model, thinking level, tools, and context

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Alt+I` - Toggle plan mode (shortcut)
- `--plan` - Start Pi in plan mode

## Configuration

Configuration is loaded from `~/.pi/agent/plan.json`. If the file does not exist, built-in defaults are used.

### Phase Profiles

Each phase (`plan`, `execute`, `normal`) has an optional profile with these fields:

| Field      | Type                                                         | Description                                              |
|------------|--------------------------------------------------------------|----------------------------------------------------------|
| `provider` | `string`                                                     | Provider name (e.g. `anthropic`, `openai`)               |
| `model`    | `string`                                                     | Model name (e.g. `claude-4-opus`, `gpt-4o`)              |
| `thinking` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Reasoning effort level                                   |
| `tools`    | `string[]`                                                   | Active tools for the phase                              |
| `context`  | `string`                                                     | System prompt injected at phase start                    |
| `instructions` | `string[]`                                               | Extra phase instructions appended as bullets             |
| `planCommandAllow` | `{ exact?: string[], prefixes?: string[] }`             | Extra Plan Mode bash commands to auto-allow             |

### Defaults

If `plan.json` does not exist or a phase key is missing, the following defaults apply:

| Phase    | Thinking   | Tools                                                       | Context                                            |
|----------|------------|-------------------------------------------------------------|----------------------------------------------------|
| `plan`   | `high`     | `read`, `bash`, `grep`, `find`, `ls`, `ask_user_question`, `propose_plan` | Prompts strong reasoning, focus on analysis, no edits |
| `execute`| `medium`   | `read`, `bash`, `edit`, `write`, `plan_task_update`          | Implementation-focused reasoning, minimal diffs    |
| `normal` | Restored   | Restored from the pre-plan runtime snapshot                 | (none)                                             |

User-provided fields in `plan.json` are shallow-merged over these defaults. Only the fields you specify need to be included. The normal profile has no built-in overrides; explicit normal fields are applied after restoring the pre-plan runtime snapshot. Plan-internal tools are phase-scoped: `propose_plan` is removed outside planning/approval, and `plan_task_update` is removed outside execution.

### Example `~/.pi/agent/plan.json`

```json
{
  "profiles": {
    "plan": {
      "provider": "anthropic",
      "model": "claude-4-opus",
      "thinking": "high",
      "context": "Focus on architecture risks and trade-offs.",
      "instructions": [
        "Plan Mode is read-only by default.",
        "Put checks that may write caches or generated files into proposal verification."
      ],
      "planCommandAllow": {
        "exact": ["npm --prefix ../npm list"],
        "prefixes": ["npm --prefix ../npm view"]
      }
    },
    "execute": {
      "provider": "anthropic",
      "model": "claude-4-sonnet",
      "thinking": "low"
    }
  }
}
```

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. For implementation, fix, refactor, or "execute/proceed/continue/apply changes" requests, the agent applies a clarification gate: resolve material user decisions that repo context cannot answer, then call `propose_plan` with `title`, `summary`, ordered `steps`, optional `assumptions`, optional `verification`, optional `risks`, optional `files`, and optional `references` (reference projects/issues/docs used to inform the plan, display only). Design questions in Plan Mode and use `ask_user_question` only to present them and collect answers. Group independent decisions when useful; for dependent decisions, ask one question, wait for the answer, and design the next question from it. The `summary` should capture key code findings, constraints, and implementation judgment needed during execution.
4. Review the complete proposal displayed directly in the TUI, then choose `Execute plan`, `Start new session`, `Refine plan`, `Edit plan`, or `Quit plan`. `Start new session` opens a child session linked to the current session and places only the approved structured plan in its editor; it does not copy the planning transcript. `Refine plan` accepts additional context and requests a complete revised proposal. Execution starts automatically after approval; saving an edited plan also starts execution with the edited steps.
5. During execution, the agent updates task state with `plan_task_update` (`pending`, `in_progress`, `completed`, or `blocked`).
6. If more steps remain, Plan Mode automatically sends hidden continuation follow-ups. If a turn forgets to report task progress, Plan Mode retries twice with a stronger hidden reminder before marking execution blocked.
7. The status bar shows completion count, and the progress widget shows only the current or next step.

The complete proposal is returned as the visible `propose_plan` tool result and does not force-terminate the turn, so the agent can ask one clarifying `ask_user_question` follow-up or annotate the proposal in the same turn before yielding. The approval selector opens at `agent_end`, after the tool result has rendered in the TUI. Restored approval sessions redisplay the proposal as a `[plan-proposal]` message before reopening the selector. After approval, execution context includes compact approved plan metadata plus remaining steps. `Refine plan` preserves the current proposal, sends the additional context through a hidden follow-up, and requires one complete revised `propose_plan` response. New context takes precedence where it conflicts with the current proposal. `Edit plan` directly replaces the pending plan and starts execution after successful validation. Invalid edits reopen the approval flow instead of executing. Confirming execution or saving an edited plan sends a hidden follow-up handoff turn so approval made from the UI starts reliably without adding protocol noise to the chat. Plain yes/no chat replies are not treated as approval. Plain chat requests such as `execute`, `proceed`, `continue`, `apply`, `执行`, `继续`, or `应用` while still in planning mean the agent should submit the complete current or revised proposal with `propose_plan`, not return a prose-only execution-step breakdown. Cancelling the refinement or edit dialog returns to approval; dismissing the approval selector returns to planning. Running `/plan` during execution clears the active execution state and exits Plan Mode.

## How It Works

### State Machine

All state transitions are centralized in `transition(mode, event)` in `constants.ts`. The function is pure — it returns a new mode and a list of `TransitionAction` values, with no side effects. Event handlers call `transition()`, update `state.mode`, then execute the returned actions via `executeActions()`.

Transition table:

| From | Event | To | Actions |
|------|-------|----|---------|
| `normal` | `TOGGLE` | `planning` | reset, apply phase, notify |
| `planning` | `TOGGLE` | `normal` | reset, apply phase, notify |
| `planning` | `PROPOSE` | `approval` | persist, update status; `agent_end` opens approval UI |
| `approval` | `EXECUTE` | `executing` | apply phase, persist, update status |
| `approval` | `REFINE_SUBMITTED` | `planning` | persist, update status, send hidden refinement follow-up |
| `approval` | `EDIT` | `approval`/`executing` | caller handles editor; cancel stays in approval, saving starts execution |
| `approval` | `PROPOSE` | `approval` | replace plan, persist; `agent_end` opens approval UI |
| `approval` | `DISMISS` | `planning` | persist, update status |
| `approval` | `QUIT` | `normal` | reset, apply phase, notify |
| `executing` | `ALL_COMPLETE` | `normal` | finish execution (success) |
| `executing` | `TASK_BLOCKED` | `normal` | finish execution (blocked) |
| `executing` | `CONTINUE` | `executing` | persist, update status, send handoff |
| `executing` | `NO_PROGRESS_RETRY` | `executing` | persist, update status, send no-progress continuation |
| `executing` | `CONTINUATION_LIMIT` | `normal` | finish execution (blocked) |

### Phase Profiles

The extension defines three phases, each with an independent profile:

- **plan** — planning and exploration with read-only bash checks and high reasoning effort; switches model if configured
- **execute** — restores the pre-plan tool set plus `plan_task_update`, unless explicitly configured; removes `propose_plan`; switches model if configured
- **normal** — restores the runtime snapshot captured before Plan Mode, then applies explicit normal profile overrides, with Plan-internal tools removed

When a phase is entered (`togglePlanMode`, executing plan, session resume), the extension:
1. Sets the active tool list via `pi.setActiveTools`
2. Optionally switches thinking level
3. Optionally switches the model via the model registry
4. Injects a context message on the next agent start

If the configured `provider`/`model` pair is not found in the registry, a warning notification is shown and the current model is kept.

- Plan phase filters `edit`, `write`, `apply_patch`, and namespaced variants from the configured tool list, then always adds `propose_plan` so structured approval remains available. Write-tool guards remain as defense in depth. Bash commands use a read-only allowlist and optional manual allowlist; every non-whitelisted command is blocked. Execute phase always includes `plan_task_update` so progress remains structured, and normal phase removes Plan-internal tools even if they appear in a restored snapshot or explicit normal profile.

### Plan Mode
- Configured read-only plan tools remain available, with write tools filtered and `propose_plan` always added
- Plan Mode instructions tell the agent to default to read-only inspection and move uncertain checks into the proposal
- `edit`, `write`, and `apply_patch` tool calls are hard-blocked
- Built-in read-only bash commands auto-run; non-whitelisted bash commands block in both UI and non-UI modes
- Repeated safe commands can be added to `profiles.plan.planCommandAllow`
- Requests to implement, edit, execute, continue, proceed, or apply changes are treated as requests to submit an executable proposal with `propose_plan`
- Agent designs clarifying questions when material user decisions cannot be inferred from local context and uses `ask_user_question` only for presentation and answer collection
- Independent decisions may be grouped in one call; dependent decisions are asked serially, with each follow-up designed after the prior answer
- If it does not ask, `assumptions` should explain low-risk defaults and why no material clarification was needed
- Agent calls `propose_plan` without making changes
- Agent never asks the user to exit Plan Mode to make changes; approval performs the execution handoff
- Approved structured proposals are retained through execution and injected as compact execution context
- Refinement carries the current proposal and additional user context forward and requires a complete revised proposal
- Blocked write commands explicitly instruct the agent to stop retrying write-capable shell commands and produce a plan instead
- The approval UI provides the user-controlled handoff into execution mode
- `Start new session` creates a child session with the approved plan as an editable draft and preserves the source planning session
- Cancelling the approval/refinement/edit UI keeps the pending plan instead of clearing it
- `/plan` during execution clears the active execution state and exits Plan Mode

### Execution Mode
- Pre-plan tool access restored, with `propose_plan` removed and `plan_task_update` added
- Agent executes steps in order
- `plan_task_update` tracks task state by stable task id
- A single-task call updates one `taskId` to a new `status` (with optional `message`); a whole-plan call passes a full `plan` array of `{ step, status }` plus an `explanation` to add, remove, reorder, or split steps, reusing existing task ids by matching step text (living plan; at most one `in_progress` at a time)
- Automatic continuation sends the next execution follow-up while steps remain and progress is being marked
- No-progress turns get two automatic retries before Plan Mode marks execution blocked and clears the active state
- Tasks marked `blocked` stop execution immediately and clear the active state
- Completing the final task terminates the current agent turn immediately; `agent_end` then sends completion and returns to `normal`
- Widget shows progress
- When all steps are marked done, a completion message is sent and mode returns to `normal`
- Returning to normal removes `propose_plan` and `plan_task_update` from the active tool list

### Session Restore

State is persisted with `schemaVersion`, a single `mode` value (`normal`, `planning`, `approval`, or `executing`), todo items, pending plan data, the pre-plan runtime snapshot, continuation count, and no-progress continuation count. On `session_start` and `session_tree`:

1. The last `plan-mode` entry on the current branch is loaded
2. Entries from older schemas are ignored and Plan Mode starts in `normal`
3. `--plan` overrides restored state and starts a fresh planning session
4. If resuming an active execution, the extension trusts persisted task state
5. Interactive approval state redisplays the pending proposal before reopening the approval UI; non-interactive approval state returns to planning
6. The active phase profile is derived from `mode` and reapplied

### Bash Guard

Plan Mode uses a simple exact/prefix allowlist model instead of trying to detect every possible side effect:
- Built-in exact and prefix commands are allowed, including common search, file inspection, Git inspection, and package metadata commands.
- Simple chains and pipelines using `&&`, `||`, `|`, or `;` are allowed only when every segment is allowlisted.
- Redirects are not auto-allowed, except stderr suppression such as `2>/dev/null`; backticks and `$()` are not auto-allowed.
- Dependency installs, Git mutations, service/process/database commands, and unknown commands are not auto-allowed unless manually added.
- All non-whitelisted bash commands are blocked in both UI and non-UI modes. Move them into `propose_plan.verification` and run them only after execution approval.

Add recurring safe project-specific commands to `profiles.plan.planCommandAllow` in `~/.pi/agent/plan.json`. Use `exact` for full command matches and `prefixes` for command starts such as `npm --prefix ../npm list`. Use `profiles.plan.instructions` for behavior guidance, and `planCommandAllow` only for commands that should auto-run in Plan Mode. `/undo` remains limited to approved `edit`/`write` file changes and does not roll back shell mutations.

## Tirith integration (optional)

Plan Mode can enrich its bash guard with [tirith](https://github.com/sheeki03/tirith), a terminal/command security scanner (homograph URLs, `curl | bash`, base64 decode-execute, data exfiltration, obfuscated payloads, malicious packages/domains). Enable it via the top-level `tirith` key in `~/.pi/agent/plan.json`:

```json
{
  "tirith": {
    "enabled": true,
    "binary": "tirith",
    "timeoutMs": 10000,
    "warnAction": "allow"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Opt in to tirith enrichment. |
| `binary` | `string` | `$TIRITH_BIN` or `tirith` | Override the tirith binary path. |
| `timeoutMs` | `number` | `10000` | `execFileSync` timeout for `tirith check`. |
| `warnAction` | `"allow"` \| `"deny"` | `$TIRITH_HOOK_WARN_ACTION` or `allow` | `allow` keeps the caller's severity and surfaces findings in the reason; `deny` escalates a tirith warning to a hard block. |

Behavior contract — tirith is **enrichment-only and can only strengthen**:

- Only commands Plan Mode already blocks are scanned (allowlisted read-only commands skip tirith, so there is no per-command overhead).
- tirith block (exit 1), or warn (exit 2) with `warnAction: "deny"` → escalate to `destructive` (hard block, no confirmation prompt) and append findings to the reason.
- tirith warn (exit 2) with `warnAction: "allow"` → keep Plan Mode's severity, append findings to the reason so they reach the agent and the approval prompt.
- tirith clean (exit 0) or error (missing binary / timeout / unexpected exit) → Plan Mode's own decision stands unchanged. A missing or erroring tirith binary never opens a hole.

Findings are folded into the blocked `reason`, which is shown to the agent, so the agent can cite them in `propose_plan` `risks`/`verification`. Install tirith separately (`brew install tirith`); this extension does not install or vendor it. `TIRITH_BIN`, `TIRITH_HOOK_WARN_ACTION` env vars are respected for parity with tirith's own Pi CLI extension.

## Status Bar

The status indicator shows different information per phase:

| Mode        | Indicator                                                     |
|-------------|---------------------------------------------------------------|
| `plan`      | `⏸ plan` (warning color)                                      |
| `execute`   | `📋 3/5` (accent color) with progress count                   |
| `normal`    | Hidden                                                        |

If a profile overrides `provider`/`model`, the status shows the successfully selected model, such as `⏸ plan anthropic/claude-4-opus high`.
If a profile overrides `thinking`, the status shows `⏸ plan high`.

A widget (`plan-todos`) renders only the current in-progress step, blocked step, or next pending step. Full task details remain available through `/todos`.
