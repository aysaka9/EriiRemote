let appData = { config: {}, aliases: {}, favorites: [], knownDevices: {}, quickLaunches: {} };
let peerState = { ok: false, local: null, peers: [], relays: [], engineMode: 'stopped' };
let activeView = 'device'; // 'device' | 'all' | 'direct' | 'favorites' | 'settings'
let selectedKey = null;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._t);
  window._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function randomString(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getNasPorts() {
  const cfg = appData.config || {};
  return {
    http: Number(cfg.nas_http_port) || 5666,
    https: Number(cfg.nas_https_port) || 5667
  };
}

function isNasDevice(dev) {
  const name = (dev.hostname || '').toLowerCase();
  return name.includes('nas') || name.includes('fnos') || name.includes('synology') || name.includes('unraid');
}

function getAllDeviceModels() {
  const map = new Map();
  for (const p of (peerState.peers || [])) {
    const key = p.hostname || p.ipv4;
    const known = (appData.knownDevices && appData.knownDevices[key]) || {};
    map.set(key, {
      key,
      hostname: p.hostname || p.ipv4,
      displayName: appData.aliases[key] || p.hostname || p.ipv4,
      ipv4: p.ipv4,
      mac: known.mac || '',
      online: true,
      cost: p.cost || 'p2p',
      lat: p.lat_ms && p.lat_ms !== '-' ? `${Number(p.lat_ms).toFixed(0)}ms` : '',
      nat: p.nat_type || '-',
      tunnel: p.tunnel_proto || '-',
      rx: p.rx_bytes || '0 B',
      tx: p.tx_bytes || '0 B',
      isNas: isNasDevice(p)
    });
  }
  for (const [key, info] of Object.entries(appData.knownDevices || {})) {
    if (!map.has(key)) {
      map.set(key, {
        key,
        hostname: info.hostname || key,
        displayName: appData.aliases[key] || info.hostname || key,
        ipv4: info.ipv4 || '',
        mac: info.mac || '',
        online: false,
        cost: 'offline',
        lat: '',
        nat: '-',
        tunnel: '-',
        rx: '-',
        tx: '-',
        isNas: isNasDevice(info)
      });
    }
  }
  const list = Array.from(map.values());
  list.sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
  return list;
}

function renderSidebar() {
  const devices = getAllDeviceModels();
  const onlineList = devices.filter((d) => d.online);
  document.getElementById('onlineCount').textContent = String(onlineList.length);

  const dot = document.getElementById('engineDot');
  const txt = document.getElementById('localIpText');
  if (peerState.ok && peerState.local && peerState.local.ipv4) {
    dot.className = 'status-dot online';
    txt.textContent = `本机 ${peerState.local.ipv4}`;
  } else if (peerState.engineMode === 'unconfigured') {
    dot.className = 'status-dot offline';
    txt.textContent = '点击设置配置局域网';
  } else {
    dot.className = 'status-dot connecting';
    txt.textContent = peerState.error || '正在接入局域网...';
  }

  if (!selectedKey && devices.length > 0) {
    selectedKey = devices[0].key;
  }

  const container = document.getElementById('sidebarDevices');
  if (devices.length === 0) {
    container.innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text-muted);">暂未发现其他在线设备</div>`;
  } else {
    container.innerHTML = devices.map((d) => {
      const isActive = activeView === 'device' && selectedKey === d.key;
      const iconSvg = d.isNas
        ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1" fill="currentColor"/><circle cx="7" cy="17" r="1" fill="currentColor"/></svg>`
        : `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 5.5L10.5 4.4V11.3H3V5.5ZM11.5 4.2L21 2.8V11.3H11.5V4.2ZM3 12.3H10.5V19.2L3 18.1V12.3ZM11.5 12.3H21V20.8L11.5 19.4V12.3Z"/></svg>`;
      return `
        <button class="nav-item ${isActive ? 'active' : ''}" data-dev="${escapeHtml(d.key)}">
          <span class="dev-dot ${d.online ? 'on' : 'off'}"></span>
          <span class="dev-badge-icon ${d.online ? (d.isNas ? 'nas' : '') : 'offline'}">${iconSvg}</span>
          <div class="dev-name-wrap">
            <div class="dev-name ${d.online ? '' : 'offline'}">${escapeHtml(d.displayName)}</div>
          </div>
          ${d.online && d.lat ? `<span class="dev-lat">${escapeHtml(d.lat)}</span>` : ''}
        </button>`;
    }).join('');
    container.querySelectorAll('[data-dev]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedKey = btn.dataset.dev;
        activeView = 'device';
        renderAll();
      });
    });
  }

  ['navAllDevices', 'navDirect', 'navFavorites', 'navSettings'].forEach((id) => {
    document.getElementById(id).classList.remove('active');
  });
  if (activeView === 'all') document.getElementById('navAllDevices').classList.add('active');
  if (activeView === 'direct') document.getElementById('navDirect').classList.add('active');
  if (activeView === 'favorites') document.getElementById('navFavorites').classList.add('active');
  if (activeView === 'settings') document.getElementById('navSettings').classList.add('active');
}

function renderDeviceDetail() {
  const panel = document.getElementById('mainPanel');
  const devices = getAllDeviceModels();
  const dev = devices.find((d) => d.key === selectedKey) || devices[0];
  const nasPorts = getNasPorts();

  if (!dev) {
    const needSetup = peerState.engineMode === 'unconfigured';
    panel.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--text-sub);">
        <div style="font-size:19px;font-weight:700;color:var(--text-main);margin-bottom:8px;">
          ${needSetup ? '欢迎使用 Erii 远程！请先配置你的私有局域网' : '正在等待其他设备上线'}
        </div>
        <div style="font-size:13px;max-width:440px;line-height:1.7;">
          ${needSetup
            ? '这是开源纯净版，未内置任何私有密钥。请点击下方按钮前往「设置」，一键随机生成或填入你自己的局域网名称与密钥，多台设备填写相同凭证即可自动组建加密局域网。'
            : `本机已接入异地局域网 <b>${escapeHtml(appData.config.network_name || '')}</b>。<br/>在其他电脑上安装本程序（或 EasyTier）并填入相同局域网凭证后，设备会自动出现在左侧列表。`}
        </div>
        <div style="margin-top:18px;display:flex;gap:10px;">
          ${needSetup
            ? `<button class="btn-primary" id="goSetupBtn">立即前往设置</button>`
            : `<button class="btn-primary" onclick="refreshPeers(true)">立即刷新</button>`}
        </div>
      </div>`;
    const goBtn = document.getElementById('goSetupBtn');
    if (goBtn) goBtn.addEventListener('click', () => { activeView = 'settings'; renderAll(); });
    return;
  }

  const isFav = (appData.favorites || []).includes(dev.key);
  const isP2p = dev.cost === 'p2p';
  const quickItems = (appData.quickLaunches && appData.quickLaunches[dev.key]) || [];

  const ctaText = dev.online
    ? (dev.isNas ? '打开 NAS 管理后台 →' : '进入桌面 →')
    : (dev.mac ? '⚡ 远程开机 (WOL)' : '⚡ 绑定 MAC 并远程开机');
  const subText = dev.online
    ? (dev.isNas ? `高速直连 · http://${dev.ipv4}:${nasPorts.http}` : `Windows RDP 极清远程桌面 · ${dev.ipv4}`)
    : (dev.mac ? `已记录 MAC：${dev.mac} · 支持局域网及跨网协同唤醒` : `上次记录 IP：${dev.ipv4 || '未知'} · 点击设置 MAC 地址以启用远程开机`);

  panel.innerHTML = `
    <div class="dev-top-bar">
      <div class="dev-title-group">
        <span class="online-pill ${dev.online ? '' : 'offline'}">
          <span class="dot"></span>${dev.online ? '在线' : '离线'}
        </span>
        <h1 class="dev-main-title">${escapeHtml(dev.displayName)}</h1>
        ${dev.ipv4 ? `<button class="ip-chip" id="copyDevIp" title="点击复制 IP">${escapeHtml(dev.ipv4)}</button>` : ''}
        ${dev.online ? `<span class="meta-pill ${isP2p ? '' : 'relay'}">${isP2p ? 'P2P 直连' : escapeHtml(dev.cost)} ${dev.lat ? '· ' + escapeHtml(dev.lat) : ''}</span>` : ''}
      </div>
      <div class="top-actions">
        <button class="subtle-btn" id="btnPower">⏻ 电源管理</button>
        <button class="subtle-btn ${isFav ? 'starred' : ''}" id="btnFav">${isFav ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="subtle-btn" id="btnRename">✎ 备注名</button>
      </div>
    </div>

    <div class="hero-wrapper">
      <div class="hero-banner ${dev.online ? '' : 'offline'} ${dev.isNas ? 'nas-theme' : ''}" id="heroConnect">
        <div class="hero-orb"></div>
        <div class="hero-ring"></div>
        <div class="hero-cta">${ctaText}</div>
        <div class="hero-sub">${subText}</div>
      </div>
      <div class="hero-toolbar">
        <button class="tool-btn" id="toolFiles">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          文件传输
        </button>
        <button class="tool-btn" id="toolMoonlight">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/>
          </svg>
          游戏串流 (Moonlight)
        </button>
        <button class="tool-btn" id="toolTerminal">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          终端 / 测速
        </button>
        <button class="tool-btn" id="toolCompanion">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          ${dev.isNas ? `HTTPS ${nasPorts.https}` : '网页 / 伴侣'}
        </button>
      </div>
    </div>

    <div class="section-title">
      <span>快速启动</span>
      <span style="font-size:12px;color:var(--text-muted);font-weight:400;">NAT: ${escapeHtml(dev.nat)} · 协议: ${escapeHtml(dev.tunnel)} · 收/发: ${escapeHtml(dev.rx)} / ${escapeHtml(dev.tx)}</span>
    </div>
    <div class="quick-box ${quickItems.length === 0 ? 'empty' : ''}">
      ${quickItems.map((q, idx) => `
        <div class="quick-item" data-qidx="${idx}">
          <button class="quick-del" data-qdel="${idx}" title="删除">×</button>
          <div class="quick-item-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </div>
          <div class="quick-item-name">${escapeHtml(q.name)}</div>
          <div class="quick-item-sub">${escapeHtml(q.type === 'smb' ? '共享目录' : q.type === 'rdp' ? '远程桌面' : '网页入口')}</div>
        </div>
      `).join('')}
      <button class="add-quick-btn" id="btnAddQuick">
        <div class="add-quick-circle">+</div>
        <span style="font-size:13px;">添加</span>
      </button>
    </div>
  `;

  const copyBtn = document.getElementById('copyDevIp');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(dev.ipv4);
      toast(`已复制 IP：${dev.ipv4}`);
    });
  }

  async function triggerWake(macAddr) {
    const onlineIps = (peerState.peers || []).map((p) => p.ipv4).filter(Boolean);
    const res = await window.eriiApi.wakeDevice(macAddr, onlineIps);
    if (res.ok) toast(res.message);
    else toast(res.error || '发送唤醒包失败');
  }

  function openPowerModal() {
    showModal(`
      <h3 class="modal-title">远程电源管理 · ${escapeHtml(dev.displayName)}</h3>
      <div class="power-grid">
        ${dev.online ? `
          <button class="power-btn" data-pact="lock">🔒 锁定屏幕</button>
          <button class="power-btn" data-pact="sleep">🌙 远程睡眠</button>
          <button class="power-btn" data-pact="reboot">🔄 远程重启 (5秒)</button>
          <button class="power-btn danger" data-pact="shutdown">⏻ 远程关机 (5秒)</button>
          <button class="power-btn" data-pact="cancel" style="grid-column:1/-1;">↩ 取消计划关机/重启</button>
        ` : `
          <button class="power-btn wake" id="modalWakeBtn">⚡ 发送远程开机魔术包 (Wake-on-LAN)</button>
        `}
      </div>
      <div class="form-row" style="margin-bottom:6px;">
        <label>设备物理网卡 MAC 地址（用于离线远程开机）</label>
        <div style="display:flex;gap:8px;">
          <input class="input" id="macInput" value="${escapeHtml(dev.mac || '')}" placeholder="例如 AA:BB:CC:DD:EE:FF" />
          <button class="btn-sec" id="saveMacBtn" style="white-space:nowrap;">保存 MAC</button>
        </div>
        <div class="hint">两台电脑均运行 Erii 远程时会自动同步 MAC；远程开机需目标主板 BIOS 开启 Wake-on-LAN。</div>
      </div>
      <div class="modal-actions">
        <button class="btn-sec" onclick="closeModal()">关闭</button>
      </div>
    `);

    document.querySelectorAll('[data-pact]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.pact;
        if ((act === 'shutdown' || act === 'reboot') && !confirm(`确定要对 ${dev.displayName} 执行「${act === 'shutdown' ? '远程关机' : '远程重启'}」吗？`)) {
          return;
        }
        const res = await window.eriiApi.remotePower(dev.ipv4, act);
        if (res.ok) {
          toast(res.message);
          closeModal();
        } else {
          toast(res.error || '指令执行失败');
        }
      });
    });

    const wakeBtn = document.getElementById('modalWakeBtn');
    if (wakeBtn) {
      wakeBtn.addEventListener('click', async () => {
        const macVal = document.getElementById('macInput').value.trim();
        if (!macVal) return toast('请先在下方输入该设备的物理网卡 MAC 地址');
        if (!appData.knownDevices[dev.key]) appData.knownDevices[dev.key] = { hostname: dev.hostname, ipv4: dev.ipv4 };
        appData.knownDevices[dev.key].mac = macVal;
        await window.eriiApi.saveMeta({ knownDevices: appData.knownDevices });
        await triggerWake(macVal);
        closeModal();
        renderAll();
      });
    }

    document.getElementById('saveMacBtn').addEventListener('click', async () => {
      const macVal = document.getElementById('macInput').value.trim();
      if (!appData.knownDevices[dev.key]) appData.knownDevices[dev.key] = { hostname: dev.hostname, ipv4: dev.ipv4 };
      appData.knownDevices[dev.key].mac = macVal;
      await window.eriiApi.saveMeta({ knownDevices: appData.knownDevices });
      toast('MAC 地址已保存');
      renderAll();
    });
  }

  document.getElementById('btnPower').addEventListener('click', openPowerModal);

  document.getElementById('heroConnect').addEventListener('click', async () => {
    if (!dev.online) {
      if (dev.mac) {
        await triggerWake(dev.mac);
      } else {
        openPowerModal();
      }
      return;
    }
    if (dev.isNas) {
      await window.eriiApi.openUrl(`http://${dev.ipv4}:${nasPorts.http}`);
      toast('正在打开 NAS 后台...');
    } else {
      await window.eriiApi.connectRdp(dev.ipv4);
      toast(`正在通过 RDP 连接 ${dev.displayName}...`);
    }
  });

  document.getElementById('toolFiles').addEventListener('click', async () => {
    if (!dev.online) return toast('设备离线');
    await window.eriiApi.openSmb(dev.ipv4);
    toast(`正在打开 \\\\${dev.ipv4} 共享文件...`);
  });

  document.getElementById('toolMoonlight').addEventListener('click', async () => {
    if (!dev.online) return toast('设备离线');
    const res = await window.eriiApi.connectMoonlight(dev.ipv4);
    if (!res.ok && res.notFound) {
      showModal(`
        <h3 class="modal-title">未检测到 Moonlight 客户端</h3>
        <div style="font-size:13px;color:var(--text-sub);line-height:1.6;">
          高帧率打游戏需要本机安装开源的 Moonlight 客户端。安装后在 Moonlight 里添加主机 <b>${escapeHtml(dev.ipv4)}</b> 即可一键串流。
        </div>
        <div class="modal-actions">
          <button class="btn-sec" onclick="closeModal()">取消</button>
          <button class="btn-primary" id="dlMoonlight">前往下载 Moonlight</button>
        </div>
      `);
      document.getElementById('dlMoonlight').addEventListener('click', () => {
        window.eriiApi.openUrl('https://github.com/moonlight-stream/moonlight-qt/releases/latest');
        closeModal();
      });
    } else {
      navigator.clipboard.writeText(dev.ipv4);
      toast(`已启动 Moonlight（主机 IP ${dev.ipv4} 已复制到剪贴板）`);
    }
  });

  document.getElementById('toolTerminal').addEventListener('click', () => {
    if (!dev.online) return toast('设备离线');
    window.eriiApi.openTerminal(dev.ipv4);
  });

  document.getElementById('toolCompanion').addEventListener('click', () => {
    if (!dev.online) return toast('设备离线');
    const url = dev.isNas ? `https://${dev.ipv4}:${nasPorts.https}` : `http://${dev.ipv4}:8088`;
    window.eriiApi.openUrl(url);
    toast(`正在打开 ${url}`);
  });

  document.getElementById('btnFav').addEventListener('click', async () => {
    const favs = new Set(appData.favorites || []);
    if (favs.has(dev.key)) favs.delete(dev.key); else favs.add(dev.key);
    appData.favorites = Array.from(favs);
    await window.eriiApi.saveMeta({ favorites: appData.favorites });
    renderAll();
  });

  document.getElementById('btnRename').addEventListener('click', () => {
    showModal(`
      <h3 class="modal-title">修改设备备注名</h3>
      <div class="form-row">
        <label>原始主机名：${escapeHtml(dev.hostname)}</label>
        <input class="input" id="aliasInput" value="${escapeHtml(dev.displayName)}" placeholder="例如：家里主力机 / 飞牛NAS" />
      </div>
      <div class="modal-actions">
        <button class="btn-sec" onclick="closeModal()">取消</button>
        <button class="btn-primary" id="saveAliasBtn">保存</button>
      </div>
    `);
    document.getElementById('saveAliasBtn').addEventListener('click', async () => {
      const val = document.getElementById('aliasInput').value.trim();
      if (val) appData.aliases[dev.key] = val;
      else delete appData.aliases[dev.key];
      await window.eriiApi.saveMeta({ aliases: appData.aliases });
      closeModal();
      renderAll();
      toast('备注名已更新');
    });
  });

  document.getElementById('btnAddQuick').addEventListener('click', () => {
    showModal(`
      <h3 class="modal-title">添加快速启动项</h3>
      <div class="form-row">
        <label>名称</label>
        <input class="input" id="qName" placeholder="例如：Apollo后台 / 共享盘 / NAS后台" />
      </div>
      <div class="form-row">
        <label>类型</label>
        <select class="select" id="qType">
          <option value="url">打开网页地址 (URL)</option>
          <option value="smb">打开 Windows 共享文件夹 (SMB)</option>
          <option value="rdp">Windows 远程桌面 (RDP)</option>
        </select>
      </div>
      <div class="form-row" id="qTargetRow">
        <label>地址 / 端口</label>
        <input class="input" id="qTarget" value="http://${escapeHtml(dev.ipv4)}:8088" placeholder="例如 https://${escapeHtml(dev.ipv4)}:47990" />
      </div>
      <div class="modal-actions">
        <button class="btn-sec" onclick="closeModal()">取消</button>
        <button class="btn-primary" id="saveQuickBtn">添加</button>
      </div>
    `);
    document.getElementById('saveQuickBtn').addEventListener('click', async () => {
      const name = document.getElementById('qName').value.trim();
      const type = document.getElementById('qType').value;
      const target = document.getElementById('qTarget').value.trim();
      if (!name) return toast('请输入名称');
      if (!appData.quickLaunches[dev.key]) appData.quickLaunches[dev.key] = [];
      appData.quickLaunches[dev.key].push({ name, type, target });
      await window.eriiApi.saveMeta({ quickLaunches: appData.quickLaunches });
      closeModal();
      renderDeviceDetail();
      toast('已添加快速启动项');
    });
  });

  panel.querySelectorAll('[data-qidx]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.dataset.qdel !== undefined) return;
      const item = quickItems[Number(card.dataset.qidx)];
      if (!item) return;
      if (item.type === 'rdp') window.eriiApi.connectRdp(dev.ipv4);
      else if (item.type === 'smb') window.eriiApi.openSmb(dev.ipv4);
      else window.eriiApi.openUrl(item.target);
    });
  });

  panel.querySelectorAll('[data-qdel]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.qdel);
      appData.quickLaunches[dev.key].splice(idx, 1);
      await window.eriiApi.saveMeta({ quickLaunches: appData.quickLaunches });
      renderDeviceDetail();
    });
  });
}

function renderDevicesGrid(onlyFavorites = false) {
  const panel = document.getElementById('mainPanel');
  let list = getAllDeviceModels();
  if (onlyFavorites) {
    const favs = new Set(appData.favorites || []);
    list = list.filter((d) => favs.has(d.key));
  }
  panel.innerHTML = `
    <div class="dev-top-bar">
      <h1 class="dev-main-title">${onlyFavorites ? '收藏设备' : '全部设备'}</h1>
      <button class="subtle-btn" onclick="refreshPeers(true)">刷新状态</button>
    </div>
    ${list.length === 0 ? `<div style="color:var(--text-muted);padding:40px 0;text-align:center;">暂无设备</div>` : `
    <div class="devices-grid">
      ${list.map((d) => `
        <div class="dev-card" data-open="${escapeHtml(d.key)}">
          <div class="dev-card-head">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="dev-badge-icon ${d.online ? (d.isNas ? 'nas' : '') : 'offline'}">${d.isNas ? 'N' : 'W'}</span>
              <strong>${escapeHtml(d.displayName)}</strong>
            </div>
            <span class="online-pill ${d.online ? '' : 'offline'}" style="padding:2px 8px;font-size:11px;">
              <span class="dot"></span>${d.online ? '在线' : '离线'}
            </span>
          </div>
          <div class="dev-card-kv"><span>虚拟 IP</span><code>${escapeHtml(d.ipv4 || '-')}</code></div>
          <div class="dev-card-kv"><span>连接方式</span><span>${d.online ? `${escapeHtml(d.cost)} ${escapeHtml(d.lat)}` : '离线'}</span></div>
          <div class="dev-card-kv"><span>NAT 类型</span><span>${escapeHtml(d.nat)}</span></div>
        </div>
      `).join('')}
    </div>`}
  `;
  panel.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      selectedKey = el.dataset.open;
      activeView = 'device';
      renderAll();
    });
  });
}

function renderDirectConnect() {
  const panel = document.getElementById('mainPanel');
  const nasPorts = getNasPorts();
  panel.innerHTML = `
    <div class="dev-top-bar"><h1 class="dev-main-title">IP 快速直连</h1></div>
    <div class="form-card">
      <div class="form-row">
        <label>目标设备虚拟 IP 或局域网 IP</label>
        <input class="input" id="directIp" placeholder="例如 10.126.126.10" />
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn-primary" id="directRdp">进入远程桌面 (RDP)</button>
        <button class="btn-sec" id="directSmb">打开共享文件 (SMB)</button>
        <button class="btn-sec" id="directWeb">打开 NAS HTTP (${nasPorts.http})</button>
        <button class="btn-sec" id="directWebHttps">打开 NAS HTTPS (${nasPorts.https})</button>
      </div>
    </div>
  `;
  const getIp = () => document.getElementById('directIp').value.trim();
  document.getElementById('directRdp').addEventListener('click', () => {
    const ip = getIp(); if (!ip) return toast('请输入 IP');
    window.eriiApi.connectRdp(ip);
  });
  document.getElementById('directSmb').addEventListener('click', () => {
    const ip = getIp(); if (!ip) return toast('请输入 IP');
    window.eriiApi.openSmb(ip);
  });
  document.getElementById('directWeb').addEventListener('click', () => {
    const ip = getIp(); if (!ip) return toast('请输入 IP');
    window.eriiApi.openUrl(`http://${ip}:${nasPorts.http}`);
  });
  document.getElementById('directWebHttps').addEventListener('click', () => {
    const ip = getIp(); if (!ip) return toast('请输入 IP');
    window.eriiApi.openUrl(`https://${ip}:${nasPorts.https}`);
  });
}

function renderSettings() {
  const panel = document.getElementById('mainPanel');
  const cfg = appData.config || {};
  const nasPorts = getNasPorts();
  const peersText = (cfg.public_peers || []).join('\n');
  const modeLabel = peerState.engineMode === 'external'
    ? '已接管系统后台 EasyTier 服务'
    : peerState.engineMode === 'builtin'
      ? '内置 EasyTier 引擎运行中'
      : peerState.engineMode === 'unconfigured'
        ? '待配置局域网凭证'
        : '引擎未启动';

  panel.innerHTML = `
    <div class="dev-top-bar">
      <h1 class="dev-main-title">软件与局域网设置</h1>
      <span class="meta-pill">${modeLabel}</span>
    </div>
    <div class="form-card">
      <div class="form-row">
        <label>本机在局域网中的显示名称 (Hostname)</label>
        <input class="input" id="cfgHost" value="${escapeHtml(cfg.hostname || '')}" />
      </div>
      <div class="form-row">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <label style="margin:0;">私有局域网名称 (Network Name)</label>
          <button class="subtle-btn" id="btnGenRand" style="height:26px;font-size:11px;">🎲 随机生成网络名与密钥</button>
        </div>
        <input class="input" id="cfgNet" value="${escapeHtml(cfg.network_name || '')}" placeholder="例如 my-private-lan（多台设备需填一致）" />
      </div>
      <div class="form-row">
        <label>私有局域网密钥 (Network Secret)</label>
        <input class="input" type="text" id="cfgSecret" value="${escapeHtml(cfg.network_secret || '')}" placeholder="建议 12~20 位高强度随机密码" />
      </div>
      <div class="form-row">
        <label>静态虚拟 IP（留空则自动 DHCP 分配，推荐留空防冲突）</label>
        <input class="input" id="cfgStaticIp" value="${escapeHtml(cfg.use_dhcp ? '' : (cfg.static_ip || ''))}" placeholder="留空表示自动 DHCP，或填如 10.126.126.10" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>NAS 默认 HTTP 端口</label>
          <input class="input" type="number" id="cfgNasHttp" value="${nasPorts.http}" />
        </div>
        <div class="form-row">
          <label>NAS 默认 HTTPS 端口</label>
          <input class="input" type="number" id="cfgNasHttps" value="${nasPorts.https}" />
        </div>
      </div>
      <div class="form-row">
        <label>握手节点列表（每行一个，可添加自己的私有节点或社区公共节点）</label>
        <textarea class="textarea" id="cfgPeers">${escapeHtml(peersText)}</textarea>
      </div>
      <div class="form-row switch-row">
        <div>
          <label style="margin:0;">允许被同局域网设备远程开关机 / 重启 / 锁屏</label>
          <div class="hint">本机物理网卡 MAC：<code>${escapeHtml(appData.localMac || '未检测到')}</code></div>
        </div>
        <input type="checkbox" id="cfgAllowPower" ${cfg.allow_remote_power !== false ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;" />
      </div>
      <div class="form-row switch-row">
        <label style="margin:0;">开机自动启动 Erii 远程</label>
        <input type="checkbox" id="cfgAutoStart" ${cfg.autoStart ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;" />
      </div>
      <div style="display:flex;gap:10px;margin-top:18px;">
        <button class="btn-primary" id="btnSaveCfg">保存并连接</button>
        <button class="btn-sec" id="btnRestartEngine">重启组网引擎</button>
      </div>
    </div>
  `;

  document.getElementById('btnGenRand').addEventListener('click', () => {
    document.getElementById('cfgNet').value = 'erii-lan-' + randomString(6).toLowerCase();
    document.getElementById('cfgSecret').value = randomString(16);
    toast('已生成高强度随机网络名与密钥，请点击保存');
  });

  document.getElementById('btnSaveCfg').addEventListener('click', async () => {
    const netName = document.getElementById('cfgNet').value.trim();
    const netSecret = document.getElementById('cfgSecret').value.trim();
    if (!netName || !netSecret) {
      return toast('请先填写局域网名称和密钥（或点击右上角随机生成）');
    }
    const staticIp = document.getElementById('cfgStaticIp').value.trim();
    const newCfg = {
      hostname: document.getElementById('cfgHost').value.trim(),
      network_name: netName,
      network_secret: netSecret,
      use_dhcp: staticIp === '',
      static_ip: staticIp,
      nas_http_port: Number(document.getElementById('cfgNasHttp').value) || 5666,
      nas_https_port: Number(document.getElementById('cfgNasHttps').value) || 5667,
      public_peers: document.getElementById('cfgPeers').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      allow_remote_power: document.getElementById('cfgAllowPower').checked,
      autoStart: document.getElementById('cfgAutoStart').checked
    };
    await window.eriiApi.saveConfig(newCfg);
    appData = await window.eriiApi.getAppData();
    toast('设置已保存，正在连接异地局域网...');
    setTimeout(() => refreshPeers(false), 1800);
  });

  document.getElementById('btnRestartEngine').addEventListener('click', async () => {
    await window.eriiApi.restartEngine();
    toast('已触发引擎重连');
    setTimeout(() => refreshPeers(false), 1800);
  });
}

function showModal(html) {
  document.getElementById('modalCard').innerHTML = html;
  document.getElementById('modalMask').classList.add('show');
}
function closeModal() {
  document.getElementById('modalMask').classList.remove('show');
}
window.closeModal = closeModal;

function renderAll() {
  renderSidebar();
  if (activeView === 'device') renderDeviceDetail();
  else if (activeView === 'all') renderDevicesGrid(false);
  else if (activeView === 'favorites') renderDevicesGrid(true);
  else if (activeView === 'direct') renderDirectConnect();
  else if (activeView === 'settings') renderSettings();
}

async function refreshPeers(showMsg = false) {
  peerState = await window.eriiApi.getPeers();
  if (peerState.knownDevices) appData.knownDevices = peerState.knownDevices;
  renderAll();
  if (showMsg) toast('已刷新在线设备状态');
}
window.refreshPeers = refreshPeers;

(async function init() {
  document.getElementById('btnMin').addEventListener('click', () => window.eriiApi.minimize());
  document.getElementById('btnMax').addEventListener('click', () => window.eriiApi.maximize());
  document.getElementById('btnClose').addEventListener('click', () => window.eriiApi.close());
  document.getElementById('btnRefresh').addEventListener('click', () => refreshPeers(true));
  document.getElementById('localIpPill').addEventListener('click', () => {
    if (peerState.engineMode === 'unconfigured') {
      activeView = 'settings';
      renderAll();
      return;
    }
    if (peerState.local && peerState.local.ipv4) {
      navigator.clipboard.writeText(peerState.local.ipv4);
      toast(`已复制本机虚拟 IP：${peerState.local.ipv4}`);
    }
  });
  document.getElementById('navAllDevices').addEventListener('click', () => { activeView = 'all'; renderAll(); });
  document.getElementById('navDirect').addEventListener('click', () => { activeView = 'direct'; renderAll(); });
  document.getElementById('navFavorites').addEventListener('click', () => { activeView = 'favorites'; renderAll(); });
  document.getElementById('navSettings').addEventListener('click', () => { activeView = 'settings'; renderAll(); });
  document.getElementById('modalMask').addEventListener('click', (e) => {
    if (e.target.id === 'modalMask') closeModal();
  });

  appData = await window.eriiApi.getAppData();
  await refreshPeers(false);
  setInterval(() => refreshPeers(false), 5000);
})();
