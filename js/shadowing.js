/**
 * EchoLine 跟读模块
 * 功能：在播放页对任一字幕句进行跟读录音、回放对比
 * 第一版：录音 + 回放对比（不含 AI 评分）
 */
(function (global) {
  'use strict';

  var cues = [];          // 当前剧集的字幕数据
  var active = false;     // 跟读模式是否开启
  var expandedIndex = -1; // 当前展开的字幕行索引（-1 = 无）

  // 录音相关状态
  var recordingState = 'idle'; // 'idle' | 'recording' | 'has-recording'
  var mediaRecorder = null;
  var audioChunks = [];
  var blobUrl = null;
  var micStream = null;
  var playbackAudio = null; // 用于播放录音的 Audio 对象

  // DOM 引用
  var btn = document.getElementById('btn-mode-shadowing');
  var video = document.getElementById('video');

  // Feature flag：只有 URL 带 ?dev=1 时才显示跟读按钮
  var devMode = new URLSearchParams(window.location.search).get('dev') === '1';
  if (!devMode && btn) {
    btn.style.display = 'none';
  }

  // 播放边界检查的回调引用（用于移除监听器）
  var boundaryCheckBound = null;

  // 字幕模式下拉框引用
  var subtitleModeSelect = document.getElementById('subtitle-mode-select');

  // --- 模式切换 ---

  function toggle() {
    if (active) {
      deactivate();
    } else {
      // 只有英文字幕模式才能启用跟读
      var currentMode = subtitleModeSelect ? subtitleModeSelect.value : 'en';
      if (currentMode !== 'en') {
        alert('跟读功能仅在英文字幕模式下可用，请先切换到英文字幕。');
        return;
      }
      activate();
    }
  }

  // 其他三个模式按钮的引用
  var btnNormal = document.getElementById('btn-mode-normal');
  var btnSingle = document.getElementById('btn-mode-single');
  var btnAb = document.getElementById('btn-mode-ab');

  function activate() {
    active = true;
    if (btn) btn.classList.add('active');
    // 取消其他三个按钮的高亮
    if (btnNormal) btnNormal.classList.remove('active');
    if (btnSingle) btnSingle.classList.remove('active');
    if (btnAb) btnAb.classList.remove('active');

    // 如果当前有高亮的字幕，自动展开它
    var sync = global.EchoLine && global.EchoLine.subtitleSync;
    if (sync) {
      var currentIdx = sync.getCurrentIndex();
      if (currentIdx >= 0 && currentIdx < cues.length) {
        expandLine(currentIdx);
        // 注册边界检查，播完当前句自动暂停
        startBoundaryCheck();
      }
    }
  }

  function deactivate() {
    collapseLine();
    active = false;
    if (btn) btn.classList.remove('active');
    // 恢复"正常"按钮高亮
    if (btnNormal) btnNormal.classList.add('active');
  }

  // 更新跟读按钮的可用状态（英文字幕时可用，其他模式灰色禁用）
  function updateBtnState() {
    if (!btn || !devMode) return;
    var currentMode = subtitleModeSelect ? subtitleModeSelect.value : 'en';
    if (currentMode !== 'en') {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      // 如果正在跟读模式，自动关闭
      if (active) deactivate();
    } else {
      btn.disabled = false;
      btn.style.opacity = '';
    }
  }

  // --- 字幕点击处理（由 subtitle-sync.js 委托调用） ---

  function onSubtitleClick(index) {
    if (index < 0 || index >= cues.length) return;

    // 如果点的是已展开的同一行，收起
    if (index === expandedIndex) {
      collapseLine();
      return;
    }

    // 收起旧的，展开新的
    collapseLine();
    expandLine(index);

    // 自动播放该句原声
    replayOriginal(index);
  }

  // --- 展开/收起面板 ---

  function expandLine(index) {
    var lineEl = document.querySelector('.subtitle-line[data-index="' + index + '"]');
    if (!lineEl) return;

    expandedIndex = index;
    lineEl.classList.add('shadowing-expanded');

    // 创建并注入面板 DOM（放在 .text-wrap 里面，避免挤压字幕文字）
    var panel = createPanel(index);
    var textWrap = lineEl.querySelector('.text-wrap');
    if (textWrap) {
      textWrap.appendChild(panel);
    } else {
      lineEl.appendChild(panel);
    }

    // 滚动到可见（使用 player 的方法，只滚动字幕列表，不影响视频区域）
    var player = global.EchoLine && global.EchoLine.player;
    if (player && player.scrollToIndex) {
      player.scrollToIndex(index);
    }

    // 注册播放边界检查
    startBoundaryCheck();
  }

  function collapseLine() {
    if (expandedIndex < 0) return;

    // 停止录音（如果正在录）
    if (recordingState === 'recording') {
      stopRecording();
    }

    // 停止录音回放
    if (playbackAudio) {
      playbackAudio.pause();
      playbackAudio = null;
    }

    // 释放录音资源
    cleanupRecording();

    // 移除面板 DOM（面板在 .text-wrap 内部）
    var lineEl = document.querySelector('.subtitle-line[data-index="' + expandedIndex + '"]');
    if (lineEl) {
      lineEl.classList.remove('shadowing-expanded');
      var panel = lineEl.querySelector('.shadowing-panel');
      if (panel) panel.parentNode.removeChild(panel);
    }

    // 移除边界检查
    stopBoundaryCheck();

    expandedIndex = -1;
    recordingState = 'idle';
  }

  // --- 创建面板 DOM ---

  function createPanel(index) {
    var panel = document.createElement('div');
    panel.className = 'shadowing-panel';

    var buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'shadowing-buttons';

    // 重播原声按钮
    var replayBtn = document.createElement('button');
    replayBtn.type = 'button';
    replayBtn.className = 'shadowing-btn';
    replayBtn.textContent = '▶️ 重播原声';
    replayBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      replayOriginal(index);
    });
    buttonsDiv.appendChild(replayBtn);

    // 检查是否支持录音
    var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var isSecure = window.isSecureContext;

    if (canRecord && isSecure) {
      // 录音按钮
      var recordBtn = document.createElement('button');
      recordBtn.type = 'button';
      recordBtn.className = 'shadowing-btn';
      recordBtn.textContent = '🎤 录音';
      recordBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (recordingState === 'idle' || recordingState === 'has-recording') {
          startRecording(recordBtn, buttonsDiv);
        } else if (recordingState === 'recording') {
          stopRecording(recordBtn, buttonsDiv);
        }
      });
      buttonsDiv.appendChild(recordBtn);
    } else {
      // 不支持录音时显示提示
      var hint = document.createElement('span');
      hint.className = 'shadowing-unsupported';
      if (!isSecure) {
        hint.textContent = '🔒 需要 HTTPS 才能录音';
      } else {
        hint.textContent = '此浏览器不支持录音';
      }
      buttonsDiv.appendChild(hint);
    }

    panel.appendChild(buttonsDiv);
    return panel;
  }

  // --- 重播原声 ---

  function replayOriginal(index) {
    if (!video || index < 0 || index >= cues.length) return;

    // 停止录音回放（如果正在播）
    if (playbackAudio) {
      playbackAudio.pause();
    }

    var cue = cues[index];
    // iOS 需要提前 0.5 秒补偿缓冲延迟
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var seekTime = isIOS ? Math.max(0, cue.start - 0.5) : cue.start;

    video.currentTime = seekTime;
    video.play();
  }

  // --- 播放边界控制：播完当前句自动暂停 ---

  function startBoundaryCheck() {
    stopBoundaryCheck();
    boundaryCheckBound = function () {
      if (expandedIndex < 0 || expandedIndex >= cues.length) return;
      var cue = cues[expandedIndex];
      if (video.currentTime > cue.end + 0.15) {
        video.pause();
      }
    };
    video.addEventListener('timeupdate', boundaryCheckBound);
  }

  function stopBoundaryCheck() {
    if (boundaryCheckBound) {
      video.removeEventListener('timeupdate', boundaryCheckBound);
      boundaryCheckBound = null;
    }
  }

  // --- 录音功能 ---

  function startRecording(recordBtn, buttonsDiv) {
    // 先清理旧录音
    cleanupRecording();

    // 移除旧的播放按钮和录音指示器
    removePlaybackBtn(buttonsDiv);
    removeRecordingIndicator(buttonsDiv.parentNode);

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        micStream = stream;

        // 检测支持的录音格式
        var mimeType = 'audio/webm';
        if (typeof MediaRecorder.isTypeSupported === 'function') {
          if (!MediaRecorder.isTypeSupported('audio/webm')) {
            mimeType = 'audio/mp4'; // iOS Safari 降级
          }
        }

        audioChunks = [];
        try {
          mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
        } catch (e) {
          // 如果指定格式不行，用默认格式
          mediaRecorder = new MediaRecorder(stream);
        }

        mediaRecorder.ondataavailable = function (e) {
          if (e.data.size > 0) {
            audioChunks.push(e.data);
          }
        };

        mediaRecorder.onstop = function () {
          var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
          blobUrl = URL.createObjectURL(blob);
          recordingState = 'has-recording';

          // 更新按钮状态
          recordBtn.className = 'shadowing-btn';
          recordBtn.textContent = '🎤 重新录音';

          // 移除录音指示器
          removeRecordingIndicator(buttonsDiv.parentNode);

          // 添加播放录音按钮
          addPlaybackBtn(buttonsDiv);

          // 释放麦克风（录完即释放）
          releaseMic();
        };

        mediaRecorder.start();
        recordingState = 'recording';

        // 更新按钮外观
        recordBtn.className = 'shadowing-btn recording';
        recordBtn.textContent = '⏹ 停止';

        // 添加录音指示器
        addRecordingIndicator(buttonsDiv.parentNode);
      })
      .catch(function (err) {
        console.warn('麦克风权限被拒绝或不可用:', err);
        alert('无法访问麦克风，请检查浏览器权限设置。');
      });
  }

  function stopRecording(recordBtn, buttonsDiv) {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop(); // 会触发 onstop 回调
    }
  }

  function playRecording() {
    if (!blobUrl) return;

    // 暂停视频原声（避免混在一起）
    if (video && !video.paused) {
      video.pause();
    }

    if (playbackAudio) {
      playbackAudio.pause();
    }

    playbackAudio = new Audio(blobUrl);
    playbackAudio.play();
  }

  function cleanupRecording() {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
    audioChunks = [];
    mediaRecorder = null;
  }

  function releaseMic() {
    if (micStream) {
      micStream.getTracks().forEach(function (track) {
        track.stop();
      });
      micStream = null;
    }
  }

  // --- 面板内的辅助 DOM 操作 ---

  function addPlaybackBtn(buttonsDiv) {
    removePlaybackBtn(buttonsDiv);
    var playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'shadowing-btn playback-btn';
    playBtn.textContent = '▶️ 播放录音';
    playBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      playRecording();
    });
    buttonsDiv.appendChild(playBtn);
  }

  function removePlaybackBtn(buttonsDiv) {
    var existing = buttonsDiv.querySelector('.playback-btn');
    if (existing) buttonsDiv.removeChild(existing);
  }

  function addRecordingIndicator(panel) {
    removeRecordingIndicator(panel);
    var indicator = document.createElement('div');
    indicator.className = 'recording-indicator';
    var dot = document.createElement('span');
    dot.className = 'rec-dot';
    indicator.appendChild(dot);
    indicator.appendChild(document.createTextNode(' 录音中...'));
    panel.appendChild(indicator);
  }

  function removeRecordingIndicator(panel) {
    if (!panel) return;
    var existing = panel.querySelector('.recording-indicator');
    if (existing) panel.removeChild(existing);
  }

  // --- 重置（切换剧集、切换字幕模式、返回列表时调用） ---

  function reset() {
    deactivate();
    releaseMic();
    cues = [];
  }

  // --- 初始化（打开新剧集时由 app.js 调用） ---

  function initModule(cuesList) {
    cues = cuesList || [];
    expandedIndex = -1;
    recordingState = 'idle';

    // 绑定跟读按钮点击事件
    if (btn && devMode) {
      btn.removeEventListener('click', toggle);
      btn.addEventListener('click', toggle);
    }

    // 监听字幕模式切换，更新跟读按钮可用状态
    if (subtitleModeSelect && devMode) {
      subtitleModeSelect.removeEventListener('change', updateBtnState);
      subtitleModeSelect.addEventListener('change', updateBtnState);
    }

    // 初始化时也检查一次按钮状态
    updateBtnState();
  }

  // --- 导出公开 API ---

  global.EchoLine = global.EchoLine || {};
  global.EchoLine.shadowing = {
    init: initModule,
    reset: reset,
    isActive: function () { return active; },
    getExpandedIndex: function () { return expandedIndex; },
    onSubtitleClick: onSubtitleClick,
    deactivate: deactivate
  };

})(typeof window !== 'undefined' ? window : this);
