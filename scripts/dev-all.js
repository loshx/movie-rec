#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW_ARGS = process.argv.slice(2);
const ARGS = new Set(RAW_ARGS);
const USB_MODE = ARGS.has('--usb');
const SKIP_ML = ARGS.has('--no-ml');
const SKIP_PORT_CLEAN = ARGS.has('--no-clean');
const USE_TUNNEL = ARGS.has('--tunnel');
const SHOULD_FORCE_LAN = USE_TUNNEL && !USB_MODE;
const HOST_IP_OVERRIDE = readArgValue('--host-ip') || process.env.DEV_ALL_HOST_IP || '';

const BACKEND_PORT = Number(process.env.CINEMA_API_PORT || process.env.PORT || 8787);
const ML_PORT = Number(process.env.ML_PORT || 8008);
const LOCAL_IPV4 = detectLocalIpv4();
const PUBLIC_HOST = USB_MODE ? '127.0.0.1' : LOCAL_IPV4;

const BACKEND_URL = `http://${PUBLIC_HOST}:${BACKEND_PORT}`;
const ML_URL = SKIP_ML ? '' : `http://${PUBLIC_HOST}:${ML_PORT}`;
const WS_URL = `ws://${PUBLIC_HOST}:${BACKEND_PORT}/ws`;

const children = [];
let shuttingDown = false;

function detectLocalIpv4() {
  const override = String(HOST_IP_OVERRIDE || '').trim();
  if (override.length) {
    return override;
  }

  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, iface] of Object.entries(nets)) {
    for (const net of iface || []) {
      if (!net || net.family !== 'IPv4' || net.internal) continue;
      candidates.push({ name, address: net.address });
    }
  }

  const isBlockedName = (name) =>
    /(nord|vpn|openvpn|vethernet|hyper-v|docker|virtual|loopback|tap|tun|tailscale|zerotier)/i.test(name);
  const isPreferredName = (name) => /(wi-?fi|wlan|wireless|ethernet)/i.test(name);
  const isPrivateIpv4 = (ip) =>
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);

  const filtered = candidates.filter((c) => !isBlockedName(c.name));
  const preferred = filtered.find((c) => isPreferredName(c.name) && isPrivateIpv4(c.address));
  if (preferred) return preferred.address;

  const privateFiltered = filtered.find((c) => isPrivateIpv4(c.address));
  if (privateFiltered) return privateFiltered.address;

  const privateAny = candidates.find((c) => isPrivateIpv4(c.address));
  if (privateAny) return privateAny.address;

  if (candidates.length) return candidates[0].address;
  return '127.0.0.1';
}

function readArgValue(flag) {
  const inline = RAW_ARGS.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }
  const idx = RAW_ARGS.indexOf(flag);
  if (idx >= 0 && idx + 1 < RAW_ARGS.length) {
    return RAW_ARGS[idx + 1];
  }
  return '';
}

function info(message) {
  process.stdout.write(`[dev-all] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[dev-all] ${message}\n`);
}

function commandForBin(bin) {
  if (process.platform !== 'win32') return bin;
  if (bin === 'npx') return 'npx.cmd';
  if (bin === 'npm') return 'npm.cmd';
  return bin;
}

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!text.length) return '""';
  if (!/[ \t"]/g.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runBestEffort(bin, args, options = {}) {
  const result = spawnSync(commandForBin(bin), args, {
    cwd: ROOT,
    stdio: 'ignore',
    shell: false,
    ...options,
  });
  return result.status === 0;
}

function parseWindowsNetstatPortPids(port, netstatOutput) {
  const pids = new Set();
  const lines = String(netstatOutput || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('TCP')) continue;
    const cols = line.split(/\s+/);
    // Format: TCP LocalAddress ForeignAddress State PID
    if (cols.length < 5) continue;
    if (cols[3] !== 'LISTENING') continue;
    const localAddress = cols[1];
    if (!localAddress.endsWith(`:${port}`)) continue;
    const pid = Number(cols[4]);
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function getListeningPidsOnPort(port) {
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      shell: false,
    });
    if (result.status !== 0) return [];
    return parseWindowsNetstatPortPids(port, result.stdout);
  }

  const result = spawnSync('lsof', ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-t'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function killPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      shell: false,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
  }
}

function ensurePortsFree(ports) {
  if (SKIP_PORT_CLEAN) {
    info('skipping port cleanup (--no-clean)');
    return;
  }
  for (const port of ports) {
    const pids = getListeningPidsOnPort(port);
    if (!pids.length) continue;
    warn(`port ${port} already in use by PID(s): ${pids.join(', ')}. Stopping stale process(es)...`);
    for (const pid of pids) {
      killPid(pid);
    }
  }
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      shell: false,
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    killTree(child);
  }
  process.exit(exitCode);
}

function spawnService(name, bin, args, extraEnv = {}) {
  info(`starting ${name}: ${bin} ${args.join(' ')}`);
  const env = { ...process.env, ...extraEnv };
  let child;
  try {
    child = spawn(commandForBin(bin), args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      env,
    });
  } catch (err) {
    if (process.platform !== 'win32') {
      throw err;
    }
    const joined = [commandForBin(bin), ...args].map(quoteWindowsArg).join(' ');
    child = spawn('cmd.exe', ['/d', '/s', '/c', joined], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      env,
    });
  }
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    warn(`${name} exited (code=${String(code)}, signal=${String(signal)})`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  children.push(child);
  return child;
}

function requestOnce(url, timeoutMs = 2000) {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = client.request(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: timeoutMs,
      },
      (res) => {
        resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
        res.resume();
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForHealth(url, label, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await requestOnce(url, 2000);
    if (ok) {
      info(`${label} healthy: ${url}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`${label} did not become healthy in ${timeoutMs / 1000}s (${url})`);
}

function resolvePythonBin() {
  const venvPython = path.join(ROOT, 'ml', '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.env.PYTHON || 'python';
}

async function main() {
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (HOST_IP_OVERRIDE) {
    info(`host ip override: ${HOST_IP_OVERRIDE}`);
  }

  ensurePortsFree([
    BACKEND_PORT,
    ...(SKIP_ML ? [] : [ML_PORT]),
    8081,
  ]);

  if (USB_MODE) {
    info('USB mode enabled: attempting adb reverse for backend/ml/metro ports');
    runBestEffort('adb', ['reverse', `tcp:${BACKEND_PORT}`, `tcp:${BACKEND_PORT}`]);
    if (!SKIP_ML) {
      runBestEffort('adb', ['reverse', `tcp:${ML_PORT}`, `tcp:${ML_PORT}`]);
    }
    runBestEffort('adb', ['reverse', 'tcp:8081', 'tcp:8081']);
  }

  spawnService('backend', 'node', ['./server/cinema-ws-server.js'], {
    PORT: String(BACKEND_PORT),
  });
  await waitForHealth(`http://127.0.0.1:${BACKEND_PORT}/health`, 'backend');

  if (!SKIP_ML) {
    const pythonBin = resolvePythonBin();
    spawnService('ml', pythonBin, ['-m', 'uvicorn', 'api:app', '--host', '0.0.0.0', '--port', String(ML_PORT), '--app-dir', 'ml'], {
      ML_DATABASE_URL: process.env.ML_DATABASE_URL || 'sqlite:///./ml/ml_local.db',
    });
    await waitForHealth(`http://127.0.0.1:${ML_PORT}/health`, 'ml');
  } else {
    info('ML service skipped (--no-ml)');
  }

  info(`backend url: ${BACKEND_URL}`);
  info(`ws url: ${WS_URL}`);
  info(`ml url: ${ML_URL || '(disabled)'}`);
  info(`network mode: ${USB_MODE ? 'usb-reverse' : `lan (${LOCAL_IPV4})`}`);

  if (SHOULD_FORCE_LAN) {
    warn(
      'Ignoring --tunnel for local backend mode. Browser/tunnel uses HTTPS and will block local HTTP API (mixed content/CORS). Using --lan instead.'
    );
  }
  const expoArgs = ['expo', 'start', '--dev-client', '-c', SHOULD_FORCE_LAN ? '--lan' : USE_TUNNEL ? '--tunnel' : '--lan'];
  spawnService('expo', 'npx', expoArgs, {
    EXPO_PUBLIC_BACKEND_URL: BACKEND_URL,
    EXPO_PUBLIC_CINEMA_WS_URL: WS_URL,
    EXPO_PUBLIC_ML_API_URL: ML_URL,
    REACT_NATIVE_PACKAGER_HOSTNAME: PUBLIC_HOST,
  });
}

main().catch((error) => {
  warn(error instanceof Error ? error.message : String(error));
  shutdown(1);
});
