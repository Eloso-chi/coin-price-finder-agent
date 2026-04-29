---
mode: agent
description: Bootstrap full project understanding by reading all documentation, repo memory, and key source files. Run at the start of a new conversation.
tools:
  - read_file
  - grep_search
  - file_search
  - semantic_search
  - list_dir
  - run_in_terminal
  - get_terminal_output
  - manage_todo_list
  - memory
---

Run a full codebase onboarding using the **Onboard** agent.

1. Read `.github/agents/onboard.agent.md` for the full operating procedure.
2. Follow all five phases:
   - **Phase 0:** Discovery scan -- find new docs, agents, and scripts not yet in the procedure.
   - **Phase 1:** Read all `/memories/repo/` files (codebase overview, backlog, decision engine, runbooks, analysis docs).
   - **Phase 2:** Read project docs (`README.md`, `docs/ARCHITECTURE.md`, `.github/copilot-instructions.md`, `docs/testing/test-monitor.md`, `data/terapeak/README.md`, `.github/skills/code-review/SKILL.md`).
   - **Phase 3:** Scan all 16 services, key routes, data/utils, scripts, and test infrastructure.
   - **Phase 4:** Run tests + git log, then produce a Readiness Report with exact numbers.
3. Use the todo list to track progress through each phase.

**You MUST NOT edit any files.** This is a read-only onboarding.
