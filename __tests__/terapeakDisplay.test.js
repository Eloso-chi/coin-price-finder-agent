'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DISPLAY_HELPER = path.join(PROJECT_ROOT, 'scripts', 'terapeak-display.sh');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runWslHarness(name, harness, timeout = 10000) {
  const harnessFile = path.join(os.tmpdir(), `cpf-display-${name}-${process.pid}.sh`);
  fs.writeFileSync(harnessFile, harness);
  try {
    return childProcess.spawnSync('wsl', ['bash', toWslPath(harnessFile)], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout,
    });
  } finally {
    fs.rmSync(harnessFile, { force: true });
  }
}

describe('terapeak-display.sh lifecycle', () => {
  test('failed proxy startup cleans up new VNC and a retry completes securely', () => {
    const testId = `${process.pid}-${Date.now()}`;
    const helperPath = toWslPath(DISPLAY_HELPER);
    const tempDir = `/tmp/cpf-display-lifecycle-${testId}`;
    const portNonce = Date.now() % 10000;
    const vncPort = 20000 + portNonce;
    const webPort = 30000 + portNonce;
    const harness = String.raw`
set -euo pipefail
temp_dir="${tempDir}"
vnc_port=${vncPort}
web_port=${webPort}
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
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
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
import socket
import os
import sys
import time
args = sys.argv[1:]
pid_file = os.environ.get('FAKE_VNC_PID_FILE')
if pid_file:
  open(pid_file, 'w').write(str(os.getpid()))
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
fail_file = os.environ.get('FAKE_PROXY_FAIL_FILE')
pid_file = os.environ.get('FAKE_PROXY_PID_FILE')
unresponsive_file = os.environ.get('FAKE_PROXY_UNRESPONSIVE_FILE')
if fail_file and os.path.exists(fail_file):
    os.unlink(fail_file)
    sys.exit(9)
if pid_file:
    open(pid_file, 'w').write(str(os.getpid()))
listen = args[1]
host, port = listen.rsplit(':', 1)
class Handler(http.server.BaseHTTPRequestHandler):
  def do_GET(self): self.send_response(503 if unresponsive_file and os.path.exists(unresponsive_file) else (200 if self.path == '/vnc.html' else 404)); self.end_headers(); self.wfile.write(b'test page')
  def log_message(self, *_args): pass
http.server.HTTPServer((host, int(port)), Handler).serve_forever()
PY
chmod +x "$temp_dir/bin/Xtigervnc" "$temp_dir/bin/websockify"
: > "$temp_dir/fail-proxy-once"
export PATH="$temp_dir/bin:$PATH"
export XDG_STATE_HOME="$temp_dir/state"
export VNC_PASSWORD_FILE="$temp_dir/passwd"
export TERAPEAK_VNC_DISPLAY=91
export TERAPEAK_VNC_PORT="$vnc_port"
export TERAPEAK_NOVNC_PORT="$web_port"
export TERAPEAK_XTIGERVNC_BIN="$temp_dir/bin/Xtigervnc"
export TERAPEAK_WEBSOCKIFY_BIN="$temp_dir/bin/websockify"
export TERAPEAK_NOVNC_WEB_DIR="$temp_dir/www"
export FAKE_PROXY_FAIL_FILE="$temp_dir/fail-proxy-once"
export FAKE_VNC_PID_FILE="$temp_dir/vnc.pid"
export FAKE_PROXY_PID_FILE="$temp_dir/proxy.pid"
export FAKE_PROXY_UNRESPONSIVE_FILE="$temp_dir/proxy-unresponsive"
export DISPLAY=:91
if bash "${helperPath}" start > "$temp_dir/first.log" 2>&1; then
  echo 'first startup unexpectedly succeeded'
  exit 1
fi
if ss -H -ltn "sport = :$vnc_port" | grep -q LISTEN; then
  echo 'VNC listener leaked after proxy startup failure'
  cat "$temp_dir/first.log"
  exit 1
fi
vnc_pid="$(cat "$temp_dir/vnc.pid")"
if kill -0 "$vnc_pid" 2>/dev/null; then
  echo "VNC process $vnc_pid survived failed startup"
  exit 1
fi
bash "${helperPath}" start > "$temp_dir/retry.log" 2>&1 || { cat "$temp_dir/retry.log"; cat "$temp_dir/state/cpf-terapeak-display/logs/vnc.log" "$temp_dir/state/cpf-terapeak-display/logs/novnc.log"; exit 1; }
grep -q '\[terapeak-display:READY\]' "$temp_dir/retry.log"
grep -q "http://localhost:$web_port/vnc.html?host=localhost&port=$web_port" "$temp_dir/retry.log"
cat "$temp_dir/retry.log"
proxy_pid="$(cat "$temp_dir/proxy.pid")"
kill "$proxy_pid"
for _ in {1..20}; do
  kill -0 "$proxy_pid" 2>/dev/null || break
  sleep 0.05
done
: > "$temp_dir/proxy-unresponsive"
if bash "${helperPath}" start > "$temp_dir/timeout.log" 2>&1; then
  echo 'unresponsive noVNC proxy unexpectedly passed readiness'
  exit 1
fi
grep -q 'did not become ready within 10 seconds' "$temp_dir/timeout.log"
proxy_pid="$(cat "$temp_dir/proxy.pid")"
if kill -0 "$proxy_pid" 2>/dev/null; then
  echo "unresponsive noVNC process $proxy_pid survived timeout cleanup"
  exit 1
fi
cat "$temp_dir/timeout.log"
`;
    const result = runWslHarness('lifecycle', harness, 30000);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
      expect.objectContaining({ status: 0, stderr: '' }),
    );
    expect(result.stdout).toContain('[terapeak-display:READY]');
    expect(result.stdout).toContain(`http://localhost:${webPort}/vnc.html?host=localhost&port=${webPort}`);
  });

  test('noVNC readiness timeout is bounded to the documented startup window', () => {
    const source = fs.readFileSync(DISPLAY_HELPER, 'utf8');
    expect(source).toContain('for _ in {1..40}');
    expect(source).toContain('--max-time 0.1');
    expect(source).toContain('sleep 0.15');
    expect(source).toContain('did not become ready within 10 seconds');
  });

  test('process verification rejects duplicate conflicting VNC security options', () => {
    const testId = `${process.pid}-${Date.now()}`;
    const helperPath = toWslPath(DISPLAY_HELPER);
    const tempDir = `/tmp/cpf-display-process-${testId}`;
    const harness = String.raw`
set -euo pipefail
temp_dir="${tempDir}"
mkdir -p "$temp_dir/proc/4242"
trap 'rm -rf "$temp_dir"' EXIT
printf '%s\n' '#!/usr/bin/python3' > "$temp_dir/Xtigervnc"
chmod +x "$temp_dir/Xtigervnc"
ln -s /usr/bin/python3 "$temp_dir/proc/4242/exe"
python3 - "$temp_dir/proc/4242/cmdline" "$temp_dir/Xtigervnc" <<'PY'
import sys
args = [b'/usr/bin/python3', sys.argv[2].encode(), b':1', b'-localhost', b'yes', b'-rfbport', b'5901', b'-SecurityTypes', b'VncAuth', b'-SecurityTypes', b'None', b'-PasswordFile', b'/tmp/passwd']
open(sys.argv[1], 'wb').write(b'\0'.join(args) + b'\0')
PY
export TERAPEAK_PROC_ROOT="$temp_dir/proc"
source <(sed '/^command_name=/,$d' "${helperPath}")
if (verify_unique_option 4242 -SecurityTypes VncAuth) 2> "$temp_dir/verify.log"; then
  echo 'conflicting security option was accepted'
  exit 1
fi
cat "$temp_dir/verify.log"
`;
    const result = runWslHarness('process-identity', harness);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
      expect.objectContaining({ status: 0, stderr: '' }),
    );
    expect(result.stdout).toContain('unexpected effective value for -SecurityTypes');
  });
});
