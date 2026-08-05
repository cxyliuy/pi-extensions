# ask-user-question

A structured question presentation and answer-collection tool (`ask_user_question`) for [Pi Agent](https://github.com/earendil-works/pi-coding-agent). Present 1–4 caller-supplied questions, each with 2–4 typed options plus an auto-appended free-text "Type something." row on every single-select question. The caller (for example, Plan Mode or a skill) owns question design and follow-up strategy.

**This is a 精简 fork of [`@juicesharp/rpiv-ask-user-question`](https://pi.dev/packages/@juicesharp/rpiv-ask-user-question) v2.0.0 (MIT, by juicesharp).** It is an independent, self-contained reimplementation — not a re-export — and diverges deliberately to stay lightweight and dependency-free for this repo's question interaction layer.

## Why a fork

The upstream package is excellent and full-featured, but pulls in `@juicesharp/rpiv-config`, optionally `@juicesharp/rpiv-i18n`, and `typebox`, and ships ~40 source files (preview pane, per-option notes, submit-tab review, 9-locale SDK, RPC dialog walker, reconciler, collapse-key overlay toggle, session-graph prewarm). This fork keeps only what the local Plan Mode clarification gate needs and resolves bilingual locale from the environment directly — **zero external npm dependencies**.

## Features

- **Single-select** questions via pi's built-in `ctx.ui.select` + free-text fallback via `ctx.ui.input` (also works in RPC mode through the select/input sub-protocol).
- **Multi-select** questions via `ctx.ui.custom` with a minimal inline checkbox-list component (Space toggle, Enter submit, Esc cancel).
- **Auto-appended "Type something." row** on every single-select question — the model never authors it; reserved labels (`Other`, `Type something.`, `Next`) are rejected at validation time.
- **Bilingual zh / en** in-dialog chrome, resolved from `LC_ALL` → `LC_MESSAGES` → `LANG` (`zh*` → 中文, `en*` → English, default English). LLM-facing copy (tool description, schema, response envelope, errors) stays English by design for reliable model interpretation.
- **Pure validation + envelope helpers** with unit tests; no TUI required to test the contract.

## Install

No install needed. Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`, so placing this directory here registers the tool on the next session start (or `/reload`).

## Tool

### `ask_user_question`

```ts
ask_user_question({
  questions: [
    {
      question: string,      // ends with "?"
      header: string,        // chip label, max 16 chars
      options: [             // 2–4 options
        { label: string, description: string },
      ],
      multiSelect?: boolean, // default false
    },
    // … 1–4 questions total
  ],
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }], // "User has answered your questions: …" or "User declined to answer questions"
  details: {
    answers: Array<{ questionIndex: number, question: string, kind: "option"|"custom"|"multi", answer: string|null, selected?: string[] }>,
    cancelled: boolean,
    error?: "no_ui" | "no_questions" | "too_many_questions" | "duplicate_question" | "empty_options" | "too_many_options" | "reserved_label" | "duplicate_option_label",
  },
}
```

Esc at any prompt cancels the whole questionnaire and resolves `cancelled: true`.

## Differences vs upstream

| Feature | Upstream v2.0.0 | This fork |
|---|---|---|
| Preview pane (option `preview` markdown) | ✅ | ❌ |
| Per-option notes (`n` to add) | ✅ | ❌ |
| Submit-tab review | ✅ | ❌ |
| Locales | 9 via `rpiv-i18n` SDK | zh + en, env-resolved |
| RPC dialog walker | ✅ | ❌ (select/input primitives work in RPC directly) |
| Reconciler | ✅ | ❌ |
| Collapse-key overlay toggle | ✅ | ❌ |
| Session-graph prewarm | ✅ | ❌ |
| Multi-select typed custom answer | ✅ | ❌ (Esc and re-ask in chat) |
| Dependencies | `rpiv-config`, `typebox`, optional `rpiv-i18n` | none |

## Layout

```
ask-user-question/
  index.ts        # extension factory, tool registration, locale detect
  types.ts        # constants, interfaces, plain JSON Schema
  validate.ts     # pure validateQuestionnaire
  envelope.ts     # LLM-facing response envelope (English)
  i18n.ts         # zh/en string tables + detectLocale
  dialog.ts       # runQuestionnaire via ctx.ui primitives + MultiSelect
  __tests__/
    validate.test.ts
    envelope.test.ts
    i18n.test.ts
```

## Verify

```bash
cd ~/.pi/agent/extensions/ask-user-question
npx --yes vitest run        # 31 tests
```

Manual: `/reload`, then a caller such as Plan Mode or a skill can call `ask_user_question` to present its designed questions and collect answers.

## License

MIT. Derivative of `@juicesharp/rpiv-ask-user-question` © juicesharp.
