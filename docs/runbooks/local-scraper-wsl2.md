# Local scraper on Surface laptop (WSL2 + Ubuntu)

> **Audience:** owner running the Terapeak scraper from their Surface laptop on
> a residential IP. This is the **preferred** path because it gives eBay/Akamai
> a stable IP + device fingerprint, which keeps the cookie jar trusted for
> longer (typical 1-7 days between forced re-logins; cookies on a fresh
> Codespace VM trip CAPTCHA within hours).
>
> **Travel fallback:** see [scraper-travel-mode.md](scraper-travel-mode.md) for
> when you only have the Codespace available.

## Why this path exists (#250)

eBay's Akamai bot-management ties session trust to the IP + browser
fingerprint that first authenticated. A Codespace VM gets a rotating Azure
data-center IP (currently Moses Lake WA on the `turbo-goggles-...` codespace,
verified by externally-observed source IP), which Akamai treats as a
data-center range and challenges aggressively. The Surface laptop on a
residential ISP looks like a normal human, so the same cookies live longer
there. Running the scraper from the laptop and POSTing results to the deployed
Azure App Service is dramatically more reliable than running it inside the
Codespace.

## One-time setup

### 0. Fast path (recommended)

If you want the quickest repeatable setup, run the bootstrap script from repo
root. It installs deps, creates the venv, installs Playwright Chromium,
creates `~/cpf/state`, and writes `~/.env.surface` + `~/load-cpf-env.sh`.

```bash
bash scripts/bootstrap-surface-wsl.sh
~/set-cpf-admin-key.sh
source ~/load-cpf-env.sh
```

`~/set-cpf-admin-key.sh` stores the raw `ADMIN_API_KEY` in
`~/.config/cpf/admin_api_key` with mode `600`, so you do not re-paste it every
session.

### 1. WSL2 + Ubuntu

You confirmed: default distribution Ubuntu, default version 2. Verify from
PowerShell:

```powershell
wsl -l -v
# Should show:  NAME      STATE     VERSION
#               Ubuntu    Running   2
```

Open Ubuntu and run the rest from inside WSL.

**Important:** run from a real Ubuntu terminal, not a VS Code devcontainer
terminal. If `whoami` shows `devcontainers` *and* you are inside a remote
container workspace, you are on the wrong path.

**Ubuntu version support:** Playwright Chromium currently fails on Ubuntu 26.04
in this workflow (`Playwright does not support chromium on ubuntu26.04-x64`).
Use Ubuntu 24.04 LTS or 22.04 LTS for the Surface path.

### 2. System dependencies

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git
# Playwright Chromium needs these system libs:
sudo apt install -y \
  libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 \
  libpango-1.0-0 libcairo2 libasound2t64
```

If your distro still uses `libasound2` instead of `libasound2t64`, install the
available one.

### 3. Clone the repo

```bash
mkdir -p ~/cpf && cd ~/cpf
git clone https://github.com/<your-org>/coin-price-agent.git
cd coin-price-agent
```

### 4. Python env + Playwright Chromium

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install playwright requests
python3 -m playwright install chromium
```

### 5. Surface-specific cookie jar

To keep the laptop's cookies separate from anything in the codespace, store
them under your home dir, not in the repo:

```bash
mkdir -p ~/cpf/state
# Empty file is fine -- the first --login run will populate it.
```

### 6. Environment variables

Create `~/cpf/coin-price-agent/.env.surface` (do **not** commit this file):

```env
# --- target ---
APP_URL=https://coinpricefinder-h3a3b5g0dmdydna4.azurewebsites.net
ADMIN_API_KEY_FILE=/home/<your-wsl-user>/.config/cpf/admin_api_key

# --- per-machine cookie jar (KEY for #250) ---
COOKIE_FILE=/home/<your-wsl-user>/cpf/state/cookies-surface.json
```

`ADMIN_API_KEY` must be the **raw secret value**. Do not use App Service
reference syntax like:

```env
ADMIN_API_KEY=@Microsoft.KeyVault(SecretUri=...)
```

That syntax is resolved only by App Service runtime, not by your local shell,
and causes auth failures (`401`) in local scraper runs.

Then `source .env.surface` (or use `set -a; source .env.surface; set +a` for
auto-export) before running the scraper. Prefer `source ~/load-cpf-env.sh`
because it validates key format and loads from `ADMIN_API_KEY_FILE`.

Verify the App Service is reachable:

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' "$APP_URL/api/health"
# Expect: health=200
```

If you ever see a 401 instead, the admin key is wrong. If you see a 000, your
network is blocking outbound HTTPS.

Quick auth check (expects `admin=200`):

```bash
curl -s -o /dev/null -w 'admin=%{http_code}\n' \
  -H "x-api-key: $ADMIN_API_KEY" \
  "$APP_URL/api/admin/stale-datasets?days=30&limit=1"
```

## First sign-in

```bash
cd ~/cpf/coin-price-agent
source .venv/bin/activate
set -a; source .env.surface; set +a
python3 scripts/terapeak-export.py --login
```

A real Chromium window will appear. Sign in to eBay manually (solve any
CAPTCHA), navigate once to `https://www.ebay.com/sh/research` to confirm
Terapeak loads, then close the window. The script writes the jar to
`$COOKIE_FILE`.

> **Do not** copy this file into the repo. The whole point of the env override
> is that the laptop's cookies stay on the laptop -- moving them between
> machines is exactly what trips Akamai.

## Daily use

```bash
cd ~/cpf/coin-price-agent
source .venv/bin/activate
set -a; source .env.surface; set +a

# 1. Pre-flight: is the session still good?
python3 scripts/cookie-health-check.py
case $? in
  0) echo "HEALTHY -- proceed" ;;
  1) echo "EXPIRED -- run --login then retry" ; exit 1 ;;
  2) echo "CHALLENGED -- wait a few hours, try again, then --login" ; exit 1 ;;
  3) echo "MISSING -- first-time setup" ; exit 1 ;;
esac

# 2. Run the scraper (example: 20 terms in one resume-aware batch)
python3 scripts/terapeak-export.py --batch 20
```

For a repeatable long-run loop, use:

```bash
bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface

# Focus only on one coin family (examples):
bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface --coin-type libertads
bash scripts/run-surface-freshness-loop.sh --env-file ~/.env.surface --focus "morgan|peace"
```

This wires freshness triage into page-1 refresh and deep pagination in one
command.

Notes:
- The loop uses `--limit` for page-1 batches (not `--batch`) to avoid
  resume-history skipping of valid backlog refresh candidates.
- `SAVED but upload failed` with HTTP 422 (`No valid comps found`) is treated
  as a no-data attempt and contributes to dormancy convergence.
- P3 monitor/evidence-probe entries are excluded by default; include them with
  `--include-thin` when you intentionally want monitor passes.

### Upload mode (UPLOAD_MODE) -- #251

The Surface launcher and `run-surface-freshness-loop.sh` set `UPLOAD_MODE=api`
unless you override it. The exporter (`terapeak-export.py`) supports three modes:

| Mode  | Behavior                                                                                     | Ingestion latency                                                |
|-------|----------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| `api` | POST every CSV to `APP_URL/api/terapeak/import`. Immediate import + dormancy progression.    | Immediate.                                                       |
| `blob`| Upload to Azure Blob only. No API fallback. Errors if blob env vars are missing.             | Deferred until server startup or explicit `/api/terapeak/reimport`. |
| `auto`| Legacy: blob first if configured, else API.                                                  | Mixed -- not recommended for daily ops.                          |

Local-ops profile (recommended): leave `UPLOAD_MODE` unset and do NOT set
`TERAPEAK_BLOB_ACCOUNT` / `TERAPEAK_BLOB_CONTAINER`. Bulk-backfill profile:
set `UPLOAD_MODE=blob` plus blob env vars and follow up with a manual call to
`POST /api/terapeak/reimport`.

Set `VERIFY_IMPORT=1` to surface explicit warnings whenever the upload path
cannot confirm immediate ingestion (always the case in blob mode).

## When the session goes stale

Symptoms:
- `cookie-health-check.py --probe` returns CHALLENGED.
- Scraper logs show `/splashui/captchaP` redirects.
- Persistent 401s from `/api/terapeak/import` (different cause, but check both).

Recovery, in order:
1. `python3 scripts/terapeak-export.py --login`. Solve CAPTCHA in the headed
   window. New jar overwrites `$COOKIE_FILE`.
2. If CAPTCHA keeps re-appearing immediately after solving, **stop**. Your IP
   is on a temporary Akamai blocklist. Wait 6-24h.
3. Never copy a Codespace-sourced jar onto the Surface (or vice versa) to
   "fix" it -- you will permanently degrade trust on the receiving machine.

## Operational rules

- One cookie jar per machine. Always. Enforce via distinct `COOKIE_FILE`
  paths.
- Run the cookie-health-check before every batch. The probe (`--probe`)
  costs one Terapeak quota unit; the offline check is free.
- Keep batch sizes small (15-25 search terms). Long uninterrupted sessions are
  a stronger bot signal than short pauses.
- If you're going to be off the laptop for >7 days, plan to re-login on
  return. Persistent identity tier survives, but Akamai short-tier tokens
  expire and the bot-management state may not transfer cleanly.
