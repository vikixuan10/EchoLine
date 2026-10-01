/**
 * 单句音频：每句一个预先切好的小文件（clips/{集数}/{序号}.m4a，序号 = 字幕条号）。
 * 单句循环 / AB 循环 / 跟读重播直接放小文件，从头放到尾，不再在视频里跳转，
 * 也就没有关键帧、跳转延迟、各设备不一致这些问题。
 * 试验中：URL 带 ?dev=1 且该集在服务器上有 clips 目录时才启用，否则一切照旧。
 */

(function (global) {
  'use strict';

  var devMode = new URLSearchParams(window.location.search).get('dev') === '1';
  var video = document.getElementById('video');
  var speedSelect = document.getElementById('speed-select');

  var audio = new Audio();
  audio.preload = 'auto';

  var base = null;        // 本集 clips 目录，如 'clips/0808/'
  var available = false;  // 探测到小文件存在才为 true
  var seq = null;         // 正在放的范围 { lo, hi, cur, loop, onIndex, onDone }
  var timer = null;
  var GAP = 0.25;         // 循环时两遍之间停多久（秒）

  function pad(n) { return ('0000' + n).slice(-4); }
  function clipUrl(index) { return base + pad(index + 1) + '.m4a'; }

  // 进入一集时调用：按视频文件名推出 clips 目录，探测第一个小文件在不在
  function setEpisode(ep) {
    stop();
    available = false;
    base = null;
    if (!devMode || !ep || !ep.videoUrl) return;
    var name = ep.videoUrl.split('/').pop().replace(/\.[^.]+$/, '');
    var dir = 'clips/' + name + '/';
    var xhr = new XMLHttpRequest();
    xhr.open('GET', dir + pad(1) + '.m4a'); // 第一个小文件只有二十来 KB，直接取一次当探测
    xhr.onload = function () {
      if (xhr.status === 200) { base = dir; available = true; }
    };
    xhr.send();
  }

  // 放第 lo 到 hi 句（含）。loop 为 true 则放完回到 lo 再来；onIndex 在每句开始时回调，onDone 在不循环且放完时回调。
  // 返回 false 表示本集没有小文件，调用方按旧办法处理。
  function playRange(lo, hi, loop, onIndex, onDone) {
    if (!available) return false;
    stop();
    seq = { lo: lo, hi: hi, cur: lo, loop: loop, onIndex: onIndex, onDone: onDone };
    video.pause();
    playCurrent();
    return true;
  }

  function playCurrent() {
    if (!seq) return;
    audio.src = clipUrl(seq.cur);
    audio.playbackRate = video.playbackRate || 1;
    if (seq.onIndex) seq.onIndex(seq.cur);
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
  }

  audio.addEventListener('ended', function () {
    if (!seq) return;
    if (seq.cur < seq.hi) { seq.cur++; playCurrent(); return; }
    if (seq.loop) { seq.cur = seq.lo; timer = setTimeout(playCurrent, GAP * 1000); return; }
    var done = seq.onDone;
    stop();
    if (done) done();
  });

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    seq = null;
    if (!audio.paused) audio.pause();
  }

  // 用户直接按了视频的播放键：把小文件停掉，交还给视频
  if (video) video.addEventListener('play', function () { if (seq) stop(); });
  if (speedSelect) speedSelect.addEventListener('change', function () {
    audio.playbackRate = parseFloat(speedSelect.value) || 1;
  });

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.clips = {
    setEpisode: setEpisode,
    isAvailable: function () { return available; },
    isPlaying: function () { return !!seq; },
    playRange: playRange,
    stop: stop
  };
})(typeof window !== 'undefined' ? window : this);
