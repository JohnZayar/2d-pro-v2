/**
 * app.js — 2D Master Pro v2
 * Local-first: IndexedDB is the source of truth for the UI;
 * PocketBase syncs in the background.
 */
import * as db from '../shared/db.js';
import * as pb from '../shared/pb.js';
import * as sync from '../shared/sync.js?v=5';
import { parseBoard, parseBoardReport, parseLine } from '../shared/parser.js';
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
        } catch (e) {
            // Invalid token → must log in again. Network/tunnel down →
            // keep the local session (local-first, offline OK).
            if (e && (e.code === 401 || e.code === 403)) {
                console.warn('token invalid, need login');
                await pb.logout();
                showPage('page-login');
                return;
            }
            console.warn('refresh failed (offline?), continuing cached:', e.message);
            state.user = pb.getUser();
        }
        await enterApp();
        return;
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
            if (t) { $('boardText').value = t; renderBoardLineCheck(); }
        } catch (e) { showToast('Paste မရပါ — ကိုယ်တိုင်ထည့်ပါ'); }
    });
    $('boardText').addEventListener('input', () => renderBoardLineCheck());
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
    $('buyerCreateBtn').addEventListener('click', createBuyerAccount);
    const buyerRefreshBtn = $('buyerRefreshBtn');
    if (buyerRefreshBtn) buyerRefreshBtn.addEventListener('click', renderBuyerList);
    $('pwChangeBtn').addEventListener('click', changePassword);

    // vouchers / overlimit / akandain
    $('voucherSession').addEventListener('change', () => { state.voucherSessionId = $('voucherSession').value; renderVouchers(); });
    $('voucherPerson').addEventListener('change', renderVoucherContent);
    $('voucherCopyBtn').addEventListener('click', copyVoucher);
    $('voucherPrintBtn').addEventListener('click', printVoucher);
    $('homeDailyDate').addEventListener('change', (e) => { _homeDailyDate = e.target.value; renderHomeDaily(); });
    $('voucherShareBtn').addEventListener('click', shareVoucher);
    $('wkPrev').addEventListener('click', () => { state.weeklyOffset = (state.weeklyOffset || 0) - 1; renderWeekly(); });
    $('wkNext').addEventListener('click', () => { state.weeklyOffset = (state.weeklyOffset || 0) + 1; renderWeekly(); });
    $('overSession').addEventListener('change', () => { state.overSessionId = $('overSession').value; renderOverlimit(); });
    $('overCopyBtn').addEventListener('click', copyOverlimit);
    $('overToAkanBtn').addEventListener('click', sendOverToAkan);
    $('akanBookieSelect').addEventListener('change', () => {
        // When bookie selection changes, update all pending items to use the selected bookie
        const bookie = ($('akanBookieSelect').value || '').trim() || null;
        akanPending.forEach((e) => { e.player_name = bookie; });
        renderAkanTable();
    });
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
        // Block disabled buyers (suspended by admin for non-payment etc.)
        if (state.user.disabled) {
            await pb.logout();
            $('loginError').textContent = 'အကောင့် ပိတ်ထားပါတယ် — admin ကို ဆက်သွယ်ပါ';
            return;
        }
        // If different user from last session, clear local DB to prevent data leakage
        const lastUserId = localStorage.getItem('v2_last_user_id');
        if (lastUserId && lastUserId !== state.user.id) {
            try { indexedDB.deleteDatabase('2dProV2'); } catch (e) { /* ignore */ }
            // Wait a moment for deletion, then reload to reinitialize clean DB
            localStorage.setItem('v2_last_user_id', state.user.id);
            location.reload();
            return;
        }
        localStorage.setItem('v2_last_user_id', state.user.id);
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
    // Clear local DB — prevents next user from seeing previous user's cached data
    try {
        indexedDB.deleteDatabase('2dProV2');
    } catch (e) { /* ignore */ }
    location.reload();
}

/* ============ BUYER ACCOUNT CREATION (Option 2) ============ */
async function createBuyerAccount() {
    // Seller-only: buyers cannot create sub-buyers
    if (!state.user || state.user.email !== 'johnzyt7@gmail.com') {
        showToast('ခွင့်မရှိပါ');
        return;
    }
    const emailEl = $('buyerEmail');
    const shopEl = $('buyerShop');
    const resultEl = $('buyerResult');
    const btn = $('buyerCreateBtn');
    const email = (emailEl.value || '').trim().toLowerCase();
    const shopName = (shopEl.value || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        showToast('Email မှန်အောင်ရိုက်ပါ');
        return;
    }
    if (!shopName) {
        showToast('ဆိုင်နာမည် ရိုက်ပါ');
        return;
    }
    if (!pb.isLoggedIn() || !sync.isOnline()) {
        showToast('အင်တာနက် လိုတယ်');
        return;
    }
    btn.disabled = true;
    btn.textContent = 'လုပ်နေတယ်…';
    resultEl.style.display = 'none';
    try {
        // Generate temp password: 8 chars, letters + digits
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        let tmp = '';
        const rnd = new Uint8Array(8);
        crypto.getRandomValues(rnd);
        for (let i = 0; i < 8; i++) tmp += chars[rnd[i] % chars.length];
        // 1. Create tenant
        const tenant = await pb.create('tenants', { name: shopName });
        // 2. Create user linked to tenant
        // Note: verified/emailVisibility omitted — PocketBase restricts these on API create by non-admins
        await pb.create('users', {
            email: email,
            password: tmp,
            passwordConfirm: tmp,
            name: shopName,
            tenant: tenant.id
        });
        resultEl.style.display = '';
        resultEl.innerHTML =
            '<div style="background:#052e16;border:1px solid #16a34a;border-radius:8px;padding:10px;margin-top:8px">' +
            '<div style="color:#4ade80;font-weight:bold">✅ Buyer account ရပြီ</div>' +
            '<div class="mt">Email: <b>' + escHtml(email) + '</b></div>' +
            '<div>Temp password: <b style="font-size:16px;letter-spacing:1px">' + escHtml(tmp) + '</b></div>' +
            '<div class="small muted mt">Buyer ကို ပို့ပေးပါ — သူ Settings မှာ password ချိန်းရမယ်</div>' +
            '</div>';
        emailEl.value = '';
        shopEl.value = '';
        showToast('✅ Buyer ထုတ်ပြီးပြီ');
    } catch (e) {
        console.warn('buyer create failed', e);
        let msg = 'မရဘူး: ' + (e.message || 'error');
        if (/already|exists|unique/i.test(e.message || '')) msg = 'ဒီ email ရှိနေပြီးသား';
        showToast(msg);
    } finally {
        btn.disabled = false;
        btn.textContent = 'ထုတ်မယ်';
    }
}

async function renderBuyerList() {
    const box = $('buyerList');
    if (!box) return;
    box.innerHTML = '<div class="muted">တင်နေတယ်…</div>';
    try {
        // Fetch all users (seller-only API rule allows this)
        const users = await pb.list('users', { perPage: 100 });
        const buyers = (users.items || users).filter((u) => u.email !== 'johnzyt7@gmail.com');
        if (!buyers.length) {
            box.innerHTML = '<div class="muted">Buyer မရှိသေးပါ</div>';
            return;
        }
        let html = '<table class="v-table"><thead><tr><th>Email</th><th>ဆိုင်</th><th>အခြေအနေ</th><th></th></tr></thead><tbody>';
        for (const b of buyers) {
            const disabled = !!b.disabled;
            html += '<tr>' +
                '<td>' + escHtml(b.email) + '</td>' +
                '<td>' + escHtml(b.name || '') + '</td>' +
                '<td>' + (disabled ? '<span style="color:#ef4444">🔴 ပိတ်</span>' : '<span style="color:#4ade80">🟢 ဖွင့်</span>') + '</td>' +
                '<td><button class="btn small ' + (disabled ? 'gray' : 'red') + '" onclick="toggleBuyerDisabled(\'' + b.id + '\',' + (!disabled) + ')">' + (disabled ? 'ဖွင့်' : 'ပိတ်') + '</button></td>' +
                '</tr>';
        }
        html += '</tbody></table>';
        box.innerHTML = html;
    } catch (e) {
        box.innerHTML = '<div class="muted">မရဘူး: ' + escHtml(e.message || 'error') + '</div>';
    }
}

window.toggleBuyerDisabled = async function toggleBuyerDisabled(userId, disable) {
    const action = disable ? 'ပိတ်' : 'ဖွင့်';
    if (!confirm('ဒီ buyer ကို ' + action + 'မလား?')) return;
    try {
        await pb.update('users', userId, { disabled: disable });
        showToast(disable ? '🔴 ပိတ်ပြီးပြီ' : '🟢 ဖွင့်ပြီးပြီ');
        renderBuyerList();
    } catch (e) {
        showToast('❌ ' + (e.message || 'error'));
    }
}

/* ============ PASSWORD CHANGE ============ */
async function changePassword() {
    const oldEl = $('pwOld'), newEl = $('pwNew'), new2El = $('pwNew2');
    const btn = $('pwChangeBtn');
    const oldPw = oldEl.value, newPw = newEl.value, newPw2 = new2El.value;
    if (!oldPw || !newPw || !newPw2) { showToast('အကုန်ဖြည့်ပါ'); return; }
    if (newPw.length < 8) { showToast('အသစ် ၈ လုံးအထက် ဖြစ်ရမယ်'); return; }
    if (newPw !== newPw2) { showToast('အသစ် ၂ ခု မတူဘူး'); return; }
    if (!state.user || !state.user.id) { showToast('ဝင်မထားဘူး'); return; }
    btn.disabled = true;
    btn.textContent = 'ချိန်းနေတယ်…';
    try {
        await pb.update('users', state.user.id, {
            oldPassword: oldPw,
            password: newPw,
            passwordConfirm: newPw2
        });
        oldEl.value = ''; newEl.value = ''; new2El.value = '';
        showToast('✅ Password ချိန်းပြီးပြီ');
    } catch (e) {
        console.warn('password change failed', e);
        showToast('မရဘူး: ' + (e.message || 'error'));
    } finally {
        btn.disabled = false;
        btn.textContent = 'ချိန်းမယ်';
    }
}

async function enterApp() {
    // Show loading while we sync — ensures data is present on first login
    // (fixes the "login twice" issue where empty local DB rendered before sync)
    showPage('page-main');
    const sessionList = $('sessionList');
    if (sessionList) sessionList.innerHTML = '<div class="empty">⏳ တင်နေတယ်… ခနစောင့်ပါ</div>';
    updateSyncPill('busy', '⏳ Sync…');
    // Sync FIRST (blocking) — then render with real data
    try {
        await ensureTenant();
        await fullSync();
        // Repair `created` timestamps wiped by old sync pulls (background)
        sync.repairMissingCreated().catch(() => {});
        // Clean up old data (records >2 weeks, winnings >10 weeks)
        await cleanupOldRecords();
        await cleanupOldWinnings();
    } catch (e) {
        console.warn('Initial sync failed:', e.message);
    }
    // Load local data (now populated from sync)
    await loadSessions();
    await loadAgents();
    await loadSettingsIntoUI();
    renderSessions();
    renderAgents();
    if (state.activeSessionId) renderLedger();
    updateSyncPill();
    // background sync every 45s + on reconnect
    clearInterval(state.syncTimer);
    state.syncTimer = setInterval(() => { if (pb.isLoggedIn()) fullSync(); }, 45000);
    window.addEventListener('online', () => fullSync());
    // Web Share Target: Viber → Share → 2D Master lands the text here.
    handleSharedText();
    // Reminders: session-close countdown + winning-number nudge, every 30s.
    clearInterval(state.remindTimer);
    updateReminders().catch(() => {});
    state.remindTimer = setInterval(() => { updateReminders().catch(() => {}); }, 30000);
}

/**
 * If the app was opened via Web Share Target (e.g. Viber message shared),
 * open the digital board with the shared text pre-filled.
 */
function handleSharedText() {
    let text = '';
    try { text = new URLSearchParams(location.search).get('text') || ''; } catch (e) {}
    if (!text.trim()) return;
    // Clean the URL so a refresh doesn't re-trigger.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    const sid = state.activeSessionId || (state.sessions[0] && state.sessions[0].id);
    if (!sid) { showToast('⚠️ Session အရင် ဖွင့်ပါ'); return; }
    openBoard(sid);
    const ta = $('boardText');
    if (ta) {
        ta.value = text.trim();
        renderBoardLineCheck();
        showToast('📋 Viber စာရင်း ထည့်ပြီးပြီ — စစ်ပြီး သိမ်းပါ');
    }
}

/* ================= REMINDERS ================= */
// Session-close countdown + winning-number nudge. Runs every 30s while the app is open.
const _remindState = { warned: {} };

async function updateReminders() {
    const bar = $('reminderBar');
    if (!bar) return;
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const todayStr = `${dd}.${mm}.${now.getFullYear()}`;
    let html = '', cls = '', tap = null;

    for (const s of state.sessions) {
        if (!s || s.date !== todayStr || s.closed) continue;
        const isAM = (s.timeType || '') === 'မနက်ပိုင်း';
        const [hh, mi] = isAM ? [11, 55] : [15, 55];
        const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mi, 0);
        let wins = [];
        try { wins = await db.query('winning_numbers', 'by_session', s.id) || []; } catch (e) {}
        const hasWin = wins.length > 0;
        const msLeft = cutoff.getTime() - now.getTime();
        const label = sessionLabel(s);

        if (!hasWin && msLeft > 0 && msLeft <= 15 * 60 * 1000) {
            // ⏰ closing soon — countdown
            const mins = Math.max(1, Math.ceil(msLeft / 60000));
            html = `⏰ ${mins} မိနစ် အလို — ${escHtml(label)} ပိတ်တော့မယ်`;
            cls = 'warn';
            if (!_remindState.warned[s.id]) {
                _remindState.warned[s.id] = true;
                try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
            }
            break;
        }
        if (!hasWin && msLeft <= 0) {
            // 🏆 closed but no winning number yet — nudge to enter it
            html = `🏆 ပေါက်သီး ထည့်ပါ — ${escHtml(label)}`;
            cls = 'win';
            tap = () => switchTab('winning');
            break;
        }
    }

    if (html) {
        bar.className = 'reminder-bar ' + cls;
        bar.innerHTML = html;
        bar.style.display = '';
        bar.onclick = tap || (() => {});
    } else {
        bar.style.display = 'none';
        bar.onclick = null;
    }
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

/** Create: save locally + queue. Immediate server sync ONLY for sessions (need server ID for refs).
 *  Records save instantly to phone — background sync pushes to server without blocking. */
async function createRecord(collection, data) {
    const obj = Object.assign({ id: uid(), _updated: Date.now() }, data);
    obj.tenant = state.tenantPbId;
    await db.put(collection, obj);

    // Sessions need immediate server ID (records reference it) — keep blocking sync here.
    // All other collections (lottery_records etc.) go through background queue only → instant save.
    if (collection === 'sessions' && pb.isLoggedIn() && sync.isOnline()) {
        try {
            const created = await pb.create(collection, serverPayload(obj));
            const oldId = obj.id;
            obj.id = created.id;
            obj._pbId = created.id;
            obj._updated = Date.now();
            await db.del(collection, oldId);
            await db.put(collection, obj);
            await remapSessionRefs(oldId, created.id);
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
    // Buyer creation: only Pho (seller) can see it — buyers cannot create sub-buyers
    const buyerCard = $('buyerCard');
    const buyerListCard = $('buyerListCard');
    const isSeller = state.user && state.user.email === 'johnzyt7@gmail.com';
    if (buyerCard) {
        buyerCard.style.display = isSeller ? '' : 'none';
    }
    if (buyerListCard) {
        buyerListCard.style.display = isSeller ? '' : 'none';
        if (isSeller) renderBuyerList();
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
    if (name === 'daily') renderHomeDaily();
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
                <button class="btn small ${s.closed ? 'gray' : 'red'}" data-act="toggleclose" data-id="${s.id}">${s.closed ? '🔓 ဖွင့်' : '🔴 ပိတ်'}</button>
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
    else if (act === 'toggleclose') toggleSessionClose(id);
    else if (act === 'del') deleteSession(id);
}

async function toggleSessionClose(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    const newClosed = !s.closed;
    const action = newClosed ? 'ပိတ်' : 'ဖွင့်';
    if (!confirm(`ဒီပွဲကို ${action}မလား?`)) return;
    try {
        await sync.mutate('update', 'sessions', Object.assign({}, s, { closed: newClosed }));
        s.closed = newClosed;
        showToast(newClosed ? '🔴 ပိတ်ပြီးပြီ' : '🔓 ဖွင့်ပြီးပြီ');
        renderSessions();
    } catch (e) {
        showToast('❌ ' + e.message);
    }
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
    // NOTE: lottery_records are KEPT for Daily/Weekly history (2 weeks)
    // They are auto-deleted when older than 2 weeks (see cleanupOldRecords)
    // NOTE: winning_numbers are KEPT for ကျန်ဂဏန်း (10-week history)
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
    renderBoardLineCheck();
    openModal('modal-board');
    // Auto-paste: Viber က ကူးထားတဲ့ စာရင်း ရှိ ရင် တန်း ထည့် (Paste နှိပ် စရာ မ လို)
    try {
        const clip = await navigator.clipboard.readText();
        if (clip && clip.trim()) {
            $('boardText').value = clip.trim();
            renderBoardLineCheck();
            showToast('📋 ကူးထားတဲ့ စာရင်း ထည့်ပြီးပြီ');
        }
    } catch (e) { /* clipboard blocked — Paste ခလုတ် သုံး */ }
    setTimeout(() => $('boardText').focus(), 300);
}

/** Strict per-line check: parse must succeed AND every number must be 2-digit. Never guesses. */
function boardLineOk(line) {
    let parsed = [];
    try { parsed = parseLine(line); } catch (e) { parsed = []; }
    return parsed.length > 0 && parsed.every((p) => /^\d{2}$/.test(String(p.number)));
}

/** Per-line formula check: small ✅/❌ per line, subtle styling. Never guesses. */
function renderBoardLineCheck() {
    const ta = $('boardText');
    const box = $('boardLineCheck');
    if (!ta || !box) return 0;
    const text = ta.value;
    if (!text.trim()) { box.innerHTML = ''; box.style.display = 'none'; return 0; }
    let html = '';
    let bad = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const ok = boardLineOk(line);
        if (!ok) bad++;
        html += `<div class="bline ${ok ? 'ok' : 'bad'}"><span class="mk">${ok ? '✅' : '❌'}</span><span class="tx">${escHtml(line)}</span></div>`;
    }
    box.innerHTML = html;
    box.style.display = '';
    return bad;
}

async function saveBoard() {
    const sessionId0 = state.boardSessionId;
    const lk0 = await isSessionLocked(sessionId0);
    if (lk0.locked) { showToast('🔒 ' + lk0.reason + ' — ထည့် မရပါ'); return; }
    const text = $('boardText').value;
    // Strict per-line: only fully-valid lines are entered. Bad lines stay on
    // the board for fixing — never guess-entered.
    const okItems = [];
    const badLines = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (!boardLineOk(line)) { badLines.push(line); continue; }
        let parsed = [];
        try { parsed = parseLine(line); } catch (e) { parsed = []; }
        for (const p of parsed) okItems.push(p);
    }
    if (!okItems.length) { showToast('ထည့်တာ မမှန်ပါ — စစ်ပါ'); return; }
    const sessionId = state.boardSessionId;

    // Keep bad lines on the board for fixing (small ❌ list stays visible).
    const keepBadOpen = () => {
        $('boardText').value = badLines.join('\n');
        renderBoardLineCheck();
    };

    // အကန်ဒိုင် mode → rows land in the OUTGOING pending table, not the entry table.
    if (state.boardMode === 'akan') {
        const bookie = (($('akanBookieSelect') && $('akanBookieSelect').value) || '').trim() || null;
        okItems.forEach((it) => {
            akanPending.push({
                player_name: bookie,
                number: String(it.number).padStart(2, '0'),
                amount: Number(it.amount) || 0,
                record_type: 'akan',
            });
        });
        if (badLines.length) {
            keepBadOpen();
            showToast('✅ ' + okItems.length + ' ကွက် ထည့်ပြီးပြီ (အထွက်) · ❌ ' + badLines.length + ' လိုင်း ကျန် — ပြင်ပြီး Save ပြန်နှိပ်');
            return;
        }
        showToast('✅ ' + okItems.length + ' ကွက် ထည့်ပြီးပြီ (အထွက်)');
        closeModal('modal-board');
        await openAkandain(sessionId);
        return;
    }

    const target = $('boardTarget').value;
    const agent = state.agents.find((a) => a.id === target);
    const personName = agent ? agent.name : '';

    // 🚫 ဒိုင်ပိတ်: blocked numbers cannot be bet (incoming only)
    const blockedSet2 = new Set(getBlocked(sessionId));
    const blockedHit2 = [];
    const allowedBoard = okItems.filter((it) => {
        const nn = String(it.number).padStart(2, '0');
        if (blockedSet2.has(nn)) { blockedHit2.push(nn); return false; }
        return true;
    });
    if (blockedHit2.length) showToast('🚫 ဒိုင်ပိတ်: ' + [...new Set(blockedHit2)].join(', ') + ' — တင် မရပါ');
    allowedBoard.forEach((it) => {
        entryPending.push({
            player_name: personName || null,
            number: String(it.number).padStart(2, '0'),
            amount: Number(it.amount) || 0,
            record_type: 'pos', // entry board is incoming-only
        });
    });
    if (badLines.length) {
        keepBadOpen();
        showToast('✅ ' + allowedBoard.length + ' ကွက် ထည့်ပြီးပြီ · ❌ ' + badLines.length + ' လိုင်း ကျန် — ပြင်ပြီး Save ပြန်နှိပ်');
        return;
    }
    showToast('✅ ' + allowedBoard.length + ' ကွက် ထည့်ပြီးပြီ');
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

    // ONLY registered people — unregistered names are BLOCKED entirely
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

/** Session lock: betting closes at 11:55 (AM) / 15:05 (PM) on session date;
    and locks entirely once winning numbers are entered. */
async function isSessionLocked(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (!s) return { locked: false };
    // manually closed by bookie → locked
    if (s.closed) return { locked: true, reason: 'ဒိုင်က ပိတ်လိုက်ပြီ' };
    // winning numbers entered → locked
    const wins = await db.query('winning_numbers', 'by_session', sessionId);
    if (wins && wins.length) return { locked: true, reason: 'ပေါက်ဂဏန်း ထည့်ပြီးပြီ' };
    // cutoff time
    if (s.date) {
        const isAM = (s.timeType || '') === 'မနက်ပိုင်း';
        const [hh, mm] = isAM ? [11, 55] : [15, 55];
        // s.date is DD.MM.YYYY — parse properly (new Date("08.10.2026T11:55:00") is Invalid)
        const parts = String(s.date).split('.');
        let cutoff;
        if (parts.length === 3) {
            cutoff = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]), hh, mm, 0);
        } else {
            cutoff = new Date(s.date + `T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
        }
        if (!isNaN(cutoff.getTime()) && new Date() > cutoff) return { locked: true, reason: 'ထိုးခွင့် ပိတ်ပြီ' };
    }
    return { locked: false };
}

/** ထည့်မည် — expand the number-box formula and add to the PENDING table. */
window.submitEntryRow = async function submitEntryRow() {
    const lk = await isSessionLocked(state.activeSessionId);
    if (lk.locked) { showToast('🔒 ' + lk.reason + ' — ပြင်/ထည့် မရပါ'); return; }
    const playerName = $('entryPlayerSelect').value || null;
    if (!playerName) { showToast('❌ အမည် စာရင်း သွင်းထားမှ ရမယ် — အရင် လူ စာရင်း သွင်းပါ'); return; }
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
    // 🚫 ဒိုင်ပိတ်: blocked numbers cannot be bet
    const blockedSet = new Set(getBlocked(state.activeSessionId));
    const blockedHit = [];
    const allowedItems = validItems.filter((it) => {
        const nn = String(it.number).padStart(2, '0');
        if (blockedSet.has(nn)) { blockedHit.push(nn); return false; }
        return true;
    });
    if (!allowedItems.length) { entryClearInputs(); showToast('🚫 ဒိုင်ပိတ် ဂဏန်းတွေ ချည်း — တင် မရပါ'); return; }
    allowedItems.forEach((it) => {
        entryPending.push({ player_name: playerName, number: String(it.number), amount: it.amount, record_type: rType });
    });
    entryClearInputs();
    renderEntryTable();
    const skipped = invalidLines.length + (items.length - validItems.length) + blockedHit.length;
    const blkMsg = blockedHit.length ? ' (🚫 ' + [...new Set(blockedHit)].join(',') + ' ပိတ်)' : '';
    showToast(rType === 'akan' ? '✅ ထည့်ပြီးပြီ (⬆️ အထွက်)' : '✅ ထည့်ပြီးပြီ' + (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : '') + blkMsg);
};

/** 💾 Save — persist all pending entries as NEW batches (one batch_no per person/type). */
window.saveEntryBatch = async function saveEntryBatch() {
    if (entrySaveInFlight) return;
    if (!entryPending.length) { showToast('စာရင်း မရှိသေးပါ'); return; }
    if (!state.activeSessionId) { showToast('⚠️ Session မရှိသေးပါ'); return; }
    const lk = await isSessionLocked(state.activeSessionId);
    if (lk.locked) { showToast('🔒 ' + lk.reason + ' — သိမ်း မရပါ'); return; }

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
                const sess = state.sessions.find((x) => x.id === state.activeSessionId);
                await createRecord('lottery_records', {
                    session: state.activeSessionId,
                    session_date: sess ? sess.date : null,
                    session_timeType: sess ? sess.timeType : null,
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

let _ledgerPerson = '__all'; // '__all' or voucherPersonKey

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

    // person filter list (grouped: agent-synced under agent name)
    const persons = [];
    const seen = new Set();
    for (const r of recs) {
        const k = voucherPersonKey(r) || '(အမည် မရှိ)';
        if (!seen.has(k)) { seen.add(k); persons.push(k); }
    }
    persons.sort();

    // filter by selected person
    const filtered = _ledgerPerson === '__all'
        ? recs
        : recs.filter((r) => (voucherPersonKey(r) || '(အမည် မရှိ)') === _ledgerPerson);

    // aggregate pos - akan
    const agg = {};
    for (const r of filtered) {
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
    const personOpts = `<option value="__all">👥 All</option>` +
        persons.map((p) => `<option value="${escHtml(p)}"${p === _ledgerPerson ? ' selected' : ''}>${escHtml(voucherPersonLabel(p))}</option>`).join('');
    head.innerHTML = `<div class="card"><div class="row"><b>${escHtml(sessionLabel(s))}</b>
        <select id="ledgerPersonSel" class="input" style="max-width:160px">${personOpts}</select>
        <button class="btn small" id="ledgerBoardBtn">📝 ထိုးကွက်</button></div></div>`;
    $('ledgerBoardBtn').addEventListener('click', () => openEntry(s.id));
    $('ledgerPersonSel').addEventListener('change', (e) => {
        _ledgerPerson = e.target.value;
        renderLedger();
    });
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

/* ================= HOME DAILY — whole day (morning + evening) ================= */

let _homeDailyDate = null;

async function dailySessionAgg(sessionId) {
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    const wins = await db.query('winning_numbers', 'by_session', sessionId);
    const winNum = wins.length ? String(wins[0].number).padStart(2, '0') : null;
    return dailyAggFromRecords(recs, winNum);
}

/** Aggregate daily stats from a list of records (for persistent history). */
function dailyAggFromRecords(recs, winNum) {
    const per = {};
    const pLabel = {};
    for (const r of recs) {
        const isAkan = r.record_type === 'akan';
        const pkey = voucherPersonKey(r) || '(အမည် မရှိ)';
        const key = (isAkan ? 'akan:' : 'pos:') + pkey;
        if (!per[key]) { per[key] = { bet: 0, win: 0, winDeduct: 0, isAkan }; pLabel[key] = voucherPersonLabel(pkey); }
        const amt = Number(r.amount) || 0;
        per[key].bet += isAkan ? -amt : amt;
        if (winNum && String(r.number).padStart(2, '0') === winNum) {
            per[key].win += amt;
            const ag0 = state.agents.find((a) => a.name === pLabel[key]);
            const payout = ag0 ? (Number(ag0.payout_rate) || 80) : 80;
            per[key].winDeduct += amt * payout;
        }
    }
    let rows = '', tBet = 0, tWin = 0, tNet = 0;
    for (const [key, v] of Object.entries(per)) {
        const label = pLabel[key];
        const ag = state.agents.find((a) => a.name === label);
        const comm = ag ? (Number(ag.commission) || 0) : 0;
        const commAmt = Math.round(v.bet * comm / 100);
        const net = v.isAkan ? v.bet - commAmt + v.winDeduct : v.bet - commAmt - v.winDeduct;
        tBet += v.bet; tWin += v.win; tNet += net;
        const nameHtml = v.isAkan
            ? `<span style="color:var(--red);font-weight:700">⬆️ ${escHtml(label)}</span>`
            : escHtml(label);
        rows += `<tr><td>${nameHtml}</td><td>${formatMoney(v.bet)}</td><td>${formatMoney(v.win)}</td><td>${formatMoney(net)}</td></tr>`;
    }
    return { rows, tBet, tWin, tNet, winNum };
}

async function renderHomeDaily() {
    const dateInput = $('homeDailyDate');
    if (!_homeDailyDate) {
        const today = new Date();
        _homeDailyDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    }
    if (dateInput && !dateInput.value) dateInput.value = _homeDailyDate;

    const [y, m, d] = _homeDailyDate.split('-');
    const ds = `${d}.${m}.${y}`; // match session.date format DD.MM.YYYY

    // Get ALL records for this date (works even after session deletion)
    const allRecs = await db.getAll('lottery_records');
    const dayRecs = allRecs.filter((r) => {
        // New records have session_date; old records: look up via session
        if (r.session_date) return r.session_date === ds;
        const sess = state.sessions.find((s) => s.id === r.session);
        return sess && sess.date === ds;
    });

    // Get winning numbers for this date
    const allWins = await db.getAll('winning_numbers');
    const dayWins = {};
    for (const w of allWins) {
        const sess = state.sessions.find((s) => s.id === w.session);
        const wDate = sess ? sess.date : null;
        // Also check if winning number record has date info
        if (wDate === ds) {
            const tt = sess.timeType || '';
            dayWins[tt] = String(w.number).padStart(2, '0');
        }
    }

    let html = '';
    let gBet = 0, gWin = 0, gNet = 0;

    for (const [timeType, title] of [['မနက်ပိုင်း', '🌅 မနက်ပိုင်း'], ['ညနေပိုင်း', '🌇 ညနေပိုင်း']]) {
        const sessRecs = dayRecs.filter((r) => {
            if (r.session_timeType) return r.session_timeType === timeType;
            const sess = state.sessions.find((s) => s.id === r.session);
            return sess && (sess.timeType || '') === timeType;
        });
        if (!sessRecs.length) {
            html += `<div class="muted small" style="margin:8px 0"><b>${title}</b> — ပွဲ မရှိပါ</div>`;
            continue;
        }
        const winNum = dayWins[timeType] || null;
        const agg = dailyAggFromRecords(sessRecs, winNum);
        gBet += agg.tBet; gWin += agg.tWin; gNet += agg.tNet;
        html += `<div style="font-weight:700;margin:10px 0 6px"><b>${title}</b> ${agg.winNum ? `· 🏆 <b style="color:var(--green)">${agg.winNum}</b>` : ''}</div>
        <table class="data"><tr><th>ထိုးသား</th><th>ထိုးငွေ</th><th>ပေါက်</th><th>ကျန်</th></tr>
        ${agg.rows || '<tr><td colspan="4" class="muted">မှတ်တမ်း မရှိ</td></tr>'}
        </table>`;
    }

    html += `<div class="card" style="margin-top:10px"><div style="font-weight:700;margin-bottom:6px">📊 တစ်နေ့ကုန် အချုပ်</div>
        <table class="data">
        <tr><td>ထိုးငွေ စုစုပေါင်း</td><td style="text-align:right">${formatMoney(gBet)}</td></tr>
        <tr><td>ပေါက် စုစုပေါင်း</td><td style="text-align:right">${formatMoney(gWin)}</td></tr>
        <tr class="total"><td>ကျန်</td><td style="text-align:right">${(gNet < 0 ? '−' : '+') + formatMoney(Math.abs(gNet))}</td></tr>
        </table></div>`;

    $('homeDailyBody').innerHTML = html;
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
    state.weeklyMonday = days[0].ds;
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

    // apply manual overrides
    for (const r of rows) {
        const e = r.e;
        for (let di = 0; di < 5; di++) {
            for (const ampm of ['am', 'pm']) {
                const ci = di * 2 + (ampm === 'am' ? 0 : 1);
                const c = r.cells[ci];
                if (!c) continue;
                const key = `woverride_${state.weeklyMonday}_${e.pkey}_${days[di].ds}_${ampm}`;
                const ov = await getSetting(key, null);
                if (ov) {
                    const ag = state.agents.find((a) => a.name === e.label);
                    const comm = ag ? (Number(ag.commission) || 0) : 0;
                    const payout = ag ? (Number(ag.payout_rate) || 80) : 80;
                    const bet = Number(ov.bet) || 0;
                    const win = Number(ov.win) || 0;
                    const winDeduct = win * payout;
                    const commAmt = Math.round(bet * comm / 100);
                    const net = e.isAkan ? bet - commAmt + winDeduct : bet - commAmt - winDeduct;
                    dayTotals[di][ampm] += (net - c.net);
                    grandTotal += (net - c.net);
                    r.rowTotal += (net - c.net);
                    r.cells[ci] = { bet, win, net, overridden: true };
                }
            }
        }
    }

    // akan (red) rows always at the bottom
    rows.sort((a, b) => (a.e.isAkan ? 1 : 0) - (b.e.isAkan ? 1 : 0));

    const signMoney = (n) => {
        const v = Math.round(n * 10) / 10;
        const cls = v < 0 ? 'wneg' : (v > 0 ? 'wpos' : '');
        return `<span class="${cls}">${(v < 0 ? '−' : '+') + formatMoney(Math.abs(v))}</span>`;
    };
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
            const ovMark = c && c.overridden ? ' ✏️' : '';
            html += c ? `<td${cellAttr}>${formatMoney(c.bet)} / ${formatMoney(c.win)}${ovMark}</td>` : '<td class="muted">-</td>';
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
                const rri = Number(ri), ddi = Number(di);
                const ci = ddi * 2 + (ampm === 'am' ? 0 : 1);
                openWeeklyCell(_weeklyRows[rri], _weeklyDays[ddi], ampm, _weeklyRows[rri].cells[ci]);
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

async function openWeeklyCell(row, day, ampm, cellData) {
    const e = row.e;
    const key = `woverride_${state.weeklyMonday}_${e.pkey}_${day.ds}_${ampm}`;
    const ov = await getSetting(key, null);
    const curBet = ov ? ov.bet : cellData.bet;
    const curWin = ov ? ov.win : cellData.win;
    let html = `<div style="font-weight:700;margin-bottom:8px">${escHtml(e.label)} (${ampm === 'am' ? 'နံနက်' : 'ညနေ'}) — ${escHtml(day.name)}</div>`;
    html += `<div style="margin-bottom:8px;color:var(--muted)">လက်ရှိ: ${formatMoney(curBet)} / ${formatMoney(curWin)}${ov ? ' (ပြင်ထားပြီး)' : ''}</div>`;
    html += `<div class="field"><label>ထိုးငွေ ပေါင်း ပြင်ရန်</label><input id="wcorrBet" type="number" inputmode="numeric" value="${curBet}"></div>`;
    html += `<div class="field"><label>ပေါက် ပြင်ရန်</label><input id="wcorrWin" type="number" inputmode="numeric" value="${curWin}"></div>`;
    html += `<button class="btn block green" id="wcorrSave">သိမ်းမည်</button>`;
    if (ov) html += `<button class="btn block" id="wcorrClear" style="margin-top:8px">မူလ အတိုင်း ပြန်ထား</button>`;
    $('wcellBody').innerHTML = html;
    openModal('modal-wcell');
    $('wcorrSave').addEventListener('click', async () => {
        const b = Number($('wcorrBet').value) || 0;
        const w = Number($('wcorrWin').value) || 0;
        await setSetting(key, { bet: b, win: w });
        closeModal('modal-wcell');
        renderWeekly();
        showToast('ပြင်ပြီးပြီ');
    });
    const clr = $('wcorrClear');
    if (clr) clr.addEventListener('click', async () => {
        await setSetting(key, null);
        closeModal('modal-wcell');
        renderWeekly();
        showToast('မူလ အတိုင်း ပြန်ထားပြီ');
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

// Auto-delete lottery records older than 2 weeks (for Daily/Weekly history)
async function cleanupOldRecords() {
    try {
        const all = await db.getAll('lottery_records');
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        for (const r of all) {
            let rDate = null;
            if (r.session_date) {
                // DD.MM.YYYY format
                const [d, m, y] = r.session_date.split('.').map(Number);
                rDate = new Date(y, m - 1, d);
            } else if (r.created) {
                rDate = new Date(r.created);
            }
            if (rDate && rDate < twoWeeksAgo) {
                await deleteRecord('lottery_records', r);
            }
        }
    } catch (e) { console.warn('cleanupOldRecords failed:', e.message); }
}

// Auto-delete winning numbers older than 10 weeks
async function cleanupOldWinnings() {
    try {
        const all = await db.getAll('winning_numbers');
        const tenWeeksAgo = new Date();
        tenWeeksAgo.setDate(tenWeeksAgo.getDate() - 70);
        const cutoffStr = tenWeeksAgo.toISOString().split('T')[0];
        for (const w of all) {
            const wDate = w.week_monday || (w.created ? new Date(w.created).toISOString().split('T')[0] : null);
            if (wDate && wDate < cutoffStr) {
                await deleteRecord('winning_numbers', w);
            }
        }
    } catch (e) { console.warn('cleanupOldWinnings failed:', e.message); }
}

async function openRemaining() {
    await cleanupOldWinnings();

    const all = await db.query('winning_numbers', 'by_tenant', state.tenantPbId);
    const local = await db.getAll('winning_numbers');
    const map = new Map();
    for (const w of all.concat(local)) if (!map.has(w.id)) map.set(w.id, w);
    const wins = Array.from(map.values());

    if (!wins.length) {
        openGeneric('🔢 ကျန်ဂဏန်း', '<div class="empty">ပေါက်သီး မှတ်တမ်း မရှိသေးပါ</div>');
        return;
    }

    // Group by date: get session date for each winning number
    const byDate = {};
    for (const w of wins) {
        const sess = state.sessions.find((s) => s.id === w.session);
        if (!sess || !sess.date) continue;
        const dateKey = sess.date;
        if (!byDate[dateKey]) byDate[dateKey] = { am: null, pm: null };
        const isAM = (sess.timeType || '') === 'မနက်ပိုင်း';
        const num = String(w.number).padStart(2, '0');
        if (isAM) byDate[dateKey].am = num;
        else byDate[dateKey].pm = num;
    }

    const sortedDates = Object.keys(byDate).sort((a, b) => {
        const [da, ma, ya] = a.split('.').map(Number);
        const [db, mb, yb] = b.split('.').map(Number);
        return new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da);
    });

    if (!sortedDates.length) {
        openGeneric('🔢 ကျန်ဂဏန်း', '<div class="empty">ပေါက်သီး မှတ်တမ်း မရှိသေးပါ</div>');
        return;
    }

    const dayNames = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];
    let html = '';
    const allNums = [];
    for (const dateKey of sortedDates.slice(0, 70)) {
        const d = byDate[dateKey];
        if (!d.am && !d.pm) continue;
        const [dd, mm, yy] = dateKey.split('.').map(Number);
        const dayName = dayNames[new Date(yy, mm - 1, dd).getDay()];
        if (d.am) allNums.push(d.am);
        if (d.pm) allNums.push(d.pm);
        html += `<div class="dayline">${dayName} Am ${d.am || '--'} Pm ${d.pm || '--'}</div>`;
    }

    const rem = remainingDigits(allNums);
    html += `<div class="small muted" style="margin:6px 0">ကျန်ဂဏန်း (${rem.length})</div>
        <div class="digit-chips">${rem.map((d) => `<span class="dchip">${d}</span>`).join('')}</div>`;

    openGeneric('🔢 ကျန်ဂဏန်း (၁၀ ပတ်)', `<div class="digit-week card">${html}</div>`);
}

/* ================= ⚖️ ကြီးငယ် (BIG / SMALL) ================= */

async function openBigSmall(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const recs = await db.query('lottery_records', 'by_session', sessionId);
    // per-person (including akan bookies), first-appearance order — same as vouchers
    const order = [];
    const seen = {};
    recs.forEach((r) => {
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
        const prs = recs.filter((r) => voucherPersonKey(r) === sel);
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
            .sort((x, y) => y.a - x.a); // by AMOUNT desc: largest to smallest
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
        if (Array.isArray(arr) && arr.length) return arr.filter((n) => /^\d{2}$/.test(n));
    } catch (e) {}
    // fallback to PocketBase-synced field
    try {
        const s = state.sessions.find((x) => x.id === sessionId);
        if (s && s.blocked_numbers) {
            const arr2 = JSON.parse(s.blocked_numbers);
            if (Array.isArray(arr2)) return arr2.filter((n) => /^\d{2}$/.test(n));
        }
    } catch (e) {}
    return [];
}

async function setBlocked(sessionId, arr) {
    const clean = Array.from(new Set(arr.map((n) => String(n).padStart(2, '0'))))
        .filter((n) => /^\d{2}$/.test(n)).sort();
    localStorage.setItem(blockedKey(sessionId), JSON.stringify(clean));
    // sync to PocketBase so Agent can also block
    const s = state.sessions.find((x) => x.id === sessionId);
    if (s) {
        s.blocked_numbers = JSON.stringify(clean);
        s._updated = Date.now();
        try { await updateRecord('sessions', s); } catch (e) { console.warn('blocked sync failed', e); }
    }
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
    const wins = await db.query('winning_numbers', 'by_session', sessionId);
    const winNum = wins.length ? String(wins[0].number).padStart(2, '0') : null;

    // per-person: incoming and akan, grouped by voucherPersonKey (agent grouped)
    // Akan amounts are SUBTRACTED (Pho pays out to hedge bookies)
    const per = {};
    let tBet = 0, tWin = 0;
    for (const r of recs) {
        const isAkan = r.record_type === 'akan';
        const pkey = voucherPersonKey(r) || '(အမည် မရှိ)';
        if (!per[pkey]) per[pkey] = { bet: 0, win: 0, isAkan };
        const amt = Number(r.amount) || 0;
        const signedAmt = isAkan ? -amt : amt;
        per[pkey].bet += signedAmt;
        tBet += signedAmt;
        if (winNum && String(r.number).padStart(2, '0') === winNum) {
            per[pkey].win += signedAmt;
            tWin += signedAmt;
        }
    }
    let rows = '';
    for (const [name, v] of Object.entries(per)) {
        rows += `<tr><td>${v.isAkan ? '⬆️ ' : ''}${escHtml(voucherPersonLabel(name))}</td><td>${formatMoney(v.bet)}</td><td>${formatMoney(v.win)}</td></tr>`;
    }
    const html = `
        <div class="muted small" style="margin-bottom:8px">${escHtml(s ? sessionLabel(s) : '')}
        ${winNum ? ` · 🏆 ပေါက်သီး <b style="color:var(--green)">${winNum}</b>` : ' · ပေါက်သီး မထည့်ရသေး'}</div>
        <table class="data">
            <tr><th>တက်ငွေ စုစုပေါင်း</th><td style="font-weight:700">${formatMoney(tBet)}</td></tr>
            <tr><th>အပေါက် စုစုပေါင်း</th><td style="font-weight:700">${formatMoney(tWin)}</td></tr>
        </table>
        <details style="margin-top:10px">
            <summary style="cursor:pointer;font-weight:700;padding:6px 0">👤 တဦးချင်း ▼</summary>
            <table class="data" style="margin-top:6px">
                <tr><th>အမည်</th><th>တက်ငွေ</th><th>အပေါက်</th></tr>
                ${rows || '<tr><td colspan="3" class="muted">စာရင်း မရှိပါ</td></tr>'}
            </table>
        </details>
        <div class="row" style="margin-top:10px">
            <button class="btn small gray" id="allTotalCopy">📋 ကူးရန်</button>
        </div>`;
    openGeneric('💰 ALL Total', html);
    $('allTotalCopy').addEventListener('click', async () => {
        const text = `တက်ငွေ စုစုပေါင်း: ${formatMoney(tBet)}\nအပေါက် စုစုပေါင်း: ${formatMoney(tWin)}`;
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
    // Agent-synced: group under agent_name only (hide individual player names in Master)
    if (r.agent_name && r.player_name && r.agent_name !== r.player_name) return r.agent_name;
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

    // Winning numbers for yellow highlight
    const wins = await db.query('winning_numbers', 'by_session', sid);
    const winNums = new Set(wins.map((w) => String(w.number).padStart(2, '0')));

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
                b.items.map((r) => {
                    const numStr = String(r.number).padStart(2, '0');
                    const isWin = winNums.has(numStr);
                    return '<tr' + (isWin ? ' class="win-row"' : '') + '><td' + (isWin ? ' class="win-cell"' : '') + '>' +
                        escHtml(numStr) + '</td>' +
                        '<td' + (isWin ? ' class="win-cell"' : '') + '>' + formatMoney(r.amount) + '</td></tr>';
                }).join('') +
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
    const lkA = await isSessionLocked(state.activeSessionId);
    if (lkA.locked) { showToast('🔒 ' + lkA.reason + ' — ပြင်/ထည့် မရပါ'); return; }
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
    const lkA2 = await isSessionLocked(state.activeSessionId);
    if (lkA2.locked) { showToast('🔒 ' + lkA2.reason + ' — သိမ်း မရပါ'); return; }

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
                const sess2 = state.sessions.find((x) => x.id === state.activeSessionId);
                await createRecord('lottery_records', {
                    session: state.activeSessionId,
                    session_date: sess2 ? sess2.date : null,
                    session_timeType: sess2 ? sess2.timeType : null,
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
