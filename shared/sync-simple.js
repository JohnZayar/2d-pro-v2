/**
 * Simplified Sync v1 (Pho Oct 19)
 * 
 * Design:
 * 1. Server ID only: Local `id` IS the PocketBase record ID. No _pbId mapping.
 *    - When creating locally, generate UID and use as both local and server ID.
 *    - Idempotent: retry with same ID doesn't duplicate (server returns 400, we adopt).
 * 2. FIFO queue: Push in creation order, sequentially. No parallel, no dependency ordering.
 *    - Sessions are created before records (UI flow), so FIFO naturally orders them.
 * 3. No tombstones: Delete = delete from server. If pull resurrects, it's a bug to fix.
 * 4. Pull: Full overwrite. Server wins. Simple.
 * 
 * API (same as old sync.js for drop-in replacement):
 * - mutate(op, collection, obj)
 * - queueOp(op)
 * - pushPending()
 * - pullUpdates()
 * - syncNow()
 * - getLastPushError(), getLastPullError()
 * - repushAll()
 */

import * as db from './db.js';
import * as pb from './pb.js';

let _syncing = false;
let _lastPushError = null;
let _lastPullError = null;

/** Format push error with PocketBase field details */
function _fmtErr(err) {
    if (!err) return 'Unknown error';
    let msg = (err.code || '') + ': ' + (err.message || String(err));
    // Include PocketBase field validation details
    if (err.data && err.data.data) {
        const fields = [];
        for (const [k, v] of Object.entries(err.data.data)) {
            fields.push(k + '=' + (v.message || v.code || JSON.stringify(v)));
        }
        if (fields.length) msg += ' [' + fields.join(', ') + ']';
    }
    return msg;
}

export function getLastPushError() { return _lastPushError; }
export function getLastPullError() { return _lastPullError; }
// Aliases for old sync.js API compatibility
export function lastPushError() { return _lastPushError; }
export function isSyncing() { return _syncing; }
export async function repairMissingCreated() { return { repaired: 0 }; }
export async function testPushOne(entry) { await _pushOne(entry); return 'ok'; }
let _onlineHandlerAttached = false;
export function startAutoSync(intervalMs = 60000, onSync = null) {
    if (typeof window !== 'undefined' && !_onlineHandlerAttached) {
        window.addEventListener('online', () => { syncNow(); });
        _onlineHandlerAttached = true;
    }
    if (typeof setInterval !== 'undefined') {
        setInterval(async () => {
            if (isOnline() && pb.isLoggedIn()) {
                const res = await syncNow().catch(() => null);
                if (res && typeof onSync === 'function') {
                    try { await onSync(res); } catch (e) {}
                }
            }
        }, intervalMs);
    }
}
export function isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
}

/** Queue an operation for later upload. */
export async function queueOp(op) {
    const entry = Object.assign({}, op, { created: Date.now() });
    await db.put('sync_queue', entry);
    if (isOnline() && pb.isLoggedIn()) {
        pushPending().catch(() => {});
    }
    return entry;
}

/** Write locally AND queue for sync. Obj must have `id` (used as server ID). */
export async function mutate(op, collection, obj) {
    if (op === 'delete') {
        await db.del(collection, obj.id);
    } else {
        obj._updated = Date.now();
        await db.put(collection, obj);
    }
    await queueOp({ op, collection, localId: obj.id, data: obj });
}

/** Push all queued ops in FIFO order, sequentially. */
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
                await db.del('sync_queue', entry.id).catch(() => {});
                pushed++;
            } catch (err) {
                // Keep in queue for retry. Never auto-drop (Pho: records must not be lost).
                // Continue with next (don't break) — one bad entry shouldn't block others.
                _lastPushError = _fmtErr(err);
                failed++;
            }
        }
    } finally {
        _syncing = false;
    }
    return { pushed, failed, skipped: false };
}

/** Push one queue entry. Local ID = Server ID. */
async function _pushOne(entry) {
    const { op, collection, localId, data } = entry;
    const local = await db.get(collection, localId);
    
    if (op === 'create' || op === 'update') {
        const payload = _toServerPayload(data || local);
        // Use local ID as server ID (idempotent)
        if (localId) payload.id = localId;
        
        try {
            if (op === 'create') {
                await pb.create(collection, payload);
            } else {
                // Update: try by localId (which = server ID)
                try {
                    await pb.update(collection, localId, payload);
                } catch (e) {
                    if (e && e.code === 404) {
                        // Not on server, create instead
                        await pb.create(collection, payload);
                    } else throw e;
                }
            }
        } catch (err) {
            // If 400 and we have localId, check if it already exists (lost-response retry)
            if (localId && err && (err.code === 400 || err.status === 400)) {
                try {
                    const existing = await pb.getOne(collection, localId);
                    if (existing && existing.id) {
                        return; // Already exists, adopt (no duplicate)
                    }
                } catch (e2) {
                    // If verify fails with network error, rethrow for retry
                    if (e2 && (e2.code === 'NETWORK_ERROR' || e2.code === 'TIMEOUT')) throw e2;
                    // 404 = truly not exists, rethrow original
                }
            }
            throw err;
        }
    } else if (op === 'delete') {
        // Local ID = Server ID, delete directly
        try {
            await pb.del(collection, localId);
        } catch (err) {
            if (err && err.code === 404) return; // Already gone, fine
            throw err;
        }
    }
}

/** Strip local-only fields. Keep `id` (used as server ID). */
function _toServerPayload(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
        if (k === '_pbId' || k === '_updated' || k === '_deleted') continue;
        out[k] = obj[k];
    }
    return out;
}

/** Pull all collections from server, overwrite local. */
export async function pullUpdates() {
    if (_syncing) return { pulled: 0, skipped: true };
    try { pb.loadAuth(); } catch (e) {}
    if (!pb.isLoggedIn()) return { pulled: 0, skipped: true, reason: 'not-logged-in' };
    
    _syncing = true;
    let pulled = 0;
    const errors = [];
    try {
        // Pho Oct 19: Get pending IDs from queue — don't delete unsynced local records.
        let pendingIds = new Set();
        try {
            const queue = await db.getAll('sync_queue');
            pendingIds = new Set(queue.map(e => e.localId).filter(Boolean));
        } catch (e) { /* ignore */ }
        
        const collections = ['sessions', 'lottery_records', 'winning_numbers', 'agents', 'app_settings'];
        for (const coll of collections) {
            try {
                const items = await pb.listAll(coll, { sort: '-updated' });
                const serverIds = new Set(items.map(i => i.id));
                for (const item of items) {
                    const rec = _fromServer(item);
                    await db.put(coll, rec);
                    pulled++;
                }
                // Pho Oct 19: Delete local orphans not on server (cleans duplicates).
                // Skip pending (unsynced) records — they're waiting to push.
                try {
                    const locals = await db.getAll(coll);
                    for (const local of locals) {
                        if (!serverIds.has(local.id) && !pendingIds.has(local.id)) {
                            await db.del(coll, local.id).catch(() => {});
                        }
                    }
                } catch (e) { /* ignore */ }
            } catch (err) {
                errors.push(coll + ': ' + err.message);
            }
        }
    } finally {
        _syncing = false;
    }
    if (errors.length) _lastPullError = errors.join('; ');
    return { pulled, skipped: false, error: errors.length ? errors.join('; ') : null };
}

/** Convert server record to local. ID is server ID. */
function _fromServer(item) {
    const rec = Object.assign({}, item, {
        _updated: Date.parse(item.updated) || Date.now()
    });
    // id stays as server id. No _pbId needed.
    delete rec.updated;
    delete rec.collectionId;
    delete rec.collectionName;
    delete rec.expand;
    if (typeof rec.created === 'string') {
        const t = Date.parse(rec.created);
        rec.created = isNaN(t) ? Date.now() : t;
    }
    return rec;
}

/** Full sync: push then pull. */
export async function syncNow() {
    const pushRes = await pushPending().catch(e => ({ pushed: 0, failed: 1, error: e.message }));
    const pullRes = await pullUpdates().catch(e => ({ pulled: 0, error: e.message }));
    return { push: pushRes, pull: pullRes };
}

/** Re-queue all local records for push (for repair). */
export async function repushAll() {
    const collections = ['sessions', 'lottery_records', 'winning_numbers'];
    let queued = 0;
    for (const coll of collections) {
        const all = await db.getAll(coll);
        for (const rec of all) {
            await queueOp({ op: 'create', collection: coll, localId: rec.id, data: rec });
            queued++;
        }
    }
    return { queued };
}
