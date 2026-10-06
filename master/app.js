/**
 * app.js — 2D Master Pro v2
 * Local-first: IndexedDB is the source of truth for the UI;
 * PocketBase syncs in the background.
 */
import * as db from '../shared/db.js';
import * as pb from '../shared/pb.js';
import * as sync from '../shared/sync.js';
import { parseBoard } from '../shared/parser.js';
import {
    formatMoney, formatDateStr, getWeekMondayStr, remainingDigits,
    uid, showToast, escHtml, extractDigits
} from '../shared/utils.js';

const MM_DAYS = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];

const state = {
    user: null,
    tenantId: null,     // local tenant id
    tenantPbId: null,   // PocketBase tenant id (used in relation fields)
    sessions: [],
    agents: [],
    activeSessionId: localStorage.getItem('v2_active_session') || null,
    boardSessionId: null,
    editingAgentId: null,
    syncTimer: null,
};

const $ = (id) => document.getElementById(id);

/* ================= BOOT ================= */

document.addEventListener('DOMContentLoaded', init);

async function init() {
    bindUI();
    pb.loadBaseUrl(); // custom server URL override (if Pho set one)
    pb.loadAuth();
    await db.openDB().catch((e) => console.error('IDB open failed', e));

    if (pb.isLoggedIn()) {
        try {
            state.user = await pb.refreshAuth();
            await enterApp();
            return;
        } catch (e) {
            console.warn('token refresh failed, need login', e.message);
            pb.logout();
        }
    }
    showPage('page-login');
}

function showPage(id) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    $(id).classList.add('active');
}

function bindUI() {
    $('loginBtn').addEventListener('click', doLogin);
    $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

    document.querySelectorAll('nav.tabs button').forEach((b) => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    $('fabSession').addEventListener('click', openSessionModal);
    $('nsSave').addEventListener('click', saveSession);

    $('boardPaste').addEventListener('click', async () => {
        try {
            const t = await navigator.clipboard.readText();
            if (t) { $('boardText').value = t; updateBoardPreview(); }
        } catch (e) { showToast('Paste မရပါ — ကိုယ်တိုင်ထည့်ပါ'); }
    });
    $('boardBack').addEventListener('click', () => closeModal('modal-board'));
    $('boardSave').addEventListener('click', saveBoard);
    $('boardText').addEventListener('input', updateBoardPreview);
    document.querySelectorAll('[data-close]').forEach((b) => {
        b.addEventListener('click', () => b.closest('.modal').classList.remove('open'));
    });

    $('winSave').addEventListener('click', saveWinning);
    $('addAgentBtn').addEventListener('click', () => openAgentModal(null));
    $('agSave').addEventListener('click', saveAgent);

    $('setLimit').addEventListener('change', () => setSetting('limit', Number($('setLimit').value) || 50000).then(renderLedger));
    $('setRate').addEventListener('change', () => setSetting('box_rate', Number($('setRate').value) || 2000).then(renderLedger));
    $('syncNowBtn').addEventListener('click', () => fullSync(true));
    $('logoutBtn').addEventListener('click', doLogout);
    $('serverUrlSave').addEventListener('click', () => {
        const v = $('serverUrlInput').value.trim();
        if (v && !/^https?:\/\//i.test(v)) { showToast('URL က https:// နဲ့ စရမယ်'); return; }
        if (v) pb.setBaseUrl(v); else pb.clearBaseUrl();
        showToast('✅ Server URL သိမ်းပြီးပြီ — reload လုပ်ပါ');
    });
    $('serverUrlReset').addEventListener('click', () => {
        pb.clearBaseUrl();
        $('serverUrlInput').value = '';
        $('serverUrlInput').placeholder = pb.getDefaultBaseUrl();
        showToast('✅ Default URL ပြန်သုံးမယ် — reload လုပ်ပါ');
    });
}

/* ================= AUTH ================= */

async function doLogin() {
    const email = $('loginEmail').value.trim();
    const pass = $('loginPass').value;
    $('loginError').textContent = '';
    if (!email || !pass) { $('loginError').textContent = 'Email နဲ့ Password ထည့်ပါ'; return; }
    $('loginBtn').disabled = true;
    try {
        state.user = await pb.login(email, pass);
        await enterApp();
    } catch (e) {
        $('loginError').textContent = e.code === 'NETWORK_ERROR'
            ? 'အင်တာနက် မရပါ — ချိတ်စစ်ပါ'
            : 'ဝင်မရပါ — Email/Password စစ်ပါ';
    } finally {
        $('loginBtn').disabled = false;
    }
}

async function doLogout() {
    if (!confirm('ထွက်မှာလား?')) return;
    await pb.logout();
    localStorage.removeItem('v2_active_session');
    location.reload();
}

async function enterApp() {
    showPage('page-main');
    // Load local data FIRST (offline-first) - don't block on network
    await loadSessions();
    await loadAgents();
    await loadSettingsIntoUI();
    renderSessions();
    renderAgents();
    if (state.activeSessionId) renderLedger();
    updateSyncPill('busy', '⏳ Sync…');
    // Background: ensure tenant and sync (non-blocking)
    (async () => {
        try {
            await ensureTenant();
            await fullSync();
            await loadSessions();
            await loadAgents();
            await loadSettingsIntoUI();
            renderSessions();
            renderAgents();
            if (state.activeSessionId) renderLedger();
        } catch (e) {
            console.warn('Background sync failed:', e.message);
        }
        updateSyncPill();
    })();
    // background sync every 45s + on reconnect
    clearInterval(state.syncTimer);
    state.syncTimer = setInterval(() => { if (pb.isLoggedIn()) fullSync(); }, 45000);
    window.addEventListener('online', () => fullSync());
}

/* ================= TENANT ================= */

async function ensureTenant() {
    // P1.1: Tenant ID comes from the user record's `tenant` relation field.
    // Do NOT list the tenants collection — it has no `tenant` field, so the
    // tenant-aware API rule can never match and the list always comes back empty.
    let tenantPbId = state.user && state.user.tenant;
    if (tenantPbId && typeof tenantPbId === 'object') tenantPbId = tenantPbId.id;

    if (!tenantPbId) {
        // User record may be stale — refresh auth to get the latest tenant link.
        try {
            state.user = await pb.refreshAuth();
            tenantPbId = state.user && state.user.tenant;
            if (tenantPbId && typeof tenantPbId === 'object') tenantPbId = tenantPbId.id;
        } catch (e) { console.warn('tenant refresh failed:', e.message); }
    }

    if (tenantPbId) {
        state.tenantId = tenantPbId;
        state.tenantPbId = tenantPbId;
        // Cache a local tenant row so offline queries by tenant keep working.
        try {
            const existing = await db.get('tenants', tenantPbId);
            if (!existing) {
                await db.put('tenants', {
                    id: tenantPbId,
                    name: (state.user && (state.user.name || state.user.email)) || 'My Shop',
                    _pbId: tenantPbId,
                    _updated: Date.now()
                });
            }
        } catch (e) { console.warn('tenant cache failed:', e.message); }
    } else {
        // Fallback for users with no tenant link (should not happen for Pho).
        console.warn('No tenant on user record — using local fallback');
        const all = await db.getAll('tenants').catch(() => []);
        let t = all[0];
        if (!t) {
            t = { id: uid(), name: 'My Shop' };
            await db.put('tenants', t);
        }
        state.tenantId = t.id;
        state.tenantPbId = t._pbId || t.id;
    }

    try {
        const userKey = 'v2_tenant:' + (state.user && state.user.id);
        localStorage.setItem(userKey, state.tenantId);
    } catch (e) { /* ignore */ }
    const lc = $('linkCode');
    if (lc) lc.textContent = state.tenantPbId;
    const lcHome = $('linkCodeHome');
    if (lcHome) lcHome.textContent = state.tenantPbId;
}

/* Copy the Agent link code to clipboard */
function copyLinkCode() {
    const code = state.tenantPbId || '';
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => alert('ကူးပြီးပါပြီ ✅')).catch(() => fallbackCopy(code));
    } else {
        fallbackCopy(code);
    }
}
function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); alert('ကူးပြီးပါပြီ ✅'); } catch (e) { alert('ကူးမရပါ: ' + text); }
    document.body.removeChild(ta);
}
window.copyLinkCode = copyLinkCode;

/* ================= SYNC ================= */

function serverPayload(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
        if (k === 'id' || k === '_pbId' || k === '_updated' || k === '_deleted') continue;
        out[k] = obj[k];
    }
    return out;
}

/** Create: direct-to-server when online (server id becomes local id), else queue. */
async function createRecord(collection, data) {
    const obj = Object.assign({ id: uid(), _updated: Date.now() }, data);
    obj.tenant = state.tenantPbId;
    await db.put(collection, obj);

    if (pb.isLoggedIn() && sync.isOnline()) {
        try {
            const created = await pb.create(collection, serverPayload(obj));
            const oldId = obj.id;
            obj.id = created.id;
            obj._pbId = created.id;
            obj._updated = Date.now();
            await db.del(collection, oldId);
            await db.put(collection, obj);
            if (collection === 'sessions') await remapSessionRefs(oldId, created.id);
            updateSyncPill();
            return obj;
        } catch (e) {
            if (e.code !== 'NETWORK_ERROR' && !(e.code >= 400 && e.code < 500)) throw e;
            // fall through → queue
        }
    }
    await sync.queueOp({ op: 'create', collection, localId: obj.id, data: obj });
    updateSyncPill();
    return obj;
}

async function updateRecord(collection, obj) {
    obj._updated = Date.now();
    await db.put(collection, obj);
    if (pb.isLoggedIn() && sync.isOnline() && obj._pbId) {
        try {
            await pb.update(collection, obj._pbId, serverPayload(obj));
            updateSyncPill();
            return obj;
        } catch (e) { /* fall through → queue */ }
    }
    await sync.queueOp({ op: obj._pbId ? 'update' : 'create', collection, localId: obj.id, data: obj });
    updateSyncPill();
    return obj;
}

async function deleteRecord(collection, obj) {
    await db.del(collection, obj.id);
    await sync.queueOp({ op: 'delete', collection, localId: obj.id, data: obj });
    updateSyncPill();
}

/** Point children at the new session id (after server created it). */
async function remapSessionRefs(oldId, newId) {
    if (oldId === newId) return;
    for (const coll of ['lottery_records', 'winning_numbers']) {
        const kids = await db.query(coll, 'by_session', oldId);
        for (const k of kids) {
            k.session = newId;
            k._updated = Date.now();
            await db.put(coll, k);
        }
    }
    if (state.activeSessionId === oldId) {
        state.activeSessionId = newId;
        localStorage.setItem('v2_active_session', newId);
    }
    if (state.boardSessionId === oldId) state.boardSessionId = newId;
}

/**
 * Before pushing, resolve queued child ops whose session has since
 * received a server id (offline-created sessions). Prevents 400 poison-drops.
 */
async function resolvePendingRelations() {
    if (!pb.isLoggedIn() || !sync.isOnline()) return false;
    let fixed = false;
    const queue = await db.getAll('sync_queue');
    for (const e of queue) {
        if (e.op !== 'create') continue;
        if (e.collection !== 'lottery_records' && e.collection !== 'winning_numbers') continue;
        const sessId = e.data && e.data.session;
        if (!sessId) continue;
        const s = await db.get('sessions', sessId);
        if (!s) continue;
        if (!s._pbId) {
            try {
                const created = await pb.create('sessions', serverPayload(s));
                const oldId = s.id;
                s._pbId = created.id; s._updated = Date.now();
                await db.put('sessions', s);
                await remapSessionRefs(oldId, created.id);
                // drop the session's own queued create (already on server)
                const q2 = await db.getAll('sync_queue');
                for (const se of q2) {
                    if (se.collection === 'sessions' && se.op === 'create' && se.localId === oldId) {
                        await db.del('sync_queue', se.id);
                    }
                }
                fixed = true;
            } catch (err) { continue; }
        }
        const sNow = await db.get('sessions', sessId === s.id ? s.id : sessId);
        const pbSid = (sNow && sNow._pbId) || (s._pbId);
        if (pbSid && e.data.session !== pbSid) {
            e.data.session = pbSid;
            await db.put('sync_queue', e);
            const local = await db.get(e.collection, e.localId);
            if (local && local.session !== pbSid) {
                local.session = pbSid;
                local._updated = Date.now();
                await db.put(e.collection, local);
            }
            fixed = true;
        }
    }
    return fixed;
}

let _fullSyncRunning = false;
async function fullSync(manual) {
    if (_fullSyncRunning || !pb.isLoggedIn()) return;
    _fullSyncRunning = true;
    updateSyncPill('busy', '⏳ Sync…');
    try {
        await resolvePendingRelations();
        await sync.syncNow();
        if (await resolvePendingRelations()) await sync.syncNow();
        // refresh in-memory lists after pull
        await loadSessions();
        await loadAgents();
        renderSessions();
        renderAgents();
        if (state.activeSessionId) renderLedger();
        if (manual) showToast('✅ Sync ပြီးပြီ');
    } catch (e) {
        console.warn('sync failed', e.message);
    } finally {
        _fullSyncRunning = false;
        updateSyncPill();
    }
}

async function updateSyncPill(force, text) {
    const pill = $('syncPill');
    if (force) { pill.className = force; pill.textContent = text; return; }
    const pending = await db.count('sync_queue').catch(() => 0);
    if (!sync.isOnline()) { pill.className = 'off'; pill.textContent = '🔴 Offline'; }
    else if (pending > 0) { pill.className = 'busy'; pill.textContent = `🟡 ${pending} ကျန်`; }
    else { pill.className = 'ok'; pill.textContent = '🟢 Synced'; }
}

/* ================= SETTINGS ================= */

async function getSetting(key, fallback) {
    const all = await db.getAll('app_settings');
    const matches = all.filter((r) => r.key === key);
    if (!matches.length) return fallback;
    matches.sort((a, b) => (b._updated || 0) - (a._updated || 0));
    const v = matches[0].value;
    return v === undefined ? fallback : v;
}

async function setSetting(key, value) {
    const all = await db.getAll('app_settings');
    const matches = all.filter((r) => r.key === key);
    matches.sort((a, b) => (b._updated || 0) - (a._updated || 0));
    let rec = matches[0];
    if (rec) { rec.value = String(value); await updateRecord('app_settings', rec); }
    else await createRecord('app_settings', { key, value: String(value) });
}

async function loadSettingsIntoUI() {
    $('setLimit').value = await getSetting('limit', 50000);
    $('setRate').value = await getSetting('box_rate', 2000);
    const urlInput = $('serverUrlInput');
    if (urlInput) {
        const cur = pb.getBaseUrl();
        const def = pb.getDefaultBaseUrl();
        urlInput.value = cur === def ? '' : cur;
        urlInput.placeholder = def;
    }
}

/* ================= TABS & MODALS ================= */

function switchTab(name) {
    document.querySelectorAll('nav.tabs button').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    $('tab-' + name).classList.add('active');
    if (name === 'ledger') renderLedger();
    if (name === 'agents') renderAgents();
}
window.switchTab = switchTab;

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function openGeneric(title, html) {
    $('genTitle').textContent = title;
    $('genBody').innerHTML = html;
    openModal('modal-generic');
}

/* ================= SESSIONS ================= */

async function loadSessions() {
    const all = await db.query('sessions', 'by_tenant', state.tenantPbId);
    const local = await db.getAll('sessions');
    const map = new Map();
    for (const s of all.concat(local)) {
        if (!map.has(s.id)) map.set(s.id, s);
    }
    state.sessions = Array.from(map.values())
        .sort((a, b) => (b._updated || 0) - (a._updated || 0));
}

function sessionLabel(s) {
    return s.name || s.date || 'ပွဲ';
}

async function renderSessions() {
    const box = $('sessionList');
    if (!state.sessions.length) {
        box.innerHTML = '<div class="empty">ပွဲ မရှိသေးပါ<br>“+” နှိပ်ပြီး အသစ်ဖန်တီးပါ</div>';
        return;
    }
    let html = '';
    for (const s of state.sessions) {
        const recs = await db.query('lottery_records', 'by_session', s.id);
        const total = recs.reduce((t, r) => t + (Number(r.amount) || 0), 0);
        html += `<div class="card session-card">
            <div class="sname">${escHtml(sessionLabel(s))}</div>
            <div class="smeta">${recs.length} မှတ်တမ်း · စုစုပေါင်း ${formatMoney(total)}</div>
            <div class="btn-grid">
                <button class="btn small" data-act="board" data-id="${s.id}">📝 ထိုးကွက်</button>
                <button class="btn small gray" data-act="ledger" data-id="${s.id}">📊 လယ်ဂျာ</button>
                <button class="btn small gray" data-act="win" data-id="${s.id}">🏆 ပေါက်သီး</button>
                <button class="btn small gray" data-act="daily" data-id="${s.id}">📑 Daily</button>
                <button class="btn small gray" data-act="copy" data-id="${s.id}">📋 Copy</button>
                <button class="btn small gray" data-act="remain" data-id="${s.id}">🔢 ကျန်ဂဏန်း</button>
                <button class="btn small red" data-act="del" data-id="${s.id}">🗑️</button>
            </div>
        </div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', () => sessionAction(b.dataset.act, b.dataset.id));
    });
}

async function sessionAction(act, id) {
    if (act === 'board') openBoard(id);
    else if (act === 'ledger') { setActiveSession(id); switchTab('ledger'); }
    else if (act === 'win') openWinning(id);
    else if (act === 'daily') openDaily(id);
    else if (act === 'copy') copyTotal(id);
    else if (act === 'remain') openRemaining();
    else if (act === 'del') deleteSession(id);
}

function setActiveSession(id) {
    state.activeSessionId = id;
    localStorage.setItem('v2_active_session', id);
}

function openSessionModal() {
    $('nsDate').value = formatDateStr(new Date()).split('.').reverse().join('-'); // yyyy-mm-dd
    openModal('modal-session');
}

async function saveSession() {
    const dv = $('nsDate').value; // yyyy-mm-dd
    const timeType = $('nsTime').value;
    if (!dv) { showToast('နေ့ ရွေးပါ'); return; }
    const [y, m, d] = dv.split('-');
    const dateStr = `${d}.${m}.${y}`;
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    const name = `${dateStr} ${MM_DAYS[dt.getDay()]} (${timeType})`;
    const s = await createRecord('sessions', {
        name, date: dateStr, timeType, is_open: true,
    });
    closeModal('modal-session');
    setActiveSession(s.id);
    await loadSessions();
    renderSessions();
    showToast('✅ ပွဲ ဖန်တီးပြီးပြီ');
}

async function deleteSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    if (!confirm(`"${sessionLabel(s)}" ကို ဖျက်မှာလား?\nမှတ်တမ်းအားလုံး ပျက်မယ်!`)) return;
    const recs = await db.query('lottery_records', 'by_session', id);
    for (const r of recs) await deleteRecord('lottery_records', r);
    const wins = await db.query('winning_numbers', 'by_session', id);
    for (const w of wins) await deleteRecord('winning_numbers', w);
    await deleteRecord('sessions', s);
    if (state.activeSessionId === id) {
        state.activeSessionId = null;
        localStorage.removeItem('v2_active_session');
    }
    await loadSessions();
    renderSessions();
    renderLedger();
    showToast('🗑️ ဖျက်ပြီးပြီ');
}

/* ================= DIGITAL BOARD ================= */

async function openBoard(sessionId) {
    state.boardSessionId = sessionId;
    const s = state.sessions.find((x) => x.id === sessionId);
    $('boardTitle').textContent = '📝 ထိုးကွက် — ' + (s ? sessionLabel(s) : '');
    const sel = $('boardTarget');
    let opts = '<option value="__DAIN__">🏠 ဒိုင် (အကန်)</option>';
    for (const a of state.agents) {
        opts += `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`;
    }
    sel.innerHTML = opts;
    $('boardText').value = '';
    updateBoardPreview();
    openModal('modal-board');
    setTimeout(() => $('boardText').focus(), 300);
}

function updateBoardPreview() {
    const text = $('boardText').value;
    if (!text.trim()) { $('boardPreview').textContent = 'စာရိုက်ပါ…'; return; }
    const items = parseBoard(text);
    const total = items.reduce((t, x) => t + (Number(x.amount) || 0), 0);
    $('boardPreview').innerHTML =
        `✅ <b>${items.length}</b> ကွက် ဝင်မယ် · စုစုပေါင်း <b>${formatMoney(total)}</b>`;
}

async function saveBoard() {
    const text = $('boardText').value;
    const items = parseBoard(text);
    if (!items.length) { showToast('ထည့်တာ မမှန်ပါ — စစ်ပါ'); return; }
    const target = $('boardTarget').value;
    const isDain = target === '__DAIN__';
    const agent = isDain ? null : state.agents.find((a) => a.id === target);
    const sessionId = state.boardSessionId;
    const batchNo = 'B' + Date.now().toString(36);

    $('boardSave').disabled = true;
    try {
        for (const it of items) {
            await createRecord('lottery_records', {
                session: sessionId,
                number: String(it.number).padStart(2, '0'),
                amount: Number(it.amount) || 0,
                agent_name: isDain ? '' : (agent ? agent.name : ''),
                record_type: isDain ? 'akan' : 'pos',
                batch_no: batchNo,
            });
        }
        showToast(`✅ ${items.length} ကွက် သိမ်းပြီးပြီ`);
        closeModal('modal-board');
        setActiveSession(sessionId);
        await loadSessions();
        renderSessions();
        renderLedger();
    } catch (e) {
        showToast('သိမ်းမရပါ: ' + e.message);
    } finally {
        $('boardSave').disabled = false;
    }
}

/* ================= LEDGER ================= */

async function renderLedger() {
    const head = $('ledgerHead');
    const grid = $('ledgerGrid');
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    if (!s) {
        head.innerHTML = '<div class="empty">ပွဲ ရွေးပါ — 📋 ပွဲများ tab ကနေ လယ်ဂျာ နှိပ်ပါ</div>';
        grid.innerHTML = '';
        $('ledgerTotal').textContent = '0';
        $('ledgerBoxes').textContent = '0';
        $('recordList').innerHTML = '';
        $('recCount').textContent = '';
        return;
    }
    const limit = Number(await getSetting('limit', 50000));
    const rate = Number(await getSetting('box_rate', 2000)) || 2000;
    const recs = await db.query('lottery_records', 'by_session', s.id);
    const wins = await db.query('winning_numbers', 'by_session', s.id);
    const winNums = new Set(wins.map((w) => String(w.number).padStart(2, '0')));

    // aggregate pos - akan
    const agg = {};
    for (const r of recs) {
        const n = String(r.number).padStart(2, '0');
        const amt = Number(r.amount) || 0;
        agg[n] = (agg[n] || 0) + (r.record_type === 'akan' ? -amt : amt);
    }
    let total = 0;
    let cells = '';
    for (let i = 0; i < 100; i++) {
        const n = String(i).padStart(2, '0');
        const a = agg[n] || 0;
        total += a;
        const cls = ['lcell'];
        if (a > limit) cls.push('over');
        if (winNums.has(n)) cls.push('win');
        cells += `<div class="${cls.join(' ')}"><span class="n">${n}</span><span class="a">${a ? formatMoney(a) : ''}</span></div>`;
    }
    head.innerHTML = `<div class="card"><div class="row"><b>${escHtml(sessionLabel(s))}</b>
        <button class="btn small" id="ledgerBoardBtn">📝 ထိုးကွက်</button></div></div>`;
    $('ledgerBoardBtn').addEventListener('click', () => openBoard(s.id));
    grid.innerHTML = cells;
    $('ledgerTotal').textContent = formatMoney(total);
    $('ledgerBoxes').textContent = formatMoney(Math.round(total / rate));

    // record list (newest first)
    $('recCount').textContent = recs.length + ' မှတ်တမ်း';
    const sorted = recs.slice().sort((a, b) => (b._updated || 0) - (a._updated || 0)).slice(0, 100);
    $('recordList').innerHTML = sorted.map((r) => `
        <div class="rec-row">
            <span class="num">${escHtml(String(r.number).padStart(2, '0'))}</span>
            <span class="who">${r.record_type === 'akan' ? '🏠 အကန်' : escHtml(r.agent_name || '')}</span>
            <span class="amt">${formatMoney(r.amount)}</span>
            <button class="icon-btn" data-delrec="${r.id}">🗑️</button>
        </div>`).join('') || '<div class="muted small">မှတ်တမ်း မရှိသေးပါ</div>';
    $('recordList').querySelectorAll('[data-delrec]').forEach((b) => {
        b.addEventListener('click', async () => {
            if (!confirm('ဒီမှတ်တမ်း ဖျက်မှာလား?')) return;
            const r = await db.get('lottery_records', b.dataset.delrec);
            if (r) await deleteRecord('lottery_records', r);
            renderLedger();
        });
    });
}

/* ================= WINNING NUMBERS ================= */

let _winSessionId = null;
function openWinning(sessionId) {
    _winSessionId = sessionId;
    const s = state.sessions.find((x) => x.id === sessionId);
    $('winTitle').textContent = '🏆 ပေါက်သီး — ' + (s ? sessionLabel(s) : '');
    $('winNumber').value = '';
    openModal('modal-winning');
}

async function saveWinning() {
    let num = $('winNumber').value.replace(/\D/g, '').slice(0, 2);
    if (num.length !== 2) { showToast('ဂဏန်း ၂ လုံး ထည့်ပါ'); return; }
    const sessionId = _winSessionId;
    const weekMonday = getWeekMondayStr(new Date());
    const existing = await db.query('winning_numbers', 'by_session', sessionId);
    if (existing.length) {
        existing[0].number = num;
        existing[0].week_monday = weekMonday;
        await updateRecord('winning_numbers', existing[0]);
    } else {
        await createRecord('winning_numbers', { session: sessionId, number: num, week_monday: weekMonday });
    }
    closeModal('modal-winning');
    showToast('🏆 ပေါက်သီး ' + num + ' သိမ်းပြီးပြီ');
    renderLedger();
}

/* ================= AGENTS ================= */

async function loadAgents() {
    const all = await db.query('agents', 'by_tenant', state.tenantPbId);
    const local = await db.getAll('agents');
    const map = new Map();
    for (const a of all.concat(local)) {
        if (!map.has(a.id)) map.set(a.id, a);
    }
    state.agents = Array.from(map.values()).sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || '')));
}

function renderAgents() {
    const box = $('agentList');
    if (!state.agents.length) {
        box.innerHTML = '<div class="empty">Agent မရှိသေးပါ</div>';
        return;
    }
    box.innerHTML = state.agents.map((a) => `
        <div class="agent-row">
            <div><div class="nm">${escHtml(a.name)}</div>
            <div class="ph">${escHtml(a.phone || '')} · ကော် ${a.commission || 0}% · အလျော် ${a.payout_rate || 80}</div></div>
            <div class="acts">
                <button class="btn small gray" data-edit="${a.id}">✏️</button>
                <button class="btn small red" data-delag="${a.id}">🗑️</button>
            </div>
        </div>`).join('');
    box.querySelectorAll('[data-edit]').forEach((b) =>
        b.addEventListener('click', () => openAgentModal(b.dataset.edit)));
    box.querySelectorAll('[data-delag]').forEach((b) =>
        b.addEventListener('click', () => deleteAgent(b.dataset.delag)));
}

function openAgentModal(id) {
    state.editingAgentId = id;
    const a = id ? state.agents.find((x) => x.id === id) : null;
    $('agentModalTitle').textContent = a ? 'Agent ပြင်မယ်' : 'Agent အသစ်';
    $('agName').value = a ? a.name : '';
    $('agPhone').value = a ? (a.phone || '') : '';
    $('agComm').value = a ? (a.commission || 0) : 0;
    $('agPayout').value = a ? (a.payout_rate || 80) : 80;
    openModal('modal-agent');
}

async function saveAgent() {
    const name = $('agName').value.trim();
    if (!name) { showToast('အမည် ထည့်ပါ'); return; }
    const data = {
        name,
        phone: $('agPhone').value.trim(),
        commission: Number($('agComm').value) || 0,
        payout_rate: Number($('agPayout').value) || 80,
    };
    if (state.editingAgentId) {
        const a = state.agents.find((x) => x.id === state.editingAgentId);
        Object.assign(a, data);
        await updateRecord('agents', a);
    } else {
        await createRecord('agents', data);
    }
    closeModal('modal-agent');
    await loadAgents();
    renderAgents();
    showToast('✅ သိမ်းပြီးပြီ');
}

async function deleteAgent(id) {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return;
    if (!confirm(`Agent "${a.name}" ဖျက်မှာလား?`)) return;
    await deleteRecord('agents', a);
    await loadAgents();
    renderAgents();
    showToast('🗑️ ဖျက်ပြီးပြီ');
}

/* ================= DAILY SUMMARY ================= */

async function openDaily(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    const wins = await db.query('winning_numbers', 'by_session', sessionId);
    const winNum = wins.length ? String(wins[0].number).padStart(2, '0') : null;

    // per-agent aggregation
    const per = {};
    for (const r of recs) {
        const key = r.record_type === 'akan' ? '🏠 အကန်' : (r.agent_name || '(အမည် မရှိ)');
        if (!per[key]) per[key] = { bet: 0, win: 0, type: r.record_type };
        const amt = Number(r.amount) || 0;
        per[key].bet += r.record_type === 'akan' ? -amt : amt;
        if (winNum && String(r.number).padStart(2, '0') === winNum && r.record_type !== 'akan') {
            const ag = state.agents.find((a) => a.name === r.agent_name);
            const payout = ag ? (Number(ag.payout_rate) || 80) : 80;
            per[key].win += amt * payout;
        }
    }
    let rows = '', tBet = 0, tWin = 0;
    for (const [name, v] of Object.entries(per)) {
        const ag = state.agents.find((a) => a.name === name);
        const comm = ag ? (Number(ag.commission) || 0) : 0;
        const commAmt = Math.round(v.bet * comm / 100);
        const net = v.bet - commAmt - v.win;
        tBet += v.bet; tWin += v.win;
        rows += `<tr><td>${escHtml(name)}</td><td>${formatMoney(v.bet)}</td><td>${formatMoney(v.win)}</td><td>${formatMoney(net)}</td></tr>`;
    }
    const html = `
        <div class="muted small" style="margin-bottom:8px">${escHtml(s ? sessionLabel(s) : '')}
        ${winNum ? ` · 🏆 ပေါက်သီး <b style="color:var(--green)">${winNum}</b>` : ' · ပေါက်သီး မထည့်ရသေး'}</div>
        <table class="data"><tr><th>ထိုးသား</th><th>ထိုးငွေ</th><th>ပေါက်</th><th>ကျန်</th></tr>
        ${rows || '<tr><td colspan="4" class="muted">မှတ်တမ်း မရှိ</td></tr>'}
        <tr class="total"><td>စုစုပေါင်း</td><td>${formatMoney(tBet)}</td><td>${formatMoney(tWin)}</td><td>${formatMoney(tBet - tWin)}</td></tr>
        </table>`;
    openGeneric('📑 Daily စာရင်းချုပ်', html);
}

/* ================= COPY TOTAL ================= */

async function copyTotal(sessionId) {
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    const agg = {};
    for (const r of recs) {
        const n = String(r.number).padStart(2, '0');
        const amt = Number(r.amount) || 0;
        agg[n] = (agg[n] || 0) + (r.record_type === 'akan' ? -amt : amt);
    }
    const lines = [];
    for (let i = 0; i < 100; i++) {
        const n = String(i).padStart(2, '0');
        if (agg[n]) lines.push(`${n} - ${formatMoney(agg[n])},`);
    }
    if (!lines.length) { showToast('ကူးစရာ မရှိပါ'); return; }
    const text = lines.join('\n');
    try {
        await navigator.clipboard.writeText(text);
        showToast(`📋 ${lines.length} ကွက် ကူးပြီးပြီ`);
    } catch (e) {
        openGeneric('📋 Copy Total', `<textarea class="field" style="width:100%;min-height:200px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px;font-family:monospace" readonly>${escHtml(text)}</textarea>`);
    }
}

/* ================= ကျန်ဂဏန်း (REMAINING DIGITS) ================= */

async function openRemaining() {
    const all = await db.query('winning_numbers', 'by_tenant', state.tenantPbId);
    const local = await db.getAll('winning_numbers');
    const map = new Map();
    for (const w of all.concat(local)) if (!map.has(w.id)) map.set(w.id, w);
    const wins = Array.from(map.values());

    // group by week_monday
    const byWeek = {};
    for (const w of wins) {
        const wk = w.week_monday || getWeekMondayStr(new Date());
        if (!byWeek[wk]) byWeek[wk] = [];
        byWeek[wk].push(w);
    }
    const weeks = Object.keys(byWeek).sort().reverse().slice(0, 10);
    if (!weeks.length) {
        openGeneric('🔢 ကျန်ဂဏန်း', '<div class="empty">ပေါက်သီး မှတ်တမ်း မရှိသေးပါ</div>');
        return;
    }
    let html = '';
    let prevRemaining = null;
    for (const wk of weeks) {
        const wlist = byWeek[wk].slice().sort((a, b) => String(a.number).localeCompare(String(b.number)));
        const nums = wlist.map((w) => String(w.number).padStart(2, '0'));
        const rem = remainingDigits(nums);
        html += `<div class="digit-week card"><div class="wtitle">📅 ${escHtml(wk)} အပတ်</div>`;
        if (prevRemaining && prevRemaining.length) {
            html += `<div class="dayline">အရင်အပတ်ကျန်: <b>${prevRemaining.join(' ')}</b></div>`;
        }
        html += `<div class="dayline">ပေါက်ဂဏန်း: <b>${nums.join(' · ')}</b></div>
            <div class="small muted" style="margin:6px 0">ကျန်ဂဏန်း (${rem.length})</div>
            <div class="digit-chips">${rem.map((d) => `<span class="dchip">${d}</span>`).join('')}</div></div>`;
        prevRemaining = rem;
    }
    openGeneric('🔢 ကျန်ဂဏန်း (၁၀ ပတ်)', html);
}
