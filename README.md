# EriiRemote（Erii 远程）

> 一款基于 **EasyTier** 异地虚拟局域网的开源、免费、高颜值 Windows 远程桌面与设备控制中心。  
> 无需购买会员、不限速、不暴露公网 3389 端口，开箱即享 **P2P 点对点直连 + Windows 原生 RDP 极清办公 + Moonlight 高刷游戏串流**。

---

## ✨ 核心特性

* **内置异地虚拟局域网引擎**：封装开源去中心化组网引擎 [EasyTier](https://github.com/EasyTier/EasyTier)，支持自动 P2P UDP 打洞直连与端到端加密。
* **现代高颜值桌面 UI**：
  * 自动扫描并实时展示局域网内在线设备（支持 Windows 电脑 / NAS 自动识别、P2P 延迟、NAT 类型监控）。
  * 自动记忆历史设备，离线设备自动灰显保留，上线自动亮绿灯。
  * 一键 **「进入桌面 →」**（默认直连 Windows 原生 RDP，自动绕过未签名 `.rdp` 弹窗），卡片下方一键切换 **文件传输 (SMB)**、**游戏串流 (Moonlight)**、**终端测速**、**NAS 网页后台**。
  * 支持自定义设备备注名、收藏星标、自定义快速启动项、系统托盘最小化驻留与开机自启。
* **远程开关机与跨网协同唤醒 (WOL)**：
  * 支持对在线设备执行 **远程关机、远程重启、睡眠、锁屏、取消关机**（基于私有局域网密钥派生 Token 鉴权，并可在设置中随时开关）。
  * 在线时**自动同步并记忆对方物理网卡 MAC 地址**；设备离线后，卡片自动切换为 **「⚡ 远程开机 (WOL)」**，点击后本机广播并**自动通知其他在线节点在其物理局域网协同代发魔术包**，实现跨外网远程开机（需目标主板 BIOS 开启 Wake-on-LAN）。
* **智能兼容已有服务**：启动时若检测到系统已运行 `easytier-core` 后台服务，自动无缝接管而不冲突；否则自动拉起内置引擎。
* **零私有信息硬编码**：开源版不包含任何私有密钥，首次打开提供「一键随机生成局域网名称与密钥」引导。

---

## 🔒 安全性说明

1. **公网零端口暴露**：被控电脑的 RDP（3389）或 SMB（445）端口完全无需映射到公网。
2. **双重加密传输**：外层由 EasyTier 使用你自定义的私有密钥进行端到端加密（中继节点无法解密任何数据），内层由 Windows RDP TLS 加密 + 系统账号密码认证。
3. **支持自建私有握手节点**：你可以在家里的 NAS（如飞牛 fnOS / 群晖）或轻量云服务器上部署 EasyTier 私有节点并填入设置中，彻底摆脱对第三方公共节点的依赖。

---

## 🚀 快速开始（使用方式）

1. 在所有需要互连的 Windows 电脑上安装 `EriiRemote`（可从 Releases 下载，或按下方步骤自行构建）。
2. 打开软件进入 **「设置」**：
   * 在第一台电脑点击 **「🎲 随机生成网络名与密钥」** 并保存；
   * 在其他电脑填入**相同的局域网名称与密钥**并保存。
3. 等待 3~5 秒，所有设备即会自动出现在左侧 **「我的设备」** 列表中，点击 **「进入桌面 →」** 即可开始远程！

> **提示**：使用 Windows 原生 RDP 被控前，请确保被控电脑已在 `设置 → 系统 → 远程桌面` 中开启远程桌面开关，且登录账号已设置密码。高帧率游戏串流推荐搭配开源的 [Apollo](https://github.com/ClassicOldSong/Apollo) + [Moonlight](https://github.com/moonlight-stream/moonlight-qt)。

---

## 🛠️ 从源码开发与构建安装包

环境要求：Windows 10/11 + Node.js 18+

```bash
# 1. 克隆仓库
git clone https://github.com/aysaka9/EriiRemote.git
cd EriiRemote

# 2. 安装依赖
npm install

# 3. 自动下载最新官方 EasyTier Windows 核心文件到 resources/easytier/
npm run download-easytier

# 4. 本地开发运行
npm start

# 5. 构建 Windows NSIS 完整安装包 (输出到 dist/ 目录)
npm run build
```

---

## 📄 开源协议与致谢

* 本项目基于 [MIT License](LICENSE) 开源。
* 底层虚拟局域网能力由优秀的开源项目 [EasyTier](https://github.com/EasyTier/EasyTier) 强力驱动。
