/**
 * direct.js — server-direct data layer for the NEW online apps (master2/agent2).
 *
 * Pho Oct 27 (server-direct rebuild): the online app no longer goes through
 * an offline step. There is NO IndexedDB, NO sync queue, NO tombstones,
 * NO watermarks, NO daily full pass here. PocketBase IS the source of truth.
 *
 * Rules this module enforces:
 * - Tenant scoping: every list merges `tenant = "<tenantPbId>"` (server API
 *   rules enforce isolation too; the filter keeps payloads small).
 * - Idempotency: record ids are client-generated (uid(), exactly 15 chars,
 *   PocketBase-compatible). A create that fails as "already exists" means the
 *   original write already landed (lost response) — it is treated as success
 *   by fetching the existing record, never as a duplicate.
 * - System fields are stripped on write (id is KEPT on create as the
 *   idempotency key, stripped on update).
 *
 * Use as ES6 module:  import * as direct from './direct.js'
 */

import * as pb from './pb.js?v=4';

function stripSystem(obj, keepId) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
        if (k === '_pbId' || k === '_updated' || k === '_deleted') continue;
        if (k === 'created' || k === 'updated') continue;
        if (k === 'id' && !keepId) continue;
        out[k] = obj[k];
    }
    return out;
}

function isDuplicateError(e) {
    if (!e) return false;
    if (e.code === 400) return true;
    return /already exists|unique|duplicate/i.test(e.message || '');
}

function isNetworkError(e) {
    if (!e) return false;
    // pb.js _req shapes: fetch failures become Error with code 'TIMEOUT' /
    // 'NETWORK_ERROR'; HTTP failures carry numeric res.status in .code.
    if (e instanceof TypeError) return true;
    if (e.code === 'TIMEOUT' || e.code === 'NETWORK_ERROR' || e.code === 0) return true;
    if (typeof e.code === 'number' && e.code >= 500 && e.code < 600) return true;
    return /network|failed to fetch|timed?\s?out/i.test(e.message || '');
}

/** Tenant filter fragment for PocketBase queries. */
export function tenantFilter(tenantPbId) {
    return tenantPbId ? `tenant = "${tenantPbId}"` : '';
}

/** List ALL records in a collection for this tenant (auto-paginates). */
export async function directList(collection, tenantPbId, opts = {}) {
    const parts = [opts.filter, tenantFilter(tenantPbId)].filter(Boolean);
    const filter = parts.length ? parts.join(' && ') : undefined;
    return pb.listAll(collection, { sort: opts.sort, filter });
}

/** Get one record by id (throws on 404 — callers decide). */
export function directGet(collection, id) {
    return pb.getOne(collection, id);
}

/**
 * Create a record with a client-generated id. If the id already exists
 * (lost response — the original write landed), fetch and return it instead
 * of creating a duplicate.
 */
export async function directCreate(collection, obj) {
    const data = stripSystem(obj, true);
    try {
        return await pb.create(collection, data);
    } catch (e) {
        if (isDuplicateError(e) && obj.id) {
            try { return await pb.getOne(collection, obj.id); } catch (_) { /* fall through */ }
        }
        throw e;
    }
}

/**
 * Save (create-or-update) by id. Update-first: an existing row updates in
 * place; a missing row (404) creates. This is the idempotent write:
 * retrying the same object never duplicates.
 * NOTE (Pho Oct 27 sessions port): the previous version called directCreate
 * first, but directCreate swallows duplicate-id errors by fetching the
 * existing row — so updates silently never landed. Update-first fixes that
 * while keeping directCreate's lost-response behavior for the create path.
 */
export async function directSave(collection, obj) {
    if (!obj || !obj.id) throw new Error('directSave needs obj.id');
    try {
        return await pb.update(collection, obj.id, stripSystem(obj, false));
    } catch (e) {
        if (e && (e.code === 404 || /not found/i.test(e.message || ''))) {
            return directCreate(collection, obj);
        }
        throw e;
    }
}

/** Delete by id. A 404 (already gone) counts as success. */
export async function directDelete(collection, id) {
    try {
        return await pb.del(collection, id);
    } catch (e) {
        if (e && (e.code === 404 || /not found/i.test(e.message || ''))) return null;
        throw e;
    }
}

/** Realtime: server pushes collection changes; onEvent fires per event. */
export function directSubscribe(topics, onEvent) {
    return pb.realtimeSubscribe(topics, onEvent);
}

export function directConnected() {
    return pb.realtimeConnected();
}

export function directUnsubscribe() {
    return pb.realtimeUnsubscribe();
}

/**
 * Retry a server call on network errors only (line blips). Validation
 * errors (400) and auth errors (401/403) are NOT retried — they need the
 * user, not another attempt. Default: 3 attempts, ~1s apart.
 */
export async function withRetry(fn, attempts = 3, delayMs = 1000) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (!isNetworkError(e) || i === attempts - 1) throw e;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}
