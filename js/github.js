// GitHub 仓库当云端书库：列出 / 下载书籍文件，读写 progress.json
// 公开仓库不需要 Token；私有仓库或要同步进度时需要一个有 Contents 权限的 Token

const API = 'https://api.github.com';

export function normalizeCloudConfig(raw) {
  const cfg = Object.assign({ repo: '', folder: '', token: '', sync: true }, raw || {});
  cfg.repo = String(cfg.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  cfg.folder = String(cfg.folder || '').trim().replace(/^\/+|\/+$/g, '');
  cfg.token = String(cfg.token || '').trim();
  cfg.sync = !!cfg.sync;
  return cfg;
}

export function loadCloudConfig() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('zreader.cloud') || '{}'); } catch (_) { /* ignore */ }
  return normalizeCloudConfig(raw);
}

export function saveCloudConfig(cfg) {
  try { localStorage.setItem('zreader.cloud', JSON.stringify(normalizeCloudConfig(cfg))); } catch (_) { /* ignore */ }
}

function headers(token, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function explain(res) {
  if (res.status === 401) return 'Token 无效或已过期';
  if (res.status === 403) return '没有权限（Token 权限不够，或请求次数超限）';
  if (res.status === 404) return '找不到仓库或文件夹（私有仓库需要 Token）';
  return `GitHub 返回 ${res.status}`;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function request(url, { token, accept, method = 'GET', body, signal, keepalive } = {}) {
  const res = await fetch(url, {
    method, headers: Object.assign(headers(token, accept), body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined, signal, keepalive, cache: 'no-store',
  });
  return res;
}

// 列出文件夹里的 txt / epub
export async function listBooks(cfg, { signal } = {}) {
  if (!cfg.repo) throw new Error('还没有设置仓库');
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(cfg.folder)}`;
  const res = await request(url, { token: cfg.token, signal });
  if (!res.ok) throw new Error(explain(res));
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('书库路径不是文件夹');
  return data
    .filter(it => it.type === 'file' && /\.(txt|epub)$/i.test(it.name))
    .map(it => ({ name: it.name, path: it.path, size: it.size, sha: it.sha }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

// 下载文件内容（ArrayBuffer）
export async function downloadBook(cfg, path, { signal, onProgress } = {}) {
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(path)}`;
  const res = await request(url, { token: cfg.token, accept: 'application/vnd.github.raw+json', signal });
  if (!res.ok) throw new Error(explain(res));
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

// 读取 JSON 文件，不存在返回 null
export async function getJson(cfg, path, { signal } = {}) {
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(path)}`;
  const res = await request(url, { token: cfg.token, signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(explain(res));
  const meta = await res.json();
  let text = '';
  if (meta.encoding === 'base64' && meta.content) {
    const bin = atob(meta.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    text = new TextDecoder('utf-8').decode(bytes);
  } else {
    const raw = await request(url, { token: cfg.token, accept: 'application/vnd.github.raw+json', signal });
    text = await raw.text();
  }
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  return { data, sha: meta.sha };
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 写 JSON 文件；sha 为已有文件的 sha（新建时不传）。返回新的 sha。冲突时抛出 err.conflict = true
export async function putJson(cfg, path, data, { sha, message, signal, keepalive } = {}) {
  if (!cfg.token) throw new Error('写入需要 Token');
  const url = `${API}/repos/${cfg.repo}/contents/${encodePath(path)}`;
  const body = { message: message || `update ${path}`, content: toBase64(JSON.stringify(data, null, 1)) };
  if (sha) body.sha = sha;
  const res = await request(url, { token: cfg.token, method: 'PUT', body, signal, keepalive });
  if (res.status === 409 || res.status === 422) {
    const err = new Error('文件已被其他设备修改');
    err.conflict = true;
    throw err;
  }
  if (!res.ok) throw new Error(explain(res));
  const out = await res.json();
  return out.content && out.content.sha;
}

// 测试连接：能列出文件夹即可；有 Token 时顺便检查写权限（看 permissions）
export async function testConnection(cfg) {
  const books = await listBooks(cfg);
  let canWrite = false;
  if (cfg.token) {
    try {
      const res = await request(`${API}/repos/${cfg.repo}`, { token: cfg.token });
      if (res.ok) {
        const info = await res.json();
        canWrite = !!(info.permissions && (info.permissions.push || info.permissions.admin));
      }
    } catch (_) { /* ignore */ }
  }
  return { count: books.length, canWrite };
}
