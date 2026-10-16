// 朗读引擎：基于浏览器自带的 speechSynthesis，按段落连续朗读、自动翻章
// 使用方式：const tts = createTTS({ getParas, onPara, onChapterEnd, onStop, getSettings })

const MAX_CHUNK = 160;   // 每次送给语音引擎的字数（太长 iOS/Chrome 可能中途断掉）
const STALL_MS = 6000;   // 超过这么久没有任何声音事件，就认为引擎卡住了，主动跳到下一句

export function splitSentences(text) {
  const parts = text.match(/[^。！？!?；;…\n]+[。！？!?；;…]*[”」』）)]*|[。！？!?；;…]+/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).length > MAX_CHUNK) { out.push(cur); cur = p; }
    else cur += p;
  }
  if (cur) out.push(cur);
  return out.flatMap(s => (s.length <= MAX_CHUNK * 1.5 ? [s] : s.match(new RegExp(`.{1,${MAX_CHUNK}}`, 'g'))));
}

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export function createTTS(hooks) {
  const synth = ttsSupported() ? window.speechSynthesis : null;
  const st = {
    status: 'stopped',  // stopped | playing | paused
    para: 0,
    sent: 0,
    sentences: [],
    utter: null,        // 必须持有引用，否则 iOS 上会被回收导致 onend 不触发
    token: 0,
    startedAt: 0,
    lastEvent: 0,
    watchdog: null,
    wakeLock: null,
  };

  let voicesCache = [];
  function refreshVoices() {
    if (!synth) return [];
    const all = synth.getVoices() || [];
    const zh = all.filter(v => /^zh|cmn|yue|wuu/i.test(v.lang || ''));
    const rest = all.filter(v => !zh.includes(v));
    voicesCache = zh.concat(rest);
    return voicesCache;
  }
  if (synth) {
    refreshVoices();
    synth.addEventListener?.('voiceschanged', () => { refreshVoices(); hooks.onVoices?.(voicesCache); });
  }

  function pickVoice(preferredURI) {
    const voices = voicesCache.length ? voicesCache : refreshVoices();
    if (!voices.length) return null;
    if (preferredURI) {
      const v = voices.find(x => x.voiceURI === preferredURI || x.name === preferredURI);
      if (v) return v;
    }
    const zhCN = voices.filter(v => /^zh[-_]?(CN|Hans)?$/i.test(v.lang) || /^zh/i.test(v.lang) && /CN|Hans|cmn/i.test(v.lang));
    const score = v => (/enhanced|premium|增强|高品质|siri|tingting|婷婷|yu-shu|shanshan/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
    const pool = zhCN.length ? zhCN : voices.filter(v => /^zh/i.test(v.lang));
    if (!pool.length) return null;
    return pool.slice().sort((a, b) => score(b) - score(a))[0];
  }

  async function wake(on) {
    try {
      if (on) {
        if (!st.wakeLock && navigator.wakeLock) {
          st.wakeLock = await navigator.wakeLock.request('screen');
          st.wakeLock.addEventListener('release', () => { st.wakeLock = null; });
        }
      } else if (st.wakeLock) {
        const w = st.wakeLock; st.wakeLock = null;
        await w.release();
      }
    } catch (_) { /* 不支持或被拒绝，忽略 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.status === 'playing') wake(true);
  });

  function cancelSpeech() {
    st.token++;
    st.utter = null;
    try { synth && synth.cancel(); } catch (_) { /* ignore */ }
  }

  function loadPara(index) {
    const paras = hooks.getParas();
    if (index < 0 || index >= paras.length) return false;
    st.para = index;
    st.sent = 0;
    st.sentences = splitSentences(paras[index]);
    hooks.onPara?.(index);
    return true;
  }

  function speakCurrent() {
    if (st.status !== 'playing' || !synth) return;
    if (st.sent >= st.sentences.length) { advancePara(); return; }
    const settings = hooks.getSettings();
    const text = st.sentences[st.sent];
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = Math.min(2, Math.max(0.5, Number(settings.rate) || 1));
    u.pitch = 1;
    const voice = pickVoice(settings.voice);
    if (voice) { u.voice = voice; if (voice.lang) u.lang = voice.lang; }
    const token = ++st.token;
    st.utter = u;
    st.startedAt = Date.now();
    st.lastEvent = Date.now();
    const next = () => {
      if (token !== st.token || st.status !== 'playing') return;
      st.sent++;
      speakCurrent();
    };
    u.onstart = () => { st.lastEvent = Date.now(); st.failStreak = 0; };
    u.onboundary = () => { st.lastEvent = Date.now(); };
    u.onend = next;
    u.onerror = (e) => {
      if (token !== st.token) return;
      const code = e.error || 'unknown';
      if (code === 'interrupted' || code === 'canceled') return;
      const fatal = ['not-allowed', 'synthesis-unavailable', 'synthesis-failed', 'audio-busy', 'audio-hardware', 'language-unavailable', 'voice-unavailable'];
      st.failStreak = (st.failStreak || 0) + 1;
      // 连续出错而且从没真正开始说过话：引擎不可用，停下来，免得一路"读"到书尾
      if (fatal.includes(code) || st.failStreak >= 3) {
        hooks.onError?.(code);
        stop();
        return;
      }
      next();
    };
    try {
      synth.speak(u);
    } catch (err) {
      hooks.onError?.(String(err));
      stop();
    }
  }

  function advancePara() {
    const paras = hooks.getParas();
    if (st.para + 1 < paras.length) {
      loadPara(st.para + 1);
      speakCurrent();
    } else {
      // 本章读完，交给外面翻章；翻章成功会回调 startFrom(0)
      const moved = hooks.onChapterEnd?.();
      if (!moved) { stop(); hooks.onFinished?.(); }
    }
  }

  function startWatchdog() {
    stopWatchdog();
    st.watchdog = setInterval(() => {
      if (st.status !== 'playing' || !synth) return;
      const idle = Date.now() - st.lastEvent;
      if (!synth.speaking && !synth.pending && idle > STALL_MS) {
        // 引擎没在说话却也没有结束事件：跳过这一句继续；连续三次都这样就当引擎坏了
        st.failStreak = (st.failStreak || 0) + 1;
        if (st.failStreak >= 3) { hooks.onError?.('stalled'); stop(); return; }
        cancelSpeech();
        st.sent++;
        speakCurrent();
      } else if (synth.paused && synth.speaking) {
        // iOS 切回前台后有时处于 paused 状态
        try { synth.resume(); } catch (_) { /* ignore */ }
        st.lastEvent = Date.now();
      }
    }, 2000);
  }
  function stopWatchdog() {
    if (st.watchdog) { clearInterval(st.watchdog); st.watchdog = null; }
  }

  /* ------- 对外接口 ------- */

  function startFrom(paraIndex) {
    if (!synth) { hooks.onError?.('unsupported'); return; }
    cancelSpeech();
    st.status = 'playing';
    st.failStreak = 0;
    if (!loadPara(paraIndex)) { stop(); return; }
    hooks.onStatus?.(st.status);
    wake(true);
    startWatchdog();
    speakCurrent();
  }

  function pause() {
    if (st.status !== 'playing') return;
    cancelSpeech();          // iOS 上 pause/resume 不可靠，直接取消并记住位置
    st.status = 'paused';
    stopWatchdog();
    wake(false);
    hooks.onStatus?.(st.status);
  }

  function resume() {
    if (st.status !== 'paused') return;
    st.status = 'playing';
    hooks.onStatus?.(st.status);
    wake(true);
    startWatchdog();
    speakCurrent();
  }

  function toggle() {
    if (st.status === 'playing') pause();
    else if (st.status === 'paused') resume();
  }

  function stop() {
    cancelSpeech();
    st.status = 'stopped';
    stopWatchdog();
    wake(false);
    hooks.onStatus?.(st.status);
    hooks.onStop?.();
  }

  // 设置变化（语速/声音）时，从当前句子重新开始
  function restartCurrent() {
    if (st.status !== 'playing') return;
    cancelSpeech();
    speakCurrent();
  }

  return {
    startFrom, pause, resume, toggle, stop, restartCurrent,
    getVoices: () => (voicesCache.length ? voicesCache : refreshVoices()),
    pickVoice,
    get status() { return st.status; },
    get para() { return st.para; },
    supported: !!synth,
  };
}
