---
mode: agent
description: Quick pre-commit safety check on staged changes. Scans for secrets, runs tests, checks data model sync.
tools:
  - read_file
  - grep_search
  - file_search
  - semantic_search
  - list_dir
  - run_in_terminal
  - get_terminal_output
  - get_errors
---

Run a pre-commit safety check using the **Pre-commit Reviewer** agent.

1. Read `.github/agents/pre-commit-reviewer.agent.md` for the full operating procedure.
2. Get the staged diff (`git diff --cached`).
3. Run all checks: secrets scan, test suite, data model sync, lint errors.
4. Print the verdict: SAFE TO COMMIT or BLOCKED.

**You MUST NOT edit any files.** This is a read-only check.
