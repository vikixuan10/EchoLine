# EchoLine 项目上下文文档

## 项目简介
EchoLine 是一个移动端优先的英语学习播放器，主要用于学习《老友记》。
- 运行方式：`node server.js`（在项目根目录执行）
- 用户端：http://localhost:3000/
- 管理端：http://localhost:3000/admin.html

## 技术栈
- 纯原生：HTML5 + CSS + JavaScript（无前端框架）
- 后端：Node.js 原生 `http` 模块（无 Express 等框架）
- 字幕格式：SRT
- 无数据库，元数据存储在 `data/episodes.json`，视频存 `videos/`，字幕存 `subtitles/`

## 项目结构

```
EchoLine/
├── index.html          # 用户端（剧集列表 + 播放页，单页）
├── admin.html          # 管理端（添加/编辑/删除剧集）
├── server.js           # Node.js 后端
├── CONTEXT.md          # 本文件，项目背景与状态
├── css/style.css       # 样式（淡雅简洁风格，移动端优先）
├── js/
│   ├── app.js          # 用户端逻辑：剧集列表、加载视频与字幕
│   ├── player.js       # 视频播放、playbackRate（0.5～2.0）
│   ├── subtitles.js    # SRT 解析、双轨合并
│   └── subtitle-sync.js# 点击字幕跳转、高亮、上一句/下一句
├── data/episodes.json  # 剧集列表（由管理端写入）
├── videos/             # MP4 视频文件
└── subtitles/          # SRT 字幕文件
```

## 已实现的功能

### 用户端
- 剧集列表页：显示已上架的所有剧集，按 title 数字从小到大排序
- 每集有视频缩略图（前端 video+canvas+IntersectionObserver 懒加载方案，无需 ffmpeg）
- 播放页：上半屏视频，下半屏可滚动英文字幕列表
- 点击某条字幕 → 视频跳转到该句并播放，之后顺延播放
- 播放时当前字幕行高亮，并自动滚动到可见区域（防抖避免与手动滑动冲突）
- 「上一句」/「下一句」按钮：按当前字幕条索引跳转，首条/末条时禁用
- 语速调节：0.5 ～ 2.0，步长 0.1，通过 `<select>` 写入 `video.playbackRate`
- 字幕显示模式：仅英文（默认）、仅中文、英+中

### 管理端
- 添加一集：上传 MP4 + 英文 SRT（必填）+ 中文 SRT（可选），立即发布，用户端立即可见
- 编辑剧集：可选择性重新上传视频/字幕（不选则保留原文件），支持改标题
- 删除剧集：删除后从列表消失，视频与字幕文件同时从磁盘删除
- 字幕由用户自行用 **Subtitle Edit** 软件完成调轴，调好后通过「编辑剧集」上传 SRT
- 无「逐条调轴」功能（已移除）

### 后端 API（server.js）
- `GET /api/episodes` — 获取剧集列表
- `POST /api/episode` — 添加一集（multipart）
- `PUT /api/episode/:index` — 编辑一集（multipart，所有字段可选）
- `DELETE /api/episode/:index` — 删除一集（同时删磁盘文件）
- 静态文件服务：支持 Range 请求（206 Partial Content），MP4 播放正常

### 关键技术细节
- multipart 解析为自定义实现（server.js），不依赖第三方库
- 文件截断 bug 已修复：去掉 body 末尾 2 字节 `\r\n`，而非在第一个 `\r\n` 处截断
- 视频播放已正常（Range 206 支持已实现）

## 当前已知问题 / 待解决
- **重复剧集**：`data/episodes.json` 中有两个 title 为 "1016" 的条目（episode_7 和 episode_8），需要在管理端删除其中一个

## 个人使用说明
- 这个 App 只有两个人使用，无需登录、权限控制、数据统计
- 管理端只有自己知道路径即可（不对外暴露）
- 字幕用 Subtitle Edit 软件手动调轴后上传，不需要在线调轴功能

## 下一步待办（可选/未来）
- 处理重复 episode_7/episode_8（title 均为 1016），在管理端删除其中一个
- 缩略图优化：目前用前端 canvas 方案（懒加载），若安装 ffmpeg 可改为服务端上传时生成，加载更快
- 手机端访问：目前只在本机 localhost:3000 运行，如需手机打开需考虑局域网 IP 或部署到服务器
