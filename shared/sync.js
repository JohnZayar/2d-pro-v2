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
    // 'players' REMOVED Pho Oct 18: server 500 'Something went wrong' on push;
    // Agent player list stays local (not needed by Master). Prevents sync block.
    'app_settings'
];

let _syncing = false;
let _pushAgain = false;
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
        // Mark as locally modified for last-write-wins.
        obj._updated = Date.now();
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
    if (_syncing) {
        // A push is already running; mark that another is needed after it finishes
        // (prevents lost pushes when many mutates happen in quick succession).
        _pushAgain = true;
        return { pushed: 0, failed: 0, skipped: true };
    }
    if (!pb.isLoggedIn()) return { pushed: 0, failed: 0, skipped: true, reason: 'not-logged-in' };

    _syncing = true;
    let pushed = 0, failed = 0;
    try {
        // Pho Oct 18: purge stale 'players' ops from queue (server 500s on players;
        // players removed from sync in v21 — old queued entries would block forever)
        try {
            const q = await db.getAll('sync_queue');
            for (const e of q) {
                if (e.collection === 'players') await db.del('sync_queue', e.id).catch(() => {});
            }
        } catch (e) { /* ignore */ }
        do {
            _pushAgain = false;
            const queue = (await db.getAll('sync_queue'))
            .sort((a, b) => (a.created || 0) - (b.created || 0));

        // Bulk 'create' ops (the common case: dozens of numbers saved at once)
        // go out in parallel — one wave of round-trips instead of N sequential ones.
        // Updates/deletes stay sequential to preserve per-record order.
        // (Server has the batch API disabled, so parallel singles is the fastest path.)
        const creates = queue.filter((e) => e.op === 'create');
        const others = queue.filter((e) => e.op !== 'create');

        // Pho Oct 19: Push in DEPENDENCY ORDER — sessions BEFORE lottery_records/winning_numbers.
        // (Parallel push of all creates broke this: records were sent with local session IDs
        //  before the session got its server _pbId → server 400.)
        const createsByColl = {};
        for (const e of creates) {
            (createsByColl[e.collection] = createsByColl[e.collection] || []).push(e);
        }
        // Order: tenants → sessions → lottery_records → winning_numbers → agents → app_settings
        const createOrder = ['tenants', 'sessions', 'lottery_records', 'winning_numbers', 'agents', 'app_settings'];
        for (const coll of createOrder) {
            const list = createsByColl[coll] || [];
            if (!list.length) continue;
            const outcomes = await _mapConcurrent(list, 6, _pushEntrySettled);
            for (const o of outcomes) {
                if (o === 'pushed') pushed++;
                else if (o === 'failed') failed++;
                // 'dropped' (poison data): removed from queue, counts as neither
            }
        }
        // Any creates for unknown collections (shouldn't happen, but be safe)
        for (const coll of Object.keys(createsByColl)) {
            if (createOrder.includes(coll)) continue;
            const outcomes = await _mapConcurrent(createsByColl[coll], 6, _pushEntrySettled);
            for (const o of outcomes) {
                if (o === 'pushed') pushed++;
                else if (o === 'failed') failed++;
            }
        }

        for (const entry of others) {
            const outcome = await _pushEntrySettled(entry);
            if (outcome === 'pushed') pushed++;
            else if (outcome === 'failed') { failed++; break; } // transient: keep order, retry next cycle
            // 'dropped': removed from queue, continue
        }
        } while (_pushAgain);
    } finally {
        _syncing = false;
        _pushAgain = false;
    }
    return { pushed, failed, skipped: false };
}

/**
 * Push one queue entry; settle its queue row.
 * Returns 'pushed' | 'dropped' (poison 4xx, removed) | 'failed' (transient, kept for retry).
 */
async function _pushEntrySettled(entry) {
    try {
        await _pushOne(entry);
    } catch (err) {
        // Pho Oct 19: SESSION_NOT_SYNCED is retryable (session will be pushed first
        // due to dependency order) — never drop it.
        if (err && err.code === 'SESSION_NOT_SYNCED') {
            _lastPushError = 'Session not yet synced, will retry';
            return 'failed';
        }
        // Pho Oct 19: DO NOT auto-drop 4xx errors. Pho's rule: "whatever is added
        // or deleted must keep working" — dropped records are lost forever.
        // Only the explicit blank-session poison (handled in _pushOne) is dropped.
        // All other failures stay queued for retry. User can manually clear via
        // Settings → App Reset if truly stuck.
        // 429 (rate limit) also stays queued.
        _lastPushError = (err && (err.code + ': ' + err.message)) || String(err);
        return 'failed';
    }
    await db.del('sync_queue', entry.id).catch(() => {});
    return 'pushed';
}

/** Run fn over items with at most `limit` concurrent workers. Returns fn's return values in order. */
async function _mapConcurrent(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            try { out[i] = await fn(items[i]); }
            catch (e) { out[i] = 'failed'; }
        }
    }
    const workers = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
}

async function _pushOne(entry) {
    const { op, collection, localId, data } = entry;
    const local = await db.get(collection, localId);

    // Pho Oct 18: Drop lottery_records/winning_numbers with blank session
    // — server returns 400 "Cannot be blank", and retrying forever blocks the queue.
    // (Root cause of Oct 18 sync failure; found via direct API reproduction.)
    if ((collection === 'lottery_records' || collection === 'winning_numbers') && op === 'create') {
        const sessVal = (data && data.session) || (local && local.session);
        if (!(sessVal && String(sessVal).trim())) {
            await db.del('sync_queue', entry.id).catch(() => {});
            return 'dropped';
        }
    }

    // Resolve local session ID → server session ID for relations.
    // (Server expects PB IDs, not local UIDs.)
    // Pho Oct 19: If the session has no _pbId yet (not pushed), DO NOT attempt the push.
    // Attempting with a local ID → server 400 → _pushEntrySettled DROPS it (lost forever).
    // Instead, throw a retryable error so it stays queued until the session is pushed.
    let payloadData = data || local;
    if (payloadData && payloadData.session && (collection === 'winning_numbers' || collection === 'lottery_records')) {
        const sess = await db.get('sessions', payloadData.session);
        if (sess && sess._pbId) {
            payloadData = Object.assign({}, payloadData, { session: sess._pbId });
        } else {
            // Pho Oct 19: Session not in local DB (null) OR exists but no _pbId —
            // do NOT push with local ID (server 400). Retry later.
            const e = new Error('Session not yet synced, retry later');
            e.code = 'SESSION_NOT_SYNCED';
            throw e;
        }
    }

    if (op === 'create') {
        // Pho Oct 18: IDEMPOTENT create — send the local id as the server record id.
        // If a previous attempt reached the server but the response was lost
        // (tunnel blip / timeout), the retry gets 400 (id exists) instead of
        // creating a duplicate. We then fetch and adopt the existing record.
        const payload = _toServerPayload(payloadData);
        if (localId) payload.id = localId;
        let created;
        try {
            created = await pb.create(collection, payload);
        } catch (err) {
            if (localId && err && (err.code === 400 || err.status === 400)) {
                // May already exist from a lost-response attempt — verify.
                try {
                    const existing = await pb.getOne(collection, localId);
                    if (existing && existing.id) {
                        const updatedLocal = Object.assign({}, (local || data || {}), {
                            _pbId: existing.id,
                            _updated: Date.now()
                        });
                        await db.put(collection, updatedLocal);
                        return; // adopted — no duplicate created
                    }
                } catch (e2) {
                    // 404 = truly not on server → original 400 was real bad data.
                    // Network/timeout on the verify → rethrow e2 so the op is
                    // RETRIED, never dropped as poison (Pho: records must not be lost).
                    if (e2 && (e2.code === 'NETWORK_ERROR' || e2.code === 'TIMEOUT' || (typeof e2.code === 'number' && e2.code >= 500))) {
                        throw e2;
                    }
                    // else: 404 → fall through and rethrow original 400
                }
            }
            throw err;
        }
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
        const payload = _toServerPayload(payloadData);
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
    // Ensure auth is loaded in this module instance (app.js and sync.js may
    // have different module instances due to ?v= cache busting; localStorage is shared).
    try { pb.loadAuth(); } catch (e) { /* ignore */ }
    if (!pb.isLoggedIn()) return { pulled: 0, skipped: true, reason: 'not-logged-in' };

    _syncing = true;
    let pulled = 0;
    const errors = [];
    try {
        // Pull all collections in parallel — sequential pulls through the tunnel
        // made every sync cycle 6x slower than needed. Collections are independent.
        const counts = await Promise.all(SYNC_COLLECTIONS.map((collection) =>
            _pullCollection(collection).catch((err) => {
                console.warn('[sync] pull failed for', collection, err.message);
                errors.push(collection + ': ' + err.message);
                return 0;
            })
        ));
        pulled = counts.reduce((a, b) => a + b, 0);
    } finally {
        _syncing = false;
    }
    return { pulled, skipped: false, error: errors.length ? errors.join('; ') : null };
}

/** True if this device tombstoned (user-deleted) the given server session id. */
function _isSessionTombstoned(pbId) {
    try {
        const arr = JSON.parse(localStorage.getItem('v2_deleted_sessions') || '[]');
        return Array.isArray(arr) && arr.includes(pbId);
    } catch (e) { return false; }
}

async function _pullCollection(collection) {
    const lastPull = await _getLastPull(collection);
    // PocketBase `updated` is an ISO datetime string.
    // Sessions: always full pull (small collection, avoids watermark issues).
    const filter = (collection === 'sessions' || collection === 'winning_numbers' || !lastPull) ? '' : `updated > "${lastPull}"`;
    const items = await pb.listAll(collection, { filter, sort: 'updated' });

    let count = 0;
    let maxUpdated = lastPull || '';
    for (const item of items) {
        if (item.updated && item.updated > maxUpdated) maxUpdated = item.updated;
        // Skip sessions the user deleted on this device (tombstones). Sessions
        // are fully re-pulled every cycle, so without this a failed/pending
        // server-side delete would resurrect the session on the next pull.
        if (collection === 'sessions' && _isSessionTombstoned(item.id)) continue;
        // Find local record by _pbId.
        const local = await _findLocalByPbId(collection, item.id);
        const serverTime = Date.parse(item.updated) || 0;
        if (!local) {
            let rec = _fromServerRecord(collection, item);
            // Resolve server session ID → local session ID (for winning_numbers, lottery_records).
            // Server stores the PB session ID; local queries use the local session ID.
            if ((collection === 'winning_numbers' || collection === 'lottery_records') && rec.session) {
                const ls = await _findLocalByPbId('sessions', rec.session);
                if (ls) rec.session = ls.id;
            }
            await db.put(collection, rec);
            count++;
        } else if (serverTime > (local._updated || 0)) {
            // Server is newer → overwrite local (last-write-wins),
            // but never lose the local `created` timestamp (Daily/Weekly need it).
            const rec = _fromServerRecord(collection, item, local.id);
            if (rec.created == null && local.created != null) rec.created = local.created;
            // Resolve server session ID → local session ID (for winning_numbers, lottery_records).
            if ((collection === 'winning_numbers' || collection === 'lottery_records') && rec.session) {
                const ls = await _findLocalByPbId('sessions', rec.session);
                if (ls) rec.session = ls.id;
            }
            await db.put(collection, rec);
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
    // Preserve a usable `created` timestamp: PocketBase sends an ISO string;
    // local views (Daily/Weekly) sort and filter by a ms timestamp. Never drop it.
    if (typeof rec.created === 'string') {
        const t = Date.parse(rec.created);
        rec.created = isNaN(t) ? Date.now() : t;
    } else if (typeof rec.created !== 'number') {
        delete rec.created; // caller falls back to local.created
    }
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
 * Repair: backfill `created` timestamps wiped by the old pull logic
 * (which deleted `created` on server overwrite). Only records already
 * pushed (have `_pbId`) can be repaired from the server.
 * Cheap no-op when nothing is broken — safe to call on every app start.
 * Returns { fixed, broken }. Callers should refresh the UI if fixed > 0.
 * NOTE: call AFTER syncNow() completes to avoid racing the pull.
 */
export async function repairMissingCreated() {
    try {
        const all = await db.getAll('lottery_records');
        const broken = all.filter((r) => (r.created == null || r.created === 0) && r._pbId);
        if (!broken.length) return { fixed: 0, broken: 0 };
        let fixed = 0;
        for (const r of broken) {
            try {
                // Re-read: a concurrent sync may already have fixed it
                const fresh = await db.get('lottery_records', r.id).catch(() => null);
                if (fresh && fresh.created != null && fresh.created !== 0) continue;
                const item = await pb.getOne('lottery_records', r._pbId);
                const t = Date.parse(item && item.created);
                if (!isNaN(t)) {
                    const target = fresh || r;
                    target.created = t;
                    await db.put('lottery_records', target);
                    fixed++;
                }
            } catch (e) { /* tunnel flaky — will retry next app start */ }
        }
        return { fixed, broken: broken.length };
    } catch (e) {
        return { fixed: 0, broken: 0 };
    }
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

/** Last transient push error (for diagnostics). */
let _lastPushError = null;
export function lastPushError() { return _lastPushError; }

/**
 * Attach automatic sync triggers: on `online` event and every interval.
 * @param {number} intervalMs default 60s
 */
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
                    try { await onSync(res); } catch (e) { /* UI refresh must not break sync */ }
                }
            }
        }, intervalMs);
    }
}

/**
 * Disaster recovery: re-push ALL local records to the server.
 * Use when the server database was wiped but phones still have the data.
 * Queues every local record in the given collections as a 'create', then pushes.
 * The server assigns fresh IDs (empty server = no conflicts).
 * @param {string[]} collections default: data collections (not tenants/users)
 * @returns {Promise<{queued:number, pushed:number, failed:number, errors:string[]}>}
 */
export async function repushAll(collections) {    const cols = collections || ['sessions', 'lottery_records', 'winning_numbers', 'agents'];
    let queued = 0, skippedBlankSession = 0;
    const errors = [];
    for (const col of cols) {
        let records = [];
        try {
            records = await db.getAll(col);
        } catch (e) {
            errors.push(`${col}: read failed (${e.message})`);
            continue;
        }
        for (const rec of records) {
            try {
                // Pho Oct 18: skip lottery_records with blank session (server 400 "Cannot be blank")
                // — these are poison and would block the queue forever
                if (col === 'lottery_records' && !(rec.session && String(rec.session).trim())) {
                    skippedBlankSession++;
                    continue;
                }
                // queueOp strips server metadata on push; fresh IDs assigned by server.
                await queueOp({ op: 'create', collection: col, localId: rec.id, data: rec });
                queued++;
            } catch (e) {
                errors.push(`${col}: queue failed (${e.message})`);
            }
        }
    }
    // Push everything now (queueOp's opportunistic pushes skip while _syncing).
    let pushed = 0, failed = 0, skipped = false, skipReason = '';
    try {
        const res = await pushPending();
        pushed = res.pushed || 0;
        failed = res.failed || 0;
        skipped = !!res.skipped;
        skipReason = res.reason || '';
    } catch (e) {
        errors.push(`push failed: ${e.message}`);
    }
    const lastErr = lastPushError();
    if (lastErr) errors.push(`last push error: ${lastErr}`);
    if (skipped && skipReason === 'not-logged-in') errors.push('❌ Login မဝင်ထားပါ — Link Code ပြန်ချိတ်ပါ');
    if (skippedBlankSession) errors.push(`⚠️ session မပါတဲ့ ${skippedBlankSession} ခု ကျော်လိုက်တယ်`);
    return { queued, pushed, failed, errors };
}

/**
 * Diagnostic: try pushing a single queue entry and return the raw result.
 * Does NOT remove the entry from the queue. Throws on error with code/message.
 */
export async function testPushOne(entry) {
    // Reuse the internal _pushOne via a direct pb call to surface the exact error.
    const { op, collection, data } = entry;
    if (op !== 'create') throw { code: 0, message: 'only create supported for test' };
    const payload = _toServerPayload(data);
    const created = await pb.create(collection, payload);
    return `created ${collection}/${created.id}`;
}
