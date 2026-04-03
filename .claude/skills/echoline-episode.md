---
name: echoline-episode
description: EchoLine 剧集上线流程：处理老友记单集的字幕（ASS转SRT、Whisper时间戳对齐）、生成缩略图、上传视频和字幕到服务器并同步到 GitHub。当用户提到"处理第X集"、"上传1017"、"做字幕"、"上线这一集"、"处理剧集"等操作时，必须使用此 Skill。即使用户只是说"帮我做下一集"或者给你字幕文件，也应该使用此 Skill 完成完整流程。
---

# EchoLine 剧集处理流程

用于将一集老友记视频完整处理并上线到 EchoLine 平台。全程用中文与用户沟通。

## 用户需要提供的信息

开始前，确认以下信息（如果用户没说，主动询问）：
- **集数编号**：如 `1017`（对应视频文件 `1017.mp4`）
- **原始字幕文件**：在 `~/Documents/Videos/Subtitle/Original/` 下，用户会告诉你文件名
  - 通常有两个：纯英文 ASS 和中英双语 ASS
  - 如果字幕包含多集（如 E17E18），需要知道要提取哪一集

## 文件路径约定

| 类型 | 路径 |
|------|------|
| 视频 | `~/Documents/Videos/S10/{集数}.mp4` |
| 原始字幕 | `~/Documents/Videos/Subtitle/Original/` |
| 输出字幕（工作副本） | `~/Documents/Videos/Subtitle/{集数}.en.srt` 和 `.zh.srt` |
| 项目字幕（Git 跟踪） | `~/Documents/PROJECTS/EchoLine/subtitles/{集数}.en.srt` 和 `.zh.srt` |
| 服务器视频 | `ubuntu@3.252.132.90:~/EchoLine/videos/` |
| 服务器字幕 | `ubuntu@3.252.132.90:~/EchoLine/subtitles/` |

## 执行步骤

### 第一步：解析字幕文件

ASS 文件编码不固定，需要自动检测。用 Python 按以下顺序尝试：`utf-16 → utf-8-sig → utf-8 → gbk → gb2312 → latin-1`，以能成功解析出 Dialogue 行的为准。

> 已知特例：S10E12 的 chs&eng.ass 是 **GBK 编码**，必须包含 gbk 才能正确解析。

**判断是否为多集合并文件：**
先用 ffprobe 获取视频时长（秒），以此为截取上限：
```bash
ffprobe -v quiet -show_entries format=duration -of csv=p=0 ~/Documents/Videos/S10/{集数}.mp4
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

输出到 `/tmp/{集数}.en.srt` 和 `/tmp/{集数}.zh.srt`

验证：检查前5条和后5条内容，确认中英文分离正确。

### 第二步：用 whisperkit-cli 生成参考时间戳

**必须使用 whisperkit-cli**（Apple Silicon Metal GPU 加速，约 4 分钟/集，7.5x 实时速度）。

**不要用** `openai-whisper`（CPU 模式，~116 分钟/集，极慢）或 `faster-whisper`（macOS 后台会被静默 kill）。

```bash
mkdir -p /tmp/whisper_{集数}
whisperkit-cli transcribe \
  --audio-path ~/Documents/Videos/S10/{集数}.mp4 \
  --model "whisper-medium" \
  --language en \
  --skip-special-tokens \
  --report --report-path /tmp/whisper_{集数}/
```

输出的 SRT 文件路径为 `/tmp/whisper_{集数}/{集数}.srt`（文件名与视频同名去扩展名）。

**⚠️ 必须验证输出非空：** whisperkit-cli 可能静默失败，生成 0 字节的 SRT 文件但不报错。如果不检查就继续跑 ffsubsync，对齐结果会完全无效（S10E02 曾因此上线后字幕全部对不上）。

```bash
# 单集验证
line_count=$(wc -l < /tmp/whisper_{集数}/{集数}.srt)
if [ "$line_count" -lt 100 ]; then
  echo "❌ 警告：Whisper 输出异常（仅 ${line_count} 行），需要重新跑"
  # 重新跑一次 whisperkit-cli
else
  echo "✅ Whisper 输出正常（${line_count} 行）"
fi
```

Whisper 的作用是提供精准时间戳，最终使用的文字内容仍以用户提供的原始字幕为准（因为原始字幕是人工翻译，质量更好）。

**批量处理多集时**，用 shell 脚本循环调用，whisperkit-cli 在后台（nohup）运行稳定，每集约 4 分钟，12 集约 50 分钟。**每集跑完必须验证输出非空：**

```bash
for ep_num in $(seq 1 12); do
  ep_code=$(printf "10%02d" $ep_num)
  mkdir -p /tmp/whisper_${ep_code}
  whisperkit-cli transcribe \
    --audio-path ~/Documents/Videos/S10/${ep_code}.mp4 \
    --model "whisper-medium" --language en \
    --skip-special-tokens \
    --report --report-path /tmp/whisper_${ep_code}/
done

# 批量验证所有输出
for ep_num in $(seq 1 12); do
  ep_code=$(printf "10%02d" $ep_num)
  srt_file="/tmp/whisper_${ep_code}/${ep_code}.srt"
  if [ ! -s "$srt_file" ]; then
    echo "❌ ${ep_code}: 输出为空，需要重新跑"
  else
    echo "✅ ${ep_code}: $(wc -l < "$srt_file") 行"
  fi
done
```

### 第三步：用 ffsubsync 以 Whisper SRT 为参考对齐

**关键：用 Whisper 生成的 SRT 作为参考（而非直接用视频文件）**，这样对齐精度更高：

```bash
/Users/weiwei/Library/Python/3.9/bin/ffs /tmp/whisper_{集数}/{集数}.srt \
  -i /tmp/{集数}.en.srt -o /tmp/{集数}.en.synced.srt

/Users/weiwei/Library/Python/3.9/bin/ffs /tmp/whisper_{集数}/{集数}.srt \
  -i /tmp/{集数}.zh.srt -o /tmp/{集数}.zh.synced.srt
```

完成后告知用户对齐结果（offset seconds 和 score）。

### 第四步：生成缩略图

在 60、90、120、180、240 秒处各截一帧，计算亮度，选最亮的：

```bash
for t in 60 90 120 180 240; do
  ffmpeg -y -ss $t -i ~/Documents/Videos/S10/{集数}.mp4 -vframes 1 /tmp/thumb_$t.jpg -loglevel quiet
  brightness=$(ffmpeg -i /tmp/thumb_$t.jpg -vf "scale=16:16,format=gray" -f rawvideo -pix_fmt gray pipe:1 2>/dev/null \
    | od -A n -t u1 | awk '{for(i=1;i<=NF;i++) sum+=$i; n+=NF} END{print int(sum/n)}')
  echo "t=${t}s brightness=${brightness}"
done
```

用亮度最高的时间点生成最终缩略图：
```bash
ffmpeg -y -ss {最亮时间} -i ~/Documents/Videos/S10/{集数}.mp4 -vframes 1 /tmp/{集数}_thumb.jpg -loglevel quiet
```

### 第五步：上传视频和缩略图到服务器

```bash
scp ~/Documents/Videos/S10/{集数}.mp4 ubuntu@3.252.132.90:~/EchoLine/videos/ && \
ssh ubuntu@3.252.132.90 "chmod 644 ~/EchoLine/videos/{集数}.mp4"

scp /tmp/{集数}_thumb.jpg ubuntu@3.252.132.90:~/EchoLine/videos/
```

**chmod 644 是必须的**，不改权限视频无法播放。

### 第六步：保存字幕并上传到服务器

将对齐后的字幕保存到本地输出目录，并上传到服务器：

```bash
# 保存到工作目录
cp /tmp/{集数}.en.synced.srt ~/Documents/Videos/Subtitle/{集数}.en.srt
cp /tmp/{集数}.zh.synced.srt ~/Documents/Videos/Subtitle/{集数}.zh.srt

# 上传到服务器
scp ~/Documents/Videos/Subtitle/{集数}.en.srt ubuntu@3.252.132.90:~/EchoLine/subtitles/
scp ~/Documents/Videos/Subtitle/{集数}.zh.srt ubuntu@3.252.132.90:~/EchoLine/subtitles/
```

### 第七步：告知用户上架信息并等待测试

告知用户：
1. **视频文件名**：`{集数}.mp4`（填入后台"服务器上已有视频文件名"）
2. **副标题**：查询 Friends S10E{集号} 的英文标题
3. 请用户在后台上架，然后在 iPhone 上测试字幕对齐效果

**等待用户测试反馈。** 如果用户反馈字幕整体偏早或偏晚，可以做全局时间偏移微调：
- 听到上一句尾音 → 字幕偏早，往后移（+0.1~0.2 秒）
- 本句开头被吃掉 → 字幕偏晚，往前移（-0.1~0.2 秒）

微调方法：用 Python 对 SRT 文件所有时间戳统一加减偏移量，然后重新上传到服务器让用户再次测试。可能需要多次微调。

### 第八步：确认满意后同步到 Git

用户确认字幕效果满意后：

```bash
# 复制最终字幕到项目目录
cp ~/Documents/Videos/Subtitle/{集数}.en.srt ~/Documents/PROJECTS/EchoLine/subtitles/
cp ~/Documents/Videos/Subtitle/{集数}.zh.srt ~/Documents/PROJECTS/EchoLine/subtitles/

# 从服务器同步 episodes.json
scp ubuntu@3.252.132.90:~/EchoLine/data/episodes.json ~/Documents/PROJECTS/EchoLine/data/

# 提交并推送到 GitHub
cd ~/Documents/PROJECTS/EchoLine
git add data/episodes.json subtitles/{集数}.en.srt subtitles/{集数}.zh.srt
git commit -m "feat: add S10E{集号} with Whisper-aligned subtitles"
git push origin main
```

**三个地方必须全部同步：本机项目目录、服务器、GitHub。**

提交到 main 后，记得同步 develop 分支：
```bash
git checkout develop && git merge main && git push origin develop && git checkout main
```

## 工具依赖

- `ffmpeg` / `ffprobe`：已安装（通过 Homebrew）
- `ffsubsync`：`/Users/weiwei/Library/Python/3.9/bin/ffs`
- `whisperkit-cli`：`/opt/homebrew/bin/whisperkit-cli`（Apple Silicon Metal GPU 加速，**首选工具**）
- SSH 免密登录：`ubuntu@3.252.132.90`（已配置）

> `openai-whisper`（`/Users/weiwei/Library/Python/3.9/bin/whisper`）仍然存在，但速度极慢（CPU only），不要使用。
> `faster-whisper` 已安装但在 macOS 后台运行时会被系统静默 kill，不要使用。

## 注意事项

- 上传大视频前先确认文件存在：`ls ~/Documents/Videos/S10/{集数}.mp4`
- 上传视频可能需要几分钟，正常等待
- Whisper 跑 medium 模型大约需要 5-10 分钟，可在后台运行
- ASS 文件编码不固定，需自动检测（尝试 utf-16 → utf-8-sig → utf-8）
- ffsubsync score 越高越好，offset 越小说明原字幕时间轴本来就接近
- 字幕文件如果不是 ASS 格式（如已是 SRT），跳过解析步骤，直接从第二步开始
- 中国版视频可能剪掉了部分片段，导致全局偏移无法完美对齐所有字幕。用户测试后如有个别不准的地方，可局部微调
- **每次处理完必须同步三个地方：本机项目目录、服务器、GitHub**
