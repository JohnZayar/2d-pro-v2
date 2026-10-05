/**
 * pb.js — PocketBase REST client wrapper for 2D Pro v2
 *
 * Uses fetch() directly against the PocketBase REST API (no SDK needed).
 * Auth token is persisted in localStorage under 'pb_auth'.
 *
 * Base URL is configurable; defaults to the Singapore VPS tunnel URL.
 * Use as ES6 module:  import * as pb from './pb.js'
 */

const DEFAULT_BASE_URL = 'https://sought-slides-douglas-wagner.trycloudflare.com';
const AUTH_KEY = 'pb_auth'; // localStorage key: { token, model }

let _baseUrl = DEFAULT_BASE_URL;
let _auth = null; // { token, model }

/** Override the API base URL (e.g. when moving to production domain/IP). */
export function setBaseUrl(url) {
    _baseUrl = String(url).replace(/\/+$/, '');
}

export function getBaseUrl() {
    return _baseUrl;
}

/** Load persisted auth from localStorage (call once at app startup). */
export function loadAuth() {
    try {
        const raw = localStorage.getItem(AUTH_KEY);
        _auth = raw ? JSON.parse(raw) : null;
    } catch (e) {
        _auth = null;
    }
    return _auth;
}

function _saveAuth(auth) {
    _auth = auth;
    try {
        if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
        else localStorage.removeItem(AUTH_KEY);
    } catch (e) { /* storage unavailable */ }
}

export function getToken() {
    return _auth ? _auth.token : null;
}

export function getUser() {
    return _auth ? _auth.model : null;
}

export function isLoggedIn() {
    return !!(_auth && _auth.token);
}

/** Internal fetch helper: JSON in/out, auth header attached when logged in. */
async function _req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_auth && _auth.token) headers['Authorization'] = _auth.token;

    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    // Add 15s timeout so slow/hanging networks don't block the app
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    opts.signal = controller.signal;

    let res;
    try {
        res = await fetch(_baseUrl + path, opts);
    } catch (e) {
        // Network unreachable (offline, blocked, tunnel down) or timeout
        const err = new Error(e.name === 'AbortError' ? 'Request timed out' : 'Network unreachable: ' + e.message);
        err.code = e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }

    if (!res.ok) {
        const err = new Error((data && data.message) || ('Request failed: ' + res.status));
        err.code = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

/**
 * Log in with email + password against the `users` auth collection.
 * Persists token + user model in localStorage.
 */
export async function login(email, password) {
    const data = await _req('POST', '/api/collections/users/auth-with-password', {
        identity: email,
        password: password
    });
    _saveAuth({ token: data.token, model: data.record });
    return data.record;
}

/** Log out: clear local auth state (also tries server-side invalidation). */
export async function logout() {
    // Best-effort server logout; ignore failures (e.g. offline).
    try { await _req('POST', '/api/collections/users/auth-refresh'); } catch (e) { /* ignore */ }
    _saveAuth(null);
}

/** Refresh the auth token (keeps session alive). Returns user record. */
export async function refreshAuth() {
    const data = await _req('POST', '/api/collections/users/auth-refresh');
    _saveAuth({ token: data.token, model: data.record });
    return data.record;
}

/**
 * Create a record in a collection.
 * @param {string} collection
 * @param {object} data
 */
export function create(collection, data) {
    return _req('POST', `/api/collections/${encodeURIComponent(collection)}/records`, data);
}

/**
 * Update a record (PATCH).
 */
export function update(collection, id, data) {
    return _req('PATCH', `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`, data);
}

/**
 * Delete a record.
 */
export function del(collection, id) {
    return _req('DELETE', `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`);
}

/**
 * Get a single record by id.
 */
export function getOne(collection, id) {
    return _req('GET', `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`);
}

/**
 * List records with optional PocketBase filter/sort/pagination.
 * @param {string} collection
 * @param {object} opts { filter, sort, page, perPage, expand }
 */
export function list(collection, opts = {}) {
    const params = new URLSearchParams();
    if (opts.filter) params.set('filter', opts.filter);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.page) params.set('page', String(opts.page));
    if (opts.perPage) params.set('perPage', String(opts.perPage));
    if (opts.expand) params.set('expand', opts.expand);
    const qs = params.toString();
    return _req('GET', `/api/collections/${encodeURIComponent(collection)}/records${qs ? '?' + qs : ''}`);
}

/**
 * Fetch ALL records in a collection (auto-paginates).
 * @param {string} collection
 * @param {object} opts { filter, sort }
 */
export async function listAll(collection, opts = {}) {
    const perPage = 200;
    let page = 1;
    let items = [];
    for (;;) {
        const res = await list(collection, Object.assign({}, opts, { page, perPage }));
        items = items.concat(res.items || []);
        if (page >= (res.totalPages || 1)) break;
        page++;
    }
    return items;
}

export { del as remove };
