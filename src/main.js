const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage } = require('electron');
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

    if (req.method === 'GET' && req.url === '/api/info') {
      const meta = getLocalNetworkMeta();
      return sendJson(200, {
        ok: true,
        hostname: data.config.hostname || os.hostname(),
        mac: meta.primaryMac,
        macs: meta.macs,
        allow_remote_power: data.config.allow_remote_power !== false
      });
    }

    if (req.method === 'POST' && (req.url === '/api/power' || req.url === '/api/wol')) {
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

function checkExternalEasyTier() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq easytier-core.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).toLowerCase().includes('easytier-core.exe'));
    });
  });
}

async function startEasyTierEngine(forceRestart = false) {
  const data = loadAppData();
  const cfg = data.config;

  if (forceRestart && easytierProc) {
    try { easytierProc.kill(); } catch {}
    easytierProc = null;
    await new Promise((r) => setTimeout(r, 800));
  }

  if (!easytierProc) {
    const externalRunning = await checkExternalEasyTier();
    if (externalRunning) {
      engineMode = 'external';
      engineLastError = '';
      return { ok: true, mode: 'external' };
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
    easytierProc = spawn(coreExe, args, {
      cwd: path.dirname(coreExe),
      windowsHide: true
    });
    engineMode = 'builtin';

    easytierProc.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf-8').trim();
      if (msg) engineLastError = msg.slice(-300);
    });
    easytierProc.on('exit', (code) => {
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

function queryPeers() {
  return new Promise((resolve) => {
    if (engineMode === 'unconfigured') {
      return resolve({
        ok: false,
        error: '待配置局域网密钥',
        peers: [],
        relays: [],
        local: null,
        engineMode,
        engineLastError
      });
    }
    const cliExe = getResourcePath('easytier', 'easytier-cli.exe');
    if (!fs.existsSync(cliExe)) {
      return resolve({ ok: false, error: '未找到 easytier-cli.exe', peers: [], relays: [], local: null, engineMode });
    }
    execFile(cliExe, ['-o', 'json', 'peer'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) {
        return resolve({
          ok: false,
          error: '正在连接异地局域网...',
          peers: [],
          relays: [],
          local: null,
          engineMode,
          engineLastError
        });
      }
      try {
        const list = JSON.parse(stdout);
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
        }
        if (dirty) saveAppData(data);

        resolve({
          ok: true,
          local,
          peers,
          relays,
          knownDevices: data.knownDevices,
          engineMode,
          engineLastError
        });
      } catch {
        resolve({ ok: false, error: '解析节点信息失败', peers: [], relays: [], local: null, engineMode });
      }
    });
  });
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
      nodeIntegration: false
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
  startControlServer();
  await startEasyTierEngine(false);
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
  return d;
});

ipcMain.handle('save-config', async (_e, newCfg) => {
  const data = loadAppData();
  data.config = { ...data.config, ...newCfg };
  saveAppData(data);
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(data.config.autoStart) });
  } catch {}
  const res = await startEasyTierEngine(true);
  return { ok: true, engine: res };
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

ipcMain.handle('connect-rdp', (_e, ip) => {
  if (!ip) return { ok: false, error: '无效 IP' };
  ensureRdpDynamicResolution();
  spawn('mstsc.exe', [`/v:${ip}`], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
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

ipcMain.handle('restart-engine', () => startEasyTierEngine(true));
