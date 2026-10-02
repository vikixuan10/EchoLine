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
  python3 tools/merge_cues.py 0808 --table 候选.md    把候选清单写成给 Weiwei 看的表格（可与 --list 同用）
  python3 tools/merge_cues.py 1016 --en subtitles/episode_1.en.srt --zh subtitles/episode_1.zh.srt
                                                     文件名不规整的集（按 data/episodes.json 里写的路径给）

中文跟着英文合：中英配对用的是播放器显示时同一套办法（按顺序、起点相差 2 秒内就算一对），
所以合并后的中文正是用户现在看到的那几行拼起来；两个半句之间留两个空格（字幕组表示停顿的写法），
半句尾的「...」「，」去掉；译文本身不改。中文 SRT 的时间码与英文一一相同。改写的文件由 Git 跟踪，可随时回退。
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
    def opt(name):
        return args[args.index(name) + 1] if name in args else None
    skip = set(int(x) for x in (opt('--skip') or '').split(',') if x)
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    en_path = os.path.join(root, opt('--en') or f'subtitles/{ep}.en.srt')
    zh_path = os.path.join(root, opt('--zh') or f'subtitles/{ep}.zh.srt')
    en = load_srt(en_path)
    zh = load_srt(zh_path) if os.path.exists(zh_path) else []

    # 中英配对：与 js/subtitles.js 的 mergeTracks 完全一样（按顺序走，起点相差 2 秒内算一对），
    # 这样合并后的中文就是用户现在屏幕上看到的那几行拼起来；S10E12 的中文时间轴与英文对不上，只能这样配
    pair = {}
    j = 0
    for i, e in enumerate(en):
        if j < len(zh) and abs(zh[j]['start'] - e['start']) < 2:
            pair[i] = zh[j]; j += 1
    zh_unpaired = len(zh) - j
    idx_of = {id(e): i for i, e in enumerate(en)}
    def zh_for(e): return pair.get(idx_of[id(e)])

    groups = group_cues(en)
    cand = [g for g in groups if len(g) > 1]
    print(f'{ep}：原 {len(en)} 条，候选合并 {len(cand)} 处，跳过 {sorted(skip) or "无"}')
    for k, g in enumerate(cand, 1):
        mark = '跳过' if k in skip else '合并'
        print(f"  {k:2d} [{mark}] {fmt_time(g[0]['start'])[3:-4]}  {join_en([x['text'] for x in g])[:90]}")
    if zh_unpaired: print(f'  注意：中文有 {zh_unpaired} 条配不上英文（播放器里本来也不显示），合并后会丢掉')
    table = opt('--table')
    if table:
        num = {id(e): i + 1 for i, e in enumerate(en)}
        rows = ['# {} 字幕合并候选（{} 处）'.format(ep, len(cand)), '',
                '规则：上一行以「...」结尾且下一行以「...」开头；或上一行没有句末标点、下一行小写开头、间隔不到 0.6 秒。两人对话行不动。', '',
                '合并后的中文在原来两半之间留两个空格。不同意合并的，在「意见」列写「不合」即可；没写的视为同意。', '',
                '| # | 时间 | 原来的行 | 合并后英文 | 合并后中文 | 时长 | 意见 |', '|---|---|---|---|---|---|---|']
        for k, g in enumerate(cand, 1):
            src = '<br>'.join(f"{num[id(x)]}: {x['text']}" for x in g)
            zs = [z['text'] for z in (zh_for(x) for x in g) if z]
            t = g[0]['start']; mm = f'{int(t // 60)}:{t % 60:04.1f}'
            rows.append(f"| {k} | {mm} | {src} | {join_en([x['text'] for x in g])} | {join_zh(zs)} | {g[-1]['end'] - g[0]['start']:.1f} 秒 | |")
        with open(table, 'w', encoding='utf-8') as f: f.write('\n'.join(rows) + '\n')
        print(f'  候选表已写到 {table}')
    if list_only: return

    # 跳过的候选拆回单行
    final = []
    k = 0
    for g in groups:
        if len(g) > 1:
            k += 1
            if k in skip: final.extend([[x] for x in g]); continue
        final.append(g)

    new_en, new_zh = [], []
    for g in final:
        start, end = g[0]['start'], g[-1]['end']
        new_en.append({'start': start, 'end': end, 'text': join_en([x['text'] for x in g])})
        zparts = [z['text'] for z in (zh_for(x) for x in g) if z]
        if zparts:
            new_zh.append({'start': start, 'end': end, 'text': join_zh(zparts)})
    write_srt(en_path, new_en)
    if zh: write_srt(zh_path, new_zh)
    print(f'已写入：英文 {len(new_en)} 条，中文 {len(new_zh)} 条')

if __name__ == '__main__':
    main()
