// 文本解析：txt（自动识别编码、自动分章）和 epub（解压、按 spine 顺序提取正文）
// 统一输出结构：{ title, author, chapters: [{ title, paras: string[], hs: number[] }] }
// paras 是段落数组，hs 是其中属于小标题的段落下标

/* ---------------- 编码识别 ---------------- */

// 高频汉字，用来判断 GB18030 和 Big5 哪个解码结果更像正常中文
const COMMON_CHARS = new Set(
  '的一是了我不在人有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从'
);

function scoreChinese(text) {
  const n = Math.min(text.length, 30000);
  let hits = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (COMMON_CHARS.has(ch)) hits++;
    else if (ch === '�') bad += 5;
  }
  return hits - bad;
}

export function decodeText(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (_) { /* 不是合法 UTF-8，继续尝试中文编码 */ }
  const candidates = [];
  for (const enc of ['gb18030', 'big5']) {
    try {
      const s = new TextDecoder(enc).decode(u8);
      candidates.push({ enc, s, score: scoreChinese(s) });
    } catch (_) { /* 浏览器不支持该编码 */ }
  }
  if (!candidates.length) return new TextDecoder('utf-8').decode(u8);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].s;
}

/* ---------------- txt 分章 ---------------- */

const CHAPTER_RE = /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节回卷集部篇话]|(?:序章|序言|序幕|前言|引子|楔子|尾声|终章|后记|番外|外传|完本感言)(?=$|[\s：:、（(\[【]|[^一-龥])|Chapter\s*\d+)/i;
const MAX_CHAPTER_TITLE = 48;
const TARGET_CHUNK = 5000;   // 没有章节标记时，按大约多少字切一块
const MAX_CHAPTER_CHARS = 40000; // 单章超过这个长度就再切

function isChapterTitle(line) {
  if (line.length > MAX_CHAPTER_TITLE) return false;
  if (!CHAPTER_RE.test(line)) return false;
  // 以句末标点结尾的更像正文里的一句话，不当标题
  if (/[。，！？；,!?]$/.test(line)) return false;
  return true;
}

function splitLongChapter(ch) {
  const total = ch.paras.reduce((n, p) => n + p.length, 0);
  if (total <= MAX_CHAPTER_CHARS) return [ch];
  const parts = Math.ceil(total / (MAX_CHAPTER_CHARS * 0.75));
  const per = Math.ceil(ch.paras.length / parts);
  const out = [];
  for (let i = 0, k = 1; i < ch.paras.length; i += per, k++) {
    out.push({ title: `${ch.title}（${k}）`, paras: ch.paras.slice(i, i + per), hs: [] });
  }
  return out;
}

export function parseTxt(fileName, buffer) {
  const text = decodeText(buffer);
  const title = fileName.replace(/\.[^.]+$/, '').trim() || '未命名';
  const lines = text.split(/\r\n|\r|\n/);

  let chapters = [];
  let cur = { title: '', paras: [], hs: [] };
  let totalChars = 0;
  for (const raw of lines) {
    const line = raw.replace(/^[\s　]+|[\s　]+$/g, '');
    if (!line) continue;
    if (isChapterTitle(line)) {
      if (cur.paras.length) chapters.push(cur);
      cur = { title: line, paras: [], hs: [] };
    } else {
      cur.paras.push(line);
      totalChars += line.length;
    }
  }
  if (cur.paras.length || !chapters.length) chapters.push(cur);

  // 识别到的章节太少（基本没有标记）就按长度切块
  const looksUnsplit = chapters.length <= 1 || totalChars / chapters.length > MAX_CHAPTER_CHARS * 2;
  if (looksUnsplit) {
    const allParas = chapters.flatMap(c => (c.title ? [c.title] : []).concat(c.paras));
    chapters = [];
    let chunk = [], size = 0;
    for (const p of allParas) {
      chunk.push(p);
      size += p.length;
      if (size >= TARGET_CHUNK) {
        chapters.push({ title: `第 ${chapters.length + 1} 部分`, paras: chunk, hs: [] });
        chunk = []; size = 0;
      }
    }
    if (chunk.length) chapters.push({ title: `第 ${chapters.length + 1} 部分`, paras: chunk, hs: [] });
  } else {
    if (!chapters[0].title) chapters[0].title = '开头';
    chapters = chapters.flatMap(splitLongChapter);
  }
  if (!chapters.length) chapters.push({ title: title, paras: ['（空文件）'], hs: [] });
  return { title, author: '', chapters };
}

/* ---------------- epub ---------------- */

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'DT', 'DD',
  'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION', 'TABLE', 'TR', 'UL', 'OL', 'BODY', 'NAV', 'MAIN', 'HR', 'BR', 'CENTER']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'SVG', 'IMG', 'IMAGE', 'VIDEO', 'AUDIO']);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function cleanText(s) {
  return s.replace(/[\s　 ]+/g, ' ').replace(/^[\s　]+|[\s　]+$/g, '');
}

function parseXml(str, type) {
  const doc = new DOMParser().parseFromString(str, type);
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

function parseHtmlDoc(str) {
  return parseXml(str, 'application/xhtml+xml') || new DOMParser().parseFromString(str, 'text/html');
}

function extractParas(html) {
  const doc = parseHtmlDoc(html);
  const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
  const paras = [], hs = [];
  let heading = '';

  const emit = (text, tag) => {
    const t = cleanText(text);
    if (!t) return;
    if (HEADING_TAGS.has(tag)) {
      hs.push(paras.length);
      if (!heading) heading = t;
    }
    paras.push(t);
  };

  const walk = (el) => {
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (SKIP_TAGS.has(tag)) return;
    const children = Array.from(el.children || []);
    const hasBlockChild = children.some(c => BLOCK_TAGS.has(c.tagName.toUpperCase()));
    if (!hasBlockChild) { emit(el.textContent, tag); return; }
    let run = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { run += node.textContent; continue; }
      if (node.nodeType !== 1) continue;
      const t = node.tagName.toUpperCase();
      if (BLOCK_TAGS.has(t)) {
        if (run) { emit(run, tag); run = ''; }
        if (t !== 'BR' && t !== 'HR') walk(node);
      } else if (!SKIP_TAGS.has(t)) {
        run += node.textContent;
      }
    }
    if (run) emit(run, tag);
  };

  if (body) walk(body);
  return { paras, hs, heading };
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i + 1) : '';
}

function resolvePath(base, href) {
  const clean = href.split('#')[0].split('?')[0];
  const segs = (dirOf(base) + clean).split('/');
  const out = [];
  for (const s of segs) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
}

function zipFile(zip, path) {
  let f = zip.file(path);
  if (!f) { try { f = zip.file(decodeURIComponent(path)); } catch (_) { /* ignore */ } }
  if (!f) {
    // 大小写不敏感兜底
    const lower = path.toLowerCase();
    const name = Object.keys(zip.files).find(n => n.toLowerCase() === lower);
    if (name) f = zip.file(name);
  }
  return f;
}

function textOf(node) { return node ? cleanText(node.textContent) : ''; }

async function loadToc(zip, opf, manifest, spine, opfPath) {
  const map = new Map();
  const items = Object.values(manifest);
  // EPUB3 nav
  const navItem = items.find(it => it.props.split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = resolvePath(opfPath, navItem.href);
    const f = zipFile(zip, navPath);
    if (f) {
      const doc = parseHtmlDoc(await f.async('string'));
      const navs = Array.from(doc.getElementsByTagName('nav'));
      const toc = navs.find(n => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '') === 'toc') || navs[0];
      if (toc) {
        for (const a of toc.getElementsByTagName('a')) {
          const href = a.getAttribute('href');
          if (!href) continue;
          const p = resolvePath(navPath, href);
          if (!map.has(p)) map.set(p, textOf(a));
        }
      }
    }
  }
  if (map.size) return map;
  // EPUB2 NCX
  const tocId = spine && spine.getAttribute('toc');
  const ncxItem = (tocId && manifest[tocId]) || items.find(it => it.type === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxPath = resolvePath(opfPath, ncxItem.href);
    const f = zipFile(zip, ncxPath);
    if (f) {
      const doc = parseXml(await f.async('string'), 'application/xml');
      if (doc) {
        for (const np of doc.getElementsByTagName('navPoint')) {
          const label = np.getElementsByTagName('text')[0];
          const content = np.getElementsByTagName('content')[0];
          if (!content) continue;
          const p = resolvePath(ncxPath, content.getAttribute('src') || '');
          if (!map.has(p)) map.set(p, textOf(label));
        }
      }
    }
  }
  return map;
}

export async function parseEpub(buffer) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载');
  const zip = await JSZip.loadAsync(buffer);
  const containerFile = zipFile(zip, 'META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 epub：缺少 container.xml');
  const container = parseXml(await containerFile.async('string'), 'application/xml');
  const rootfile = container && container.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath) throw new Error('不是有效的 epub：找不到 OPF');
  const opfFile = zipFile(zip, opfPath);
  if (!opfFile) throw new Error('不是有效的 epub：OPF 文件缺失');
  const opf = parseXml(await opfFile.async('string'), 'application/xml');
  if (!opf) throw new Error('OPF 文件无法解析');

  const title = textOf(opf.getElementsByTagNameNS('*', 'title')[0]) || '未命名';
  const author = Array.from(opf.getElementsByTagNameNS('*', 'creator')).map(textOf).filter(Boolean).join('、');

  const manifest = {};
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    manifest[it.getAttribute('id')] = {
      href: it.getAttribute('href') || '',
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    };
  }
  const spine = opf.getElementsByTagNameNS('*', 'spine')[0];
  const itemrefs = spine ? Array.from(spine.getElementsByTagNameNS('*', 'itemref')) : [];
  const tocMap = await loadToc(zip, opf, manifest, spine, opfPath);

  const chapters = [];
  for (const ref of itemrefs) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = manifest[ref.getAttribute('idref')];
    if (!item) continue;
    if (item.props.split(/\s+/).includes('nav')) continue;
    if (item.type && !/html|xml/i.test(item.type)) continue;
    const path = resolvePath(opfPath, item.href);
    const f = zipFile(zip, path);
    if (!f) continue;
    const { paras, hs, heading } = extractParas(await f.async('string'));
    if (!paras.length) continue;
    let chTitle = tocMap.get(path) || heading || '';
    if (!chTitle) chTitle = `第 ${chapters.length + 1} 节`;
    chapters.push({ title: chTitle, paras, hs });
  }
  if (!chapters.length) throw new Error('这本 epub 里没有可读的文字内容');
  return { title, author, chapters: chapters.flatMap(splitLongChapter) };
}

/* ---------------- markdown ---------------- */

function stripInline(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                 // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')              // 链接 → 文字
    .replace(/<[^>]+>/g, '')                               // HTML 标签
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                    // 粗体
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2') // 斜体 *x*
    .replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')  // 斜体 _x_
    .replace(/~~(.+?)~~/g, '$1')                           // 删除线
    .replace(/`([^`]*)`/g, '$1')                           // 行内代码
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1')        // 转义字符
    .replace(/[\s　]+$/g, '').replace(/^[\s　]+/g, '');
}

export function parseMarkdown(fileName, buffer) {
  const text = decodeText(buffer);
  const title = fileName.replace(/\.[^.]+$/, '').trim() || '未命名';
  const rawLines = text.split(/\r\n|\r|\n/);

  // 先把行归类：标题 / 空行 / 正文（顺带去掉 markdown 记号）
  const lines = [];
  let inFence = false;
  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { lines.push({ t: 'p', text: line.trim(), hard: true }); continue; }
    if (!line.trim()) { lines.push({ t: 'blank' }); continue; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) { lines.push({ t: 'h', level: h[1].length, text: stripInline(h[2]) }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { lines.push({ t: 'blank' }); continue; } // 分隔线
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;             // 表格分隔行
    let body = line.replace(/^\s{0,3}>\s?/, '');                                                // 引用
    const isItem = /^\s*([-*+]|\d+[.)])\s+/.test(body) || /^\s*\|.*\|\s*$/.test(body);           // 列表项 / 表格行各自成段
    body = body.replace(/^\s*([-*+]|\d+[.)])\s+/, '');                                          // 列表
    body = body.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, '　');        // 表格
    lines.push({ t: 'p', text: stripInline(body), hard: isItem });
  }

  // 下一行紧接着的文字行是否该并成一段：markdown 里是，但很多人写小说时每行一段、不空行
  const textLines = lines.filter(l => l.t === 'p').length;
  const blankLines = lines.filter(l => l.t === 'blank').length;
  const joinLines = textLines > 0 && blankLines / textLines > 0.2;

  // 用出现次数最多的标题级别来分章；更高级别（如 # 卷名）也分章
  const levelCount = {};
  for (const l of lines) if (l.t === 'h') levelCount[l.level] = (levelCount[l.level] || 0) + 1;
  const levels = Object.keys(levelCount).map(Number);
  let chapterLevel = 0;
  if (levels.length) {
    chapterLevel = levels.sort((a, b) => levelCount[b] - levelCount[a] || a - b)[0];
    // 只有一个顶级标题（书名）时，不要拿它当章节级别
    if (levelCount[chapterLevel] === 1 && levels.length > 1) chapterLevel = levels.filter(l => l !== chapterLevel).sort((a, b) => levelCount[b] - levelCount[a] || a - b)[0];
  }

  const chapters = [];
  let cur = { title: '', paras: [], hs: [] };
  let buf = '';
  const flush = () => { if (buf) { cur.paras.push(buf); buf = ''; } };
  for (const l of lines) {
    if (l.t === 'blank') { flush(); continue; }
    if (l.t === 'h') {
      flush();
      if (chapterLevel && l.level <= chapterLevel) {
        if (cur.paras.length) chapters.push(cur);
        cur = { title: l.text, paras: [], hs: [] };
      } else if (l.text) {
        cur.hs.push(cur.paras.length);
        cur.paras.push(l.text);
      }
      continue;
    }
    if (!l.text) continue;
    if (l.hard) { flush(); cur.paras.push(l.text); continue; }
    if (joinLines && buf) buf += l.text;
    else { flush(); buf = l.text; }
  }
  flush();
  if (cur.paras.length || !chapters.length) chapters.push(cur);

  if (chapters.length <= 1) {
    // 没有 markdown 标题：按 txt 的"第X章"规则再试一次
    const plain = chapters[0].paras.join('\n');
    const viaTxt = parseTxt(fileName, new TextEncoder().encode(plain).buffer);
    return { title, author: '', chapters: viaTxt.chapters };
  }
  if (!chapters[0].title) chapters[0].title = '开头';
  return { title, author: '', chapters: chapters.flatMap(splitLongChapter) };
}

export async function parseFile(file) {
  const name = file.name || '未命名';
  const lower = name.toLowerCase();
  const buffer = await file.arrayBuffer();
  const isEpub = lower.endsWith('.epub') || file.type === 'application/epub+zip' ||
    (new Uint8Array(buffer, 0, 2).join(',') === '80,75' && !lower.endsWith('.txt'));
  const isMd = /\.(md|markdown)$/i.test(lower);
  const parsed = isEpub ? await parseEpub(buffer) : isMd ? parseMarkdown(name, buffer) : parseTxt(name, buffer);
  parsed.format = isEpub ? 'epub' : isMd ? 'md' : 'txt';
  parsed.chars = parsed.chapters.reduce((n, c) => n + c.paras.reduce((m, p) => m + p.length, 0), 0);
  return parsed;
}
