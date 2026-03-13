---
mode: agent
description: Apply approved code review findings. Requires a prior review with numbered APPLY candidates.
tools:
  - read_file
  - grep_search
  - file_search
  - semantic_search
  - replace_string_in_file
  - multi_replace_string_in_file
  - create_file
  - run_in_terminal
  - get_terminal_output
  - get_errors
  - manage_todo_list
  - list_dir
  - runSubagent
---

Apply approved fixes from a Code Review Report using the **Implementer (Approval-Only)** agent.

1. Read `.github/agents/implementer.approval-only.agent.md` for the full operating procedure.
2. The user must specify which items to apply (e.g., `APPLY 1, 3, 5` or `APPLY ALL`).
3. If the user has not yet run `/review-deep`, tell them to run a review first.
4. Follow the Implementer's operating procedure exactly:
   - Parse the APPLY request.
   - Plan changes (files, what, risk).
   - Implement approved items only -- minimal diffs.
   - Run `npm test` to verify.
   - Report summary with follow-ups.

**ONLY fix items the user explicitly approved.** Do not fix unapproved findings.
