# Travel mode: running the scraper from a Codespace

> **Audience:** owner is away from the Surface laptop and only has the
> Codespace available. This path is a **fallback** -- it's strictly worse than
> the laptop because eBay's Akamai bot-management distrusts Azure data-center
> IP ranges, so cookie jars die faster (often within hours) and CAPTCHA
> challenges are more frequent.
>
> **Preferred path:** [local-scraper-wsl2.md](local-scraper-wsl2.md).

## Why a separate runbook (#250)

The Codespace cannot interactively solve a CAPTCHA in a real Chromium window
(headless works, headed-via-VNC hangs -- see issue #102). So the only way to
seed a usable cookie jar from inside a Codespace is to **export cookies from a
browser that already has a live eBay session** -- e.g. the Edge profile on
whatever borrowed/loaner laptop you're using -- and paste them in.

We deliberately do **not** share the Surface's `cookies-surface.json` with the
Codespace. One persistent eBay identity used from two disparate IPs in a short
window is one of the highest-confidence fraud signals Akamai watches for.

## One-time setup

The repo is already cloned in the Codespace. Make sure dependencies are in
place once per Codespace rebuild:

```bash
cd /workspaces/coin-price-agent
python3 -m pip install --user playwright requests
python3 -m playwright install chromium
```

## Each scraping session

### 1. Export cookies from the host browser

On the loaner laptop, sign in to eBay in Edge/Chrome and navigate once to
`https://www.ebay.com/sh/research` to confirm Terapeak is reachable. Then
export the cookies. Suggested tools (any one):

- **Cookie-Editor** extension: Export -> JSON. Filter to `*.ebay.com`.
- Chrome DevTools -> Application -> Cookies -> Save as HAR -> extract.
- A trusted CLI like `chrome-cookies-secure` (verify before installing).

Save the JSON to your local machine, e.g. `~/Downloads/cookies-travel.json`.

> **Do not** paste cookies into Slack, GitHub, an issue tracker, or any
> screen-shared session. They are credentials. Move them by trusted channel
> only (your own SSH, file-transfer to the Codespace, a paste into a private
> file).

### 2. Drop the file into the Codespace

Easiest: open the Codespace in VS Code Desktop / web, drag-and-drop the
file into a folder **outside** the repo working tree (cache/ is gitignored
but accidents happen). Suggested:

```bash
mkdir -p ~/codespace-state
mv /tmp/uploaded-cookies-travel.json ~/codespace-state/cookies-travel.json
chmod 600 ~/codespace-state/cookies-travel.json
```

### 3. Configure environment

```bash
cd /workspaces/coin-price-agent

# Use the same App Service the laptop uses (data lands in the same Cosmos):
export APP_URL=https://coinpricefinder-h3a3b5g0dmdydna4.azurewebsites.net
export ADMIN_API_KEY='<from Key Vault>'

# Travel-specific jar -- separate from any Codespace default:
export COOKIE_FILE=~/codespace-state/cookies-travel.json
```

### 4. Pre-flight check

```bash
python3 scripts/cookie-health-check.py
```

If the offline check passes, optionally probe (uses one quota unit):

```bash
python3 scripts/cookie-health-check.py --probe
```

If the probe returns CHALLENGED, **stop**. Don't burn quota and don't poison
the host browser's session. Wait or use a different host browser.

### 5. Run small batches (freshness triage integrated)

```bash
# Keep travel mode conservative: smaller page-1 batch, skip deep by default.
bash scripts/run-surface-freshness-loop.sh \
  --stale 15 \
  --page1-batch 10 \
  --skip-deep

# Optional focus to one coin family while traveling:
bash scripts/run-surface-freshness-loop.sh --page1-batch 10 --skip-deep --coin-type libertads
bash scripts/run-surface-freshness-loop.sh --page1-batch 10 --skip-deep --focus "morgan|peace"
```

Smaller batches than the Surface workflow (10 vs 20) because the data-center
IP shortens the Akamai trust window.

If you need to run exporter directly (without triage orchestration), use:

```bash
python3 scripts/terapeak-export.py --batch 10
```

### Upload mode (UPLOAD_MODE) -- #251

Travel mode follows the same parity defaults as Surface: `UPLOAD_MODE=api`
(immediate import via `APP_URL/api/terapeak/import`). Set `UPLOAD_MODE=blob`
only for explicit bulk-backfill profiles, in which case ingestion is deferred
until server startup or an explicit `POST /api/terapeak/reimport` call.

Do NOT set `TERAPEAK_BLOB_ACCOUNT` / `TERAPEAK_BLOB_CONTAINER` for the
default travel workflow -- they cause `auto` mode to attempt blob-first uploads.

Set `VERIFY_IMPORT=1` to log explicit warnings when ingestion cannot be
confirmed immediately (any non-api mode).

## Hard limits

- **One active jar per Codespace.** If you've used the Codespace for scraping
  in the last 24h, do not paste a fresh jar into it -- the IP may already be
  on a soft blocklist.
- **Never push the cookie file to git.** `cache/` is gitignored except
  `greysheet_history.json`, and the recommended path here
  (`~/codespace-state/`) is outside the worktree. Verify with
  `git status --ignored | grep -i cookie`.
- **Never share cookies between machines.** Surface jar stays on Surface,
  travel jar stays on the Codespace it was uploaded to.

## When you get back to the Surface

Discard the travel jar:

```bash
shred -u ~/codespace-state/cookies-travel.json   # or rm
```

The Surface's own jar is unaffected by anything you did from the Codespace;
just resume the normal [local-scraper-wsl2.md](local-scraper-wsl2.md) flow.
