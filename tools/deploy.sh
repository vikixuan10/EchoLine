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
# 脚本从标准输入喂给服务器上的 bash，里面任何一步失败都会停下，不会走到「上线完成」
ssh "$SERVER" bash -s <<'REMOTE'
set -eu
cd ~/EchoLine
before=$(git rev-parse HEAD)
git fetch -q
target=$(git rev-parse '@{u}')   # 即将拉取的提交，下面核对与合并都认这一个

# 后台上架会直接改 data/episodes.json、往 subtitles/ 写新字幕，服务器的 Git 把它们当成未提交改动，
# 拉取含同样文件的提交会被拒。这里逐个核对内容指纹：与即将拉取的提交一致的才 git add
# （只登记进暂存区，文件内容不动），拉取就能通过。对不上的只提示、不拦：快进合并不会覆盖
# 服务器上的改动，真冲突时 Git 自己会拒绝，那时再停下。
same=()
mismatch=()
while IFS= read -r -d '' entry; do
  f=${entry:3}
  want=$(git rev-parse -q --verify "$target:$f" || true)
  have=""
  if [ -e "$f" ]; then have=$(git hash-object -- "$f"); fi
  if [ "$have" = "$want" ]; then
    # 两边都没有这个文件（服务器已删、提交里也删了）就不用登记
    if [ -n "$have" ]; then same+=("$f"); fi
    continue
  fi
  # 对不上：写明差在哪，以及本次提交改没改这个文件（改了，拉取才会碰它）
  if [ -z "$want" ]; then why="服务器上有，即将拉取的提交里没有"
  elif [ -z "$have" ]; then why="服务器上已删除，即将拉取的提交里还有"
  else why="两边内容不同"
  fi
  if git --literal-pathspecs diff --quiet "$before" "$target" -- "$f"; then
    if [ -n "$have" ]; then effect="本次提交没改它，拉取不会动它"; else effect="本次提交没改它，拉取后仍是删除状态"; fi
  else
    if [ -n "$have" ]; then effect="本次提交也改了它，Git 不会覆盖，拉取会被拒绝"; else effect="本次提交改了它，拉取时会被写回服务器"; fi
  fi
  mismatch+=("$f（$why；$effect）")
done < <(git status --porcelain --no-renames -z --untracked-files=all -- data/episodes.json subtitles)

if [ ${#same[@]} -gt 0 ]; then
  git --literal-pathspecs add -- "${same[@]}"
  echo "服务器上这些未提交的文件与本次提交内容一致，已 git add："
  printf '  %s\n' "${same[@]}"
fi
if [ ${#mismatch[@]} -gt 0 ]; then
  echo "提示：服务器上这些文件与即将拉取的提交 ${target:0:7} 对不上，记得把两边同步："
  printf '  %s\n' "${mismatch[@]}"
fi

if ! git merge -q --ff-only "$target"; then
  echo "合并失败，已停下。代码已推到 GitHub，但服务器还没拉取，服务器上的文件没有被改动。"
  if [ ${#mismatch[@]} -gt 0 ]; then
    echo "先把下面对不上的文件两边改成一致，再重新运行："
    printf '  %s\n' "${mismatch[@]}"
  fi
  exit 1
fi
after=$(git rev-parse HEAD)
echo "服务器 ${before:0:7} -> ${after:0:7}"
if git diff --name-only "$before" "$after" | grep -qx server.js; then
  pm2 restart echoline >/dev/null </dev/null && echo "server.js 有改动，已重启"
else
  echo "server.js 未变，不重启"
fi
REMOTE
echo "上线完成"
