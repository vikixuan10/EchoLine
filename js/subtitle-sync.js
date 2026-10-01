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

  // 干净切句：
  // 1) iOS 跳转后会吃掉开头一小段声音，所以提前起跳；提前的那一段静音，播到句首才出声，
  //    不带进上一句的尾音。循环跳回句首也一样
  // 2) 循环时句尾不越过下一句的起点
  // 以下两个数是 2026-10-01 在 iPhone 外放上实测定的，网址加 ?lead=1 或 ?ml=0.25 可临时改，方便在手机上调
  var urlParams = new URLSearchParams(window.location.search);
  var leadParam = parseFloat(urlParams.get('lead'));
  var mlParam = parseFloat(urlParams.get('ml'));
  // iPhone 上「静音 / 出声」的指令要过约 0.3 秒才听得出效果，所以两个指令都提前这么久发
  var muteLatency = !isNaN(mlParam) ? mlParam : (isIOS ? 0.3 : 0);
  // 提前起跳多久。0.3 秒的延迟只在播放稳定后成立，刚跳转完指令几乎立刻见效，
  // 所以要留够时间让播放稳下来再发「出声」：实测 0.5 会带进上一句尾音，0.8 和 1 效果相同
  var seekLead = !isNaN(leadParam) ? leadParam : (isIOS ? 0.8 : 0);
  if (muteLatency > 0) seekLead = Math.max(seekLead, muteLatency + 0.2);
  var TAIL_PAD = 0.15;      // 句尾留的余量
  var unmuteAt = -1;        // >= 0 表示正在静音预热，播到这个时间发「出声」指令
  var tailHoldEnd = -1;     // >= 0 表示句尾已提前静音，值是这一句真正的截止时间
  var holding = false;      // 当前是否由我们按着静音
  var mutedBefore = false;  // 我们按静音之前，用户自己是否静音

  function holdSound() {
    if (!holding) { mutedBefore = video.muted; holding = true; }
    video.muted = true;
  }

  function releaseSound() {
    if (holding) { video.muted = mutedBefore; holding = false; }
    unmuteAt = -1;
    tailHoldEnd = -1;
  }

  // 这一句最晚播到哪：句尾留余量，但不越过下一句的起点
  function cutEnd(index) {
    var end = cues[index].end;
    for (var j = index + 1; j < cues.length; j++) {
      // 译注与正文同时间，跳过它找真正的下一句
      if (cues[j].start >= end - 0.05) {
        return Math.min(end + TAIL_PAD, Math.max(end, cues[j].start));
      }
    }
    return end + TAIL_PAD;
  }

  // 跳到某句句首：提前起跳并静音，播到句首再出声
  function seekToCue(index) {
    var start = cues[index].start;
    var target = Math.max(0, start - seekLead);
    if (target < start) {
      holdSound();
      tailHoldEnd = -1;
      unmuteAt = Math.max(0, start - muteLatency); // 不能为负，负数会被当成「没在预热」
    } else if (holding) {
      releaseSound();
    }
    player.seekTo(target);
  }

  // 该出声时出声：播到句首（扣掉指令延迟）恢复声音；用户自己把进度拖到别处也恢复
  function restoreSoundIfDue(time) {
    if (unmuteAt >= 0) {
      if (time >= unmuteAt || time < unmuteAt - seekLead - 0.5) releaseSound();
    } else if (tailHoldEnd >= 0) {
      // 句尾静音后本该马上跳回；若没跳（切了模式、拖了进度），别一直静音下去
      if (time > tailHoldEnd + 0.3 || time < tailHoldEnd - muteLatency - 0.3) releaseSound();
    }
  }

  // 循环：播到句尾就跳回 startIndex 的句首，跳了返回 true。
  // 句尾的「静音」指令提前发，真正到句尾再跳
  function loopIfDue(time, endIndex, startIndex) {
    var end = cutEnd(endIndex);
    if (muteLatency > 0 && unmuteAt < 0 && tailHoldEnd < 0 && time > end - muteLatency && time <= end) {
      holdSound();
      tailHoldEnd = end;
    }
    if (time <= end) return false;
    seekToCue(startIndex);
    return true;
  }

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
    restoreSoundIfDue(time);

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
      if (clipLoop) return; // 小文件在循环，视频是停着的，不管
      loopIfDue(time, currentIndex, currentIndex);
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
      if (clipLoop) return;
      var lo = Math.min(loopAIndex, loopBIndex);
      var hi = Math.max(loopAIndex, loopBIndex);
      if (loopIfDue(time, hi, lo) && seekLead > 0) {
        // 提前起跳期间高亮先停在 A 句，免得闪到 A 的上一句
        seekLockIndex = lo;
        currentIndex = lo;
        player.setCurrentIndex(lo);
      }
    }
  }

  function goToIndex(index) {
    if (index < 0 || index >= cues.length) return;
    currentIndex = index;
    if (seekLead > 0) seekLockIndex = index; // 提前起跳期间锁定高亮到目标字幕
    seekToCue(index);
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

  // --- 小文件循环（?dev=1 且本集有 clips 时）---

  var clipLoop = false; // 当前是否由小文件在循环

  function clips() { return global.EchoLine && global.EchoLine.clips; }

  // 用小文件循环第 lo 到 hi 句；本集没有小文件返回 false，调用方走旧办法
  function startClipLoop(lo, hi) {
    var c = clips();
    if (!c || !c.isAvailable()) return false;
    releaseSound();
    seekLockIndex = -1;
    // 画面停在这句开头，声音从小文件出
    if (video) { video.pause(); video.currentTime = cues[lo].start; }
    var ok = c.playRange(lo, hi, true, function (idx) {
      currentIndex = idx;
      player.setCurrentIndex(idx);
      if (Date.now() - lastUserScroll > scrollDebounceMs) player.scrollToIndex(idx);
    }, null);
    clipLoop = ok;
    return ok;
  }

  function stopClipLoop() {
    if (!clipLoop) return;
    clipLoop = false;
    var c = clips();
    if (c) c.stop();
  }

  function setMode(m) {
    var wasClipLoop = clipLoop;
    stopClipLoop();
    mode = m;
    // 句尾已提前静音但还没跳回时切了模式：把声音还回去
    if (tailHoldEnd >= 0 && video) releaseSound();
    // 从小文件循环切回正常：视频从这句接着放
    if (wasClipLoop && m === 'normal' && currentIndex >= 0) {
      seekLockIndex = seekLead > 0 ? currentIndex : -1;
      seekToCue(currentIndex);
    }
    if (m === 'single' && currentIndex >= 0) startClipLoop(currentIndex, currentIndex);
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
    restartABClipLoop();
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
    restartABClipLoop();
  }

  // A、B 都定了就用小文件开始循环；改了 A 或 B 就重来
  function restartABClipLoop() {
    stopClipLoop();
    if (mode === 'ab' && loopAIndex >= 0 && loopBIndex >= 0) {
      startClipLoop(Math.min(loopAIndex, loopBIndex), Math.max(loopAIndex, loopBIndex));
    }
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
    // 换集时若还停在静音预热里，先把声音还回去
    if (video) releaseSound();
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
      player.video.removeEventListener('play', onVideoPlayDuringClipLoop);
      player.video.addEventListener('play', startRaf);
      player.video.addEventListener('pause', stopRaf);
      player.video.addEventListener('ended', stopRaf);
      player.video.addEventListener('play', onVideoPlayDuringClipLoop);
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

  // 小文件循环时用户按了视频自己的播放键：交还给视频，回到正常模式
  function onVideoPlayDuringClipLoop() {
    if (!clipLoop) return;
    clipLoop = false;
    var c = clips();
    if (c) c.stop();
    mode = 'normal';
    if (btnModeNormal) btnModeNormal.classList.add('active');
    if (btnModeSingle) btnModeSingle.classList.remove('active');
    if (btnModeAb) btnModeAb.classList.remove('active');
    if (abControls) abControls.style.display = 'none';
    clearAB();
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
