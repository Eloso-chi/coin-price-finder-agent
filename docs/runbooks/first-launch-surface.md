# First launch on the Surface laptop -- Copilot handoff

> **Purpose:** this file exists so the Copilot running in VS Code on the Surface
> laptop has the context that was decided in the Codespace conversation on
> 2026-06-03 (PRs #100, #98, #103, #104, #105). The laptop Copilot cannot see
> that chat history; this doc is the bridge.
>
> **Audience:** you, on the Surface, about to run the Terapeak scraper for the
> first time from that machine. Paste the "Context block" below into Copilot as
> your first message in the new session, then follow the authoritative runbook.

---

## Authoritative runbook (do this, not improvised steps)

`docs/runbooks/local-scraper-wsl2.md` -- walk it top to bottom. This file is
just orientation; the runbook is the source of truth.

## Context block to paste into Copilot on the Surface

> Help me launch the Terapeak scraper from this Surface laptop (WSL2 Ubuntu)
> for the first time. This is the preferred / residential-IP path described in
> PR #103 (#250). The repo is `Eloso-chi/coin-price-finder-agent`.
>
> Authoritative runbook -- follow exactly:
> `docs/runbooks/local-scraper-wsl2.md`. If a step is unclear, ask me; do not
> invent steps.
>
> Background you must know (from prior Codespace conversation, 2026-06-03):
>
> 1. **Dual-path scraper (#250, PR #103).** The same scraper runs from two
>    environments: this Surface laptop (residential IP, trusted longer by
>    Akamai) and the Codespace (data-center IP, jars die fast). They MUST keep
>    separate cookie jars. Reusing one persistent eBay identity across two IPs
>    is the exact pattern Akamai flags as fraud.
> 2. **`COOKIE_FILE` env var** selects which jar to load (supports `~`
>    expansion). On this machine use a path outside the worktree, e.g.
>    `~/cpf/state/cookies-surface.json`. Never share this jar with the
>    Codespace. Never commit it. The default if unset is
>    `cache/ebay_cookies.json` -- that is the Codespace's jar; do not use it
>    here.
> 3. **Pre-flight gate:** `scripts/cookie-health-check.py` exits
>    `0 HEALTHY / 1 EXPIRED / 2 CHALLENGED / 3 MISSING / 4 PROBE_FAILED`.
>    Run it before every batch. Optional `--probe` does a ~10s live eBay hit
>    (costs 1 Terapeak quota unit) to confirm the session actually works.
>    Contract is locked in by `tests/test_cookie_health_check.py` (19 cases).
> 4. **First-run sequence:** `--login` (visible browser, manual eBay sign-in
>    into Seller Hub Research -- this writes the jar) -> health-check ->
>    health-check `--probe` -> `--run --batch 15`. Use a **small** first batch
>    (15, not 40+) while we confirm the residential path is trusted. Scale up
>    only after a few clean batches.
> 5. **`APP_URL` env.** By default the scraper POSTs CSVs to
>    `localhost:3000/api/terapeak/import`. From the laptop you almost certainly
>    want the deployed App Service instead:
>    `APP_URL=https://coinpricefinder-h3a3b5g0dmdydna4.azurewebsites.net`. The
>    blob-upload path is preferred if `TERAPEAK_BLOB_ACCOUNT` / container creds
>    are configured; otherwise it falls back to HTTP POST.
> 6. **Critical recovery rule.** If the health-check returns `2 CHALLENGED`
>    (Akamai `bm_*` or `__cf_bm` rotated/missing), do NOT retry from the
>    Codespace with the same jar. Re-login locally instead. Cross-IP reuse is
>    what got us blocked before.
> 7. **Operating rules to respect.** All changes go through a PR -- no direct
>    commits to `main`. Never start `node server.js` or any long-running
>    process without backgrounding it. Never expose secrets. Use ASCII `--`,
>    not Unicode dashes.
> 8. **Key Vault reference gotcha.** In local WSL shells, `ADMIN_API_KEY` must
>    be the raw secret value. `@Microsoft.KeyVault(SecretUri=...)` only works
>    inside App Service runtime and will yield `401` locally.
> 9. **Ubuntu/Playwright support gotcha.** If Playwright says Chromium is not
>    supported on Ubuntu 26.04, switch to Ubuntu 24.04/22.04 for scraper runs.
>
> State as of 2026-06-03:
>
> - PRs #100, #98, #103, #104, #105 all merged. Local `main` should
>   fast-forward to `fe08883` or newer.
> - There is a parked ~176-coin scrape we want to resume in 15-25 term batches
>   once this machine is set up.
> - There are working-tree leftovers (notably 2007 British Gold Britannia files
>   in `stash@{0}`) that the Codespace was going to triage; out of scope for
>   first launch.
>
> First thing to do: open `docs/runbooks/local-scraper-wsl2.md` and walk me
> through it step by step, asking before each action that modifies system
> state (`apt` installs, `playwright install`, creating `~/cpf/state/`). After
> setup completes: health-check (no `--probe`) -> `--login` flow ->
> health-check `--probe` -> a 15-coin `--run` batch against the App Service
> `APP_URL`. Use `bash scripts/bootstrap-surface-wsl.sh` for fast setup, then
> `bash scripts/terapeak-operator.sh` for
> repeatable long-run batches.

---

## Companion docs the laptop Copilot should read

1. `docs/runbooks/local-scraper-wsl2.md` -- the actual procedure.
2. `docs/runbooks/scraper-travel-mode.md` -- the Codespace fallback; useful
   for understanding what NOT to do here.
3. `scripts/cookie-health-check.py` -- exit-code contract and CLI flags.
4. `scripts/terapeak-export.py` lines 65-78 -- where `COOKIE_FILE` is wired up.
5. `README.md` "Terapeak Data Pipeline" + env-var table (`COOKIE_FILE` row).
6. `docs/ARCHITECTURE.md` "Terapeak Sales Aggregation Architecture" +
   "Dual-path execution model (#250)" paragraph.
