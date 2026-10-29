# Terapeak Export Process (Historical Notes)

This file is retained as historical context. Use the canonical procedures in
`docs/memory/terapeak-runbook.md`, `docs/runbooks/local-scraper-wsl2.md`, and
`docs/runbooks/scraper-travel-mode.md` before operating a scraper.

The old fixed `DISPLAY=:7` example is not a requirement. The exporter detects
the display supplied by the environment; the current local runbook uses the
configured VNC display. `--login` opens a visible browser and requires a
display. `--login-manual` accepts cookies pasted from the user's own browser
when a display is unavailable, but it does not guarantee that the session is
valid or that subsequent eBay requests will avoid a challenge.

When no display is present, export may run headless and can trigger a challenge.
Follow the anti-bot runbook: stop on a hard challenge and do not retry or bypass
it. Do not assume a server is unnecessary for every export mode: API uploads
require the configured app endpoint, while blob/local modes have different
requirements. See `scripts/README.md` and the current runbooks for the selected
`UPLOAD_MODE` workflow.
