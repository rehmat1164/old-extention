export const DATABASE_NAME = 'mete-run-local';
export const DATABASE_VERSION = 1;
export const STORE_NAMES = Object.freeze(['assets', 'runs', 'handles', 'drafts']);
export const CURRENT_RUN_KEY = 'current';

let databasePromise;

function storageError(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  return error;
}

function assertStoreName(store) {
  if (!STORE_NAMES.includes(store)) {
    throw new RangeError(`Unknown Mete Run store: ${store}`);
  }
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) {
    return Promise.reject(storageError('IndexedDB is unavailable in this context.'));
  }

  databasePromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(storageError('Could not open Mete Run local storage.', error));
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      STORE_NAMES.forEach((name) => {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
      });
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(storageError('Could not open Mete Run local storage.', request.error));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(storageError('Mete Run local storage is blocked by another open page.'));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (databasePromise) databasePromise = undefined;
      };
      resolve(database);
    };
  });
  return databasePromise;
}

function transact(storeName, mode, operation) {
  assertStoreName(storeName);
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    let transaction;
    let result;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(storageError(`Mete Run ${storeName} transaction failed.`, error));
      try {
        transaction?.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
    };

    try {
      transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error || storageError('Transaction aborted.'));
      operation(store, (value) => {
        result = value;
      }, fail);
    } catch (error) {
      fail(error);
    }
  }));
}

function requestOperation(storeName, mode, createRequest) {
  return transact(storeName, mode, (store, setResult, fail) => {
    let request;
    try {
      request = createRequest(store);
    } catch (error) {
      fail(error);
      return;
    }
    request.onsuccess = () => setResult(request.result);
    request.onerror = () => fail(request.error);
  });
}

export function get(store, key) {
  return requestOperation(store, 'readonly', (objectStore) => objectStore.get(key));
}

export function put(store, key, value) {
  return requestOperation(store, 'readwrite', (objectStore) => objectStore.put(value, key));
}

export function remove(store, key) {
  return requestOperation(store, 'readwrite', (objectStore) => objectStore.delete(key));
}

export function clear(store) {
  return requestOperation(store, 'readwrite', (objectStore) => objectStore.clear());
}

export function entries(store) {
  return transact(store, 'readonly', (objectStore, setResult, fail) => {
    const values = [];
    let request;
    try {
      request = objectStore.openCursor();
    } catch (error) {
      fail(error);
      return;
    }
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        setResult(values);
        return;
      }
      values.push({ key: cursor.key, value: cursor.value });
      try {
        cursor.continue();
      } catch (error) {
        fail(error);
      }
    };
    request.onerror = () => fail(request.error);
  });
}

export function getCurrentRun() {
  return get('runs', CURRENT_RUN_KEY);
}

export function putCurrentRun(session) {
  return put('runs', CURRENT_RUN_KEY, session);
}
