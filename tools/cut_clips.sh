#!/usr/bin/env bash
# 按字幕把一集的声音切成每句一个小文件：clips/{集数}/{序号}.m4a（序号 = 字幕条号，4 位补零）
# 单句循环 / AB 循环 / 跟读重播直接放小文件，不再在视频里跳转。字幕改了就重跑一次。
# 用法：bash tools/cut_clips.sh 0808 [英文字幕路径]   文件名不规整的集把 episodes.json 里写的英文字幕路径传进来
# 产物不进 Git（.gitignore 里有 clips/），用 scp 传到服务器 ~/EchoLine/clips/{集数}/
set -euo pipefail
cd "$(dirname "$0")/.."
ep=${1:-}
[[ "$ep" =~ ^[0-9]{4}$ ]] || { echo "用法：bash tools/cut_clips.sh 0808（四位集数）[英文字幕路径]"; exit 1; }

FRIENDS="$HOME/Library/CloudStorage/GoogleDrive-vikixuan10@gmail.com/我的云端硬盘/Friends"
video="$FRIENDS/S$((10#${ep:0:2}))/$ep.mp4"     # 集数前两位是季号，季目录不补零
srt="${2:-subtitles/$ep.en.srt}"
[ -f "$video" ] || { echo "找不到视频 $video"; exit 1; }
[ -f "$srt" ] || { echo "找不到字幕 $srt"; exit 1; }

out="clips/$ep"
tmp="/tmp/whisper_batch/$ep"; mkdir -p "$tmp" "$out"
wav="$tmp/$ep.44k.wav"
# 先整集抽成 wav，再从 wav 上切：切点按采样精确，比直接从 mp4 切快得多
[ -s "$wav" ] || ffmpeg -nostdin -y -v error -i "$video" -vn -ac 1 -ar 44100 "$wav"

# 每条字幕一行：序号 起点 时长 淡出起点
n=0
while read -r idx start dur fade_st; do
  ffmpeg -nostdin -y -v error -ss "$start" -t "$dur" -i "$wav" \
    -af "afade=t=in:st=0:d=0.015,afade=t=out:st=$fade_st:d=0.015" \
    -c:a aac -b:a 64k "$out/$idx.m4a"
  n=$((n+1))
done < <(python3 - "$srt" <<'EOF'
import re, sys
def t(s):
    h, m, r = s.split(':'); sec, ms = r.split(','); return int(h)*3600 + int(m)*60 + int(sec) + int(ms)/1000
txt = open(sys.argv[1], encoding='utf-8-sig').read().strip()
for i, b in enumerate(re.split(r'\n\s*\n', txt), 1):
    ls = b.split('\n'); m = re.match(r'(\S+) --> (\S+)', ls[1])
    s, e = t(m.group(1)), t(m.group(2)); d = max(e - s, 0.2)
    print(f"{i:04d} {s:.3f} {d:.3f} {max(d - 0.015, 0):.3f}")
EOF
)
echo "$ep：切出 $n 个小文件 → $out/（共 $(du -sh "$out" | cut -f1)）"
