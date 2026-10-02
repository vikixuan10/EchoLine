#!/usr/bin/env python3
"""
中文字幕分行与英文不同（如 S10E12：英文 634 行、中文 472 行，一行中文常对应两行英文）时，
按双语 ASS 里带的英文原句，把每行中文配到英文 SRT 的一行或连续几行上：
  - 配到一行：中文直接套用那行英文的时间码
  - 配到连续几行：把这几行英文先合成一句（字幕组的译者本来就把它当一句翻的），中文套合并后的时间码
产出覆盖 subtitles/{集数}.en.srt 与 .zh.srt（Git 跟踪，可回退）。之后照常跑 merge_cues.py 再按规则合并半句。

用法：python3 tools/rebuild_zh_by_text.py 1012 "{Friends}/Subtitle/Original/Friends.S10E12.chs&eng.ass"
"""
import re, sys, os, difflib

MAX_SPAN = 3      # 一行中文最多跨几行英文
MIN_RATIO = 0.72  # 英文文本相似度门槛

def dec(raw):
    if raw[:3] == b'\xef\xbb\xbf': return raw[3:].decode('utf-8')
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'): return raw.decode('utf-16')
    for enc in ('utf-8', 'gbk', 'gb2312'):
        try: return raw.decode(enc)
        except Exception: pass
    return raw.decode('latin-1')

def clean(s): return re.sub(r'\{[^}]*\}', '', s).replace('\\N', ' ').strip()

def load_ass_bilingual(path):
    out = []
    for l in dec(open(path, 'rb').read()).splitlines():
        if not l.startswith('Dialogue'): continue
        txt = l.split(',', 9)[9]
        if '{\\r}\\N' in txt:
            zh, en = txt.split('{\\r}\\N', 1)
        else:
            zh, en = txt, ''
        out.append({'zh': clean(zh), 'en': clean(en)})
    return out

def parse_time(s):
    h, m, rest = s.split(':'); sec, ms = re.split(r'[,.]', rest)
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000

def fmt_time(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def load_srt(path):
    out = []
    for b in re.split(r'\n\s*\n', open(path, encoding='utf-8-sig').read().strip()):
        ls = b.split('\n'); m = re.match(r'(\S+) --> (\S+)', ls[1])
        out.append({'start': parse_time(m.group(1)), 'end': parse_time(m.group(2)), 'text': ' '.join(x.strip() for x in ls[2:])})
    return out

def write_srt(path, entries):
    with open(path, 'w', encoding='utf-8') as f:
        for i, e in enumerate(entries, 1):
            f.write(f"{i}\n{fmt_time(e['start'])} --> {fmt_time(e['end'])}\n{e['text']}\n\n")

def norm(s):
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'^[A-Z][A-Z .]+:\s*', '', s)          # 去掉 PHOEBE: 这类说话人前缀
    return re.sub(r'[^a-z0-9 ]', '', s.lower().replace("'", '')).strip()

def main():
    ep, ass_path = sys.argv[1], sys.argv[2]
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    en_path = os.path.join(root, 'subtitles', f'{ep}.en.srt')
    zh_path = os.path.join(root, 'subtitles', f'{ep}.zh.srt')
    en = load_srt(en_path)
    bi = [b for b in load_ass_bilingual(ass_path) if b['en'] and re.search('[A-Za-z]', b['en'])]
    en_norm = [norm(e['text']) if re.search('[A-Za-z]', e['text']) else '' for e in en]

    # 顺序往前配：对每行中文，在英文当前位置附近试 1~MAX_SPAN 行的拼接，取相似度最高的
    j = 0
    spans = {}      # 英文起始行号 -> (跨几行, 中文)
    unmatched = []
    for b in bi:
        target = norm(b['en'])
        best = None
        for k in range(j, min(j + 12, len(en))):
            if not en_norm[k]: continue
            for span in range(1, MAX_SPAN + 1):
                if k + span > len(en): break
                cand = ' '.join(x for x in en_norm[k:k + span] if x)
                r = difflib.SequenceMatcher(None, target, cand).ratio()
                # 跨行拼接要明显更像才算，防止把下一句也吞进来
                if r >= MIN_RATIO and (best is None or r > best[0] + (0.03 if span > best[1] else 0)):
                    best = (r, span, k)
        if best is None:
            unmatched.append(b); continue
        r, span, k = best
        spans[k] = (span, b['zh'])
        j = k + span

    # 按跨行信息重排英文：跨几行的合成一句
    new_en, new_zh = [], []
    i = 0
    merged_rows = 0
    while i < len(en):
        if i in spans:
            span, zh = spans[i]
            grp = en[i:i + span]
            text = ' '.join(x['text'] for x in grp)
            text = re.sub(r'\.\.\. \.\.\.', ' ', text)
            new_en.append({'start': grp[0]['start'], 'end': grp[-1]['end'], 'text': text})
            new_zh.append({'start': grp[0]['start'], 'end': grp[-1]['end'], 'text': zh})
            if span > 1: merged_rows += 1
            i += span
        else:
            new_en.append(dict(en[i])); i += 1
    write_srt(en_path, new_en)
    write_srt(zh_path, new_zh)
    print(f'{ep}：中文 {len(bi)} 行，配上 {len(bi) - len(unmatched)} 行（其中 {merged_rows} 行跨多行英文、已把英文合成一句），没配上 {len(unmatched)} 行')
    print(f'英文 {len(en)} 行 → {len(new_en)} 行；中文写出 {len(new_zh)} 行')
    for b in unmatched[:12]:
        print('   没配上:', b['en'][:70], '|', b['zh'][:30])

if __name__ == '__main__':
    main()
