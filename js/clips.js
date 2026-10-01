/**
 * 单句音频：每句一个预先切好的小文件（clips/{集数}/{序号}.m4a，序号 = 字幕条号）。
 * 单句循环 / AB 循环 / 跟读重播直接放小文件，从头放到尾，不再在视频里跳转，
 * 也就没有关键帧、跳转延迟、各设备不一致这些问题。
 * 进一集就把小文件逐个预取到本地（一集约 7MB），按下去直接从本地放，不用等网络。
 * 放小文件时视频静音跟着放，画面有动静；画面可能比声音慢一点，循环时画面跳回去也慢一点，声音不受影响。
 * 该集在服务器上有 clips 目录就启用（2026-10-01 起对所有人生效），没有的集一切照旧。
 */

(function (global) {
  'use strict';

  var PICTURE_FOLLOWS = true;   // 放小文件时视频是否静音跟着放；false 则画面停在句首
  var GAP = 0.25;               // 循环时两遍之间停多久（秒）
  var PREFETCH_PARALLEL = 2;    // 后台预取同时取几个

  var video = document.getElementById('video');
  var speedSelect = document.getElementById('speed-select');

  var audio = new Audio();
  audio.preload = 'auto';

  var base = null;        // 本集 clips 目录，如 'clips/0808/'
  var available = false;  // 探测到小文件存在才为 true
  var cues = [];
  var seq = null;         // 正在放的范围 { lo, hi, cur, loop, onIndex, onDone }
  var timer = null;
  var cache = {};         // 序号 -> 本地 blob 地址
  var inflight = {};      // 序号 -> 正在取的 Promise
  var epToken = 0;        // 换集后作废旧的预取
  var expectPlay = false; // 我们自己让视频播放时置 true，区分用户按的播放键
  var mutedBefore = null; // 让视频静音之前用户自己的静音状态
  var onTakeover = null;  // 用户按了视频播放键时通知调用方

  function pad(n) { return ('0000' + n).slice(-4); }
  function clipUrl(index) { return base + pad(index + 1) + '.m4a'; }

  // 取一个小文件到本地，返回 Promise<blob 地址>；已有就直接给
  function fetchClip(index, token) {
    if (cache[index]) return Promise.resolve(cache[index]);
    if (inflight[index]) return inflight[index];
    var p = fetch(clipUrl(index)).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.blob();
    }).then(function (blob) {
      delete inflight[index];
      if (token !== epToken) return null;      // 已经换集了，不要
      cache[index] = URL.createObjectURL(blob);
      return cache[index];
    }).catch(function () { delete inflight[index]; return null; });
    inflight[index] = p;
    return p;
  }

  // 预取当前句和后面两句（点句、高亮变化时调用）
  function warm(index) {
    if (!available) return;
    for (var i = index; i < Math.min(index + 3, cues.length); i++) fetchClip(i, epToken);
  }

  // 后台把整集都取下来，几个几个地取，不挤占正在放的
  function prefetchAll(token) {
    var next = 0;
    function worker() {
      if (token !== epToken || next >= cues.length) return;
      var i = next++;
      fetchClip(i, token).then(worker);
    }
    for (var k = 0; k < PREFETCH_PARALLEL; k++) worker();
  }

  function clearCache() {
    Object.keys(cache).forEach(function (k) { URL.revokeObjectURL(cache[k]); });
    cache = {};
    inflight = {};
  }

  // 进一集时调用：按视频文件名推出 clips 目录，探测第一个小文件在不在，在就开始预取
  function setEpisode(ep, cueList) {
    stop();
    epToken++;
    clearCache();
    cues = cueList || [];
    available = false;
    base = null;
    if (!ep || !ep.videoUrl) return;
    var name = ep.videoUrl.split('/').pop().replace(/\.[^.]+$/, '');
    var dir = 'clips/' + name + '/';
    var token = epToken;
    fetch(dir + pad(1) + '.m4a').then(function (r) {
      if (!r.ok || token !== epToken) return;
      base = dir;
      available = true;
      prefetchAll(token);
    }).catch(function () {});
  }

  // 放第 lo 到 hi 句（含）。loop 为 true 则放完回到 lo 再来；onIndex 在每句开始时回调，onDone 在不循环且放完时回调。
  // 返回 false 表示本集没有小文件，调用方按旧办法处理。
  function playRange(lo, hi, loop, onIndex, onDone) {
    if (!available) return false;
    stop();
    seq = { lo: lo, hi: hi, cur: lo, loop: loop, onIndex: onIndex, onDone: onDone };
    if (mutedBefore === null) mutedBefore = video.muted;
    video.muted = true;
    playCurrent();
    return true;
  }

  function playCurrent() {
    if (!seq) return;
    var mine = seq, idx = seq.cur;
    if (mine.onIndex) mine.onIndex(idx);
    var startAudio = function (src) {
      if (seq !== mine || seq.cur !== idx) return;
      audio.src = src;
      audio.playbackRate = video.playbackRate || 1;
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
      // 画面：跳到这句开头静音跟着放
      if (PICTURE_FOLLOWS && cues[idx]) {
        video.currentTime = cues[idx].start;
        expectPlay = true;
        var vp = video.play();
        if (vp && vp.catch) vp.catch(function () { expectPlay = false; });
      } else if (cues[idx]) {
        video.pause();
        video.currentTime = cues[idx].start;
      }
    };
    if (cache[idx]) startAudio(cache[idx]);
    else fetchClip(idx, epToken).then(function (src) { startAudio(src || clipUrl(idx)); });
  }

  audio.addEventListener('ended', function () {
    if (!seq) return;
    if (seq.cur < seq.hi) { seq.cur++; playCurrent(); return; }
    if (seq.loop) { seq.cur = seq.lo; timer = setTimeout(playCurrent, GAP * 1000); return; }
    var done = seq.onDone;
    stop();
    if (done) done();
  });

  function stop(keepVideoPlaying) {
    if (timer) { clearTimeout(timer); timer = null; }
    var was = seq;
    seq = null;
    if (!audio.paused) audio.pause();
    if (was) {
      if (!keepVideoPlaying) video.pause();
      if (mutedBefore !== null) { video.muted = mutedBefore; mutedBefore = null; }
    }
  }

  // 视频的 play 事件：是我们自己让它放的就忽略；否则是用户按了播放键，把小文件停掉交还给视频
  if (video) video.addEventListener('play', function () {
    if (expectPlay) { expectPlay = false; return; }
    if (!seq) return;
    stop(true);
    if (onTakeover) onTakeover();
  });
  if (speedSelect) speedSelect.addEventListener('change', function () {
    audio.playbackRate = parseFloat(speedSelect.value) || 1;
  });

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.clips = {
    setEpisode: setEpisode,
    isAvailable: function () { return available; },
    isPlaying: function () { return !!seq; },
    playRange: playRange,
    stop: function () { stop(false); },
    warm: warm,
    onTakeover: function (fn) { onTakeover = fn; }
  };
})(typeof window !== 'undefined' ? window : this);
