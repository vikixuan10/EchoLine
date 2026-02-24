/**
 * 用户端：剧集列表、进入播放页、加载对应集视频与字幕
 */

(function (global) {
  'use strict';

  var EPISODES_URL = 'data/episodes.json';
  var episodeListPage = document.getElementById('episode-list-page');
  var playerPage = document.getElementById('player-page');
  var episodeListEl = document.getElementById('episode-list');
  var emptyHint = document.getElementById('empty-hint');
  var backToList = document.getElementById('back-to-list');
  var video = document.getElementById('video');

  var subtitleModeSelect = document.getElementById('subtitle-mode-select');

  var episodes = [];
  var currentCues = [];

  function showPage(id) {
    episodeListPage.classList.toggle('active', id === 'episode-list-page');
    playerPage.classList.toggle('active', id === 'player-page');
  }

  function loadEpisodes() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', EPISODES_URL + '?t=' + Date.now());
    xhr.onload = function () {
      try {
        episodes = JSON.parse(xhr.responseText || '[]');
      } catch (e) {
        episodes = [];
      }
      episodes.sort(function (a, b) {
        var na = parseInt(a.title, 10);
        var nb = parseInt(b.title, 10);
        return (isNaN(na) ? Infinity : na) - (isNaN(nb) ? Infinity : nb);
      });
      renderEpisodeList();
    };
    xhr.onerror = function () {
      episodes = [];
      renderEpisodeList();
    };
    xhr.send();
  }

  function renderEpisodeList() {
    episodeListEl.innerHTML = '';
    if (episodes.length === 0) {
      emptyHint.classList.remove('hidden');
      return;
    }
    emptyHint.classList.add('hidden');
    var thumbTargets = [];
    episodes.forEach(function (ep, i) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'episode-link';
      a.href = '#play-' + i;

      var thumbDiv = document.createElement('div');
      thumbDiv.className = 'episode-thumb';
      if (ep.thumbUrl) {
        thumbDiv.style.backgroundImage = 'url(' + ep.thumbUrl + ')';
        thumbDiv.classList.add('loaded');
      } else {
        thumbDiv.dataset.videoUrl = ep.videoUrl || '';
      }

      var info = document.createElement('div');
      info.className = 'episode-info';
      info.innerHTML = '<span class="title">' + (ep.title || '第' + (i + 1) + '集') + '</span>' +
        (ep.subtitle ? '<span class="meta">' + escapeHtml(ep.subtitle) + '</span>' : '');

      a.appendChild(thumbDiv);
      a.appendChild(info);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        openEpisode(i);
      });
      li.appendChild(a);
      episodeListEl.appendChild(li);
      if (!ep.thumbUrl && ep.videoUrl) thumbTargets.push(thumbDiv);
    });
    lazyLoadThumbnails(thumbTargets);
  }

  function lazyLoadThumbnails(targets) {
    if (!targets.length) return;
    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) { captureThumbnail(el); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          captureThumbnail(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '200px' });
    targets.forEach(function (el) { observer.observe(el); });
  }

  var THUMB_TIMES = [2, 5, 8, 12, 18, 30];
  var BRIGHTNESS_THRESHOLD = 25;

  function captureThumbnail(el) {
    var url = el.dataset.videoUrl;
    if (!url) return;
    var vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.preload = 'metadata';
    vid.playsInline = true;
    vid.src = url;
    var attempt = 0;
    var canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    var ctx = canvas.getContext('2d');

    function tryCapture() {
      try {
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        var sum = 0;
        for (var i = 0; i < data.length; i += 16) {
          sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        var avg = sum / (data.length / 16);
        if (avg < BRIGHTNESS_THRESHOLD && attempt < THUMB_TIMES.length - 1) {
          attempt++;
          vid.currentTime = THUMB_TIMES[attempt];
          return;
        }
        el.style.backgroundImage = 'url(' + canvas.toDataURL('image/jpeg', 0.7) + ')';
        el.classList.add('loaded');
      } catch (_) {}
      vid.src = '';
      vid.load();
    }

    vid.addEventListener('loadeddata', function () {
      vid.currentTime = THUMB_TIMES[0];
    });
    vid.addEventListener('seeked', tryCapture);
  }

  function escapeHtml(s) {
    if (!s) return '';
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function getSubtitleMode() {
    return subtitleModeSelect ? subtitleModeSelect.value : 'en';
  }

  function openEpisode(index) {
    var ep = episodes[index];
    if (!ep || !ep.videoUrl) return;
    showPage('player-page');
    if (subtitleModeSelect) subtitleModeSelect.value = 'en';
    global.EchoLine.player.setSource(ep.videoUrl);
    loadSubtitlesForEpisode(ep, function (cues) {
      currentCues = cues;
      global.EchoLine.player.renderSubtitles(cues, getSubtitleMode());
      global.EchoLine.subtitleSync.init(cues);
    });
  }

  function loadSubtitlesForEpisode(ep, callback) {
    var mode = ep.subtitleMode || 'en';
    var enUrl = ep.subtitles && ep.subtitles.en;
    var zhUrl = ep.subtitles && ep.subtitles.zh;
    if (!enUrl && !zhUrl) {
      callback([]);
      return;
    }
    if (!enUrl) {
      fetchOne(zhUrl, function (zhCues) {
        var merged = (zhCues || []).map(function (c) {
          return { start: c.start, end: c.end, textEn: null, textZh: c.text };
        });
        callback(merged);
      });
      return;
    }
    fetchOne(enUrl, function (enCues) {
      if (!zhUrl) {
        var list = (enCues || []).map(function (c) {
          return { start: c.start, end: c.end, textEn: c.text, textZh: null };
        });
        callback(list);
        return;
      }
      fetchOne(zhUrl, function (zhCues) {
        var merged = global.EchoLine.mergeTracks(enCues || [], zhCues || []);
        callback(merged);
      });
    });
  }

  function fetchOne(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url + '?t=' + Date.now());
    xhr.onload = function () {
      var list = global.EchoLine.parseSrt(xhr.responseText || '');
      callback(list);
    };
    xhr.onerror = function () { callback([]); };
    xhr.send();
  }

  function init() {
    loadEpisodes();
    if (backToList) {
      backToList.addEventListener('click', function (e) {
        e.preventDefault();
        if (video) video.pause();
        showPage('episode-list-page');
      });
    }
    if (subtitleModeSelect) {
      subtitleModeSelect.addEventListener('change', function () {
        if (currentCues.length > 0) {
          global.EchoLine.player.renderSubtitles(currentCues, getSubtitleMode());
          global.EchoLine.subtitleSync.init(currentCues);
        }
      });
    }
    var hash = window.location.hash || '';
    var m = /#play-(\d+)/.exec(hash);
    if (m) openEpisode(parseInt(m[1], 10));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.app = { loadEpisodes: loadEpisodes, openEpisode: openEpisode };
})(typeof window !== 'undefined' ? window : this);
