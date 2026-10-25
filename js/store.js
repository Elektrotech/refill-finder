// Minimaler IndexedDB-Wrapper. Speichert alle bereits gesehenen Stationen und deren Details,
// damit die Suche nach der nächsten Station auch offline funktioniert.
// Fällt IndexedDB aus (privater Modus o. Ä.), arbeitet die App ohne Persistenz weiter.

const DB_NAME = 'refill-finder';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('stations')) db.createObjectStore('stations', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('details')) db.createObjectStore('details', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(err => {
      console.warn('IndexedDB nicht verfügbar', err);
      return null;
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function safe(fn, fallback) {
  try {
    const db = await open();
    return db ? await fn(db) : fallback;
  } catch (err) {
    console.warn('IndexedDB-Fehler', err);
    return fallback;
  }
}

export const getAllStations = () => safe(db => request(db.transaction('stations').objectStore('stations').getAll()), []);

export const putStations = (list, removeIds = []) => safe(async db => {
  const tx = db.transaction('stations', 'readwrite');
  const os = tx.objectStore('stations');
  for (const id of removeIds) os.delete(id);
  for (const s of list) os.put(s);
  await done(tx);
});

export const getDetails = ids => safe(async db => {
  const os = db.transaction('details').objectStore('details');
  const results = await Promise.all(ids.map(id => request(os.get(id))));
  return results.filter(Boolean);
}, []);

export const putDetails = list => safe(async db => {
  const tx = db.transaction('details', 'readwrite');
  const os = tx.objectStore('details');
  for (const d of list) os.put(d);
  await done(tx);
});

export const getMeta = key => safe(db => request(db.transaction('meta').objectStore('meta').get(key)), undefined);

export const setMeta = (key, value) => safe(async db => {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
});
