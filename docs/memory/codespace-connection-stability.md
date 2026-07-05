# Codespace Connection Stability + Keep-Alive

Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05.

> Source of truth on the TWO distinct problems users conflate as "my codespace froze."
> Recreated 2026-06-30 after a prior session's ad-hoc script went undocumented.

## The two problems (do not confuse them)

| # | Problem | Symptom | Cause | Container alive? |
|---|---|---|---|---|
| 1 | **Server-side idle-stop** | Whole codespace is gone, port :3000 dead, processes lost | GitHub orchestrator auto-stops the container after default 30 min idle | NO |
| 2 | **Client connection drop** | Terminal frozen, VS Code "Reconnecting..." banner, but reconnect resumes same shell | TCP/WebSocket between laptop and codespace dropped (WiFi sleep, VPN, NAT timeout) | YES |

If your terminal froze but a fresh browser tab shows the codespace still listed as Running -> problem 2.
If GitHub UI shows the codespace as Stopped -> problem 1.

---

## Problem 1 mitigations (server-side idle-stop)

Strongest first:

1. **Raise idle timeout in GitHub settings** (most reliable, single-knob fix)
   - github.com -> Settings -> Codespaces -> "Default idle timeout"
   - Max 240 min (4h). No script can beat this.

2. **Real port-forwarding traffic from OUTSIDE the codespace**
   - The orchestrator only counts activity on forwarded ports as seen from the edge.
   - Hit the public URL: `https://${CODESPACE_NAME}-3000.app.github.dev/api/health` from a laptop cron / UptimeRobot / etc.
   - Internal localhost curls do NOT count (no forward, no edge traversal).

3. **Keep VS Code window connected**
   - Active editor session counts as activity. Strongest "do nothing" option.

4. **Our `scripts/codespace-keepalive.sh`** (weak, belt-and-suspenders)
   - Curls `http://localhost:3000/api/health` every 5 min, logs to `cache/keepalive/keepalive.log`.
   - Effectiveness for problem 1 is UNPROVEN. Logged 18 entries over 90 min in one prior session while codespace stayed up, but can't distinguish "script worked" from "user's VS Code stayed open."
   - Useful side effect: visible heartbeat log so you can tell after the fact whether the box was alive.

   Usage:
   ```bash
   bash scripts/codespace-keepalive.sh --launch    # nohup-detaches
   bash scripts/codespace-keepalive.sh --status    # pid + last 3 log lines
   bash scripts/codespace-keepalive.sh --stop
   ```

---

## Problem 2 mitigations (client connection drop)

Only relevant if your terminal hangs / VS Code shows "Reconnecting..." but the codespace itself is still listed as Running.

### If using `gh codespace ssh` from a local terminal
SSH keepalive applies. In `~/.ssh/config`:
```
Host *
  ServerAliveInterval 60
  ServerAliveCountMax 3
```
Client sends a silent no-op every 60s; gives up after 3 misses (3 min silence = drop with clean error instead of indefinite freeze).
**Verified standard-issue SSH behavior. Works for `gh codespace ssh` and any other SSH client.**

### If using VS Code Desktop with the Codespaces extension
SSH config does NOT apply -- the connection is WebSocket/HTTPS, not SSH. Settings that help:
- VS Code setting `remote.SSH.connectTimeout` (only matters if using Remote-SSH extension, not Codespaces extension)
- `remote.downloadExtensionsLocally` -- avoids large remote-side downloads that can stall on reconnect
- Keep `git.autofetch: true` -- marginal, generates background HTTPS chatter

### If using VS Code Web (browser)
Neither SSH config nor Remote-SSH settings apply. Only mitigations are at the network layer:
- Whitelist `*.github.com`, `*.app.github.dev`, `*.visualstudio.com` in any corporate VPN/proxy
- Disable aggressive WiFi power saving on the laptop
- Disable browser tab-discarding for the Codespace tab

### Universal (any client)
- VPN that aggressively kills "idle" WebSockets after 60-120s = #1 cause of "frozen terminal" in corporate setups
- macOS / Windows network adapter power management putting WiFi to sleep
- ISP NAT / CGNAT short connection-table TTL (rare, residential ISPs)

---

## Restart procedure after a Codespace stop (problem 1)

The keepalive PID dies when the container stops. After restart:
```bash
bash scripts/codespace-keepalive.sh --status   # expect "not running"
bash scripts/codespace-keepalive.sh --launch
# Also: server on :3000 needs to be restarted manually (see /memories/server-management.md in user memory)
```

---

## Things that DO NOT help (debunking common myths)

| Myth | Reality |
|---|---|
| "A `while true; sleep 60` loop keeps Codespaces alive" | Generates zero orchestrator-visible activity. Pure noise. |
| "Writing files to disk every minute counts as activity" | No. Orchestrator watches port traffic and client connections, not container I/O. |
| "Git autofetch keeps the codespace alive" | Generates outbound traffic from the codespace; the orchestrator's idle detector doesn't care. |
| "SSH ServerAliveInterval prevents codespace idle-stop" | No. SSH keepalive is layer 4 (TCP), addresses problem 2 only. Idle-stop is application layer. |

---

## Script location / state (updated 2026-07-05)

- File: `scripts/codespace-keepalive.sh` (mode 0755) -- **now git-tracked** (verified 2026-07-05 via `git ls-files`)
- Log: `cache/keepalive/keepalive.log` (gitignored via `cache/` rule)
- PID: `cache/keepalive/keepalive.pid`
