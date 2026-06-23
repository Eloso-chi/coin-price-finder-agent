# Agent Loading Order

How VS Code Copilot loads agent customization in this repo. Added under
#271W F18 to remove ambiguity about where new content belongs and what
gets loaded automatically.

This is a meta doc; it does NOT define new rules, it describes the
mechanics. Source-of-truth for individual rules lives in the file each
section references.

---

## Surfaces (in load order)

1. **User memory -- `/memories/`** (cross-workspace, machine-local)
   - First 200 lines auto-loaded into every conversation's system context.
   - Use for: preferences, common patterns, frequently used commands,
     truly cross-project insights.
   - Files referenced by this repo's workflow:
     - `/memories/operating-rules.md` -- user-side operating rules (PR
       Workflow section is a pointer to `.github/skills/workflow/SKILL.md`)
     - `/memories/server-management.md` -- isBackground rules (INC-003)
     - `/memories/gh-cli-codespaces.md` -- gh CLI token quirk (INC-008)
   - **Source-of-truth note:** when a rule applies across all workspaces,
     it lives here; when it's repo-specific, it lives in repo memory or
     a SKILL.

2. **Repo memory -- `/memories/repo/`** (workspace-scoped, machine-local)
   - File names listed in context; full content NOT auto-loaded.
   - Use the memory tool to read specific files on demand.
   - Files copied from `docs/memory/` on 2026-06-17 carry a `MIGRATED to
     docs/memory/...` banner. The canonical version is in git; the
     `/memories/repo/` copy is a stale machine-local backup -- agents
     SHOULD prefer `docs/memory/` when both exist.

3. **Session memory -- `/memories/session/`** (conversation-scoped)
   - Cleared when the conversation ends.
   - Use for in-progress plans, working notes, multi-turn context.

4. **Canonical repo memory -- `docs/memory/`** (git-tracked)
   - The authoritative corpus. Read in Phase 1 of the onboard agent.
   - Single source of truth for repo-scoped long-lived knowledge:
     codebase overview, decision-engine spec, numismatic terminology
     (MANDATORY Pool-Isolation Contract), terapeak runbook, INC analyses,
     etc.
   - All new long-lived knowledge goes here (not `/memories/repo/`).

5. **`.github/copilot-instructions.md`** (always loaded with every PR /
   chat in this repo)
   - Repo-wide rules: testing, safety, conventions.
   - Loaded automatically by Copilot.

6. **`.github/agents/*.agent.md`** (workspace agents, loaded on `@-mention`)
   - Each file defines a sub-agent (name, tools, prompt). NOT loaded
     into the main context; invoked explicitly via `@<agent-name>` in
     chat or via the `/agent` slash commands.
   - Current agents listed in `docs/memory/agents-and-prompts.md`.
   - Example: `@pre-commit-reviewer`, `@code-reviewer.approval-gated`,
     `@numismatic-audit`, `@onboard`.

7. **`.github/prompts/*.prompt.md`** (slash commands, loaded on invocation)
   - Each file defines a slash command (`/pre-commit`, `/review-deep`,
     `/onboard`, `/test-coverage`, `/ux-reviewer`, `/apply-approved`).
   - These are thin wrappers over the corresponding agent files in
     `.github/agents/`.

8. **`.github/skills/<topic>/SKILL.md`** (loaded by agents that cite them)
   - Domain knowledge shared between agents (not loaded into main
     context). An agent's prompt file lists the skills it consults; the
     agent then reads the skill at runtime.
   - Current skills (7 as of 2026-06-23):
     - `code-review/SKILL.md` -- 8-category review framework
     - `numismatics/SKILL.md` -- domain knowledge + MANDATORY Pool-Isolation Contract
     - `testing/TESTING-PLAN.md` -- testing strategy
     - `workflow/SKILL.md` -- canonical PR workflow (#271W F6)
     - `process-discipline/SKILL.md` -- hot-file -> INC mapping + WASTE-LEDGER author guide (#271W F9)
     - `valuation/SKILL.md` -- FMV / confidence / buy-sell routing reference (#271W F7)
     - `comp-data/SKILL.md` -- eBay cascade + Terapeak routing reference (#271W F8)

---

## Where Does New Content Belong?

| New content | Goes in |
|---|---|
| Cross-workspace personal rule | `/memories/<topic>.md` (user memory) |
| Repo-specific long-lived knowledge | `docs/memory/<topic>.md` (git-tracked) |
| Repo-specific machine-local cache that may drift | `/memories/repo/<topic>.md` (rarely needed; prefer docs/memory) |
| Working notes for the current conversation | `/memories/session/<topic>.md` |
| Reusable domain reference cited by multiple agents | `.github/skills/<topic>/SKILL.md` |
| Sub-agent with its own tools / prompt | `.github/agents/<name>.agent.md` |
| Slash command wrapping an agent | `.github/prompts/<name>.prompt.md` |
| Postmortem of a process / data incident | `docs/WASTE-LEDGER.md` (single ledger) |
| Operational runbook | `docs/runbooks/<topic>.md` |
| Architecture / data flow | `docs/ARCHITECTURE.md`, `docs/api-reference.md`, `docs/data-dictionary.md` |

---

## Doc-Coverage Gate (cross-reference)

When you add a file under `.github/agents|prompts|skills/**`, you MUST
also update:

- `docs/memory/agents-and-prompts.md` -- inventory
- `.github/agents/onboard.agent.md` Phase 2 read list -- so new agents
  see the file during onboarding

Pre-commit reviewer Documentation Coverage check (Step 2.G) enforces
this. Full mapping table lives in `CONTRIBUTING.md` "Documentation
Expectations".

---

## Cross-References

- `.github/agents/onboard.agent.md` -- canonical onboarding procedure (5 phases)
- `.github/prompts/onboard.prompt.md` -- `/onboard` slash command wrapper
- `docs/memory/agents-and-prompts.md` -- inventory of agents / prompts / skills + PR workflow pointer
- `CONTRIBUTING.md` -- contributor workflow + Documentation Expectations mapping
- `.github/skills/workflow/SKILL.md` -- canonical PR workflow (loaded by reviewer agents on M/L tier)
- `.github/skills/process-discipline/SKILL.md` -- hot-file -> INC mapping (loaded before editing hot files)
- `/memories/operating-rules.md` -- user-side operating rules (cross-workspace)
