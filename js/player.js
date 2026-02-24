/**
 * 播放器：视频容器、playbackRate（0.5～2.0 步长 0.1）、seek、播放/暂停
 */

(function (global) {
  'use strict';

  var SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];

  var video = document.getElementById('video');
  var speedSelect = document.getElementById('speed-select');
  var subtitleListEl = document.getElementById('subtitle-list');

  function initSpeedSelect() {
    speedSelect.innerHTML = '';
    SPEEDS.forEach(function (rate) {
      var opt = document.createElement('option');
      opt.value = rate;
      opt.textContent = rate + 'x';
      if (rate === 1) opt.selected = true;
      speedSelect.appendChild(opt);
    });
    speedSelect.addEventListener('change', function () {
      video.playbackRate = parseFloat(speedSelect.value, 10);
    });
  }

  function setSource(videoUrl) {
    video.src = videoUrl;
    video.load();
    video.playbackRate = parseFloat(speedSelect.value, 10) || 1;
  }

  function seekTo(seconds) {
    video.currentTime = seconds;
    video.play();
  }

  function getCurrentTime() {
    return video.currentTime;
  }

  function onTimeUpdate(callback) {
    video.addEventListener('timeupdate', callback);
  }

  function formatTimestamp(seconds) {
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return (m < 10 ? '0' + m : String(m)) + ':' + (s < 10 ? '0' + s : String(s));
  }

  function renderSubtitles(items, mode) {
    mode = mode || 'en';
    subtitleListEl.innerHTML = '';
    if (!items || items.length === 0) return;
    var getText = global.EchoLine && global.EchoLine.getDisplayText;
    if (!getText) getText = function (item) { return item.textEn || item.text || ''; };
    items.forEach(function (item, index) {
      var div = document.createElement('div');
      div.className = 'subtitle-line';
      div.dataset.index = index;
      div.dataset.start = item.start;
      div.dataset.end = item.end;
      var text = getText(item, mode);
      var tsHtml = '<span class="timestamp">' + formatTimestamp(item.start) + '</span>';
      var innerHtml;
      if (text.indexOf('\n') !== -1) {
        var parts = text.split('\n');
        innerHtml = '<span class="text">' + escapeHtml(parts[0]) + '</span><span class="text-zh">' + escapeHtml(parts[1] || '') + '</span>';
      } else {
        innerHtml = '<span class="text">' + escapeHtml(text) + '</span>';
      }
      div.innerHTML = tsHtml + '<div class="text-wrap">' + innerHtml + '</div>';
      subtitleListEl.appendChild(div);
    });
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function setCurrentIndex(index) {
    var lines = subtitleListEl.querySelectorAll('.subtitle-line');
    lines.forEach(function (el, i) {
      el.classList.toggle('current', i === index);
    });
  }

  function scrollToIndex(index) {
    var lines = subtitleListEl.querySelectorAll('.subtitle-line');
    var el = lines[index];
    if (!el) return;
    subtitleListEl.scrollTo({
      top: el.offsetTop - (subtitleListEl.clientHeight / 2) + (el.clientHeight / 2),
      behavior: 'smooth'
    });
  }

  if (speedSelect) initSpeedSelect();

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.player = {
    video: video,
    setSource: setSource,
    seekTo: seekTo,
    getCurrentTime: getCurrentTime,
    onTimeUpdate: onTimeUpdate,
    renderSubtitles: renderSubtitles,
    setCurrentIndex: setCurrentIndex,
    scrollToIndex: scrollToIndex,
    getSpeedOptions: function () { return SPEEDS; }
  };
})(typeof window !== 'undefined' ? window : this);
