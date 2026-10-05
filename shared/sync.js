/**
 * sync.js — Background sync for 2D Pro v2 (local-first)
 *
 * Strategy:
 *  - UI always reads/writes IndexedDB (instant, works offline).
 *  - Mutations are ALSO queued in `sync_queue` when offline (or always,
 *    so the server eventually converges).
 *  - pushPending(): uploads queued ops (create/update/delete) to PocketBase.
 *  - pullUpdates(): fetches server records newer than local copies.
 *  - Conflict resolution: last-write-wins via `_updated` timestamps.
 *
 * Sync queue entry shape:
 *   { op: 'create'|'update'|'delete', collection, localId, data, created }
 *
 * Server id mapping: local records keep `id` (local) and `_pbId`
 * (PocketBase id) once pushed. Queue ops carry both.
 *
 * Use as ES6 module:  import * as sync from './sync.js'
 */

import * as db from './db.js';
import * as pb from './pb.js';

// Collections that participate in sync (local store name -> PB collection)
const SYNC_COLLECTIONS = [
    'tenants',
    'sessions',
    'lottery_records',
    'winning_numbers',
    'agents',
    'app_settings'
];

let _syncing = false;
let _onlineHandlerAttached = false;

export function isSyncing() {
    return _syncing;
}

/** Browser online status (best effort). */
export function isOnline() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/**
 * Queue an operation for later upload. Call this for every mutation
 * so offline work is not lost.
 *
 * @param {object} op { op:'create'|'update'|'delete', collection, localId, data }
 */
export async function queueOp(op) {
    const entry = Object.assign({}, op, { created: Date.now() });
    await db.put('sync_queue', entry);
    // Opportunistic: try pushing right away if online.
    if (isOnline() && pb.isLoggedIn()) {
        pushPending().catch(() => { /* will retry later */ });
    }
    return entry;
}

/**
 * High-level mutation helper: write locally AND queue for sync.
 *
 * @param {'create'|'update'|'delete'} op
 * @param {string} collection  local store / PB collection name
 * @param {object} obj         must have `id` (local id)
 */
export async function mutate(op, collection, obj) {
    if (op === 'delete') {
        await db.del(collection, obj.id);
    } else {
        await db.put(collection, obj);
    }
    await queueOp({ op, collection, localId: obj.id, data: obj });
}

/**
 * Push all queued operations to PocketBase, oldest first.
 * Successful ops are removed from the queue. Failures stay queued
 * (except unrecoverable 4xx errors, which are dropped to avoid poison).
 */
export async function pushPending() {
    if (_syncing) return { pushed: 0, failed: 0, skipped: true };
    if (!pb.isLoggedIn()) return { pushed: 0, failed: 0, skipped: true, reason: 'not-logged-in' };

    _syncing = true;
    let pushed = 0, failed = 0;
    try {
        const queue = (await db.getAll('sync_queue'))
            .sort((a, b) => (a.created || 0) - (b.created || 0));

        for (const entry of queue) {
            try {
                await _pushOne(entry);
                await db.del('sync_queue', entry.id);
                pushed++;
            } catch (err) {
                // Drop unrecoverable client errors (bad data); keep the rest.
                if (err && err.code >= 400 && err.code < 500 && err.code !== 429) {
                    console.warn('[sync] dropping poison op', entry, err.message);
                    await db.del('sync_queue', entry.id);
                } else {
                    failed++;
                    // Stop on first transient failure to preserve order.
                    break;
                }
            }
        }
    } finally {
        _syncing = false;
    }
    return { pushed, failed, skipped: false };
}

async function _pushOne(entry) {
    const { op, collection, localId, data } = entry;
    const local = await db.get(collection, localId);

    if (op === 'create') {
        // Don't send local-only bookkeeping fields to the server.
        const payload = _toServerPayload(data || local);
        const created = await pb.create(collection, payload);
        // Remember the server id on the local record.
        const updatedLocal = Object.assign({}, (local || data || {}), {
            _pbId: created.id,
            _updated: Date.now()
        });
        await db.put(collection, updatedLocal);
    } else if (op === 'update') {
        const pbId = (local && local._pbId) || (data && data._pbId);
        if (!pbId) {
            // Never pushed before — treat as create.
            return _pushOne({ op: 'create', collection, localId, data });
        }
        const payload = _toServerPayload(data || local);
        await pb.update(collection, pbId, payload);
    } else if (op === 'delete') {
        const pbId = (local && local._pbId) || (data && data._pbId);
        if (pbId) {
            try {
                await pb.del(collection, pbId);
            } catch (err) {
                if (!(err && err.code === 404)) throw err; // already gone = fine
            }
        }
    }
}

/** Strip local-only fields before sending to PocketBase. */
function _toServerPayload(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
        if (k === 'id' || k === '_pbId' || k === '_updated' || k === '_deleted') continue;
        out[k] = obj[k];
    }
    return out;
}

/**
 * Pull server changes into IndexedDB.
 * For each collection, fetches records updated since the last pull
 * (tracked per-collection in app_settings under key `sync:lastPull:<collection>`).
 * Last-write-wins: server record wins only if its `updated` is newer
 * than the local `_updated`.
 */
export async function pullUpdates() {
    if (_syncing) return { pulled: 0, skipped: true };
    if (!pb.isLoggedIn()) return { pulled: 0, skipped: true, reason: 'not-logged-in' };

    _syncing = true;
    let pulled = 0;
    try {
        for (const collection of SYNC_COLLECTIONS) {
            try {
                pulled += await _pullCollection(collection);
            } catch (err) {
                console.warn('[sync] pull failed for', collection, err.message);
            }
        }
    } finally {
        _syncing = false;
    }
    return { pulled, skipped: false };
}

async function _pullCollection(collection) {
    const lastPull = await _getLastPull(collection);
    // PocketBase `updated` is an ISO datetime string.
    const filter = lastPull ? `updated > "${lastPull}"` : '';
    const items = await pb.listAll(collection, { filter, sort: 'updated' });

    let count = 0;
    let maxUpdated = lastPull || '';
    for (const item of items) {
        if (item.updated && item.updated > maxUpdated) maxUpdated = item.updated;
        // Find local record by _pbId.
        const local = await _findLocalByPbId(collection, item.id);
        const serverTime = Date.parse(item.updated) || 0;
        if (!local) {
            await db.put(collection, _fromServerRecord(collection, item));
            count++;
        } else if (serverTime > (local._updated || 0)) {
            // Server is newer → overwrite local (last-write-wins).
            await db.put(collection, _fromServerRecord(collection, item, local.id));
            count++;
        }
        // else: local is newer or equal → keep local; push will send it up.
    }
    if (maxUpdated) await _setLastPull(collection, maxUpdated);
    return count;
}

async function _findLocalByPbId(collection, pbId) {
    const all = await db.getAll(collection);
    return all.find((r) => r._pbId === pbId) || null;
}

function _fromServerRecord(collection, item, localId) {
    const rec = Object.assign({}, item, {
        _pbId: item.id,
        _updated: Date.parse(item.updated) || Date.now()
    });
    // Keep a stable local id across pulls.
    rec.id = localId || item.id;
    delete rec.created;
    delete rec.updated;
    delete rec.collectionId;
    delete rec.collectionName;
    delete rec.expand;
    return rec;
}

async function _getLastPull(collection) {
    const rec = await db.get('app_settings', `sync:lastPull:${collection}`);
    return rec ? rec.value : '';
}

async function _setLastPull(collection, iso) {
    await db.put('app_settings', {
        id: `sync:lastPull:${collection}`,
        key: `sync:lastPull:${collection}`,
        value: iso
    });
}

/**
 * Full sync: push pending ops, then pull updates.
 * Safe to call on app start, on reconnect, and on a timer.
 */
export async function syncNow() {
    const pushRes = await pushPending().catch((e) => ({ pushed: 0, failed: 1, error: e.message }));
    const pullRes = await pullUpdates().catch((e) => ({ pulled: 0, error: e.message }));
    return { push: pushRes, pull: pullRes };
}

/**
 * Attach automatic sync triggers: on `online` event and every interval.
 * @param {number} intervalMs default 60s
 */
export function startAutoSync(intervalMs = 60000) {
    if (typeof window !== 'undefined' && !_onlineHandlerAttached) {
        window.addEventListener('online', () => { syncNow(); });
        _onlineHandlerAttached = true;
    }
    if (typeof setInterval !== 'undefined') {
        setInterval(() => {
            if (isOnline() && pb.isLoggedIn()) syncNow();
        }, intervalMs);
    }
}
