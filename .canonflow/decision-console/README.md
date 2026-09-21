# Human Decision Console — app

Self-contained static HTML (`index.html`). No network, no dependencies, no
build step; system fonts only, works from `file://`.

## Default template authority

`index.html` is the CanonFlow default HDC template. Generated session files under
`.canonflow/decision-sessions/pending/` are rendered outputs; they do not become
the source of truth for the visual system. The visual, layout and interaction
rules are captured in `TEMPLATE_CONTRACT.md`.

The default style preserves the current HDC experience: dark session header,
metadata grid, muted paper/card layout, CanonFlow seal accents, risk-tier chips,
sticky decision rail, canonical eight-section flow, required-answer validation,
answer summary, JSON export and exact final save instructions.

## Two ways to open a session

1. **Self-contained session (normal path)**: the agent runs
   `python scripts/render_question_session.py QS-xxxx.questions.json` — this
   embeds the questions JSON into a copy of this app and writes
   `QS-xxxx.html` next to it. The human just opens that file.
2. **Bare console**: open `index.html` directly and load any
   `*.questions.json` via the file picker or drag-and-drop.

## Save modes (method/15)

- **Mode 1 (default, always available)**: "Export answers JSON" downloads
  `QS-xxxx.answers.json`; section 8 tells the human exactly where to place it.
- **Mode 2 (optional)**: if the browser supports the File System Access API,
  a second button saves directly into a chosen folder. Feature-detected;
  hidden otherwise.
- **Mode 3 (future)**: local helper that receives and writes the JSON —
  intentionally not shipped in v1.

## Supported question types

single_choice, multi_choice, yes_no, approval, risk_acceptance, free_text,
ordered_priority, confirm_or_override — with per-option guidance
(description, recommended_when, impact, risk, tradeoff, recommended badge),
required-question validation, live progress rail, answer summary and
bilingual UI chrome (en/es via `ui_language`).

`assets/` stays empty by design (single-file app); it exists for projects that
add a logo or custom CSS without touching `index.html`.

## Update rule

Do not edit a generated `QS-xxxx.html` file and treat it as the new style.
Change `index.html` first, update `TEMPLATE_CONTRACT.md`, then regenerate the
session HTML from the question JSON.
