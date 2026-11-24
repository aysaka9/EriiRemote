const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

let mainWindow = null;
let tray = null;
let easytierProc = null;
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
      nas_https_port: 5667
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
      autoStart: false
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
        let dirty = false;
        for (const p of peers) {
          const key = p.hostname || p.ipv4;
          const existing = data.knownDevices[key];
          if (!existing || existing.ipv4 !== p.ipv4) {
            data.knownDevices[key] = {
              hostname: p.hostname,
              ipv4: p.ipv4,
              lastSeen: Date.now()
            };
            dirty = true;
          } else {
            data.knownDevices[key].lastSeen = Date.now();
          }
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
  await startEasyTierEngine(false);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (easytierProc) {
    try { easytierProc.kill(); } catch {}
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
ipcMain.handle('get-app-data', () => loadAppData());

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

ipcMain.handle('connect-rdp', (_e, ip) => {
  if (!ip) return { ok: false, error: '无效 IP' };
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

ipcMain.handle('restart-engine', () => startEasyTierEngine(true));
