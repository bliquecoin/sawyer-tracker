(function (root) {
  "use strict";
  function create({ state, memoryStores, clone, DB_NAME, DB_VERSION }) {
    function openDb() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          state.storageUnavailable = true;
          reject(new Error("IndexedDB is not available."));
          return;
        }

        const timeoutId = setTimeout(() => {
          state.storageUnavailable = true;
          reject(new Error("IndexedDB did not respond."));
        }, 2500);
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("profile")) {
            db.createObjectStore("profile", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("settings")) {
            db.createObjectStore("settings", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("schedules")) {
            const schedules = db.createObjectStore("schedules", { keyPath: "id" });
            schedules.createIndex("dogId", "dogId");
            schedules.createIndex("kind", "kind");
          }
          if (!db.objectStoreNames.contains("events")) {
            const events = db.createObjectStore("events", { keyPath: "id" });
            events.createIndex("dogId", "dogId");
            events.createIndex("type", "type");
            events.createIndex("occurredAt", "occurredAt");
            events.createIndex("dayKey", "dayKey");
            events.createIndex("doseKey", "doseKey", { unique: false });
            events.createIndex("syncStatus", "syncStatus");
          }
        };

        request.onsuccess = () => {
          clearTimeout(timeoutId);
          resolve(request.result);
        };
        request.onerror = () => {
          clearTimeout(timeoutId);
          state.storageUnavailable = true;
          reject(request.error);
        };
        request.onblocked = () => {
          clearTimeout(timeoutId);
          state.storageUnavailable = true;
          reject(new Error("IndexedDB is blocked by another Safari tab."));
        };
      });
    }

    async function dbGetAll(storeName) {
      if (state.storageUnavailable) return memoryGetAll(storeName);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      });
    }

    async function dbGet(storeName, key) {
      if (state.storageUnavailable) return memoryGet(storeName, key);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      });
    }

    async function dbPut(storeName, value) {
      if (state.storageUnavailable) return memoryPut(storeName, value);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => {
          db.close();
          resolve(value);
        };
        tx.onerror = () => reject(tx.error);
      });
    }

    async function dbBulkPut(storeName, values) {
      if (state.storageUnavailable) return memoryBulkPut(storeName, values);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        values.forEach((value) => store.put(value));
        tx.oncomplete = () => {
          db.close();
          resolve(values);
        };
        tx.onerror = () => reject(tx.error);
      });
    }

    async function dbDelete(storeName, key) {
      if (state.storageUnavailable) return memoryDelete(storeName, key);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    }

    async function dbClear(storeName) {
      if (state.storageUnavailable) return memoryClear(storeName);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    }

    function memoryGetAll(storeName) {
      return Array.from(memoryStores[storeName]?.values() || []).map(clone);
    }

    function memoryGet(storeName, key) {
      const value = memoryStores[storeName]?.get(key);
      return value ? clone(value) : null;
    }

    function memoryPut(storeName, value) {
      memoryStores[storeName]?.set(value.id, clone(value));
      return clone(value);
    }

    function memoryBulkPut(storeName, values) {
      values.forEach((value) => memoryPut(storeName, value));
      return values.map(clone);
    }

    function memoryDelete(storeName, key) {
      memoryStores[storeName]?.delete(key);
    }

    function memoryClear(storeName) {
      memoryStores[storeName]?.clear();
    }

    return { dbGetAll, dbGet, dbPut, dbBulkPut, dbDelete, dbClear };
  }
  root.SawyerTrackerStorage = { create };
})(globalThis);
