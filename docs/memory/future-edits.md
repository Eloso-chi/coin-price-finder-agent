# Future Edits & Ideas -- HISTORICAL ARCHIVE

> **DEPRECATED.** Canonical backlog is [docs/BACKLOG.md](BACKLOG.md). All items
> that once lived here were rationalized into BACKLOG.md on or before May 31,
> 2026. See [docs/BACKLOG.rules.md](BACKLOG.rules.md) for governance.

## Renumbered items

When migrating from this file to BACKLOG.md, three IDs collided with pre-existing
BACKLOG entries and were renumbered:

| Original (this file) | Canonical (BACKLOG.md) | Title |
|----------------------|------------------------|-------|
| memory **#183** | **#228** | Page 1 refresh -- Libertads, ASEs, Perth Lunars |
| memory **#185** | **#226** | Gold Libertad thin comp data |
| memory **#186** | **#227** | Silver Libertad Proof thin comp data |

## Per-machine ID convention

Verbatim from the original (still authoritative for new entries):

> Per-machine ID convention (in effect from #264W onward, see
> `docs/BACKLOG.rules.md`):
>
> - New backlog IDs get a `W` (Codespace) or `H` (home) suffix.
> - Detect this machine's letter with `scripts/machine-id.sh` (reads
>   `.machine-id` -- gitignored).
> - This machine = **W**. Verify with `scripts/machine-id.sh` before authoring
>   any new entry.
> - Next-in-series scan:
>   ```bash
>   for s in W H; do
>     hi=$(grep -oE "^### #[0-9]+${s}\." docs/BACKLOG.md \
>          | grep -oE "[0-9]+" | sort -n | tail -1)
>     echo "Next #${s}: #$((${hi:-263} + 1))${s}"
>   done
>   ```
> - Bare-number IDs (#1..#263) grandfathered; never renamed.

## Where the full original content lives

This file was 3291 lines / ~212 KB before the 2026-06-17 trim. The full content
is preserved in:

1. **Git history** -- `git log --follow -p docs/memory/future-edits.md` (or
   `/memories/repo/future-edits.md` for the pre-migration path)
2. **Machine-local memory backup** -- `/memories/repo/future-edits.md` on the
   `W` (Codespace) machine, retained as a non-authoritative reference and not
   committed to git. May drift over time.

Do **not** add new items here. Open them in [docs/BACKLOG.md](BACKLOG.md) under
the per-machine ID convention.
