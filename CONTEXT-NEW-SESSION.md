# 新对话请先读本文（上下文迁移）

新对话框开始时说「请先读 @CONTEXT-NEW-SESSION.md」，Agent 读完后直接继续开发或部署。

---

## 一、项目简介

**EchoLine**：影视跟读学习播放器（目前内容为《老友记》）。
- 用户端：剧集列表 + 视频播放 + 字幕联动（单句循环、AB 循环、中英双语切换）
- 管理端：添加/编辑/删除剧集（填服务器上已有视频文件名 + 上传字幕，无需手动改 JSON）
- GitHub：https://github.com/vikixuan10/EchoLine（`.gitignore` 含 `videos/`，视频不入库）

---

## 二、当前代码功能状态（已全部 push 到 GitHub）

### 管理端（admin.html + server.js）
- **添加一集**：不在网页上传视频。填「服务器上已有视频文件名」（如 `episode_0.mp4`）+ 上传字幕，点「上传字幕并发布」，自动写 `episodes.json`、生成缩略图。
- **编辑剧集**：表单插入在剧集卡片下方；显示当前文件名；支持副标题。
- **删除剧集**：同时删除服务器上对应的视频、字幕、缩略图文件。
- **缩略图**：POST/PUT 时调 ffmpeg 在视频第 5 秒截一帧，保存为 `videos/xxx_thumb.jpg`，写入 `thumbUrl`；`POST /api/generate-thumbnails` 可批量补生成。

### 用户端（index.html + js/）
- 剧集列表：有 `thumbUrl` 时直接用图片（手机端正常）；否则回退 canvas 截帧（桌面端）。
- 播放页：三态模式（正常/单句循环/AB 循环）；字幕下拉（英文/中文/双语）；已去掉「上一句/下一句」按钮。
- **PWA 图标**：已配置 `manifest.json` + `icons/icon-192.png` + `icons/icon-512.png`，手机"添加到主屏幕"后显示自定义图标。

### 字幕解析（js/subtitles.js）
- 已修复 UTF-8 BOM 导致第一句字幕不显示的问题。

---

## 三、部署状态（AWS Lightsail）

- **区域**：欧洲（爱尔兰）eu-west-1，公网 IP：**3.252.132.90**
- **实例**：echoline，Ubuntu 24.04 LTS，512MB RAM / 2 vCPUs / 20GB SSD
- **Swap**：已配置 1GB swapfile，永久生效

### Node（PM2）
- `pm2 start server.js --name echoline`，已 `pm2 save` + `pm2 startup`
- Node 监听 **localhost:3000**（不对外直接暴露）

### Nginx（视频和静态文件服务）✅ 已配置
- Nginx 1.24 监听 **80 端口**，直接从磁盘提供视频/字幕/静态文件（sendfile，不经过 Node 内存），仅 `/api/*` 代理到 Node:3000
- 配置文件：`/etc/nginx/sites-available/echoline`（已 symlink 到 sites-enabled）
- 权限修复：已执行 `sudo chmod o+x /home/ubuntu`（永久生效）
- ffmpeg 已安装：`sudo apt install ffmpeg`

### 访问地址
- 用户端：`http://3.252.132.90`
- 管理端：`http://3.252.132.90/admin.html`

### 防火墙（Lightsail Networking）
- 已开放：SSH 22、HTTP 80、TCP 3000
- 后续建议：确认 Nginx 稳定后，可在控制台删掉 3000 端口规则

---

## 四、标准操作手册

### 新加一集（完整流程）
```powershell
# 步骤 1：本机 PowerShell 用 scp 传视频到服务器
scp "C:\Projects\EchoLine\videos\你的视频.mp4" ubuntu@3.252.132.90:~/EchoLine/videos/episode_N.mp4
```
步骤 2：浏览器打开 `http://3.252.132.90/admin.html`  
步骤 3：「添加一集」→ 填标题、副标题（可选）、视频文件名（如 `episode_1.mp4`）、上传英文字幕（必填）和中文字幕（可选）→ 点「上传字幕并发布」  
步骤 4：服务端自动生成缩略图，用户端立即可见

### 更新代码后部署
```powershell
# 本机 PowerShell
cd C:\Projects\EchoLine
git add .
git commit -m "改动说明"
git push
```
```bash
# SSH 连上服务器后
cd ~/EchoLine
git pull
pm2 restart echoline
```

### SSH 连接服务器
```powershell
ssh ubuntu@3.252.132.90
```
建议在本机 `C:\Users\xww06\.ssh\config` 里加心跳配置，防止空闲断连：
```
Host 3.252.132.90
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

---

## 五、后续待做事项

1. **关闭 3000 端口**：Lightsail 防火墙删掉 3000 端口规则（Nginx 已接管，3000 不需对外）
2. **管理端加密码保护**：`/admin.html` 目前任何人都能访问，建议加简单密码
3. **绑定静态 IP**：公网 IP 在实例重启后可能变，Lightsail 控制台可绑定静态 IP
4. **HTTPS**：有域名后可用 Let's Encrypt 免费证书，消除「Not Secure」
5. **非 Range 请求隐患**：`server.js` 末尾 `readFileSync` 对非 Range 请求读整个视频，正常浏览器不触发，可改成流式更稳健
