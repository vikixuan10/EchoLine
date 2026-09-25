---
name: echoline-episode
description: EchoLine 剧集上线流程：处理老友记单集的字幕（ASS转SRT、Whisper 逐词时间戳逐句对齐）、生成缩略图、上传视频和字幕到服务器并同步到 GitHub。当用户提到"处理第X集"、"上传1017"、"做字幕"、"上线这一集"、"处理剧集"等操作时，必须使用此 Skill。即使用户只是说"帮我做下一集"或者给你字幕文件，也应该使用此 Skill 完成完整流程。
---

# EchoLine 剧集处理流程

用于将一集老友记视频完整处理并上线到 EchoLine 平台。全程用中文与用户沟通。

## 用户需要提供的信息

开始前，确认以下信息（如果用户没说，主动询问）：
- **集数编号**：如 `1017`（对应视频文件 `1017.mp4`）
- **原始字幕文件**：用户会告诉你文件在哪、叫什么
  - 通常有两个：纯英文 ASS 和中英双语 ASS
  - 如果字幕包含多集（如 E17E18），需要知道要提取哪一集

## 文件路径约定

| 类型 | 路径 |
|------|------|
| 视频 | `~/Library/CloudStorage/GoogleDrive-vikixuan10@gmail.com/我的云端硬盘/Friends/S10/{集数}.mp4`（Google Drive 本机同步目录；旧路径 `~/Documents/Videos/S10/` 已不存在） |
| 转写与对齐中间产物 | `/tmp/whisper_batch/{集数}/`（whisper JSON）和 `/tmp/whisper_batch/out/{集数}/`（对齐后的 SRT 与报告） |
| 项目字幕（Git 跟踪，也是最终真源） | `~/Documents/PROJECTS/EchoLine/subtitles/{集数}.en.srt` 和 `.zh.srt` |
| 对齐工具 | `~/Documents/PROJECTS/EchoLine/tools/align_subtitles.py`（单集）、`tools/batch_align.sh`（按 episodes.json 批量重对齐已上架的集） |
| 服务器视频 | `ubuntu@3.252.132.90:~/EchoLine/videos/` |
| 服务器字幕 | `ubuntu@3.252.132.90:~/EchoLine/subtitles/` |

下文用 `$VIDEO` 代指视频完整路径：
```bash
VIDEO="$HOME/Library/CloudStorage/GoogleDrive-vikixuan10@gmail.com/我的云端硬盘/Friends/S10/{集数}.mp4"
```

## 执行步骤

### 第一步：解析字幕文件

ASS 文件编码不固定，需要自动检测。用 Python 按以下顺序尝试：`utf-16 → utf-8-sig → utf-8 → gbk → gb2312 → latin-1`，以能成功解析出 Dialogue 行的为准。

> 已知特例：S10E12 的 chs&eng.ass 是 **GBK 编码**，必须包含 gbk 才能正确解析。

**判断是否为多集合并文件：**
先用 ffprobe 获取视频时长（秒），以此为截取上限：
```bash
ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$VIDEO"
```

如果是多集合并文件（如 E17E18），需要：
1. 找到两集之间的时间间隔（通常有明显的空白间隔）
2. 根据要提取的集数，截取对应的时间段
3. 如果提取的是后面的集数，需要将时间戳减去偏移量（从 0:00:00 开始）

**解析英文 ASS → 英文 SRT：**
每行 Dialogue 格式：`Dialogue: 0,开始时间,结束时间,Default,...,,文本`
- 过滤时间戳超过视频时长的行
- 去除 ASS 格式标签 `{...}`，处理 `\N`（换行）
- 时间格式从 `H:MM:SS.cc` 转为 SRT 格式 `HH:MM:SS,mmm`

**解析中英双语 ASS → 中文 SRT：**
每行文本结构：`{样式}中文{\r}\N{样式}English`
- 取 `{\r}\N` 之前的部分作为中文
- 同样去除格式标签

输出到 `/tmp/{集数}.en.srt` 和 `/tmp/{集数}.zh.srt`。**中文 SRT 的时间码必须与英文一一相同**（对齐时中文靠旧开始时间去找对应英文句）。

验证：检查前5条和后5条内容，确认中英文分离正确。

### 第二步：whisperkit 逐词转写

原始字幕的时间轴通常大方向对、零星句子放错、句尾拖进下一句。**用逐句强制对齐修**：whisperkit 给出每个词的时间，再让人工字幕的文字去匹配，每句独立拿到起止时间。不再用 ffsubsync 整集平移，也不再手调整集偏移（2026-09-24 起，18 集实测整集偏移中位数都在 ±0.3 秒内，错的全是零星句，整集平移救不了）。

**必须使用 whisperkit-cli**（Apple Silicon Metal GPU 加速，约 4 分钟/集）。**不要用** `openai-whisper`（CPU，~116 分钟/集）或 `faster-whisper`（macOS 后台会被静默 kill）。

```bash
mkdir -p /tmp/whisper_batch/{集数}
# 先抽 16k 单声道 wav，比直接读 Drive 上的 mp4 稳；-nostdin 防止 ffmpeg 吞掉脚本的标准输入
ffmpeg -nostdin -y -v error -i "$VIDEO" -vn -ac 1 -ar 16000 /tmp/whisper_batch/{集数}/{集数}.wav
whisperkit-cli transcribe \
  --audio-path /tmp/whisper_batch/{集数}/{集数}.wav \
  --model whisper-medium --language en \
  --word-timestamps --report --report-path /tmp/whisper_batch/{集数}/ < /dev/null
```

输出 `/tmp/whisper_batch/{集数}/{集数}.json`（带每个词的 start/end）。**`--word-timestamps` 不能省**，对齐脚本靠它。

**⚠️ 必须验证输出非空：** whisperkit-cli 可能静默失败，生成空文件但不报错（S10E02 曾因此上线后字幕全部对不上）。词数少于 500 就重跑一次：
```bash
python3 -c "import json; d=json.load(open('/tmp/whisper_batch/{集数}/{集数}.json')); print(sum(len(s.get('words') or []) for s in d['segments']))"
```

### 第三步：逐句对齐

```bash
cd ~/Documents/PROJECTS/EchoLine
python3 tools/align_subtitles.py {集数} /tmp/{集数}.en.srt /tmp/whisper_batch/{集数}/{集数}.json /tmp/whisper_batch/out/{集数} /tmp/{集数}.zh.srt
```

产出在 `/tmp/whisper_batch/out/{集数}/`：
- `{集数}.en.srt` / `{集数}.zh.srt`：对齐后的字幕（文字与条数与输入完全一致，只改时间码）
- `{集数}.report.tsv`：每句旧/新起止、偏移、匹配词数、状态（strong 强匹配 / weak 弱匹配 / miss 按邻句推算 / note 译注）

脚本终端输出里看三样：强匹配比例（正常八成以上）、强匹配句偏移中位数（正常 ±0.3 秒内）、「偏移超过 1 秒的强匹配句」清单（这些是原字幕真放错的地方，可以抽两句听一下）。推算句多半是单词句（So... / Fine.）或英文轨里夹的中文译注，正常。

> 已上架的集要重新对齐时用 `bash tools/batch_align.sh {集数}`，它按 `data/episodes.json` 找字幕、复用已有的 whisper JSON，产出同样在 `/tmp/whisper_batch/out/`，不直接改 `subtitles/`。

### 第四步：生成缩略图

在 60、90、120、180、240 秒处各截一帧，计算亮度，选最亮的：

```bash
for t in 60 90 120 180 240; do
  ffmpeg -y -ss $t -i "$VIDEO" -vframes 1 /tmp/thumb_$t.jpg -loglevel quiet
  brightness=$(ffmpeg -i /tmp/thumb_$t.jpg -vf "scale=16:16,format=gray" -f rawvideo -pix_fmt gray pipe:1 2>/dev/null \
    | od -A n -t u1 | awk '{for(i=1;i<=NF;i++) sum+=$i; n+=NF} END{print int(sum/n)}')
  echo "t=${t}s brightness=${brightness}"
done
```

用亮度最高的时间点生成最终缩略图：
```bash
ffmpeg -y -ss {最亮时间} -i "$VIDEO" -vframes 1 /tmp/{集数}_thumb.jpg -loglevel quiet
```

### 第五步：上传视频和缩略图到服务器

```bash
scp "$VIDEO" ubuntu@3.252.132.90:~/EchoLine/videos/ && \
ssh ubuntu@3.252.132.90 "chmod 644 ~/EchoLine/videos/{集数}.mp4"

scp /tmp/{集数}_thumb.jpg ubuntu@3.252.132.90:~/EchoLine/videos/
```

**chmod 644 是必须的**，不改权限视频无法播放。

### 第六步：字幕进项目目录并上传服务器

```bash
cp /tmp/whisper_batch/out/{集数}/{集数}.en.srt ~/Documents/PROJECTS/EchoLine/subtitles/
cp /tmp/whisper_batch/out/{集数}/{集数}.zh.srt ~/Documents/PROJECTS/EchoLine/subtitles/

# 先传临时目录再 mv 换名（原子操作），正在看的人不会拿到半截文件；字幕是静态文件，服务端每次请求读盘，不需要重启 PM2
ssh ubuntu@3.252.132.90 'mkdir -p ~/EchoLine/subtitles/.incoming'
scp ~/Documents/PROJECTS/EchoLine/subtitles/{集数}.*.srt ubuntu@3.252.132.90:~/EchoLine/subtitles/.incoming/
ssh ubuntu@3.252.132.90 'cd ~/EchoLine/subtitles && for f in .incoming/*.srt; do mv -f "$f" "$(basename "$f")"; done; rmdir .incoming'
```

### 第七步：告知用户上架信息并等待测试

告知用户：
1. **视频文件名**：`{集数}.mp4`（填入后台"服务器上已有视频文件名"）
2. **副标题**：查询 Friends S10E{集号} 的英文标题
3. 请用户在后台上架，然后在 iPhone 上测试字幕对齐效果，重点听第三步报告里「偏移超过 1 秒」的那几句

**等待用户测试反馈。** 如果个别句子仍不准：打开 `{集数}.report.tsv` 找到那句，看它是 miss（推算）还是 strong，直接手改 `subtitles/` 里该句的时间码后重传。**不要再对整集加减固定偏移**，那会把已经对准的几百句一起带偏。

### 第八步：确认满意后同步到 Git

用户确认字幕效果满意后：

```bash
# 从服务器同步 episodes.json
scp ubuntu@3.252.132.90:~/EchoLine/data/episodes.json ~/Documents/PROJECTS/EchoLine/data/

# 提交并推送到 GitHub
cd ~/Documents/PROJECTS/EchoLine
git add data/episodes.json subtitles/{集数}.en.srt subtitles/{集数}.zh.srt
git commit -m "feat: add S10E{集号} with per-sentence aligned subtitles"
git push origin main
```

**三个地方必须全部同步：本机项目目录、服务器、GitHub。**

提交到 main 后，记得同步 develop 分支：
```bash
git checkout develop && git merge main && git push origin develop && git checkout main
```

## 工具依赖

- `ffmpeg` / `ffprobe`：已安装（通过 Homebrew）
- `whisperkit-cli`：`/opt/homebrew/bin/whisperkit-cli`（Apple Silicon Metal GPU 加速，**首选工具**）
- `tools/align_subtitles.py`：项目内，纯标准库 Python，无需安装依赖
- SSH 免密登录：`ubuntu@3.252.132.90`（已配置）

> `ffsubsync` 已不再使用（本机也已不在 PATH 里）。
> `openai-whisper`（`/Users/weiwei/Library/Python/3.9/bin/whisper`）仍然存在，但速度极慢（CPU only），不要使用。
> `faster-whisper` 已安装但在 macOS 后台运行时会被系统静默 kill，不要使用。

## 注意事项

- 上传大视频前先确认文件存在：`ls "$VIDEO"`
- 上传视频可能需要几分钟，正常等待
- Whisper 跑 medium 模型约 4 分钟一集，可在后台运行；批量时用终端标签跑，用户能看到进度
- ASS 文件编码不固定，需自动检测（尝试 utf-16 → utf-8-sig → utf-8 → gbk）
- 字幕文件如果不是 ASS 格式（如已是 SRT），跳过解析步骤，直接从第二步开始
- 中国版视频可能剪掉了部分片段。逐句对齐天然不受影响（每句独立定位），这正是弃用整集平移的原因
- **每次处理完必须同步三个地方：本机项目目录、服务器、GitHub**
- 本 skill 的唯一真源是项目仓库 `.claude/skills/echoline-episode/SKILL.md`（git 跟踪即备份），只在 EchoLine 目录下开的会话加载；不要再往 claude.ai 上传副本
