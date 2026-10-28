/**
 * app.js — 2D Master Pro v2 (server-direct rebuild, Pho Oct 27)
 * PocketBase IS the source of truth for the UI; no local-first layer,
 * no sync queue, no background pull. Realtime events refresh the visible view.
 */
import * as pb from '../shared/pb.js?v=4';
import * as direct from '../shared/direct.js?v=1';
import { parseBoard, parseBoardReport, parseLine } from '../shared/parser.js?v=18';
import {
    formatMoney, formatDateStr, getWeekMondayStr, remainingDigits,
    uid, showToast, escHtml, extractDigits, agentEmailFor, agentPasswordFor,
    agentEmailForNum, agentPasswordForNum, agentCodeFor, parseAgentCode, generateAgentSecret
} from '../shared/utils.js?v=7';

// Global safety net: log unhandled promise rejections instead of failing silently.
if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (e) => {
        console.error('[master] Unhandled rejection:', e.reason);
    });
}

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
};

const $ = (id) => document.getElementById(id);

/* ================= BOOT ================= */

document.addEventListener('DOMContentLoaded', init);

/** Server-direct winning-number lookup: one session's winning numbers.
 *  Server ids ARE the session ids now (no local/_pbId split), so a plain
 *  session filter matches. Sorted by created so wins[0] is the earliest,
 *  as before. Throws on a failed read — callers must never treat a failure
 *  as "no winning number". */
async function _getWins(sessionId) {
    return direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
}

async function init() {
    window.appReady = true; // Pho Oct 18: signals app.js loaded (for offline screen)
    bindUI();
    pb.loadBaseUrl(); // custom server URL override (if Pho set one)
    pb.loadAuth();
    // Server-direct: no local DB to open — PocketBase is the source of truth.

    if (pb.isLoggedIn()) {
        try {
            state.user = await pb.refreshAuth();
        } catch (e) {
            // Invalid token → must log in again. Network/tunnel down →
            // keep the cached user and continue (server loads below will
            // toast on failure; no line = no Master in server-direct).
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
    // Try auto-login with saved credentials (Pho: stay logged in)
    try {
        const savedEmail = localStorage.getItem('v2_saved_email');
        const savedPass = localStorage.getItem('v2_saved_pass');
        if (savedEmail && savedPass) {
            state.user = await pb.login(savedEmail, savedPass);
            if (state.user.disabled) {
                await pb.logout();
                localStorage.removeItem('v2_saved_email');
                localStorage.removeItem('v2_saved_pass');
                showPage('page-login');
                return;
            }
            localStorage.setItem('v2_last_user_id', state.user.id);
            await enterApp();
            return;
        }
    } catch (e) { /* auto-login failed, show login page */ }
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
    $('agLimitAdd').addEventListener('click', addAgentLimit);

    $('syncNowBtn').addEventListener('click', () => manualRefresh());
    $('logoutBtn').addEventListener('click', doLogout);
    const resetBtn = $('resetAppBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetApp);
    const wipeBtn = $('nuclearWipeBtn');
    if (wipeBtn) wipeBtn.addEventListener('click', nuclearWipe);
    $('buyerCreateBtn').addEventListener('click', createBuyerAccount);
    const agentCreateBtn = $('agentCreateBtn');
    if (agentCreateBtn) agentCreateBtn.addEventListener('click', () => window.createAgentAccount());
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
    // Server URL UI removed (hardcoded to https://2d.skylinkvpn.stream)
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
        // Save credentials for auto-login (Pho requested persistent login)
        try {
            localStorage.setItem('v2_saved_email', email);
            localStorage.setItem('v2_saved_pass', pass);
        } catch (e) { /* ignore */ }
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
    try {
        localStorage.removeItem('v2_saved_email');
        localStorage.removeItem('v2_saved_pass');
    } catch (e) { /* ignore */ }
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
    // Server-direct (Pho Oct 27): sync.isOnline() was literally
    // `navigator.onLine !== false` — same gate without the sync module.
    if (!pb.isLoggedIn() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
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
        // 3. Create per-tenant agent account #1 (for Agent app sync, tenant-isolated)
        // Buyer can add up to 4 more via Agent management (5 total max)
        const agentEmail = agentEmailForNum(tenant.id, 1);
        const agentSecret1 = generateAgentSecret();
        const agentPass = agentPasswordForNum(tenant.id, 1, agentSecret1);
        const agentCode1 = agentCodeFor(tenant.id, 1, agentSecret1);
        await pb.create('users', {
            email: agentEmail,
            password: agentPass,
            passwordConfirm: agentPass,
            name: `Agent 1 (${shopName})`,
            tenant: tenant.id
        });
        resultEl.style.display = '';
        resultEl.innerHTML =
            '<div style="background:#052e16;border:1px solid #16a34a;border-radius:8px;padding:10px;margin-top:8px">' +
            '<div style="color:#4ade80;font-weight:bold">✅ Buyer account ရပြီ</div>' +
            '<div class="mt">Email: <b>' + escHtml(email) + '</b></div>' +
            '<div>Temp password: <b style="font-size:16px;letter-spacing:1px">' + escHtml(tmp) + '</b></div>' +
            '<div class="small muted mt">Buyer ကို ပို့ပေးပါ — သူ Settings မှာ password ချိန်းရမယ်</div>' +
            '<div class="mt" style="border-top:1px solid #16a34a;padding-top:8px">Agent 1 Code: <b style="font-size:14px;letter-spacing:1px">' + escHtml(agentCode1) + '</b><div class="small muted">ကူးယူထားပါ — နောက်မှ ပြန်မရဘူး</div></div>' +
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
        // Fetch all users, filter in JS by name (email is hidden by PocketBase for other users)
        // Agents are named "Agent N" or "Agent N (Shop)"; buyers have shop names; exclude Pho himself
        const users = await pb.list('users', { perPage: 100 });
        const allUsers = (users.items || users);
        const myEmail = (state.user && state.user.email || '').toLowerCase();
        const buyers = allUsers.filter((u) => {
            const name = (u.name || '').trim();
            const email = (u.email || '').toLowerCase();
            if (email === 'johnzyt7@gmail.com' || email === myEmail) return false;
            if (name.toLowerCase().startsWith('agent ')) return false;
            return true;
        });
        if (!buyers.length) {
            box.innerHTML = '<div class="muted">Buyer မရှိသေးပါ</div>';
            return;
        }
        // Fetch agent limits for all buyers in one query (fast)
        let limitMap = {};
        try {
            const limRes = await pb.list('app_settings', { filter: 'key ~ "agent_limit_"', perPage: 100 });
            for (const r of (limRes.items || limRes)) {
                const tid = (r.key || '').replace('agent_limit_', '');
                limitMap[tid] = parseInt(r.value, 10) || 5;
            }
        } catch (e) { /* ignore */ }
        let html = '<div style="overflow-x:auto"><table class="v-table"><thead><tr><th>Email</th><th>ဆိုင်</th><th>Agent</th><th>အခြေအနေ</th><th></th></tr></thead><tbody>';
        for (const b of buyers) {
            const disabled = !!b.disabled;
            const tenantId = typeof b.tenant === 'string' ? b.tenant : (b.tenant && b.tenant.id);
            const limit = limitMap[tenantId] || 5;
            html += '<tr>' +
                '<td>' + escHtml(b.email) + '</td>' +
                '<td>' + escHtml(b.name || '') + '</td>' +
                '<td><button class="btn small gray" onclick="editAgentLimit(\'' + (tenantId || '') + '\',' + limit + ')">' + limit + ' ✏️</button></td>' +
                '<td>' + (disabled ? '<span style="color:#ef4444">🔴 ပိတ်</span>' : '<span style="color:#4ade80">🟢 ဖွင့်</span>') + '</td>' +
                '<td style="white-space:nowrap"><button class="btn small ' + (disabled ? 'gray' : 'red') + '" style="padding:4px 8px;font-size:12px" onclick="toggleBuyerDisabled(\'' + b.id + '\',' + (!disabled) + ')">' + (disabled ? 'ဖွင့်' : 'ပိတ်') + '</button>' +
                '<button class="btn small" style="padding:4px 8px;font-size:12px;background:#374151;color:#fca5a5;border:1px solid #4b5563;margin-left:4px" onclick="deleteBuyerAccount(\'' + b.id + '\',\'' + escHtml(b.email).replace(/'/g, "\\'") + '\')">🗑️</button></td>' +
                '</tr>';
        }
        html += '</tbody></table></div>';
        box.innerHTML = html;
    } catch (e) {
        box.innerHTML = '<div class="muted">မရဘူး: ' + escHtml(e.message || 'error') + '</div>';
    }
}

window.toggleBuyerDisabled = async function toggleBuyerDisabled(userId, disable) {
    const action = disable ? 'ပိတ်' : 'ဖွင့်';
    if (!confirm('ဒီ buyer ကို ' + action + 'မလား? (agent လည်း ' + action + 'မယ်)')) return;
    try {
        await pb.update('users', userId, { disabled: disable });
        // Also disable/enable the tenant's agent account
        try {
            const buyer = await pb.getOne('users', userId);
            const tenantId = buyer.tenant;
            if (tenantId) {
                // Disable/enable all of this tenant's agent accounts (up to 5)
                for (let n = 1; n <= 5; n++) {
                    try {
                        const agentEmail = agentEmailForNum(tenantId, n);
                        const agents = await pb.list('users', { filter: `email="${agentEmail}"`, perPage: 1 });
                        const agent = (agents.items || agents)[0];
                        if (agent) {
                            await pb.update('users', agent.id, { disabled: disable });
                        }
                    } catch (e) { /* agent n may not exist */ }
                }
            }
        } catch (e) {
            console.warn('Agent toggle failed:', e.message);
        }
        showToast(disable ? '🔴 ပိတ်ပြီးပြီ' : '🟢 ဖွင့်ပြီးပြီ');
        renderBuyerList();
    } catch (e) {
        showToast('❌ ' + (e.message || 'error'));
    }
}

/** Delete a buyer account permanently (seller only). Also deletes their agents. */
window.deleteBuyerAccount = async function deleteBuyerAccount(userId, email) {
    if (!confirm('"' + email + '" ကို အပြီးဖျက်မလား? (agent တွေလည်း ပျက်မယ်, ပြန်မရဘူး)')) return;
    if (!confirm('သေချာလား? နောက်ဆုံး အကြိမ် မေးတာ')) return;
    try {
        try {
            const buyer = await pb.getOne('users', userId);
            const tenantId = buyer.tenant;
            if (tenantId) {
                const prefix = 'agent_' + tenantId + '_';
                const res = await pb.list('users', { filter: 'email ~ "' + prefix + '"', perPage: 100 });
                const agents = (res.items || res);
                for (const a of agents) {
                    try { await pb.del('users', a.id); } catch (e) {}
                }
            }
        } catch (e) { console.warn('Agent cleanup failed:', e.message); }
        await pb.del('users', userId);
        showToast('🗑️ ဖျက်ပြီးပြီ');
        renderBuyerList();
    } catch (e) {
        showToast('❌ ' + (e.message || 'error'));
    }
};

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
    // Show loading while the server data loads — ensures data is present on
    // first login (fixes the "login twice" issue where an empty view rendered
    // before data arrived).
    showPage('page-main');
    const sessionList = $('sessionList');
    if (sessionList) sessionList.innerHTML = '<div class="empty">⏳ တင်နေတယ်… ခနစောင့်ပါ</div>';
    // Server-direct (Pho Oct 27): load straight from the server, no sync step.
    try {
        await ensureTenant();
    } catch (e) {
        console.warn('Initial load failed:', e.message);
    }
    // Load + render FIRST so the first view paints fast (Pho Oct 27: boot
    // maintenance was blocking first paint on a slow line). Maintenance runs
    // behind below — same work, same rules, just not blocking the UI.
    await loadSessions();
    await loadAgents();
    await loadSettingsIntoUI();
    renderSessions();
    renderAgents();
    if (state.activeSessionId) renderLedger();
    updateSyncPill();
    // Background maintenance (not awaited): old-record/winnings cleanup
    // (>2 weeks / >10 weeks, same rules as before) + date backfill so history
    // views survive session deletion. Failures only warn; next boot retries.
    cleanupOldRecords().catch((e) => console.warn('cleanupOldRecords failed:', e.message));
    cleanupOldWinnings().catch((e) => console.warn('cleanupOldWinnings failed:', e.message));
    backfillDates().catch((e) => console.warn('backfillDates failed:', e.message));
    // Realtime: server pushes changes in ~1-2s; refresh ONLY the visible view.
    // No polling loop, no full sync. The transport carries no collection info
    // (see _refreshOnRealtime), so each burst refreshes the current view.
    try {
        direct.directSubscribe(
            ['lottery_records', 'winning_numbers', 'sessions', 'agents'],
            () => { _drainRealtimeRefresh(); }
        );
    } catch (e) { /* realtime optional — foreground refresh covers it */ }
    // Foreground / reconnect: cheap backup refresh of the current view.
    window.addEventListener('online', () => { _drainRealtimeRefresh(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _drainRealtimeRefresh();
    });
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
        try { wins = await _getWins(s.id) || []; } catch (e) {}
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
        // Server-direct: no local tenant row to cache — the user record IS
        // the tenant link, and server API rules enforce the isolation.
    } else {
        // Fallback for users with no tenant link (should not happen for Pho).
        // Server-direct: NEVER mint a fake local tenant id — server queries
        // would silently return nothing (or orphan writes). Reuse the cached
        // tenant from a previous login if present, else leave it empty and
        // let the server API rules decide (views toast on failure).
        console.warn('No tenant on user record — using cached tenant if any');
        try {
            const cached = localStorage.getItem('v2_tenant:' + (state.user && state.user.id));
            if (cached) { state.tenantId = cached; state.tenantPbId = cached; }
        } catch (e) { /* ignore */ }
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
    // Load the agent list for this tenant (buyer's own agents)
    renderAgentList().catch(() => {});
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


/** Auto-ack batches for Agent "Ok" display. Runs after realtime record
 *  events (and manual refresh). Writes to batch_acks. */
/* Pho Oct 18: ANY Master user writes acks for their own tenant's batches
   (was restricted to johnzyt7@gmail.com only — broke for Mkl etc.) */
async function writeBatchAcks() {
    try {
        if (!pb.isLoggedIn()) return;
    } catch (e) { return; }
    try {
        // Pho Oct 21: scan ALL records, not just the newest 100 — a batch
        // that fell out of the 100-record window never got its ack and was
        // never re-checked (TL batch 2, 156 records, stayed Ok-less while
        // batches 1, 3, 4 were acked).
        const res = await pb.listAll('lottery_records', { sort: '-created' });
        const records = res.items || res;
        const seen = new Map();
        for (const r of records) {
            if (!r.agent_name || !r.batch_no) continue;
            const tenantId = r.tenant || '';
            const batchKey = [r.agent_name, r.player_name || '', r.batch_no, r.session].join('|');
            if (!seen.has(batchKey)) seen.set(batchKey, { r, tenantId, batchKey });
        }
        for (const [batchKey, { r, tenantId }] of seen) {
            try {
                const ex = await pb.list('batch_acks', { filter: `batch_key="${batchKey}"`, perPage: 1 });
                if (!(ex.items || ex).length) {
                    await pb.create('batch_acks', {
                        batch_key: batchKey,
                        agent_name: r.agent_name,
                        player_name: r.player_name || '',
                        batch_no: Number(r.batch_no) || 0,
                        session: r.session || '',
                        tenant: tenantId
                    });
                }
            } catch (e) { /* skip */ }
        }
    } catch (e) { /* skip */ }
}

/* ================= SERVER-DIRECT REFRESH (Pho Oct 27) =================
 * No sync, no pull, no polling. PocketBase realtime pushes a change event;
 * the visible view re-renders from the server. NOTE on the transport:
 * pb.js realtimeSubscribe fires its callback with NO arguments (named
 * per-topic listeners funnel into the same no-arg handler), so the app
 * cannot tell WHICH collection changed without changing shared pb.js
 * (live-app code — deliberately untouched). The mapping is therefore
 * collection-agnostic by necessity: each burst refreshes the session list
 * (keeps every view's session lookup fresh) + ONLY the visible view's
 * loader. Nothing else re-renders, nothing reloads the page. Bursts
 * coalesce: events arriving mid-refresh set a flag for one follow-up run. */

/** Re-render ONLY the currently visible tab (mirror of switchTab's renders,
 *  without pane toggling or nav-stack pushes). Static tabs render nothing. */
async function refreshCurrentTab() {
    switch (currentTab) {
        case 'sessions': await loadSessions(); renderSessions(); break;
        case 'entry': await renderEntry(); break;
        case 'ledger': await renderLedger(); break;
        case 'agents': await loadAgents(); renderAgents(); loadAgentLinksAndUsers().then(() => renderAgents()); break;
        case 'vouchers': await renderVouchers(); break;
        case 'akan': await renderOverlimit(); break;
        case 'akandain': await renderAkandain(); break;
        case 'winning': await renderWinningHome(); break;
        case 'weekly': await renderWeekly(); break;
        case 'daily': await renderHomeDaily(); break;
        default: break; // home, formula, settings: static, nothing to refresh
    }
}

/** One realtime burst: fresh session list (unless already on the sessions
 *  tab, where refreshCurrentTab loads it) + the visible view's loader.
 *  View loaders toast on their own read failures; a failure here only logs. */
async function _refreshOnRealtime() {
    if (!pb.isLoggedIn()) return;
    try {
        if (currentTab !== 'sessions') await loadSessions();
        await refreshCurrentTab();
    } catch (e) {
        console.warn('[master] realtime refresh failed:', e.message);
    }
    // Auto-ack (background, unawaited): Agent "Ok" badges still need acks
    // written when agent records arrive — previously fullSync did this after
    // every pull. Coalesced so a burst of record events runs it once.
    _runAcksCoalesced();
}

let _rtRunning = false;
let _rtPending = false;
async function _drainRealtimeRefresh() {
    if (!pb.isLoggedIn()) return;
    if (_rtRunning) { _rtPending = true; return; }
    _rtRunning = true;
    try {
        do {
            _rtPending = false;
            await _refreshOnRealtime();
        } while (_rtPending);
    } finally {
        _rtRunning = false;
    }
}

/** Coalesced ack runner: at most one writeBatchAcks run at a time; an event
 *  arriving mid-run schedules exactly one follow-up run. */
let _acksRunning = false;
let _acksPending = false;
async function _runAcksCoalesced() {
    if (_acksRunning) { _acksPending = true; return; }
    _acksRunning = true;
    try {
        do {
            _acksPending = false;
            await writeBatchAcks();
        } while (_acksPending);
    } catch (e) {
        console.warn('Ack failed:', e.message);
    } finally {
        _acksRunning = false;
    }
}

/** Server-direct: no sync queue anymore, so no pill.
 *  Kept as a no-op so existing call sites keep working; hides the pill
 *  element whenever it runs. */
async function updateSyncPill() {
    try { const pill = $('syncPill'); if (pill) pill.style.display = 'none'; } catch (e) { /* ignore */ }
}

/** Server-direct manual refresh (Settings "Sync လုပ်မယ်" button + pill tap):
 *  reload the lists + the current view. No queue, no sync — the button's
 *  label and toasts stay the same. */
async function manualRefresh() {
    try {
        await loadSessions();
        await loadAgents();
        await refreshCurrentTab();
        await _runAcksCoalesced();
        showToast('✅ Sync ပြီးပြီ');
    } catch (e) {
        showToast('❌ Sync မရပါ: ' + (e.message || e));
    }
    updateSyncPill();
}
window.syncNowManual = manualRefresh;

/* ================= SETTINGS ================= */


/** Server-direct (Pho Oct 27): server rows carry ISO `updated`, not numeric
 * `_updated`. Normalize so the existing newest-first sort comparators keep
 * working unchanged. */
function normServerRows(rows) {
    return (rows || []).map((r) => Object.assign({}, r, {
        _updated: r.updated ? Date.parse(r.updated) : (r._updated || 0),
    }));
}

async function getSetting(key, fallback) {
    try {
        const all = normServerRows(await direct.withRetry(() => direct.directList('app_settings', state.tenantPbId)));
        const matches = all.filter((r) => r.key === key);
        if (!matches.length) return fallback;
        matches.sort((a, b) => (b._updated || 0) - (a._updated || 0));
        const v = matches[0].value;
        return v === undefined ? fallback : v;
    } catch (e) { return fallback; }
}

async function setSetting(key, value) {
    const all = normServerRows(await direct.withRetry(() => direct.directList('app_settings', state.tenantPbId)));
    const matches = all.filter((r) => r.key === key);
    matches.sort((a, b) => (b._updated || 0) - (a._updated || 0));
    const rec = matches[0];
    if (rec) {
        await direct.withRetry(() => direct.directSave('app_settings', Object.assign({}, rec, { value: String(value) })));
    } else {
        await direct.withRetry(() => direct.directCreate('app_settings', { id: uid(), tenant: state.tenantPbId, key, value: String(value) }));
    }
}

/** Pho Oct 21: Agent-account links + money resolver.
 *  A registry person (agents) may be linked to a PocketBase agent ACCOUNT
 *  (users). Link lives in app_settings: key 'agentlink_<userId>' -> agents id.
 *  Commission/payout must follow the LINK (ID), not spelling alone:
 *  'Kyaw Soe' vs 'kyawsoe' must never change the rates. */
async function loadAgentLinksAndUsers() {
    try {
        // Server-direct (Pho Oct 27): links live in server app_settings.
        const all = await direct.withRetry(() => direct.directList('app_settings', state.tenantPbId));
        const links = {};
        for (const r of all) {
            if (r.key && r.key.indexOf('agentlink_') === 0 && r.value) links[r.key.slice(10)] = r.value;
        }
        state.agentLinks = links;
    } catch (e) { if (!state.agentLinks) state.agentLinks = {}; }
    try {
        let tenantId = state.tenantPbId;
        if (!tenantId && state.user && state.user.tenant) tenantId = typeof state.user.tenant === 'string' ? state.user.tenant : state.user.tenant.id;
        if (tenantId && pb.isLoggedIn()) {
            const res = await pb.list('users', { perPage: 100 });
            const allUsers = (res.items || res);
            state.agentUsers = allUsers.filter((u) => {
                const uTenant = typeof u.tenant === 'string' ? u.tenant : (u.tenant && u.tenant.id);
                if (uTenant !== tenantId) return false;
                const nm = (u.name || '').trim();
                if (nm.toLowerCase().startsWith('agent ')) return true;
                const em = (u.email || '').toLowerCase();
                return em.startsWith('agent_' + tenantId.toLowerCase() + '_') && em.endsWith('@2dpro.local');
            }).map((u) => {
                const em = (u.email || '').match(/_(\d+)@2dpro\.local$/i);
                const nm = (u.name || '').match(/agent\s+(\d+)/i);
                return { id: u.id, name: u.name || '', num: em ? parseInt(em[1], 10) : (nm ? parseInt(nm[1], 10) : 0) };
            }).sort((a, b) => (a.num || 999) - (b.num || 999));
        }
    } catch (e) { if (!state.agentUsers) state.agentUsers = []; }
}

const _normName = (s) => (s || '').toLowerCase().replace(/\s+/g, '');

/** Resolve the registry person whose commission/payout applies to a bucket.
 *  Order: 1) bucket 'id:' key -> registry by ID. 2) agent account (exact name)
 *  -> saved link -> registry by ID. 3) exact registry name. 4) normalized
 *  name (case/space-insensitive) via link, then registry. */
function resolveAgentForBucket(pkey, label) {
    const agents = state.agents || [];
    if (pkey && pkey.indexOf('id:') === 0) {
        const a = agents.find((x) => x.id === pkey.slice(3));
        if (a) return a;
    }
    const links = state.agentLinks || {};
    const users = state.agentUsers || [];
    const byLink = (u) => (u && links[u.id]) ? (agents.find((x) => x.id === links[u.id]) || null) : null;
    let a = byLink(users.find((x) => (x.name || '') === label));
    if (a) return a;
    a = agents.find((x) => x.name === label);
    if (a) return a;
    const nl = _normName(label);
    if (nl) {
        a = byLink(users.find((x) => _normName(x.name) === nl));
        if (a) return a;
        a = agents.find((x) => _normName(x.name) === nl);
        if (a) return a;
    }
    return null;
}

/** 'Agent N' badge text for a linked registry person (or ''). */
function agentBadgeForPerson(personId) {
    const links = state.agentLinks || {};
    const users = state.agentUsers || [];
    for (const uid of Object.keys(links)) {
        if (links[uid] === personId) {
            const u = users.find((x) => x.id === uid);
            if (u) return u.num ? ('Agent ' + u.num) : (u.name || 'Agent');
            return 'Agent';
        }
    }
    return '';
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

/* ---- Header back-button navigation history ---- */
let navStack = [];
let currentTab = 'home';
function updateBackBtn() {
    const b = $('backBtn');
    if (b) b.style.display = (currentTab === 'home' || !navStack.length) ? 'none' : '';
}
function goBack() {
    const prev = navStack.pop();
    switchTab(prev || 'home', { noPush: true });
}
window.goBack = goBack;

function switchTab(name, opts) {
    const noPush = opts && opts.noPush;
    if (name !== currentTab) {
        if (!noPush) {
            navStack.push(currentTab);
            if (navStack.length > 30) navStack.shift();
        }
        currentTab = name;
    }
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    $('tab-' + name).classList.add('active');
    // The entry/akandain keypads are fixed overlays — hide them whenever leaving their tab.
    const ekp = $('entryKeypad');
    if (ekp && name !== 'entry' && !ekp.hidden) { ekp.hidden = true; $('entryKbToggle')?.classList.remove('active'); }
    const akp = $('akanKeypad');
    if (akp && name !== 'akandain' && !akp.hidden) { akp.hidden = true; $('akanKbToggle')?.classList.remove('active'); }
    if (name === 'ledger') renderLedger();
    if (name === 'entry') renderEntry();
    if (name === 'agents') { renderAgents(); loadAgentLinksAndUsers().then(() => renderAgents()); }
    if (name === 'vouchers') renderVouchers();
    if (name === 'akan') renderOverlimit();
    if (name === 'akandain') renderAkandain();
    if (name === 'winning') renderWinningHome();
    if (name === 'weekly') renderWeekly();
    if (name === 'daily') renderHomeDaily();
    updateBackBtn();
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
        // Server-direct (Pho Oct 27): save to the server first, only then
        // show the new limit. The old local-first code had no failure path
        // (local put always succeeded, so it always showed the success toast).
        const oldLimit = s.limit;
        try {
            await direct.withRetry(() => direct.directSave('sessions', Object.assign({}, s, { limit: v })));
            s.limit = v;
            await loadSessions();
        } catch (e) {
            // Do not leave the UI showing an unsaved limit: keep the old
            // value (loadSessions refreshes from the server when it can).
            s.limit = oldLimit;
            try { await loadSessions(); } catch (_) { /* keep old value */ }
            closeModal('modal-limit');
            showToast('❌ ' + (e.message || e));
            renderLedger();
            return;
        }
    }
    closeModal('modal-limit');
    showToast('🚫 Limit ' + formatMoney(v) + ' သိမ်းပြီးပြီ');
    renderLedger();
}

/* ================= SESSIONS ================= */

async function loadSessions() {
    try {
        const rows = await direct.withRetry(() => direct.directList('sessions', state.tenantPbId, { sort: '-updated' }));
        state.sessions = normServerRows(rows)
            .sort((a, b) => (b._updated || 0) - (a._updated || 0));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        // Keep previous state.sessions — never blank the card list on a failed load.
    }
}

function sessionLabel(s) {
    return s.name || s.date || 'ပွဲ';
}

async function renderSessions() {
    const box = $('sessionList');
    await loadArchivedSessionIds();
    if (!state.sessions.length) {
        box.innerHTML = '<div class="empty">ပွဲ မရှိသေးပါ<br>“+” နှိပ်ပြီး အသစ်ဖန်တီးပါ</div>';
        return;
    }
    const visible = state.sessions.filter((s) => !state.archivedSessionIds.has(s.id));
    if (!visible.length) {
        box.innerHTML = '<div class="empty">ပွဲတွေ ဝှက်ထားပါတယ်</div>';
        return;
    }
    let html = '';
    const bulkable = bulkArchivableSessions();
    if (bulkable.length) {
        html += `<button class="btn small gray" id="bulkArchiveBtn">အဟောင်းတွေ ဝှက် (${bulkable.length})</button>`;
    }
    // Server-direct (Pho Oct 27): card counts come from the server, not local DB.
    // Fetch all cards in parallel (same output order); on failure a card shows 0
    // and corrects itself on the next load (the old local query had no failure path).
    const counts = await Promise.all(visible.map(async (s) => {
        try {
            return await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${s.id}"` }));
        } catch (e) { return []; }
    }));
    for (let i = 0; i < visible.length; i++) {
        const s = visible[i];
        const recs = counts[i];
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
                <button class="btn small gray" data-act="archive" data-id="${s.id}">ဝှက်</button>
            </div>
        </div>`;
    }
    box.innerHTML = html;
    const bulkBtn = $('bulkArchiveBtn');
    if (bulkBtn) bulkBtn.addEventListener('click', bulkArchiveOldSessions);
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
    else if (act === 'archive') archiveSession(id);
}

async function toggleSessionClose(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    const newClosed = !s.closed;
    const action = newClosed ? 'ပိတ်' : 'ဖွင့်';
    if (!confirm(`ဒီပွဲကို ${action}မလား?`)) return;
    try {
        await direct.withRetry(() => direct.directSave('sessions', Object.assign({}, s, { closed: newClosed })));
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
    // Pho Oct 19: Session uniqueness — 1 tenant, 1 date, 1 timeType = max 1 session.
    // Prevents duplicate sessions (the 121-duplicate bug).
    // Server-direct (Pho Oct 27): the server IS the source — one server check
    // covers both old paths (local + server); the server toast survives.
    try {
        const list = await direct.withRetry(() => direct.directList('sessions', state.tenantPbId, {
            filter: `date="${dateStr}" && timeType="${timeType}"`,
        }));
        if (list.length > 0) {
            const se = list[0];
            closeModal('modal-session');
            setActiveSession(se.id);
            await loadSessions();
            renderSessions();
            showToast('⚠️ Server မှာ ရှိပြီးသား — ပြန်ယူလိုက်ပြီ');
            return;
        }
    } catch (e) { /* fall through to create */ }
    let s;
    try {
        s = await direct.withRetry(() => direct.directCreate('sessions', {
            id: uid(), tenant: state.tenantPbId,
            name, date: dateStr, timeType, is_open: true, limit: 50000,
        }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    closeModal('modal-session');
    setActiveSession(s.id);
    await loadSessions();
    renderSessions();
    showToast('✅ ပွဲ ဖန်တီးပြီးပြီ');
}

/** Archived session ids (Pho Oct 27): one app_settings row on the server per
 * hidden session, key 'archived_<sessionId>'. Session ids are globally
 * unique, so one buyer's archive can never hide another buyer's session.
 * Only the card hides — records, winnings and Daily/Weekly history are
 * untouched. Server-direct: no sync needed, every load reads the server. */
async function loadArchivedSessionIds() {
    try {
        const all = await direct.withRetry(() => direct.directList('app_settings', state.tenantPbId));
        const set = new Set();
        for (const r of all) {
            if (r.key && r.key.indexOf('archived_') === 0) set.add(r.key.slice(9));
        }
        state.archivedSessionIds = set;
    } catch (e) { if (!state.archivedSessionIds) state.archivedSessionIds = new Set(); }
    return state.archivedSessionIds;
}

/** Sessions the bulk-hide button covers: dated before today, never the
 * active session, not already archived. Unparseable dates are skipped. */
function bulkArchivableSessions() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return state.sessions.filter((s) => {
        if (s.id === state.activeSessionId) return false;
        if (state.archivedSessionIds && state.archivedSessionIds.has(s.id)) return false;
        if (!s.date) return false;
        const parts = String(s.date).split('.');
        if (parts.length !== 3) return false;
        const d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
        return !isNaN(d.getTime()) && d < today;
    });
}

/** Bulk-hide old sessions (Pho Oct 27): buyers accumulate dozens of cards;
 * one tap clears the old ones. Cards only — records and history stay. */
async function bulkArchiveOldSessions() {
    await loadArchivedSessionIds();
    const targets = bulkArchivableSessions();
    if (!targets.length) { showToast('ဝှက်စရာ မရှိပါ'); return; }
    if (!confirm(`ပွဲ ${targets.length} ခု ဝှက်မှာလား?\nကဒ်ပဲ ပျောက်မယ် — စာရင်း၊ အချုပ်တွေ ကျန်မယ်။`)) return;
    try {
        for (const s of targets) {
            await setSetting('archived_' + s.id, state.tenantPbId || '');
            state.archivedSessionIds.add(s.id);
        }
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        await loadSessions();
        renderSessions();
        renderLedger();
        return;
    }
    await loadSessions();
    renderSessions();
    renderLedger();
    showToast(`${targets.length} ပွဲ ဝှက်ပြီးပြီ`);
}

async function archiveSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    if (!confirm(`"${sessionLabel(s)}" ဝှက်မှာလား?\nကဒ်ပဲ ပျောက်မယ် — စာရင်း၊ ပေါက်သီး၊ အချုပ်တွေ ကျန်မယ်။`)) return;
    // Archive (Pho Oct 27): an app_settings row on the server — NOT a server
    // delete, so PocketBase's required-relation rule never blocks it, and
    // every device hides the card on its next load (no sync needed).
    // Records, winnings and Daily/Weekly history are untouched (they are
    // date-based, not card-based).
    try {
        await setSetting('archived_' + id, state.tenantPbId || '');
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    if (!state.archivedSessionIds) state.archivedSessionIds = new Set();
    state.archivedSessionIds.add(id);
    if (state.activeSessionId === id) {
        state.activeSessionId = null;
        localStorage.removeItem('v2_active_session');
    }
    await loadSessions();
    renderSessions();
    renderLedger();
    showToast('ဝှက်ပြီးပြီ');
}

/* ================= DIGITAL BOARD ================= */

async function openBoard(sessionId) {
    state.boardSessionId = sessionId;
    const s = state.sessions.find((x) => x.id === sessionId);
    $('boardTitle').textContent = '📝 ထိုးကွက် — ' + (s ? sessionLabel(s) : '');
    $('boardTargetWrap').style.display = '';
    $('boardTargetWrap').querySelector('label').textContent = 'ထိုးသား';
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

/** Per-line formula check: small ✅/❌ per line + (count) total. Never guesses. */
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
        let extra = '';
        if (ok) {
            try {
                const parsed = parseLine(line);
                const total = parsed.reduce((s, p) => s + (Number(p.amount) || 0), 0);
                extra = ` <span class="muted">(${parsed.length}) ${formatMoney(total)}</span>`;
            } catch (e) {}
        }
        html += `<div class="bline ${ok ? 'ok' : 'bad'}"><span class="mk">${ok ? '✅' : '❌'}</span><span class="tx">${escHtml(line)}${extra}</span></div>`;
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
        for (const p of parsed) okItems.push({...p, formula_text: line.trim()});
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
        // Board's own bookie selector first (akan mode), main screen's selector as fallback.
        const bookie = (($('boardTarget') && $('boardTarget').value) || ($('akanBookieSelect') && $('akanBookieSelect').value) || '').trim() || null;
        if (!bookie) { showToast('❌ ဒိုင် နာမည် ရွေးပါ'); return; }
        if ($('akanBookieSelect')) $('akanBookieSelect').value = bookie;
        okItems.forEach((it) => {
            addAkanUnique(bookie, it.number, it.amount);
        });
        if (badLines.length) {
            keepBadOpen();
            showToast('✅ ' + okItems.length + ' ကွက် ထည့်ပြီးပြီ (အထွက်) · ❌ ' + badLines.length + ' လိုင်း ကျန် — ပြင်ပြီး Save ပြန်နှိပ်');
            return;
        }
        showToast('✅ ' + okItems.length + ' ကွက် ထည့်ပြီးပြီ (အထွက်)');
        $('boardText').value = '';
        renderBoardLineCheck();
        closeModal('modal-board');
        await openAkandain(sessionId);
        return;
    }

    const target = $('boardTarget').value;
    const agent = state.agents.find((a) => a.id === target);
    const personName = agent ? agent.name : '';
    const boardPersonId = agent ? agent.id : '';
    if (!personName) { showToast('❌ အမည် ရွေးပါ (မရွေးရင် တင်မရ)'); return; }

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
        addEntryUnique(personName || null, it.number, it.amount, 'pos', it.formula_text, undefined, boardPersonId);
    });
    if (badLines.length) {
        keepBadOpen();
        showToast('✅ ' + allowedBoard.length + ' ကွက် ထည့်ပြီးပြီ · ❌ ' + badLines.length + ' လိုင်း ကျန် — ပြင်ပြီး Save ပြန်နှိပ်');
        return;
    }
    showToast('✅ ' + allowedBoard.length + ' ကွက် ထည့်ပြီးပြီ');
    $('boardText').value = '';
    renderBoardLineCheck();
    closeModal('modal-board');
    await openEntry(sessionId);
}

/* ================= ENTRY SCREEN (ထိုးကွက် — Agent-style) ================= */

let entryPending = [];      // typed but NOT yet saved: [{player_name, number, amount, record_type}]
/** Add to entryPending. Pho: duplicates allowed — user deletes mistakes manually.
 *  Pho Oct 18: personId links records to the exact person (same-name safe). */
function addEntryUnique(playerName, number, amount, recordType, formulaText, lineIdx, personId) {
    const num = String(number).padStart(2, '0');
    const amt = Number(amount) || 0;
    entryPending.push({ player_name: playerName, number: num, amount: amt, record_type: recordType || 'pos', formula_text: formulaText || '', line_idx: lineIdx ?? -1, person_id: personId || '' });
    return true;
}
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
    // Pho Oct 18: options keyed by agent ID (not name) so same-name persons stay separate.
    // If duplicate names exist, show phone to distinguish.
    const nameCount = {};
    (state.agents || []).forEach((a) => {
        if ((a.person_type || 'agent') === 'akan') return;
        const n = (a.name || '').trim();
        if (n) nameCount[n] = (nameCount[n] || 0) + 1;
    });
    let opts = '';
    (state.agents || []).forEach((a) => {
        if ((a.person_type || 'agent') === 'akan') return;
        const n = (a.name || '').trim();
        if (!n) return;
        const label = (nameCount[n] > 1 && a.phone) ? `${n} (${a.phone})` : n;
        opts += `<option value="${escHtml(a.id)}">${escHtml(voucherPersonLabel(label))}</option>`;
    });
    const ph = '-- ထိုးသား ရွေးပါ --';
    pSel.innerHTML = '<option value="">' + escHtml(ph) + '</option>' + opts;
    if (prev && pSel.querySelector(`option[value="${CSS.escape(prev)}"]`)) pSel.value = prev;
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
    // Group by (formula_text, line_idx) for compact display — each input line is its own row (Pho)
    const byF = {}; const fOrder = [];
    entryPending.forEach((e, idx) => {
        const ft = (e.formula_text || '').trim();
        const key = ft ? ft + '‖' + (e.line_idx ?? -1) : `__s__${idx}`;
        if (!byF[key]) { byF[key] = { indices: [], entries: [] }; fOrder.push(key); }
        byF[key].indices.push(idx);
        byF[key].entries.push(e);
    });
    tbody.innerHTML = fOrder.map((key) => {
        const g = byF[key];
        if (g.entries.length > 1) {
            const e0 = g.entries[0];
            const ft = (e0.formula_text || '').trim();
            const gTotal = g.entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
            const idxList = g.indices.join(',');
            const label = (e0.record_type === 'akan' ? '⬆️ ' : '') + escHtml(e0.player_name || (e0.record_type === 'akan' ? 'ဒိုင် (အကန်)' : 'ကိုယ်တိုင်'));
            return '<tr>' +
                '<td>' + label + '</td>' +
                '<td class="cell-no">' + escHtml(ft) + ' (' + g.entries.length + ')</td>' +
                '<td class="cell-amt">' + formatMoney(gTotal) + '</td>' +
                '<td class="cell-del"><button class="rec-del" onclick="entryDeleteGroup(\'' + idxList + '\')" title="ဖျက်မည်">🗑️</button></td>' +
            '</tr>';
        }
        const e = g.entries[0]; const i = g.indices[0];
        return '<tr>' +
            '<td>' + (e.record_type === 'akan' ? '⬆️ ' : '') + escHtml(e.player_name || (e.record_type === 'akan' ? 'ဒိုင် (အကန်)' : 'ကိုယ်တိုင်')) + '</td>' +
            '<td class="cell-no">' + escHtml(String(e.number)) + '</td>' +
            '<td class="cell-amt">' + formatMoney(e.amount) + '</td>' +
            '<td class="cell-del"><button class="rec-del" onclick="entryDeleteRow(' + i + ')" title="ဖျက်မည်">🗑️</button></td>' +
        '</tr>';
    }).join('');
}

window.entryDeleteGroup = function entryDeleteGroup(idxList) {
    const idxs = idxList.split(',').map((x) => parseInt(x, 10)).sort((a, b) => b - a);
    idxs.forEach((i) => entryPending.splice(i, 1));
    renderEntryTable();
};

window.entryDeleteRow = function entryDeleteRow(i) {
    entryPending.splice(i, 1);
    renderEntryTable();
};

/** Session lock: betting closes at 11:55 (AM) / 15:55 (PM) on session date;
    and locks entirely once winning numbers are entered. */
async function isSessionLocked(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (!s) return { locked: false };
    // manually closed by bookie → locked
    if (s.closed) return { locked: true, reason: 'ဒိုင်က ပိတ်လိုက်ပြီ' };
    // winning numbers entered → locked
    // Fail CLOSED on a read failure: never allow entry when the lock state
    // is unknown (and a throw here would brick entrySave's in-flight guard).
    let wins;
    try {
        wins = await _getWins(sessionId);
    } catch (e) {
        return { locked: true, reason: 'ပေါက်သီး စစ်မရပါ — လိုင်းစစ်ပြီး ပြန်စမ်းပါ' };
    }
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
    // Pho Oct 18: dropdown value is now the agent ID (same-name persons stay separate).
    const selId = $('entryPlayerSelect').value || null;
    const selAgent = selId ? (state.agents || []).find((a) => a.id === selId) : null;
    const playerName = selAgent ? selAgent.name : null;
    const personId = selAgent ? selAgent.id : null;
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
        addEntryUnique(playerName, it.number, it.amount, rType, it.formula_text, it.line_idx, personId);
    });
    entryClearInputs();
    renderEntryTable();
    const skipped = invalidLines.length + (items.length - validItems.length) + blockedHit.length;
    const blkMsg = blockedHit.length ? ' (🚫 ' + [...new Set(blockedHit)].join(',') + ' ပိတ်)' : '';
    showToast(rType === 'akan' ? '✅ ထည့်ပြီးပြီ (⬆️ အထွက်)' : '✅ ထည့်ပြီးပြီ' + (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : '') + blkMsg);
};

/** 💾 Save — persist all pending entries as NEW batches (one batch_no per person/type). */
/** Check per-person per-number limits: cumulative total per (person, number, session) must not exceed the limit. Returns error message or null. */
async function checkPersonLimits(pending, sessionId) {
    const pendTotals = {};
    pending.forEach((e) => {
        const name = (e.player_name || '').trim();
        const num = String(e.number).padStart(2, '0');
        const k = name + '|' + num;
        pendTotals[k] = (pendTotals[k] || 0) + (Number(e.amount) || 0);
    });
    // Server-direct (Pho Oct 27): existing totals come from the server, not local DB.
    // A failed read must NOT silently skip limit enforcement — the caller treats
    // a throw as a save failure (guard reset, error toast, pending kept), so no
    // over-limit batch can slip through and the next save still works.
    const existing = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"` }));
    const existTotals = {};
    existing.forEach((r) => {
        const name = (r.player_name || r.agent_name || '').trim();
        const num = String(r.number).padStart(2, '0');
        const k = name + '|' + num;
        existTotals[k] = (existTotals[k] || 0) + (Number(r.amount) || 0);
    });
    for (const k of Object.keys(pendTotals)) {
        const sep = k.lastIndexOf('|');
        const name = k.slice(0, sep), num = k.slice(sep + 1);
        const person = (state.agents || []).find((a) => a.name === name);
        const lim = person && person.limits && Number(person.limits[num]);
        if (lim > 0) {
            const total = (existTotals[k] || 0) + pendTotals[k];
            if (total > lim) {
                return `${name} — ဟော့ဂဏန်း (${num}) Limite ပြည့်လို့ မရတော့ပါ`;
            }
        }
    }
    return null;
}

window.saveEntryBatch = async function saveEntryBatch() {
    if (entrySaveInFlight) return;
    // Pho Oct 18: set the guard SYNCHRONOUSLY before any await —
    // two rapid taps must not both pass (same class as Oct 13 winning-number fix).
    entrySaveInFlight = true;
    if (!entryPending.length) { entrySaveInFlight = false; showToast('စာရင်း မရှိသေးပါ'); return; }
    // Block if any entry has no player name
    if (entryPending.some((e) => !(e.player_name || '').trim())) { entrySaveInFlight = false; showToast('❌ အမည် မပါ တဲ့ စာရင်း ရှိ — ဖျက် ပြီး ပြန် ထည့်'); return; }
    if (!state.activeSessionId) { entrySaveInFlight = false; showToast('⚠️ Session မရှိသေးပါ'); return; }
    const lk = await isSessionLocked(state.activeSessionId);
    if (lk.locked) { entrySaveInFlight = false; showToast('🔒 ' + lk.reason + ' — သိမ်း မရပါ'); return; }
    // Per-person hot-number limits (cumulative per session).
    // Fail CLOSED on a read failure — but the guard MUST reset, or the next
    // save would silently no-op at the in-flight check (this call sits
    // outside the save's try block, so a throw here would otherwise brick it).
    let limitErr;
    try {
        limitErr = await checkPersonLimits(entryPending, state.activeSessionId);
    } catch (e) {
        entrySaveInFlight = false;
        showToast('သိမ်းမရပါ: ' + (e.message || e));
        return;
    }
    if (limitErr) { entrySaveInFlight = false; showToast('❌ ' + limitErr); return; }

    // Server-direct (Pho Oct 27): savedIds tracks ONLY this attempt's rows, so a
    // failure can roll them back and a retry can never duplicate them.
    const savedIds = [];
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
                // Built ONCE outside withRetry: a lost-response retry must re-send
                // the SAME id (directCreate treats a duplicate id as the landed write).
                const rec = {
                    id: uid(),
                    tenant: state.tenantPbId,
                    session: state.activeSessionId,
                    session_date: sess ? sess.date : null,
                    session_timeType: sess ? sess.timeType : null,
                    number: String(e.number).padStart(2, '0'),
                    amount: Number(e.amount) || 0,
                    agent_name: e.player_name || '',
                    player_name: e.player_name || '',
                    person_id: e.person_id || '',
                    record_type: e.record_type || 'pos',
                    batch_no: batchNo,
                    formula_text: e.formula_text || '',
                };
                const saved = await direct.withRetry(() => direct.directCreate('lottery_records', rec));
                if (saved && saved.id) savedIds.push(saved.id);
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
        // Roll back this attempt's rows (best-effort) so the pending table stays
        // intact and a retry saves a clean batch — never a false partial success.
        for (const id of savedIds) {
            try { await direct.directDelete('lottery_records', id); } catch (_) { /* keep going */ }
        }
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
window.openAkanBoard = async function openAkanBoard() {
    state.boardMode = 'akan';
    openBoard(state.activeSessionId);
    // Akan mode: the board gets its OWN bookie selector (no longer hidden) —
    // start from the main screen's options, then refresh from the server.
    const wrap = $('boardTargetWrap');
    wrap.style.display = '';
    wrap.querySelector('label').textContent = 'အကန်ဒိုင်';
    const sel = $('boardTarget');
    const mainSel = $('akanBookieSelect');
    if (mainSel) { sel.innerHTML = mainSel.innerHTML; if (mainSel.value) sel.value = mainSel.value; }
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    $('boardTitle').textContent = '🔄 အကန်ဒိုင် (အထွက်) — ' + (s ? sessionLabel(s) : '');
    try {
        const names = await getAkanBookieNames();
        const prev = sel.value;
        sel.innerHTML = '<option value="">-- အကန်ဒိုင်ရွေးရန် --</option>' +
            names.map((k) => '<option value="' + escHtml(k) + '">' + escHtml(k) + '</option>').join('');
        if (prev && names.includes(prev)) sel.value = prev;
        else if (mainSel && mainSel.value && names.includes(mainSel.value)) sel.value = mainSel.value;
    } catch (e) { /* keep the main screen's options copied above */ }
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
    // Server-direct (Pho Oct 27): ledger records come from the server, not local DB.
    // On a failed read, keep the previous ledger content (never blank it).
    let recs;
    try {
        recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${s.id}"` }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    // On a failed wins read, keep the previous ledger content (never blank it).
    let wins;
    try {
        wins = await _getWins(s.id);
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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
    const btn = $('winSave');
    if (btn && btn.disabled) return; // Already saving — prevent double-tap
    if (btn) { btn.disabled = true; btn.textContent = 'သိမ်းနေတယ်…'; }
    try {
        let num = $('winNumber').value.replace(/\D/g, '').slice(0, 2);
        if (num.length !== 2) { showToast('ဂဏန်း ၂ လုံး ထည့်ပါ'); return; }
        const sessionId = _winSessionId;
        const weekMonday = getWeekMondayStr(new Date());
        // Denormalize date/timeType so history views survive session deletion.
        const _ws = state.sessions.find((x) => x.id === sessionId);
        const _wDate = _ws ? _ws.date : null;
        const _wTT = _ws ? (_ws.timeType || '') : '';
        // Re-check for existing (another tap may have created one)
        const existing = await _getWins(sessionId);
        if (existing.length) {
            existing[0].number = num;
            existing[0].week_monday = weekMonday;
            if (_wDate && !existing[0].date) existing[0].date = _wDate;
            if (_wTT && !existing[0].timeType) existing[0].timeType = _wTT;
            await direct.withRetry(() => direct.directSave('winning_numbers', existing[0]));
        } else {
            await direct.withRetry(() => direct.directCreate('winning_numbers', { id: uid(), tenant: state.tenantPbId, session: sessionId, number: num, week_monday: weekMonday, date: _wDate, timeType: _wTT }));
        }
        closeModal('modal-winning');
        showToast('🏆 ပေါက်သီး ' + num + ' သိမ်းပြီးပြီ');
        renderLedger();
        if ($('tab-winning') && $('tab-winning').classList.contains('active')) renderWinningHome();
    } catch (e) {
        showToast('သိမ်းမရပါ: ' + (e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'သိမ်းမယ်'; }
    }
}

/** Home 🎯 ပေါက်သီး tab: every session with its winning number + ထည့်/ပြင် button.
 *  Winning numbers of deleted sessions are shown as read-only date rows. */
async function renderWinningHome() {
    const box = $('winHomeList');
    const sess = (state.sessions || []).slice().sort((a, b) =>
        String(b.created || '').localeCompare(String(a.created || '')));
    const sessIds = new Set(sess.map((s) => s.id));
    const rows = [];
    // On a failed wins read, keep the previous list (never blank it).
    try {
    for (const s of sess) {
        const wins = await _getWins(s.id);
        const num = wins.length ? String(wins[0].number).padStart(2, '0') : null;
        rows.push('<div class="agent-row"><div><div class="nm">' + escHtml(sessionLabel(s)) + '</div>' +
            '<div class="ph">' + (num
                ? '🏆 ပေါက်သီး <b style="color:var(--green)">' + escHtml(num) + '</b>'
                : 'ပေါက်သီး မထည့်ရသေး') + '</div></div>' +
            '<div class="acts"><button class="btn small green" onclick="openWinning(\'' + s.id + '\')">' +
            (num ? 'ပြင်မယ်' : 'ထည့်မယ်') + '</button></div></div>');
    }
    // Orphaned winning numbers (session deleted): date row, read-only.
    const allWins = await direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId));
    const orphans = allWins
        .filter((w) => w && w.number != null && String(w.number) !== '' && !sessIds.has(w.session))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    for (const w of orphans) {
        const label = w.date ? (w.date + (w.timeType ? ' (' + w.timeType + ')' : '')) : '…';
        const num = String(w.number).padStart(2, '0');
        rows.push('<div class="agent-row"><div><div class="nm">' + escHtml(label) + '</div>' +
            '<div class="ph">🏆 ပေါက်သီး <b style="color:var(--green)">' + escHtml(num) + '</b></div></div></div>');
    }
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    if (!rows.length) { box.innerHTML = '<div class="empty">ပွဲ မရှိသေးပါ</div>'; return; }
    box.innerHTML = rows.join('');
}
window.openWinning = openWinning;

/* ================= AGENTS ================= */

async function loadAgents() {
    // Server-direct (Pho Oct 27): the server is the only copy now — no
    // local merge needed. On a failed read, keep the previous list (never
    // blank it) and show an error toast; this function never throws, so all
    // callers (boot, save, delete) stay safe.
    let rows;
    try {
        rows = await direct.withRetry(() => direct.directList('agents', state.tenantPbId));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    state.agents = rows.sort((a, b) =>
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
            <div><div class="nm">${escHtml(a.name)} <span class="ptype">${escHtml(personTypeLabel(a))}</span>${agentBadgeForPerson(a.id) ? ` <span class="ptype" style="background:#1e3a5f;color:#7dd3fc">${escHtml(agentBadgeForPerson(a.id))}</span>` : ''}</div>
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

async function openAgentModal(id) {
    state.editingAgentId = id;
    const a = id ? state.agents.find((x) => x.id === id) : null;
    $('agentModalTitle').textContent = a ? 'လူ ပြင်မယ်' : 'လူအသစ်';
    $('agName').value = a ? a.name : '';
    $('agType').value = a ? (a.person_type || 'agent') : 'agent';
    $('agPhone').value = a ? (a.phone || '') : '';
    $('agComm').value = a ? (a.commission || 0) : 0;
    $('agPayout').value = a ? (a.payout_rate || 80) : 80;
    state.editingLimits = Object.assign({}, (a && a.limits) || {});
    $('agLimitNum').value = '';
    $('agLimitAmt').value = '';
    renderAgentLimitList();
    openModal('modal-agent');
    // Pho Oct 21: fill the agent-account link picker (async, modal already open).
    const linkSel = $('agLink');
    if (linkSel) {
        linkSel.innerHTML = '<option value="">— မချိတ်ထား —</option>';
        try {
            await loadAgentLinksAndUsers();
            const links = state.agentLinks || {};
            let linkedUser = '';
            if (id) { for (const uid of Object.keys(links)) if (links[uid] === id) { linkedUser = uid; break; } }
            for (const u of (state.agentUsers || [])) {
                const opt = document.createElement('option');
                opt.value = u.id;
                opt.textContent = (u.num ? 'Agent ' + u.num + ' · ' : '') + (u.name || '');
                if (u.id === linkedUser) opt.selected = true;
                linkSel.appendChild(opt);
            }
        } catch (e) { /* picker stays empty; person fields unaffected */ }
    }
}

/** Render per-number limits in the person modal. */
function renderAgentLimitList() {
    const box = $('agLimitList');
    const keys = Object.keys(state.editingLimits || {});
    if (!keys.length) {
        box.innerHTML = '<div class="small muted">ကန့်သတ် မရှိသေးပါ</div>';
        return;
    }
    box.innerHTML = keys.sort().map((num) =>
        `<div class="row" style="justify-content:space-between;padding:4px 0;border-bottom:1px dashed #ddd">
            <span><b>${escHtml(num)}</b> → ${formatMoney(state.editingLimits[num])}</span>
            <button class="btn small red" data-dellimit="${escHtml(num)}" type="button">×</button>
        </div>`).join('');
    box.querySelectorAll('[data-dellimit]').forEach((b) =>
        b.addEventListener('click', () => {
            delete state.editingLimits[b.dataset.dellimit];
            renderAgentLimitList();
        }));
}

function addAgentLimit() {
    const raw = $('agLimitNum').value.trim();
    const amt = Number($('agLimitAmt').value) || 0;
    // Allow "56" or "56+98+35+69" — each number gets the same limit.
    const nums = raw.split('+').map((s) => s.trim()).filter(Boolean);
    if (!nums.length || !nums.every((n) => /^\d{2}$/.test(n))) { showToast('ဂဏန်း ၂ လုံး ထည့်ပါ (56+98 လို့လဲ ရတယ်)'); return; }
    if (amt <= 0) { showToast('ပမာဏ ထည့်ပါ'); return; }
    state.editingLimits = state.editingLimits || {};
    nums.forEach((n) => { state.editingLimits[n] = amt; });
    $('agLimitNum').value = '';
    $('agLimitAmt').value = '';
    renderAgentLimitList();
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
        limits: Object.assign({}, state.editingLimits || {}),
    };
    let personId = state.editingAgentId;
    // Server-direct (Pho Oct 27): writes go to the server, not local DB.
    // On failure, error toast + return — no false success, modal stays open,
    // and the in-memory row is untouched until the server save succeeds.
    try {
        if (state.editingAgentId) {
            const a = state.agents.find((x) => x.id === state.editingAgentId);
            await direct.withRetry(() => direct.directSave('agents', Object.assign({}, a, data)));
            if (a) Object.assign(a, data);
        } else {
            const created = await direct.withRetry(() => direct.directCreate('agents', { id: uid(), tenant: state.tenantPbId, ...data }));
            personId = created && created.id;
        }
    } catch (e) {
        showToast('သိမ်းမရပါ: ' + (e.message || e));
        return;
    }
    // Pho Oct 21: persist the agent-account link (app_settings agentlink_<userId>).
    try {
        const sel = $('agLink');
        const selUser = sel ? sel.value : '';
        const links = state.agentLinks || {};
        for (const uid of Object.keys(links)) {
            if (personId && links[uid] === personId && uid !== selUser) await setSetting('agentlink_' + uid, '');
        }
        if (selUser && personId) await setSetting('agentlink_' + selUser, personId);
        await loadAgentLinksAndUsers();
    } catch (e) { /* link is best-effort; person data already saved */ }
    closeModal('modal-agent');
    await loadAgents();
    renderAgents();
    showToast('✅ သိမ်းပြီးပြီ');
}

async function deleteAgent(id) {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return;
    if (!confirm(`Agent "${a.name}" ဖျက်မှာလား?`)) return;
    // Server-direct (Pho Oct 27): on failure, keep the row + error toast.
    try {
        await direct.withRetry(() => direct.directDelete('agents', id));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    await loadAgents();
    renderAgents();
    showToast('🗑️ ဖျက်ပြီးပြီ');
}

/* ================= DAILY SUMMARY ================= */

async function openDaily(sessionId) {
    await loadAgentLinksAndUsers();
    const s = state.sessions.find((x) => x.id === sessionId);
    // On a failed records read, keep the previous content (never blank it).
    let recs;
    try {
        recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    // On a failed wins read, keep the previous content (never blank it).
    let wins;
    try {
        wins = await _getWins(sessionId);
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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
            const ag0 = resolveAgentForBucket(pkey, pLabel[key]);
            const payout = ag0 ? (Number(ag0.payout_rate) || 80) : 80;
            per[key].win += amt;
            per[key].winDeduct += amt * payout;
        }
    }
    let rows = '', tBet = 0, tWin = 0, tComm = 0, tWinDeductPos = 0, tWinDeductAkan = 0, tNet = 0;
    for (const [key, v] of Object.entries(per)) {
        const label = pLabel[key];
        const ag = resolveAgentForBucket(key.replace(/^(akan|pos):/, ''), label);
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
            const ag0 = resolveAgentForBucket(pkey, pLabel[key]);
            const payout = ag0 ? (Number(ag0.payout_rate) || 80) : 80;
            per[key].winDeduct += amt * payout;
        }
    }
    let rows = '', tBet = 0, tWin = 0, tNet = 0;
    for (const [key, v] of Object.entries(per)) {
        const label = pLabel[key];
        const ag = resolveAgentForBucket(key.replace(/^(akan|pos):/, ''), label);
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
    await loadAgentLinksAndUsers();
    const dateInput = $('homeDailyDate');
    if (!_homeDailyDate) {
        const today = new Date();
        _homeDailyDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    }
    if (dateInput && !dateInput.value) dateInput.value = _homeDailyDate;

    const [y, m, d] = _homeDailyDate.split('-');
    const ds = `${d}.${m}.${y}`; // match session.date format DD.MM.YYYY

    // Get ALL records for this date (works even after session deletion)
    // On a failed records read, keep the previous body (never blank it).
    let allRecs;
    try {
        allRecs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { sort: 'created' }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    const dayRecs = allRecs.filter((r) => {
        // New records have session_date; old records: look up via session
        if (r.session_date) {
            if (r.session_date !== ds) return false;
            // Tenant isolation: skip records from other tenants (defense in depth)
            if (r.tenant && state.tenantPbId && r.tenant !== state.tenantPbId) return false;
            return true;
        }
        const sess = state.sessions.find((s) => s.id === r.session);
        return sess && sess.date === ds;
    });

    // Get winning numbers for this date (prefer denormalized w.date so
    // deleted sessions don't hide them)
    // On a failed wins read, keep the previous body (never blank it).
    let allWins;
    try {
        allWins = await direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    const dayWins = {};
    for (const w of allWins) {
        const sess = state.sessions.find((s) => s.id === w.session);
        const wDate = w.date || (sess ? sess.date : null);
        if (wDate === ds) {
            const tt = w.timeType || (sess ? sess.timeType : '') || '';
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
    await loadAgentLinksAndUsers();
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
    // NOTE: iterate dates (not sessions) so deleted sessions don't hide history.
    // Records/winning numbers carry denormalized session_date/date (see backfillDates).
    // On a failed records read, keep the previous content (never blank it).
    let allRecs;
    try {
        allRecs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { sort: 'created' }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    // On a failed wins read, keep the previous content (never blank it).
    let allWins;
    try {
        allWins = await direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }

    // agg key: (akan? 'akan:':'pos:') + pkey
    // perDay[5] -> { am: {bet,win,winDeduct,has}, pm: {...} }
    const agg = {};
    const rowOrder = [];
    const blankCell = () => ({ bet: 0, win: 0, winDeduct: 0, has: false });
    for (let dayIdx = 0; dayIdx < 5; dayIdx++) {
        const ds = days[dayIdx].ds;
        for (const tt of ['မနက်ပိုင်း', 'ညနေပိုင်း']) {
        const isAM = tt === 'မနက်ပိုင်း';
        const recs = allRecs.filter((r) => r.session_date === ds && (r.session_timeType || '') === tt);
        const _w = allWins.find((x) => (x.date || '') === ds && ((x.timeType || '') === tt));
        const wins = _w ? [_w] : [];
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
                const ag0 = resolveAgentForBucket(agg[rk].pkey, agg[rk].label);
                const payout = ag0 ? (Number(ag0.payout_rate) || 80) : 80;
                d.win += amt;
                d.winDeduct += amt * payout;
                d.has = true;
            }
        }
        } // end timeType loop
    } // end day loop

    if (!rowOrder.length) {
        box.innerHTML = '<div class="empty">ဒီအပတ် မှတ်တမ်း မရှိသေးပါ</div>';
        return;
    }

    // Compute nets; dayTotals[5] = {am, pm} nets
    const dayTotals = [0, 1, 2, 3, 4].map(() => ({ am: 0, pm: 0 }));
    let grandTotal = 0;
    const rows = rowOrder.map((rk) => {
        const e = agg[rk];
        const ag = resolveAgentForBucket(e.pkey, e.label);
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
                    const ag = resolveAgentForBucket(e.pkey, e.label);
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
    // Server-direct: records come from the server, not local DB.
    // On a failed read, toast and return (nothing is rendered, so nothing blanks).
    let recs;
    try {
        recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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

/**
 * One-time backfill: stamp date/timeType directly onto winning_numbers and
 * session_date/session_timeType onto lottery_records, so Daily/Weekly/ကျန်ဂဏန်း
 * keep working after their session is deleted. Uses the session when still
 * present, otherwise falls back to the record's own timestamps.
 * Server-direct; idempotent (already-stamped rows are skipped).
 */
async function backfillDates() {
    const sessById = new Map((state.sessions || []).map((s) => [s.id, s]));
    const dateOf = (ts) => {
        if (!ts) return null;
        const d = new Date(ts);
        return isNaN(d.getTime()) ? null : dsOf(d);
    };
    // winning_numbers (server-direct; the lottery_records part below is untouched)
    const wins = await direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId));
    for (const w of wins) {
        if (w.date) continue;
        const sess = sessById.get(w.session);
        let d = sess ? sess.date : null;
        let tt = sess ? (sess.timeType || '') : '';
        if (!d) d = dateOf(w.created || w._updated);
        if (d) {
            w.date = d;
            if (!w.timeType) w.timeType = tt;
            await direct.directSave('winning_numbers', w);
        }
    }
    // lottery_records missing session_date (old records) — server-direct.
    // Selection logic unchanged: only rows missing session_date are stamped,
    // from the session when present, else the row's own timestamp (server rows
    // carry ISO `created`/`updated`; local `_updated` kept as a fallback).
    // Per-row failures are logged and skipped so one bad row never aborts the
    // repair; the next boot retries it (already-stamped rows are skipped).
    const recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId));
    for (const r of recs) {
        if (r.session_date) continue;
        const sess = sessById.get(r.session);
        let d = sess ? sess.date : null;
        let tt = sess ? (sess.timeType || '') : '';
        if (!d) d = dateOf(r.created || r.updated || r._updated);
        if (d) {
            r.session_date = d;
            if (!r.session_timeType) r.session_timeType = tt;
            try {
                await direct.directSave('lottery_records', r);
            } catch (e) { console.warn('backfillDates record failed:', r.id, e.message); }
        }
    }
}

// Server-direct (Pho Oct 27): same 14-day rule as the old local cleanup.
// Old flow deleted local rows + propagated the deletes to the server via the
// sync queue; with no local DB the same rule runs tenant-wide at boot.
// Rows older than 2 weeks (by session_date DD.MM.YYYY, else created) go away.
async function cleanupOldRecords() {
    try {
        const all = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId));
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
                try { await direct.directDelete('lottery_records', r.id); } catch (_) { /* next boot retries */ }
            }
        }
    } catch (e) { console.warn('cleanupOldRecords failed:', e.message); }
}

// Auto-delete winning numbers older than 10 weeks
async function cleanupOldWinnings() {
    try {
        const all = await direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId));
        const tenWeeksAgo = new Date();
        tenWeeksAgo.setDate(tenWeeksAgo.getDate() - 70);
        const cutoff = tenWeeksAgo.getTime();
        for (const w of all) {
            let wTime = null;
            const wm = w.week_monday;
            if (wm) {
                // week_monday is DD.MM.YYYY (from formatDateStr); parse it correctly.
                const m = String(wm).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
                if (m) {
                    wTime = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1])).getTime();
                } else {
                    // Fallback: try ISO YYYY-MM-DD
                    const t = Date.parse(wm);
                    if (!isNaN(t)) wTime = t;
                }
            } else if (w.created) {
                wTime = typeof w.created === 'number' ? w.created : Date.parse(w.created);
            }
            if (wTime && wTime < cutoff) {
                await direct.directDelete('winning_numbers', w.id);
            }
        }
    } catch (e) { console.warn('cleanupOldWinnings failed:', e.message); }
}

async function openRemaining() {
    await cleanupOldWinnings();

    // Server-direct: one tenant-scoped read replaces the local+server merge.
    // On a failed read, keep the previous content (never blank it).
    let wins;
    try {
        wins = await direct.withRetry(() => direct.directList('winning_numbers', state.tenantPbId));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }

    if (!wins.length) {
        openGeneric('🔢 ကျန်ဂဏန်း', '<div class="empty">ပေါက်သီး မှတ်တမ်း မရှိသေးပါ</div>');
        return;
    }

    // Group by date: prefer denormalized w.date (survives session deletion),
    // fall back to session lookup for very old records.
    const byDate = {};
    for (const w of wins) {
        const sess = state.sessions.find((s) => s.id === w.session);
        const dateKey = w.date || (sess && sess.date);
        if (!dateKey) continue;
        if (!byDate[dateKey]) byDate[dateKey] = { am: null, pm: null };
        const tt = w.timeType || (sess && sess.timeType) || '';
        const isAM = tt === 'မနက်ပိုင်း';
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
    // Server-direct: records come from the server, not local DB.
    // On a failed read, toast and return (modal never opens, so nothing blanks).
    // Sort 'created' keeps first-appearance (entry) order for the person dropdown.
    let recs;
    try {
        recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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
    // Server-direct (Pho Oct 27): sync to PocketBase so Agent can also block.
    // Returns true only if the server write landed; on failure an error toast
    // shows and callers must NOT show their success toast.
    const s = state.sessions.find((x) => x.id === sessionId);
    if (s) {
        s.blocked_numbers = JSON.stringify(clean);
        try {
            await direct.withRetry(() => direct.directSave('sessions', s));
        } catch (e) {
            showToast('❌ ' + (e.message || e));
            return false;
        }
    }
    return true;
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
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                const cur = getBlocked(sessionId).filter((n) => n !== b.dataset.unblock);
                const ok = await setBlocked(sessionId, cur);
                refresh();
                if (ok) showToast('🗑️ ဖြုတ်ပြီးပြီ');
            });
        });
    };
    const addNum = async () => {
        const v = $('blockedInput').value.replace(/\D/g, '').slice(-2).padStart(2, '0');
        if (!/^\d{2}$/.test(v)) { showToast('ဂဏန်း ၂ လုံး ထည့်ပါ'); return; }
        const cur = getBlocked(sessionId);
        if (cur.includes(v)) { showToast('ထည့်ပြီးသား ဖြစ်နေပါတယ်'); return; }
        const ok = await setBlocked(sessionId, cur.concat([v]));
        $('blockedInput').value = '';
        refresh();
        if (ok) showToast(`🚫 ${v} ပိတ်ပြီးပြီ`);
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
    // Server-direct: records come from the server, not local DB.
    // On a failed read, toast and return (modal never opens, so nothing blanks).
    let recs;
    try {
        recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    // On a failed wins read, keep the previous content (never blank it).
    let wins;
    try {
        wins = await _getWins(sessionId);
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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
    // Server-direct (Pho Oct 27): voucher records come from the server, not local DB.
    // Server rows carry ISO `created`; sort oldest-first on numeric created
    // (fallback _updated), same shape as the old local sort.
    const rows = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
    const recs = normServerRows(rows);
    const createdMs = (r) => {
        const c = r.created;
        if (typeof c === 'string') { const t = Date.parse(c); return Number.isNaN(t) ? 0 : t; }
        return c || 0;
    };
    return recs.slice().sort((a, b) =>
        (createdMs(a) || a._updated || 0) - (createdMs(b) || b._updated || 0));
}

function voucherPersonKey(r) {
    // Pho Oct 18: group by person_id when present (same-name persons stay separate).
    // Agent-synced: group under agent_name only (hide individual player names in Master).
    if (r.person_id) return 'id:' + r.person_id;
    if (r.agent_name && r.player_name && r.agent_name !== r.player_name) return r.agent_name;
    return r.player_name || r.agent_name || '';
}
function voucherPersonLabel(k) {
    // Pho Oct 18: 'id:xxx' keys resolve to the agent's name for display.
    if (k && k.startsWith('id:')) {
        const a = (state.agents || []).find((x) => x.id === k.slice(3));
        return (a && a.name) || 'ကိုယ်တိုင်';
    }
    return k || 'ကိုယ်တိုင်';
}

function fillSessionSelect(sel, selectedId) {
    sel.innerHTML = state.sessions.map((s) =>
        `<option value="${escHtml(s.id)}"${s.id === selectedId ? ' selected' : ''}>${escHtml(sessionLabel(s))}</option>`
    ).join('');
}

/** Voucher formula-group expansion row (စာရင်းဖြေ): the group's numbers, hidden until the formula row is tapped. */
function voucherExpandRow(grp, winNums) {
    const chips = grp.map((r) => {
        const ns = String(r.number).padStart(2, '0');
        return '<span class="vx-chip' + (winNums.has(ns) ? ' win' : '') + '">' + ns + ' · ' + formatMoney(r.amount) + '</span>';
    }).join('');
    return '<tr class="vx-row" hidden><td colspan="2"><div class="vx-grid">' + chips + '</div></td></tr>';
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
    // On a failed read, keep the previous voucher content (never blank it).
    let recs;
    try {
        recs = await sessionRecordsOrdered(sid);
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }

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

    // On a failed read, keep the previous voucher content (never blank it).
    let recs;
    try {
        recs = await sessionRecordsOrdered(sid);
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
    if (sel !== '__all') recs = recs.filter((r) => voucherPersonKey(r) === sel);
    if (!recs.length) {
        box.innerHTML = '<div class="empty">စာရင်း မရှိသေးပါ</div>';
        state.lastVoucherText = '';
        return;
    }

    // Winning numbers for yellow highlight
    // On a failed read, keep the previous voucher content (never blank it).
    let wins;
    try {
        wins = await _getWins(sid);
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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
        const batches = batchOrder.map((b, i) => {
            // Pho: NO dedup — duplicates are legitimate and must all show
            const items = byBatch[b];
            return { label: 'NO ' + (i + 1), items };
        });
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
            // Group by formula_text for compact display (e.g. "အပူး 500" (10) 5000)
            const byFormula = {};
            const formulaOrder = [];
            b.items.forEach((r) => {
                const ft = (r.formula_text || '').trim();
                const key = ft || `__single__${r.id}`;
                if (!byFormula[key]) { byFormula[key] = []; formulaOrder.push(key); }
                byFormula[key].push(r);
            });
            const rowsHtml = formulaOrder.map((key) => {
                const grp = byFormula[key];
                if (grp.length > 1) {
                    // Compact: formula text + (count) total
                    const ft = (grp[0].formula_text || '').trim();
                    const cnt = grp.length;
                    const total = grp.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                    const ids = grp.map((r) => r.id).join(',');
                    return '<tr data-rids="' + escHtml(ids) + '" style="user-select:none;-webkit-user-select:none;"><td>' + escHtml(ft) + '</td>' +
                        '<td>(' + cnt + ') ' + formatMoney(total) + '</td></tr>' + voucherExpandRow(grp, winNums);
                } else {
                    const r = grp[0];
                    const numStr = String(r.number).padStart(2, '0');
                    const isWin = winNums.has(numStr);
                    return '<tr data-rid="' + escHtml(r.id) + '"' + (isWin ? ' class="win-row"' : '') + '><td' + (isWin ? ' class="win-cell"' : '') + '>' +
                        escHtml(numStr) + '</td>' +
                        '<td' + (isWin ? ' class="win-cell"' : '') + '>' + formatMoney(r.amount) + '</td></tr>';
                }
            }).join('');
            html += '<div class="v-batch"><div class="v-batch-no">' + escHtml(b.label) + '</div>' +
                '<table class="v-table"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th></tr></thead><tbody>' +
                rowsHtml +
                '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(bTotal) + '</td></tr></tfoot></table></div>';
        });
        html += '</div>';
    });
    box.innerHTML = html;

    // Plain text (Pho's format: name → NO X → lines → Total per batch)
    // Compact: "အပူး 500 (10) 5000" for formula groups
    const lines = [];
    players.forEach((p, pi) => {
        if (pi > 0) lines.push('');
        lines.push((p.isAkan ? '⬆️ ' : '') + p.label);
        p.batches.forEach((b, bi) => {
            if (bi > 0) lines.push('');
            lines.push(b.label);
            let bTotal = 0;
            const byF = {};
            const fOrder = [];
            b.items.forEach((r) => {
                const ft = (r.formula_text || '').trim();
                const key = ft || `__s__${r.id}`;
                if (!byF[key]) { byF[key] = []; fOrder.push(key); }
                byF[key].push(r);
            });
            fOrder.forEach((key) => {
                const grp = byF[key];
                if (grp.length > 1) {
                    const ft = (grp[0].formula_text || '').trim();
                    const total = grp.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                    bTotal += total;
                    lines.push(`${ft} (${grp.length}) ${total}`);
                } else {
                    const r = grp[0];
                    const amt = Number(r.amount) || 0;
                    bTotal += amt;
                    lines.push(String(r.number).padStart(2, '0') + ' ' + amt);
                }
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
    // Server-direct: records come from the server, not local DB.
    const recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: `session = "${sessionId}"`, sort: 'created' }));
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
    // Over-limit card's own bookie selector fills in the BACKGROUND — the
    // table below must not wait for it (speed fix, Pho Oct 28). A current
    // selection always wins over a stale in-flight fill.
    const overSel = $('overBookieSelect');
    if (overSel) {
        const prevOver = overSel.value;
        getAkanBookieNames().then((overNames) => {
            const cur = overSel.value;
            overSel.innerHTML = '<option value="">-- အကန်ဒိုင်ရွေးရန် --</option>' +
                overNames.map((k) => '<option value="' + escHtml(k) + '">' + escHtml(k) + '</option>').join('');
            if (cur && overNames.includes(cur)) overSel.value = cur;
            else if (prevOver && overNames.includes(prevOver)) overSel.value = prevOver;
        }).catch(() => { /* keep previous options on a failed read */ });
    }
    // On a failed read, keep the previous content (never blank it).
    let limit, over;
    try {
        ({ limit, over } = await calcOverlimit(sid));
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
    }
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
    // Over-limit card's own bookie selector first, main screen's selector as fallback.
    const bookie = (($('overBookieSelect') && $('overBookieSelect').value) || ($('akanBookieSelect') && $('akanBookieSelect').value) || '').trim() || null;
    if (!bookie) { showToast('❌ ဒိုင် နာမည် ရွေးပါ'); return; }
    // Keep the akan screen on the same bookie when we navigate there.
    if ($('akanBookieSelect')) $('akanBookieSelect').value = bookie;
    validItems.forEach((it) => {
        addAkanUnique(bookie, it.number, it.amount);
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
/** Add to akanPending, skipping exact duplicates. */
function addAkanUnique(bookie, number, amount) {
    const num = String(number).padStart(2, '0');
    const amt = Number(amount) || 0;
    const exists = akanPending.some((e) =>
        (e.player_name || '') === (bookie || '') &&
        String(e.number).padStart(2, '0') === num &&
        (Number(e.amount) || 0) === amt
    );
    if (!exists) {
        akanPending.push({ player_name: bookie, number: num, amount: amt, record_type: 'akan' });
        return true;
    }
    return false;
}
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
/** Bookie names for the akan selectors: distinct names from prior OUTGOING
    (akan) bets, all sessions, plus registered အကန်ဒိုင် persons.
    Throws on a failed read — callers keep their previous options. */
async function getAkanBookieNames() {
    // Speed fix (Pho Oct 28): ONE query for all OUTGOING (akan) bets, not one
    // request per session — the per-session loop got slower as sessions piled up.
    // Order is first-appearance by record creation, same as before for a dropdown.
    const seen = new Set();
    const order = [];
    const recs = await direct.withRetry(() => direct.directList('lottery_records', state.tenantPbId, { filter: 'record_type = "akan"', sort: 'created' }));
    for (const r of recs) {
        const k = (r.player_name || r.agent_name || '').trim();
        if (k && !seen.has(k)) { seen.add(k); order.push(k); }
    }
    for (const a of state.agents || []) {
        if ((a.person_type || 'agent') !== 'akan') continue;
        const k = (a.name || '').trim();
        if (k && !seen.has(k)) { seen.add(k); order.push(k); }
    }
    return order;
}

async function renderAkanBookieOptions() {
    const sel = $('akanBookieSelect');
    const prev = sel.value;
    let order;
    try {
        order = await getAkanBookieNames();
    } catch (e) {
        showToast('❌ ' + (e.message || e));
        return;
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
    if (!bookie) { showToast('❌ ဒိုင် နာမည် ရွေးပါ'); return; }
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
        addAkanUnique(bookie, it.number, it.amount);
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
    // H1 fix (Oct 28): track this attempt's rows so a failure can roll them
    // back and a retry can never duplicate them (same pattern as entry save).
    const savedIds = [];
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
                // Server-direct (Pho Oct 27): same field set createRecord sent
                // (id + tenant + the akan fields); directCreate strips _updated
                // and the server sets created/updated itself. withRetry retries
                // line blips; a persistent failure lands in the catch below —
                // pending is NOT cleared and no false success is shown.
                // H1 fix (Oct 28): build the record (with its id) ONCE
                // outside withRetry — a lost-response retry must reuse the
                // same id so directCreate's duplicate protection holds.
                const rec = {
                    id: uid(),
                    tenant: state.tenantPbId,
                    session: state.activeSessionId,
                    session_date: sess2 ? sess2.date : null,
                    session_timeType: sess2 ? sess2.timeType : null,
                    number: String(e.number).padStart(2, '0'),
                    amount: Number(e.amount) || 0,
                    agent_name: e.player_name || '',
                    player_name: e.player_name || '',
                    record_type: 'akan',
                    batch_no: batchNo,
                };
                await direct.withRetry(() => direct.directCreate('lottery_records', rec));
                savedIds.push(rec.id);
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
        // Roll back this attempt's rows (best-effort) so the pending table
        // stays intact and a retry saves a clean batch.
        for (const id of savedIds) {
            try { await direct.directDelete('lottery_records', id); } catch (_) { /* keep going */ }
        }
        showToast('သိမ်းမရပါ: ' + e.message);
    } finally {
        akanSaveInFlight = false;
    }
};

/* ============ AGENT MANAGEMENT (default 5 per buyer, Pho can raise) ============ */
const DEFAULT_MAX_AGENTS = 5;

async function getAgentLimit(tenantId) {
    try {
        const key = `agent_limit_${tenantId}`;
        const rec = await pb.list('app_settings', { filter: `key="${key}"`, perPage: 1 });
        const item = (rec.items || rec)[0];
        if (item && item.value) {
            const n = parseInt(item.value, 10);
            if (n >= 1 && n <= 99) return n;
        }
    } catch (e) { /* ignore */ }
    return DEFAULT_MAX_AGENTS;
}

async function setAgentLimit(tenantId, limit) {
    const key = `agent_limit_${tenantId}`;
    try {
        const rec = await pb.list('app_settings', { filter: `key="${key}"`, perPage: 1 });
        const item = (rec.items || rec)[0];
        if (item) {
            await pb.update('app_settings', item.id, { value: String(limit) });
        } else {
            await pb.create('app_settings', { key, value: String(limit), tenant: tenantId });
        }
    } catch (e) {
        showToast('❌ ' + (e.message || 'error'));
    }
}

async function renderAgentList() {
    const box = $('agentListSettings');
    if (!box) return;
    // Get tenant ID from state or directly from logged-in user (handle both string ID and expanded object)
    let tenantId = state.tenantPbId;
    if (!tenantId && state.user && state.user.tenant) {
        tenantId = typeof state.user.tenant === 'string' ? state.user.tenant : state.user.tenant.id;
    }
    if (!tenantId) {
        box.innerHTML = '<div class="muted">—</div>';
        return;
    }
    try {
        box.innerHTML = '<div class="muted">ရှာနေတယ်…</div>';
        const maxAgents = await getAgentLimit(tenantId);
        // Find agent accounts for this tenant by name (email hidden by PocketBase)
        // Agents are named "Agent N" or "Agent N (Shop)"; match by tenant + name pattern
        let agents = [];
        try {
            const res = await pb.list('users', { perPage: 100 });
            const allUsers = (res.items || res);
            agents = allUsers.filter((u) => {
                const uTenant = typeof u.tenant === 'string' ? u.tenant : (u.tenant && u.tenant.id);
                if (uTenant !== tenantId) return false;
                // Match by name prefix "Agent N" OR by email pattern agent_<tenantId>_<n>@2dpro.local
                // (Pho Oct 19: some agent accounts have custom display names like Bb/Ss/Ld)
                const name = (u.name || '').trim();
                if (name.toLowerCase().startsWith('agent ')) return true;
                const email = (u.email || '').toLowerCase();
                return email.startsWith(`agent_${tenantId.toLowerCase()}_`) && email.endsWith('@2dpro.local');
            });
            // Sort by agent number extracted from name
            agents.sort((a, b) => {
                const ma = (a.name || '').match(/agent\s+(\d+)/i);
                const mb = (b.name || '').match(/agent\s+(\d+)/i);
                return (ma ? parseInt(ma[1], 10) : 0) - (mb ? parseInt(mb[1], 10) : 0);
            });
        } catch (e) { /* ignore, show empty */ }
        let html = '<div style="overflow-x:auto"><table class="v-table"><thead><tr><th>Agent</th><th>Code</th><th>အခြေအနေ</th><th></th></tr></thead><tbody>';
        let count = 0;
        for (const agent of agents) {
            const m = (agent.name || '').match(/agent\s+(\d+)/i);
            const n = m ? parseInt(m[1], 10) : 0;
            if (!n) continue;
            count++;
            const disabled = !!agent.disabled;
            html += '<tr>' +
                '<td>' + escHtml(agent.name || `Agent ${n}`) + '</td>' +
                '<td><button class="btn small" style="padding:4px 8px;font-size:12px;background:#1e3a5f;color:#7dd3fc;border:1px solid #2d5a8f" onclick="regenerateAgentCode(\'' + agent.id + '\',' + n + ',\'' + tenantId + '\',\'' + escHtml(agent.name || `Agent ${n}`).replace(/'/g, "\\'") + '\')">🔑 Code အသစ်</button></td>' +
                '<td>' + (disabled ? '<span style="color:#ef4444">🔴 ပိတ်</span>' : '<span style="color:#4ade80">🟢 ဖွင့်</span>') + '</td>' +
                '<td style="white-space:nowrap"><button class="btn small ' + (disabled ? 'gray' : 'red') + '" style="padding:4px 8px;font-size:12px" onclick="toggleAgentDisabled(\'' + agent.id + '\',' + (!disabled) + ')">' + (disabled ? 'ဖွင့်' : 'ပိတ်') + '</button>' +
                '<button class="btn small" style="padding:4px 8px;font-size:12px;background:#374151;color:#fca5a5;border:1px solid #4b5563;margin-left:4px" onclick="deleteAgentAccount(\'' + agent.id + '\',\'' + escHtml(agent.name || `Agent ${n}`).replace(/'/g, "\\'") + '\')">🗑️</button></td>' +
                '</tr>';
        }
        html += '</tbody></table></div>';
        if (!count) html = '<div class="muted">Agent မရှိသေးပါ</div>';
        else html += `<div class="small muted mt">${count}/${maxAgents} သုံး ပြီးပြီ</div>`;
        box.innerHTML = html;
        const btn = $('agentCreateBtn');
        if (btn) btn.disabled = count >= maxAgents;
    } catch (e) {
        box.innerHTML = '<div class="muted">မရဘူး: ' + escHtml(e.message || 'error') + '</div>';
    }
}

window.toggleAgentDisabled = async function toggleAgentDisabled(agentId, disable) {
    const action = disable ? 'ပိတ်' : 'ဖွင့်';
    if (!confirm(`ဒီ agent ကို ${action}မလား?`)) return;
    try {
        await pb.update('users', agentId, { disabled: disable });
        showToast(disable ? '🔴 ပိတ်ပြီးပြီ' : '🟢 ဖွင့်ပြီးပြီ');
        renderAgentList();
    } catch (e) {
        let msg = e.message || 'error';
        // Show PocketBase validation details if available
        try {
            const data = e.response?.data?.data;
            if (data) {
                const details = Object.entries(data).map(([k, v]) => `${k}: ${v.message || v.code || 'invalid'}`).join(', ');
                if (details) msg += ` (${details})`;
            }
        } catch (_) { /* ignore */ }
        showToast('❌ ' + msg);
    }
};

/** Delete an agent account permanently (seller only). */
window.deleteAgentAccount = async function deleteAgentAccount(agentId, agentName) {
    if (!confirm(`"${agentName}" ကို အပြီးဖျက်မလား? (ပြန်မရဘူး)`)) return;
    if (!confirm('သေချာလား? နောက်ဆုံး အကြိမ် မေးတာ')) return;
    try {
        await pb.del('users', agentId);
        showToast('🗑️ ဖျက်ပြီးပြီ');
        renderAgentList();
    } catch (e) {
        showToast('❌ ' + (e.message || 'error'));
    }
};

window.createAgentAccount = async function createAgentAccount() {
    const tenantId = state.tenantPbId;
    if (!tenantId) {
        showToast('❌ Tenant မရှိပါ');
        return;
    }
    // Enforce agent limit (server-side check)
    try {
        const maxAgents = await getAgentLimit(tenantId);
        const res = await pb.list('users', { perPage: 100 });
        const allUsers = (res.items || res);
        let agentCount = 0;
        for (const u of allUsers) {
            const name = (u.name || '').trim();
            if (!name.toLowerCase().startsWith('agent ')) continue;
            const uTenant = typeof u.tenant === 'string' ? u.tenant : (u.tenant && u.tenant.id);
            if (uTenant === tenantId) agentCount++;
        }
        if (agentCount >= maxAgents) {
            showToast(`❌ Agent ${maxAgents} ဦးပြည့်နေပြီ (Main Admin ခွင့်ပြုမှရမယ်)`);
            return;
        }
    } catch (e) {
        console.warn('agent limit check failed', e);
        // Continue anyway if check fails (don't block on error)
    }
    // Simple: ask for agent number directly (1-99)
    const numInput = prompt('Agent နံပါတ် (1-99):', '2');
    if (!numInput) return;
    const nextNum = parseInt(numInput, 10);
    if (isNaN(nextNum) || nextNum < 1 || nextNum > 99) {
        showToast('❌ 1-99 ကြား ထည့်ပါ');
        return;
    }
    const agentName = prompt(`Agent ${nextNum} နာမည်:`, `Agent ${nextNum}`);
    if (!agentName) return;
    try {
        const email = agentEmailForNum(tenantId, nextNum);
        const secret = generateAgentSecret();
        const pass = agentPasswordForNum(tenantId, nextNum, secret);
        await pb.create('users', {
            email: email,
            password: pass,
            passwordConfirm: pass,
            name: agentName.trim(),
            tenant: tenantId
        });
        const code = agentCodeFor(tenantId, nextNum, secret);
        renderAgentList();
        // Show code in a copyable dialog
        prompt(`✅ Agent ဖန်တီးပြီးပြီ\nCode (ကူးယူပါ):`, code);
    } catch (e) {
        let msg = e.message || 'error';
        try {
            const respData = e.response && e.response.data;
            if (respData) {
                msg += ' | ' + JSON.stringify(respData).slice(0, 300);
            }
        } catch (_) {}
        showToast('❌ ' + msg);
        console.error('createAgentAccount failed:', e);
    }
};

/** Pho Oct 19: Regenerate an agent's link code (new secret).
 *  PocketBase does not allow users to update another user's password via client API,
 *  so we delete and recreate the agent account with the same number but new secret.
 *  Old codes stop working immediately. Shows the new code once. */
window.regenerateAgentCode = async function regenerateAgentCode(agentId, agentNum, tenantId, agentName) {
    if (!confirm(`Agent ${agentNum} ရဲ့ Code အသစ်ထုတ်မလား?\n(အဟောင်း code တွေ သုံးမရတော့ဘူး)`)) return;
    try {
        // Delete the old account
        await pb.del('users', agentId);
        // Recreate with same number, new secret
        const secret = generateAgentSecret();
        const pass = agentPasswordForNum(tenantId, agentNum, secret);
        const email = agentEmailForNum(tenantId, agentNum);
        await pb.create('users', {
            email: email,
            password: pass,
            passwordConfirm: pass,
            name: agentName || `Agent ${agentNum}`,
            tenant: tenantId
        });
        const code = agentCodeFor(tenantId, agentNum, secret);
        renderAgentList();
        prompt(`✅ Code အသစ်ရပြီ\n(ကူးယူပါ — ဒီတစ်ခါပဲ ပြမယ်):`, code);
    } catch (e) {
        let msg = e.message || 'error';
        try {
            const respData = e.response && e.response.data;
            if (respData && respData.message) msg = respData.message;
        } catch (_) {}
        showToast('❌ ' + msg);
        renderAgentList();
    }
};

/* Pho: Edit agent limit for a buyer */
window.editAgentLimit = async function editAgentLimit(tenantId, currentLimit) {
    if (!tenantId) {
        showToast('❌ Tenant မရှိပါ');
        return;
    }
    const input = prompt(`Agent limit (ခု ${currentLimit}):`, String(currentLimit));
    if (!input) return;
    const n = parseInt(input, 10);
    if (isNaN(n) || n < 1 || n > 99) {
        showToast('❌ 1-99 ကြား ထည့်ပါ');
        return;
    }
    await setAgentLimit(tenantId, n);
    showToast(`✅ Agent limit → ${n}`);
    renderBuyerList();
};

/* 🔄 App Reset: clear all local data and reload */
async function resetApp() {
    if (!confirm('App data အကုန် ရှင်း မလား? (login ပြန် ဝင် ရ မယ်)')) return;
    // Server-direct (Pho Oct 27): no local DB to wipe — clear storage and reload.
    // App Reset = အထဲမှာ ဘာမှမရှိရတော့ဘူး, အကုန် clear. Reload lands on the
    // login screen (pb_auth + saved credentials live in localStorage).
    // NOTE (final sweep, Pho Oct 27): stale IndexedDB bytes may remain on disk,
    // but the app never reads them; the database file itself is left in place.
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
    location.reload();
}

/* 🗑️ Nuclear Wipe: delete ALL server data for tenant + clear local */
async function nuclearWipe() {
    if (!confirm('⚠️ Server + App data အကုန် ဖျက်မလား?\nပွဲစဥ်၊ စာရင်း၊ ပေါက်သီး အကုန် ပျက်မယ် — ပြန်မရဘူး!')) return;
    if (!confirm('သေချာလား? အကုန် ပျက်မယ်!')) return;
    const tid = state.tenantPbId;
    if (!tid) { showToast('❌ Tenant မရှိ'); return; }
    showToast('🗑️ Server ရှင်းနေတယ်...');
    try {
        // Delete all lottery_records for tenant
        const recs = await pb.listAll('lottery_records', { filter: `tenant="${tid}"` });
        for (const r of recs) {
            try { await pb.del('lottery_records', r.id); } catch (e) { /* ignore */ }
        }
        // Delete all winning_numbers for tenant
        const wns = await pb.listAll('winning_numbers', { filter: `tenant="${tid}"` });
        for (const w of wns) {
            try { await pb.del('winning_numbers', w.id); } catch (e) { /* ignore */ }
        }
        // Delete all sessions for tenant
        const sess = await pb.listAll('sessions', { filter: `tenant="${tid}"` });
        for (const s of sess) {
            try { await pb.del('sessions', s.id); } catch (e) { /* ignore */ }
        }
        showToast(`✅ Server ရှင်းပြီးပြီ (${recs.length + wns.length + sess.length} ခု)`);
    } catch (e) {
        showToast('❌ Server ရှင်းမရဘူး: ' + e.message);
        return;
    }
    // Local IndexedDB is no longer used — nothing local left to clear.
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
    location.reload();
}

/** Long-press Edit/Delete for voucher rows (Pho's spec: nothing shows until long-press) */
(function() {
    let pressTimer = null;
    let pressTarget = null;
    const clearPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        pressTarget = null;
    };
    const onPressStart = (e) => {
        const trG = e.target.closest ? e.target.closest('tr[data-rids]') : null;
        if (trG) {
            pressTarget = trG;
            pressTimer = setTimeout(() => {
                showGroupMenu(pressTarget.getAttribute('data-rids'), e);
                clearPress();
            }, 600);
            return;
        }
        const tr = e.target.closest('tr[data-rid]');
        if (!tr) return;
        pressTarget = tr;
        pressTimer = setTimeout(() => {
            showEditDeleteMenu(pressTarget.getAttribute('data-rid'), e);
            clearPress();
        }, 600);
    };
    document.addEventListener('touchstart', onPressStart, { passive: true });
    document.addEventListener('touchend', clearPress);
    document.addEventListener('touchmove', clearPress);
    document.addEventListener('mousedown', (e) => { if (e.button === 0) onPressStart(e); });
    document.addEventListener('mouseup', clearPress);
    window.showEditDeleteMenu = function(rid, e) {
        closeEditDeleteMenu();
        const menu = document.createElement('div');
        menu.id = 'editDeleteMenu';
        menu.style.cssText = 'position:fixed;z-index:9999;background:#1e293b;border:1px solid #3b82f6;border-radius:8px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.5);';
        const x = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) || window.innerWidth/2;
        const y = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) || window.innerHeight/2;
        menu.style.left = Math.min(x, window.innerWidth - 140) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
        menu.innerHTML =
            '<button onclick="openEditRecord(\'' + rid + '\')" style="display:block;width:100%;padding:8px 16px;margin:4px 0;background:#3b82f6;color:white;border:none;border-radius:4px;">✏️ ပြင်</button>' +
            '<button onclick="deleteRecord(\'' + rid + '\')" style="display:block;width:100%;padding:8px 16px;margin:4px 0;background:#ef4444;color:white;border:none;border-radius:4px;">🗑️ ဖျက်</button>';
        document.body.appendChild(menu);
        setTimeout(() => { document.addEventListener('click', closeEditDeleteMenu, { once: true }); }, 100);
    };
    window.closeEditDeleteMenu = function() {
        const m = document.getElementById('editDeleteMenu');
        if (m) m.remove();
        const em = document.getElementById('editRecordModal');
        if (em) em.remove();
    };
    window.openEditRecord = async function(rid) {
        closeEditDeleteMenu();
        try {
            // Server-direct (Pho Oct 27): directGet throws on 404, so a missing
            // record maps to the same 'မတွေ့ပါ' alert as the old db.get undefined.
            let r = null;
            try { r = await direct.directGet('lottery_records', rid); } catch (e) { r = null; }
            if (!r) { alert('မတွေ့ပါ'); return; }
            const modal = document.createElement('div');
            modal.id = 'editRecordModal';
            modal.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
            modal.innerHTML =
                '<div style="background:#1e293b;border:1px solid #3b82f6;border-radius:12px;padding:20px;min-width:280px;">' +
                '<h3 style="color:white;margin:0 0 16px;">ပြင်</h3>' +
                '<label style="color:#94a3b8;display:block;margin-bottom:8px;">ဂဏန်း</label>' +
                '<input id="editNum" type="text" value="' + escHtml(r.number) + '" style="width:100%;padding:8px;margin-bottom:12px;background:#0f172a;color:white;border:1px solid #334155;border-radius:4px;">' +
                '<label style="color:#94a3b8;display:block;margin-bottom:8px;">ပမာဏ</label>' +
                '<input id="editAmt" type="number" value="' + r.amount + '" style="width:100%;padding:8px;margin-bottom:16px;background:#0f172a;color:white;border:1px solid #334155;border-radius:4px;">' +
                '<div style="display:flex;gap:8px;">' +
                '<button onclick="saveEditRecord(\'' + rid + '\')" style="flex:1;padding:10px;background:#3b82f6;color:white;border:none;border-radius:4px;">သိမ်း</button>' +
                '<button onclick="closeEditDeleteMenu()" style="flex:1;padding:10px;background:#475569;color:white;border:none;border-radius:4px;">ပိတ်</button>' +
                '</div></div>';
            document.body.appendChild(modal);
        } catch (e) { alert('Error: ' + e.message); }
    };
    window.saveEditRecord = async function(rid) {
        const num = document.getElementById('editNum').value.trim();
        const amt = Number(document.getElementById('editAmt').value);
        if (!num || !(amt > 0)) { alert('မှန်ကန်စွာ ဖြည့်ပါ'); return; }
        try {
            // Server-direct (Pho Oct 27): verify existence first (same silent
            // return as before), then update ONLY number+amount — exactly what
            // the old sync.mutate sent; other server fields stay untouched.
            let r = null;
            try { r = await direct.directGet('lottery_records', rid); } catch (e) { r = null; }
            if (!r) return;
            await direct.withRetry(() => direct.directSave('lottery_records', { id: rid, number: num, amount: amt }));
            closeEditDeleteMenu();
            if (window.refreshVoucherView) await window.refreshVoucherView();
            else location.reload();
        } catch (e) { alert('Error: ' + e.message); }
    };
    window.deleteRecord = async function(rid) {
        closeEditDeleteMenu();
        if (!confirm('ဖျက်မလား?')) return;
        try {
            // Server-direct (Pho Oct 27): directDelete treats 404 as success.
            await direct.withRetry(() => direct.directDelete('lottery_records', rid));
            if (window.refreshVoucherView) await window.refreshVoucherView();
            else location.reload();
        } catch (e) { alert('Error: ' + e.message); }
    };

    // Pho Oct 20: Long-press on GROUPED formula rows — edit/delete the whole group.
    // Grouped rows carry data-rids (all record IDs in the formula group).
    let _grpIds = [];
    const _grpRefresh = async () => {
        if (window.refreshVoucherView) await window.refreshVoucherView();
        else location.reload();
    };
    window.showGroupMenu = function(ridsStr, e) {
        closeEditDeleteMenu();
        const menu = document.createElement('div');
        menu.id = 'editDeleteMenu';
        menu.style.cssText = 'position:fixed;z-index:9999;background:#1e293b;border:1px solid #3b82f6;border-radius:8px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.5);';
        const x = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) || window.innerWidth/2;
        const y = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) || window.innerHeight/2;
        menu.style.left = Math.min(x, window.innerWidth - 140) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
        menu.innerHTML =
            '<button onclick="openEditGroup(\'' + ridsStr + '\')" style="display:block;width:100%;padding:8px 16px;margin:4px 0;background:#3b82f6;color:white;border:none;border-radius:4px;">✏️ ပြင်</button>' +
            '<button onclick="deleteRecordGroup(\'' + ridsStr + '\')" style="display:block;width:100%;padding:8px 16px;margin:4px 0;background:#ef4444;color:white;border:none;border-radius:4px;">🗑️ အကုန် ဖျက်</button>';
        document.body.appendChild(menu);
        setTimeout(() => { document.addEventListener('click', closeEditDeleteMenu, { once: true }); }, 100);
    };
    window.openEditGroup = async function(ridsStr) {
        closeEditDeleteMenu();
        _grpIds = ridsStr.split(',').filter(Boolean);
        await renderGroupModal();
    };
    async function renderGroupModal() {
        const old = document.getElementById('editRecordModal');
        if (old) old.remove();
        const recs = [];
        for (const id of _grpIds) {
            // Server-direct (Pho Oct 27): retried read; a record still missing
            // after retries drops from _grpIds below, as before.
            try {
                const r = await direct.withRetry(() => direct.directGet('lottery_records', id));
                if (r) recs.push(r);
            } catch (e) { /* gone — dropped */ }
        }
        _grpIds = recs.map((r) => r.id);
        if (!recs.length) { closeEditDeleteMenu(); await _grpRefresh(); return; }
        const ft = (recs[0].formula_text || '').trim();
        let rows = '';
        for (const r of recs) {
            rows += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
                '<input id="gNum_' + r.id + '" type="text" value="' + escHtml(r.number) + '" style="width:56px;padding:6px;background:#0f172a;color:white;border:1px solid #334155;border-radius:4px;">' +
                '<input id="gAmt_' + r.id + '" type="number" value="' + r.amount + '" style="flex:1;padding:6px;background:#0f172a;color:white;border:1px solid #334155;border-radius:4px;">' +
                '<button onclick="deleteOneInGroup(\'' + r.id + '\')" style="padding:6px 10px;background:#ef4444;color:white;border:none;border-radius:4px;">ဖျက်</button></div>';
        }
        const modal = document.createElement('div');
        modal.id = 'editRecordModal';
        modal.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
        modal.innerHTML =
            '<div style="background:#1e293b;border:1px solid #3b82f6;border-radius:12px;padding:20px;min-width:300px;max-width:92vw;max-height:84vh;display:flex;flex-direction:column;">' +
            '<h3 style="color:white;margin:0 0 6px;">ပြင် — ' + escHtml(ft) + '</h3>' +
            '<div style="color:#94a3b8;margin-bottom:12px;">' + recs.length + ' ကွက်</div>' +
            '<div style="overflow-y:auto;">' + rows + '</div>' +
            '<div style="display:flex;gap:8px;margin-top:12px;">' +
            '<button onclick="saveEditGroup()" style="flex:1;padding:10px;background:#3b82f6;color:white;border:none;border-radius:4px;">သိမ်း</button>' +
            '<button onclick="closeEditDeleteMenu()" style="flex:1;padding:10px;background:#475569;color:white;border:none;border-radius:4px;">ပိတ်</button>' +
            '</div></div>';
        document.body.appendChild(modal);
    }
    window.saveEditGroup = async function() {
        try {
            for (const id of _grpIds) {
                const numEl = document.getElementById('gNum_' + id);
                const amtEl = document.getElementById('gAmt_' + id);
                if (!numEl || !amtEl) continue;
                const num = numEl.value.trim();
                const amt = Number(amtEl.value);
                if (!num || !(amt > 0)) { alert('မှန်ကန်စွာ ဖြည့်ပါ'); return; }
                // Server-direct (Pho Oct 27): unchanged rows still skip the write,
                // as before; changed rows update ONLY number+amount.
                let r = null;
                try { r = await direct.withRetry(() => direct.directGet('lottery_records', id)); } catch (e) { r = null; }
                if (!r) continue;
                if (String(r.number) !== num || Number(r.amount) !== amt) {
                    await direct.withRetry(() => direct.directSave('lottery_records', { id, number: num, amount: amt }));
                }
            }
            closeEditDeleteMenu();
            await _grpRefresh();
        } catch (e) { alert('Error: ' + e.message); }
    };
    window.deleteOneInGroup = async function(rid) {
        if (!confirm('ဒီ ၁ ကွက် ဖျက်မလား?')) return;
        try {
            // Server-direct (Pho Oct 27).
            await direct.withRetry(() => direct.directDelete('lottery_records', rid));
            _grpIds = _grpIds.filter((x) => x !== rid);
            if (!_grpIds.length) { closeEditDeleteMenu(); await _grpRefresh(); }
            else await renderGroupModal();
        } catch (e) { alert('Error: ' + e.message); }
    };
    window.deleteRecordGroup = async function(ridsStr) {
        closeEditDeleteMenu();
        const ids = ridsStr.split(',').filter(Boolean);
        let total = 0;
        for (const id of ids) {
            // Server-direct (Pho Oct 27): a missing record contributes 0, as before.
            try {
                const r = await direct.withRetry(() => direct.directGet('lottery_records', id));
                if (r) total += Number(r.amount) || 0;
            } catch (e) { /* gone — contributes 0 */ }
        }
        if (!confirm(ids.length + ' ကွက် လုံး ဖျက်မလား? (စုစုပေါင်း ' + total + ')')) return;
        try {
            for (const id of ids) {
                await direct.withRetry(() => direct.directDelete('lottery_records', id));
            }
            await _grpRefresh();
        } catch (e) { alert('Error: ' + e.message); }
    };
})();


/* Tap a voucher formula row -> toggle its စာရင်းဖြေ expansion.
   A long-press (>500ms) still opens the group menu and must NOT toggle. */
(function () {
    let downAt = 0, downRow = null;
    const mark = (e) => {
        const tr = e.target && e.target.closest ? e.target.closest('tr[data-rids]') : null;
        if (tr) { downAt = Date.now(); downRow = tr; }
    };
    document.addEventListener('touchstart', mark, { passive: true });
    document.addEventListener('mousedown', mark);
    document.addEventListener('click', (e) => {
        const tr = e.target && e.target.closest ? e.target.closest('tr[data-rids]') : null;
        if (!tr) return;
        if (tr === downRow && Date.now() - downAt > 500) return;
        const nx = tr.nextElementSibling;
        if (nx && nx.classList.contains('vx-row')) nx.hidden = !nx.hidden;
    });
})();
