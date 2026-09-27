/**
 * 字幕联动：点击字幕 → seek；timeupdate → 高亮；三态模式（正常/单句循环/AB循环）
 */

(function (global) {
  'use strict';

  var player = global.EchoLine && global.EchoLine.player;
  var video = player && player.video;
  var subtitleListEl = document.getElementById('subtitle-list');

  var btnModeNormal = document.getElementById('btn-mode-normal');
  var btnModeSingle = document.getElementById('btn-mode-single');
  var btnModeAb = document.getElementById('btn-mode-ab');
  var abControls = document.getElementById('ab-controls');
  var btnSetA = document.getElementById('btn-set-a');
  var btnSetB = document.getElementById('btn-set-b');

  var cues = [];
  var currentIndex = -1;
  var lastUserScroll = 0;
  var scrollDebounceMs = 1500;

  var mode = 'normal'; // 'normal' | 'single' | 'ab'
  var loopAIndex = -1;
  var loopBIndex = -1;

  // iOS 检测（用于 seek 缓冲补偿）
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var seekLockIndex = -1; // 点击字幕后锁定高亮到目标索引，直到播放到达该字幕

  function findIndexByTime(time) {
    for (var i = 0; i < cues.length; i++) {
      if (time >= cues[i].start && time <= cues[i].end) return i;
    }
    for (var j = 0; j < cues.length; j++) {
      if (cues[j].start > time) return Math.max(0, j - 1);
    }
    return cues.length - 1;
  }

  function updateHighlight() {
    if (!player || cues.length === 0) return;
    var time = player.getCurrentTime();

    // 点击字幕后，锁定高亮直到播放位置到达目标字幕
    if (seekLockIndex >= 0) {
      if (time >= cues[seekLockIndex].start) {
        seekLockIndex = -1; // 已到达，解除锁定
      } else {
        return; // 未到达，保持高亮不动
      }
    }

    // 跟读模式展开时，高亮锁定在展开的那一句，不随播放时间变化
    var shadowing = global.EchoLine && global.EchoLine.shadowing;
    var shadowingExpandedIdx = shadowing ? shadowing.getExpandedIndex() : -1;
    if (shadowingExpandedIdx >= 0) {
      if (currentIndex !== shadowingExpandedIdx) {
        currentIndex = shadowingExpandedIdx;
        player.setCurrentIndex(shadowingExpandedIdx);
      }
      return;
    }

    if (mode === 'single' && currentIndex >= 0) {
      if (time > cues[currentIndex].end + 0.15) {
        player.video.currentTime = cues[currentIndex].start;
      }
      return;
    }

    var idx = findIndexByTime(time);
    if (idx !== currentIndex) {
      currentIndex = idx;
      player.setCurrentIndex(idx);
      if (Date.now() - lastUserScroll > scrollDebounceMs) {
        player.scrollToIndex(idx);
      }
    }

    if (mode === 'ab' && loopAIndex >= 0 && loopBIndex >= 0) {
      var lo = Math.min(loopAIndex, loopBIndex);
      var hi = Math.max(loopAIndex, loopBIndex);
      if (time > cues[hi].end + 0.15) {
        player.video.currentTime = cues[lo].start;
      }
    }
  }

  function goToIndex(index) {
    if (index < 0 || index >= cues.length) return;
    currentIndex = index;
    // iOS seek 后有缓冲延迟会吃掉开头几个词，提前 0.5 秒补偿
    var seekTime = isIOS ? Math.max(0, cues[index].start - 0.5) : cues[index].start;
    if (isIOS) seekLockIndex = index; // 锁定高亮到目标字幕
    player.seekTo(seekTime);
    player.setCurrentIndex(index);
    player.scrollToIndex(index);
  }

  function onSubtitleClick(e) {
    var line = e.target.closest('.subtitle-line');
    if (!line || !player) return;
    var index = parseInt(line.dataset.index, 10);
    if (isNaN(index)) return;

    // 跟读模式：委托给 shadowing 模块处理
    var shadowing = global.EchoLine && global.EchoLine.shadowing;
    if (shadowing && shadowing.isActive()) {
      shadowing.onSubtitleClick(index);
      return;
    }

    if (mode === 'single') {
      setMode('normal');
    } else if (mode === 'ab' && loopAIndex >= 0 && loopBIndex >= 0) {
      var lo = Math.min(loopAIndex, loopBIndex);
      var hi = Math.max(loopAIndex, loopBIndex);
      if (index < lo || index > hi) setMode('normal');
    }
    goToIndex(index);
  }

  function onUserScroll() {
    lastUserScroll = Date.now();
  }

  // --- Mode switching ---

  function setMode(m) {
    mode = m;
    // 切换播放模式时，如果跟读模式在激活状态，自动关闭跟读
    var shadowing = global.EchoLine && global.EchoLine.shadowing;
    if (shadowing && shadowing.isActive()) {
      shadowing.deactivate();
    }
    if (btnModeNormal) btnModeNormal.classList.toggle('active', m === 'normal');
    if (btnModeSingle) btnModeSingle.classList.toggle('active', m === 'single');
    if (btnModeAb) btnModeAb.classList.toggle('active', m === 'ab');
    if (abControls) abControls.style.display = m === 'ab' ? '' : 'none';
    if (m !== 'ab') {
      clearAB();
    }
  }

  // --- AB loop ---

  function clearAB() {
    loopAIndex = -1;
    loopBIndex = -1;
    updateABMarkers();
    updateABButtons();
  }

  function updateABMarkers() {
    if (!subtitleListEl) return;
    var lines = subtitleListEl.querySelectorAll('.subtitle-line');
    for (var i = 0; i < lines.length; i++) {
      lines[i].classList.toggle('loop-a', i === loopAIndex);
      lines[i].classList.toggle('loop-b', i === loopBIndex);
    }
  }

  function updateABButtons() {
    if (btnSetA) btnSetA.classList.toggle('set-a', loopAIndex >= 0);
    if (btnSetB) btnSetB.classList.toggle('set-b', loopBIndex >= 0);
  }

  function onSetA() {
    if (currentIndex < 0) return;
    if (loopAIndex === currentIndex) {
      loopAIndex = -1;
    } else {
      loopAIndex = currentIndex;
    }
    sortAB();
    updateABMarkers();
    updateABButtons();
  }

  function onSetB() {
    if (currentIndex < 0) return;
    if (loopBIndex === currentIndex) {
      loopBIndex = -1;
    } else {
      loopBIndex = currentIndex;
    }
    sortAB();
    updateABMarkers();
    updateABButtons();
  }

  function sortAB() {
    if (loopAIndex >= 0 && loopBIndex >= 0 && loopAIndex > loopBIndex) {
      var tmp = loopAIndex;
      loopAIndex = loopBIndex;
      loopBIndex = tmp;
    }
  }

  // --- RAF 补充轮询（解决 iOS timeupdate 触发频率低导致字幕迟到的问题）---

  var rafId = null;

  function startRaf() {
    if (rafId !== null) return;
    function tick() {
      updateHighlight();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // --- Init ---

  function init(cuesList) {
    cues = cuesList || [];
    currentIndex = -1;
    setMode('normal');

    if (subtitleListEl) {
      subtitleListEl.removeEventListener('click', onSubtitleClick);
      subtitleListEl.addEventListener('click', onSubtitleClick);
      subtitleListEl.removeEventListener('scroll', onUserScroll);
      subtitleListEl.addEventListener('scroll', onUserScroll);
    }
    if (player && player.onTimeUpdate) {
      player.onTimeUpdate(updateHighlight);
    }

    // 播放时启动 RAF 轮询，暂停/结束时停止
    if (player && player.video) {
      player.video.removeEventListener('play', startRaf);
      player.video.removeEventListener('pause', stopRaf);
      player.video.removeEventListener('ended', stopRaf);
      player.video.addEventListener('play', startRaf);
      player.video.addEventListener('pause', stopRaf);
      player.video.addEventListener('ended', stopRaf);
    }

    if (btnModeNormal) {
      btnModeNormal.removeEventListener('click', onClickNormal);
      btnModeNormal.addEventListener('click', onClickNormal);
    }
    if (btnModeSingle) {
      btnModeSingle.removeEventListener('click', onClickSingle);
      btnModeSingle.addEventListener('click', onClickSingle);
    }
    if (btnModeAb) {
      btnModeAb.removeEventListener('click', onClickAb);
      btnModeAb.addEventListener('click', onClickAb);
    }
    if (btnSetA) {
      btnSetA.removeEventListener('click', onSetA);
      btnSetA.addEventListener('click', onSetA);
    }
    if (btnSetB) {
      btnSetB.removeEventListener('click', onSetB);
      btnSetB.addEventListener('click', onSetB);
    }

    updateHighlight();
  }

  function onClickNormal() { setMode('normal'); }
  function onClickSingle() { setMode(mode === 'single' ? 'normal' : 'single'); }
  function onClickAb() { setMode(mode === 'ab' ? 'normal' : 'ab'); }

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.subtitleSync = {
    init: init,
    goToIndex: goToIndex,
    getCurrentIndex: function () { return currentIndex; },
    getCues: function () { return cues; }
  };
})(typeof window !== 'undefined' ? window : this);
