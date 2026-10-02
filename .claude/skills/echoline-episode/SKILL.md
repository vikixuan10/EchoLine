---
name: echoline-episode
description: EchoLine 剧集上线流程：处理老友记单集的字幕（ASS转SRT、Whisper 逐词时间戳逐句对齐）、生成缩略图、上传视频和字幕到服务器并同步到 GitHub。当用户提到"处理第X集"、"上传1017"、"做字幕"、"上线这一集"、"处理剧集"等操作时，必须使用此 Skill。即使用户只是说"帮我做下一集"或者给你字幕文件，也应该使用此 Skill 完成完整流程。
---

# EchoLine 剧集处理流程

用于将一集老友记视频完整处理并上线到 EchoLine 平台。全程用中文与用户沟通。

## 用户需要提供的信息

开始前，确认以下信息（如果用户没说，主动询问）：
- **集数编号**：四位数，两位季号 + 两位集号，如 `0808`（第八季第 8 集）、`1017`（第十季第 17 集），对应视频文件 `{集数}.mp4`
- **原始字幕文件**：通常在下方「文件路径约定」写的目录里，按约定的文件名去找；用户另有说明时以用户说的为准
  - 通常有两个：纯英文 ASS 和中英双语 ASS
  - 如果字幕包含多集（如 E17E18），需要知道要提取哪一集

## 文件路径约定

各季通用。下文三个占位符都由集数编号推出：

| 占位符 | 含义 | 第八季第 8 集 | 第十季第 17 集 |
|------|------|------|------|
| `{集数}` | 两位季号 + 两位集号，视频、字幕、缩略图的文件名都用它 | `0808` | `1017` |
| `{季目录}` | `S` + 季号，不补零 | `S8` | `S10` |
| `{季集号}` | `S` + 两位季号 + `E` + 两位集号 | `S08E08` | `S10E17` |

`{Friends}` 代指 Google Drive 本机同步目录 `~/Library/CloudStorage/GoogleDrive-vikixuan10@gmail.com/我的云端硬盘/Friends`。

| 类型 | 路径 |
|------|------|
| 视频 | `{Friends}/{季目录}/{集数}.mp4`，如 `{Friends}/S8/0808.mp4`（旧路径 `~/Documents/Videos/S10/` 已不存在） |
| 原始字幕 | `{Friends}/Subtitle/Original/Friends.{季集号}.chs&eng.ass`（中英双语）和 `Friends.{季集号}.eng.ass`（纯英文），如 `Friends.S08E08.chs&eng.ass`。个别集命名不同（如合集 `Friends.S10E17E18.*.ass`），以目录里实际有的文件为准 |
| 转写与对齐中间产物 | `/tmp/whisper_batch/{集数}/`（whisper JSON）和 `/tmp/whisper_batch/out/{集数}/`（对齐后的 SRT 与报告） |
| 项目字幕（Git 跟踪，也是最终真源） | `~/Documents/PROJECTS/EchoLine/subtitles/{集数}.en.srt` 和 `.zh.srt` |
| 对齐工具 | `~/Documents/PROJECTS/EchoLine/tools/align_subtitles.py`（单集）、`tools/batch_align.sh`（按 episodes.json 批量重对齐已上架的集） |
| 服务器视频 | `ubuntu@3.252.132.90:~/EchoLine/videos/` |
| 服务器字幕 | `ubuntu@3.252.132.90:~/EchoLine/subtitles/` |

下文用 `$VIDEO` 代指视频完整路径：
```bash
VIDEO="$HOME/Library/CloudStorage/GoogleDrive-vikixuan10@gmail.com/我的云端硬盘/Friends/{季目录}/{集数}.mp4"
```

## 执行步骤

### 第一步：解析字幕文件

ASS 文件编码不固定，需要自动检测。用 Python 先读文件开头的 BOM：

- 开头是 `FF FE` 或 `FE FF`：UTF-16，用 `utf-16` 解码
- 开头是 `EF BB BF`：带 BOM 的 UTF-8，用 `utf-8-sig` 解码
- 没有 BOM：按 `utf-8 → gbk → gb2312 → latin-1` 依次尝试，以能成功解析出 Dialogue 行的为准

> 不要一上来就试 `utf-16`：带 BOM 的 UTF-8 文件按 utf-16 解码不一定报错，文件字节数恰为偶数时会顺利解出一堆乱码，所以必须先看 BOM。
>
> 已知特例：S10E12 的 chs&eng.ass 是 **GBK 编码**（无 BOM），必须包含 gbk 才能正确解析。

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
- 英文 ASS 里夹的中文译注（如 `[《爸爸别说教》: 麦当娜歌曲…]`、片名行）原样保留在英文轨里，不删、不挪到中文轨；对齐脚本会按邻句推算它们的时间（报告里状态为 note）

**解析中英双语 ASS → 中文 SRT：**
每行文本结构：`{样式}中文{\r}\N{样式}English`
- 取 `{\r}\N` 之前的部分作为中文
- 同样去除格式标签
- 不用双语 ASS 自己的时间：它通常比纯英文 ASS 统一晚 0.10 秒（S08E08、S10E01、S10E05 实测逐句如此）。每句中文直接套用对应英文句的时间码（双语行 `\N` 后面带着英文原句，可据此配对）

输出到 `/tmp/{集数}.en.srt` 和 `/tmp/{集数}.zh.srt`。**中文 SRT 的时间码必须与英文一一相同**（对齐时中文靠旧开始时间去找对应英文句，容差只有 0.05 秒，差 0.10 秒就配不上）。

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

### 第三步半：合并半句，再切每句音频

播放器的单句循环、AB 循环、跟读重播都是放预先切好的每句一个音频小文件（`clips/{集数}/{序号}.m4a`，序号 = 字幕条号），不在视频里跳转。前提是「一行字幕 = 一句话」，所以要先把字幕组为控制行宽拆开的半句合回去，再切。

**1. 出合并候选表给用户看（不能跳过）**

先把对齐后的字幕放进 `subtitles/`（第六步的 cp），然后：

```bash
cd ~/Documents/PROJECTS/EchoLine
python3 tools/merge_cues.py {集数} --list --table /tmp/{集数}-合并候选.md
```

规则（2026-10-01 与用户定）：上一行以「...」结尾且下一行以「...」开头；或上一行没有句末标点、下一行小写开头、两行间隔不到 0.6 秒。两人对话行（`- Why me? - Hey...`）不动，译注行不动，不设长度上限。候选表每行列出原来的两行、合并后的中英文、时长，用 SendUserFile 发给用户，请用户只回复「不合」的序号。一集通常 30 到 40 处。

**2. 按用户的意见合并**

```bash
python3 tools/merge_cues.py {集数}                 # 全部同意
python3 tools/merge_cues.py {集数} --skip 3,7      # 第 3、7 处不合
```

它直接改写 `subtitles/{集数}.en.srt` 与 `.zh.srt`：英文把「... ...」去掉拼成一句，中文两半之间留两个空格，译文不改。中英配对用的是播放器显示时同一套办法，所以 S10E12 这种中文时间轴对不上的集也能合。文件名不规整的集用 `--en` `--zh` 指明路径（按 `data/episodes.json` 里写的）。

**3. 切音频**

```bash
bash tools/cut_clips.sh {集数}                     # 文件名不规整的集：bash tools/cut_clips.sh 1016 subtitles/episode_1.en.srt
```

先整集抽 44.1k wav，再按每条字幕切成 AAC 64k 单声道小文件，首尾各 15 毫秒淡入淡出，一集约 16 秒、7MB，产物在 `clips/{集数}/`（不进 Git）。**字幕改了必须重切**，序号是按条号对应的。

**4. 上传小文件**

```bash
ssh ubuntu@3.252.132.90 'mkdir -p ~/EchoLine/clips/{集数}'
scp -q -r clips/{集数}/. ubuntu@3.252.132.90:~/EchoLine/clips/{集数}/
ssh ubuntu@3.252.132.90 'chmod 644 ~/EchoLine/clips/{集数}/*.m4a; ls ~/EchoLine/clips/{集数} | wc -l'
```

播放器进一集时探测 `clips/{集数}/0001.m4a` 在不在，在就启用小文件并整集预取到手机，不在就走视频跳转的老办法。所以小文件可以晚于字幕上传，但上传后要和字幕条数一致。

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

### 第五步：上传视频到服务器

```bash
scp "$VIDEO" ubuntu@3.252.132.90:~/EchoLine/videos/ && \
ssh ubuntu@3.252.132.90 "chmod 644 ~/EchoLine/videos/{集数}.mp4"
```

**chmod 644 是必须的**，不改权限视频无法播放。

缩略图这一步先不传，等用户在后台上架之后再传（见第七步）。

### 第六步：字幕进项目目录并上传服务器

```bash
cp /tmp/whisper_batch/out/{集数}/{集数}.en.srt ~/Documents/PROJECTS/EchoLine/subtitles/
cp /tmp/whisper_batch/out/{集数}/{集数}.zh.srt ~/Documents/PROJECTS/EchoLine/subtitles/
# 这里先做「第三步半」的合并与切音频，上传的必须是合并后的字幕，否则小文件序号对不上

# 先传临时目录再 mv 换名（原子操作），正在看的人不会拿到半截文件；字幕是静态文件，服务端每次请求读盘，不需要重启 PM2
ssh ubuntu@3.252.132.90 'mkdir -p ~/EchoLine/subtitles/.incoming'
scp ~/Documents/PROJECTS/EchoLine/subtitles/{集数}.*.srt ubuntu@3.252.132.90:~/EchoLine/subtitles/.incoming/
ssh ubuntu@3.252.132.90 'cd ~/EchoLine/subtitles && for f in .incoming/*.srt; do mv -f "$f" "$(basename "$f")"; done; rmdir .incoming'
```

### 第七步：请用户上架，上架后传缩略图，再等待测试

告知用户：
1. **视频文件名**：`{集数}.mp4`（填入后台"服务器上已有视频文件名"）
2. **副标题**：查询 Friends {季集号} 的英文标题
3. 请用户在后台上架，上架完说一声

**用户确认已上架之后**，再把第四步选好的缩略图传上去：

```bash
scp /tmp/{集数}_thumb.jpg ubuntu@3.252.132.90:~/EchoLine/videos/
```

> 为什么必须在上架之后传：后台「添加一集」时，`server.js` 的 `generateThumbnail` 会用 ffmpeg 截视频第 5 秒的画面（固定时间点，不挑亮度），存成 `videos/{集数}_thumb.jpg`，与本地选的那张同名。上架前传上去的会被它覆盖；上架后再传，留在服务器上的才是本地选的那一帧。`episodes.json` 里的 `thumbUrl` 指向的就是这个文件名，不用改。
>
> 如果 `/tmp/{集数}_thumb.jpg` 已经不在（比如中间重启过），按第四步重新生成再传。

缩略图传完后，请用户在 iPhone 上测试字幕对齐效果，重点听第三步报告里「偏移超过 1 秒」的那几句。

**等待用户测试反馈。** 如果个别句子仍不准：打开 `{集数}.report.tsv` 找到那句，看它是 miss（推算）还是 strong，直接手改 `subtitles/` 里该句的时间码后重传。**不要再对整集加减固定偏移**，那会把已经对准的几百句一起带偏。

### 第八步：确认满意后同步到 Git

用户确认字幕效果满意后：

```bash
# 从服务器同步 episodes.json
scp ubuntu@3.252.132.90:~/EchoLine/data/episodes.json ~/Documents/PROJECTS/EchoLine/data/

# 提交并推送到 GitHub
cd ~/Documents/PROJECTS/EchoLine
git add data/episodes.json subtitles/{集数}.en.srt subtitles/{集数}.zh.srt
git commit -m "feat: add {季集号} with per-sentence aligned subtitles"   # 如 feat: add S08E08 with ...
git push origin main
```

**三个地方必须全部同步：本机项目目录、服务器、GitHub。**

## 工具依赖

- `ffmpeg` / `ffprobe`：已安装（通过 Homebrew）
- `whisperkit-cli`：`/opt/homebrew/bin/whisperkit-cli`（Apple Silicon Metal GPU 加速，**首选工具**）
- `tools/align_subtitles.py`、`tools/merge_cues.py`：项目内，纯标准库 Python，无需安装依赖
- `tools/cut_clips.sh`：项目内，只依赖 ffmpeg
- SSH 免密登录：`ubuntu@3.252.132.90`（已配置）

> `ffsubsync` 已不再使用（本机也已不在 PATH 里）。
> `openai-whisper`（`/Users/weiwei/Library/Python/3.9/bin/whisper`）仍然存在，但速度极慢（CPU only），不要使用。
> `faster-whisper` 已安装但在 macOS 后台运行时会被系统静默 kill，不要使用。

## 注意事项

- 上传大视频前先确认文件存在：`ls "$VIDEO"`
- 上传视频可能需要几分钟，正常等待
- Whisper 跑 medium 模型约 4 分钟一集，可在后台运行；批量时用终端标签跑，用户能看到进度
- ASS 文件编码不固定，需自动检测（先看 BOM，没有 BOM 再逐个尝试，顺序见第一步）
- 字幕文件如果不是 ASS 格式（如已是 SRT），跳过解析步骤，直接从第二步开始
- 中国版视频可能剪掉了部分片段。逐句对齐天然不受影响（每句独立定位），这正是弃用整集平移的原因
- **每次处理完必须同步三个地方：本机项目目录、服务器、GitHub**；小文件（`clips/`）不进 Git，只在本机和服务器
- 改字幕（重新对齐、改错字、合并）之后，`cut_clips.sh` 重切并重传整集小文件，别只传几个
- 本 skill 的唯一真源是项目仓库 `.claude/skills/echoline-episode/SKILL.md`（git 跟踪即备份）；`~/.claude/skills/echoline-episode` 是指向它的软链，因此任何目录下开的会话都加载同一份实体，改这里就够了。不要再往 claude.ai 上传副本
