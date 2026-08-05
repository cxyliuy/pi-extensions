# Pi Extensions

Local Pi agent extensions for `~/.pi/agent/extensions`.

Pi auto-discovers directory-style extensions from `~/.pi/agent/extensions/*/index.ts` and file-style extensions such as `rtk.ts`. After editing an auto-discovered extension, reload Pi with `/reload`.

Official extension docs: https://pi.dev/docs/latest/extensions

## Extensions

- `plan/` - Plan Mode extension for read-only exploration, plan extraction, todo progress, and execution handoff.
- `review/` - Focused read-only review command for current changes or a specified scope.
- `goal/` - Persistent task goal tracking modeled on Codex `/goal`.
- `loop/` - Scheduled loop tasks that periodically trigger an agent prompt.
- `init/` - Project instruction initializer modeled on Codex `/init` with Claude Code options.
- `buddy/` - Local terminal companion modeled on Claude Code `/buddy`.
- `usage/` - Provider quota and balance queries for selected model providers.
- `undo/` - Restore files changed by the last Pi edit/write tool turn.
- `tooling/` - Always-on tool selection and git commit hygiene guidance that nudges agents toward `rg`, `fd`, `jq`, `yq`, `uvx`, `npx`, `httpie`, and Context7.
- `web/` - Web search and URL content fetching tools backed by Firecrawl, Exa, and native fetch.
- `ask-user-question/` - Neutral `ask_user_question` interaction tool (1–4 caller-supplied questions, 2–4 options each) for Plan Mode, skills, and general use. Question design and follow-up strategy remain with the caller. 精简 bilingual (zh/en) fork of `@juicesharp/rpiv-ask-user-question`, zero external deps.
- `rtk.ts` - RTK transparent bash proxy that rewrites supported commands through `rtk rewrite` for compact output.

## Usage

- Toggle Plan Mode with `/plan`.
- Show current plan progress with `/todos`.
- Start Pi in Plan Mode with `--plan`.
- Review current changes with `/review` or a scope with `/review <scope>`.
- Set a persistent goal with `/goal <objective>`, pause/resume it with `/goal pause` and `/goal resume`, or clear it with `/goal clear`.
- Start a scheduled loop with natural language like `/loop 每天8点查找我的邮件`, list loops with `/loop list`, pause/resume/remove with `/loop pause|resume|rm <id>`.
- Initialize project instructions with `/init`, `/init codex`, or Claude variants like `/init claude all`.
- Hatch or show a local buddy with `/buddy`, pet it with `/buddy pet`, or hide it with `/buddy off`.
- Query selected provider quota or balance with `/usage`.
- Restore the last Pi edit/write changes with `/undo` or inspect the current snapshot with `/undo show`.
- Use `web_search` and `fetch_content` from the agent tools after configuring `FIRECRAWL_API_KEY`, `EXA_API_KEY`, or `~/.pi/agent/web.json`.

See `plan/README.md` for detailed Plan Mode behavior and command allowlist notes, `review/README.md` for review command behavior, `goal/README.md` for goal tracking behavior, `loop/README.md` for scheduled loop behavior, `init/README.md` for instruction initialization behavior, `buddy/README.md` for buddy command behavior, `usage/README.md` for quota query behavior, `undo/README.md` for undo behavior, and `web/README.md` for web provider configuration.
