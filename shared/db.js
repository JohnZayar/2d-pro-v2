/**
 * db.js — IndexedDB wrapper for 2D Pro v2 (local-first storage)
 *
 * Stores (object stores):
 *  - tenants, sessions, lottery_records, winning_numbers, agents, app_settings
 *  - sync_queue (offline operations pending upload)
 *
 * All methods return Promises. No external dependencies.
 * Use as ES6 module:  import { put, get, getAll, query, del, clear } from './db.js'
 */

const DB_NAME = '2dProV2';
const DB_VERSION = 2;

const STORES = [
    'tenants',
    'sessions',
    'lottery_records',
    'winning_numbers',
    'agents',
    'app_settings',
    'players',
    'sync_queue'
];

// Indexes per store: { storeName: [ {name, keyPath, unique} ] }
// lottery_records gets useful query indexes for ledger/session views.
const INDEXES = {
    lottery_records: [
        { name: 'by_session', keyPath: 'session', unique: false },
        { name: 'by_tenant', keyPath: 'tenant', unique: false },
        { name: 'by_number', keyPath: 'number', unique: false }
    ],
    sessions: [
        { name: 'by_tenant', keyPath: 'tenant', unique: false }
    ],
    winning_numbers: [
        { name: 'by_tenant', keyPath: 'tenant', unique: false },
        { name: 'by_session', keyPath: 'session', unique: false }
    ],
    agents: [
        { name: 'by_tenant', keyPath: 'tenant', unique: false }
    ],
    players: [
        { name: 'by_tenant', keyPath: 'tenant', unique: false },
        { name: 'by_agent', keyPath: 'agent_name', unique: false }
    ],
    app_settings: [
        { name: 'by_tenant', keyPath: 'tenant', unique: false }
    ],
    sync_queue: [
        { name: 'by_created', keyPath: 'created', unique: false }
    ]
};

let _db = null;

/** Open (or create) the database. Resolves with the IDBDatabase. */
export function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            for (const storeName of STORES) {
                if (!db.objectStoreNames.contains(storeName)) {
                    // Use 'id' as keyPath when present; sync_queue uses auto-increment.
                    const opts = storeName === 'sync_queue'
                        ? { keyPath: 'id', autoIncrement: true }
                        : { keyPath: 'id' };
                    const store = db.createObjectStore(storeName, opts);
                    const idxs = INDEXES[storeName] || [];
                    for (const idx of idxs) {
                        store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
                    }
                }
            }
        };

        req.onsuccess = (e) => {
            _db = e.target.result;
            // Close cleanly on version change from another tab.
            _db.onversionchange = () => { _db.close(); _db = null; };
            resolve(_db);
        };
        req.onerror = (e) => reject(e.target.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked: close other tabs using 2D Pro v2'));
    });
}

/** Run a transaction and return a promise for the request result. */
function _tx(storeName, mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let req;
        try {
            req = fn(store);
        } catch (err) {
            reject(err);
            return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
    }));
}

/**
 * Insert or update a record. Object should have an `id` field
 * (except sync_queue entries, which get auto-increment ids).
 */
export function put(store, obj) {
    // Stamp local updated time for last-write-wins conflict resolution.
    const stamped = Object.assign({}, obj, { _updated: Date.now() });
    return _tx(store, 'readwrite', (s) => s.put(stamped));
}

/** Get a single record by id. Resolves with the record or undefined. */
export function get(store, id) {
    return _tx(store, 'readonly', (s) => s.get(id));
}

/** Get all records in a store. */
export function getAll(store) {
    return _tx(store, 'readonly', (s) => s.getAll());
}

/**
 * Query by index: query('lottery_records', 'by_session', sessionId)
 * Returns matching records.
 */
export function query(store, indexName, value) {
    return openDB().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const idx = tx.objectStore(store).index(indexName);
        const req = idx.getAll(value);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

/** Delete a record by id. */
export function del(store, id) {
    return _tx(store, 'readwrite', (s) => s.delete(id));
}

/** Remove all records from a store. */
export function clear(store) {
    return _tx(store, 'readwrite', (s) => s.clear());
}

/** Count records in a store. */
export function count(store) {
    return _tx(store, 'readonly', (s) => s.count());
}

// Alias `delete` is a reserved word; export `del` and also provide `remove`.
export { del as remove };
