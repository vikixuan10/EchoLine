#!/usr/bin/env python3
"""
把字幕组为了控制行宽拆开的半句合回一句，让「一行 = 一句话」，点句、循环、切音频都以它为单位。

合并规则（2026-10-01 与 Weiwei 定）：
  1. 上一行以「...」结尾，且下一行以「...」开头
  2. 上一行没有句末标点（. ? !），下一行以小写字母开头，两行间隔不到 0.6 秒
  两人对话行（「- Why me? - Hey...」）不动；译注行（没有英文）不动，也不跨译注合并；不设长度上限。

用法：
  python3 tools/merge_cues.py 0808 --list            只打印候选清单，不改文件
  python3 tools/merge_cues.py 0808                   直接改写 subtitles/0808.en.srt 与 .zh.srt
  python3 tools/merge_cues.py 0808 --skip 3,7        候选清单里第 3、7 处不合并

中文跟着英文合：两个半句之间留两个空格（字幕组表示停顿的写法），半句尾的「...」「，」去掉；
译文本身不改。中文 SRT 的时间码与英文一一相同。改写的文件由 Git 跟踪，可随时回退。
"""
import re, sys, os, bisect

GAP_MAX = 0.6

def parse_time(s):
    h, m, rest = s.split(':')
    sec, ms = re.split(r'[,.]', rest)
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000

def fmt_time(t):
    ms = int(round(max(t, 0) * 1000))
    h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def load_srt(path):
    txt = open(path, encoding='utf-8-sig').read()
    out = []
    for b in re.split(r'\n\s*\n', txt.strip()):
        lines = b.strip().split('\n')
        if len(lines) < 2: continue
        m = re.match(r'\s*(\S+)\s*-->\s*(\S+)', lines[1])
        if not m: continue
        out.append({'start': parse_time(m.group(1)), 'end': parse_time(m.group(2)), 'text': ' '.join(l.strip() for l in lines[2:]).strip()})
    return out

def write_srt(path, entries):
    with open(path, 'w', encoding='utf-8') as f:
        for i, e in enumerate(entries, 1):
            f.write(f"{i}\n{fmt_time(e['start'])} --> {fmt_time(e['end'])}\n{e['text']}\n\n")

def is_english(t): return bool(re.search(r'[A-Za-z]', t))
def ends_open(t): return not re.search(r'[.?!]["\']?$', t.strip())

def should_merge(prev, cur):
    """返回合并原因，不该合返回 None"""
    if not is_english(prev['text']) or not is_english(cur['text']): return None
    if cur['text'].lstrip().startswith('-'): return None          # 对话行不动
    gap = cur['start'] - prev['end']
    if prev['text'].rstrip().endswith('...') and cur['text'].lstrip().startswith('...'): return '省略号'
    if ends_open(prev['text']) and cur['text'].strip()[0].islower() and gap < GAP_MAX: return '未完句'
    return None

def group_cues(en):
    groups = [[en[0]]]
    for cur in en[1:]:
        if should_merge(groups[-1][-1], cur): groups[-1].append(cur)
        else: groups.append([cur])
    return groups

def join_en(parts):
    return re.sub(r'\.\.\. \.\.\.', ' ', ' '.join(p.strip() for p in parts))

def join_zh(parts):
    out = []
    for i, z in enumerate(parts):
        z = z.strip()
        if i < len(parts) - 1: z = re.sub(r'(\.\.\.|…|，|,)$', '', z)
        if i > 0: z = re.sub(r'^(\.\.\.|…)', '', z)
        out.append(z)
    return '  '.join(p for p in out if p)

def main():
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        print(__doc__); sys.exit(1)
    ep = args[0]
    list_only = '--list' in args
    skip = set()
    if '--skip' in args:
        skip = set(int(x) for x in args[args.index('--skip') + 1].split(',') if x)
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    en_path = os.path.join(root, 'subtitles', f'{ep}.en.srt')
    zh_path = os.path.join(root, 'subtitles', f'{ep}.zh.srt')
    en = load_srt(en_path)
    zh = load_srt(zh_path) if os.path.exists(zh_path) else []
    zh_starts = [z['start'] for z in zh]
    zh_taken = set()  # 一条中文只能配一条英文：译注与正文同时间，别把正文的中文复制给译注

    def zh_for(e):
        k = bisect.bisect_left(zh_starts, e['start'] - 0.03)
        for j in (k, k + 1, k - 1):
            if 0 <= j < len(zh) and j not in zh_taken and abs(zh[j]['start'] - e['start']) < 0.05 and abs(zh[j]['end'] - e['end']) < 0.05:
                zh_taken.add(j)
                return zh[j]
        return None

    groups = group_cues(en)
    cand = [g for g in groups if len(g) > 1]
    print(f'{ep}：原 {len(en)} 条，候选合并 {len(cand)} 处，跳过 {sorted(skip) or "无"}')
    for k, g in enumerate(cand, 1):
        mark = '跳过' if k in skip else '合并'
        print(f"  {k:2d} [{mark}] {fmt_time(g[0]['start'])[3:-4]}  {join_en([x['text'] for x in g])[:90]}")
    if list_only: return

    # 跳过的候选拆回单行
    final = []
    k = 0
    for g in groups:
        if len(g) > 1:
            k += 1
            if k in skip: final.extend([[x] for x in g]); continue
        final.append(g)

    new_en, new_zh, zh_used = [], [], 0
    for g in final:
        start, end = g[0]['start'], g[-1]['end']
        new_en.append({'start': start, 'end': end, 'text': join_en([x['text'] for x in g])})
        zparts = [zh_for(x) for x in g]
        zparts = [z['text'] for z in zparts if z]
        if zparts:
            zh_used += len(zparts)
            new_zh.append({'start': start, 'end': end, 'text': join_zh(zparts)})
    write_srt(en_path, new_en)
    if zh:
        write_srt(zh_path, new_zh)
        if zh_used != len(zh): print(f'  注意：中文 {len(zh)} 条里有 {len(zh) - zh_used} 条没找到对应英文行，已丢弃，请检查')
    print(f'已写入：英文 {len(new_en)} 条，中文 {len(new_zh)} 条')

if __name__ == '__main__':
    main()
