/**
 * pb.js — PocketBase REST client wrapper for 2D Pro v2
 *
 * Uses fetch() directly against the PocketBase REST API (no SDK needed).
 * Auth token is persisted in localStorage under 'pb_auth'.
 *
 * Base URL is configurable; defaults to the Singapore VPS tunnel URL.
 * Use as ES6 module:  import * as pb from './pb.js'
 */

const DEFAULT_BASE_URL = 'https://2d.skylinkvpn.stream';
const AUTH_KEY = 'pb_auth'; // localStorage key: { token, model }
const URL_KEY = 'pb_server_url'; // localStorage key for custom server URL override

let _baseUrl = DEFAULT_BASE_URL;
let _auth = null; // { token, model }

/** Override the API base URL (e.g. when moving to production domain/IP). */
export function setBaseUrl(url) {
    _baseUrl = String(url).replace(/\/+$/, '');
    try {
        if (url) localStorage.setItem(URL_KEY, _baseUrl);
        else localStorage.removeItem(URL_KEY);
    } catch (e) { /* ignore */ }
}

export function getBaseUrl() {
    return _baseUrl;
}

/** Load a previously saved custom server URL (call at app startup, before loadAuth). */
export function loadBaseUrl() {
    try {
        const saved = localStorage.getItem(URL_KEY);
        if (saved && saved.trim()) _baseUrl = saved.trim().replace(/\/+$/, '');
    } catch (e) { /* ignore */ }
    return _baseUrl;
}

/** Clear the custom server URL override (revert to default). */
export function clearBaseUrl() {
    _baseUrl = DEFAULT_BASE_URL;
    try { localStorage.removeItem(URL_KEY); } catch (e) { /* ignore */ }
}

export function getDefaultBaseUrl() {
    return DEFAULT_BASE_URL;
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
    // Load from localStorage in case this module instance hasn't loaded yet
    // (app.js and sync.js may be different instances due to ?v= cache busting).
    if (!_auth) loadAuth();
    return !!(_auth && _auth.token);
}

/** Internal fetch helper: JSON in/out, auth header attached when logged in. */
async function _req(method, path, body) {
    // Ensure auth loaded (module instance may differ from app.js due to ?v=).
    if (!_auth) loadAuth();
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
    // PocketBase token auth has no server-side invalidation; clearing local
    // auth is what actually logs out. No server call needed.
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

/* ================= REALTIME (SSE) =================
 * PocketBase v0.23+ unified realtime: server pushes collection changes over
 * Server-Sent Events, so the app learns about new data in ~1-2s instead of
 * waiting for the next poll. The interval poll stays as fallback/revert path.
 *
 * Flow: GET /api/realtime (EventSource) → server sends PB_CONNECT with a
 * clientId → POST /api/realtime {clientId, subscriptions} (auth header, normal
 * fetch) → change events stream in. EventSource auto-reconnects on drops; each
 * re-PB_CONNECT re-registers the subscriptions.
 */
const _rt = {
    source: null,
    clientId: null,
    topics: [],
    onEvent: null,
    connecting: false,
};

function _rtReset() {
    try { if (_rt.source) _rt.source.close(); } catch (e) { /* ignore */ }
    _rt.source = null;
    _rt.clientId = null;
    _rt.connecting = false;
}

async function _rtRegister() {
    if (!_rt.clientId || !_rt.topics.length || !isLoggedIn()) return;
    try {
        await _req('POST', '/api/realtime', {
            clientId: _rt.clientId,
            subscriptions: _rt.topics.slice(),
        });
    } catch (e) {
        console.warn('[realtime] subscribe failed:', e.message);
    }
}

function _rtFireChanged() {
    if (typeof _rt.onEvent === 'function') {
        try { _rt.onEvent(); } catch (e) { /* app handler must not break the stream */ }
    }
}

function _rtConnect() {
    if (_rt.source || _rt.connecting || !isLoggedIn()) return;
    if (typeof EventSource === 'undefined') return;
    _rt.connecting = true;
    let es = null;
    try {
        es = new EventSource(getBaseUrl() + '/api/realtime');
    } catch (e) {
        _rt.connecting = false;
        return;
    }
    _rt.source = es;
    _rt.connecting = false;

    es.addEventListener('PB_CONNECT', (e) => {
        try {
            const data = JSON.parse(e.data || '{}');
            _rt.clientId = data.clientId || data.client_id || null;
        } catch (err) { _rt.clientId = null; }
        _rtRegister();
    });
    // Any pushed change event → tell the app to sync. Exact event names vary,
    // so listen both for default-type messages and per-topic named events.
    es.onmessage = () => _rtFireChanged();
    const named = (e) => _rtFireChanged();
    for (const t of _rt.topics) {
        try { es.addEventListener(t, named); } catch (err) { /* ignore */ }
    }
    es.onerror = () => {
        // EventSource retries by itself; a fresh PB_CONNECT re-registers topics.
        // If the stream is fully closed, drop it so a later call can start anew.
        try {
            if (es.readyState === EventSource.CLOSED) _rtReset();
        } catch (e) { _rtReset(); }
    };
}

/**
 * Subscribe to realtime collection changes. `onEvent` fires on every pushed
 * change (the app should just run its normal sync). Topics merge across calls.
 * If the stream can't connect, nothing breaks — the interval poll continues.
 */
export function realtimeSubscribe(topics, onEvent) {
    const list = Array.isArray(topics) ? topics : [topics];
    for (const t of list) {
        if (t && !_rt.topics.includes(t)) _rt.topics.push(t);
    }
    if (typeof onEvent === 'function') _rt.onEvent = onEvent;
    if (!_rt.source) _rtConnect();
    else if (_rt.clientId) _rtRegister();
}

/** True when the realtime stream is up (for diagnostics). */
export function realtimeConnected() {
    try {
        return !!(_rt.source && _rt.source.readyState === EventSource.OPEN && _rt.clientId);
    } catch (e) { return false; }
}

/** Stop the realtime stream (logout reloads the page anyway; this is for completeness). */
export function realtimeUnsubscribe() {
    _rt.topics = [];
    _rt.onEvent = null;
    _rtReset();
}
