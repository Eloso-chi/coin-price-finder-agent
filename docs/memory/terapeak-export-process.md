# Terapeak Export Process -- Correct Steps

## What the script NEEDS:
- `DISPLAY=:7` (Xvfb/VNC for headful Chromium)
- Python3 + Playwright
- Valid eBay cookies at `cache/ebay_cookies.json`

## What the script does NOT need:
- `node server.js` -- export writes directly to blob or local CSV files
- The Node server is ONLY needed for the import side (reimport from blob)

## Login flow:
1. Try `--login` (visual browser on VNC). If browser freezes on first attempt:
   - Do NOT retry. Offer `--login-manual` immediately.
2. `--login-manual`: user pastes cookies from their own browser's DevTools.
   - This is the reliable fallback -- always works, no CAPTCHA.

## Run flow:
```bash
DISPLAY=:7 python3 scripts/terapeak-export.py --run --backlog cache/freshness-report.json --include-thin --shuffle --resume
```

## Do NOT start node server.js for this task.
