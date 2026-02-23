/**
 * SRT 解析与显示模式（仅英 / 仅中 / 英+中）
 * 输出 { id, start, end, textEn?, textZh? }[]，按条对齐
 */

(function (global) {
  'use strict';

  function parseTime(s) {
    // 00:01:23,456 -> 83.456
    var m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
    if (!m) return 0;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10), sec = parseInt(m[3], 10), ms = parseInt(m[4].padEnd(3, '0').slice(0, 3), 10);
    return h * 3600 + min * 60 + sec + ms / 1000;
  }

  function parseSrtBlock(block) {
    var lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    var num = parseInt(lines[0], 10);
    if (isNaN(num)) return null;
    var timeLine = lines[1];
    var arrow = timeLine.indexOf(' --> ');
    if (arrow === -1) return null;
    var start = parseTime(timeLine.slice(0, arrow));
    var end = parseTime(timeLine.slice(arrow + 5));
    var text = lines.slice(2).join('\n').trim();
    return { id: num, start: start, end: end, text: text };
  }

  function parseSrt(content) {
    if (!content || typeof content !== 'string') return [];
    var blocks = content.split(/\n\s*\n/);
    var list = [];
    for (var i = 0; i < blocks.length; i++) {
      var item = parseSrtBlock(blocks[i]);
      if (item) list.push(item);
    }
    return list.sort(function (a, b) { return a.start - b.start; });
  }

  /**
   * 合并双轨（英+中）：按序号或时间对齐，返回 { start, end, textEn?, textZh? }[]
   */
  function mergeTracks(englishList, chineseList) {
    if (!chineseList || chineseList.length === 0) {
      return englishList.map(function (e) {
        return { id: e.id, start: e.start, end: e.end, textEn: e.text, textZh: null };
      });
    }
    var en = englishList.slice();
    var zh = chineseList.slice();
    var result = [];
    var i = 0, j = 0;
    while (i < en.length) {
      var e = en[i];
      var z = zh[j];
      if (z && Math.abs(z.start - e.start) < 2) {
        result.push({ id: e.id, start: e.start, end: e.end, textEn: e.text, textZh: z.text });
        j++;
      } else {
        result.push({ id: e.id, start: e.start, end: e.end, textEn: e.text, textZh: null });
      }
      i++;
    }
    return result;
  }

  /**
   * 显示模式：'en' | 'zh' | 'both'
   */
  function getDisplayText(item, mode) {
    if (mode === 'zh') return item.textZh || item.textEn || '';
    if (mode === 'both') {
      var en = item.textEn || '';
      var zh = item.textZh || '';
      return zh ? en + '\n' + zh : en;
    }
    return item.textEn || '';
  }

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.parseSrt = parseSrt;
  global.EchoLine.mergeTracks = mergeTracks;
  global.EchoLine.getDisplayText = getDisplayText;
})(typeof window !== 'undefined' ? window : this);
