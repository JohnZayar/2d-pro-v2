/**
 * Simplified Sync v1 (Pho Oct 19) + v10 incremental pull (Oct 21, clone test build)
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

        // Pho Oct 21: PRE-FLIGHT — a create whose response was lost last
        // time is ALREADY on the server. Ask once per chunk which queued
        // create IDs exist, and adopt those WITHOUT re-sending. (A blind
        // re-send costs a 400 + a verify round-trip each; bursts of them
        // made sync crawl.) Skipping a send can never duplicate a record —
        // it is already there exactly once, under the same ID.
        const adopted = new Set();
        try {
            const byColl = {};
            for (const e of queue) {
                if (e.op === 'create' && e.localId) (byColl[e.collection] = byColl[e.collection] || []).push(e);
            }
            for (const coll of Object.keys(byColl)) {
                const ops = byColl[coll];
                for (let i = 0; i < ops.length; i += 20) {
                    const chunk = ops.slice(i, i + 20);
                    const filter = chunk.map((e) => `id="${e.localId}"`).join(' || ');
                    const res = await pb.list(coll, { filter, perPage: 50 });
                    const items = res && res.items ? res.items : (Array.isArray(res) ? res : []);
                    const found = new Set(items.map((r) => r.id));
                    for (const e of chunk) {
                        if (found.has(e.localId)) {
                            adopted.add(e.id);
                            await db.del('sync_queue', e.id).catch(() => {});
                            pushed++;
                        }
                    }
                }
            }
        } catch (e) { /* pre-flight failed (offline): per-op path below still protects via 400-adopt */ }

        for (const entry of queue) {
            if (adopted.has(entry.id)) continue;
            try {
                await _pushOne(entry);
                await db.del('sync_queue', entry.id).catch(() => {});
                pushed++;
            } catch (err) {
                // Keep in queue for retry. Never auto-drop (Pho: records must not be lost).
                // Stamp the attempt count (re-read fresh — the session gate may
                // have rewritten this entry). A RETRIED create is verified with
                // getOne BEFORE any re-send, so it never fires a blind 400.
                try {
                    const fresh = await db.get('sync_queue', entry.id);
                    if (fresh) { fresh.attempts = (fresh.attempts || 0) + 1; await db.put('sync_queue', fresh); }
                } catch (e) { /* ignore */ }
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
    // Re-read the queue entry: an adoption earlier in this same run may have
    // re-pointed it (session refs / localId) — never push stale data.
    try {
        const fresh = await db.get('sync_queue', entry.id);
        if (fresh) entry = fresh;
    } catch (e) {}
    const { op, collection, localId, data } = entry;

    // Pho Oct 21: ONE GATE for session creates — (tenant, date, timeType) is
    // unique, like a winning number: enter once, never twice. If the server
    // already has that day-part under a different ID, adopt it instead of
    // minting a twin. (Sync lag / lost responses made twins before.)
    if (op === 'create' && collection === 'sessions' && data && data.tenant && data.date && data.timeType) {
        try {
            const res = await pb.list('sessions', {
                filter: `tenant="${data.tenant}" && date="${data.date}" && timeType="${data.timeType}"`,
                perPage: 5
            });
            const items = res && res.items ? res.items : (Array.isArray(res) ? res : []);
            if (items.length) {
                if (items[0].id === localId) return; // already ours on the server
                await _adoptSession(localId, items[0]);
                return; // adopted — never create a second one
            }
        } catch (e) {
            // Pho Oct 21: NO PROOF, NO CREATE. If the gate cannot verify,
            // stay queued and retry — never fall through to a blind create.
            // (A 5 KB/s timeout here minted a twin while the original
            // session had already been on the server for 5 minutes.)
            throw e;
        }
    }

    // Pho Oct 21: a RETRIED create (attempts > 0) may already be on the
    // server — its first response was lost. Verify with getOne BEFORE
    // re-sending: if it's there, adopt silently (no blind POST, no 400).
    // If the verify itself fails on the network, stay queued — no proof,
    // no create. (Sessions are exempt: the gate above already proves them.)
    if (op === 'create' && collection !== 'sessions' && entry.attempts > 0 && localId) {
        try {
            const ex = await pb.getOne(collection, localId);
            if (ex && ex.id) return; // already there — adopt
        } catch (e) {
            if (!(e && (e.code === 404 || e.status === 404))) throw e;
            // 404 = truly not there — fall through and create.
        }
    }

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
            // Lost response? The create may have landed before the reply
            // died. Verify once, right now — if it is there, adopt it
            // instead of queueing a blind re-send for the next sync.
            if (op === 'create' && localId && err && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT')) {
                try {
                    const ex = await pb.getOne(collection, localId);
                    if (ex && ex.id) return; // landed — adopt
                } catch (e2) { /* verify failed too — stay queued */ }
            }
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

/** Re-key a local session to the server's existing session for the same
 *  day-part: the local session row, its records, winning numbers and any
 *  queued ops all move to the adopted ID, so nothing keeps pointing at the
 *  abandoned local ID. */
async function _adoptSession(localId, srv) {
    const sid = srv.id;
    try { await db.del('sessions', localId); } catch (e) {}
    await db.put('sessions', _fromServer(srv));
    for (const coll of ['lottery_records', 'winning_numbers']) {
        try {
            const all = await db.getAll(coll);
            for (const k of all) {
                if (k.session === localId) { k.session = sid; k._updated = Date.now(); await db.put(coll, k); }
            }
        } catch (e) {}
    }
    try {
        const q = await db.getAll('sync_queue');
        for (const qop of q) {
            let changed = false;
            if (qop.data && qop.data.session === localId) { qop.data.session = sid; changed = true; }
            if (qop.collection === 'sessions' && qop.localId === localId) {
                qop.localId = sid;
                if (qop.data) qop.data.id = sid;
                changed = true;
            }
            if (changed) await db.put('sync_queue', qop);
        }
    } catch (e) {}
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('v2_active_session') === localId) {
            localStorage.setItem('v2_active_session', sid);
        }
    } catch (e) {}
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
/* ================================================================
 * Pull — incremental with daily full reconciliation (Sync v10,
 * Pho Oct 21, option A; built in the CLONE for testing first).
 *
 * - First pull ever (no watermark) and the FIRST pull of each day
 *   run FULL: download everything, delete local orphans (with the
 *   v9 protections: queue re-read at deletion time + 5-min grace).
 *   That daily pass is how deletions propagate — a deleted row is
 *   simply absent on the server, which only a full comparison sees.
 * - Every other pull is INCREMENTAL: per collection, fetch only
 *   rows whose server `updated` is >= (watermark - 5 min overlap).
 *   The watermark is the newest server `updated` applied for that
 *   collection; it advances ONLY after that collection's fetch
 *   completes, so an interrupted pull loses nothing — the next
 *   pull re-fetches the same window (upserts are idempotent).
 * - Watermark values come from the SERVER's own `updated` fields,
 *   never the phone clock, so a wrong phone clock can't skip rows.
 * - Watermarks are keyed by user id: a different account logging in
 *   on the same phone starts from a full pull, never a stale mark.
 * ================================================================ */
function _wmScope() {
    let uid = 'anon';
    try { const u = pb.getUser(); if (u && u.id) uid = u.id; } catch (e) {}
    return 'syncv10_' + uid + '_';
}
function _todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _pbDateTime(ms) { return new Date(ms).toISOString().replace('T', ' '); }

export async function pullUpdates() {
    if (_syncing) return { pulled: 0, skipped: true };
    try { pb.loadAuth(); } catch (e) {}
    if (!pb.isLoggedIn()) return { pulled: 0, skipped: true, reason: 'not-logged-in' };

    _syncing = true;
    let pulled = 0;
    const errors = [];
    try {
        const collections = ['sessions', 'lottery_records', 'winning_numbers', 'agents', 'app_settings'];
        const scope = _wmScope();
        let fullDay = '';
        try { fullDay = localStorage.getItem(scope + 'full_day') || ''; } catch (e) {}
        const needFullDay = fullDay !== _todayStr();
        let fullDayOk = true;
        for (const coll of collections) {
            let wmMs = 0;
            try { wmMs = Date.parse(localStorage.getItem(scope + 'wm_' + coll) || '') || 0; } catch (e) {}
            const full = needFullDay || !wmMs;
            try {
                if (full) {
                    const items = await pb.listAll(coll, { sort: '-updated' });
                    const serverIds = new Set(items.map(i => i.id));
                    let maxMs = wmMs;
                    for (const item of items) {
                        const rec = _fromServer(item);
                        await db.put(coll, rec);
                        pulled++;
                        const t = Date.parse(item.updated);
                        if (!isNaN(t) && t > maxMs) maxMs = t;
                    }
                    // Delete local orphans not on server (cleans duplicates).
                    // Pho Oct 21: re-read the queue NOW, at deletion time — not at
                    // pull start. A record saved DURING this (long, slow-network)
                    // pull has a queue entry by the time we get here, and must
                    // NEVER be wiped as an "orphan": on Oct 21 a board save
                    // mid-pull vanished from the Agent's own phone even though it
                    // reached the server, and only reappeared on a later pull.
                    // Second lock: never wipe a just-created local record
                    // (5-minute grace) even if its queue entry is not visible yet.
                    try {
                        const qNow = await db.getAll('sync_queue');
                        const pendingNow = new Set(qNow.map(e => e.localId).filter(Boolean));
                        const locals = await db.getAll(coll);
                        for (const local of locals) {
                            const fresh = local.created && (Date.now() - local.created) < 5 * 60 * 1000;
                            if (!serverIds.has(local.id) && !pendingNow.has(local.id) && !fresh) {
                                await db.del(coll, local.id).catch(() => {});
                            }
                        }
                    } catch (e) { /* ignore */ }
                    if (maxMs > wmMs) { try { localStorage.setItem(scope + 'wm_' + coll, new Date(maxMs).toISOString()); } catch (e) {} }
                } else {
                    // Incremental: only rows changed since the watermark
                    // (5-minute overlap window; re-applied rows are harmless
                    // upserts). NO orphan deletion in this mode — deletions
                    // are reconciled by the daily full pass.
                    const since = _pbDateTime(wmMs - 5 * 60 * 1000);
                    const items = await pb.listAll(coll, { filter: `updated >= "${since}"`, sort: 'updated' });
                    let maxMs = wmMs;
                    for (const item of items) {
                        const rec = _fromServer(item);
                        await db.put(coll, rec);
                        pulled++;
                        const t = Date.parse(item.updated);
                        if (!isNaN(t) && t > maxMs) maxMs = t;
                    }
                    // Advance the watermark ONLY after the whole fetch landed.
                    if (maxMs > wmMs) { try { localStorage.setItem(scope + 'wm_' + coll, new Date(maxMs).toISOString()); } catch (e) {} }
                }
            } catch (err) {
                errors.push(coll + ': ' + err.message);
                if (full) fullDayOk = false;
            }
        }
        if (needFullDay && fullDayOk) { try { localStorage.setItem(scope + 'full_day', _todayStr()); } catch (e) {} }
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
