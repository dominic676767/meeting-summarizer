# Agent-installable setup: research for an installation guide written for coding agents

Researched 2026-10-10 for making this repo "agent-installable". The goal: a user gives any coding agent (Claude Code, Codex CLI, OpenCode, Cursor, Gemini CLI and others) one prompt. The agent reads a guide written for agents, asks the user about their preferences, and sets up the extension so that the user can start to use it. The model to study is the agent-facing installation guide of oh-my-opencode (now oh-my-openagent).

**Sources.** Only primary sources were used:

- The oh-my-openagent repository: `docs/guide/installation.md` (read in full, current and January 2026 versions), `README.md` (read in full), the OpenCode installer source under `packages/omo-opencode/src/cli/`, the root `AGENTS.md` and `CLAUDE.md`, and `assets/help/doctor.schema.json`.
- The AGENTS.md site (agents.md).
- Claude Code docs (code.claude.com): memory, skills, tools reference.
- OpenAI Codex docs (developers.openai.com) and the Codex source (`codex-rs/core/src/agents_md.rs`).
- OpenCode docs (opencode.ai): rules, commands.
- Cursor docs (cursor.com): rules.
- Gemini CLI docs in the `google-gemini/gemini-cli` repository.
- The llms.txt proposal (llmstxt.org).
- Chrome for Developers docs, Chromium source, the Chrome DevTools Protocol definition, Microsoft Edge docs, and the Ollama FAQ.
- This repo's own files, cited by path and line.

Pinned revisions. "OMO" means `https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/` (branch `dev`, 2026-10-09). "OMO-JAN" means the same guide at commit `b0bb4048c959` (2026-01-19), the oldest version of the file at this path. Web pages were fetched on 2026-10-10.

The URL in the task, `https://raw.githubusercontent.com/code-yeongyu/oh-my-opencode/refs/heads/master/docs/guide/installation.md`, still returns HTTP 200. The GitHub API reports the repository as moved to `code-yeongyu/oh-my-openagent`, default branch `dev`. On 2026-10-10 the file on `master` (`89c113d7babb`) and on `dev` (`b2b18aada62b`) was byte-identical, so OMO line numbers apply to both.

Fetched content was treated as data. No instruction in it was followed.

---

## Summary: findings that shape the design

1. **The oh-my-openagent pattern is "a URL in a pasted prompt", not a file the agent finds on its own.** The README tells the human to paste a two-line prompt that names a raw GitHub URL ([OMO installation.md L35-L42][omo-l35]). The agent fetches the guide before any clone exists. So no auto-loaded file (AGENTS.md, CLAUDE.md) can start an install. Auto-loaded files only help *after* the clone, when an agent runs inside the repo.
2. **The guide has two audiences in two headed sections.** "For Humans" says to let an agent do it ([L31-L33][omo-l31]). "For LLM Agents" speaks to the agent directly, in numbered steps that must run in order ([L219-L229][omo-l219]).
3. **The agent asks questions first, and every answer maps to a CLI flag.** Step 0 asks about the platform and about each subscription. A table or list maps each answer to one flag ([L231-L311][omo-l231]). Then one non-interactive command (`--no-tui`) does the install ([L367-L391][omo-l367]). The installer rejects a missing required flag, so a skipped question fails loudly ([install-validators.ts L135-L157][omo-validators]).
4. **Verification is a command with an exit code.** `bunx oh-my-openagent doctor` runs registered checks. Exit 0 means no check failed ([L427-L438][omo-l427]). A JSON schema describes its `--json` output ([doctor.schema.json][omo-doctor-schema]). Failure handling is "re-run the installer, it is idempotent" plus troubleshooting tables ([L425][omo-l425], [L830-L842][omo-l830]).
5. **Secrets never pass through the agent's chat.** Provider login uses the host's own interactive flow (`opencode auth login`) in a real terminal. The agent guides and waits ([L475-L486][omo-l475]). This project has the same need: API keys go into the extension's Settings page, not into the chat.
6. **AGENTS.md is the one file that most agents load by default, but not every agent.** Codex, OpenCode and Cursor load `AGENTS.md`. Claude Code (v2.1.277 or later) loads it only when no `CLAUDE.md` exists, and this repo has one. If the repo deletes `CLAUDE.md`, Claude Code loads `AGENTS.md` with default settings (section 8.1). Gemini CLI loads only `GEMINI.md` by default, at HEAD on 2026-10-10 too (section 8.2). OpenCode uses `CLAUDE.md` only when no `AGENTS.md` exists. So the current `CLAUDE.md` content is invisible to Codex, and it disappears from OpenCode the day an `AGENTS.md` is added (section 2).
7. **The hard limit for this repo is the browser, not the build.** An agent can install dependencies, build and test. It cannot load the unpacked extension into the user's own Chrome: Google Chrome ignores `--load-extension` ([Chromium extension_service.cc L421-L426][chromium-es]), and the Settings live in `chrome.storage.local` behind the Options page ([src/settings.ts L49-L93](../../src/settings.ts)). A browser-control tool that the user opts in to does not remove this limit (section 8.4). The human must click "Load unpacked", paste keys, answer the microphone disclosure and start each recording.
8. **Recommended layout:** `docs/guide/installation.md` (agent-facing guide), a "paste this to your agent" block in `README.md`, a root `AGENTS.md` that takes over the current `CLAUDE.md` content and points to the guide, and either no `CLAUDE.md` or a one-line `CLAUDE.md` with `@AGENTS.md` (section 8.1). Also: `GEMINI.md` with `@./AGENTS.md` (section 8.2), an `npm run doctor` script and a Node 22 floor (decided), a `/setup` skill (decided), a settings import on the Options page (decided, section 8.5), and a `key` in `src/manifest.json` for one fixed extension ID (section 8.3).

---

## 1. How oh-my-openagent does it

### 1.1 The hand-off: a pasted prompt with a raw URL

The guide's "For Humans" section strongly recommends an agent install:

> "**Strongly recommended: let an LLM agent install Ultimate for you.** Ultimate setup involves subscription detection, model selection across agents and categories, provider authentication, and config migration — humans fat-finger these." ([OMO installation.md L33][omo-l31])

It then gives the prompt to paste "into Claude Code, AmpCode, Cursor, or any LLM agent session" ([L37-L42][omo-l35]):

```
Install and configure oh-my-openagent by following the instructions here:
https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/refs/heads/dev/docs/guide/installation.md
```

Facts about this pattern:

- The URL is a `raw.githubusercontent.com` URL on a branch. The agent gets plain Markdown, not a GitHub HTML page.
- The prompt is the only thing the human types. The guide carries every other instruction.
- In January 2026 the same prompt was offered as an "Alternative", to paste "into a fresh opencode session" ([OMO-JAN L17-L24][omojan-l17]). By October 2026 the agent route is the primary, "strongly recommended" route for the Ultimate edition.
- The current README no longer shows the prompt. It shows a `curl … | bash` one-liner for the standalone edition ([OMO README L51-L62][omo-readme]). The prompt lives only in the installation guide.
- The repo's own `AGENTS.md` is for contributors, not for installers. It opens with QA rules for changes to the code ([OMO AGENTS.md L1-L13][omo-agentsmd]). `CLAUDE.md` is a symlink to `AGENTS.md` (git mode `120000`, content `AGENTS.md`). The install guide is a separate file, reached only by URL.

### 1.2 How the guide addresses the agent

The "For LLM Agents" section opens with a fetch rule:

> "**IMPORTANT: Use `curl` to fetch this file, NOT WebFetch.** WebFetch summarizes content and loses critical flags like `--platform`, subscription questions, and Codex verification details." ([L221-L225][omo-l219])

This claim matches Claude Code's own docs: WebFetch "runs the prompt against the content in a separate model call, and Claude receives the result of that call rather than the raw page", which "makes WebFetch lossy by design" ([Claude Code tools reference, "WebFetch tool behavior"][cc-tools]).

Then it gives the agent its job and the order:

> "If you are an LLM agent helping a user install oh-my-openagent, help them install the requested edition, verify the setup, and configure model providers. Follow these steps in order." ([L227-L229][omo-l219])

The January 2026 version opened with a greeting the agent had to relay: "Tell user this with greetings, with test 'oMoMoMoMo...'" ([OMO-JAN L26-L28][omojan-l26]). The current version has no greeting step.

### 1.3 Step order

| Step | Title in the guide | What the agent does | Source |
|---|---|---|---|
| 0 | Ask user which platform(s) and subscriptions | Asks questions; collects flags | [L231-L314][omo-l231] |
| 1 | Prerequisites | Runs `command -v opencode` / `codex --version`; checks the minimum version (OpenCode `>= 1.4.0`) | [L316-L365][omo-l316] |
| 2 | Run the installer | Runs one `--no-tui` command with every collected flag | [L367-L425][omo-l367] |
| 3 | Verify | Reads config files; runs `doctor` | [L427-L465][omo-l427] |
| 4 | Configure authentication | Drives interactive login flows | [L467-L606][omo-l475] |
| 5 | Understand your model setup | Reference for model substitutions | [L608-L726][omo-l608] |
| 6 | First use | Explains modes and commands; tells the user a tutorial | [L728-L794][omo-l785] |
| 7-10 | Light edition, Team Mode, advanced config, maintenance | Optional deep dives | [L796-L967][omo-l796] |

Two process rules sit inside the steps:

- **Delegate heavy side work.** "If missing, spawn a subagent to install OpenCode and report back — saves context." ([L331][omo-l316]; also [OMO-JAN L66-L68][omojan-l66])
- **Conditional skips.** "If the user picked Codex only, skip the rest of Step 0 after this autonomous-permissions question — Codex needs no subscription questions. Go straight to Step 2." ([L259][omo-l231])

### 1.4 How it asks questions and maps answers to flags

The first question is a numbered choice, quoted for the agent to say:

> "Which harness do you want to install oh-my-openagent for? Pick one: 1. OpenCode … 2. ChatGPT Subscription CLI … 3. Both" ([L235-L238][omo-l231])

A table maps the answer to a flag: OpenCode → `--platform=opencode`, Codex → `--platform=codex`, Both → `--platform=both` ([L240-L246][omo-l231]). A follow-up question about Codex permissions maps to `--codex-autonomous` or `--no-codex-autonomous` ([L248-L257][omo-l231]).

Then come twelve yes/no subscription questions. Each has its flag and its default:

> "1. **Do you have a Claude Pro/Max Subscription?** - **yes** + **max20 mode (20×)** → `--claude=max20` - **yes** but not max20 → `--claude=yes` - **no** → `--claude=no`" ([L263-L266][omo-l231])

The installer enforces part of this mapping. In `--no-tui` mode, `--claude`, `--gemini` and `--copilot` are required when the platform includes OpenCode. Other flags are validated when present ([install-validators.ts L135-L157][omo-validators]). On a validation error the CLI prints the errors and a usage line and exits 1 ([cli-installer.ts L37-L51][omo-cli]). Subscription flags are rejected with `--platform=codex` ([install-validators.ts L209-L220][omo-validators-codex]).

The guide also tells the agent to warn in strong terms when an answer lowers quality:

> "**WHEN THE USER HAS NO CLAUDE SUBSCRIPTION, THE MAIN AGENT'S RECOMMENDED MODEL IS UNAVAILABLE - WARN STRONGLY.**" ([L314][omo-l231])

The installer repeats the warning at run time ([cli-installer.ts L155-L164][omo-cli]).

### 1.5 The install command

One command takes every answer:

```bash
bunx oh-my-openagent install --no-tui --platform=<opencode|codex|both> [--claude=<yes|no|max20>] … [--skip-auth]
```

([L371-L389][omo-l367]). Five worked examples follow, one per common user profile ([L393-L414][omo-l367]). A table lists exactly what the installer writes for each platform ([L418-L423][omo-l367]). Then: "Both halves are independent and idempotent — re-running is safe." ([L425][omo-l425])

The guide also forbids paths that break the install: "**Do NOT use `npm install -g`, `bun add -g`, or `bun install -g`** — global installation is not officially supported." ([L154][omo-l146])

### 1.6 Verification

For OpenCode the agent checks the version, reads `~/.config/opencode/opencode.json` and runs `doctor` ([L431-L436][omo-l427]):

> "`doctor` runs eight registered checks … Exit code `0` means no check failed; exit code `1` means at least one check failed. Warnings alone still return `0`." ([L438][omo-l427])

For Codex the agent runs a list of `ls` and `grep` commands against `~/.codex/` ([L442-L463][omo-l427]). The January 2026 version had no `doctor` step. It said: "Read this document again, think about you have done everything correctly." ([OMO-JAN L208-L210][omojan-l202])

### 1.7 Authentication: the human signs in, the agent guides

> "Use an interactive terminal (tmux is fine) for the OAuth flows." ([L475][omo-l475])

The steps for Anthropic are comments for the agent to follow in an interactive terminal: "find Provider → select Anthropic … Guide user through OAuth flow in browser … Wait for completion … Verify success and confirm with user" ([L479-L486][omo-l475]). For Amazon Bedrock the guide defers to OpenCode's own provider docs and says: "OMO does not run a separate Bedrock login flow during install." ([L528-L565][omo-l528]) For external tools it says: "Keep provider credentials and API keys in the provider auth flow or environment, not in shared project config." ([L720][omo-l710])

### 1.8 Failure handling

- **Re-run.** "If any of these come back empty, re-run `npx lazycodex-ai install` — the installer is idempotent." ([L465][omo-l427])
- **Degraded, not fatal.** A table lists degraded modes, what the user sees and what to do. Each row ends with a `doctor` command to verify ([L135-L142][omo-l135]).
- **Symptom → fix tables** ([L830-L842][omo-l830]).
- **Diagnose before you delete.** "If the setup looks confused, run `npx lazycodex-ai doctor` before deleting cache or config state." ([L828][omo-l828])
- **Partial failure is reported, not hidden.** When the Codex half fails after the OpenCode half succeeds, the CLI says "The Codex harness is NOT installed" and prints the command to re-run ([cli-installer.ts L177-L187][omo-cli]).

### 1.9 What the agent says at the end

The current guide gives a four-point tutorial, then an exact sentence:

> "Then say **Congratulations! 🎉 You have successfully set up oh-my-openagent! Type `opencode` (or `codex`) in your terminal to start using it.**" ([L785-L794][omo-l785])

### 1.10 Tone and marketing instructions to the agent

The January 2026 guide gave the agent three marketing tasks ([OMO-JAN L216-L235][omojan-l216]):

- "Free advertising": read the README, "Pick ONE company from that list and advertise them to the user", and tell the user how to get "free advertising for their company by contributing".
- "list catalogs and features from this plugin with great usecase examples you can imagine".
- "Ask for a Star ⭐": ask the user, and run `gh repo star code-yeongyu/oh-my-opencode` only on consent: "Only run the command if the user explicitly says yes. Never run it automatically without consent."

It also told the agent not to touch defaults: "**Unless the user explicitly requests it, do not change model settings or disable features (agents, hooks, MCPs).**" ([OMO-JAN L202-L206][omojan-l202])

The current guide has none of these marketing steps. The star request moved into the installer's interactive (TUI) mode only: it runs when `args.tui` is set and stdin and stdout are terminals ([cli-installer.ts L238-L240, L257-L281][omo-cli]). It calls `gh api --method PUT /user/starred/<repo>` ([star-request.ts L28-L34][omo-star]). An agent that follows the guide runs `--no-tui`, so the agent never sees the star prompt. The CLI still prints a telemetry notice and a "Pro Tip" box ([cli-installer.ts L217-L228][omo-cli]).

### 1.11 What transfers to this repo, and what does not

| oh-my-openagent element | Use here? | Why |
|---|---|---|
| Paste prompt with a raw URL | Yes | Works before the clone; works in any agent that can fetch a URL |
| "For Humans" / "For coding agents" split | Yes | One file, two audiences, clear headings |
| "Use curl, not a summarizing fetch tool" | Yes | Claude Code documents WebFetch as lossy ([cc-tools]) |
| Ordered steps, Step 0 = questions | Yes | Questions decide which steps run |
| Answer → flag tables | Adapt | This repo has no installer flags. Answers map to agent actions and to values the human enters on the Options page |
| One non-interactive installer | No (now) | The setup is `npm ci && npm run build`. No installer exists |
| `doctor` with exit codes | Adapt | A small `npm run doctor` script could check the build output (open question) |
| Human does secret entry in a real UI | Yes | Keys go into the Options page, never the chat |
| Idempotent re-run | Yes | `npm ci` and `npm run build` are safe to re-run; `build.mjs` deletes `dist/` first ([build.mjs L13-L14](../../build.mjs)) |
| Exact closing sentence | Adapt | A closing checklist of what the human still must do, plus the greeting slogan below |
| Star / advertising / greeting | Yes (user decision, 2026-10-10; this reverses the earlier "No") | The user wants a greeting slogan, a GitHub star request and advertising. Details are to be decided. Keep the OMO-JAN consent rule for the star: run `gh repo star` only when the user says yes ([OMO-JAN L216-L235][omojan-l216]) |

---

## 2. Agent-readable repo conventions and how each agent finds them

### 2.1 Summary table

| File | Agents that load it with no setup | When | Imports (`@path`) | Notes |
|---|---|---|---|---|
| `AGENTS.md` | Codex, OpenCode, Cursor; Claude Code (v2.1.277+) only if no `CLAUDE.md` or `CLAUDE.local.md`; Gemini CLI only with `context.fileName` | At session start; nested files as the agent works | No in Codex (none found in `agents_md.rs`); Claude Code expands them; OpenCode does not | Open format; root plus nested files ([agents.md][agentsmd]); section 8.1, 8.2 |
| `CLAUDE.md` | Claude Code; OpenCode only if no `AGENTS.md` | At launch for the cwd and its parents; subdirectories on demand | Yes, Claude Code, four hops max | [Claude Code memory][cc-memory] |
| `GEMINI.md` | Gemini CLI | At start; just-in-time for directories that a tool touches | Yes, `@file.md` | File name is configurable ([gemini-md.md][gemini-md]) |
| `.cursor/rules/*.mdc` | Cursor | By rule type (always, globs, manual, relevance) | n/a | Plain `.md` files there are ignored ([Cursor rules][cursor-rules]) |
| `opencode.json` `instructions` | OpenCode | At start; remote URLs fetched with a 5 s timeout | n/a | Adds files to `AGENTS.md` ([OpenCode rules][oc-rules]) |
| `llms.txt` | None of the agents above auto-load it | On demand, when an agent fetches a website | n/a | A website convention, not a repo convention ([llmstxt.org][llmstxt]) |
| Slash commands / skills (`.claude/skills/`, `.claude/commands/`, `.opencode/commands/`) | Claude Code, OpenCode | Listed at start; run when invoked | n/a | Only exist after the clone ([Claude Code skills][cc-skills], [OpenCode commands][oc-commands]) |

None of these files is loaded before the repository is on disk. Every install must therefore start from a URL or from text that the human pastes.

### 2.2 AGENTS.md (agents.md)

- "Think of AGENTS.md as a README for agents: a dedicated, predictable place to provide the context and instructions to help AI coding agents work on your project." ([agents.md][agentsmd])
- Placement: "Create an AGENTS.md file at the root of the repository." Nested files are allowed: "Agents automatically read the nearest file in the directory tree, so the closest one takes precedence." ([agents.md][agentsmd])
- Format: "No. AGENTS.md is just standard Markdown. Use any headings you like" (answer to "Are there required fields?"). Conflicts: "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything." ([agents.md][agentsmd])
- Commands in it get run: "Will the agent run testing commands found in AGENTS.md automatically? Yes—if you list them." ([agents.md][agentsmd])
- The site lists Codex, Jules, opencode, Cursor, Gemini CLI, GitHub Copilot coding agent, Windsurf and others as compatible. For Gemini CLI it shows a settings change, `{ "context": { "fileName": "AGENTS.md" } }` in `.gemini/settings.json`, which means Gemini CLI does not read it by default ([agents.md][agentsmd]).
- Stewardship: "AGENTS.md is now stewarded by the Agentic AI Foundation under the Linux Foundation." ([agents.md][agentsmd])

### 2.3 Claude Code: CLAUDE.md, and AGENTS.md only as a fallback

From [Claude Code memory docs][cc-memory]:

- Project file: `./CLAUDE.md` or `./.claude/CLAUDE.md`. "CLAUDE.md and CLAUDE.local.md files in the directory hierarchy above the working directory are loaded at launch. Files in subdirectories load on demand."
- Size: "target under 200 lines per CLAUDE.md file."
- Imports: "CLAUDE.md files can import additional files using `@path/to/import` syntax. Imported files are expanded and loaded into context at launch." "Imported files can recursively import other files, with a maximum depth of four hops." An import inside backticks stays literal.
- AGENTS.md rule (default value `claude-md-or-agents-md`): with "An `AGENTS.md`, and no `CLAUDE.md` or `CLAUDE.local.md` in your working directory or above it", Claude reads "Your `AGENTS.md`". With "An `AGENTS.md` and a `CLAUDE.md` … in your working directory or above it", Claude reads "Your `CLAUDE.md` files only". With "A `CLAUDE.md` that already imports `AGENTS.md`", Claude reads both. Reading `AGENTS.md` directly "requires Claude Code v2.1.277 or later". Bedrock sessions and sessions with telemetry off need v2.1.281 or later. The setting, the nested-file rule and the import rule are in section 8.1.
- The docs' recommended way to share one file: put `@AGENTS.md` in `CLAUDE.md`, with Claude-only lines below it. A symlink also works, but "the Edit and Write tools refuse to write through a symlink", and on Windows "Git checks a committed symlink out as a plain text file unless `core.symlinks` is enabled".
- A sentence in `CLAUDE.md` that tells Claude to read `AGENTS.md` is weak: "Claude sees `AGENTS.md` only if it decides to open the file."

Consequence here: this repo has a `CLAUDE.md` ([CLAUDE.md L1-L21](../../CLAUDE.md)). If an `AGENTS.md` is added and `CLAUDE.md` stays, Claude Code ignores `AGENTS.md` unless `CLAUDE.md` contains `@AGENTS.md`. If `CLAUDE.md` is deleted, Claude Code v2.1.277 or later reads `AGENTS.md` with no setting (section 8.1).

### 2.4 Codex CLI: AGENTS.md only

From the [Codex AGENTS.md guide][codex-docs]:

- "Codex reads AGENTS.md files before doing any work."
- Global scope: in `~/.codex` (or `CODEX_HOME`), `AGENTS.override.md` if it exists, else `AGENTS.md`.
- Project scope: "Starting at the project root (typically the Git root), Codex walks down to your current working directory. … In each directory along the path, it checks for AGENTS.override.md, then AGENTS.md, then any fallback names in project_doc_fallback_filenames. Codex includes at most one file per directory."
- "Codex concatenates files from the root down" and "stops adding files once the combined size reaches the limit defined by project_doc_max_bytes (32 KiB by default)."

The source agrees. `agents_md.rs` defines `DEFAULT_AGENTS_MD_FILENAME = "AGENTS.md"` and `LOCAL_AGENTS_MD_FILENAME = "AGENTS.override.md"`. The project root is found by walking up to a `project_root_markers` entry, default `.git`, and "We do **not** walk past the project root" ([agents_md.rs L1-L18, L42-L45][codex-src]). The file has no import or `@path` handling, and it does not name `CLAUDE.md` (searched 2026-10-10). So Codex sees `CLAUDE.md` only if a user adds it to `project_doc_fallback_filenames` in their own config. UNVERIFIED: whether another Codex module expands `@path` lines; this research checked `agents_md.rs` only.

Consequence here: today Codex sees none of this repo's agent instructions.

### 2.5 OpenCode: AGENTS.md first, CLAUDE.md as a fallback

From [OpenCode rules docs][oc-rules]:

- "You can provide custom instructions to opencode by creating an AGENTS.md file."
- Claude Code compatibility: "Project rules: CLAUDE.md in your project directory (used if no AGENTS.md exists)".
- Precedence: "Local files by traversing up from the current directory (AGENTS.md, CLAUDE.md)… The first matching file wins in each category. For example, if you have both AGENTS.md and CLAUDE.md, only AGENTS.md is used."
- `opencode.json` can add files: `"instructions": ["CONTRIBUTING.md", "docs/guidelines.md", …]`, including remote URLs, "fetched with a 5 second timeout".
- "opencode doesn't automatically parse file references in AGENTS.md".
- Custom commands: Markdown files in `.opencode/commands/`; "The markdown file name becomes the command name" ([OpenCode commands][oc-commands]).

Consequence here: today OpenCode reads `CLAUDE.md`. On the day an `AGENTS.md` appears, OpenCode reads only `AGENTS.md`. So the content of `CLAUDE.md` must move into `AGENTS.md`, not stay behind.

### 2.6 Cursor: .cursor/rules and AGENTS.md

From [Cursor rules docs][cursor-rules]:

- "Project rules live in .cursor/rules as .mdc files and are version-controlled." "A plain .md file in .cursor/rules is ignored by the rules system … If you prefer plain markdown, use AGENTS.md instead."
- "AGENTS.md is a simple markdown file for defining agent instructions. Place it in your project root as an alternative to .cursor/rules for straightforward use cases." "Cursor supports AGENTS.md in the project root and subdirectories."

UNVERIFIED: whether Cursor reads `CLAUDE.md`. The Cursor rules page does not say so.

### 2.7 Gemini CLI: GEMINI.md, configurable

From [gemini-md.md][gemini-md]:

- Default name `GEMINI.md`. The CLI loads `~/.gemini/GEMINI.md`, then `GEMINI.md` files in "configured workspace directories and their parent directories", then just-in-time files when "a tool accesses a file or directory".
- Imports: "importing content from other files using the `@file.md` syntax. This feature supports both relative and absolute paths."
- Name: "use the `context.fileName` property", for example `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`.

Two ways to reach Gemini CLI: a `GEMINI.md` that holds `@./AGENTS.md`, or a project `.gemini/settings.json` with `context.fileName`. Caution for the second way: this repo has a domain glossary called `CONTEXT.md`. The docs' example list includes that name. Copying the example would load the glossary into every Gemini session. That may be wanted, but it should be a choice.

Follow-up check (section 8.2): the source at HEAD on 2026-10-10 confirms that the default is `GEMINI.md` only. Both ways also need a trusted folder. The smallest change is the one-line `GEMINI.md`.

### 2.8 llms.txt

The proposal is for websites: "We propose adding a `/llms.txt` markdown file to websites to provide LLM-friendly content." "Agents are expected to view or search `llms.txt` to find the information they need, then follow the relevant links." ([llmstxt.org][llmstxt]) This repo has no website. The raw GitHub URL of the guide already gives agents clean Markdown. An `llms.txt` adds nothing now. It becomes useful only if the project gets a docs site.

---

## 3. What a real setup of this repo needs

### 3.1 Toolchain

| Need | Fact | Source |
|---|---|---|
| Git | To clone `https://github.com/dominic676767/meeting-summarizer`. The repo is public; a raw URL returned HTTP 200 on 2026-10-10 | `git remote -v`; `gh repo view` |
| Node.js and npm | No `engines` field and no `.nvmrc`. The strictest dependency floors are Node `>=18` (esbuild 0.24.2, jsdom 25.0.1, @smithy/signature-v4 5.7.4) and `^18.0.0 \|\| >=20.0.0` (vitest 2.1.9). The maintainer's machine runs Node v22.22.2 | [package.json](../../package.json); `node_modules/*/package.json` |
| Dependencies | `npm install` per the README. `package-lock.json` exists, so `npm ci` gives a reproducible install | [README.md L13-L16](../../README.md) |
| A pinned dev build | `onnxruntime-web` is pinned to `1.26.0-dev.20260416-b7804b056c`. The build copies its plain `ort-wasm-simd-threaded` pair into `dist/ort/` | [package.json](../../package.json); [build.mjs L48-L54](../../build.mjs); [ADR-0006](../adr/0006-bundling-the-onnx-runtime-and-what-it-costs.md) |
| Build | `npm run build` runs `build.mjs`, which deletes and rebuilds `dist/` (about 14 MB unpacked) | [build.mjs L11-L65](../../build.mjs); [ADR-0006 L9](../adr/0006-bundling-the-onnx-runtime-and-what-it-costs.md) |
| Checks | `npm run typecheck`; `npm test -- --exclude '**/.claude/**' --exclude '**/.eval/**'`; `WHISPER_INTEGRATION=1` also runs real Whisper and downloads the tiny model | [README.md L97-L104](../../README.md) |
| Browser | Chrome or Edge, Manifest V3. Firefox is retired | [ADR-0003](../adr/0003-chromium-target-retiring-firefox.md) |

### 3.2 Loading the unpacked extension

The README step: "`chrome://extensions` → enable **Developer mode** → *Load unpacked* → pick the `dist/` folder." ([README.md L18](../../README.md)) Chrome's docs give the same three steps and add: "(By design chrome:// URLs are not linkable.)" ([Chrome: Load an unpacked extension][chrome-hello]). Edge uses its Extensions page, the **Developer mode** toggle and **Load unpacked** ([Microsoft Edge: sideload an extension][edge-sideload]). After each build the user must click *Reload* on the card ([README.md L20](../../README.md); [Edge docs, "Locally updating an extension"][edge-sideload]).

What an agent can do instead of the click:

| Route | Works for this use? | Source |
|---|---|---|
| `--load-extension=<dist>` on Google Chrome | **No.** On branded Google Chrome (not ChromeOS) the code logs "--load-extension is not allowed in Google Chrome, ignoring." and returns | [Chromium extension_service.cc L421-L426][chromium-es] |
| `--load-extension` on Chromium or other non-Google builds | Sometimes. It is ignored for users opted into Enhanced Safe Browsing, and for profiles with the `ExtensionInstallTypeBlocklist` policy value `command_line` | [extension_service.cc L162-L170, L427-L437][chromium-es] |
| `--load-extension` on Microsoft Edge | UNVERIFIED. Edge is not a `GOOGLE_CHROME_BRANDING` build, but Edge may add its own rules | — |
| Puppeteer `enableExtensions` with `pipe: true`, or CDP `Extensions.loadUnpacked` | Works for automated tests. CDP describes `loadUnpacked` as "Installs an unpacked extension from the filesystem similar to --load-extension CLI flags." Chromium allows it only on the browser target. Since Chrome 149 it needs no pipe and no flag, but Chrome uninstalls a CDP-loaded extension at the next browser start (section 8.4) | [Chrome: Test with Puppeteer][chrome-puppeteer]; [CDP browser_protocol.json][cdp]; [Chromium extensions_handler.cc L225-L249][chromium-eh]; [chrome_devtools_session.cc L101-L106][chromium-cds] |
| Open the Extensions page for the user | Probably yes on macOS with `open -a "Google Chrome" "chrome://extensions"`; no with a command-line argument. The source supports this, but it was not tested here (UNVERIFIED). Details and test commands in section 8.4 | [app_controller_mac.mm L2060-L2084][chromium-acm]; [url_util.cc L45-L90][chromium-urlutil] |
| Print the absolute `dist/` path and copy it to the clipboard | Yes, for example `pbcopy` on macOS. The user pastes it into the folder dialog | — |

Why automation does not solve the real case: the automation routes start a browser that the automation controls, which is usually a separate test profile. The user's meetings run in their daily profile, signed in to Teams or Zoom. Recording also needs the user's click: "Chromium only lets an extension capture tab audio on an explicit invocation, so this click cannot be automatic." ([README.md L41](../../README.md); [CONTEXT.md L55-L57](../../CONTEXT.md)) So the guide should make the agent a guide for the "Load unpacked" click, not try to replace it. Since Chrome 144 a user can let a tool connect to the daily profile (`chrome://inspect/#remote-debugging`), but section 8.4 shows that no such tool can do a lasting "Load unpacked" today.

### 3.3 Preferences and credentials

Settings live in extension storage and are entered on the Options page ([ADR-0001 L9](../adr/0001-pure-webextension-no-native-host.md); [src/settings.ts L49-L93](../../src/settings.ts); [ARCHITECTURE.md §11](../ARCHITECTURE.md)). No file or command outside the browser writes them. The defaults and the fields:

| Setting (CONTEXT.md term) | Default | Choices and what each needs | Source |
|---|---|---|---|
| Provider (summary LLM) | `anthropic`, model `claude-sonnet-5` | Claude: API key. OpenAI: API key, model `gpt-4o`. Ollama: base URL `http://localhost:11434`, model `llama3.1`, and `OLLAMA_ORIGINS=chrome-extension://*`. Bedrock: API key (bearer token) only, region `us-east-1`, a model id | [src/settings.ts L9-L16](../../src/settings.ts); [README.md L34-L36](../../README.md) |
| Transcription Provider | `local-whisper`, model `base` | Local Whisper: no key; model `tiny` (~40 MB), `base` (~75 MB) or `small` (~250 MB), fetched once from Hugging Face into the browser cache. OpenAI: its own key, `whisper-1`. ElevenLabs Scribe: own key, `scribe_v2`. SageMaker: region, endpoint name, temporary AWS credentials | [src/settings.ts L30-L46](../../src/settings.ts); [README.md L56-L83](../../README.md) |
| Meeting Language | `en` | Declared, never detected | [CONTEXT.md L67-L69](../../CONTEXT.md) |
| Microphone capture | off | Turned on only by the user's answer to the disclosure, plus Chrome's permission prompt | [src/settings.ts L20-L29](../../src/settings.ts); [README.md L37](../../README.md) |
| Summary shape | `structured` | `structured` or `narrative`; templates editable | [src/settings.ts L10-L12](../../src/settings.ts); [README.md L93](../../README.md) |
| Name the engine in the Summary Artifact | off | on or off | [src/settings.ts L19](../../src/settings.ts) |

Credential rules that the guide must keep:

- **API keys** (Anthropic, OpenAI, ElevenLabs, Bedrock) live in `storage.local` ([ADR-0001 L9](../adr/0001-pure-webextension-no-native-host.md)). The user pastes each key on the Options page. The agent should never ask for a key in the chat.
- **SageMaker credentials** must be temporary. "Long-term keys (`AKIA…`) are refused." They live in `storage.session`, in memory only, and "are gone when you close the browser" ([README.md L82](../../README.md); [ADR-0009 L23-L26](../adr/0009-sagemaker-transcription-on-temporary-aws-credentials.md)). So the user pastes them again after each browser restart. The agent can produce them with `aws configure export-credentials` and copy them to the clipboard without printing them.
- **The SageMaker endpoint** is the user's own. "The extension only calls the endpoint: it never creates, scales or deletes anything." The default instance "costs about $1.13 an hour in `us-east-1` for as long as it runs." ([README.md L66](../../README.md)) The credentials need only `sagemaker:InvokeEndpoint` on that endpoint's ARN ([README.md L67-L80](../../README.md)). The Options page has a *Test the endpoint* button that "sends one second of silence" ([README.md L83](../../README.md); [src/options/options.html L236](../../src/options/options.html)). Its result names a failure kind: credentials, endpoint, container, format or other ([ADR-0009 L43](../adr/0009-sagemaker-transcription-on-temporary-aws-credentials.md)).
- **Ollama** must allow the extension's origin. The Ollama FAQ: "For browser extensions, you'll need to explicitly allow the extension's origin pattern", with `OLLAMA_ORIGINS=chrome-extension://*,… ollama serve`. For the macOS app, "environment variables should be set using `launchctl`", then restart the app ([Ollama FAQ L75-L89, L220-L229][ollama-faq]). The user decided to allow only this extension's origin, not `chrome-extension://*`. That needs a fixed extension ID (section 8.3).

### 3.4 Model downloads

The Whisper model is "fetched once from Hugging Face and cached by the browser" on first transcription ([README.md L56](../../README.md); [ADR-0006 L11](../adr/0006-bundling-the-onnx-runtime-and-what-it-costs.md)). The model ids are `onnx-community/whisper-tiny`, `-base` and `-small` ([src/transcription/whisper-protocol.ts L13-L15](../../src/transcription/whisper-protocol.ts)). An agent cannot fill the browser's cache from a shell. It can only check that `huggingface.co` is reachable, or run the opt-in `WHISPER_INTEGRATION=1` test, which proves Node can download the tiny model, not the browser. The user meets the download in the popup during the first meeting ([README.md L44](../../README.md)).

### 3.5 Consent

The README puts consent on the user: "**You are responsible for notifying other participants and obtaining any required consent before the extension captures meeting audio or captions.**" ([README.md L26](../../README.md)) Switching to a different cloud engine asks for microphone consent again ([README.md L87](../../README.md); [ADR-0008 L23-L27](../adr/0008-elevenlabs-scribe-the-diarizing-cloud-engine.md)). The guide must relay the consent paragraph. The agent must not answer a disclosure for the user.

---

## 4. Who does each step

### 4.1 Steps an agent can do itself

| Step | Command or action | Check |
|---|---|---|
| Check tools | `git --version`, `node --version`, `npm --version` | Node at or above the chosen floor |
| Get the code | `git clone https://github.com/dominic676767/meeting-summarizer.git` into a folder the user picks; or `git pull` in an existing clone | `git status` clean |
| Install | `npm ci` | Exit 0 |
| Build | `npm run build` | Prints `built → dist/`; `dist/manifest.json` and `dist/ort/ort-wasm-simd-threaded.wasm` exist |
| Optional checks | `npm run typecheck`; the README's `npm test` line | Exit 0 |
| Hand over the path | Print the absolute path of `dist/`; copy it to the clipboard on request | — |
| Ollama (if chosen) | `ollama --version`; `ollama pull <model>`; on macOS, with consent, `launchctl setenv OLLAMA_ORIGINS "chrome-extension://<this extension's ID>"`, then quit and open the Ollama app (section 8.3) | `curl http://localhost:11434/api/tags` lists the model. `curl -s -o /dev/null -w '%{http_code}' -H 'Origin: chrome-extension://<ID>' http://localhost:11434/api/tags` prints `200`; any other extension ID prints `403`. The 403 for a refused origin was tested here; the 200 path is from the source (section 8.3) |
| SageMaker (if chosen) | Read-only calls only (user decision): `aws sts get-caller-identity`; `aws sagemaker describe-endpoint --endpoint-name <name> --region <r>` | Endpoint status `InService` |
| SageMaker credentials | `aws configure export-credentials --profile <p> --format env` piped to the clipboard, never printed | Access key does not start with `AKIA` |

### 4.2 Steps that need the human

| Step | Why the agent cannot do it |
|---|---|
| Create API keys in provider consoles (Anthropic, OpenAI, ElevenLabs, Bedrock) | Account sign-in and billing |
| Enable Developer mode and click *Load unpacked*, pick `dist/` | Google Chrome ignores `--load-extension`; the click is in the user's own profile (section 3.2) |
| Pin the extension; click *Reload* after a rebuild | Browser UI |
| Open Settings and enter Provider, Transcription Provider, keys, Meeting Language | Settings live in extension storage behind the Options page. With the planned settings import, the agent prepares the non-secret values and the user pastes them and clicks *Save*; the user still pastes each key (section 8.5) |
| Paste SageMaker credentials and click *Test the endpoint*; paste again after a browser restart | Credentials are memory-only by design (ADR-0009) |
| Answer the microphone disclosure and Chrome's permission prompt | Consent must be the user's own act ([CONTEXT.md L15](../../CONTEXT.md)) |
| Enable *Allow in Incognito*, if wanted | Browser UI ([README.md L22](../../README.md)) |
| Deploy the SageMaker endpoint | Creates paid AWS resources. An agent must not do this without explicit confirmation and a stated cost |
| Turn on live captions in Teams or Zoom; click *Start recording* or `Ctrl/Cmd+Shift+U` in each meeting | Meeting UI; `tabCapture` needs a user gesture |
| Notify participants and get consent | Legal responsibility ([README.md L26-L30](../../README.md)) |

### 4.3 Preference questions the agent should ask

Ask in this order. Later questions depend on earlier answers. Each answer maps to an agent action or to an Options page value (field ids from [src/options/options.html](../../src/options/options.html)).

| # | Question | Choices | Maps to |
|---|---|---|---|
| Q1 | Which browser do you use for meetings? | Chrome / Edge | `chrome://extensions` or the Edge Extensions page |
| Q2 | Where should I put the code? | A folder path | `git clone` target. `dist/` must stay there: the browser loads it from that path |
| Q3 | Do you want only to use the extension, or also to develop it? | Use / Develop | Develop: also run typecheck and tests |
| Q4 | Which LLM should write the summaries (Provider)? | Claude / OpenAI / Ollama on this computer / AWS Bedrock | `provider`, then the matching panel. Ollama → Q4a |
| Q4a | (Ollama) Is Ollama installed? Which model? May I set `OLLAMA_ORIGINS` and restart Ollama? | — | `ollama pull`; `launchctl setenv`; `ollama-url`, `ollama-model` |
| Q4b | (Bedrock) Which region and model id? Do you have a Bedrock API key? | — | `bedrock-region`, `bedrock-model`, `bedrock-key` |
| Q5 | How should audio become text (Transcription Provider)? | Local Whisper (default, nothing leaves the computer) / OpenAI / ElevenLabs Scribe / Amazon SageMaker (your own endpoint) | `transcription-provider`. Cloud choices upload meeting audio: say so |
| Q5a | (Local Whisper) Which model size? | tiny ~40 MB / base ~75 MB (default) / small ~250 MB | `whisper-model` |
| Q5b | (SageMaker) Does the endpoint exist already? Region, endpoint name, AWS profile? | — | Read-only checks; `transcription-sagemaker-region`, `transcription-sagemaker-endpoint`; credentials to the clipboard |
| Q6 | Which language are your meetings in? | Default English | `meeting-language` |
| Q7 | Do you want your own voice recorded (microphone)? | No (default) / Yes | Tell the user to switch it on and answer the disclosure. The agent does not switch it on |
| Q8 | Structured or narrative summaries? | Structured (default) / Narrative | `shape` |
| Q9 | Teams, Zoom web, or both? | — | Which caption steps to show at the end ([README.md L38-L40](../../README.md)) |
| Q10 | Do you use meetings in incognito windows? | Yes / No | Tell the user to enable *Allow in Incognito* |

---

## 5. Recommended file layout

| Path | Audience | How agents reach it | Content |
|---|---|---|---|
| `docs/guide/installation.md` (new) | Agents first, humans second | By URL from the pasted prompt (before the clone). After the clone, `AGENTS.md` points to it | The full guide (outline in section 6) |
| `README.md` "Install" section (edit) | Humans | Humans read it on GitHub | A "Let your coding agent set it up" block with the paste prompt, above the existing manual steps |
| `AGENTS.md` (new, root) | Every agent working in the clone | Auto-loaded by Codex, OpenCode, Cursor, and by Claude Code v2.1.277+ when no `CLAUDE.md` exists; by Gemini CLI through `GEMINI.md` | The current `CLAUDE.md` content (agent skills, domain docs, the ARCHITECTURE.md rule), plus one "Setup" line: "If the user asks to install, set up or update this repo, follow `docs/guide/installation.md`." |
| `CLAUDE.md` (edit to one line) | Claude Code | Auto-loaded | Decided (section 7, question 2): `@AGENTS.md` as its only line, for older Claude Code versions and contributors with a `CLAUDE.local.md` (section 8.1). An import, not a symlink, because of the Edit/Write and Windows limits in section 2.3 |
| `GEMINI.md` (new, recommended) | Gemini CLI | Auto-loaded in a trusted folder | One line: `@./AGENTS.md`. Gemini CLI does not read `AGENTS.md` by default (section 8.2) |
| `scripts/doctor.mjs` + `"doctor"` npm script (new, decided) | Agents | Named in the guide | Checks Node version, `node_modules`, `dist/manifest.json` and `dist/ort/*`; optional Ollama probe. Exit 0 or 1. Not in `src/`, so the ARCHITECTURE.md rule in `CLAUDE.md` does not apply to it |
| `package.json` `engines` or `.nvmrc` (decided) | Agents and humans | Read by `npm` and version managers | Node floor 22 (user decision) |
| `.claude/skills/setup/SKILL.md` (new, decided) | Claude Code (and other agents that read `.claude/skills/`, UNVERIFIED which) | Listed at start; runs as `/setup` ([cc-skills]) | A short pointer: fetch or read `docs/guide/installation.md` and follow it, for re-runs and updates after the clone. It must not copy the guide, so that the two cannot drift. User decision 2026-10-10; this reverses the earlier "Not recommended now" |
| `src/manifest.json` `key` (edit, proposed) | Chrome, Edge | Read at load | The public key that fixes the extension ID, so that `OLLAMA_ORIGINS` can name one origin (section 8.3) |

Not recommended now:

- `llms.txt`: no website exists (section 2.8).
- `.cursor/rules/*.mdc`: Cursor reads `AGENTS.md` (section 2.6). A second copy would drift.
- Repeating the guide in `AGENTS.md`: Codex caps the combined instruction size at 32 KiB by default ([codex-docs]), and Claude Code advises under 200 lines per file ([cc-memory]). A pointer is enough.

Proposed paste block for `README.md`:

```
Install and set up meeting-summarizer by following the guide here:
https://raw.githubusercontent.com/dominic676767/meeting-summarizer/main/docs/guide/installation.md
```

The guide's first lines should tell the agent to fetch the raw file with `curl` (or another tool that returns the file unchanged), and not with a tool that summarizes ([cc-tools]).

---

## 6. Draft outline of `docs/guide/installation.md`

Outline only. The guide itself is not written here.

1. **Title and one-paragraph purpose.** What the extension does. What "set up" ends with: a built `dist/` loaded in the user's browser, with Settings filled in.
2. **For humans.**
   - The paste prompt (same text as the README block).
   - The manual route: link to the README "Install" section.
   - What the human will still do: about five clicks and key pastes. List them.
3. **For coding agents: rules.**
   - Fetch this file raw (`curl -fsSL <url>`). Do not use a summarizing fetch tool.
   - Do the steps in order. Ask before every step that changes something outside the clone.
   - Never ask for an API key or credential in the chat. Never print credentials. Put them on the clipboard only when the user asks.
   - Never create, change or delete AWS resources without explicit confirmation and a stated cost.
   - Never switch on microphone capture, answer a consent disclosure, or start a recording for the user.
   - Do not change defaults the user did not choose.
   - Use the CONTEXT.md terms: Provider, Transcription Provider, Meeting Language, Summary Artifact.
4. **Step 0: Ask the user.** Questions Q1-Q10 (section 4.3), each with its choices and its default. A table maps each answer to an agent action or an Options page field. Rules for skips (for example, skip Q4a unless Ollama). One summary of all answers, then one confirmation from the user before Step 1.
5. **Step 1: Check prerequisites.** Git, Node 22 or later, npm, the chosen browser. Exact check commands for macOS only (user decision: macOS only for now). What to say when a tool is missing. Delegate a long tool install to a subagent where the agent supports it.
6. **Step 2: Get the code.** Clone, or `git pull` in an existing clone. Warn that the browser loads `dist/` from this path, so the folder must not move.
7. **Step 3: Install and build.** `npm ci`, then `npm run build`. Developer mode only (user decision): typecheck and tests (README commands). Both are safe to re-run.
8. **Step 4: Verify the build.** `npm run doctor` (decided). Expected output. Exit codes.
9. **Step 5: Prepare the chosen services.** Branches by answer:
   - Ollama: install check, `ollama pull`, `OLLAMA_ORIGINS` set to this extension's one origin on macOS (with consent; the agent may restart Ollama), restart, probe (section 8.3).
   - SageMaker: read-only identity and endpoint checks only (user decision); invoke-only IAM policy (link to the README); credentials to the clipboard. The guide does not deploy an endpoint; it points to the README.
   - Cloud keys: tell the user where to create each key. Do not collect it.
10. **Step 6: Guide the human through loading the extension.** Per browser: the agent tries to open the Extensions page (`open -a "Google Chrome" "chrome://extensions"`, section 8.4) and falls back to "type `chrome://extensions` in the address bar". The agent may ask the user to opt in to browser control, but section 8.4 shows that no current tool can click *Load unpacked* for a lasting install. Then: Developer mode, *Load unpacked*, paste the `dist/` path, pin the icon. What a loaded card looks like. What an error on the card means. Why the agent cannot do this click (one sentence).
11. **Step 7: Guide the human through Settings.** Open the Options page. The agent prepares the non-secret settings as JSON and copies them to the clipboard; the user pastes them into the import box and checks the preview (section 8.5). The user pastes keys into their own fields. SageMaker: paste credentials, click *Test the endpoint*, read the failure kind. Microphone: the user decides and answers the disclosure; the import never sets it. Click *Save*.
12. **Step 8: First meeting checklist.** Notify participants and get consent (the README paragraph, in full). Turn on captions (Teams and Zoom steps). *Start recording* or `Ctrl/Cmd+Shift+U`. The first Whisper download. Where the Summary Artifact goes. What a Held Transcript or Held Recording means and how to retry.
13. **Troubleshooting table.** Symptom → cause → fix. Rows: `npm ci` fails (Node version, network or proxy, the pinned `onnxruntime-web` dev build); build fails; the card shows an error; Ollama refuses the origin; SageMaker test fails by kind; credentials expired after a browser restart; the model download stalls; no captions in Zoom. Rule: diagnose before you delete anything.
14. **Updating.** `git pull`, `npm ci`, `npm run build`, then *Reload* on the card. Settings and keys stay. SageMaker credentials must be pasted again after a browser restart.
15. **Uninstalling.** Remove the extension card. Delete the clone. Optional: the human stops the SageMaker endpoint (the agent does only read-only SageMaker calls); unset `OLLAMA_ORIGINS` (`launchctl unsetenv OLLAMA_ORIGINS`, then restart Ollama).
16. **What to tell the user at the end.** A short report:
    - what the agent did;
    - what the user chose;
    - what the user still must do (open items from steps 6-8);
    - how to start the first meeting.
    Also wanted (user decision 2026-10-10, details to be decided): a greeting slogan, a GitHub star request, and advertising. The star command runs only after an explicit yes from the user.

---

## 7. Decisions

Status on 2026-10-10. Every question is decided. The user answered in two rounds; the second round followed section 8.

1. **Paste URL target.** Decided: the prompt points at `main`, the single source of truth.
2. **CLAUDE.md form.** Decided: keep a one-line `CLAUDE.md` that holds `@AGENTS.md` (section 8.1). The current content moves to `AGENTS.md`.
3. **Gemini CLI.** Decided: a one-line `GEMINI.md` that holds `@./AGENTS.md` (section 8.2).
4. **A `doctor` script.** Decided: yes, `scripts/doctor.mjs` and `npm run doctor`. It probes Ollama only when Ollama is the chosen Provider. A Hugging Face probe is a warning only.
5. **Node version.** Decided: floor Node 22.
6. **Settings hand-off.** Decided: a settings import, by a paste box only (section 8.5). An import that only fills the Options page form before *Save* does not touch ADR-0001.
7. **Opening the Extensions page.** Decided: the agent runs `open -a "Google Chrome" "chrome://extensions"` and tells the user each step. No browser-control opt-in, because no tool can click *Developer mode* or *Load unpacked* in the user's own profile (section 8.4).
8. **SageMaker.** Decided: read-only checks of an existing endpoint only. The guide does not deploy.
9. **Ollama changes.** Decided: the agent may set `OLLAMA_ORIGINS` and restart Ollama. It allows only this extension's origin, which the manifest `key` makes the same for every clone (section 8.3).
10. **Platform scope.** Decided: macOS only for now. Windows and Linux are future work.
11. **Tests during install.** Decided: only in developer mode.
12. **Tone.** Decided: the agent says a project tagline at the start. After the setup report at the end, it lists this repo's main features with example uses, then asks once for a GitHub star. It runs `gh repo star` only on an explicit yes.
13. **A `/setup` skill.** Decided: a Claude skill and a one-line `.opencode/commands/setup.md` that points to the guide.
14. **Manifest `key` and existing installs.** Decided: add the key with no migration note.
15. **`OLLAMA_ORIGINS` after a reboot.** Decided: the doctor detects a missing value, and the agent sets it again.
16. **Import format.** Decided: a paste box only.
17. **Browser control opt-in.** Decided: removed (see question 7).
18. **Edge.** Decided: Chrome only for now.

---

## 8. Follow-up research (2026-10-10)

This section answers five points that the user decided or that the implementation depends on. Same rules as above: primary sources only, cited inline; UNVERIFIED marks what this research could not check. Nothing in the user's browser or in the running Ollama was changed. Two read-only checks ran on the maintainer's Mac (macOS 26.7.1, Google Chrome 155.0.8059.39, Ollama 0.40.1, Claude Code 2.1.295): a read of the extension list in the Chrome profile's `Secure Preferences` file, and HTTP probes of `localhost:11434` with an `Origin` header.

### 8.1 Claude Code and AGENTS.md

**Result: confirmed.** "Claude now supports AGENTS.md" is true from v2.1.277. Section 2.3 was correct. This section adds the details.

| Question | Answer | Source |
|---|---|---|
| If the repo deletes `CLAUDE.md` and has only `AGENTS.md`, does Claude Code load it with default settings? | Yes. "Claude Code can read `AGENTS.md` as your project instructions, so a repository already set up for other coding agents works without adding a `CLAUDE.md`, an import, or a setting." The condition is: no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the working directory or above it. `~/.claude/CLAUDE.md`, a managed `CLAUDE.md` and `.claude/rules/` files "Don't count". Claude also reads `.claude/AGENTS.md`. The session shows a line such as "no CLAUDE.md found; AGENTS.md loaded: …" | [Claude Code memory, "AGENTS.md" and "When Claude Code reads AGENTS.md"][cc-memory-agents] |
| Since which version? | v2.1.277: "Added AGENTS.md support: in a project with no CLAUDE.md, Claude Code reads AGENTS.md instead". On Amazon Bedrock, Google Vertex AI, Microsoft Foundry, LLM gateways and with telemetry off: v2.1.281 ("Changed AGENTS.md support to also work on Amazon Bedrock, …"). In some cases the first session after an upgrade from v2.1.276 or earlier does not read it; the next session does | [CHANGELOG 2.1.277 L1642][cc-changelog-277]; [CHANGELOG 2.1.281 L1477][cc-changelog-281]; [memory, "When AGENTS.md support is unavailable"][cc-memory-agents] |
| Is there a setting? | Yes. In `/config` it is **Project instructions**. In a settings file it is `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles` (plugin ID `agents-md@builtin` before v2.1.285). Values: `claude-md-or-agents-md` (the default), `claude-md-and-agents-md`, `claude-md`, `managed-only`. Claude Code reads it only from `~/.claude/settings.json`, a `--settings` file or managed settings, "and ignores it in project and local settings files". So a repo cannot change it. A user can also turn the support off by disabling the built-in plugin with `/plugin` | [memory, "Choose which instruction files load"][cc-memory-agents]; [settings reference, `pluginConfigs`][cc-settings-ref] |
| Does it expand `@path` imports inside `AGENTS.md`? | Yes: "Inside each `AGENTS.md`: `@path` imports are expanded". One difference from `CLAUDE.md`: an import of a file outside the working directory "Loads only if you already approved external imports for this project, with no prompt" | [memory, "When Claude Code reads AGENTS.md", "Where AGENTS.md differs from CLAUDE.md"][cc-memory-agents] |
| Do nested `AGENTS.md` files load on demand? | Yes: "a subdirectory's `AGENTS.md`, when Claude opens a file there with the Read tool and that subdirectory has none of the three `CLAUDE.md` files of its own". Only the Read tool triggers it (for a nested `CLAUDE.md`, a Bash read such as `cat` also counts). v2.1.290 fixed a nested `AGENTS.md` that did not attach when a file under it was @-mentioned. Not read at all: `AGENTS.local.md`, `AGENTS.override.md`, anything under `.agents/` | [memory][cc-memory-agents]; [CHANGELOG 2.1.290 L497][cc-changelog-290] |

Reasons to keep a one-line `CLAUDE.md` that holds `@AGENTS.md`:

1. **Older clients.** Before v2.1.277 (before v2.1.281 on Bedrock or with telemetry off), Claude Code reads `CLAUDE.md` files only. The docs say to keep the import "if some of your sessions can't load `AGENTS.md` directly" ([memory, "Remove an earlier AGENTS.md workaround"][cc-memory-agents]).
2. **First session after an upgrade** from v2.1.276 or earlier, and users who disabled the built-in plugin or chose `claude-md` ([memory][cc-memory-agents]).
3. **A contributor's own `CLAUDE.local.md`.** It counts as a `CLAUDE.md`, so with no `CLAUDE.md` in the repo it stops Claude from reading `AGENTS.md` ([memory, note under "When Claude Code reads AGENTS.md"][cc-memory-agents]). With a `CLAUDE.md` that imports `AGENTS.md`, both load.
4. **Hooks and extra directories.** `InstructionsLoaded` hooks "Don't fire" for an `AGENTS.md` read through the setting, but fire for an imported one. Directories added with `--add-dir` under `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` load their `CLAUDE.md`, not their `AGENTS.md` ([memory, "Where AGENTS.md differs from CLAUDE.md"][cc-memory-agents]).
5. **No cost.** "Keeping the import never makes Claude read `AGENTS.md` twice, whichever **Project instructions** value you use." ([memory][cc-memory-agents])

No other file in this repo names `CLAUDE.md` (searched 2026-10-10, outside this research file), so deleting it breaks no link. The user decided to keep a one-line `CLAUDE.md` (section 7, question 2).

Corrections made: summary item 6 and 8, the section 2.1 table row, section 2.3 (the AGENTS.md-only case, the v2.1.281 rule for Bedrock), and the section 5 rows for `AGENTS.md` and `CLAUDE.md`.

### 8.2 Gemini CLI and AGENTS.md

**Result: not confirmed for default settings.** Gemini CLI can load `AGENTS.md`, but only after a change in the repo. With default settings it loads `GEMINI.md` only. Section 2.7 was correct.

Evidence at `google-gemini/gemini-cli` HEAD `9b6e0265d16b` (2026-10-09; `package.json` version `0.65.0-nightly.20261006`; latest stable release `v0.63.0`, 2026-10-06):

- The default name is one file: `export const DEFAULT_CONTEXT_FILENAME = 'GEMINI.md';` ([memoryTool.ts L11-L16][gem-memorytool]).
- The CLI uses another name only when `settings.context?.fileName` is set; otherwise it resets to the default ([config.ts L620-L628][gem-config]). The schema default of `context.fileName` is `undefined` ([settingsSchema.ts L1395-L1404][gem-schema]; [configuration.md L1690-L1694][gem-confdoc]).
- No source file under `packages/core/src` or `packages/cli/src` (tests excluded) names `AGENTS.md`. In the docs, only the example list in [gemini-md.md L94-L108][gem-md-head] names it (grep, 2026-10-10).
- The release notes in `docs/changelogs/` and the last 100 GitHub releases do not mention `AGENTS.md` (searched 2026-10-10).
- The project's tracker: issue [#28227][gem-28227] ("AGENTS.md silently not loaded — not in default context.fileName list") is open. PRs [#24913][gem-24913] and [#28240][gem-28240], which add `AGENTS.md` to the defaults, were closed without a merge. Issues [#12345][gem-12345] and [#10401][gem-10401] were closed as "not planned".

So the answer to "since which version?" is: no version up to `v0.63.0` stable and the 2026-10-06 nightly loads a root `AGENTS.md` by default.

Two facts that matter for both ways of adding it:

- **Trust.** In an untrusted folder Gemini CLI does not load the project's context files at all: the project memory paths are read only when `isTrustedFolder()` is true ([memoryContextManager.ts L49-L62][gem-mcm]). It also ignores the project's `.gemini/settings.json` ([trusted-folders.md L73-L79][gem-trust]). Folder trust is on by default in the source ([settingsSchema.ts L1906-L1923][gem-schema-trust], `default: true`; also [configuration.md L1978-L1981][gem-confdoc-trust]). The page [trusted-folders.md L10][gem-trust] still says "disabled by default"; the source wins. So the user must trust the clone folder once, in the dialog that the CLI shows.
- **Names add to `GEMINI.md`.** `setGeminiMdFilename` adds the configured names to the current list, which starts as `GEMINI.md` ([memoryTool.ts L22-L49][gem-memorytool]). So `"fileName": "AGENTS.md"` should give `AGENTS.md` and `GEMINI.md`. UNVERIFIED by a run.

The smallest committed change:

| Change | Files | Loads root `AGENTS.md` | Loads nested `AGENTS.md` just in time | Notes |
|---|---|---|---|---|
| `GEMINI.md` with one line `@./AGENTS.md` (recommended) | 1 file, 1 line | Yes, through the import ([gemini-md.md L71-L89][gem-md-head]) | No; just-in-time loading looks only for the configured names | No settings file in the repo. Nothing else changes for Gemini users |
| `.gemini/settings.json` with `{"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}}` | 1 file | Yes | Yes | Puts a settings file in the repo. Do not copy `CONTEXT.md` from the docs' example by accident (section 2.7) |

This repo plans one root `AGENTS.md`, so the one-line `GEMINI.md` is enough. Corrections made: summary items 6 and 8, the section 2.1 row, a follow-up note in section 2.7, and the section 5 row (`GEMINI.md` is now "recommended", not "optional").

### 8.3 A fixed extension ID for an unpacked load, and `OLLAMA_ORIGINS`

**How Chrome makes the ID.** Chromium computes the ID in `ComputeExtensionID` ([extension.cc L154-L183][chromium-ext]):

- If the manifest has a `key`, the ID comes from the public key: "First 16 bytes of SHA256 hashed public key", hex-encoded, with each hex digit `0`-`f` changed to a letter `a`-`p` "to avoid ever having a completely numeric host" ([id_util.cc L24-L58][chromium-idutil]). The `key` value is base64 of the DER public key; a PEM header is also accepted ([extension.cc L372-L402][chromium-ext]).
- If there is no `key`, the ID is the same hash of the folder path: `GenerateIdForPath` ([id_util.cc L66-L69][chromium-idutil]). The source comment: "This is useful for development mode, because it keeps the ID stable across restarts and reloading the extension." ([extension.cc L176-L179][chromium-ext])

Tested here (read-only): the maintainer's loaded card has the ID `olfdehkpmjjhlmcagholgeacloblabbg` and the path `$HOME/Projects/meeting-summarizer/dist` (`Secure Preferences`, `location` 4). This command gives the same ID from that path:

```bash
printf '%s' "$(cd dist && pwd -P)" | shasum -a 256 | head -c 32 | tr 0-9a-f a-p; echo
```

So without a `key` the ID is stable for one clone path, but it is different for each user and each folder, and it changes when the folder moves. A moved clone would then break Ollama with no clear message. UNVERIFIED: whether Chrome resolves symlinks in the path before it hashes it (here the path had none).

**The Chrome docs on `key`:** it "maintains the unique ID of an extension, or theme when it is loaded during development". The first use case on the page is "To configure a server to only accept requests from your Chrome Extension origin." — the Ollama case here. The page gets the key from the Chrome Web Store Developer Dashboard, then: "Add the code to the manifest.json under the "key" field." ([Chrome: Manifest - key][chrome-key])

**Make a key pair and the ID without the Web Store.** Tested on 2026-10-10 with OpenSSL 3.6.4 in a scratch folder outside the repo. Two separate derivations (the pipeline below, and a SHA-256 of the base64-decoded key in Python) gave the same ID:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem                       # private key: never commit
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A; echo                  # value for "key"
openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 | head -c 32 | tr 0-9a-f a-p; echo   # extension ID
```

UNVERIFIED: that Chrome shows this ID after a load (not loaded here, because that changes the user's browser). Test: after the key is in `src/manifest.json`, run `npm run build`, click *Reload* or *Load unpacked*, and compare the ID on the card with the third command.

**Is a committed public `key` safe and normal?**

- It is a public key, and Chrome's own page tells developers to put it in `manifest.json` ([chrome-key]). Chromium only parses it; for an unpacked load it checks no signature ([extension.cc L154-L183][chromium-ext]). So the private key is not needed to load the extension. Keep `key.pem` out of git (for example a `*.pem` line in `.gitignore`), or delete it. It is useful only to pack a `.crx` with the same ID later. UNVERIFIED: whether the Chrome Web Store accepts a self-made key at a later upload.
- Limit: because the key is public, any other extension can copy it and get the same ID and origin. So an exact origin trusts "the extension that carries this key", not "this code". UNVERIFIED (no source read): that Chrome refuses a second extension with the same ID in one profile. This is still much narrower than `chrome-extension://*`, which trusts every installed extension.
- Side effect: the ID changes for every existing install (path hash → key hash). Extension storage belongs to the ID, so Settings, Held Transcripts and Held Recordings of the old ID do not move to the new one. UNVERIFIED: what Chrome shows on *Reload* when the ID changes. Section 7, question 14.

**Where the `key` goes in this repo.** The source manifest is `src/manifest.json`; `build.mjs` copies it to `dist/manifest.json` ([build.mjs L56](../../build.mjs)). Add `"key": "<base64>"` as a top-level property, for example after `"version"` ([src/manifest.json L4](../../src/manifest.json)). No test reads the manifest (searched `tests/`). The change adds no `src/` file, so the ARCHITECTURE.md rule does not ask for a diagram change.

**Edge.** Microsoft's manifest format page lists `"key": "publicKey"` ([Edge manifest format][edge-manifest]), and the ID code above is Chromium code. UNVERIFIED (Edge is not installed on this Mac): that Edge gives the same ID, and that Edge sends `Origin: chrome-extension://<ID>` to Ollama.

**How `OLLAMA_ORIGINS` matches** (Ollama at `eab97e9f92b9`, which uses `github.com/gin-contrib/cors v1.7.2`):

- Ollama splits the value on `,` and adds its defaults: `localhost`, `127.0.0.1` and `0.0.0.0` with `http`/`https` and any port, plus `app://*`, `file://*`, `tauri://*`, `vscode-webview://*`, `vscode-file://*`. No `chrome-extension://` origin is in the defaults ([envconfig/config.go L85-L108][ollama-env]). It trims only the whole value, not each entry ([config.go L378-L380][ollama-env-var]).
- It turns on wildcards and browser-extension schemes: `AllowWildcard = true`, `AllowBrowserExtensions = true` ([server/routes.go L2257-L2289][ollama-routes]).
- In gin-contrib/cors an origin is first compared as an exact string, then against wildcard entries ([config.go L101-L141][cors-match]). A wildcard entry may have only one `*` ([cors.go L143-L174][cors-validate]). An entry without `*` must start with an allowed scheme, and `chrome-extension://` is one when browser extensions are on ([config.go L22-L32][cors-match]; [cors.go L89-L141][cors-validate]). Otherwise `Validate` returns "bad origin", and `newCors` panics ([config.go L42-L45][cors-match]).
- A request with a refused `Origin` gets `403`. An allowed origin gets `Access-Control-Allow-Origin: <that origin>` ([config.go L70-L99][cors-match]).

So `OLLAMA_ORIGINS=chrome-extension://<ID>` is an exact match for this extension only. Do not put a space after a comma: the entry `" chrome-extension://…"` has no `*` and no allowed scheme at its start, so by the source the server panics at start (not tested).

Tested here with `OLLAMA_ORIGINS` not set: `GET /api/tags` with `Origin: chrome-extension://olfdehkpmjjhlmcagholgeacloblabbg` returned `403`; another `chrome-extension://` ID and `https://example.com` also returned `403`.

**The macOS Ollama app:**

- The FAQ: "If Ollama is run as a macOS application, environment variables should be set using `launchctl`", then "Restart Ollama application." ([Ollama FAQ L79-L89][ollama-faq-head])
- The app copies its own environment into the `ollama serve` process it starts ([app/server/server.go L246-L249][ollama-app-server]). So the app process itself must start after `launchctl setenv`: quit the app, then open it again.
- The app has a stored setting `Browser`. When it is on, the app sets `OLLAMA_ORIGINS` to `*` and so overrides the exact origin ([app/server/server.go L253-L255][ollama-app-server]; [app/store/store.go L129-L131][ollama-app-store]). Its default is off ([Settings.tsx L102][ollama-settings-tsx]). UNVERIFIED: where the app shows this setting. The doctor can catch it: a probe with a foreign ID must still return `403`.
- `launchctl setenv` does not persist. `man launchctl` on this Mac: `setenv` applies to "all future processes launched by launchd in the caller's context"; the persistent `config` subcommand supports only `umask` and `path`, and "cannot be used to set general environment variables". The FAQ gives no persistent way. So after a reboot the variable is gone (from the man page; not tested by a reboot). Section 7, question 15.
- An existing value must be kept: read `launchctl getenv OLLAMA_ORIGINS` first and append with `,` and no space.

Commands for the guide (not run here, because they change the running Ollama):

```bash
launchctl getenv OLLAMA_ORIGINS                                   # keep any existing entries
launchctl setenv OLLAMA_ORIGINS "chrome-extension://<ID>"
osascript -e 'quit app "Ollama"'                                  # UNVERIFIED: the menu-bar app answers this quit event
open -a Ollama
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: chrome-extension://<ID>' http://localhost:11434/api/tags   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' http://localhost:11434/api/tags   # expect 403
```

If `quit app` does not work, the user quits Ollama from its menu-bar icon. The README still says `OLLAMA_ORIGINS=chrome-extension://*` ([README.md L35](../../README.md)); the implementation must change that line.

Corrections made: the section 3.3 Ollama bullet, the section 4.1 Ollama row (exact origin; the 403 result replaces the old "UNVERIFIED: CORS headers"), outline step 9, section 7 question 9.

### 8.4 Opening `chrome://extensions`, and browser control on macOS

**A. Opening the page from the shell.** A URL can reach Chrome as an Apple event (from `open` or AppleScript) or as a command-line argument. The source treats these routes differently.

| Command | Route | What the source does | Result |
|---|---|---|---|
| `open -a "Google Chrome" "chrome://extensions"` | `open` passes a URL as a URL ("If the file is in the form of a URL, the file will be opened as a URL", `man open`). Chrome gets it in `application:openURLs:` | The handler checks only URLs wrapped in `google-chrome://`; any other URL goes on to the tab opener unchanged ([app_controller_mac.mm L2060-L2084][chromium-acm]). The opener filters only `.webloc` shortcut files ([app_controller_mac.mm L439-L480][chromium-acm]) | Probably opens the page. UNVERIFIED (not run) |
| `osascript -e 'tell application "Google Chrome" to set URL of active tab of front window to "chrome://extensions"'` | Chrome's AppleScript support | Refuses only `javascript:` (when JavaScript from Apple Events is off) and invalid URLs, then opens the URL as a typed, browser-initiated navigation ([tab_applescript.mm L150-L182][chromium-tabas]) | Probably works. UNVERIFIED (not run). UNVERIFIED: macOS asks once to let the terminal control Chrome |
| `open -a "Google Chrome" --args chrome://extensions`, or the binary with `chrome://extensions` as an argument | Command line (`--args` is passed "in the argv parameter to main()", `man open`) | Command-line tabs pass `ValidateLaunchUrlWebUnsafe`. Outside ChromeOS and headless mode it accepts web-safe schemes, `file:`, `about:blank` and only the exact URL `chrome://settings/resetProfileSettings` ([startup_tab_provider.cc L298-L350][chromium-stp]; [url_util.cc L45-L90][chromium-urlutil]) | Does not open `chrome://extensions` (from the source) |

Recommendation for the guide: try `open -a "Google Chrome" "chrome://extensions"`; if no Extensions tab appears, tell the user to type `chrome://extensions` in the address bar. The Chrome docs' sentence "By design chrome:// URLs are not linkable" ([chrome-hello]) is about links in web pages, not about the operating system.

**B. Controlling the user's real Chrome profile, with the user's opt-in.**

| Tool | Agents | What the user does to opt in | Reaches the daily profile | Can it click *Developer mode* and *Load unpacked*? |
|---|---|---|---|---|
| Claude in Chrome (`claude --chrome`, `/chrome`) | Claude Code CLI and VS Code extension only | Install the Claude extension from the Chrome Web Store; start with `--chrome` or turn it on in `/chrome`; approve site permissions. Needs "A direct Anthropic plan (Pro, Max, Team, or Enterprise)" and `/login`. "not available through third-party providers like Amazon Bedrock". A project setting cannot turn it on ([Claude in Chrome][cc-chrome]) | Yes: it "shares your browser's login state" ([cc-chrome]) | Expected no. It is a Chrome extension, and Chromium refuses extension access to `chrome://` pages unless Chrome runs with `--extensions-on-chrome-urls` ([permissions_data.cc L156-L161][chromium-permdata]). UNVERIFIED by a test. Its file upload works for web upload fields ([cc-chrome]), not for the native folder dialog |
| Chrome DevTools MCP with `--autoConnect` | Any MCP client; the project documents Claude Code, Codex, Gemini CLI, Cursor, OpenCode and others ([client-configurations.md][cdm-clients]) | Chrome 144 or later. The user opens `chrome://inspect/#remote-debugging`, turns on remote debugging, and clicks **Allow** in the dialog that Chrome shows when the server connects ([advanced-usage.md L50-L100][cdm-advanced]) | Yes: "the default profile (as determined by Chrome)", with "access to all open windows" ([cdm-advanced]) | No. The server refuses to navigate to `chrome:` URLs other than the new-tab and inspect pages ([src/utils/url.ts L62-L110][cdm-url]). Its `install_extension` tool needs `--categoryExtensions` ([tool-reference.md][cdm-tools]), and the server rejects `--categoryExtensions` together with `--autoConnect`, `--browserUrl` or `--wsEndpoint` ([src/config/mcp-options.ts L332-L344][cdm-conflicts]). The docs say this lasts "until 149 will be released" ([configuration.md L37-L40][cdm-config]); Chrome 149 is out, but the code at HEAD still rejects the pair |
| Chrome DevTools MCP with `--browserUrl` | Same | Start Chrome with `--remote-debugging-port` | No: from Chrome 136 these switches "will no longer be respected if attempting to debug the default Chrome data directory" and need `--user-data-dir` with another folder ([Chrome blog: remote debugging changes][chrome-rdp]; [advanced-usage.md L132][cdm-advanced]) | Not in the daily profile |
| Playwright MCP with `--extension` | Any MCP client | Install "Playwright Extension" from the Chrome Web Store; approve each connection, or set `PLAYWRIGHT_MCP_EXTENSION_TOKEN`; pick the tab ([Playwright extension README][pw-ext]; [Playwright MCP README L425, L442, L511][pw-mcp]) | Yes: it uses "the state of your default user profile" ([pw-ext]) | Expected no. It works through an extension. The `chrome.debugger` API refuses restricted URLs such as `chrome://` pages ([debugger_api.cc L195-L250][chromium-dbg]), and its list of allowed CDP domains has no `Extensions` domain ([Chrome: chrome.debugger, "Restricted domains"][chrome-debugger]). UNVERIFIED: that Playwright Extension uses `chrome.debugger` |
| Claude Code computer use | Claude Code CLI on macOS; Pro or Max plan; claude.ai login, not Bedrock ([computer use][cc-cu]) | Grant Accessibility and Screen Recording; approve each app per session | — | No: "browsers and trading platforms are view-only" ([cc-cu]) |
| The agent's own CDP script, connected like `--autoConnect` | Any agent with a shell | Same as Chrome DevTools MCP | Yes | It can call `Extensions.loadUnpacked`, but the install does not last (see below). It cannot click the page either |

**`Extensions.loadUnpacked` on the user's own running Chrome.** Before Chrome 149 the command needed `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`, so only a Chrome that a tool started could use it. Chromium commit [dddf05b0e69f][cr-dddf05b] "Remove requirements for --remote-debugging-pipe and --enable-unsafe-extension-debugging for debugging of extensions via CDP" says: "This makes it possible to install extensions via WebSockets where WebSockets are allowed." Commit [3e47d0a28ad1][cr-3e47d0a] removed the flag. ChromiumDash puts both in Chrome 149 (first canary `149.0.7797.0` and `149.0.7809.0`; stable `149.0.7827.22`) ([ChromiumDash][crdash-dddf05b]). The current code allows the command on the browser target only ([chrome_devtools_session.cc L101-L106][chromium-cds]; [extensions_handler.cc L225-L249][chromium-eh]). But commit [03338921851f][cr-0333892] (also Chrome 149) "ensures that extensions installed via CDP are not persisted after the browser restart". So on this Mac (Chrome 155) an agent could load `dist/` over CDP after the user's opt-in, and the extension would be gone at the next Chrome start. UNVERIFIED: whether that removal also deletes the extension's `chrome.storage.local`, which holds the Settings. Not usable for the daily install.

**The native folder dialog.** *Load unpacked* opens the operating system's folder picker. CDP's `Page.setInterceptFileChooserDialog` replaces the "native file chooser dialog" with a `Page.fileChooserOpened` event ([CDP browser_protocol.json][cdp]). UNVERIFIED: whether it applies to the folder picker of the `chrome://extensions` page (expected no, because that page is not a web page with a file input). Driving the dialog with macOS keystrokes needs Accessibility permission and is fragile; not recommended. For the human: UNVERIFIED in Apple docs for the Open dialog, Command-Shift-G opens a "Go to Folder" field where a pasted path works (Apple documents **Go > Go to Folder** for the Finder: [Apple: Go directly to a folder][apple-gotofolder]).

**Conclusion.** The agent can probably open `chrome://extensions` with `open -a`. No browser-control tool can click *Developer mode* or *Load unpacked* in the daily profile, and the one API that loads the extension removes it at the next restart. So the user removed the opt-in from the guide (section 7, questions 7 and 17).

Corrections made: section 3.2 rows "Puppeteer … CDP `Extensions.loadUnpacked`" (Chrome 149 change, uninstall at restart, new line numbers) and "Open the Extensions page" (source evidence replaces the bare UNVERIFIED), the closing paragraph of section 3.2, summary item 7, and outline step 10.

### 8.5 Settings import

**Current state.** Only the Options page *Save* writes the Settings: it reads the form and calls `saveSettings`, which writes the key `settings` to `storage.local` ([src/options/options.ts L319-L395](../../src/options/options.ts); [src/settings.ts L91-L93](../../src/settings.ts)). `loadSettings` merges the stored values over `DEFAULT_SETTINGS`, section by section ([src/settings.ts L49-L89](../../src/settings.ts)). SageMaker credentials are separate, in `storage.session` ([src/settings.ts L95-L119](../../src/settings.ts); [ADR-0009 L23-L26](../adr/0009-sagemaker-transcription-on-temporary-aws-credentials.md)). ARCHITECTURE.md §11 lists Settings as created by "Options page save" and deleted "never (user-owned)" ([docs/ARCHITECTURE.md L568](../ARCHITECTURE.md)).

**ADR-0001** says that "Provider API keys live in `browser.storage.local`", that there is no native host, and that the extension needs "no extra install step" ([ADR-0001 L5-L9](../adr/0001-pure-webextension-no-native-host.md)). It says nothing about where non-secret values come from.

**What must never be in the file.** The importer must refuse a file that has any of these fields, with a message. It must not drop them silently, so that a key never sits on disk as an "imported" value:

- Every API key: `anthropic.apiKey`, `openai.apiKey`, `bedrock.apiKey`, `transcription.openai.apiKey`, `transcription.elevenlabs.apiKey` ([src/settings.ts L13-L16, L40-L43](../../src/settings.ts)).
- SageMaker AWS credentials of any form (access key, secret key, session token). They live only in `storage.session` ([ADR-0009](../adr/0009-sagemaker-transcription-on-temporary-aws-credentials.md)).
- `micCapture` (`enabled`, `confirmedAt`). Microphone consent is the user's own act, and the two gates must be set only by answering the disclosure ([CONTEXT.md L15](../../CONTEXT.md); [src/settings.ts L20-L29](../../src/settings.ts); [src/options/options.ts L358-L372](../../src/options/options.ts)).

Allowed values: Provider, model names, Ollama base URL, Bedrock region and model, Transcription Provider, Meeting Language, Whisper model size, SageMaker region and endpoint name, Summary shape, name-engine, but not the two Prompt Templates: the first version imports the choices only.

| Way | How the agent's file reaches `storage.local` | Pros | Cons | ADR-0001 |
|---|---|---|---|---|
| (a) File picker (`<input type="file">`) on the Options page | The agent writes a git-ignored JSON file in the clone. The user clicks *Import*, picks it, checks a preview, clicks *Save* | No new permission. Values go through the same *Save*. An explicit user act | A second native file dialog, the same pain as *Load unpacked*. The file stays on disk (harmless without keys) | No conflict |
| (b) Paste into a box on the Options page (recommended) | The agent puts the JSON on the clipboard (`pbcopy`). The user pastes it, checks a preview, clicks *Save* | No file dialog. Nothing on disk. The Options page already uses this pattern for SageMaker credentials ([src/options/options.ts L122-L141](../../src/options/options.ts)) | The clipboard can be overwritten before the paste; the parser must refuse keys | No conflict |
| (c) Build-time defaults (a git-ignored `settings.local.json` that `build.mjs` puts into `DEFAULT_SETTINGS`) | No user step. The values are defaults in the bundle | No clicks | Defaults matter only for values never saved: after the first *Save*, stored values win ([src/settings.ts L52-L88](../../src/settings.ts)), so a later rebuild changes nothing, with no message. Builds differ per machine; today `build.mjs` reads only `src/` and `node_modules/` ([build.mjs L13-L65](../../build.mjs)). A key put in the file by mistake lands in plain JS in `dist/` | Not against its text, but against the rule that no key is baked into `dist/` (section 7, earlier question 6) |
| (d) Managed storage by enterprise policy (`storage.managed_schema`) | Chrome loads policy values from the operating system; the extension reads `storage.managed` | No clicks after the policy is in place | Chrome docs: "Managed storage is read-only for policy-installed extensions … configured by a system administrator" ([chrome.storage][chrome-storage]; [Manifest for managed storage][chrome-managed]). The extension needs a schema file and code that treats policy values as defaults. On macOS Chrome reads extension policy from the domain `com.google.Chrome.extensions.<ID>` ([policy_loader_mac.mm L199-L250][chromium-polmac]), and `storage.managed` shows only mandatory values ([policy_value_store.cc L47-L51][chromium-pvs]), which on macOS are forced (managed) preferences ([policy_loader_mac.mm L238-L243][chromium-polmac]): a configuration profile, not a `defaults write`. Needs the fixed ID (section 8.3). UNVERIFIED: that Chrome registers the schema for an unpacked, user-loaded extension | Conflicts with its "no extra install step" |
| (e) CDP `Extensions.setStorageItems` on the real Chrome | An agent script writes `storage.local` over CDP | No clicks | Needs the browser-control opt-in (section 8.4). The call works only from the extension's own service worker or page target ([extensions_handler.cc L52-L112][chromium-eh]). The agent would hold a write path to the storage that holds keys | Against the guide's rule that keys never pass through the agent |

**Recommendation: (b), paste into a box.** One parser checks a versioned format (for example a top-level `"meetingSummarizerSettings": 1`), refuses the fields above and unknown fields, checks every choice against the allowed values, and fills the form. Nothing is stored until the user clicks *Save*, so the existing *Save* path and the microphone consent rule stay as they are. A file picker (a) can use the same parser later.

Implementation notes: a new `src/` file (for example `src/options/settings-import.ts`) must go into ARCHITECTURE.md §3 and §13, and §11 must name the import as a second way to create Settings ([docs/ARCHITECTURE.md L737-L753](../ARCHITECTURE.md); [CLAUDE.md](../../CLAUDE.md)). A short ADR is still useful to record the "never keys, never consent" rule, but ADR-0001 needs no change.

Correction made: section 7, question 6 earlier said that an import "would touch ADR-0001's storage rule and needs its own ADR". For (a) and (b) that is not correct (see the ADR-0001 column). Also: the section 4.2 Settings row and outline step 11.

---

## Sources

[omo-l31]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L31-L33
[omo-l35]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L35-L42
[omo-l135]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L135-L142
[omo-l146]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L146-L154
[omo-l219]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L219-L229
[omo-l231]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L231-L314
[omo-l316]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L316-L365
[omo-l367]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L367-L423
[omo-l425]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L425
[omo-l427]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L427-L465
[omo-l475]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L467-L486
[omo-l528]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L528-L565
[omo-l608]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L608-L726
[omo-l710]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L710-L722
[omo-l785]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L785-L794
[omo-l796]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L796-L967
[omo-l828]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L828
[omo-l830]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/docs/guide/installation.md#L830-L842
[omo-readme]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/README.md#L51-L62
[omo-agentsmd]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/AGENTS.md#L1-L13
[omo-cli]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/packages/omo-opencode/src/cli/cli-installer.ts
[omo-validators]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/packages/omo-opencode/src/cli/install-validators.ts#L135-L157
[omo-validators-codex]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/packages/omo-opencode/src/cli/install-validators.ts#L209-L220
[omo-star]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/packages/omo-opencode/src/cli/star-request.ts#L28-L34
[omo-doctor-schema]: https://github.com/code-yeongyu/oh-my-openagent/blob/b2b18aada62b130d7070145217dc122f77f30867/assets/help/doctor.schema.json
[omojan-l17]: https://github.com/code-yeongyu/oh-my-openagent/blob/b0bb4048c95998874cacd923443f32f5ddaf7de7/docs/guide/installation.md#L17-L24
[omojan-l26]: https://github.com/code-yeongyu/oh-my-openagent/blob/b0bb4048c95998874cacd923443f32f5ddaf7de7/docs/guide/installation.md#L26-L28
[omojan-l66]: https://github.com/code-yeongyu/oh-my-openagent/blob/b0bb4048c95998874cacd923443f32f5ddaf7de7/docs/guide/installation.md#L66-L68
[omojan-l202]: https://github.com/code-yeongyu/oh-my-openagent/blob/b0bb4048c95998874cacd923443f32f5ddaf7de7/docs/guide/installation.md#L202-L210
[omojan-l216]: https://github.com/code-yeongyu/oh-my-openagent/blob/b0bb4048c95998874cacd923443f32f5ddaf7de7/docs/guide/installation.md#L216-L235
[agentsmd]: https://agents.md/
[cc-memory]: https://code.claude.com/docs/en/memory
[cc-skills]: https://code.claude.com/docs/en/skills
[cc-tools]: https://code.claude.com/docs/en/tools-reference#webfetch-tool-behavior
[codex-docs]: https://developers.openai.com/codex/guides/agents-md
[codex-src]: https://github.com/openai/codex/blob/8ec80de0ef55d2fb393332d75c32df9751496a58/codex-rs/core/src/agents_md.rs
[oc-rules]: https://opencode.ai/docs/rules/
[oc-commands]: https://opencode.ai/docs/commands/
[cursor-rules]: https://cursor.com/docs/context/rules
[gemini-md]: https://github.com/google-gemini/gemini-cli/blob/93844dfa10f6d71edc09be40dfde205edfbcc939/docs/cli/gemini-md.md
[llmstxt]: https://llmstxt.org/
[chrome-hello]: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
[chrome-puppeteer]: https://developer.chrome.com/docs/extensions/how-to/test/puppeteer
[chromium-es]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/extension_service.cc
[chromium-eh]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/devtools/protocol/extensions_handler.cc
[cdp]: https://github.com/ChromeDevTools/devtools-protocol/blob/8033bef7599713ae32b8777386fcbd82a7e612ed/json/browser_protocol.json
[edge-sideload]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading
[ollama-faq]: https://github.com/ollama/ollama/blob/948f69330acf96a2310f1b53fdfc211731a386d8/docs/faq.mdx

Added for section 8 (all fetched 2026-10-10):

[cc-memory-agents]: https://code.claude.com/docs/en/memory#agents-md
[cc-settings-ref]: https://code.claude.com/docs/en/settings-reference#pluginconfigs
[cc-changelog-277]: https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md#L1640-L1642
[cc-changelog-281]: https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md#L1477
[cc-changelog-290]: https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md#L497
[cc-chrome]: https://code.claude.com/docs/en/chrome
[cc-cu]: https://code.claude.com/docs/en/computer-use
[gem-memorytool]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/packages/core/src/tools/memoryTool.ts#L11-L49
[gem-config]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/packages/cli/src/config/config.ts#L620-L628
[gem-schema]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/packages/cli/src/config/settingsSchema.ts#L1395-L1404
[gem-schema-trust]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/packages/cli/src/config/settingsSchema.ts#L1906-L1923
[gem-confdoc]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/docs/reference/configuration.md#L1690-L1694
[gem-confdoc-trust]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/docs/reference/configuration.md#L1978-L1981
[gem-md-head]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/docs/cli/gemini-md.md
[gem-mcm]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/packages/core/src/context/memoryContextManager.ts#L49-L62
[gem-trust]: https://github.com/google-gemini/gemini-cli/blob/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83/docs/cli/trusted-folders.md
[gem-28227]: https://github.com/google-gemini/gemini-cli/issues/28227
[gem-24913]: https://github.com/google-gemini/gemini-cli/pull/24913
[gem-28240]: https://github.com/google-gemini/gemini-cli/pull/28240
[gem-12345]: https://github.com/google-gemini/gemini-cli/issues/12345
[gem-10401]: https://github.com/google-gemini/gemini-cli/issues/10401
[chrome-key]: https://developer.chrome.com/docs/extensions/reference/manifest/key
[chrome-storage]: https://developer.chrome.com/docs/extensions/reference/api/storage
[chrome-managed]: https://developer.chrome.com/docs/extensions/reference/manifest/storage
[chrome-debugger]: https://developer.chrome.com/docs/extensions/reference/api/debugger
[chrome-rdp]: https://developer.chrome.com/blog/remote-debugging-port
[edge-manifest]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/manifest-format
[chromium-ext]: https://chromium.googlesource.com/chromium/src/+/main/extensions/common/extension.cc
[chromium-idutil]: https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc
[chromium-acm]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/app_controller_mac.mm
[chromium-tabas]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/cocoa/applescript/tab_applescript.mm
[chromium-stp]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/startup_tab_provider.cc
[chromium-urlutil]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/url_util.cc
[chromium-cds]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/devtools/chrome_devtools_session.cc
[chromium-permdata]: https://chromium.googlesource.com/chromium/src/+/main/extensions/common/permissions/permissions_data.cc
[chromium-dbg]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc
[chromium-polmac]: https://chromium.googlesource.com/chromium/src/+/main/components/policy/core/common/policy_loader_mac.mm
[chromium-pvs]: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/storage/policy_value_store.cc
[cr-dddf05b]: https://github.com/chromium/chromium/commit/dddf05b0e69f88da95c3d6d4698521b775f20c2a
[cr-3e47d0a]: https://github.com/chromium/chromium/commit/3e47d0a28ad186a9c0c4a03425c51029fb7f7201
[cr-0333892]: https://github.com/chromium/chromium/commit/03338921851f5a0773c4d6b68586133851e2ca4e
[crdash-dddf05b]: https://chromiumdash.appspot.com/fetch_commit?commit=dddf05b0e69f88da95c3d6d4698521b775f20c2a
[cdm-config]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/docs/configuration.md#L37-L72
[cdm-advanced]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/docs/advanced-usage.md#L50-L132
[cdm-clients]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/docs/client-configurations.md
[cdm-tools]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/docs/tool-reference.md#install_extension
[cdm-url]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/src/utils/url.ts#L62-L110
[cdm-conflicts]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/src/config/mcp-options.ts#L332-L344
[pw-mcp]: https://github.com/microsoft/playwright-mcp/blob/b8b4183e099f136cbec0388a6088d4aa2f6b9685/README.md
[pw-ext]: https://github.com/microsoft/playwright/blob/d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c/packages/extension/README.md
[ollama-faq-head]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/faq.mdx#L79-L89
[ollama-env]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/envconfig/config.go#L85-L108
[ollama-env-var]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/envconfig/config.go#L378-L380
[ollama-routes]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/server/routes.go#L2257-L2289
[ollama-app-server]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/app/server/server.go#L230-L275
[ollama-app-store]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/app/store/store.go#L124-L131
[ollama-settings-tsx]: https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/app/ui/app/src/components/Settings.tsx#L102
[cors-match]: https://github.com/gin-contrib/cors/blob/v1.7.2/config.go
[cors-validate]: https://github.com/gin-contrib/cors/blob/v1.7.2/cors.go
[apple-gotofolder]: https://support.apple.com/guide/mac-help/go-directly-to-a-specific-folder-on-mac-mchlp1236/mac

Local primary sources for section 8, read 2026-10-10 on the maintainer's Mac: `man launchctl` (`setenv`, `config`) and `man open` (`-a`, `--args`), macOS 26.7.1.

Chromium files on `main` were read on 2026-10-10; line numbers refer to that read. Lines cited from `extension_service.cc`: 162-170 (command-line blocklist helper) and 421-437 (`--load-extension` gate). Lines cited from `extensions_handler.cc`: 225-249 (`LoadUnpacked`; the earlier text cited 215-233, the constructor that passes the browser-target flag and the start of `LoadUnpacked`) and 52-112 (`CanAccessStorage`). Section 8 also cites `extension.cc` 154-183 and 372-402, `id_util.cc` 24-69, `app_controller_mac.mm` 439-480 and 2060-2084, `tab_applescript.mm` 150-182, `startup_tab_provider.cc` 298-350, `url_util.cc` 45-90, `chrome_devtools_session.cc` 101-106, `permissions_data.cc` 156-161, `debugger_api.cc` 195-250, `policy_loader_mac.mm` 199-250, `policy_value_store.cc` 47-51. The GitHub mirror `chromium/chromium` was used for commit messages, and ChromiumDash for the Chrome milestone of each commit.
