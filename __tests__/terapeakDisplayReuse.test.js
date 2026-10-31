'use strict';

/**
 * #318H / #319H / #321H -- display helper reuse, descriptor inheritance, and
 * process-inspection robustness. These run the real terapeak-display.sh against
 * fake Xtigervnc/websockify binaries.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DISPLAY_HELPER = path.join(PROJECT_ROOT, 'scripts', 'terapeak-display.sh');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function helperPath() {
  return process.platform === 'win32' ? toWslPath(DISPLAY_HELPER) : DISPLAY_HELPER;
}

function runWslHarness(name, harness, timeout = 30000) {
  const harnessFile = path.join(os.tmpdir(), `cpf-display-${name}-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(harnessFile, harness);
  try {
    if (process.platform === 'win32') {
      return childProcess.spawnSync('wsl', ['bash', toWslPath(harnessFile)], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout,
      });
    }
    return childProcess.spawnSync('bash', [harnessFile], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout });
  } finally {
    fs.rmSync(harnessFile, { force: true });
  }
}

// Shared bash prelude: fake VNC and proxy daemons, isolated state, cleanup on exit.
function displayPrelude(label) {
  const testId = `${process.pid}-${Date.now()}-${label}`;
  const portNonce = (Date.now() + label.length * 37) % 9000;
  return String.raw`
set -euo pipefail
temp_dir="/tmp/cpf-display-${label}-${testId}"
vnc_port=${21000 + portNonce}
web_port=${31000 + portNonce}
mkdir -p "$temp_dir/bin" "$temp_dir/state" "$temp_dir/www"
cleanup() {
  for pid_file in "$temp_dir/vnc.pid" "$temp_dir/proxy.pid"; do
    if [[ -f "$pid_file" ]]; then
      pid="$(cat "$pid_file")"
      kill "$pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.05
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$temp_dir"
}
trap cleanup EXIT
printf '%s\n' fake-password > "$temp_dir/passwd"
printf '%s\n' '<html>test</html>' > "$temp_dir/www/vnc.html"
chmod 600 "$temp_dir/passwd"
cat > "$temp_dir/bin/Xtigervnc" <<'PY'
#!/usr/bin/python3
import os
import socket
import sys
import time
args = sys.argv[1:]
open(os.environ['FAKE_VNC_PID_FILE'], 'w').write(str(os.getpid()))
port = int(args[args.index('-rfbport') + 1])
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('127.0.0.1', port))
server.listen()
while True:
    time.sleep(1)
PY
cat > "$temp_dir/bin/websockify" <<'PY'
#!/usr/bin/python3
import http.server
import os
import sys
args = sys.argv[1:]
open(os.environ['FAKE_PROXY_PID_FILE'], 'w').write(str(os.getpid()))
host, port = args[1].rsplit(':', 1)
class Handler(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
    self.send_response(200 if self.path == '/vnc.html' else 404); self.end_headers(); self.wfile.write(b'test page')
  def log_message(self, *_args): pass
http.server.HTTPServer((host, int(port)), Handler).serve_forever()
PY
chmod +x "$temp_dir/bin/Xtigervnc" "$temp_dir/bin/websockify"
export PATH="$temp_dir/bin:$PATH"
export XDG_STATE_HOME="$temp_dir/state"
export VNC_PASSWORD_FILE="$temp_dir/passwd"
export TERAPEAK_VNC_DISPLAY=92
export TERAPEAK_VNC_PORT="$vnc_port"
export TERAPEAK_NOVNC_PORT="$web_port"
export TERAPEAK_XTIGERVNC_BIN="$temp_dir/bin/Xtigervnc"
export TERAPEAK_WEBSOCKIFY_BIN="$temp_dir/bin/websockify"
export TERAPEAK_NOVNC_WEB_DIR="$temp_dir/www"
export FAKE_VNC_PID_FILE="$temp_dir/vnc.pid"
export FAKE_PROXY_PID_FILE="$temp_dir/proxy.pid"
export DISPLAY=:92
helper="${helperPath()}"
`;
}

describe('#318H display start is idempotent when both servers are already running', () => {
  test('a second start succeeds, prints the URL, and starts nothing new', () => {
    const harness = `${displayPrelude('reuse')}
bash "$helper" start > "$temp_dir/first.log" 2>&1 || { echo "first start failed"; cat "$temp_dir/first.log"; exit 1; }
grep -q 'VNC PID:' "$temp_dir/first.log"
first_vnc="$(cat "$temp_dir/vnc.pid")"
set +e
bash "$helper" start > "$temp_dir/second.log" 2>&1
second_rc=$?
set -e
echo "second_rc=$second_rc"
echo "same_vnc=$([[ "$(cat "$temp_dir/vnc.pid")" == "$first_vnc" ]] && echo yes || echo no)"
echo "second_has_pid_lines=$(grep -c 'PID:' "$temp_dir/second.log" || true)"
echo "second_ready=$(grep -c 'terapeak-display:READY' "$temp_dir/second.log" || true)"
echo "second_url=$(grep -c "http://localhost:$web_port/vnc.html" "$temp_dir/second.log" || true)"
bash "$helper" check > "$temp_dir/check.log" 2>&1
echo "check_rc=$?"
`;
    const result = runWslHarness('reuse', harness);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('second_rc=0');
    expect(result.stdout).toContain('same_vnc=yes');
    expect(result.stdout).toContain('second_has_pid_lines=0');
    expect(result.stdout).toContain('second_ready=1');
    expect(result.stdout).toContain('second_url=1');
    expect(result.stdout).toContain('check_rc=0');
  }, 60000);
});

describe('#319H display daemons do not inherit the caller descriptors', () => {
  test('a lock held by the caller is released when the caller closes it, even with the servers still running', () => {
    const harness = `${displayPrelude('lock')}
lock_file="$temp_dir/operator.lock"
exec 9>"$lock_file"
flock -n 9
bash "$helper" start > "$temp_dir/start.log" 2>&1 || { echo "start failed"; cat "$temp_dir/start.log"; exit 1; }
for name in vnc proxy; do
  pid="$(cat "$temp_dir/$name.pid")"
  held="no"
  for fd in /proc/$pid/fd/*; do
    if [[ "$(readlink "$fd" 2>/dev/null || true)" == "$lock_file" ]]; then held="yes"; fi
  done
  echo "$name holds the lock file: $held"
done
exec 9>&-
if flock -n "$lock_file" true; then echo "lock released after the caller closed it"; else echo "lock still held by a display process"; fi
`;
    const result = runWslHarness('lock', harness);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('vnc holds the lock file: no');
    expect(result.stdout).toContain('proxy holds the lock file: no');
    expect(result.stdout).toContain('lock released after the caller closed it');
  }, 60000);
});

describe('#321H process inspection', () => {
  const proc = (extra) => `${displayPrelude('inspect')}
export TERAPEAK_PROC_ROOT="$temp_dir/proc"
source <(sed '/^command_name=/,$d' "$helper")
make_proc() {
  local pid="$1" exe="$2"; shift 2
  mkdir -p "$temp_dir/proc/$pid"
  ln -sf "$exe" "$temp_dir/proc/$pid/exe"
  python3 - "$temp_dir/proc/$pid/cmdline" "$exe" "$@" <<'PY'
import sys
open(sys.argv[1], 'wb').write(b'\\0'.join(a.encode() for a in sys.argv[2:]) + b'\\0')
PY
}
${extra}`;

  test('a binary executable is verified without a null-byte warning', () => {
    const harness = proc(`
make_proc 4242 /usr/bin/true :92 -localhost yes
(verify_process 4242 /usr/bin/true :92 -localhost yes) 2> "$temp_dir/verify.err"
echo "rc=$?"
echo "stderr_bytes=$(wc -c < "$temp_dir/verify.err")"
cat "$temp_dir/verify.err"
`);
    const result = runWslHarness('inspect-binary', harness);
    expect(result.stdout).toContain('rc=0');
    expect(result.stdout).toContain('stderr_bytes=0');
    expect(result.stdout).not.toContain('ignored null byte');
  }, 60000);

  test('a process whose /proc entry appears moments late is still verified', () => {
    const harness = proc(`
( sleep 0.4; make_proc 4243 /usr/bin/true :92 -localhost yes ) &
(verify_process 4243 /usr/bin/true :92 -localhost yes) 2> "$temp_dir/late.err"
echo "late_rc=$?"
wait
`);
    const result = runWslHarness('inspect-late', harness);
    expect(result.stdout).toContain('late_rc=0');
  }, 60000);

  test('a process that never becomes inspectable still fails, after a bounded number of waits', () => {
    const harness = proc(`
sleep() { printf '%s\\n' "$1" >> "$temp_dir/sleeps"; }
set +e
(verify_process 4244 /usr/bin/true :92 -localhost yes) 2> "$temp_dir/never.err"
echo "never_rc=$?"
set -e
echo "sleep_calls=$(wc -l < "$temp_dir/sleeps")"
echo "distinct_sleep_values=$(sort -u "$temp_dir/sleeps" | tr '\\n' ' ')"
cat "$temp_dir/never.err"
`);
    const result = runWslHarness('inspect-never', harness);
    expect(result.stdout).toContain('never_rc=1');
    expect(result.stdout).toContain('sleep_calls=20');
    expect(result.stdout).toContain('distinct_sleep_values=0.1 ');
    expect(result.stdout).toContain('Cannot inspect listener process 4244');
  }, 60000);
});
