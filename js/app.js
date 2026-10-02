/**
 * 用户端：剧集列表、进入播放页、加载对应集视频与字幕
 */

(function (global) {
  'use strict';

  var EPISODES_URL = 'data/episodes.json';
  var PAGE_URL = 'index.html';
  var episodeListPage = document.getElementById('episode-list-page');
  var playerPage = document.getElementById('player-page');
  var episodeListEl = document.getElementById('episode-list');
  var emptyHint = document.getElementById('empty-hint');
  var backToList = document.getElementById('back-to-list');
  var video = document.getElementById('video');

  var subtitleModeSelect = document.getElementById('subtitle-mode-select');

  var episodes = [];
  var episodesText = null;    // 上次取到的剧集列表原文，没变就不重画
  var currentCues = [];
  var loadedPage = null;      // 打开时服务器上的首页内容，用来判断之后有没有上过新版
  var updatePending = null;   // 发现有新版时记下服务器上的首页内容；在播放页时等回到列表再刷新

  function showPage(id) {
    episodeListPage.classList.toggle('active', id === 'episode-list-page');
    playerPage.classList.toggle('active', id === 'player-page');
  }

  function loadEpisodes() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', EPISODES_URL + '?t=' + Date.now());
    xhr.onload = function () {
      var text = xhr.responseText || '[]';
      if (text === episodesText) return;                        // 列表没变，不重画
      if (episodesText !== null && xhr.status !== 200) return;  // 刷新时出错，保留现有列表
      episodesText = text;
      try {
        episodes = JSON.parse(text);
      } catch (e) {
        episodes = [];
      }
      episodes.sort(function (a, b) {
        // 提取标题中的数字部分排序（如 S10E14 → 1014）
        var na = parseInt((a.title.match(/\d+/g) || []).join(''), 10);
        var nb = parseInt((b.title.match(/\d+/g) || []).join(''), 10);
        return (isNaN(na) ? Infinity : na) - (isNaN(nb) ? Infinity : nb);
      });
      renderEpisodeList();
    };
    xhr.onerror = function () {
      if (episodesText !== null) return;                        // 刷新时没网，保留现有列表
      episodes = [];
      renderEpisodeList();
    };
    xhr.send();
  }

  // 自动更新。从主屏幕图标打开时，iPhone 要么接着上次的画面继续（页面不重新加载），
  // 要么直接用手机里存的旧首页（不向服务器要），上线的新版就一直看不到。
  // 所以每次打开、每次回到前台、每次回到列表，都向服务器取一次首页，两种情况算有新版：
  //   1. 服务器首页引用的脚本 / 样式（带 ?v=）当前页面里没有：这一页是手机缓存里的旧版；
  //   2. 首页内容和上次取到的不一样：页面开着的时候上过线。
  // 有新版就重新加载整页（重新加载会向服务器要首页）。在播放页时不打断，先记下，等回到列表再刷新。
  // 没有新版就只刷新剧集列表（新上的集）。
  function checkForUpdate() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', PAGE_URL + '?t=' + Date.now());
    xhr.onload = function () {
      var text = xhr.responseText;
      if (xhr.status !== 200 || !text) return;
      var stale = pageIsStale(text);
      if (!stale && loadedPage === null) { loadedPage = text; return; }
      var onList = episodeListPage.classList.contains('active');
      if (stale || text !== loadedPage) {
        updatePending = text;
        if (onList) reloadOnce();
      } else if (onList) {
        loadEpisodes();
      }
    };
    xhr.send();
  }

  // 服务器首页引用的脚本 / 样式，当前页面里是不是都有；缺一个就说明这一页是旧版
  function pageIsStale(serverPage) {
    var sel = 'script[src], link[rel="stylesheet"]';
    var have = {};
    var nodes = document.querySelectorAll(sel);
    var i;
    for (i = 0; i < nodes.length; i++) {
      have[nodes[i].getAttribute('src') || nodes[i].getAttribute('href')] = true;
    }
    var want = new DOMParser().parseFromString(serverPage, 'text/html').querySelectorAll(sel);
    for (i = 0; i < want.length; i++) {
      if (!have[want[i].getAttribute('src') || want[i].getAttribute('href')]) return true;
    }
    return false;
  }

  // 为同一版首页只自动重载一次：万一重载后拿到的还是旧页面，不会没完没了地转
  function reloadOnce() {
    var s = updatePending, h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    var mark = s.length + ':' + h;
    try {
      if (sessionStorage.getItem('echoline-reloaded-for') === mark) return;
      sessionStorage.setItem('echoline-reloaded-for', mark);
    } catch (e) {}
    window.location.reload();
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
      if (global.EchoLine.clips) global.EchoLine.clips.setEpisode(ep, cues);
      global.EchoLine.player.renderSubtitles(cues, getSubtitleMode());
      global.EchoLine.subtitleSync.init(cues);
      // 初始化跟读模块
      if (global.EchoLine.shadowing) {
        global.EchoLine.shadowing.init(cues);
      }
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
    checkForUpdate();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForUpdate();
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) checkForUpdate();
    });
    if (backToList) {
      backToList.addEventListener('click', function (e) {
        e.preventDefault();
        if (video) video.pause();
        if (global.EchoLine.clips) global.EchoLine.clips.stop();
        // 重置跟读模块（释放麦克风等资源）
        if (global.EchoLine.shadowing) {
          global.EchoLine.shadowing.reset();
        }
        showPage('episode-list-page');
        if (updatePending) reloadOnce();
        else checkForUpdate();
      });
    }
    if (subtitleModeSelect) {
      subtitleModeSelect.addEventListener('change', function () {
        if (currentCues.length > 0) {
          // 重置跟读模块（renderSubtitles 会重建 DOM，面板会丢失）
          if (global.EchoLine.shadowing) {
            global.EchoLine.shadowing.reset();
          }
          global.EchoLine.player.renderSubtitles(currentCues, getSubtitleMode());
          global.EchoLine.subtitleSync.init(currentCues);
          // 重新初始化跟读模块（reset 会清空 cues，需要重新传入）
          if (global.EchoLine.shadowing) {
            global.EchoLine.shadowing.init(currentCues);
          }
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
