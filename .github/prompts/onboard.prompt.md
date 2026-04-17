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
2. Follow all four phases:
   - **Phase 1:** Read all `/memories/repo/` files (codebase overview, backlog, runbooks, analysis docs).
   - **Phase 2:** Read architecture docs (`docs/ARCHITECTURE.md`, `.github/copilot-instructions.md`).
   - **Phase 3:** Scan key source file exports (`server.js`, services, utils, routes).
   - **Phase 4:** Produce a Readiness Report confirming what you now understand.
3. Use the todo list to track progress through each phase.

**You MUST NOT edit any files.** This is a read-only onboarding.
