// IndexedDB 封装：books 存书的元数据和阅读进度，contents 存解析后的章节正文
const DB_NAME = 'zreader';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('contents')) db.createObjectStore('contents', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export const db = {
  allBooks: () => run('books', 'readonly', s => s.getAll()),
  getBook: id => run('books', 'readonly', s => s.get(id)),
  putBook: book => run('books', 'readwrite', s => s.put(book)),
  getContent: id => run('contents', 'readonly', s => s.get(id)),
  putContent: content => run('contents', 'readwrite', s => s.put(content)),
  async deleteBook(id) {
    await run('books', 'readwrite', s => s.delete(id));
    await run('contents', 'readwrite', s => s.delete(id));
  },
};

// 向浏览器申请持久化存储，减少 iOS 自动清理数据的可能
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) await navigator.storage.persist();
    }
  } catch (_) { /* 不支持就算了 */ }
}
