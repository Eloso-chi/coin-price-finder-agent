# Secret Bootstrap (New / Other Dev Machine)

Pull the dev secrets this app needs (`EBAY_APP_ID`, `EBAY_CLIENT_SECRET`,
`PCGS_API_KEY`, etc.) from Azure Key Vault `coinpricefinder-kv` into a local
`.env`. No secrets are ever committed to the repo or copied through chat,
email, or files.

Helper script: `scripts/load-secrets.sh` (added in PR #137).

## Agent prompt (copy-paste on the other machine)

```
Pull latest main, then bootstrap my .env from Azure Key Vault using the
helper script scripts/load-secrets.sh.

Steps:
1. cd into the repo and run:
     git checkout main && git pull
2. Confirm scripts/load-secrets.sh exists and is executable.
3. Verify az CLI is installed and logged in:
     az account show
   If not logged in:
     az login              # or: az login --use-device-code  (Codespace / headless)
4. Dry-run the loader first so I can see which secrets will land:
     scripts/load-secrets.sh
   Expect 8 OK lines from vault coinpricefinder-kv.
5. If the dry-run looks right, write the values into .env:
     scripts/load-secrets.sh --write
   Confirm the resulting file is mode 600:
     stat -c '%a %n' .env
6. Sanity-check that the app can see the keys (do NOT print them):
     node -e "require('dotenv').config(); \
       ['EBAY_APP_ID','EBAY_CLIENT_SECRET','PCGS_API_KEY'] \
       .forEach(k => console.log(k, process.env[k] ? 'set' : 'MISSING'))"

If step 4 reports SKIP for any secret, the signed-in Azure identity is
missing get-secret permission on the vault. Stop and tell me which
account is signed in:
     az account show --query user.name -o tsv
so I can grant access from the other machine.

Do not commit .env or print secret values to chat. Do not use --print.
Reference: docs/runbooks/secret-bootstrap.md, PR #137.
```

## Granting access to a new identity

Run from a machine whose signed-in account already has Key Vault admin
rights on `coinpricefinder-kv`:

```bash
az keyvault set-policy --name coinpricefinder-kv \
  --upn <new-machine-account@domain> \
  --secret-permissions get list
```

## What the script does (and does not)

- **Does** fetch 8 named secrets via `az keyvault secret show` and merge
  them into `./.env` (mode 600), preserving non-secret lines (`PORT`,
  endpoint URLs, TTLs).
- **Does not** rotate, delete, or upload secrets.
- **Does not** touch any file other than `.env`.
- **Defaults to dry-run.** `--write` and `--print` are opt-in.
- `--print` exposes raw values to stdout (scrollback / pipes). Avoid it
  unless reviewing locally; prefer `--write`.

See script header for full usage: `scripts/load-secrets.sh --help`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `az: command not found` | Azure CLI not installed | https://aka.ms/install-azure-cli |
| `az not logged in. Run: az login` | No active session | `az login` (or `az login --use-device-code`) |
| All 8 lines `SKIP ... (not found or no access)` | Vault policy missing for the signed-in account | See "Granting access" above |
| Some SKIPs, some OKs | Specific secret missing from vault | Verify in Azure Portal -> Key Vault `coinpricefinder-kv` -> Secrets |
| Wrong subscription | Multi-tenant `az` login | `az account set --subscription <id-or-name>` |
| `.env` ends up mode 644 | Script run with an older version | `git pull` -- umask 077 was added after initial release |
