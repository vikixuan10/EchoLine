#!/bin/bash
# 批量逐句对齐：对 data/episodes.json 里的每一集
#   1. 从 Google Drive 本机同步目录取视频，抽 16k 单声道 wav
#   2. whisperkit-cli 逐词转写（已有有效 JSON 则跳过）
#   3. tools/align_subtitles.py 对齐，产出到 $OUT/<集数>/
# 不改 subtitles/ 里的任何文件；确认后再手动复制进去。
# 用法：bash tools/batch_align.sh [集数 ...]   不带参数就跑全部
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
VIDEO_DIR="/Users/weiwei/Library/CloudStorage/GoogleDrive-vikixuan10@gmail.com/我的云端硬盘/Friends/S10"
WORK=/tmp/whisper_batch
OUT=$WORK/out
LOG=$WORK/batch.log
mkdir -p "$OUT"

# 集数 -> 英文字幕 / 中文字幕 路径，从 episodes.json 读
mapping() {
  python3 - "$ROOT/data/episodes.json" <<'EOF'
import json, sys, os
for e in json.load(open(sys.argv[1], encoding='utf-8')):
    if '测试' in e['title']:
        continue
    ep = os.path.splitext(os.path.basename(e['videoUrl']))[0]
    print(ep, e['subtitles'].get('en', ''), e['subtitles'].get('zh', ''))
EOF
}

if [ $# -gt 0 ]; then
  WANT=" $* "
else
  WANT=""
fi

mapping | sort | while read -r ep en zh; do
  if [ -n "$WANT" ] && [[ "$WANT" != *" $ep "* ]]; then continue; fi
  echo "[$(date '+%H:%M:%S')] START $ep" | tee -a "$LOG"
  d=$WORK/$ep; mkdir -p "$d"
  json=$d/$ep.json

  # 已有有效 JSON 就不重跑转写
  valid=0
  if [ -s "$json" ]; then
    valid=$(python3 -c "import json,sys; d=json.load(open('$json')); print(sum(len(s.get('words') or []) for s in d.get('segments',[])))" 2>/dev/null || echo 0)
  fi
  if [ "${valid:-0}" -lt 500 ]; then
    if [ ! -f "$VIDEO_DIR/$ep.mp4" ]; then
      echo "[$(date '+%H:%M:%S')] FAIL $ep 找不到视频" | tee -a "$LOG"; continue
    fi
    ffmpeg -nostdin -y -v error -i "$VIDEO_DIR/$ep.mp4" -vn -ac 1 -ar 16000 "$d/$ep.wav" || { echo "[$(date '+%H:%M:%S')] FAIL $ep 抽音频失败" | tee -a "$LOG"; continue; }
    whisperkit-cli transcribe --audio-path "$d/$ep.wav" --model whisper-medium --language en \
      --word-timestamps --report --report-path "$d/" < /dev/null > "$d/whisper.log" 2>&1
    valid=$(python3 -c "import json,sys; d=json.load(open('$json')); print(sum(len(s.get('words') or []) for s in d.get('segments',[])))" 2>/dev/null || echo 0)
    if [ "${valid:-0}" -lt 500 ]; then
      # whisperkit 可能静默输出空文件，重跑一次
      echo "[$(date '+%H:%M:%S')] RETRY $ep whisper 词数 $valid" | tee -a "$LOG"
      whisperkit-cli transcribe --audio-path "$d/$ep.wav" --model whisper-medium --language en \
        --word-timestamps --report --report-path "$d/" < /dev/null > "$d/whisper.log" 2>&1
      valid=$(python3 -c "import json,sys; d=json.load(open('$json')); print(sum(len(s.get('words') or []) for s in d.get('segments',[])))" 2>/dev/null || echo 0)
      if [ "${valid:-0}" -lt 500 ]; then echo "[$(date '+%H:%M:%S')] FAIL $ep whisper 输出异常（词数 $valid）" | tee -a "$LOG"; continue; fi
    fi
  fi

  mkdir -p "$OUT/$ep"
  if python3 tools/align_subtitles.py "$ep" "$en" "$json" "$OUT/$ep" ${zh:+"$zh"} < /dev/null > "$OUT/$ep/summary.txt" 2>&1; then
    echo "[$(date '+%H:%M:%S')] DONE $ep $(sed -n 2p "$OUT/$ep/summary.txt")" | tee -a "$LOG"
  else
    echo "[$(date '+%H:%M:%S')] FAIL $ep 对齐脚本出错，见 $OUT/$ep/summary.txt" | tee -a "$LOG"
  fi
done
echo "[$(date '+%H:%M:%S')] ALL DONE" | tee -a "$LOG"
