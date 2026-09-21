# Human Decision Console — Default Template Contract

Status: REVIEW_CANDIDATE. This contract freezes the visual, interaction and artifact-shape defaults of the CanonFlow Human Decision Console (HDC). The canonical implementation is `decision-console/index.html`.

## 0. Two surfaces, one visual contract (HDC v1)

Since HDC v1 there are two HDC surfaces:

1. **The local console app** (primary): the packaged application under
   `decision-console/app/`, served at `http://127.0.0.1:<port>/`. Its frontend
   (Overview · Decisions · Workspace · History · Traceability · Project state ·
   Diagnostics) implements this same visual contract — dark session header,
   paper/card layout, seal palette, risk chips, decision rail, canonical
   eight sections — plus the console navigation. Answer submission happens
   here; section 7 is **Send answers** (server-published ANS), not an export.
2. **The static session HTML** (compatibility): `decision-console/index.html`
   rendered sessions, usable without the server, Mode 1 export flow.

This document binds both. Changes to the shared look/layout/interaction model
update the console frontend and this template together; the compatibility HTML
keeps working unchanged (already-emitted files are never regenerated). The
console never offers a second parallel HTML submission path, and the renderer
never degrades a session state or fabricates paths.

## 1. Authority

`decision-console/index.html` is the default HDC template for every generated question session in compatibility mode. `scripts/render_question_session.py` must render by embedding `QS-xxxx.questions.json` into this template unless a caller explicitly passes `--console` for a controlled override.

Generated session HTML files under `.canonflow/decision-sessions/pending/` are rendered outputs, not design authorities. When a generated session looks correct, its durable source is still the console template and this contract.

## 2. Non-negotiable style defaults

The default template preserves the current CanonFlow HDC visual language:

- self-contained static HTML: no network, no build step, no external fonts, no external CSS or JS;
- system-font UI with calm professional density, optimized for executive and operator review;
- paper/card visual model: muted paper background, white cards, soft borders, rounded corners;
- dark session header with compact metadata grid;
- CanonFlow seal accent palette using `--seal`, `--seal-soft` and `--seal-ink`;
- risk-tier chips using the `--t0` through `--t4` tokens;
- sticky left decision rail with live progress, required-question markers and section navigation;
- visually separated canonical sections, numbered with compact badges;
- question cards with guidance, recommendations, risk/impact/tradeoff detail and optional comments;
- accessible focus states and reduced-motion support;
- bilingual UI chrome driven by `ui_language`.

## 3. Required layout

Every default HDC session uses the eight canonical sections from `method/15`:

```text
1 Context
2 Decision required
3 Recommended options
4 Risks and impact
5 Questions
6 Answer summary
7 Export answers (console: Send answers)
8 What you must do now
```

The session header must show the session title, session id, generated timestamp, state and relevant metadata. The rail must remain the signature navigation element and must not be removed in alternate renderers.

## 4. Required interaction behavior

The default template must keep:

- required-answer validation before export;
- live completion percentage;
- option selection highlighting;
- answer summary before export;
- Mode 1 JSON export as mandatory baseline;
- optional Mode 2 File System Access API save when the browser supports it;
- exact final instructions telling the human where to place `QS-xxxx.answers.json`.

Mode 1 must always work from `file://`.

## 5. Allowed customization

Projects may add a logo or minor local branding through `decision-console/assets/`, but must not remove the decision rail, canonical sections, export behavior, validation behavior or traceability instructions.

Project-specific HDC styling is an extension. It must not overwrite the core template unless approved as a method change.

## 6. Template update rule

Any change to the default HDC look, layout, interaction model or save flow must update:

1. `decision-console/index.html`;
2. this contract;
3. `decision-console/README.md` when user-facing generation behavior changes;
4. `method/15-human-decision-console.md` when the method guarantee changes;
5. `CHANGELOG.md`.

Generated session files are never edited to become the template. The template is changed first, then sessions are regenerated from it.
