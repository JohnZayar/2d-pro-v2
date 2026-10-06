/**
 * app.js — 2D Master Pro v2
 * Local-first: IndexedDB is the source of truth for the UI;
 * PocketBase syncs in the background.
 */
import * as db from '../shared/db.js';
import * as pb from '../shared/pb.js';
import * as sync from '../shared/sync.js';
import { parseBoard, parseBoardReport } from '../shared/parser.js';
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
    voucherSessionId: null,
    weeklyOffset: 0,
    overSessionId: null,
    lastVoucherText: '',
    lastOverText: '',
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

    $('fabSession').addEventListener('click', openSessionModal);
    $('nsSave').addEventListener('click', saveSession);

    $('boardPaste').addEventListener('click', async () => {
        try {
            const t = await navigator.clipboard.readText();
            if (t) { $('boardText').value = t; }
        } catch (e) { showToast('Paste မရပါ — ကိုယ်တိုင်ထည့်ပါ'); }
    });
    $('boardBack').addEventListener('click', () => closeModal('modal-board'));
    $('boardSave').addEventListener('click', saveBoard);
    document.querySelectorAll('[data-close]').forEach((b) => {
        b.addEventListener('click', () => b.closest('.modal').classList.remove('open'));
    });

    $('winSave').addEventListener('click', saveWinning);
    $('limitSave').addEventListener('click', saveLimit);
    $('addAgentBtn').addEventListener('click', () => openAgentModal(null));
    $('agSave').addEventListener('click', saveAgent);

    $('syncNowBtn').addEventListener('click', () => fullSync(true));
    $('logoutBtn').addEventListener('click', doLogout);

    // vouchers / overlimit / akandain
    $('voucherSession').addEventListener('change', () => { state.voucherSessionId = $('voucherSession').value; renderVouchers(); });
    $('voucherPerson').addEventListener('change', renderVoucherContent);
    $('voucherCopyBtn').addEventListener('click', copyVoucher);
    $('voucherPrintBtn').addEventListener('click', printVoucher);
    $('voucherShareBtn').addEventListener('click', shareVoucher);
    $('wkPrev').addEventListener('click', () => { state.weeklyOffset = (state.weeklyOffset || 0) - 1; renderWeekly(); });
    $('wkNext').addEventListener('click', () => { state.weeklyOffset = (state.weeklyOffset || 0) + 1; renderWeekly(); });
    $('overSession').addEventListener('change', () => { state.overSessionId = $('overSession').value; renderOverlimit(); });
    $('overCopyBtn').addEventListener('click', copyOverlimit);
    $('overToAkanBtn').addEventListener('click', sendOverToAkan);
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
    const lcDrawer = $('linkCodeDrawer');
    if (lcDrawer) lcDrawer.textContent = state.tenantPbId;
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
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    $('tab-' + name).classList.add('active');
    // The entry/akandain keypads are fixed overlays — hide them whenever leaving their tab.
    const ekp = $('entryKeypad');
    if (ekp && name !== 'entry' && !ekp.hidden) { ekp.hidden = true; $('entryKbToggle')?.classList.remove('active'); }
    const akp = $('akanKeypad');
    if (akp && name !== 'akandain' && !akp.hidden) { akp.hidden = true; $('akanKbToggle')?.classList.remove('active'); }
    if (name === 'ledger') renderLedger();
    if (name === 'entry') renderEntry();
    if (name === 'agents') renderAgents();
    if (name === 'vouchers') renderVouchers();
    if (name === 'akan') renderOverlimit();
    if (name === 'akandain') renderAkandain();
    if (name === 'winning') renderWinningHome();
    if (name === 'weekly') renderWeekly();
}
window.switchTab = switchTab;

/* ================= SIDE DRAWER (v1 style) ================= */

function toggleDrawer() {
    $('sidebar').classList.toggle('open');
    $('drawerBackdrop').classList.toggle('show');
}
function closeDrawer() {
    $('sidebar').classList.remove('open');
    $('drawerBackdrop').classList.remove('show');
}
function goDrawer(name) {
    closeDrawer();
    switchTab(name);
}
window.toggleDrawer = toggleDrawer;
window.closeDrawer = closeDrawer;
window.goDrawer = goDrawer;
window.doLogout = doLogout;

function openModal(id) {
    // The formula keypads are fixed overlays (z-index 900) that would cover the
    // modal sheet — hide them whenever any modal opens (e.g. 🏆 ပေါက်သီး).
    const ekp = $('entryKeypad');
    if (ekp && !ekp.hidden) { ekp.hidden = true; $('entryKbToggle')?.classList.remove('active'); }
    const akp = $('akanKeypad');
    if (akp && !akp.hidden) { akp.hidden = true; $('akanKbToggle')?.classList.remove('active'); }
    $(id).classList.add('open');
}
function closeModal(id) { $(id).classList.remove('open'); }

function openGeneric(title, html) {
    $('genTitle').textContent = title;
    $('genBody').innerHTML = html;
    openModal('modal-generic');
}

/* ================= LIMIT DIALOG (per-session) ================= */

function sessionLimit(s) {
    return Number(s && s.limit) || 50000;
}

async function openLimitDialog() {
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    $('limitInput').value = sessionLimit(s);
    openModal('modal-limit');
}
window.openLimitDialog = openLimitDialog;

async function saveLimit() {
    const v = Number($('limitInput').value) || 50000;
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    if (s) {
        s.limit = v;
        s._updated = Date.now();
        await updateRecord('sessions', s);
        await loadSessions();
    }
    closeModal('modal-limit');
    showToast('🚫 Limit ' + formatMoney(v) + ' သိမ်းပြီးပြီ');
    renderLedger();
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
                <button class="btn small gray" data-act="vouchers" data-id="${s.id}">🧾 ဘောက်ချာများ</button>
                <button class="btn small gray" data-act="overlimit" data-id="${s.id}">🔴 အကျွံ</button>
                <button class="btn small gray" data-act="akandain" data-id="${s.id}">🔄 အကန်ဒိုင်</button>
                <button class="btn small gray" data-act="bigsmall" data-id="${s.id}">⚖️ ကြီးငယ်</button>
                <button class="btn small gray" data-act="blocked" data-id="${s.id}">🚫 ဒိုင်ပိတ်</button>
                <button class="btn small gray" data-act="alltotal" data-id="${s.id}">💰 ALL Total</button>
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
    if (act === 'board') openEntry(id);
    else if (act === 'ledger') { setActiveSession(id); switchTab('ledger'); }
    else if (act === 'win') openWinning(id);
    else if (act === 'daily') openDaily(id);
    else if (act === 'copy') copyTotal(id);
    else if (act === 'remain') openRemaining();
    else if (act === 'vouchers') { setActiveSession(id); switchTab('vouchers'); }
    else if (act === 'overlimit') { setActiveSession(id); switchTab('akan'); }
    else if (act === 'akandain') { setActiveSession(id); switchTab('akandain'); }
    else if (act === 'bigsmall') { setActiveSession(id); openBigSmall(id); }
    else if (act === 'blocked') { setActiveSession(id); openBlocked(id); }
    else if (act === 'alltotal') { setActiveSession(id); openAllTotal(id); }
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
        name, date: dateStr, timeType, is_open: true, limit: 50000,
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
    $('boardTargetWrap').style.display = '';
    // Target: registered ထိုးသား + Agent (no akan mixing; entry board is incoming-only)
    const sel = $('boardTarget');
    let opts = '';
    for (const a of state.agents) {
        if ((a.person_type || 'agent') === 'akan') continue;
        opts += `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`;
    }
    sel.innerHTML = opts;
    $('boardText').value = '';
    openModal('modal-board');
    setTimeout(() => $('boardText').focus(), 300);
}

async function saveBoard() {
    const text = $('boardText').value;
    const { items, invalidLines } = parseBoardReport(text);
    // Guard: only real 2-digit numbers
    const validItems = items.filter((it) => /^\d{2}$/.test(String(it.number)));
    if (!validItems.length) { showToast('ထည့်တာ မမှန်ပါ — စစ်ပါ'); return; }
    const sessionId = state.boardSessionId;
    const skipped = invalidLines.length + (items.length - validItems.length);

    // အကန်ဒိုင် mode → rows land in the OUTGOING pending table, not the entry table.
    if (state.boardMode === 'akan') {
        const bookie = (($('akanBookieSelect') && $('akanBookieSelect').value) || '').trim() || null;
        validItems.forEach((it) => {
            akanPending.push({
                player_name: bookie,
                number: String(it.number).padStart(2, '0'),
                amount: Number(it.amount) || 0,
                record_type: 'akan',
            });
        });
        showToast('✅ ' + validItems.length + ' ကွက် ထည့်ပြီးပြီ (အထွက်)' +
            (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : ''));
        closeModal('modal-board');
        await openAkandain(sessionId);
        return;
    }

    const target = $('boardTarget').value;
    const agent = state.agents.find((a) => a.id === target);
    const personName = agent ? agent.name : '';

    validItems.forEach((it) => {
        entryPending.push({
            player_name: personName || null,
            number: String(it.number).padStart(2, '0'),
            amount: Number(it.amount) || 0,
            record_type: 'pos', // entry board is incoming-only
        });
    });
    showToast('✅ ' + validItems.length + ' ကွက် ထည့်ပြီးပြီ' +
        (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : ''));
    closeModal('modal-board');
    await openEntry(sessionId);
}

/* ================= ENTRY SCREEN (ထိုးကွက် — Agent-style) ================= */

let entryPending = [];      // typed but NOT yet saved: [{player_name, number, amount, record_type}]
let entryActiveBox = 'no';  // 'no' | 'amt' | 'rev'
let entrySaveInFlight = false;

const ENTRY_FORMULA_INSERT = {
    'ထိပ်': 'ထိပ်', 'နောက်': 'နောက်', 'ပတ်': 'ပတ်', 'ပူး': 'ပူး',
    'ပါဝါ': 'ပါဝါ', 'နက္ခတ်': 'နက္ခတ်', 'ဘရိတ်': 'ဘရိတ်',
    'ခွေ': 'ခွေ', 'ခွေပူးပါ': 'ခွေပူးပါ', 'ညီအစ်ကို': 'ညီအစ်ကို',
    'စုံစုံ': 'စုံစုံ', 'မမ': 'မမ', 'စုံမ': 'စုံမ', 'မစုံ': 'မစုံ'
};

window.entrySetFocusBox = function entrySetFocusBox(boxName) {
    entryActiveBox = boxName;
    $('boxNo').classList.remove('active-box');
    $('boxAmt').classList.remove('active-box');
    $('boxRev').classList.remove('active-box');
    if (boxName === 'no') $('boxNo').classList.add('active-box');
    else if (boxName === 'amt') $('boxAmt').classList.add('active-box');
    else if (boxName === 'rev') $('boxRev').classList.add('active-box');
};

window.entryAppendNum = function entryAppendNum(val) {
    if (entryActiveBox === 'no') $('boxNo').value += val;
    else if (entryActiveBox === 'amt') $('boxAmt').value += val;
    else if (entryActiveBox === 'rev') $('boxRev').value += val;
};

window.entryBackspace = function entryBackspace() {
    if (entryActiveBox === 'no') $('boxNo').value = $('boxNo').value.slice(0, -1);
    else if (entryActiveBox === 'amt') $('boxAmt').value = $('boxAmt').value.slice(0, -1);
    else if (entryActiveBox === 'rev') $('boxRev').value = $('boxRev').value.slice(0, -1);
};

function entryClearInputs() {
    $('boxNo').value = ''; $('boxAmt').value = ''; $('boxRev').value = '';
    entrySetFocusBox('no');
}

window.entryApplyFormula = function entryApplyFormula(fName) {
    const insert = ENTRY_FORMULA_INSERT[fName] || fName;
    const cur = $('boxNo').value.trim();
    $('boxNo').value = cur ? cur + insert : insert;
    entrySetFocusBox('amt');
};

window.entryToggleR = function entryToggleR() {
    $('boxRev').value = $('boxRev').value.trim() ? '' : 'R';
};

/** Toggle the entry-screen keypad (fixed bottom overlay, same as Agent). */
window.toggleEntryKeyboard = function toggleEntryKeyboard() {
    const kp = $('entryKeypad');
    if (!kp) return;
    kp.hidden = !kp.hidden;
    const btn = $('entryKbToggle');
    if (btn) btn.classList.toggle('active', !kp.hidden);
};

/** Open the full Agent-style entry screen for a session. */
async function openEntry(sessionId) {
    setActiveSession(sessionId);
    entryClearInputs();
    await renderEntry();
    switchTab('entry');
}

/** Refresh entry screen: session label, person select, pending table. */
async function renderEntry() {
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    $('entrySessionLabel').textContent = s ? sessionLabel(s) : 'Session မရှိပါ';

    await renderEntryPersonOptions();
    renderEntryTable();
}

/** Name dropdown: everyone mixed — player names from this session's incoming
 *  records + all registered persons (ထိုးသား / Agent / အကန်ဒိုင်).
 *  ထိုးကွက် is incoming-only; outgoing bets go through 🔄 အကန်ဒိုင်. */
async function renderEntryPersonOptions() {
    const pSel = $('entryPlayerSelect');
    const prev = pSel.value;
    const order = [];
    const seen = new Set();
    const add = (k) => { k = (k || '').trim(); if (k && !seen.has(k)) { seen.add(k); order.push(k); } };

    const recs = state.activeSessionId ? await db.query('lottery_records', 'by_session', state.activeSessionId) : [];
    recs.forEach((r) => { if (r.record_type !== 'akan') add(voucherPersonKey(r)); });
    // ထိုးသား + Agent only — အကန်ဒိုင် never mixes in here
    (state.agents || []).forEach((a) => { if ((a.person_type || 'agent') !== 'akan') add(a.name); });
    const ph = '-- ထိုးသား ရွေးပါ --';
    pSel.innerHTML = '<option value="">' + escHtml(ph) + '</option>' +
        order.map((k) => '<option value="' + escHtml(k) + '">' + escHtml(voucherPersonLabel(k)) + '</option>').join('');
    if (prev && order.includes(prev)) pSel.value = prev;
}

/** Pending entries table + totals. */
function renderEntryTable() {
    const tbody = $('entryTableBody');
    const total = entryPending.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    $('entryTotal').textContent = formatMoney(total);
    $('entryCount').textContent = entryPending.length;
    if (!entryPending.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">စာရင်း မရှိသေးပါ။</td></tr>';
        return;
    }
    tbody.innerHTML = entryPending.map((e, i) =>
        '<tr>' +
            '<td>' + (e.record_type === 'akan' ? '⬆️ ' : '') + escHtml(e.player_name || (e.record_type === 'akan' ? 'ဒိုင် (အကန်)' : 'ကိုယ်တိုင်')) + '</td>' +
            '<td class="cell-no">' + escHtml(String(e.number)) + '</td>' +
            '<td class="cell-amt">' + formatMoney(e.amount) + '</td>' +
            '<td class="cell-del"><button class="rec-del" onclick="entryDeleteRow(' + i + ')" title="ဖျက်မည်">🗑️</button></td>' +
        '</tr>'
    ).join('');
}

window.entryDeleteRow = function entryDeleteRow(i) {
    entryPending.splice(i, 1);
    renderEntryTable();
};

/** ထည့်မည် — expand the number-box formula and add to the PENDING table. */
window.submitEntryRow = async function submitEntryRow() {
    const playerName = $('entryPlayerSelect').value || null;
    const rType = 'pos'; // ထိုးကွက် is incoming-only; outgoing goes through 🔄 အကန်ဒိုင်
    const noText = $('boxNo').value.trim();
    const amtText = $('boxAmt').value.trim().replace(/[^\d]/g, '');
    const revText = $('boxRev').value.trim();

    if (!noText) { showToast('❌ ဂဏန်း (သို့) ဖော်မြူလာ ထည့်ပါ'); entrySetFocusBox('no'); return; }
    const mainAmt = parseInt(amtText, 10) || 0;
    if (mainAmt <= 0) { showToast('❌ ပမာဏ ထည့်ပါ'); entrySetFocusBox('amt'); return; }

    let line = noText + '=' + mainAmt;
    if (revText) {
        if (/^r$/i.test(revText)) line += 'r' + mainAmt;
        else {
            const revAmt = parseInt(revText.replace(/[^\d]/g, ''), 10) || 0;
            if (revAmt > 0) line += 'r' + revAmt;
        }
    }

    const { items, invalidLines } = parseBoardReport(line);
    const validItems = items.filter((it) => /^\d{2}$/.test(String(it.number)));
    if (!validItems.length) {
        showToast('❌ ဖော်မြူလာ မသိပါ (ဂဏန်း မှားနေတယ်)' + (invalidLines.length ? ': ' + invalidLines[0] : ''));
        return;
    }
    validItems.forEach((it) => {
        entryPending.push({ player_name: playerName, number: String(it.number), amount: it.amount, record_type: rType });
    });
    entryClearInputs();
    renderEntryTable();
    const skipped = invalidLines.length + (items.length - validItems.length);
    showToast(rType === 'akan' ? '✅ ထည့်ပြီးပြီ (⬆️ အထွက်)' : '✅ ထည့်ပြီးပြီ' + (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : ''));
};

/** 💾 Save — persist all pending entries as NEW batches (one batch_no per person/type). */
window.saveEntryBatch = async function saveEntryBatch() {
    if (entrySaveInFlight) return;
    if (!entryPending.length) { showToast('စာရင်း မရှိသေးပါ'); return; }
    if (!state.activeSessionId) { showToast('⚠️ Session မရှိသေးပါ'); return; }

    entrySaveInFlight = true;
    try {
        // Group by (person, record_type), preserving first-appearance order
        const order = [];
        const byKey = {};
        entryPending.forEach((e) => {
            const k = (e.player_name || '') + '|' + (e.record_type || 'pos');
            if (!byKey[k]) { byKey[k] = []; order.push(k); }
            byKey[k].push(e);
        });

        let count = 0;
        for (const k of order) {
            const batchNo = 'B' + Date.now().toString(36) + count.toString(36);
            for (const e of byKey[k]) {
                await createRecord('lottery_records', {
                    session: state.activeSessionId,
                    number: String(e.number).padStart(2, '0'),
                    amount: Number(e.amount) || 0,
                    agent_name: e.player_name || '',
                    player_name: e.player_name || '',
                    record_type: e.record_type || 'pos',
                    batch_no: batchNo,
                });
                count++;
            }
        }
        entryPending = [];
        renderEntryTable();
        showToast('✅ သိမ်းပြီးပြီ');
        await loadSessions();
        renderSessions();
        renderLedger();
    } catch (e) {
        showToast('သိမ်းမရပါ: ' + e.message);
    } finally {
        entrySaveInFlight = false;
    }
};

/** 📋 button in entry screen → open the paste Digital Board modal. */
window.openEntryBoard = function openEntryBoard() {
    state.boardMode = 'entry';
    openBoard(state.activeSessionId);
};

/** 📋 button in akandain screen → board feeds the OUTGOING pending table. */
window.openAkanBoard = function openAkanBoard() {
    state.boardMode = 'akan';
    openBoard(state.activeSessionId);
    // Bookie is chosen on the akandain screen — hide the board's target row.
    $('boardTargetWrap').style.display = 'none';
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    $('boardTitle').textContent = '🔄 အကန်ဒိုင် (အထွက်) — ' + (s ? sessionLabel(s) : '');
};

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
        return;
    }
    const limit = sessionLimit(s);
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
    $('ledgerBoardBtn').addEventListener('click', () => openEntry(s.id));
    grid.innerHTML = cells;
    $('ledgerTotal').textContent = formatMoney(total);
    $('ledgerBoxes').textContent = limit ? (total / limit).toFixed(1) : '0';
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
    if ($('tab-winning') && $('tab-winning').classList.contains('active')) renderWinningHome();
}

/** Home 🎯 ပေါက်သီး tab: every session with its winning number + ထည့်/ပြင် button. */
async function renderWinningHome() {
    const box = $('winHomeList');
    const sess = (state.sessions || []).slice().sort((a, b) =>
        String(b.created || '').localeCompare(String(a.created || '')));
    if (!sess.length) { box.innerHTML = '<div class="empty">ပွဲ မရှိသေးပါ</div>'; return; }
    const rows = [];
    for (const s of sess) {
        const wins = await db.query('winning_numbers', 'by_session', s.id);
        const num = wins.length ? String(wins[0].number).padStart(2, '0') : null;
        rows.push('<div class="agent-row"><div><div class="nm">' + escHtml(sessionLabel(s)) + '</div>' +
            '<div class="ph">' + (num
                ? '🏆 ပေါက်သီး <b style="color:var(--green)">' + escHtml(num) + '</b>'
                : 'ပေါက်သီး မထည့်ရသေး') + '</div></div>' +
            '<div class="acts"><button class="btn small green" onclick="openWinning(\'' + s.id + '\')">' +
            (num ? 'ပြင်မယ်' : 'ထည့်မယ်') + '</button></div></div>');
    }
    box.innerHTML = rows.join('');
}
window.openWinning = openWinning;

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

/** Person type label: agent (default) / player (ထိုးသား) / akan (အကန်ဒိုင်). */
function personTypeLabel(a) {
    const t = (a && a.person_type) || 'agent';
    return t === 'player' ? 'ထိုးသား' : t === 'akan' ? 'အကန်ဒိုင်' : 'Agent';
}

function renderAgents() {
    const box = $('agentList');
    if (!state.agents.length) {
        box.innerHTML = '<div class="empty">လူ မရှိသေးပါ</div>';
        return;
    }
    box.innerHTML = state.agents.map((a) => `
        <div class="agent-row">
            <div><div class="nm">${escHtml(a.name)} <span class="ptype">${escHtml(personTypeLabel(a))}</span></div>
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
    $('agentModalTitle').textContent = a ? 'လူ ပြင်မယ်' : 'လူအသစ်';
    $('agName').value = a ? a.name : '';
    $('agType').value = a ? (a.person_type || 'agent') : 'agent';
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
        person_type: $('agType').value || 'agent',
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

    // per-person aggregation: incoming and outgoing (akan) shown as separate rows
    const per = {};
    const pLabel = {};
    for (const r of recs) {
        const isAkan = r.record_type === 'akan';
        const pkey = voucherPersonKey(r) || '(အမည် မရှိ)';
        const key = (isAkan ? 'akan:' : 'pos:') + pkey;
        if (!per[key]) { per[key] = { bet: 0, win: 0, winDeduct: 0, isAkan }; pLabel[key] = voucherPersonLabel(pkey); }
        const amt = Number(r.amount) || 0;
        per[key].bet += isAkan ? -amt : amt;
        // ပေါက် column DISPLAYS the raw winning amount only.
        // Behind the scenes ("နောက်ကွယ်ကတွက်မယ်") the net uses win × payout (80).
        // Bettors: Pho PAYS winnings (deduct). Akan: bookie PAYS Pho (add).
        if (winNum && String(r.number).padStart(2, '0') === winNum) {
            const ag0 = state.agents.find((a) => a.name === pLabel[key]);
            const payout = ag0 ? (Number(ag0.payout_rate) || 80) : 80;
            per[key].win += amt;
            per[key].winDeduct += amt * payout;
        }
    }
    let rows = '', tBet = 0, tWin = 0, tComm = 0, tWinDeductPos = 0, tWinDeductAkan = 0, tNet = 0;
    for (const [key, v] of Object.entries(per)) {
        const label = pLabel[key];
        const ag = state.agents.find((a) => a.name === label);
        const comm = ag ? (Number(ag.commission) || 0) : 0;
        const commAmt = Math.round(v.bet * comm / 100);
        // Bettors: ကျန် = ထိုးငွေ − ကော် − (အပေါက် × 80). Pho pays winners.
        // Akan: ကျန် = ထိုးငွေ − ကော် + (အပေါက် × 80). Bookie pays Pho.
        const net = v.isAkan ? v.bet - commAmt + v.winDeduct : v.bet - commAmt - v.winDeduct;
        tBet += v.bet; tWin += v.win; tComm += commAmt; tNet += net;
        if (v.isAkan) tWinDeductAkan += v.winDeduct; else tWinDeductPos += v.winDeduct;
        const nameHtml = v.isAkan
            ? `<span style="color:var(--red);font-weight:700">⬆️ ${escHtml(label)}</span>`
            : escHtml(label);
        rows += `<tr><td>${nameHtml}</td><td>${formatMoney(v.bet)}</td><td>${formatMoney(v.win)}</td><td>${formatMoney(net)}</td></tr>`;
    }
    // Total deducts commission and the background (win × 80), not the displayed raw win.
    // tNet is the sum of row nets (handles both bettor and akan directions).
    const html = `
        <div class="muted small" style="margin-bottom:8px">${escHtml(s ? sessionLabel(s) : '')}
        ${winNum ? ` · 🏆 ပေါက်သီး <b style="color:var(--green)">${winNum}</b>` : ' · ပေါက်သီး မထည့်ရသေး'}</div>
        <table class="data"><tr><th>ထိုးသား</th><th>ထိုးငွေ</th><th>ပေါက်</th><th>ကျန်</th></tr>
        ${rows || '<tr><td colspan="4" class="muted">မှတ်တမ်း မရှိ</td></tr>'}
        </table>
        <div class="card" style="margin-top:10px"><div style="font-weight:700;margin-bottom:6px">📊 အချုပ်</div>
        <table class="data">
        <tr class="total"><td>ကျန်</td><td style="text-align:right">${(tNet < 0 ? '−' : '+') + formatMoney(Math.abs(tNet))}</td></tr>
        </table></div>`;
    openGeneric('📑 Daily စာရင်းချုပ်', html);
}

/* ================= WEEKLY SUMMARY (v1 cross-tab) ================= */

function parseSessionDate(ds) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(ds || '');
    if (!m) return null;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function mondayOf(d) {
    const diff = (d.getDay() + 6) % 7; // days since Monday
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
}

function dsOf(d) {
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

const WK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function shortTimeType(tt) {
    if (tt === 'မနက်ပိုင်း') return 'မနက်';
    if (tt === 'ညနေပိုင်း') return 'ညနေ';
    return tt || '';
}

async function renderWeekly() {
    const box = $('weeklyContent');
    const offset = state.weeklyOffset || 0;
    const mon = mondayOf(new Date());
    mon.setDate(mon.getDate() + offset * 7);
    const days = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
        days.push({ ds: dsOf(d), name: WK_DAYS[i] });
    }
    $('wkLabel').textContent = `${days[0].ds} – ${days[4].ds}`;
    const daySet = new Set(days.map((x) => x.ds));

    const weekSessions = state.sessions.filter((s) => s.date && daySet.has(s.date));

    // agg key: (akan? 'akan:':'pos:') + pkey
    // perDay[5] -> { am: {bet,win,winDeduct,has}, pm: {...} }
    const agg = {};
    const rowOrder = [];
    const blankCell = () => ({ bet: 0, win: 0, winDeduct: 0, has: false });
    for (const s of weekSessions) {
        const dayIdx = days.findIndex((d) => d.ds === s.date);
        if (dayIdx < 0) continue;
        const isAM = (s.timeType || '') === 'မနက်ပိုင်း';
        const recs = await db.query('lottery_records', 'by_session', s.id);
        const wins = await db.query('winning_numbers', 'by_session', s.id);
        const winNum = wins.length ? String(wins[0].number).padStart(2, '0') : null;
        for (const r of recs) {
            const isAkan = r.record_type === 'akan';
            const pkey = voucherPersonKey(r) || '(အမည် မရှိ)';
            const rk = (isAkan ? 'akan:' : 'pos:') + pkey;
            if (!agg[rk]) {
                agg[rk] = {
                    isAkan, label: voucherPersonLabel(pkey), pkey,
                    perDay: [0, 1, 2, 3, 4].map(() => ({ am: blankCell(), pm: blankCell() })),
                };
                rowOrder.push(rk);
            }
            const d = isAM ? agg[rk].perDay[dayIdx].am : agg[rk].perDay[dayIdx].pm;
            const amt = Number(r.amount) || 0;
            if (amt !== 0) d.has = true;
            d.bet += isAkan ? -amt : amt;
            if (winNum && String(r.number).padStart(2, '0') === winNum) {
                const ag0 = state.agents.find((a) => a.name === agg[rk].label);
                const payout = ag0 ? (Number(ag0.payout_rate) || 80) : 80;
                d.win += amt;
                d.winDeduct += amt * payout;
                d.has = true;
            }
        }
    }

    if (!rowOrder.length) {
        box.innerHTML = '<div class="empty">ဒီအပတ် မှတ်တမ်း မရှိသေးပါ</div>';
        return;
    }

    // Compute nets; dayTotals[5] = {am, pm} nets
    const dayTotals = [0, 1, 2, 3, 4].map(() => ({ am: 0, pm: 0 }));
    let grandTotal = 0;
    const rows = rowOrder.map((rk) => {
        const e = agg[rk];
        const ag = state.agents.find((a) => a.name === e.label);
        const comm = ag ? (Number(ag.commission) || 0) : 0;
        const cells = []; // 10 cells: [day0am, day0pm, day1am, ...]
        let rowTotal = 0;
        for (let i = 0; i < 5; i++) {
            for (const k of ['am', 'pm']) {
                const d = e.perDay[i][k];
                if (!d.has) { cells.push(null); continue; }
                const commAmt = Math.round(d.bet * comm / 100);
                const net = e.isAkan ? d.bet - commAmt + d.winDeduct : d.bet - commAmt - d.winDeduct;
                cells.push({ bet: d.bet, win: d.win, net });
                rowTotal += net;
                dayTotals[i][k] += net;
            }
        }
        grandTotal += rowTotal;
        return { e, cells, rowTotal };
    });

    // akan (red) rows always at the bottom
    rows.sort((a, b) => (a.e.isAkan ? 1 : 0) - (b.e.isAkan ? 1 : 0));

    const signMoney = (n) => (n < 0 ? '−' : '+') + formatMoney(Math.abs(Math.round(n * 10) / 10));
    const MM_DAY = ['တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ'];
    let html = '<table class="wtable"><tr><th>အမည်</th>';
    days.forEach((d, i) => {
        html += `<th>${MM_DAY[i]} နံနက်<br><span style="font-size:11px">${signMoney(dayTotals[i].am)}</span></th>`;
        html += `<th>${MM_DAY[i]} ညနေ<br><span style="font-size:11px">${signMoney(dayTotals[i].pm)}</span></th>`;
    });
    html += `<th>Total<br><span style="font-size:11px">${signMoney(grandTotal)}</span></th></tr>`;

    rows.forEach((r, ri) => {
        const nameHtml = (r.e.isAkan ? '⬆️ ' : '') + escHtml(r.e.label);
        const nameCell = r.e.isAkan
            ? `<td><span style="color:var(--red);font-weight:700">${nameHtml}</span></td>`
            : `<td><b>${nameHtml}</b></td>`;
        html += `<tr>${nameCell}`;
        r.cells.forEach((c, ci) => {
            const isAM = ci % 2 === 0;
            const dayIdx = Math.floor(ci / 2);
            const cellAttr = c ? ` data-wcell="${ri}:${dayIdx}:${isAM ? 'am' : 'pm'}" style="cursor:pointer"` : '';
            html += c ? `<td${cellAttr}>${formatMoney(c.bet)} / ${formatMoney(c.win)}</td>` : '<td class="muted">-</td>';
        });
        html += `<td><b>${signMoney(r.rowTotal)}</b></td></tr>`;
    });
    html += '</table>';
    box.innerHTML = html;
    box.querySelectorAll('[data-wcell]').forEach((td) => {
        let lpTimer = null;
        const startLp = (e) => {
            lpTimer = setTimeout(() => {
                lpTimer = null;
                const [ri, di, ampm] = td.getAttribute('data-wcell').split(':');
                openWeeklyCell(_weeklyRows[Number(ri)], _weeklyDays[Number(di)], ampm);
                if (e && e.preventDefault) e.preventDefault();
            }, 550);
        };
        const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
        td.addEventListener('touchstart', startLp, { passive: true });
        td.addEventListener('touchend', cancelLp);
        td.addEventListener('touchmove', cancelLp);
        td.addEventListener('mousedown', startLp);
        td.addEventListener('mouseup', cancelLp);
        td.addEventListener('mouseleave', cancelLp);
    });
    _weeklyRows = rows;
    _weeklyDays = days;
}

let _weeklyRows = [];
let _weeklyDays = [];

async function openWeeklyCell(row, day, ampm) {
    const e = row.e;
    const wantTime = ampm === 'am' ? 'မနက်ပိုင်း' : 'ညနေပိုင်း';
    const sessions = state.sessions.filter((s) => s.date === day.ds && (s.timeType || '') === wantTime);
    const recs = [];
    for (const s of sessions) {
        const rs = await db.query('lottery_records', 'by_session', s.id);
        for (const r of rs) {
            const isAkan = r.record_type === 'akan';
            if (isAkan !== e.isAkan) continue;
            const pkey = voucherPersonKey(r) || '(အမည် မရှိ)';
            if (pkey !== e.pkey) continue;
            recs.push(r);
        }
    }
    if (!recs.length) { showToast('မှတ်တမ်း မရှိပါ'); return; }
    let html = `<div style="font-weight:700;margin-bottom:8px">${escHtml(e.label)} (${ampm === 'am' ? 'နံနက်' : 'ညနေ'}) — ${escHtml(day.name)}</div>`;
    html += '<div style="max-height:50vh;overflow-y:auto">';
    recs.forEach((r, i) => {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)">` +
            `<span style="flex:1"><b>${escHtml(String(r.number))}</b> — ${formatMoney(r.amount)}</span>` +
            `<button class="btn small" data-wedit="${i}">✏️</button>` +
            `<button class="btn small danger" data-wdel="${i}">🗑️</button></div>`;
    });
    html += '</div>';
    $('wcellBody').innerHTML = html;
    openModal('modal-wcell');
    $('wcellBody').querySelectorAll('[data-wedit]').forEach((b) => {
        b.addEventListener('click', async () => {
            const r = recs[Number(b.getAttribute('data-wedit'))];
            const nv = prompt('ပမာဏ ပြင်ရန်', String(r.amount));
            if (nv === null) return;
            const v = Number(nv);
            if (!v || v <= 0) { showToast('ပမာဏ မှားနေတယ်'); return; }
            r.amount = v;
            r._updated = Date.now();
            await updateRecord('lottery_records', r);
            closeModal('modal-wcell');
            renderWeekly();
            showToast('ပြင်ပြီးပြီ');
        });
    });
    $('wcellBody').querySelectorAll('[data-wdel]').forEach((b) => {
        b.addEventListener('click', async () => {
            const r = recs[Number(b.getAttribute('data-wdel'))];
            if (!confirm(`"${r.number}" ဖျက်မလား?`)) return;
            await deleteRecord('lottery_records', r);
            closeModal('modal-wcell');
            renderWeekly();
            showToast('ဖျက်ပြီးပြီ');
        });
    });
}
window.openWeeklyCell = openWeeklyCell;

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

/* ================= ⚖️ ကြီးငယ် (BIG / SMALL) ================= */

async function openBigSmall(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    // per-person (exclude akan), first-appearance order — same as vouchers
    const mine = recs.filter((r) => r.record_type !== 'akan');
    const order = [];
    const seen = {};
    mine.forEach((r) => {
        const k = voucherPersonKey(r);
        if (!seen[k]) { seen[k] = 1; order.push(k); }
    });
    const label = escHtml(s ? sessionLabel(s) : '');
    openGeneric('⚖️ ကြီးငယ်', `
        <div class="muted small" style="margin-bottom:8px">${label}</div>
        <div class="field"><label>လူရွေးရန်</label>
            <select id="bigsmallPerson">
                ${order.map((k, i) => `<option value="${escHtml(k)}"${i === 0 ? ' selected' : ''}>${escHtml(voucherPersonLabel(k))}</option>`).join('')}
            </select>
        </div>
        <div id="bigsmallList"></div>`);
    const renderBigSmall = () => {
        const sel = $('bigsmallPerson').value;
        const prs = mine.filter((r) => voucherPersonKey(r) === sel);
        // aggregate per number, sort big -> small
        const agg = {};
        for (const r of prs) {
            const n = String(r.number).padStart(2, '0');
            const amt = Number(r.amount) || 0;
            agg[n] = (agg[n] || 0) + amt;
        }
        const rows = Object.keys(agg)
            .filter((n) => agg[n] !== 0)
            .map((n) => ({ n, a: agg[n] }))
            .sort((x, y) => Number(y.n) - Number(x.n)); // by NUMBER desc: 99, 98, 97…
        $('bigsmallList').innerHTML = rows.length
            ? rows.map((r) =>
                `<div class="voucher-row"><span class="v-no">${r.n}</span><span class="v-amt">${formatMoney(r.a)}</span></div>`).join('')
            : '<div class="muted small">စာရင်း မရှိသေးပါ</div>';
    };
    $('bigsmallPerson').addEventListener('change', renderBigSmall);
    renderBigSmall();
}

/* ================= 🚫 ဒိုင်ပိတ်ဂဏန်း (BLOCKED NUMBERS) ================= */

function blockedKey(sessionId) { return 'v2_blocked_' + sessionId; }

function getBlocked(sessionId) {
    try {
        const raw = localStorage.getItem(blockedKey(sessionId));
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((n) => /^\d{2}$/.test(n)) : [];
    } catch (e) { return []; }
}

function setBlocked(sessionId, arr) {
    const clean = Array.from(new Set(arr.map((n) => String(n).padStart(2, '0'))))
        .filter((n) => /^\d{2}$/.test(n)).sort();
    localStorage.setItem(blockedKey(sessionId), JSON.stringify(clean));
    return clean;
}

function openBlocked(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const list = getBlocked(sessionId);
    const chips = list.length
        ? list.map((n) => `<span class="dchip" data-blocked="${n}">${n} <b data-unblock="${n}" style="cursor:pointer;color:var(--red)">×</b></span>`).join('')
        : '<div class="muted small">ပိတ်ထားတဲ့ ဂဏန်း မရှိသေးပါ</div>';
    const html = `
        <div class="muted small" style="margin-bottom:8px">${escHtml(s ? sessionLabel(s) : '')} · ဒိုင်က မရောင်းဘူးဆိုပြီး ပိတ်ထားတဲ့ ဂဏန်းများ</div>
        <div class="row" style="margin-bottom:10px">
            <input id="blockedInput" class="field" type="text" inputmode="numeric" maxlength="2"
                placeholder="ဂဏန်း ၂ လုံး" style="flex:1;min-width:0">
            <button class="btn small" id="blockedAdd">+ ထည့်မယ်</button>
        </div>
        <div class="digit-chips" id="blockedChips">${chips}</div>
        <div class="row" style="margin-top:10px">
            <button class="btn small gray" id="blockedCopy">📋 ကူးရန်</button>
        </div>`;
    openGeneric('🚫 ဒိုင်ပိတ်ဂဏန်း', html);

    const refresh = () => {
        const cur = getBlocked(sessionId);
        $('blockedChips').innerHTML = cur.length
            ? cur.map((n) => `<span class="dchip">${n} <b data-unblock="${n}" style="cursor:pointer;color:var(--red)">×</b></span>`).join('')
            : '<div class="muted small">ပိတ်ထားတဲ့ ဂဏန်း မရှိသေးပါ</div>';
        bindUnblock();
    };
    const bindUnblock = () => {
        $('blockedChips').querySelectorAll('[data-unblock]').forEach((b) => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = getBlocked(sessionId).filter((n) => n !== b.dataset.unblock);
                setBlocked(sessionId, cur);
                refresh();
                showToast('🗑️ ဖြုတ်ပြီးပြီ');
            });
        });
    };
    const addNum = () => {
        const v = $('blockedInput').value.replace(/\D/g, '').slice(-2).padStart(2, '0');
        if (!/^\d{2}$/.test(v)) { showToast('ဂဏန်း ၂ လုံး ထည့်ပါ'); return; }
        const cur = getBlocked(sessionId);
        if (cur.includes(v)) { showToast('ထည့်ပြီးသား ဖြစ်နေပါတယ်'); return; }
        setBlocked(sessionId, cur.concat([v]));
        $('blockedInput').value = '';
        refresh();
        showToast(`🚫 ${v} ပိတ်ပြီးပြီ`);
    };
    $('blockedAdd').addEventListener('click', addNum);
    $('blockedInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNum(); });
    $('blockedCopy').addEventListener('click', async () => {
        const cur = getBlocked(sessionId);
        if (!cur.length) { showToast('ကူးစရာ မရှိပါ'); return; }
        try {
            await navigator.clipboard.writeText(cur.join(' '));
            showToast(`📋 ${cur.length} ကွက် ကူးပြီးပြီ`);
        } catch (e) { showToast(cur.join(' ')); }
    });
    bindUnblock();
}

/* ================= 💰 ALL Total ================= */

async function openAllTotal(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    let pos = 0, akan = 0, posCount = 0, akanCount = 0;
    for (const r of recs) {
        const amt = Number(r.amount) || 0;
        if (r.record_type === 'akan') { akan += amt; akanCount++; }
        else { pos += amt; posCount++; }
    }
    const net = pos - akan;
    const html = `
        <div class="muted small" style="margin-bottom:8px">${escHtml(s ? sessionLabel(s) : '')}</div>
        <table class="data">
            <tr><th>အမျိုးအစား</th><th>မှတ်တမ်း</th><th>ပမာဏ</th></tr>
            <tr><td>📝 ထိုးငွေ</td><td>${posCount}</td><td>${formatMoney(pos)}</td></tr>
            <tr><td>🏠 အကန်</td><td>${akanCount}</td><td>${formatMoney(akan)}</td></tr>
            <tr class="total"><td>💰 ALL Total (net)</td><td>${posCount + akanCount}</td><td>${formatMoney(net)}</td></tr>
        </table>
        <div class="row" style="margin-top:10px">
            <button class="btn small gray" id="allTotalCopy">📋 ကူးရန်</button>
        </div>`;
    openGeneric('💰 ALL Total', html);
    $('allTotalCopy').addEventListener('click', async () => {
        const text = `ထိုးငွေ: ${formatMoney(pos)}\nအကန်: ${formatMoney(akan)}\nALL Total: ${formatMoney(net)}`;
        try {
            await navigator.clipboard.writeText(text);
            showToast('📋 ကူးပြီးပြီ');
        } catch (e) { showToast('ကူးမရပါ'); }
    });
}

/* ================= 🧾 ဘောက်ချာများ (VOUCHERS) ================= */

/** Session records in saved order (never re-sorted beyond entry order). */
async function sessionRecordsOrdered(sessionId) {
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    return recs.slice().sort((a, b) =>
        (a.created || a._updated || 0) - (b.created || b._updated || 0));
}

function voucherPersonKey(r) {
    return r.player_name || r.agent_name || '';
}
function voucherPersonLabel(k) {
    return k || 'ကိုယ်တိုင်';
}

function fillSessionSelect(sel, selectedId) {
    sel.innerHTML = state.sessions.map((s) =>
        `<option value="${escHtml(s.id)}"${s.id === selectedId ? ' selected' : ''}>${escHtml(sessionLabel(s))}</option>`
    ).join('');
}

async function renderVouchers() {
    const sessSel = $('voucherSession');
    if (!state.voucherSessionId || !state.sessions.find((s) => s.id === state.voucherSessionId)) {
        state.voucherSessionId = state.activeSessionId;
    }
    fillSessionSelect(sessSel, state.voucherSessionId);

    const sid = sessSel.value;
    state.voucherSessionId = sid;
    if (!sid) {
        $('voucherContent').innerHTML = '<div class="empty">ပွဲ မရှိသေးပါ</div>';
        state.lastVoucherText = '';
        return;
    }
    let recs = await sessionRecordsOrdered(sid);

    const order = [];
    const seen = {};
    const akanKeys = {};
    recs.forEach((r) => {
        const k = voucherPersonKey(r);
        if (!seen[k]) { seen[k] = 1; order.push(k); }
        if (r.record_type === 'akan') akanKeys[k] = true;
    });

    const pSel = $('voucherPerson');
    const prev = pSel.value;
    pSel.innerHTML = '<option value="__all">အားလုံး</option>' + order.map((k) =>
        `<option value="${escHtml(k)}">${akanKeys[k] ? '⬆️ ' : ''}${escHtml(voucherPersonLabel(k))}</option>`).join('');
    pSel.value = (prev && (prev === '__all' || order.includes(prev))) ? prev : '__all';

    renderVoucherContent();
}

async function renderVoucherContent() {
    const sid = $('voucherSession').value;
    const sel = $('voucherPerson').value;
    const box = $('voucherContent');
    if (!sid) { box.innerHTML = ''; state.lastVoucherText = ''; return; }

    let recs = await sessionRecordsOrdered(sid);
    if (sel !== '__all') recs = recs.filter((r) => voucherPersonKey(r) === sel);
    if (!recs.length) {
        box.innerHTML = '<div class="empty">စာရင်း မရှိသေးပါ</div>';
        state.lastVoucherText = '';
        return;
    }

    // Group: player (first-appearance order) → batch (first-appearance order) → entry order
    const playerOrder = [];
    const byPlayer = {};
    recs.forEach((r) => {
        const k = voucherPersonKey(r);
        if (!byPlayer[k]) { byPlayer[k] = []; playerOrder.push(k); }
        byPlayer[k].push(r);
    });

    const players = playerOrder.map((k) => {
        const pRecs = byPlayer[k];
        const batchOrder = [];
        const byBatch = {};
        pRecs.forEach((r) => {
            const b = (r.batch_no === undefined || r.batch_no === null) ? '__none__' : String(r.batch_no);
            if (!byBatch[b]) { byBatch[b] = []; batchOrder.push(b); }
            byBatch[b].push(r);
        });
        const batches = batchOrder.map((b, i) => ({
            label: 'NO ' + (i + 1),
            items: byBatch[b],
        }));
        const isAkan = pRecs.length > 0 && pRecs.every((r) => r.record_type === 'akan');
        return { key: k, label: voucherPersonLabel(k), batches, isAkan };
    });

    // On-screen HTML: neat table per batch with per-batch total
    let html = '';
    players.forEach((p) => {
        html += '<div class="v-player-block"><div class="v-player-name">' +
            (p.isAkan ? '⬆️ ' : '') + escHtml(p.label) +
            (p.isAkan ? ' <span class="ptype">အထွက်</span>' : '') + '</div>';
        p.batches.forEach((b) => {
            const bTotal = b.items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            html += '<div class="v-batch"><div class="v-batch-no">' + escHtml(b.label) + '</div>' +
                '<table class="v-table"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th></tr></thead><tbody>' +
                b.items.map((r) =>
                    '<tr><td>' + escHtml(String(r.number).padStart(2, '0')) + '</td>' +
                    '<td>' + formatMoney(r.amount) + '</td></tr>'
                ).join('') +
                '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(bTotal) + '</td></tr></tfoot></table></div>';
        });
        html += '</div>';
    });
    box.innerHTML = html;

    // Plain text (Pho's format: name → NO X → "55 500" lines → Total per batch)
    const lines = [];
    players.forEach((p, pi) => {
        if (pi > 0) lines.push('');
        lines.push((p.isAkan ? '⬆️ ' : '') + p.label);
        p.batches.forEach((b, bi) => {
            if (bi > 0) lines.push('');
            lines.push(b.label);
            let bTotal = 0;
            b.items.forEach((r) => {
                const amt = Number(r.amount) || 0;
                bTotal += amt;
                lines.push(String(r.number).padStart(2, '0') + ' ' + amt);
            });
            lines.push('Total ' + bTotal);
        });
    });
    state.lastVoucherText = lines.join('\n');
}

async function copyTextHelper(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e2) { return false; }
    }
}

async function copyVoucher() {
    const t = state.lastVoucherText;
    if (!t) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    const ok = await copyTextHelper(t);
    showToast(ok ? '✅ ကူးပြီးပြီ' : '❌ ကူးမရပါ');
}

function printVoucher() {
    const t = state.lastVoucherText;
    if (!t) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    const esc = escHtml(t);
    const s = state.sessions.find((x) => x.id === state.voucherSessionId);
    $('printArea').innerHTML =
        '<div class="print-receipt">' +
        '<div class="pr-title">🧾 ဘောက်ချာ</div>' +
        '<div class="pr-sub">' + escHtml(s ? sessionLabel(s) : '') + '</div>' +
        '<div class="pr-line"></div>' +
        '<pre class="pr-pre">' + esc + '</pre>' +
        '<div class="pr-line"></div>' +
        '</div>';
    window.print();
}

async function shareVoucher() {
    const t = state.lastVoucherText;
    if (!t) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    if (navigator.share) {
        try { await navigator.share({ text: t }); } catch (e) { /* dismissed */ }
    } else {
        await copyVoucher();
    }
}

/* ================= 🔴 အကျွံဂဏန်းများ (OVER-LIMIT) ================= */

async function calcOverlimit(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const limit = sessionLimit(s);
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    const agg = {};
    for (const r of recs) {
        const n = String(r.number).padStart(2, '0');
        const amt = Number(r.amount) || 0;
        agg[n] = (agg[n] || 0) + (r.record_type === 'akan' ? -amt : amt);
    }
    const over = [];
    for (let i = 0; i < 100; i++) {
        const n = String(i).padStart(2, '0');
        const total = agg[n] || 0;
        if (total > limit) over.push({ number: n, total, excess: total - limit });
    }
    return { limit, over };
}

async function renderOverlimit() {
    const sessSel = $('overSession');
    if (!state.overSessionId || !state.sessions.find((s) => s.id === state.overSessionId)) {
        state.overSessionId = state.activeSessionId;
    }
    fillSessionSelect(sessSel, state.overSessionId);

    const sid = sessSel.value;
    state.overSessionId = sid;
    const box = $('overContent');
    if (!sid) {
        box.innerHTML = '<div class="empty">ပွဲ မရှိသေးပါ</div>';
        $('overLimitLabel').textContent = '';
        state.lastOverText = '';
        return;
    }
    const { limit, over } = await calcOverlimit(sid);
    $('overLimitLabel').textContent = 'Limit ' + formatMoney(limit);

    if (!over.length) {
        box.innerHTML = '<div class="empty">✅ အကျွံ မရှိပါ<br>Limit ' + formatMoney(limit) + ' ကျော်တာ မရှိဘူး</div>';
        state.lastOverText = '';
        return;
    }

    box.innerHTML = '<div class="card"><table class="data">' +
        '<tr><th>ဂဏန်း</th><th>စုစုပေါင်း</th><th>အကျွံ</th></tr>' +
        over.map((o) =>
            '<tr class="over-row"><td>' + escHtml(o.number) + '</td>' +
            '<td>' + formatMoney(o.total) + '</td>' +
            '<td><b>' + formatMoney(o.excess) + '</b></td></tr>'
        ).join('') +
        '</table><div class="small muted mt">အနီရောင် = Limit ကျော်နေတဲ့ ဂဏန်းများ — ပိုနေတာကို တခြားဒိုင်မှာ သွားကန်ပါ</div></div>';

    state.lastOverText = over.map((o) => o.number + ' ' + o.excess).join('\n');
}

async function copyOverlimit() {
    const t = state.lastOverText;
    if (!t) { showToast('အကျွံ မရှိပါ'); return; }
    const ok = await copyTextHelper(t);
    showToast(ok ? '✅ အကျွံစာရင်း ကူးပြီးပြီ' : '❌ ကူးမရပါ');
}

/** One-tap: push over-limit list into the အကန်ဒိုင် OUTGOING pending table and go there. */
async function sendOverToAkan() {
    const t = state.lastOverText;
    if (!t) { showToast('အကျွံ မရှိပါ'); return; }
    const { items } = parseBoardReport(t);
    const validItems = items.filter((it) => /^\d{2}$/.test(String(it.number)));
    if (!validItems.length) { showToast('ထည့်တာ မမှန်ပါ'); return; }
    const bookie = (($('akanBookieSelect') && $('akanBookieSelect').value) || '').trim() || null;
    validItems.forEach((it) => {
        akanPending.push({
            player_name: bookie,
            number: String(it.number).padStart(2, '0'),
            amount: Number(it.amount) || 0,
            record_type: 'akan',
        });
    });
    const ok = await copyTextHelper(t);
    await openAkandain(state.overSessionId || state.activeSessionId);
    showToast('✅ အကန်ဒိုင်သို့ ပို့ပြီးပြီ (အထွက်)' + (ok ? ' — ကူးပြီးသား' : ''));
}

/* ================= 🔄 အကန်ဒိုင် (AKAN — OUTGOING bets, Agent-style entry) ================= */
/* Pho: "ကိုယ်ကသူများစီထိုးမှာမို့ အထွက်ပြပါ။ အဝင်မဟုတ်" — everything here is
   OUTGOING (money leaves the shop). Saved with record_type 'akan' so the
   ledger nets it out and vouchers exclude it, same as the house-akan flow. */

let akanPending = [];      // typed but NOT yet saved: [{player_name(bookie), number, amount, record_type:'akan'}]
let akanActiveBox = 'no';  // 'no' | 'amt' | 'rev'
let akanSaveInFlight = false;

const AKAN_FORMULA_INSERT = {
    'ထိပ်': 'ထိပ်', 'နောက်': 'နောက်', 'ပတ်': 'ပတ်', 'ပူး': 'ပူး',
    'ပါဝါ': 'ပါဝါ', 'နက္ခတ်': 'နက္ခတ်', 'ဘရိတ်': 'ဘရိတ်',
    'ခွေ': 'ခွေ', 'ခွေပူးပါ': 'ခွေပူးပါ', 'ညီအစ်ကို': 'ညီအစ်ကို',
    'စုံစုံ': 'စုံစုံ', 'မမ': 'မမ', 'စုံမ': 'စုံမ', 'မစုံ': 'မစုံ'
};

window.akanSetFocusBox = function akanSetFocusBox(boxName) {
    akanActiveBox = boxName;
    $('akanBoxNo').classList.remove('active-box');
    $('akanBoxAmt').classList.remove('active-box');
    $('akanBoxRev').classList.remove('active-box');
    if (boxName === 'no') $('akanBoxNo').classList.add('active-box');
    else if (boxName === 'amt') $('akanBoxAmt').classList.add('active-box');
    else if (boxName === 'rev') $('akanBoxRev').classList.add('active-box');
};

window.akanAppendNum = function akanAppendNum(val) {
    if (akanActiveBox === 'no') $('akanBoxNo').value += val;
    else if (akanActiveBox === 'amt') $('akanBoxAmt').value += val;
    else if (akanActiveBox === 'rev') $('akanBoxRev').value += val;
};

window.akanBackspace = function akanBackspace() {
    if (akanActiveBox === 'no') $('akanBoxNo').value = $('akanBoxNo').value.slice(0, -1);
    else if (akanActiveBox === 'amt') $('akanBoxAmt').value = $('akanBoxAmt').value.slice(0, -1);
    else if (akanActiveBox === 'rev') $('akanBoxRev').value = $('akanBoxRev').value.slice(0, -1);
};

function akanClearInputs() {
    $('akanBoxNo').value = ''; $('akanBoxAmt').value = ''; $('akanBoxRev').value = '';
    akanSetFocusBox('no');
}

window.akanApplyFormula = function akanApplyFormula(fName) {
    const insert = AKAN_FORMULA_INSERT[fName] || fName;
    const cur = $('akanBoxNo').value.trim();
    $('akanBoxNo').value = cur ? cur + insert : insert;
    akanSetFocusBox('amt');
};

window.akanToggleR = function akanToggleR() {
    $('akanBoxRev').value = $('akanBoxRev').value.trim() ? '' : 'R';
};

/** Toggle the akandain-screen keypad (fixed bottom overlay, same as entry). */
window.toggleAkanKeyboard = function toggleAkanKeyboard() {
    const kp = $('akanKeypad');
    if (!kp) return;
    kp.hidden = !kp.hidden;
    const btn = $('akanKbToggle');
    if (btn) btn.classList.toggle('active', !kp.hidden);
};

/** Open the အကန်ဒိုင် (outgoing) entry screen for a session. */
async function openAkandain(sessionId) {
    setActiveSession(sessionId);
    akanClearInputs();
    await renderAkandain();
    switchTab('akandain');
}

/** Refresh akandain screen: session label, bookie select, pending table. */
async function renderAkandain() {
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    $('akanSessionLabel').textContent = s ? sessionLabel(s) : 'Session မရှိပါ';

    await renderAkanBookieOptions();
    renderAkanTable();
}

/** Bookie dropdown options: prior OUTGOING (akan) bookies from all sessions,
 *  plus registered အကန်ဒိုင် persons. Native <select> — reliable on phones. */
async function renderAkanBookieOptions() {
    const sel = $('akanBookieSelect');
    const prev = sel.value;
    // Bookie suggestions: distinct bookie names from prior OUTGOING (akan) bets, all sessions,
    // plus registered အကန်ဒိုင် persons.
    const seen = new Set();
    const order = [];
    for (const sess of state.sessions) {
        const recs = await db.query('lottery_records', 'by_session', sess.id);
        for (const r of recs) {
            if (r.record_type !== 'akan') continue;
            const k = (r.player_name || r.agent_name || '').trim();
            if (k && !seen.has(k)) { seen.add(k); order.push(k); }
        }
    }
    for (const a of state.agents || []) {
        if ((a.person_type || 'agent') !== 'akan') continue;
        const k = (a.name || '').trim();
        if (k && !seen.has(k)) { seen.add(k); order.push(k); }
    }
    sel.innerHTML = '<option value="">-- အကန်ဒိုင်ရွေးရန် --</option>' +
        order.map((k) => '<option value="' + escHtml(k) + '">' + escHtml(k) + '</option>').join('');
    if (prev && order.includes(prev)) sel.value = prev;
}

/** Pending OUTGOING table + totals. */
function renderAkanTable() {
    const tbody = $('akanTableBody');
    const total = akanPending.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    $('akanTotal').textContent = formatMoney(total);
    $('akanCount').textContent = akanPending.length;
    if (!akanPending.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">စာရင်း မရှိသေးပါ။</td></tr>';
        return;
    }
    tbody.innerHTML = akanPending.map((e, i) =>
        '<tr>' +
            '<td class="cell-out">⬆️ ' + escHtml(e.player_name || '—') + '</td>' +
            '<td class="cell-no">' + escHtml(String(e.number)) + '</td>' +
            '<td class="cell-amt out-amt">' + formatMoney(e.amount) + '</td>' +
            '<td class="cell-del"><button class="rec-del" onclick="akanDeleteRow(' + i + ')" title="ဖျက်မည်">🗑️</button></td>' +
        '</tr>'
    ).join('');
}

window.akanDeleteRow = function akanDeleteRow(i) {
    akanPending.splice(i, 1);
    renderAkanTable();
};

/** ထည့်မည် — expand the number-box formula and add to the OUTGOING pending table. */
window.submitAkanRow = async function submitAkanRow() {
    const bookie = ($('akanBookieSelect').value || '').trim() || null;
    const noText = $('akanBoxNo').value.trim();
    const amtText = $('akanBoxAmt').value.trim().replace(/[^\d]/g, '');
    const revText = $('akanBoxRev').value.trim();

    if (!noText) { showToast('❌ ဂဏန်း (သို့) ဖော်မြူလာ ထည့်ပါ'); akanSetFocusBox('no'); return; }
    const mainAmt = parseInt(amtText, 10) || 0;
    if (mainAmt <= 0) { showToast('❌ ပမာဏ ထည့်ပါ'); akanSetFocusBox('amt'); return; }

    let line = noText + '=' + mainAmt;
    if (revText) {
        if (/^r$/i.test(revText)) line += 'r' + mainAmt;
        else {
            const revAmt = parseInt(revText.replace(/[^\d]/g, ''), 10) || 0;
            if (revAmt > 0) line += 'r' + revAmt;
        }
    }

    const { items, invalidLines } = parseBoardReport(line);
    const validItems = items.filter((it) => /^\d{2}$/.test(String(it.number)));
    if (!validItems.length) {
        showToast('❌ ဖော်မြူလာ မသိပါ (ဂဏန်း မှားနေတယ်)' + (invalidLines.length ? ': ' + invalidLines[0] : ''));
        return;
    }
    validItems.forEach((it) => {
        akanPending.push({ player_name: bookie, number: String(it.number), amount: it.amount, record_type: 'akan' });
    });
    akanClearInputs();
    renderAkanTable();
    const skipped = invalidLines.length + (items.length - validItems.length);
    showToast('✅ ထည့်ပြီးပြီ (အထွက်)' + (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : ''));
};

/** 💾 Save — persist all pending OUTGOING entries as NEW akan batches. */
window.saveAkanBatch = async function saveAkanBatch() {
    if (akanSaveInFlight) return;
    if (!akanPending.length) { showToast('စာရင်း မရှိသေးပါ'); return; }
    if (!state.activeSessionId) { showToast('⚠️ Session မရှိသေးပါ'); return; }

    akanSaveInFlight = true;
    try {
        // Group by bookie, preserving first-appearance order
        const order = [];
        const byKey = {};
        akanPending.forEach((e) => {
            const k = e.player_name || '';
            if (!byKey[k]) { byKey[k] = []; order.push(k); }
            byKey[k].push(e);
        });

        let count = 0;
        for (const k of order) {
            const batchNo = 'B' + Date.now().toString(36) + count.toString(36);
            for (const e of byKey[k]) {
                await createRecord('lottery_records', {
                    session: state.activeSessionId,
                    number: String(e.number).padStart(2, '0'),
                    amount: Number(e.amount) || 0,
                    agent_name: e.player_name || '',
                    player_name: e.player_name || '',
                    record_type: 'akan',
                    batch_no: batchNo,
                });
                count++;
            }
        }
        akanPending = [];
        renderAkanTable();
        showToast('✅ အထွက် သိမ်းပြီးပြီ');
        await loadSessions();
        renderSessions();
        renderLedger();
    } catch (e) {
        showToast('သိမ်းမရပါ: ' + e.message);
    } finally {
        akanSaveInFlight = false;
    }
};
