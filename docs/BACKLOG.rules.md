# Backlog Rules

Governance rules for `docs/BACKLOG.md` -- the single source of truth for planned, in-progress, and completed work.

---

## Canonical Source

| File | Role |
|------|------|
| `docs/BACKLOG.md` | Authoritative backlog. Final in all conflicts. |
| `.github/pull_request_template.md` | Enforces backlog reference on every PR. |
| This file (`docs/BACKLOG.rules.md`) | Governance and expectations. |

Copilot memory files, chat context, comments, and personal notes are **non-authoritative** and **transient**. They are never a substitute for the Git-tracked backlog.

---

## Sections

Backlog items progress through these sections:

1. **Proposed** -- idea surfaced, not yet approved
2. **Planned** -- approved, not yet started
3. **In Progress** -- actively being worked
4. **Done** -- completed (kept for reference, struck through)
5. **Won't Fix / Deprecated** -- explicitly declined or superseded

---

## Item Format

Each item should include:

- **Title** with priority tag (e.g. `[HIGH]`, `[MEDIUM]`, `[LOW]`)
- **Problem** -- what is broken or missing (1-2 sentences)
- **Fix / Approach** -- what to do about it
- **Files** -- affected source files (when known)
- **Status notes** -- commit hash, date, blockers

---

## Per-machine ID convention (in effect from #264W onward)

This project is worked on from two machines that may both add backlog items without coordinating. To eliminate ID collisions during merge, every new backlog ID gets a single-letter suffix identifying its origin machine:

- `W` -- Codespace / **w**ork environment (this dev container)
- `H` -- **h**ome workstation (native Windows)

An ID is the number **plus** the suffix. `#264W` and `#264H` are two unrelated items and may coexist freely.

### Picking the next number

Before writing a new backlog entry:

1. Run `scripts/machine-id.sh` to get this machine's letter. If it errors with "not found", do the one-time setup printed on stderr (`echo W > .machine-id` or `echo H > .machine-id`) and re-run. **Never guess.**
2. Run `git fetch --all --prune` so you see the latest entries from BOTH series.
3. Find the highest existing number for your letter:
   ```bash
   grep -oE "^### #[0-9]+$(scripts/machine-id.sh)\." docs/BACKLOG.md \
     | grep -oE "[0-9]+" | sort -n | tail -1
   ```
4. Use the next integer, with your letter suffix (e.g. `#265W`).
5. Cross-references inside the entry MUST include the suffix (`See #261W`, never bare `#261`).

### Grandfathered numbers

Backlog items added BEFORE #264W are bare numbers (no suffix). They are never retroactively renamed. When referencing them, use the bare form (`#244`, `#256`).

### PR titles and branch names

- PR titles should include the suffixed ID, e.g. `feat(#265W): split fractional gold pools`.
- Branch names may include the suffix (`feat/265W-fractional-gold`) or omit it -- the suffix on the backlog ID is the source of truth.

### Detection failure mode

If `scripts/machine-id.sh` exits non-zero, the agent or developer MUST stop and create the file. Do NOT assume a default. CI environments have no `.machine-id` and must not author backlog items.

---

## Approval-Gated Actions

The following require explicit user approval before execution:

- Adding new backlog items
- Changing scope or priority of existing items
- Marking items as Done, Deprecated, or Superseded
- Introducing follow-on or implied work
- Expanding work beyond original backlog intent

Process: **Propose -> Explain -> Show diff -> Get approval -> Execute**

---

## PR Hygiene

Every Pull Request MUST:

1. Reference an existing backlog item, OR
2. Propose a new backlog item, OR
3. Update backlog status, OR
4. Explicitly justify why no backlog update is needed

Scope expansion discovered during a PR MUST be reflected in `docs/BACKLOG.md` and approved before merging.

---

## Quality Standards

Backlog items should be:

- Independently actionable
- Clear in intent and outcome
- Reviewable without chat context

Avoid:

- Duplicates (check before adding)
- Vague "future ideas" without next steps
- Architectural musings without concrete action

When uncertain, propose the item as "Proposed" and ask for confirmation.

---

## Conflict Resolution

If any source conflicts with `docs/BACKLOG.md`:

- `docs/BACKLOG.md` wins
- Surface the conflict explicitly
- Default to preserving backlog integrity
- Ask for guidance before acting
