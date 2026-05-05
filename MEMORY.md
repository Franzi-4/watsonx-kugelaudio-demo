# Session Memory

Use this file to persist context between long chat sessions and compaction events.

## User Preferences
- Language: German (informal, concise)

## Active Goal
- Enable per-session memory so answers build on prior context.

## Decisions
- Added `.cursor/rules/session-memory.mdc` to enforce reading/updating this file.
- Claims scenario now supports a hardcoded scripted dialogue (`scriptedAssistantTurns`) and both `/api/converse` plus `/api/converse/stream` consume it turn-by-turn instead of using LLM output.
- Scripted claims flow now only advances when each user turn matches expected intent/data; otherwise the system transparently falls back to normal LLM behavior.
- Added explicit UI mode toggle (`Skript` / `Free`) in the header; requests now carry `mode`, with `script` forcing the fixed dialogue and `free` using regular LLM flow.
- Script opening wording updated: replaced "HDI Versicherung" with "Ihre E-Versicherung".
- Scripted location wording simplified to "Aachener Straße in Köln" (removed "Maarweg" and "50933" from assistant readback lines).
- Header mode switch restyled from prominent segmented buttons to a subtle compact slider toggle (`Skript` ↔ `Free`).
- Header mode labels shortened to single letters (`S` / `F`) for lower visual prominence.
- Mode toggle moved from header into the live-controls row next to `Start live conversation`.
- Mode toggle moved back to header and placed directly next to the green `live` status chip.
- Mode toggle left label changed from `S` to `M` (`M/F`).
- Manually edited script text in `src/agents/scenarios.js` was spell-checked and fixed (including a broken quote that caused invalid JS).
- Claims scripted assistant turns were fully normalized again (wording, names, amounts, and readback) with `8 Uhr`, `Aachener Straße`, and generic insurance phrasing.
- Updated `CLAIMS_SCRIPTED_USER_PATTERNS` to match the current script content (`8 Uhr`, `Aachener Straße`, `Viktor`, `dreitausend`).
- Added synthetic response timing in `src/server.js` for `/api/converse` and `/api/converse/stream`: `FAKE_LLM_LATENCY_*` adds base delay, `FAKE_AGENT_DELAY_*` adds occasional extra lag before answer output.
- Added configurable pre-speech pause before streaming the first audio chunk in `/api/scenario/start/stream` and `/api/converse/stream` via `PRE_SPEECH_DELAY_MS` (default `180`).
- Added a small fake written-reply delay in `public/index.html` before rendering assistant text messages (`140-340ms`) so responses look more like a real LLM call.
- Increased default delays for more noticeable realism: `PRE_SPEECH_DELAY_MS` now defaults to `320`, written text delay range is now `280-620ms`.
- Rolled back the increased delay defaults after instability report; active defaults restored to `PRE_SPEECH_DELAY_MS=180` and written text delay `140-340ms`.
- To reduce "hardcoded" feel in stream mode, scripted/non-streaming text output now emits pseudo-token deltas (small variable chunks + jittered micro-pauses) before TTS starts.
- Added multi-tier delay behavior: spoken pre-speech delay now samples variable ranges with occasional extra pause, and written reply delay now also adds occasional longer micro-pauses.

## Open Questions
- None currently.
