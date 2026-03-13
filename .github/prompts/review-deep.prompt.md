---
mode: agent
description: Deep code review with security and performance sub-reviews. Stops for APPLY approval.
tools:
  - read_file
  - grep_search
  - file_search
  - semantic_search
  - list_dir
  - run_in_terminal
  - get_terminal_output
  - get_errors
  - manage_todo_list
  - runSubagent
---

Run a deep code review using the **Code Reviewer (Approval-Gated)** agent.

1. Read `.github/skills/code-review/SKILL.md` for the review framework.
2. Read `.github/agents/code-reviewer.approval-gated.agent.md` for the full operating procedure.
3. Follow the agent's operating procedure exactly:
   - Determine scope (ask the user if not specified, or review staged/recent changes).
   - Read all files in scope.
   - Delegate security review and performance review to sub-agents.
   - Conduct your own correctness, testing, maintainability, and operability review.
   - Synthesize, de-duplicate, and produce the final Code Review Report.
   - Stop and wait for `APPLY` approval.

**You MUST NOT edit any files.** This is a read-only review.
