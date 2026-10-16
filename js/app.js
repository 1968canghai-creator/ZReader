import { db, requestPersistentStorage } from './db.js';
import { parseFile, parseTxt, parseEpub } from './parsers.js';
import { createTTS } from './tts.js';
import { loadCloudConfig, saveCloudConfig, normalizeCloudConfig, listBooks, downloadBook, getJson, putJson, testConnection } from './github.js';

export const APP_VERSION = '1.1.0';

/* ---------------- 小工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

let toastTimer = null;
function toast(msg, { action, actionLabel, sticky } = {}) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(document.createTextNode(msg));
  if (action) t.append(el('button', { class: 'btn', text: actionLabel || '确定', onclick: () => { action(); t.classList.add('hidden'); } }));
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function showLoading(text) { $('#loading-text').textContent = text || '正在处理…'; $('#loading').classList.remove('hidden'); }
function hideLoading() { $('#loading').classList.add('hidden'); }
function fmtTime(ts) {
  if (!ts) return '尚未开始';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}
function fmtChars(n) { return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`; }
function fmtSize(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
// 同一个文件在不同设备上导入，算出来的 id 一样，这样进度才能跨设备合并
function stableId(name, size) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `f:${h.toString(36)}:${size}`;
}

/* ---------------- 设置 ---------------- */
const DEFAULT_SETTINGS = { fontSize: 19, lineHeight: 1.8, font: 'serif', theme: 'light', tap: 'page', rate: 1, voice: '' };
const settings = Object.assign({}, DEFAULT_SETTINGS);
try { Object.assign(settings, JSON.parse(localStorage.getItem('zreader.settings') || '{}')); } catch (_) { /* ignore */ }
function saveSettings() { try { localStorage.setItem('zreader.settings', JSON.stringify(settings)); } catch (_) { /* ignore */ } }

const THEME_COLORS = { light: '#f6f1e7', green: '#cfe3cf', gray: '#e9e9e9', dark: '#161616' };
function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--fs', `${settings.fontSize}px`);
  root.style.setProperty('--lh', String(settings.lineHeight));
  root.style.setProperty('--reading-font', settings.font === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)');
  root.setAttribute('data-theme', settings.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[settings.theme] || THEME_COLORS.light);
  $('#font-size-text').textContent = settings.fontSize;
  $$('#line-height-seg .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.lh) === Number(settings.lineHeight)));
  $$('#font-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.font === settings.font));
  $$('#theme-row .theme-dot').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme));
  $$('#tap-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.tap === settings.tap));
  $('#tts-rate-text').textContent = `${Number(settings.rate).toFixed(1)}×`;
}

/* ---------------- 状态 ---------------- */
const state = {
  books: [],
  book: null,       // 当前书的元数据（含进度）
  content: null,    // 当前书的章节正文
  chapter: 0,
  barsVisible: false,
  saveTimer: null,
};

/* ---------------- 书架 ---------------- */
async function loadShelf({ pull = false } = {}) {
  if (pull) await pullProgress();
  state.books = (await db.allBooks()) || [];
  state.books.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  renderShelf();
}

function renderShelf() {
  const list = $('#book-list');
  list.innerHTML = '';
  $('#shelf-empty').classList.toggle('hidden', state.books.length > 0);
  for (const b of state.books) {
    const pct = Math.round((b.percent || 0) * 100);
    const meta = [b.author, b.format.toUpperCase(), `${b.chapterCount} 章`, fmtChars(b.chars || 0)].filter(Boolean).join(' · ');
    const clean = b.title.replace(/[^\p{L}\p{N}]/gu, '');
    const coverText = /[㐀-鿿]/.test(clean) ? clean.slice(0, 4) : clean.slice(0, 3).toUpperCase();
    const card = el('div', { class: 'book', role: 'listitem' },
      el('div', { class: 'book-cover', text: coverText || '书' }),
      el('div', { class: 'book-main' },
        el('div', { class: 'book-title', text: b.title }),
        el('div', { class: 'book-meta', text: meta }),
        el('div', { class: 'book-meta', text: `${pct === 0 && !b.lastRead ? '未读' : `已读 ${pct}%`} · ${fmtTime(b.lastRead)}` }),
        el('div', { class: 'book-progress' }, el('i', { style: `width:${pct}%` })),
      ),
      el('div', { class: 'book-actions' },
        el('button', { class: 'btn book-del', text: '删除', type: 'button', onclick: (e) => { e.stopPropagation(); deleteBook(b); } }),
      ),
    );
    card.addEventListener('click', () => openBook(b.id));
    list.append(card);
  }
}

async function deleteBook(b) {
  if (!confirm(`删除《${b.title}》？阅读进度也会一起删除。`)) return;
  await db.deleteBook(b.id);
  await loadShelf();
  toast('已删除');
}

// 把解析结果存进书架；同一 id 已存在时保留原来的阅读进度
async function storeParsed(id, parsed, source) {
  const old = await db.getBook(id);
  await db.putContent({ id, chapters: parsed.chapters });
  const book = {
    id, title: parsed.title, author: parsed.author || '', format: parsed.format,
    chapterCount: parsed.chapters.length, chars: parsed.chars,
    addedAt: old ? old.addedAt : Date.now(),
    lastRead: old ? old.lastRead : 0,
    percent: old ? old.percent : 0,
    progress: old && old.progress ? old.progress : { chapter: 0, para: 0 },
    source: source || (old && old.source) || null,
  };
  if (book.progress.chapter >= parsed.chapters.length) book.progress = { chapter: 0, para: 0 };
  await db.putBook(book);
  return book;
}

async function importFiles(files) {
  const arr = Array.from(files || []);
  if (!arr.length) return;
  let ok = 0;
  for (const f of arr) {
    showLoading(`正在解析 ${f.name}…`);
    try {
      const parsed = await parseFile(f);
      await storeParsed(stableId(f.name, f.size), parsed, null);
      ok++;
    } catch (err) {
      console.error(err);
      hideLoading();
      alert(`《${f.name}》导入失败：${err.message || err}`);
    }
  }
  hideLoading();
  await loadShelf();
  if (ok) toast(ok === 1 ? '导入成功' : `已导入 ${ok} 本`);
}

/* ---------------- 阅读 ---------------- */
const content = $('#content');

async function openBook(id) {
  showLoading('正在打开…');
  try {
    // 先拉一次云端进度（最多等 3 秒），这样换设备能接着读
    await pullProgress({ timeoutMs: 3000, onlyId: id });
    const [book, data] = await Promise.all([db.getBook(id), db.getContent(id)]);
    if (!book || !data) { toast('这本书的数据丢失了'); hideLoading(); return; }
    state.book = book;
    state.content = data;
    $('#shelf').classList.add('hidden');
    $('#reader').classList.remove('hidden');
    $('#toc-title').textContent = book.title;
    setBars(false);
    const p = book.progress || { chapter: 0, para: 0 };
    showChapter(Math.min(p.chapter, data.chapters.length - 1), p.para || 0);
  } finally {
    hideLoading();
  }
}

function backToShelf() {
  tts.stop();
  flushProgress();
  $('#reader').classList.add('hidden');
  $('#shelf').classList.remove('hidden');
  state.book = null; state.content = null;
  loadShelf();
  schedulePush('leave');
}

function chapterAt(i) { return state.content.chapters[i]; }
function chapterCount() { return state.content.chapters.length; }

function showChapter(index, para = 0, { keepTTS = false } = {}) {
  if (!state.content) return;
  index = Math.max(0, Math.min(index, chapterCount() - 1));
  if (!keepTTS && tts.status !== 'stopped') tts.stop();
  state.chapter = index;
  const ch = chapterAt(index);
  const hs = new Set(ch.hs || []);

  content.innerHTML = '';
  const frag = document.createDocumentFragment();
  // 正文第一段本身就是同名标题（epub 常见）时，不再重复显示一次章节名
  const norm = s => s.replace(/[\s　]+/g, '');
  const firstIsTitle = hs.has(0) && ch.paras.length && norm(ch.paras[0]) === norm(ch.title);
  if (!firstIsTitle) frag.append(el('h2', { class: 'chapter-head', text: ch.title }));
  ch.paras.forEach((t, i) => {
    frag.append(el('p', { class: hs.has(i) ? 'h' : null, 'data-i': i, text: t }));
  });
  const end = el('div', { class: 'chapter-end' });
  if (index + 1 < chapterCount()) {
    end.append(el('div', { text: `本章完 · 下一章：${chapterAt(index + 1).title}` }));
    end.append(el('button', { class: 'btn', type: 'button', text: '下一章', onclick: (e) => { e.stopPropagation(); showChapter(index + 1, 0); } }));
  } else {
    end.append(el('div', { text: '全书完' }));
    end.append(el('button', { class: 'btn', type: 'button', text: '回到书架', onclick: (e) => { e.stopPropagation(); backToShelf(); } }));
  }
  frag.append(end);
  content.append(frag);

  $('#cur-chapter').textContent = ch.title;
  $('#btn-prev').disabled = index === 0;
  $('#btn-next').disabled = index + 1 >= chapterCount();

  // 恢复到指定段落
  requestAnimationFrame(() => {
    if (para > 0) {
      const target = content.querySelector(`p[data-i="${Math.min(para, ch.paras.length - 1)}"]`);
      content.scrollTop = target ? Math.max(0, target.offsetTop - content.offsetTop - 10) : 0;
    } else {
      content.scrollTop = 0;
    }
    updateProgress();
  });
  renderToc();
}

function firstVisiblePara() {
  const top = content.scrollTop + 4;
  const ps = content.querySelectorAll('p[data-i]');
  // 二分查找第一个底部在视口上沿之下的段落
  let lo = 0, hi = ps.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = ps[mid];
    if (p.offsetTop + p.offsetHeight - content.offsetTop >= top) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ps.length ? Number(ps[ans].dataset.i) : 0;
}

function updateProgress() {
  if (!state.book || !state.content) return;
  const ch = chapterAt(state.chapter);
  const para = firstVisiblePara();
  const inChapter = ch.paras.length ? para / ch.paras.length : 0;
  const percent = Math.min(1, (state.chapter + inChapter) / chapterCount());
  const atEnd = content.scrollTop + content.clientHeight >= content.scrollHeight - 2;
  const prev = state.book.progress || {};
  if (prev.chapter !== state.chapter || prev.para !== para) cloud.dirty = true;
  state.book.progress = { chapter: state.chapter, para };
  state.book.percent = (atEnd && state.chapter + 1 >= chapterCount()) ? 1 : percent;
  // 保证时间戳只增不减：即使另一台设备的时钟偏快，本机新读到的位置也能覆盖它
  state.book.lastRead = Math.max(Date.now(), (state.book.lastRead || 0) + 1);
  $('#progress-text').textContent = `${state.chapter + 1}/${chapterCount()} · ${(state.book.percent * 100).toFixed(1)}%`;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushProgress, 600);
  schedulePush('reading');
}

function flushProgress() {
  clearTimeout(state.saveTimer);
  if (state.book) db.putBook(state.book).catch(() => {});
}

let scrollPending = false;
content.addEventListener('scroll', () => {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => { scrollPending = false; updateProgress(); });
}, { passive: true });

function setBars(visible) {
  state.barsVisible = visible;
  $('#reader-top').classList.toggle('off', !visible);
  $('#reader-bottom').classList.toggle('off', !visible);
  $('#tts-panel').classList.toggle('shifted', visible);
}

function pageScroll(dir) {
  const step = content.clientHeight - Math.max(40, parseFloat(getComputedStyle(content).fontSize) * settings.lineHeight * 1.5);
  if (dir > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 2) {
    if (state.chapter + 1 < chapterCount()) showChapter(state.chapter + 1, 0, { keepTTS: true });
    return;
  }
  if (dir < 0 && content.scrollTop <= 0) {
    if (state.chapter > 0) {
      showChapter(state.chapter - 1, 0, { keepTTS: true });
      requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
    }
    return;
  }
  content.scrollBy({ top: dir * step, behavior: 'auto' });
}

// 点击正文：朗读时点段落 = 从该段开始读；否则按区域翻屏 / 显示菜单
content.addEventListener('click', (e) => {
  if (e.target.closest('button, a')) return;
  const p = e.target.closest('p[data-i]');
  if (tts.status !== 'stopped' && p) {
    tts.startFrom(Number(p.dataset.i));
    return;
  }
  if (state.barsVisible) { setBars(false); return; }
  const y = e.clientY / window.innerHeight;
  if (settings.tap === 'page' && y < 0.3) pageScroll(-1);
  else if (settings.tap === 'page' && y > 0.7) pageScroll(1);
  else setBars(true);
});

/* ---------------- 目录 ---------------- */
function renderToc() {
  if (!state.content) return;
  const list = $('#toc-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.content.chapters.forEach((c, i) => {
    frag.append(el('button', { class: `toc-item${i === state.chapter ? ' current' : ''}`, type: 'button', text: c.title, 'data-i': i }));
  });
  list.append(frag);
}
$('#toc-list').addEventListener('click', (e) => {
  const item = e.target.closest('.toc-item');
  if (!item) return;
  closeOverlay('toc');
  setBars(false);
  showChapter(Number(item.dataset.i), 0);
});
function openOverlay(name) {
  const node = $(`#${name}`);
  node.classList.remove('hidden');
  node.setAttribute('aria-hidden', 'false');
  if (name === 'toc') {
    const cur = node.querySelector('.toc-item.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }
}
function closeOverlay(name) {
  const node = $(`#${name}`);
  node.classList.add('hidden');
  node.setAttribute('aria-hidden', 'true');
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) closeOverlay(c.dataset.close);
});

/* ---------------- 朗读 ---------------- */
const tts = createTTS({
  getParas: () => (state.content ? chapterAt(state.chapter).paras : []),
  getSettings: () => settings,
  onPara: (i) => {
    content.querySelectorAll('p.speaking').forEach(p => p.classList.remove('speaking'));
    const p = content.querySelector(`p[data-i="${i}"]`);
    if (!p) return;
    p.classList.add('speaking');
    const top = p.offsetTop - content.offsetTop;
    const viewTop = content.scrollTop, viewBottom = viewTop + content.clientHeight;
    if (top < viewTop + 60 || top + p.offsetHeight > viewBottom - 160) {
      content.scrollTo({ top: Math.max(0, top - content.clientHeight * 0.25), behavior: 'smooth' });
    }
  },
  onChapterEnd: () => {
    if (state.chapter + 1 >= chapterCount()) return false;
    showChapter(state.chapter + 1, 0, { keepTTS: true });
    tts.startFrom(0);
    return true;
  },
  onFinished: () => toast('全书朗读完毕'),
  onStatus: (s) => {
    $('#tts-toggle').textContent = s === 'playing' ? '❚❚' : '▶';
    $('#tts-toggle').title = s === 'playing' ? '暂停' : '继续';
    $('#tts-panel').classList.toggle('hidden', s === 'stopped');
    $('#btn-tts').classList.toggle('on', s !== 'stopped');
  },
  onStop: () => content.querySelectorAll('p.speaking').forEach(p => p.classList.remove('speaking')),
  onVoices: () => fillVoices(),
  onError: (code) => {
    if (code === 'unsupported') toast('这个浏览器不支持语音朗读');
    else if (code === 'not-allowed') toast('浏览器拒绝了朗读，请再点一次「朗读」');
    else if (code === 'stalled') toast('语音引擎没有响应，已停止朗读');
    else toast('朗读失败：手机上可能没有可用的中文语音。可到 设置 → 辅助功能 → 朗读内容 → 声音 里下载', { sticky: true, actionLabel: '知道了', action: () => {} });
  },
});

function fillVoices() {
  const sel = $('#tts-voice');
  const voices = tts.getVoices();
  sel.innerHTML = '';
  if (!voices.length) {
    sel.append(el('option', { value: '', text: '系统默认' }));
    return;
  }
  sel.append(el('option', { value: '', text: '自动（优先中文）' }));
  for (const v of voices) {
    const label = `${v.name}${v.lang ? `（${v.lang}）` : ''}`;
    sel.append(el('option', { value: v.voiceURI, text: label }));
  }
  const has = voices.some(v => v.voiceURI === settings.voice);
  sel.value = has ? settings.voice : '';
}

function startTTS() {
  if (!tts.supported) { toast('这个浏览器不支持语音朗读'); return; }
  if (tts.status !== 'stopped') { tts.toggle(); return; }
  fillVoices();
  setBars(false);
  tts.startFrom(firstVisiblePara());
}

$('#btn-tts').addEventListener('click', startTTS);
$('#tts-toggle').addEventListener('click', () => tts.toggle());
$('#tts-stop').addEventListener('click', () => tts.stop());
$('#tts-slower').addEventListener('click', () => changeRate(-0.1));
$('#tts-faster').addEventListener('click', () => changeRate(0.1));
function changeRate(d) {
  settings.rate = Math.round(Math.min(2, Math.max(0.5, Number(settings.rate) + d)) * 10) / 10;
  saveSettings(); applySettings();
  tts.restartCurrent();
}
$('#tts-voice').addEventListener('change', (e) => {
  settings.voice = e.target.value;
  saveSettings();
  tts.restartCurrent();
});

/* ---------------- 云端书库 ---------------- */
const PROGRESS_FILE = 'zreader-progress.json';
const cloud = { cfg: loadCloudConfig(), dirty: false, lastPush: 0, pushTimer: null, pushing: false, sha: null, remote: null, failedOnce: false };

function syncEnabled() { return !!(cloud.cfg.repo && cloud.cfg.token && cloud.cfg.sync); }
function setSyncStatus(text) {
  const n = $('#sync-status');
  if (!text) { n.classList.add('hidden'); return; }
  n.textContent = text;
  n.classList.remove('hidden');
}

async function openLibrary() {
  cloud.cfg = loadCloudConfig();
  if (!cloud.cfg.repo) { openCloudSettings(); return; }
  $('#lib-repo').textContent = cloud.cfg.folder ? `${cloud.cfg.repo}/${cloud.cfg.folder}` : cloud.cfg.repo;
  const list = $('#lib-list');
  list.innerHTML = '';
  $('#lib-empty').classList.add('hidden');
  list.append(el('div', { class: 'lib-item muted' }, el('span', { class: 'spin' }), '正在读取书库…'));
  openOverlay('library');
  try {
    const files = await listBooks(cloud.cfg);
    renderLibrary(files);
  } catch (e) {
    list.innerHTML = '';
    $('#lib-empty').classList.remove('hidden');
    $('#lib-empty-text').textContent = `读取失败：${e.message}`;
  }
}

function libraryId(path) { return `gh:${cloud.cfg.repo}/${path}`; }

function renderLibrary(files) {
  const list = $('#lib-list');
  list.innerHTML = '';
  if (!files.length) {
    $('#lib-empty').classList.remove('hidden');
    $('#lib-empty-text').textContent = cloud.cfg.folder ? `仓库的 ${cloud.cfg.folder} 文件夹里还没有 txt / epub 文件` : '仓库里还没有 txt / epub 文件';
    return;
  }
  const have = new Set(state.books.map(b => b.id));
  for (const f of files) {
    const id = libraryId(f.path);
    const exists = have.has(id);
    const btn = el('button', { class: `btn ${exists ? 'done' : 'primary'}`, type: 'button', text: exists ? '已在书架' : '下载' });
    btn.addEventListener('click', () => downloadToShelf(f, id, btn));
    list.append(el('div', { class: 'lib-item' },
      el('div', { class: 'lib-name' }, el('div', { text: f.name }), el('div', { class: 'lib-meta', text: fmtSize(f.size) })),
      btn));
  }
}

async function downloadToShelf(f, id, btn) {
  btn.disabled = true;
  btn.className = 'btn';
  btn.textContent = '下载中';
  try {
    const buf = await downloadBook(cloud.cfg, f.path, {
      onProgress: (r, t) => { btn.textContent = t ? `${Math.min(99, Math.round(r / t * 100))}%` : fmtSize(r); },
    });
    btn.textContent = '解析中…';
    const parsed = await parseFile(new File([buf], f.name));
    await storeParsed(id, parsed, { repo: cloud.cfg.repo, path: f.path, sha: f.sha });
    await loadShelf({ pull: false });
    btn.className = 'btn done';
    btn.textContent = '已在书架';
    toast(`《${parsed.title}》已加入书架`);
  } catch (e) {
    console.error(e);
    btn.className = 'btn primary';
    btn.textContent = '重试';
    toast(`下载失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function openCloudSettings() {
  const c = loadCloudConfig();
  $('#cloud-repo').value = c.repo;
  $('#cloud-folder').value = c.folder || '';
  $('#cloud-token').value = c.token;
  $('#cloud-sync').checked = !!c.sync;
  openOverlay('cloud');
}
function readCloudForm() {
  return normalizeCloudConfig({
    repo: $('#cloud-repo').value, folder: $('#cloud-folder').value,
    token: $('#cloud-token').value, sync: $('#cloud-sync').checked,
  });
}
$('#btn-library').addEventListener('click', openLibrary);
$('#lib-settings').addEventListener('click', openCloudSettings);
$('#cloud-save').addEventListener('click', async () => {
  const cfg = readCloudForm();
  saveCloudConfig(cfg);
  cloud.cfg = loadCloudConfig();
  cloud.remote = null; cloud.sha = null; cloud.failedOnce = false;
  closeOverlay('cloud');
  toast('已保存');
  if (cloud.cfg.repo) {
    await loadShelf({ pull: true });
    openLibrary();
  }
});
$('#cloud-test').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const cfg = readCloudForm();
  if (!cfg.repo) { toast('请先填写仓库，格式：用户名/仓库名'); return; }
  btn.disabled = true; btn.textContent = '测试中…';
  try {
    const r = await testConnection(cfg);
    let msg = `连接成功，找到 ${r.count} 本书`;
    if (cfg.token) msg += r.canWrite ? '，Token 可以同步进度' : '，但 Token 没有写权限，无法同步进度';
    toast(msg);
  } catch (err) {
    toast(`连接失败：${err.message}`, { sticky: true, actionLabel: '知道了', action: () => {} });
  } finally {
    btn.disabled = false; btn.textContent = '测试连接';
  }
});

/* ---------------- 进度同步 ---------------- */
// 云端文件结构：{ version, updatedAt, books: { [bookId]: { title, chapter, para, percent, lastRead } } }
async function pullProgress({ timeoutMs = 8000, onlyId = null } = {}) {
  if (!syncEnabled()) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await getJson(cloud.cfg, PROGRESS_FILE, { signal: ctrl.signal });
    if (!res) { cloud.sha = null; cloud.remote = { version: 1, books: {} }; return false; }
    cloud.sha = res.sha;
    cloud.remote = (res.data && res.data.books) ? res.data : { version: 1, books: {} };
    const entries = cloud.remote.books;
    const ids = onlyId ? [onlyId] : Object.keys(entries);
    let changed = false;
    for (const id of ids) {
      const r = entries[id];
      if (!r) continue;
      const local = await db.getBook(id);
      if (!local) continue;
      if ((r.lastRead || 0) > (local.lastRead || 0)) {
        let chapter = Number(r.chapter) || 0, para = Number(r.para) || 0;
        if (chapter >= local.chapterCount) { chapter = 0; para = 0; }
        local.progress = { chapter, para };
        local.percent = Number(r.percent) || 0;
        local.lastRead = r.lastRead;
        await db.putBook(local);
        changed = true;
      }
    }
    setSyncStatus(`☁ 进度已同步 · ${fmtTime(Date.now())}`);
    return changed;
  } catch (e) {
    console.warn('拉取进度失败', e);
    setSyncStatus(`☁ 进度同步失败：${e.name === 'AbortError' ? '网络超时' : e.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pushProgress({ keepalive = false } = {}) {
  if (!syncEnabled() || cloud.pushing) return;
  cloud.pushing = true;
  try {
    if (cloud.remote === null) await pullProgress({ timeoutMs: 6000 });
    const books = await db.allBooks();
    const attempt = async (retried) => {
      const remote = (cloud.remote && cloud.remote.books) || {};
      const merged = Object.assign({}, remote);
      for (const b of books) {
        if (!b.lastRead) continue;
        const r = merged[b.id];
        if (!r || (b.lastRead || 0) >= (r.lastRead || 0)) {
          merged[b.id] = { title: b.title, chapter: b.progress.chapter, para: b.progress.para, percent: b.percent, lastRead: b.lastRead };
        }
      }
      const data = { version: 1, updatedAt: new Date().toISOString(), books: merged };
      try {
        cloud.sha = await putJson(cloud.cfg, PROGRESS_FILE, data, { sha: cloud.sha, message: `阅读进度 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, keepalive });
        cloud.remote = data;
        cloud.dirty = false;
      } catch (e) {
        if (e.conflict && !retried) {
          const res = await getJson(cloud.cfg, PROGRESS_FILE);
          cloud.sha = res ? res.sha : null;
          cloud.remote = (res && res.data && res.data.books) ? res.data : { version: 1, books: {} };
          return attempt(true);
        }
        throw e;
      }
    };
    await attempt(false);
    cloud.lastPush = Date.now();
    setSyncStatus(`☁ 进度已同步 · ${fmtTime(Date.now())}`);
  } catch (e) {
    console.warn('上传进度失败', e);
    setSyncStatus(`☁ 进度同步失败：${e.message}`);
    if (!cloud.failedOnce) { cloud.failedOnce = true; toast(`进度同步失败：${e.message}`); }
  } finally {
    cloud.pushing = false;
  }
}

// reading：阅读中最多每 45 秒推一次；leave：离开书或退到后台时立刻推
function schedulePush(reason, opts = {}) {
  if (!syncEnabled() || !cloud.dirty) return;
  if (reason === 'leave') {
    clearTimeout(cloud.pushTimer); cloud.pushTimer = null;
    pushProgress(opts);
    return;
  }
  if (cloud.pushTimer) return;
  cloud.pushTimer = setTimeout(() => { cloud.pushTimer = null; pushProgress(); }, 45e3);
}

/* ---------------- 按钮绑定 ---------------- */
$('#btn-import').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  await importFiles(e.target.files);
  e.target.value = '';
});
$('#btn-back').addEventListener('click', backToShelf);
$('#btn-prev').addEventListener('click', () => { setBars(false); showChapter(state.chapter - 1, 0); });
$('#btn-next').addEventListener('click', () => { setBars(false); showChapter(state.chapter + 1, 0); });
$('#btn-toc').addEventListener('click', () => { renderToc(); openOverlay('toc'); });
$('#btn-settings').addEventListener('click', () => openOverlay('settings'));

$('#font-smaller').addEventListener('click', () => { settings.fontSize = Math.max(13, settings.fontSize - 1); saveSettings(); applySettings(); });
$('#font-larger').addEventListener('click', () => { settings.fontSize = Math.min(34, settings.fontSize + 1); saveSettings(); applySettings(); });
$('#line-height-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-lh]'); if (b) { settings.lineHeight = Number(b.dataset.lh); saveSettings(); applySettings(); } });
$('#font-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-font]'); if (b) { settings.font = b.dataset.font; saveSettings(); applySettings(); } });
$('#theme-row').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b) { settings.theme = b.dataset.theme; saveSettings(); applySettings(); } });
$('#tap-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-tap]'); if (b) { settings.tap = b.dataset.tap; saveSettings(); applySettings(); } });

// 键盘（电脑上测试用）
document.addEventListener('keydown', (e) => {
  if ($('#reader').classList.contains('hidden')) return;
  if (e.key === 'ArrowRight') showChapter(state.chapter + 1, 0);
  else if (e.key === 'ArrowLeft') showChapter(state.chapter - 1, 0);
  else if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); pageScroll(1); }
  else if (e.key === 'PageUp') { e.preventDefault(); pageScroll(-1); }
  else if (e.key === 'Escape') { closeOverlay('toc'); closeOverlay('settings'); }
});

// 退到后台/关闭页面时立即保存进度；回到前台时在书架上刷新一下云端进度
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushProgress();
    schedulePush('leave', { keepalive: true });
  } else if (!$('#shelf').classList.contains('hidden') && syncEnabled()) {
    loadShelf({ pull: true });
  }
});
window.addEventListener('pagehide', () => { flushProgress(); schedulePush('leave', { keepalive: true }); });

/* ---------------- Service Worker ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('ZReader 有新版本', { sticky: true, actionLabel: '刷新', action: () => location.reload() });
        }
      });
    });
  }).catch(() => {});
}

/* ---------------- 启动 ---------------- */
async function init() {
  $('#app-version').textContent = `v${APP_VERSION}`;
  applySettings();
  requestPersistentStorage();
  await loadShelf({ pull: true });
  fillVoices();
  registerSW();
}
init();
