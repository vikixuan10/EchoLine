# 新对话请先读本文（上下文迁移）

本文是上一轮对话的总结，供新开对话框后让 Agent 先读，以便延续 EchoLine 的开发和部署上下文。项目主背景见 [CONTEXT.md](CONTEXT.md)。

---

## 一、本轮已完成的代码与功能变更

### 1. 管理端（admin.html + server.js）
- **添加一集流程（大视频）**：**不再在网页上传视频**。流程为：先用 **scp** 将 MP4 传到服务器 `videos/` 目录，再在管理端「添加一集」处**填写服务器上已有视频文件名**（如 `episode_0.mp4`），上传英文字幕（必填）、中文字幕（可选），点击「上传字幕并发布」。后端 POST `/api/episode` 支持无 `video` 部件、带 `videoFilename` 时校验文件存在并登记，字幕仍通过表单上传；**无需手动改 JSON**。
- **编辑表单位置**：点某剧集「编辑」后，编辑区域**动态插入在该剧集卡片下方**，不再固定在页面底部。
- **当前文件展示**：编辑时显示该集已有的视频/英文字幕/中文字幕的**当前文件名**（从 `videoUrl`、`subtitles.en`、`subtitles.zh` 取 basename），无则显示「无」。
- **副标题字段**：添加一集、编辑剧集均支持**副标题**（可选）；不填则与标题相同。后端 POST/PUT 均支持 `subtitle` 字段，且不再用 title 覆盖 subtitle。

### 2. 用户端播放页（index.html + js/subtitle-sync.js + css/style.css）
- **移除**：「上一句」「下一句」按钮已删除。
- **三态模式**：仅一种模式生效——**正常** / **单句循环** / **AB 循环**。控制栏为三个互斥按钮，当前模式用填充色高亮；**AB 循环**模式下会多出一行「设 A」「设 B」按钮。
- **单句循环**：开启后当前句播完自动跳回句首循环。**在单句循环模式下点击另一条字幕会退出单句循环回到正常模式**。实现上在 `updateHighlight()` 里**先判断单句循环并 return**，避免 `currentIndex` 被更新导致循环错句。
- **AB 循环**：设 A、设 B 均为当前高亮句；A/B 可独立取消（再点一次）；**点击不在 A～B 范围内的字幕会退出 AB 循环回到正常模式**。字幕行有 `loop-a` / `loop-b` 的左侧色条与标签样式。
- **字幕模式下拉框**：用户端有「字幕」下拉，选项为**英文 / 中文 / 双语**（与前面「字幕」二字不重复）。切换后重新 `renderSubtitles(cues, mode)`。布局上「语速」和「字幕」为上下两行，左侧三态按钮保持横向排列。
- **缩略图**：剧集列表缩略图不再用第 1 秒（常黑屏），改为多时间点尝试（如 2、5、8、12、18、30 秒）+ 画面亮度判断，取第一个「够亮」的帧；否则用最后一帧。逻辑在 `js/app.js` 的 `captureThumbnail`。

### 3. Git 与仓库
- **.gitignore**：项目根目录有 `.gitignore`，内容为 `videos/`，**视频不纳入 Git**，避免超过 GitHub 单文件 100MB 限制。
- **GitHub 仓库**：https://github.com/vikixuan10/EchoLine （仓库名为 EchoLine，大小写不敏感可 clone）。代码已 push，含代码、`data/episodes.json`、`subtitles/`，**不含** `videos/`。
- **首次提交**：曾因带视频 push 失败，后用 `git rm --cached` 去掉两个 MP4、加 `.gitignore`、`git commit --amend` 后 push 成功。

---

## 二、部署状态（AWS Lightsail）

- **区域**：欧洲（爱尔兰）eu-west-1。
- **实例**：名称 echoline，Ubuntu 24.04 LTS，512MB RAM / 2 vCPUs / 20GB SSD，General purpose + Dual-stack。
- **已做配置**：
  - 防火墙开放 TCP 3000（及 SSH 22、HTTP 80）。
  - 安装 Node.js、npm，`git clone` 了 EchoLine 仓库到 `~/EchoLine`。
  - 使用 pm2 常驻：`pm2 start server.js --name echoline`，并已 `pm2 save` 和 `pm2 startup`（执行过 PM2 提示的那行 `sudo env PATH=...`）。
- **访问**：用户端 `http://公网IP:3000`，管理端 `http://公网IP:3000/admin.html`。公网 IP 以 Lightsail 实例页为准（会变可考虑静态 IP）。

### 重要限制：大文件上传与 512MB 内存
- **现象**：在管理端通过网页上传约 200MB+ 的 MP4 时易出现「保存错误」或「网络错误」。
- **原因**：`server.js` 将整个请求体读入内存再解析；512MB 实例在接收大文件时易触发内存不足或进程被杀。
- **规范做法**：大视频先用 **scp** 传到服务器 `videos/`，再在管理端「添加一集」填写该视频文件名并上传字幕发布。示例（PowerShell）：
  ```powershell
  scp "C:\Projects\EchoLine\videos\episode_0.mp4" ubuntu@公网IP:~/EchoLine/videos/
  ```