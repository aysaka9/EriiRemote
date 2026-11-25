const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const CONTROL_PORT = 17988;

let mainWindow = null;
let tray = null;
let easytierProc = null;
let controlServer = null;
let isQuitting = false;
let engineMode = 'stopped'; // 'builtin' | 'external' | 'unconfigured' | 'stopped' | 'error'
let engineLastError = '';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

function getResourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...parts);
  }
  return path.join(__dirname, '..', 'resources', ...parts);
}

function getAssetPath(...parts) {
  return path.join(__dirname, '..', 'assets', ...parts);
}

function getDataFilePath() {
  return path.join(app.getPath('userData'), 'erii-remote-data.json');
}

function loadDefaultConfig() {
  const defPath = getResourcePath('default_config.json');
  try {
    const raw = fs.readFileSync(defPath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {
      network_name: '',
      network_secret: '',
      public_peers: [
        'tcp://et.sumnight.top:11010',
        'tcp://easytier.weiai.org.cn:11010',
        'tcp://225284.xyz:11010'
      ],
      use_dhcp: true,
      static_ip: '',
      nas_http_port: 5666,
      nas_https_port: 5667,
      allow_remote_power: true
    };
  }
}

function loadAppData() {
  const filePath = getDataFilePath();
  const defCfg = loadDefaultConfig();
  const fallback = {
    config: {
      ...defCfg,
      hostname: os.hostname(),
      autoStart: false,
      allow_remote_power: true
    },
    aliases: {},
    favorites: [],
    knownDevices: {},
    quickLaunches: {}
  };
  if (!fs.existsSync(filePath)) {
    saveAppData(fallback);
    return fallback;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      ...fallback,
      ...parsed,
      config: { ...fallback.config, ...(parsed.config || {}) }
    };
  } catch {
    return fallback;
  }
}

function saveAppData(data) {
  const filePath = getDataFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getShareDir() {
  const data = loadAppData();
  const dir = (data.config && data.config.share_dir && data.config.share_dir.trim())
    ? data.config.share_dir.trim()
    : path.join(app.getPath('documents'), 'EriiRemote共享');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function getAuthToken(cfg) {
  const name = (cfg && cfg.network_name ? cfg.network_name : '').trim();
  const secret = (cfg && cfg.network_secret ? cfg.network_secret : '').trim();
  if (!name || !secret) return '';
  return crypto.createHash('sha256').update(`${name}:${secret}:erii-power-v1`).digest('hex');
}

// Get physical NIC MAC addresses & per-interface IPv4/broadcast pairs for reliable WOL on Windows
function getLocalNetworkMeta() {
  const ifaces = os.networkInterfaces();
  const ethernetMacs = [];
  const otherMacs = [];
  const sendTargets = []; // { localIp, broadcast }
  for (const [name, entries] of Object.entries(ifaces)) {
    const low = name.toLowerCase();
    const isVirtual = low.includes('vethernet') || low.includes('virtual') || low.includes('vmware') ||
      low.includes('vbox') || low.startsWith('et_') || low.includes('wintun') || low.includes('tailscale') ||
      low.includes('loopback') || low.includes('bluetooth') || low.includes('zerotier') || low.includes('radmin');
    const isEthernet = low.includes('ethernet') || low.includes('以太网') || low.includes('本地连接') || low.startsWith('eth') || low.startsWith('enp');
    for (const info of (entries || [])) {
      if (info.family === 'IPv4' && !info.internal && !isVirtual) {
        if (info.mac && info.mac !== '00:00:00:00:00:00') {
          const formatted = info.mac.toUpperCase();
          if (isEthernet) {
            if (!ethernetMacs.includes(formatted)) ethernetMacs.push(formatted);
          } else {
            if (!otherMacs.includes(formatted)) otherMacs.push(formatted);
          }
        }
        if (info.address && info.netmask) {
          const ipParts = info.address.split('.').map(Number);
          const maskParts = info.netmask.split('.').map(Number);
          if (ipParts.length === 4 && maskParts.length === 4) {
            const bcast = ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.');
            sendTargets.push({ localIp: info.address, broadcast: bcast });
          }
        }
      }
    }
  }
  const macs = [...ethernetMacs, ...otherMacs];
  return { primaryMac: macs[0] || '', macs, sendTargets };
}

function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return '';
  return hex.match(/.{2}/g).join(':');
}

function sendPacketFromInterface(packet, localIp, targets) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      resolve(ok);
    };
    sock.on('error', () => finish(false));
    const bindArgs = localIp ? [0, localIp] : [0];
    sock.bind(...bindArgs, () => {
      try { sock.setBroadcast(true); } catch {}
      let pending = targets.length * 2;
      const done = () => {
        pending -= 1;
        if (pending <= 0) finish(true);
      };
      for (const addr of targets) {
        sock.send(packet, 0, packet.length, 9, addr, done);
        sock.send(packet, 0, packet.length, 7, addr, done);
      }
    });
    setTimeout(() => finish(true), 1500);
  });
}

async function sendMagicPacketLocal(macStr) {
  const clean = normalizeMac(macStr);
  if (!clean) return { ok: false, error: '无效的 MAC 地址' };
  const macBytes = Buffer.from(clean.replace(/:/g, ''), 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6);
  }
  const { sendTargets } = getLocalNetworkMeta();
  const tasks = [];
  // Explicitly bind to every physical NIC's IPv4 so Windows never routes WOL only to the virtual EasyTier NIC
  for (const t of sendTargets) {
    const addrs = t.broadcast === '255.255.255.255' ? ['255.255.255.255'] : [t.broadcast, '255.255.255.255'];
    tasks.push(sendPacketFromInterface(packet, t.localIp, addrs));
  }
  if (tasks.length === 0) {
    tasks.push(sendPacketFromInterface(packet, null, ['255.255.255.255']));
  }
  const results = await Promise.all(tasks);
  return { ok: results.some(Boolean), mac: clean, nicCount: tasks.length };
}

function httpJsonRequest(ip, method, reqPath, bodyObj, token, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = http.request({
      hostname: ip,
      port: CONTROL_PORT,
      path: reqPath,
      method,
      timeout: timeoutMs,
      headers: {
        'X-Erii-Token': token || '',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw || '{}') });
        } catch {
          resolve({ status: res.statusCode, data: {} });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

function startControlServer() {
  if (controlServer) return;
  controlServer = http.createServer((req, res) => {
    const sendJson = (status, obj) => {
      const buf = Buffer.from(JSON.stringify(obj), 'utf-8');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
    };

    const data = loadAppData();
    const expectedToken = getAuthToken(data.config);
    const gotToken = String(req.headers['x-erii-token'] || '');
    if (!expectedToken || gotToken !== expectedToken) {
      return sendJson(401, { ok: false, error: 'unauthorized' });
    }

    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/api/info') {
      const meta = getLocalNetworkMeta();
      return sendJson(200, {
        ok: true,
        hostname: data.config.hostname || os.hostname(),
        mac: meta.primaryMac,
        macs: meta.macs,
        allow_remote_power: data.config.allow_remote_power !== false
      });
    }

    if (req.method === 'GET' && pathname === '/api/version') {
      getInstallerInfo().then((inst) => {
        sendJson(200, {
          ok: true,
          version: app.getVersion(),
          installer: inst ? { sha256: inst.sha256, size: inst.size } : null
        });
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/installer') {
      const p = getLocalInstallerPath();
      if (!p) return sendJson(404, { ok: false, error: 'installer not available' });
      const st = fs.statSync(p);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(p).pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/files') {
      const shareDir = getShareDir();
      try {
        const entries = fs.readdirSync(shareDir, { withFileTypes: true });
        const files = [];
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          const st = fs.statSync(path.join(shareDir, ent.name));
          files.push({ name: ent.name, size: st.size, mtime: st.mtimeMs });
        }
        files.sort((a, b) => b.mtime - a.mtime);
        return sendJson(200, { ok: true, shareDir, files });
      } catch (e) {
        return sendJson(500, { ok: false, error: String(e.message || e) });
      }
    }

    if (req.method === 'GET' && pathname === '/api/files/download') {
      const rawName = parsedUrl.searchParams.get('name') || '';
      const safeName = path.basename(rawName);
      const target = path.join(getShareDir(), safeName);
      if (!safeName || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return sendJson(404, { ok: false, error: 'file not found' });
      }
      const st = fs.statSync(target);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/files/upload') {
      const rawName = parsedUrl.searchParams.get('name') || `upload_${Date.now()}.bin`;
      const safeName = path.basename(rawName).trim() || `upload_${Date.now()}.bin`;
      const dest = path.join(getShareDir(), safeName);
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      let failed = false;
      req.on('error', () => {
        failed = true;
        out.destroy();
        try { fs.rmSync(tmp, { force: true }); } catch {}
      });
      out.on('error', (e) => {
        failed = true;
        try { fs.rmSync(tmp, { force: true }); } catch {}
        sendJson(500, { ok: false, error: String(e.message || e) });
      });
      out.on('finish', () => {
        if (failed) return;
        try {
          fs.renameSync(tmp, dest);
          sendJson(200, { ok: true, name: safeName });
        } catch (e) {
          sendJson(500, { ok: false, error: String(e.message || e) });
        }
      });
      req.pipe(out);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/files/delete') {
      let raw = '';
      req.on('data', (c) => { if (raw.length < 16384) raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const safeName = path.basename(String(body.name || ''));
        const target = path.join(getShareDir(), safeName);
        if (!safeName || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return sendJson(404, { ok: false, error: 'file not found' });
        }
        try {
          fs.unlinkSync(target);
          return sendJson(200, { ok: true });
        } catch (e) {
          return sendJson(500, { ok: false, error: String(e.message || e) });
        }
      });
      return;
    }

    if (req.method === 'POST' && (pathname === '/api/power' || pathname === '/api/wol')) {
      let raw = '';
      req.on('data', (chunk) => { if (raw.length < 16384) raw += chunk; });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}

        if (req.url === '/api/wol') {
          const wolRes = await sendMagicPacketLocal(body.mac);
          return sendJson(wolRes.ok ? 200 : 400, wolRes);
        }

        if (data.config.allow_remote_power === false) {
          return sendJson(403, { ok: false, error: '目标设备已在设置中关闭「允许远程电源控制」' });
        }

        const action = body.action;
        if (action === 'shutdown') {
          spawn('shutdown.exe', ['/s', '/t', '5', '/c', 'Erii远程：正在执行远程关机（5秒后关闭）'], { windowsHide: true }).unref();
          return sendJson(200, { ok: true, message: '已下发关机指令（目标电脑 5 秒后关机）' });
        }
        if (action === 'reboot') {
          spawn('shutdown.exe', ['/r', '/t', '5', '/c', 'Erii远程：正在执行远程重启（5秒后重启）'], { windowsHide: true }).unref();
          return sendJson(200, { ok: true, message: '已下发重启指令（目标电脑 5 秒后重启）' });
        }
        if (action === 'cancel') {
          spawn('shutdown.exe', ['/a'], { windowsHide: true }).unref();
          return sendJson(200, { ok: true, message: '已取消目标电脑的计划关机/重启' });
        }
        if (action === 'lock') {
          spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }).unref();
          return sendJson(200, { ok: true, message: '已锁定目标电脑屏幕' });
        }
        if (action === 'sleep') {
          spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { windowsHide: true }).unref();
          return sendJson(200, { ok: true, message: '已下发睡眠指令' });
        }
        return sendJson(400, { ok: false, error: '未知的电源指令' });
      });
      return;
    }

    sendJson(404, { ok: false, error: 'not found' });
  });

  controlServer.on('error', () => {
    // Port may already be in use; ignore non-fatally
  });
  controlServer.listen(CONTROL_PORT, '0.0.0.0');
}

// ===================== LAN peer-to-peer auto update =====================
let updateInProgress = false;
let installerHashCache = null;
const peerVersionCheckedAt = new Map();

function getLocalInstallerPath() {
  if (!app.isPackaged) return null;
  const p = path.join(path.dirname(process.execPath), 'update', 'EriiRemote-Setup.exe');
  return fs.existsSync(p) ? p : null;
}

function getInstallerInfo() {
  return new Promise((resolve) => {
    const p = getLocalInstallerPath();
    if (!p) return resolve(null);
    let st;
    try { st = fs.statSync(p); } catch { return resolve(null); }
    if (installerHashCache && installerHashCache.path === p &&
      installerHashCache.mtimeMs === st.mtimeMs && installerHashCache.size === st.size) {
      return resolve(installerHashCache);
    }
    const hash = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (c) => hash.update(c))
      .on('error', () => resolve(null))
      .on('end', () => {
        installerHashCache = { path: p, mtimeMs: st.mtimeMs, size: st.size, sha256: hash.digest('hex') };
        resolve(installerHashCache);
      });
  });
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function downloadInstallerFromPeer(ip, token, dest, expectedSha, expectedSize) {
  return new Promise((resolve) => {
    const tmp = `${dest}.part`;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok) { try { fs.rmSync(tmp, { force: true }); } catch {} }
      resolve(ok);
    };
    const req = http.request({
      hostname: ip,
      port: CONTROL_PORT,
      path: '/api/installer',
      method: 'GET',
      timeout: 120000,
      headers: { 'X-Erii-Token': token }
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(false); }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp);
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        if (expectedSize) {
          const pct = Math.floor((received * 100) / expectedSize);
          if (pct !== lastPct && pct % 20 === 0) {
            lastPct = pct;
            notifyRenderer('update-status', { stage: 'downloading', percent: pct });
          }
        }
      });
      res.on('error', () => finish(false));
      out.on('error', () => finish(false));
      out.on('finish', () => {
        out.close(() => {
          if (hash.digest('hex') !== expectedSha) return finish(false);
          try {
            fs.renameSync(tmp, dest);
            finish(true);
          } catch {
            finish(false);
          }
        });
      });
      res.pipe(out);
    });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

async function checkPeerUpdate(peer, token, force = false) {
  if (!token || !peer.ipv4 || updateInProgress) return false;
  const last = peerVersionCheckedAt.get(peer.ipv4) || 0;
  if (!force && Date.now() - last < 60 * 1000) return false;
  peerVersionCheckedAt.set(peer.ipv4, Date.now());

  const res = await httpJsonRequest(peer.ipv4, 'GET', '/api/version', null, token, 2500);
  if (res.status !== 200 || !res.data || !res.data.version) return false;

  const key = peer.hostname || peer.ipv4;
  const latest = loadAppData();
  if (latest.knownDevices[key] && latest.knownDevices[key].appVersion !== res.data.version) {
    latest.knownDevices[key].appVersion = res.data.version;
    saveAppData(latest);
  }

  if (!app.isPackaged || (!force && latest.config.auto_update === false)) return false;
  if (compareVersions(res.data.version, app.getVersion()) <= 0) return false;
  const inst = res.data.installer;
  if (!inst || !inst.sha256) return false;
  if (updateInProgress) return false;

  updateInProgress = true;
  const version = res.data.version;
  try {
    notifyRenderer('update-status', { stage: 'found', version, from: key });
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `EriiRemote-Setup-${version}.exe`);
    const ok = await downloadInstallerFromPeer(peer.ipv4, token, dest, inst.sha256, inst.size);
    if (!ok) {
      notifyRenderer('update-status', { stage: 'failed', version });
      updateInProgress = false;
      return false;
    }
    notifyRenderer('update-status', { stage: 'installing', version });
    setTimeout(async () => {
      // Wait 2s in a detached cmd wrapper so EriiRemote.exe and easytier-core.exe fully exit and unlock files before silent NSIS runs
      const cmd = `ping -n 3 127.0.0.1 >nul && start "" "${dest}" /S --force-run`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      isQuitting = true;
      if (easytierProc && easytierProc.pid) {
        await killProcessSync(easytierProc.pid);
      }
      if (controlServer) { try { controlServer.close(); } catch {} }
      app.exit(0);
    }, 1500);
    return true;
  } catch {
    updateInProgress = false;
    return false;
  }
}

function ensureFirewallRule() {
  execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=EriiRemote-Control'], { windowsHide: true }, (err, stdout) => {
    if (!err && String(stdout).includes('EriiRemote-Control')) return;
    execFile('netsh', [
      'advfirewall', 'firewall', 'add', 'rule', 'name=EriiRemote-Control',
      'dir=in', 'action=allow', 'protocol=TCP', `localport=${CONTROL_PORT}`
    ], { windowsHide: true }, () => {});
  });
}

// Enable WDDM graphics display driver for RDP ("Use WDDM graphics display driver for Remote Desktop Connections")
function ensureRdpWddmPolicy() {
  const key = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services';
  execFile('reg', ['add', key, '/v', 'fEnableWddmDriver', '/t', 'REG_DWORD', '/d', '1', '/f'], { windowsHide: true }, () => {});
}

function checkExternalEasyTier() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq easytier-core.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).toLowerCase().includes('easytier-core.exe'));
    });
  });
}

function killProcessSync(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
  });
}

function setWindowsAutoStart(enable) {
  return new Promise((resolve) => {
    try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
    if (!app.isPackaged) return resolve({ ok: true, skipped: true });
    const taskName = 'EriiRemote_AutoStart';
    if (enable) {
      execFile('schtasks', [
        '/Create', '/TN', taskName,
        '/TR', `"${process.execPath}"`,
        '/SC', 'ONLOGON',
        '/RL', 'HIGHEST',
        '/F'
      ], { windowsHide: true }, (err, _stdout, stderr) => {
        resolve({ ok: !err, error: err ? String(stderr || err.message) : '' });
      });
    } else {
      execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true }, () => {
        resolve({ ok: true });
      });
    }
  });
}

async function startEasyTierEngine(forceRestart = false) {
  const data = loadAppData();
  const cfg = data.config;

  if (forceRestart) {
    if (easytierProc) {
      const oldProc = easytierProc;
      easytierProc = null;
      await killProcessSync(oldProc.pid);
      await new Promise((r) => setTimeout(r, 600));
    } else if (engineMode === 'external' || await checkExternalEasyTier()) {
      // Stop standalone easytier-core.exe so the new config (e.g. static IP) can take effect
      await new Promise((r) => {
        execFile('taskkill', ['/F', '/IM', 'easytier-core.exe'], { windowsHide: true }, () => r());
      });
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  if (!easytierProc) {
    const externalRunning = await checkExternalEasyTier();
    if (externalRunning) {
      engineMode = 'external';
      engineLastError = '';
      return {
        ok: true,
        mode: 'external',
        note: forceRestart ? '检测到系统后台 EasyTier 服务仍在运行，配置未覆盖该外部服务' : ''
      };
    }
  } else {
    engineMode = 'builtin';
    return { ok: true, mode: 'builtin' };
  }

  if (!cfg.network_name || !cfg.network_name.trim() || !cfg.network_secret || !cfg.network_secret.trim()) {
    engineMode = 'unconfigured';
    engineLastError = '请先在设置中配置局域网名称和密钥';
    return { ok: false, mode: 'unconfigured', error: engineLastError };
  }

  const coreExe = getResourcePath('easytier', 'easytier-core.exe');
  if (!fs.existsSync(coreExe)) {
    engineMode = 'error';
    engineLastError = '未找到内置 easytier-core.exe，请先运行 npm run download-easytier';
    return { ok: false, error: engineLastError };
  }

  const args = [
    '-r', '127.0.0.1:25888',
    '--network-name', cfg.network_name.trim(),
    '--network-secret', cfg.network_secret.trim(),
    '--hostname', (cfg.hostname || os.hostname()).trim(),
    '--enable-kcp-proxy'
  ];
  if (!cfg.use_dhcp && cfg.static_ip && cfg.static_ip.trim()) {
    args.push('--ipv4', cfg.static_ip.trim());
  } else {
    args.push('--dhcp');
  }
  const peers = Array.isArray(cfg.public_peers) ? cfg.public_peers : [];
  for (const p of peers) {
    if (p && p.trim()) args.push('-p', p.trim());
  }

  try {
    engineLastError = '';
    const proc = spawn(coreExe, args, {
      cwd: path.dirname(coreExe),
      windowsHide: true
    });
    easytierProc = proc;
    engineMode = 'builtin';

    proc.stderr.on('data', (chunk) => {
      if (easytierProc !== proc) return;
      const msg = chunk.toString('utf-8').trim();
      if (msg) engineLastError = msg.slice(-300);
    });
    proc.on('exit', (code) => {
      if (easytierProc !== proc) return;
      easytierProc = null;
      if (!isQuitting) {
        engineMode = code === 0 ? 'stopped' : 'error';
      }
    });
    return { ok: true, mode: 'builtin' };
  } catch (e) {
    engineMode = 'error';
    engineLastError = String(e.message || e);
    return { ok: false, error: engineLastError };
  }
}

// Auto-probe peer MAC address from its EriiRemote control service (non-blocking)
const probedMacIps = new Set();
async function probePeerMacIfNeeded(peer, data, token) {
  if (!token || !peer.ipv4) return;
  const key = peer.hostname || peer.ipv4;
  const existing = data.knownDevices[key];
  if (existing && existing.mac) return;
  if (probedMacIps.has(peer.ipv4)) return;
  probedMacIps.add(peer.ipv4);
  setTimeout(() => probedMacIps.delete(peer.ipv4), 60000);

  const res = await httpJsonRequest(peer.ipv4, 'GET', '/api/info', null, token, 2000);
  if (res.status === 200 && res.data && res.data.mac) {
    const latest = loadAppData();
    if (!latest.knownDevices[key]) {
      latest.knownDevices[key] = { hostname: peer.hostname, ipv4: peer.ipv4, lastSeen: Date.now() };
    }
    latest.knownDevices[key].mac = normalizeMac(res.data.mac);
    saveAppData(latest);
  }
}

let inFlightPeerQuery = null;
let lastGoodPeerState = null;
let consecutivePeerFailures = 0;

function execCliPeer(cliExe, portalAddr) {
  return new Promise((resolve) => {
    const args = portalAddr ? ['-p', portalAddr, '-o', 'json', 'peer'] : ['-o', 'json', 'peer'];
    execFile(cliExe, args, { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      try {
        const list = JSON.parse(stdout);
        return resolve({ ok: true, list });
      } catch {
        return resolve({ ok: false });
      }
    });
  });
}

function queryPeers() {
  if (inFlightPeerQuery) return inFlightPeerQuery;
  inFlightPeerQuery = (async () => {
    try {
      if (engineMode === 'unconfigured') {
        lastGoodPeerState = null;
        return {
          ok: false,
          error: '待配置局域网密钥',
          peers: [],
          relays: [],
          local: null,
          engineMode,
          engineLastError
        };
      }
      const cliExe = getResourcePath('easytier', 'easytier-cli.exe');
      if (!fs.existsSync(cliExe)) {
        return { ok: false, error: '未找到 easytier-cli.exe', peers: [], relays: [], local: null, engineMode };
      }

      const portals = engineMode === 'builtin'
        ? ['127.0.0.1:25888', '127.0.0.1:15888']
        : ['127.0.0.1:15888', '127.0.0.1:25888'];

      let cliRes = await execCliPeer(cliExe, portals[0]);
      if (!cliRes.ok) {
        cliRes = await execCliPeer(cliExe, portals[1]);
      }

      if (!cliRes.ok) {
        consecutivePeerFailures += 1;
        if (lastGoodPeerState && consecutivePeerFailures < 3) {
          return { ...lastGoodPeerState, engineMode, engineLastError };
        }
        return {
          ok: false,
          error: '正在连接异地局域网...',
          peers: [],
          relays: [],
          local: null,
          engineMode,
          engineLastError
        };
      }

      consecutivePeerFailures = 0;
      const list = cliRes.list;
      let local = null;
      const peers = [];
      const relays = [];
      for (const item of list) {
        if (item.cost === 'Local') {
          local = item;
        } else if (item.ipv4 && item.ipv4.trim() !== '') {
          peers.push(item);
        } else {
          relays.push(item);
        }
      }
      const data = loadAppData();
      const token = getAuthToken(data.config);
      let dirty = false;
      for (const p of peers) {
        const key = p.hostname || p.ipv4;
        const existing = data.knownDevices[key];
        if (!existing || existing.ipv4 !== p.ipv4) {
          data.knownDevices[key] = {
            ...(existing || {}),
            hostname: p.hostname,
            ipv4: p.ipv4,
            lastSeen: Date.now()
          };
          dirty = true;
        } else {
          data.knownDevices[key].lastSeen = Date.now();
        }
        probePeerMacIfNeeded(p, data, token);
        checkPeerUpdate(p, token);
      }
      if (dirty) saveAppData(data);

      const state = {
        ok: true,
        local,
        peers,
        relays,
        knownDevices: data.knownDevices,
        engineMode,
        engineLastError
      };
      lastGoodPeerState = state;
      return state;
    } finally {
      inFlightPeerQuery = null;
    }
  })();
  return inFlightPeerQuery;
}

function findMoonlightExe() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Moonlight Game Streaming', 'Moonlight.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Moonlight Game Streaming', 'Moonlight.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Moonlight Game Streaming', 'Moonlight.exe')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  const iconPath = getAssetPath('icon.png');
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 920,
    minHeight: 600,
    frame: false,
    title: 'Erii 远程',
    icon: iconPath,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconImg = nativeImage.createFromPath(getAssetPath('icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(iconImg);
  tray.setToolTip('Erii 远程 - 异地局域网控制中心');
  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 Erii 远程', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '重新连接局域网', click: () => startEasyTierEngine(true) },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        isQuitting = true;
        if (easytierProc) {
          try { easytierProc.kill(); } catch {}
        }
        if (controlServer) {
          try { controlServer.close(); } catch {}
        }
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  createWindow();
  createTray();
  getShareDir();
  startControlServer();
  ensureFirewallRule();
  ensureRdpWddmPolicy();
  await startEasyTierEngine(false);
  // Run peer discovery & auto-update check independently in main process every 60s
  // so tray-minimized instances never get throttled by Chromium.
  setInterval(() => {
    queryPeers().catch(() => {});
  }, 60 * 1000);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (easytierProc) {
    try { easytierProc.kill(); } catch {}
  }
  if (controlServer) {
    try { controlServer.close(); } catch {}
  }
});

// IPC Handlers
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow && mainWindow.hide());

ipcMain.handle('get-peers', () => queryPeers());
ipcMain.handle('get-app-data', () => {
  const d = loadAppData();
  d.localMac = getLocalNetworkMeta().primaryMac;
  d.appVersion = app.getVersion();
  d.shareDir = getShareDir();
  return d;
});

ipcMain.handle('save-config', async (_e, newCfg) => {
  const data = loadAppData();
  data.config = { ...data.config, ...newCfg };
  saveAppData(data);
  const autoRes = await setWindowsAutoStart(Boolean(data.config.autoStart));
  const res = await startEasyTierEngine(true);
  return { ok: true, engine: res, autoStart: autoRes };
});

ipcMain.handle('save-meta', (_e, patch) => {
  const data = loadAppData();
  if (patch.aliases) data.aliases = patch.aliases;
  if (patch.favorites) data.favorites = patch.favorites;
  if (patch.quickLaunches) data.quickLaunches = patch.quickLaunches;
  if (patch.knownDevices) data.knownDevices = patch.knownDevices;
  saveAppData(data);
  return { ok: true };
});

// Ensure mstsc's Default.rdp enables dynamic resolution (remote resolution follows window resize)
function ensureRdpDynamicResolution() {
  try {
    const p = path.join(app.getPath('documents'), 'Default.rdp');
    const wanted = { 'dynamic resolution': 'i:1', 'smart sizing': 'i:0' };
    let text = '';
    const exists = fs.existsSync(p);
    if (exists) {
      const buf = fs.readFileSync(p);
      text = (buf[0] === 0xff && buf[1] === 0xfe)
        ? buf.slice(2).toString('utf16le')
        : buf.toString('utf8').replace(/^\uFEFF/, '');
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    let changed = !exists;
    for (const [k, v] of Object.entries(wanted)) {
      const line = `${k}:${v}`;
      const idx = lines.findIndex((l) => l.toLowerCase().startsWith(`${k}:`));
      if (idx >= 0) {
        if (lines[idx] !== line) { lines[idx] = line; changed = true; }
      } else {
        lines.push(line);
        changed = true;
      }
    }
    if (!changed) return;
    const out = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]);
    if (exists) {
      // Default.rdp is a hidden file; open with r+ to avoid EPERM on Windows
      const fd = fs.openSync(p, 'r+');
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, out, 0, out.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.writeFileSync(p, out);
    }
  } catch {}
}

function toEriiDomain(hostname) {
  const label = String(hostname || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return label ? `${label}.erii` : '';
}

let lastHostsSignature = '';
function syncHostsEntries(entries) {
  try {
    const valid = (entries || [])
      .map((e) => ({ ip: String(e.ip || '').trim(), domain: toEriiDomain(e.hostname) }))
      .filter((e) => e.ip && e.domain);
    if (!valid.length) return false;
    const sig = valid.map((e) => `${e.ip}=${e.domain}`).sort().join('|');
    if (sig === lastHostsSignature) return true;

    const hostsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    const raw = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf8') : '';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const domains = new Set(valid.map((e) => e.domain));
    const lines = raw.split(/\r?\n/).filter((line) => {
      const m = line.match(/#\s*EriiRemote:([^\s]+)/);
      if (m && domains.has(m[1])) return false;
      return true;
    });
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    for (const e of valid) {
      lines.push(`${e.ip} ${e.domain} # EriiRemote:${e.domain}`);
    }
    fs.writeFileSync(hostsPath, lines.join(eol) + eol, 'utf8');
    lastHostsSignature = sig;
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('connect-rdp', (_e, payload) => {
  const ip = typeof payload === 'string' ? payload : (payload && payload.ip);
  const hostname = typeof payload === 'object' && payload ? payload.hostname : '';
  if (!ip) return { ok: false, error: '无效 IP' };
  ensureRdpDynamicResolution();
  let target = ip;
  const domain = toEriiDomain(hostname);
  if (domain && syncHostsEntries([{ ip, hostname }])) {
    target = domain;
  }
  spawn('mstsc.exe', [`/v:${target}`], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, target };
});

ipcMain.handle('connect-moonlight', (_e, ip) => {
  const exe = findMoonlightExe();
  if (!exe) {
    return { ok: false, notFound: true, message: '本机未检测到 Moonlight 客户端' };
  }
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, ip };
});

ipcMain.handle('open-smb', (_e, ip) => {
  if (!ip) return { ok: false };
  spawn('explorer.exe', [`\\\\${ip}`], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

ipcMain.handle('open-url', (_e, url) => {
  if (url) shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('open-terminal', (_e, ip) => {
  if (!ip) return { ok: false };
  spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `title Erii远程终端 - ${ip} && ping -n 4 ${ip}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  }).unref();
  return { ok: true };
});

ipcMain.handle('ping-device', (_e, ip) => {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '2', '-w', '1500', ip], { windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      const m = out.match(/(\d+)\s*ms/i);
      resolve({ ok: !err, ms: m ? Number(m[1]) : null, raw: out });
    });
  });
});

ipcMain.handle('remote-power', async (_e, { ip, action }) => {
  const data = loadAppData();
  const token = getAuthToken(data.config);
  if (!token) return { ok: false, error: '请先配置局域网密钥' };
  const res = await httpJsonRequest(ip, 'POST', '/api/power', { action }, token, 4000);
  if (res.status === 200 && res.data && res.data.ok) {
    return { ok: true, message: res.data.message || '指令已执行' };
  }
  if (res.status === 403) {
    return { ok: false, error: res.data.error || '目标设备未开启远程电源控制' };
  }
  if (res.status === 401) {
    return { ok: false, error: '密钥校验失败，请确保两端局域网密钥一致' };
  }
  return { ok: false, error: '无法连接目标电源服务（请确认目标电脑运行着 Erii 远程 v1.1+ 且放行 17988 端口）' };
});

ipcMain.handle('wake-device', async (_e, { mac, onlinePeerIps }) => {
  const clean = normalizeMac(mac);
  if (!clean) return { ok: false, error: 'MAC 地址格式无效（示例：AA:BB:CC:DD:EE:FF）' };
  const data = loadAppData();
  const token = getAuthToken(data.config);

  // 1. Broadcast locally
  const localRes = await sendMagicPacketLocal(clean);

  // 2. Ask all currently online peers running EriiRemote to relay WOL on their physical LANs
  let relaySuccess = 0;
  const ips = Array.isArray(onlinePeerIps) ? onlinePeerIps : [];
  if (token && ips.length > 0) {
    const results = await Promise.all(
      ips.map((ip) => httpJsonRequest(ip, 'POST', '/api/wol', { mac: clean }, token, 2500))
    );
    relaySuccess = results.filter((r) => r.status === 200 && r.data && r.data.ok).length;
  }

  return {
    ok: localRes.ok || relaySuccess > 0,
    mac: clean,
    relaySuccess,
    message: relaySuccess > 0
      ? `已发送唤醒包至 ${clean}（本机 + ${relaySuccess} 台在线节点协同广播）`
      : `已在本机局域网发送唤醒包至 ${clean}`
  };
});

function uploadSingleFileToPeer(ip, token, filePath) {
  return new Promise((resolve) => {
    let st;
    try { st = fs.statSync(filePath); } catch { return resolve({ ok: false, error: '无法读取文件' }); }
    const fileName = path.basename(filePath);
    const req = http.request({
      hostname: ip,
      port: CONTROL_PORT,
      path: `/api/files/upload?name=${encodeURIComponent(fileName)}`,
      method: 'POST',
      headers: {
        'X-Erii-Token': token,
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}');
          resolve({ ok: res.statusCode === 200 && parsed.ok, name: fileName, error: parsed.error });
        } catch {
          resolve({ ok: res.statusCode === 200, name: fileName });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    let sent = 0;
    let lastPct = -1;
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => {
      sent += chunk.length;
      if (st.size > 0) {
        const pct = Math.floor((sent * 100) / st.size);
        if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
          lastPct = pct;
          notifyRenderer('file-transfer-progress', { direction: 'upload', name: fileName, percent: pct });
        }
      }
    });
    rs.on('error', (e) => { req.destroy(); resolve({ ok: false, error: String(e.message || e) }); });
    rs.pipe(req);
  });
}

function downloadSingleFileFromPeer(ip, token, fileName) {
  return new Promise((resolve) => {
    const dest = path.join(getShareDir(), path.basename(fileName));
    const tmp = `${dest}.part`;
    let settled = false;
    const finish = (resObj) => {
      if (settled) return;
      settled = true;
      if (!resObj.ok) { try { fs.rmSync(tmp, { force: true }); } catch {} }
      resolve(resObj);
    };
    const req = http.request({
      hostname: ip,
      port: CONTROL_PORT,
      path: `/api/files/download?name=${encodeURIComponent(fileName)}`,
      method: 'GET',
      headers: { 'X-Erii-Token': token }
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, error: '下载失败' }); }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const out = fs.createWriteStream(tmp);
      let got = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total > 0) {
          const pct = Math.floor((got * 100) / total);
          if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
            lastPct = pct;
            notifyRenderer('file-transfer-progress', { direction: 'download', name: fileName, percent: pct });
          }
        }
      });
      res.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
      out.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            finish({ ok: true, localPath: dest });
          } catch (e) {
            finish({ ok: false, error: String(e.message || e) });
          }
        });
      });
      res.pipe(out);
    });
    req.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
    req.end();
  });
}

ipcMain.handle('open-share-dir', () => {
  const dir = getShareDir();
  shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('reveal-file', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle('list-remote-files', async (_e, ip) => {
  const data = loadAppData();
  const token = getAuthToken(data.config);
  if (!token) return { ok: false, error: '请先配置局域网密钥' };
  const res = await httpJsonRequest(ip, 'GET', '/api/files', null, token, 4000);
  if (res.status === 200 && res.data && res.data.ok) {
    return { ok: true, files: res.data.files || [], shareDir: res.data.shareDir || '' };
  }
  return { ok: false, error: '无法连接对方文件服务（请确认对方已升级至 v1.3.0+）' };
});

ipcMain.handle('upload-files-to-peer', async (_e, { ip, filePaths }) => {
  const data = loadAppData();
  const token = getAuthToken(data.config);
  if (!token) return { ok: false, error: '请先配置局域网密钥' };

  let targets = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (targets.length === 0) {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择要发送到对方共享文件夹的文件',
      properties: ['openFile', 'multiSelections']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    targets = picked.filePaths;
  }

  let successCount = 0;
  for (const fp of targets) {
    const r = await uploadSingleFileToPeer(ip, token, fp);
    if (r.ok) successCount += 1;
  }
  return { ok: successCount > 0, count: successCount, total: targets.length };
});

ipcMain.handle('download-file-from-peer', async (_e, { ip, name }) => {
  const data = loadAppData();
  const token = getAuthToken(data.config);
  if (!token) return { ok: false, error: '请先配置局域网密钥' };
  return downloadSingleFileFromPeer(ip, token, name);
});

ipcMain.handle('delete-remote-file', async (_e, { ip, name }) => {
  const data = loadAppData();
  const token = getAuthToken(data.config);
  if (!token) return { ok: false, error: '请先配置局域网密钥' };
  const res = await httpJsonRequest(ip, 'POST', '/api/files/delete', { name }, token, 3500);
  return { ok: res.status === 200 && res.data && res.data.ok };
});

ipcMain.handle('check-lan-update', async () => {
  const data = loadAppData();
  const token = getAuthToken(data.config);
  if (!token) return { ok: false, error: '请先配置局域网密钥' };
  const q = await queryPeers();
  const peers = (q && q.peers) || [];
  for (const p of peers) {
    const started = await checkPeerUpdate(p, token, true);
    if (started) return { ok: true, updating: true };
  }
  return { ok: true, updating: false, message: '当前已是局域网内最新版本' };
});

ipcMain.handle('restart-engine', () => startEasyTierEngine(true));
