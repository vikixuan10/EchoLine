#!/usr/bin/env python3
"""
逐句强制对齐：用 whisperkit 的逐词时间戳，给人工字幕的每一句重新定起止时间。

输入：
  1. 人工英文 SRT（文字为准）
  2. whisperkit --word-timestamps 生成的 JSON 报告（时间为准）
  3. 可选：中文 SRT（时间轴与英文原本一致），会跟着英文一起改时间
输出：
  - <out_dir>/<集数>.en.srt / .zh.srt  对齐后的字幕
  - <out_dir>/<集数>.report.tsv       每句的旧起点 / 新起点 / 偏移 / 匹配情况 / 置信
  - 终端打印摘要

用法：
  python3 tools/align_subtitles.py 1002 subtitles/1002.en.srt /tmp/whisper_batch/1002/1002.json out/ [subtitles/1002.zh.srt]
  批量跑全部剧集用 tools/batch_align.sh
"""
import sys, re, json, difflib, os, bisect, statistics

WORD_DUR = 0.28        # 估算一个词占多长（正常语速约 3.5 词/秒）
STRONG_MIN = 3         # 至少几个词对上才算「强」匹配
NEIGH_TOL = 1.0        # 弱匹配句与邻句偏移差超过这个值就不信它

# ---------- SRT 读写 ----------

def parse_time(s):
    h, m, rest = s.split(':')
    sec, ms = re.split(r'[,.]', rest)
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000

def fmt_time(t):
    ms = int(round(max(t, 0) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def load_srt(path):
    txt = open(path, encoding='utf-8-sig').read()
    out = []
    for b in re.split(r'\n\s*\n', txt.strip()):
        lines = b.strip().split('\n')
        if len(lines) < 2:
            continue
        m = re.match(r'\s*(\S+)\s*-->\s*(\S+)', lines[1])
        if not m:
            continue
        out.append({'start': parse_time(m.group(1)), 'end': parse_time(m.group(2)),
                    'text': '\n'.join(lines[2:]).strip()})
    return out

def write_srt(path, entries):
    with open(path, 'w', encoding='utf-8') as f:
        for i, e in enumerate(entries, 1):
            f.write(f"{i}\n{fmt_time(e['start'])} --> {fmt_time(e['end'])}\n{e['text']}\n\n")

# ---------- 分词 ----------

def tokenize(text):
    """小写、去标点、拆词。撇号缩写保留为一个词（i'm / don't），与 whisper 输出一致。"""
    text = text.replace('’', "'").replace('…', ' ')
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\[[^\]]*\]|\([^)]*\)', ' ', text)   # 去 [Laughter] (audience laughing) 之类
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower())

def is_english(text):
    return bool(re.search(r'[A-Za-z]', text))

# ---------- 读 whisperkit 报告，并剔除时间乱序的词 ----------

def load_whisper_words(path):
    data = json.load(open(path, encoding='utf-8'))
    raw = []
    for seg in data.get('segments', []):
        for w in seg.get('words') or []:
            toks = tokenize(w.get('word', ''))
            if not toks:
                continue
            ws, we = float(w['start']), float(w['end'])
            n = len(toks)
            for k, t in enumerate(toks):
                raw.append({'tok': t, 'start': ws + (we - ws) * k / n, 'end': ws + (we - ws) * (k + 1) / n})
    # whisper 偶尔给某个词标出乱序时间：比后面 3 个词里最早的还晚 1 秒以上（跳到前面去了），
    # 或比前面 3 个词里最晚的还早 1 秒以上（跳回去了），就丢掉。长停顿是单调递增的，不会误伤
    words, dropped = [], 0
    for i, w in enumerate(raw):
        nxt = [raw[j]['start'] for j in range(i + 1, min(len(raw), i + 4))]
        prv = [raw[j]['start'] for j in range(max(0, i - 3), i)]
        if (nxt and w['start'] > min(nxt) + 1.0) or (prv and w['start'] < max(prv) - 1.0):
            dropped += 1
            continue
        words.append(w)
    return words, dropped

# ---------- 对齐 ----------

def align(entries, wwords):
    # 每句 token 及其在总序列里的位置
    seq_tokens, owner = [], []
    for idx, e in enumerate(entries):
        toks = tokenize(e['text']) if is_english(e['text']) else []
        e['ntok'] = len(toks)
        e['first_pos'] = len(seq_tokens)
        for t in toks:
            seq_tokens.append(t)
            owner.append(idx)

    sm = difflib.SequenceMatcher(None, seq_tokens, [w['tok'] for w in wwords], autojunk=False)
    hits = {i: [] for i in range(len(entries))}
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            hits[owner[a + k]].append((a + k, b + k))

    # 第一遍：每个匹配词都能倒推出一个「隐含句首时间」（词时间 - 它在句里的位置 × 每词时长），
    # 取中位数当这句的句首，单个错配词带不偏整句
    for idx, e in enumerate(entries):
        hs = sorted(hits[idx])
        e['matched'] = len(hs)
        e['hits'] = hs
        if not hs:
            e['status'] = 'note' if not is_english(e['text']) else 'miss'
            e['delta'] = None
            continue
        implied = [wwords[w]['start'] - WORD_DUR * (p - e['first_pos']) for p, w in hs]
        est_start = statistics.median(implied)
        e['delta'] = est_start - e['start']
        e['spread'] = (max(implied) - min(implied)) if len(implied) > 1 else 0.0
        e['implied'] = implied
        strong = len(hs) >= STRONG_MIN and e['spread'] < 1.5 and len(hs) / e['ntok'] >= 0.5
        e['status'] = 'strong' if strong else 'weak'

    # 第二遍：弱匹配句与邻近强匹配句的偏移差太多就不信
    strong_idx = [i for i, e in enumerate(entries) if e['status'] == 'strong']
    for idx, e in enumerate(entries):
        if e['status'] != 'weak':
            continue
        k = bisect.bisect_left(strong_idx, idx)
        neigh = [entries[j]['delta'] for j in strong_idx[max(0, k - 2):k + 2]]
        tol = NEIGH_TOL if e['matched'] >= 3 else 0.6
        if neigh and abs(e['delta'] - statistics.median(neigh)) > tol:
            e['status'] = 'miss'

    # 定起止：句首就用第一个匹配词的时间，只在它是「错配到别处的词」时才弃用。
    # 判断错配：它排在上一句已用过的 whisper 词之前；或它和本句下一个匹配词之间夹了 2 个以上别的词 / 隔了 4 秒以上。
    # 这样句内停顿（Well, ... they may be）不会把句首拉后，错配的首词（No 匹到上一句的 No, no, no）也不会把句首拉前。
    cursor = -1
    for idx, e in enumerate(entries):
        if e['status'] not in ('strong', 'weak'):
            continue
        hs = [(p, w) for p, w in e['hits'] if w > cursor]
        def foreign(a, b):
            (p0, w0), (p1, w1) = a, b
            return (w1 - w0) - (p1 - p0) > 1 or wwords[w1]['start'] - wwords[w0]['start'] > 4.0
        while len(hs) >= 2 and foreign(hs[0], hs[1]):
            hs.pop(0)
        while len(hs) >= 2 and foreign(hs[-2], hs[-1]):
            hs.pop()
        if not hs:
            e['status'] = 'miss'
            continue
        p0, w0 = hs[0]
        p1, w1 = hs[-1]
        e['new_start'] = wwords[w0]['start'] - WORD_DUR * (p0 - e['first_pos'])
        e['new_end'] = wwords[w1]['end'] + WORD_DUR * ((e['first_pos'] + e['ntok'] - 1) - p1)
        e['delta'] = e['new_start'] - e['start']
        cursor = w1

    # 没对上的句：按前后可信句等比推算
    ok_idx = [i for i, e in enumerate(entries) if e['status'] in ('strong', 'weak')]
    for i, e in enumerate(entries):
        if e['status'] in ('strong', 'weak'):
            continue
        k = bisect.bisect_left(ok_idx, i)
        prev = ok_idx[k - 1] if k > 0 else None
        nxt = ok_idx[k] if k < len(ok_idx) else None
        dur = e['end'] - e['start']
        if prev is not None and nxt is not None:
            p, q = entries[prev], entries[nxt]
            span = q['start'] - p['start'] or 1e-6
            r = (e['start'] - p['start']) / span
            e['new_start'] = p['new_start'] + r * (q['new_start'] - p['new_start'])
        elif prev is not None:
            e['new_start'] = e['start'] + entries[prev]['new_start'] - entries[prev]['start']
        elif nxt is not None:
            e['new_start'] = e['start'] + entries[nxt]['new_start'] - entries[nxt]['start']
        else:
            e['new_start'] = e['start']
        e['new_end'] = e['new_start'] + dur

    # 译注类（非英文、与前一句同时间）跟随前一句
    for i, e in enumerate(entries):
        if e['status'] == 'note' and i > 0 and abs(e['start'] - entries[i - 1]['start']) < 0.05:
            e['new_start'], e['new_end'] = entries[i - 1]['new_start'], entries[i - 1]['new_end']

    # 收尾：单调、最短时长、不重叠
    warn = []
    for i, e in enumerate(entries):
        if i > 0 and e['new_start'] < entries[i - 1]['new_start'] - 0.05:
            warn.append(i + 1)
            e['new_start'] = entries[i - 1]['new_start']
        if e['new_end'] < e['new_start'] + 0.4:
            e['new_end'] = e['new_start'] + max(0.4, e['end'] - e['start'])
    for i in range(len(entries) - 1):
        a, b = entries[i], entries[i + 1]
        if a['new_end'] > b['new_start'] and abs(a['new_start'] - b['new_start']) > 0.05:
            a['new_end'] = max(a['new_start'] + 0.3, b['new_start'] - 0.02)
    return warn

# ---------- 主流程 ----------

def main():
    ep, en_path, json_path, out_dir = sys.argv[1:5]
    zh_path = sys.argv[5] if len(sys.argv) > 5 else None
    os.makedirs(out_dir, exist_ok=True)

    entries = load_srt(en_path)
    wwords, dropped = load_whisper_words(json_path)
    print(f"字幕 {len(entries)} 句；whisper 词 {len(wwords)} 个（剔除时间乱序的 {dropped} 个）")
    warn = align(entries, wwords)
    cnt = {s: sum(1 for e in entries if e['status'] == s) for s in ('strong', 'weak', 'miss', 'note')}
    print(f"强匹配 {cnt['strong']} 句，弱匹配 {cnt['weak']} 句，推算 {cnt['miss']} 句，译注 {cnt['note']} 句")
    if warn:
        print(f"顺序被强制修正的句子：{warn}")

    rep = os.path.join(out_dir, f"{ep}.report.tsv")
    with open(rep, 'w', encoding='utf-8') as f:
        f.write("序号\t旧起点\t新起点\t起点偏移\t旧终点\t新终点\t终点偏移\t匹配词/总词\t状态\t文本\n")
        for i, e in enumerate(entries, 1):
            d = e['new_start'] - e['start']
            de = e['new_end'] - e['end']
            f.write(f"{i}\t{fmt_time(e['start'])}\t{fmt_time(e['new_start'])}\t{d:+.2f}\t{fmt_time(e['end'])}\t{fmt_time(e['new_end'])}\t{de:+.2f}\t{e['matched']}/{e['ntok']}\t{e['status']}\t{e['text'][:60]!r}\n")

    deltas = [e['new_start'] - e['start'] for e in entries if e['status'] == 'strong']
    big = [(i, e) for i, e in enumerate(entries, 1) if e['status'] == 'strong' and abs(e['new_start'] - e['start']) > 1.0]
    print(f"\n强匹配句偏移：中位数 {statistics.median(deltas):+.2f}s，范围 {min(deltas):+.2f} ~ {max(deltas):+.2f}")
    print(f"偏移超过 1 秒的强匹配句 {len(big)} 句（这些是原字幕真放错的地方）：")
    for i, e in big:
        print(f"  #{i} {fmt_time(e['start'])} -> {fmt_time(e['new_start'])} ({e['new_start'] - e['start']:+.2f}) {e['text'][:50]!r}")
    misses = [(i, e) for i, e in enumerate(entries, 1) if e['status'] == 'miss']
    print(f"\n靠推算的英文句 {len(misses)} 句：")
    for i, e in misses:
        print(f"  #{i} {fmt_time(e['start'])} {e['text'][:50]!r}")

    write_srt(os.path.join(out_dir, f"{ep}.en.srt"),
              [{'start': e['new_start'], 'end': e['new_end'], 'text': e['text']} for e in entries])

    if zh_path:
        zh = load_srt(zh_path)
        starts = [e['start'] for e in entries]
        unmatched = 0
        for z in zh:
            k = bisect.bisect_left(starts, z['start'])
            cands = [c for c in (k - 1, k) if 0 <= c < len(entries)]
            best = min(cands, key=lambda c: abs(entries[c]['start'] - z['start']))
            if abs(entries[best]['start'] - z['start']) < 0.05:
                z['new_start'], z['new_end'] = entries[best]['new_start'], entries[best]['new_end']
            else:
                unmatched += 1
                shift = entries[best]['new_start'] - entries[best]['start']
                z['new_start'], z['new_end'] = z['start'] + shift, z['end'] + shift
        write_srt(os.path.join(out_dir, f"{ep}.zh.srt"),
                  [{'start': z['new_start'], 'end': z['new_end'], 'text': z['text']} for z in zh])
        print(f"\n中文 {len(zh)} 句已跟随改时间，其中 {unmatched} 句没有同时间的英文句、按邻句平移")
    print(f"\n报告：{rep}")

if __name__ == '__main__':
    main()
