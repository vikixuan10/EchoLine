#!/usr/bin/env bash
# 上线：本机 main 推到 GitHub，服务器 git pull 拉下来。用法：bash tools/deploy.sh
# 视频不走这里（不进 Git），仍按 skill 里的 scp 步骤单独传。
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER=ubuntu@3.252.132.90

# 只从 main 上线
branch=$(git branch --show-current)
[ "$branch" = main ] || { echo "当前在 $branch 分支，上线只从 main 推，先合回 main"; exit 1; }

# episodes.json 的真源在服务器（后台上架会改它），先拉回来，有变化就先提交
scp -q "$SERVER:~/EchoLine/data/episodes.json" data/episodes.json
if [ -n "$(git status --porcelain data/episodes.json)" ]; then
  echo "服务器上的 episodes.json 有更新，已拉回本地，先提交它再上线"; exit 1
fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "本地有未提交改动，先提交"; git status -s --untracked-files=no; exit 1; }

git push origin main

# 服务器拉取；只有 server.js 变了才重启 Node，静态文件与字幕改了不用重启
ssh "$SERVER" '
  cd ~/EchoLine
  before=$(git rev-parse HEAD)
  git pull -q --ff-only
  after=$(git rev-parse HEAD)
  echo "服务器 ${before:0:7} -> ${after:0:7}"
  if git diff --name-only "$before" "$after" | grep -qx server.js; then
    pm2 restart echoline >/dev/null && echo "server.js 有改动，已重启"
  else
    echo "server.js 未变，不重启"
  fi
'
echo "上线完成"
