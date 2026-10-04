# meeting-summarizer

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Architecture blueprint

`docs/ARCHITECTURE.md` is the visual map of the code (Mermaid diagrams of the runtime pieces, data flow, states, messages and functions). Read it before exploring.

**Rule: keep it current.** Any change that adds, renames or removes a `src/` file, a message type, a session/capture state, a Meeting End path, a storage location, a transcription engine or a Provider must update the matching diagram and tables in `docs/ARCHITECTURE.md` in the same commit. The doc's last section maps each kind of change to the section to edit. `tests/architecture-doc.test.ts` fails when a `src/` file or message type is missing. It can't tell whether a diagram is still true, so re-read the affected diagrams against the code before finishing.
