---
agent: agent
description: Deep code review with security and performance sub-reviews. Stops for APPLY approval.
tools: [read, search, execute, todo, agent]
---

Run a deep code review by orchestrating the registered workspace reviewers.

1. Read `.github/skills/code-review/SKILL.md` for the review framework.
2. Read `.github/agents/code-reviewer.approval-gated.agent.md` for the full operating procedure.
3. Determine the exact review scope and file list before launching reviewers.
4. Launch these registered agents in parallel with the same scope and file list:
  - **Code Reviewer (Approval-Gated)** for correctness, testing, maintainability,
    domain correctness, and operability.
  - **Security Reviewer** for the security sub-review.
  - **Performance Reviewer** for the performance sub-review.
5. Require each reviewer to read the live workspace files, follow
  `.github/skills/code-review/SKILL.md`, and return Finding Schema entries.
6. Synthesize all three reports, de-duplicate overlapping findings, sort by
  severity, number APPLY candidates sequentially, and produce the final Code
  Review Report.
7. Stop and wait for `APPLY` approval.

**You MUST NOT edit any files.** This is a read-only review.
