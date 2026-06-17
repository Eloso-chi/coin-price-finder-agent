# Codespaces gh CLI auth quirk

## TL;DR

The codespace-injected `$GITHUB_TOKEN` is a scoped GitHub App token with NO access to this private repo (returns HTTP 404 on `repos/Eloso-chi/coin-price-finder-agent`). `gh` defaults to that token over the OAuth login, so bare `gh` commands fail.

## Workaround (use by default from turn 1)

Always prefix `gh` calls:

```
GITHUB_TOKEN= GH_TOKEN= gh <command>
```

This falls through to the OAuth login in `~/.config/gh/hosts.yml` (gho_... token, scopes: `gist read:org repo workflow`) which has full repo access.

## How to verify the situation

```
gh auth status                              # shows both tokens
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/Eloso-chi/coin-price-finder-agent
# 404 means the codespace token has no access (expected)
```

## Permanent fix options (user decision, do not apply unilaterally)

1. Add `unset GITHUB_TOKEN GH_TOKEN` to `~/.bashrc` in the codespace.
2. Repo Settings -> Codespaces -> grant GITHUB_TOKEN the `contents:read`, `pull-requests:write`, `issues:write` permissions.
3. Use `gh auth switch` (less reliable; env var still wins).

## Related waste

INC-008 in `docs/WASTE-LEDGER.md` -- bypassed branch protection on PR #52 instead of using this workaround. Do not repeat.
