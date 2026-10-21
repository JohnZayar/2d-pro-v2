/**
 * app.js — 2D Agent Pro v2 (local-first, v1-style entry)
 *
 * Screens (home menu):
 *  - entry   : 📝 စာရင်းသွင်းရန် — v1 POS style (boxes + color keypad + numpad + ထည့်မည်)
 *  - records : 📋 စာရင်းများ — voucher batches by player (No1, No2… in entry order)
 *  - players : 👥 လူစာရင်း
 *  - daily   : 📅 တနေ့စာ
 *  - weekly  : 📊 တပတ်စာ
 *
 * Each ထည့်မည် press creates a new batch (No1, No2…) per player per session.
 * Batches keep entry order — never re-sorted — so they match what was sent.
 */

import * as db from '../shared/db.js?v=3';
import * as pb from '../shared/pb.js?v=4';
import * as sync from '../shared/sync-simple.js?v=10';
import { parseBoardReport, parseLine } from '../shared/parser.js?v=15';

// Global safety net: log unhandled promise rejections instead of failing silently.
if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (e) => {
        console.error('[agent] Unhandled rejection:', e.reason);
    });
}
import { uid, formatMoney, formatDateStr, getWeekMonday, showToast, escHtml, debounce, agentEmailFor, agentPasswordFor, agentEmailForNum, agentPasswordForNum, parseAgentCode } from '../shared/utils.js?v=7';

const LS_TENANT = 'v2_agent_tenant';
const LS_AGENT_NAME = 'v2_agent_name';
const LS_SESSION = 'v2_agent_session';

let tenantId = null;
let agentName = null;
let currentSessionId = null;
// Reminder state: session-close warnings + seen winning numbers
const _agentRemind = { warned: {}, knownWins: {} };
let saveInFlight = false; // double-tap guard
let pendingEntries = []; // typed but NOT yet saved: [{player_name, number, amount}]

/** Add to pending, skipping exact duplicates (prevents double-add glitches). */
function addPendingUnique(playerName, number, amount, fromFormula, formulaText, lineIdx) {
    const num = String(number).padStart(2, '0');
    const amt = Number(amount) || 0;
    // Pho: duplicates allowed (e.g. 55x500 then 55x2500) — user deletes mistakes manually
    pendingEntries.push({ player_name: playerName, number: num, amount: amt, fromFormula: !!fromFormula, formula_text: formulaText || '', line_idx: lineIdx ?? -1 });
    return true;
}

/** Formula keywords: board lines containing these expand via formula
 *  — formula-derived numbers are EXCLUDED from hot-number limits.
 *  Exempt (Pho): ပါ/အပါ, ပူး/အပူး, ခွေ/အခွေ, ပတ်/အပတ်, နက္ခတ်/ထိုင်းနက္ခတ်,
 *  ပါဝါ, စုံမ, မစုံ, ထိပ်, နောက်. Only pure direct numbers are blocked. */
const FORMULA_KEYWORDS = ['ပါ', 'ပူး', 'ခွေ', 'ပတ်', 'နက္ခတ်', 'ထိုင်းနက္ခတ်', 'ညီအစ်ကို', 'စုံမ', 'မစုံ', 'ထိပ်', 'နောက်'];
function lineHasFormula(line) {
    const s = String(line || '');
    return FORMULA_KEYWORDS.some((kw) => s.includes(kw));
}

/** Check hot-number limits for this agent: cumulative per (number, session), excluding formula-derived entries. Returns error message or null. */
async function checkAgentLimits() {
    let myLimits = {};
    try {
        const agents = await db.getAll('agents');
        const me = (agents || []).find((a) => (a.name || '') === agentName);
        myLimits = (me && me.limits) || {};
    } catch (e) { /* ignore */ }
    const limitNums = Object.keys(myLimits).filter((n) => Number(myLimits[n]) > 0);
    if (!limitNums.length || !currentSessionId) return null;

    // Pending totals by number (skip formula-derived)
    const pendTotals = {};
    pendingEntries.forEach((e) => {
        if (e.fromFormula) return;
        const num = String(e.number).padStart(2, '0');
        if (!limitNums.includes(num)) return;
        pendTotals[num] = (pendTotals[num] || 0) + (Number(e.amount) || 0);
    });
    if (!Object.keys(pendTotals).length) return null;

    // Existing saved records for this agent + session
    let existing = [];
    try { existing = await db.query('lottery_records', 'by_session', currentSessionId); } catch (e) { /* ignore */ }
    const existTotals = {};
    existing.forEach((r) => {
        if ((r.agent_name || '') !== agentName) return;
        if (r.fromFormula) return; // formula-derived excluded
        const num = String(r.number).padStart(2, '0');
        if (!limitNums.includes(num)) return;
        existTotals[num] = (existTotals[num] || 0) + (Number(r.amount) || 0);
    });

    for (const num of Object.keys(pendTotals)) {
        const lim = Number(myLimits[num]);
        const total = (existTotals[num] || 0) + pendTotals[num];
        if (total > lim) {
            return `ဟော့ဂဏန်း (${num}) Limite ပြည့်လို့ မရတော့ပါ`;
        }
    }
    return null;
}

/** Get blocked numbers for a session (synced from Master via PocketBase). */
async function getAgentBlocked(sessionId) {
    try {
        const s = await db.get('sessions', sessionId);
        if (s && s.blocked_numbers) {
            const arr = JSON.parse(s.blocked_numbers);
            if (Array.isArray(arr)) return arr.filter((n) => /^\d{2}$/.test(n));
        }
    } catch (e) {}
    return [];
}

/** Session lock: 11:55 AM / 3:55 PM cutoff + lock after winning numbers. */
async function isAgentSessionLocked(sessionId) {
    try {
        const s = await db.get('sessions', sessionId);
        if (!s) return { locked: false };
        // manually closed by bookie → locked
        if (s.closed) return { locked: true, reason: 'အချိန်ပြည့်လို့ပိတ်သွားပါပြီ' };
        const wins = await _getWins(sessionId);
        if (wins && wins.length) return { locked: true, reason: 'ပေါက်ဂဏန်း ထည့်ပြီးပြီ' };
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
    } catch (e) {}
    return { locked: false };
}

/* ================= Boot ================= */

document.addEventListener('DOMContentLoaded', init);

/** Robust winning-number lookup: matches by local session ID or server _pbId, no index dependency. */
async function _getWins(sessionId) {
    try {
        const all = await db.getAll('winning_numbers');
        let pbId = null;
        try { const s = await db.get('sessions', sessionId); if (s) pbId = s._pbId; } catch (e) {}
        return all.filter((w) => w.session === sessionId || (pbId && w.session === pbId));
    } catch (e) { return []; }
}

/**
 * Login as the tenant-specific agent account.
 * Each buyer (tenant) has their own agent account for data isolation.
 * Credentials are derived from the link code (tenant PB ID).
 */
async function loginAsTenantAgent() {
    const code = localStorage.getItem(LS_TENANT) || '';
    if (!code) return; // No link code yet — user needs to connect first
    const parsed = parseAgentCode(code);
    if (!parsed) return;
    const { tenantId, agentNum, secret } = parsed;
    const email = agentEmailForNum(tenantId, agentNum);
    // If already logged in as the correct agent, skip
    const current = pb.getUser();
    if (current && current.email === email && pb.isLoggedIn()) return;
    // Log out from any previous account (e.g., different agent or old format)
    pb.logout();
    await pb.login(email, agentPasswordForNum(tenantId, agentNum, secret));
}

/** Check if current agent is disabled; if so, log out. */
async function checkAgentDisabled() {
    try {
        const u = pb.getUser();
        if (!u || !u.id || !pb.isLoggedIn()) return false;
        const rec = await pb.getOne('users', u.id);
        if (rec && rec.disabled) {
            pb.logout();
            showToast('🔴 Disabled — Admin က ပိတ်ထားတယ်');
            // Reload to show login screen
            setTimeout(() => location.reload(), 1500);
            return true;
        }
    } catch (e) { /* ignore - don't block on check failure */ }
    return false;
}

async function init() {
    window.appReady = true; // Pho Oct 18: signals app.js loaded (for offline screen)
    pb.loadBaseUrl(); // custom server URL override (if Pho set one)
    pb.loadAuth();
    // Auto-login as the tenant-specific agent account (if link code is saved)
    // Each buyer has their own agent account for tenant isolation.
    // Pho Oct 19: If a code is saved but login fails, show the link screen
    // with the error (not the app with silent "Local only").
    let autoLoginFailed = false;
    let autoLoginError = '';
    try {
        await loginAsTenantAgent();
    } catch (e) {
        const code = localStorage.getItem(LS_TENANT);
        if (code) {
            autoLoginFailed = true;
            autoLoginError = e.message || String(e);
        }
    }
    try {
        await db.openDB();
    } catch (e) {
        showToast('❌ Local DB ဖွင့်မရပါ: ' + e.message);
        return;
    }

    const savedCode = localStorage.getItem(LS_TENANT) || '';
    const parsedCode = parseAgentCode(savedCode);
    tenantId = parsedCode ? parsedCode.tenantId : savedCode;
    agentName = localStorage.getItem(LS_AGENT_NAME) || '';
    currentSessionId = localStorage.getItem(LS_SESSION) || '';

/** After each background sync: if anything arrived, refresh the UI so
 *  winning numbers / sessions appear without navigating away. */
async function autoSyncRefresh(res) {
    updateSyncPill();
    const pulled = (res && res.pull && res.pull.pulled) || 0;
    if (pulled > 0) {
        await refreshSession();
        refreshActiveScreen();
    }
}

    if (tenantId && agentName && !autoLoginFailed) {
        showApp();
        await refreshSession();
        // Background sync (non-blocking) — refreshes UI when new data arrives
        sync.startAutoSync(60000, autoSyncRefresh);
        // Realtime: winning numbers / session changes arrive in ~1-2s (60s poll stays as backup)
        try {
            pb.realtimeSubscribe(
                ['winning_numbers', 'sessions', 'lottery_records'],
                () => { sync.syncNow().then((res) => autoSyncRefresh(res)).catch(() => updateSyncPill()); }
            );
        } catch (e) { /* realtime optional — poll covers it */ }
        // ⏰ Session-close countdown, every 30s
        updateAgentReminders().catch(() => {});
        setInterval(() => { updateAgentReminders().catch(() => {}); }, 30000);
        sync.syncNow().then(async () => {
            updateSyncPill();
            await refreshSession();
            refreshActiveScreen();
            // Repair `created` wiped by old sync pulls — AFTER sync to avoid races.
            // Visible result so the user can confirm it worked.
            try {
                const res = await sync.repairMissingCreated();
                if (res.fixed > 0) {
                    showToast('🔧 ရက်စွဲ ' + res.fixed + ' ခု ပြန်ဖြည့်ပြီးပြီ');
                    await refreshSession();
                    refreshActiveScreen();
                } else if (res.broken > 0) {
                    showToast('⚠️ ရက်စွဲ ဖြည့်မရပါ — Sync နှိပ်ပြီး app ပြန်ဖွင့်ကြည့်ပါ');
                }
            } catch (e) {}
        }).catch(() => updateSyncPill());
    } else {
        showLinkScreen();
        // Pho Oct 19: If auto-login failed, pre-fill the dead code and show the error
        if (autoLoginFailed) {
            const deadCode = localStorage.getItem(LS_TENANT) || '';
            const deadName = localStorage.getItem(LS_AGENT_NAME) || '';
            try {
                document.getElementById('tenantCodeInput').value = deadCode;
                document.getElementById('agentNameInput').value = deadName;
            } catch (e) {}
            setTimeout(() => showLinkError('Auto-login မရပါ: ' + autoLoginError + ' — Code ပြန်စစ်ပါ'), 300);
        }
    }
    updateSyncPill();
    window.addEventListener('online', updateSyncPill);
    window.addEventListener('offline', updateSyncPill);
    // Phone sleep → foreground: sync immediately so stale data doesn't linger
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && pb.isLoggedIn()) {
            checkAgentDisabled().then((disabled) => {
                if (!disabled) sync.syncNow().then((res) => autoSyncRefresh(res)).catch(() => updateSyncPill());
            });
        }
    });
}

function showLinkScreen() {
    document.getElementById('linkScreen').hidden = false;
    document.getElementById('appScreen').hidden = true;
}

function showApp() {
    document.getElementById('linkScreen').hidden = true;
    document.getElementById('appScreen').hidden = false;
    document.getElementById('headerAgentName').textContent = agentName;
    document.getElementById('headerTenantName').textContent = '🔗 ' + tenantId;
    // Pho Oct 18: show FULL link code (with -N-SECRET), not just tenantId
    document.getElementById('settingsTenantCode').textContent = localStorage.getItem(LS_TENANT) || tenantId;
    document.getElementById('settingsAgentName').textContent = agentName;
}

/* ================= Connect via link code ================= */

window.connectAgent = async function connectAgent() {
    const code = document.getElementById('tenantCodeInput').value.trim();
    const name = document.getElementById('agentNameInput').value.trim();

    if (!code) return showLinkError('Link Code ထည့်ပါ');
    if (!name) return showLinkError('နာမည် ထည့်ပါ');

    const btn = document.getElementById('connectBtn');
    btn.disabled = true;
    btn.textContent = 'ချိတ်နေတယ်…';

    try {
        // Parse agent code: "<tenantId>-<n>" or legacy "<tenantId>"
        const parsed = parseAgentCode(code);
        if (!parsed) return showLinkError('Code မှားနေတယ်');
        const tid = parsed.tenantId;
        // Verify tenant exists: try local DB first, then PocketBase (if logged in).
        let tenant = await db.get('tenants', tid);
        if (!tenant && pb.isLoggedIn()) {
            try {
                const pbTenant = await pb.getOne('tenants', tid);
                tenant = { id: pbTenant.id, name: pbTenant.name };
                await db.put('tenants', tenant);
            } catch (e) { /* not found remotely either */ }
        }
        // Local-first: accept the code even if unverified (works offline).
        if (!tenant) {
            tenant = { id: tid, name: 'Main (' + tid.slice(0, 6) + '…)' };
            await db.put('tenants', tenant);
        }

        tenantId = tid;
        agentName = name;
        // Pho Oct 19: Save code optimistically for loginAsTenantAgent() to read,
        // but REMOVE it if login fails (don't leave bad code saved).

        // Login as this tenant's agent account for isolated sync
        // Pho Oct 19: MUST succeed — if login fails, show the error and stop.
        // (Previously the failure was swallowed and app lied "ချိတ်ပြီးပြီ".)
        localStorage.setItem(LS_TENANT, code);
        localStorage.setItem(LS_AGENT_NAME, name);
        try {
            await loginAsTenantAgent();
        } catch (e) {
            localStorage.removeItem(LS_TENANT);
            localStorage.removeItem(LS_AGENT_NAME);
            btn.disabled = false;
            btn.textContent = 'ချိတ်မယ်';
            return showLinkError('Login မရပါ: ' + (e.message || e));
        }
        // Verify login actually worked
        if (!pb.isLoggedIn()) {
            localStorage.removeItem(LS_TENANT);
            localStorage.removeItem(LS_AGENT_NAME);
            btn.disabled = false;
            btn.textContent = 'ချိတ်မယ်';
            return showLinkError('Login မဝင်ပါ — Code မှားနေနိုင်တယ်');
        }
        // Login succeeded — code stays saved

        showApp();
        await refreshSession();
        sync.startAutoSync(60000, autoSyncRefresh);
        sync.syncNow().then((res) => autoSyncRefresh(res)).catch(() => {});
        showToast('✅ ချိတ်ဆက်ပြီးပြီ');
    } catch (e) {
        showLinkError('ချိတ်မရပါ: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'ချိတ်ဆက်မည်';
    }
};

function showLinkError(msg) {
    const errEl = document.getElementById('linkError');
    errEl.textContent = msg;
    errEl.hidden = false;
}

window.disconnectAgent = async function disconnectAgent() {
    if (!confirm('ထွက်မှာလား?')) return;
    localStorage.removeItem(LS_TENANT);
    localStorage.removeItem(LS_AGENT_NAME);
    localStorage.removeItem(LS_SESSION);
    // Clear IndexedDB so the next tenant doesn't see previous tenant's data.
    // Pho Oct 19: Close DB + await deletion (same race fix as resetApp).
    try { db.closeDB(); } catch (e) { /* ignore */ }
    try {
        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('2dProV2');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
    } catch (e) { /* ignore */ }
    location.reload();
};

/* ================= Sessions ================= */

/** Pick the latest open session for this tenant (local-first). */
async function refreshSession() {
    try {
        const sessions = await getAgentSessions();
        const open = sessions.filter((s) => s.is_open !== false);
        const pick = open[0] || sessions[0] || null;

        if (pick && pick.id !== currentSessionId) {
            currentSessionId = pick.id;
            localStorage.setItem(LS_SESSION, pick.id);
        }
        const banner = document.getElementById('sessionBannerText');
        if (pick) {
            // Prominent winning-number display: 🏆 67 — so agents see it the moment it syncs in.
            let winHtml = '';
            try {
                const wins = await _getWins(pick.id);
                if (wins && wins.length) {
                    // Dedupe: same number from duplicate rows shows only once
                    const uniqNums = [...new Set(wins.map((w) => String(w.number).padStart(2, '0')))];
                    winHtml = ' &nbsp;🏆 <b>' + uniqNums.map((n) => escHtml(n)).join(' ') + '</b>';
                    // 🔔 NEW winning number alert (first sighting only)
                    if (!_agentRemind.knownWins[pick.id]) {
                        _agentRemind.knownWins[pick.id] = true;
                        showToast('🏆 ပေါက်သီး ထွက်ပြီ: ' + uniqNums.join(' '));
                        try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) {}
                    }
                }
            } catch (e) { /* ignore */ }
            banner.innerHTML = '📌 <b>' + escHtml(pick.name || 'Session') + '</b>' + winHtml;
        } else {
            currentSessionId = null;
            localStorage.removeItem(LS_SESSION);
            banner.textContent = 'Session မရှိသေးပါ — Main ဖွင့်မှ ပေါ်မယ်';
        }
    } catch (e) {
        console.warn('[agent] refreshSession failed', e);
    }
}

/** ⏰ Session-close countdown banner for the agent's current session. */
async function updateAgentReminders() {
    const bar = document.getElementById('reminderBar');
    if (!bar || !currentSessionId) { if (bar) bar.style.display = 'none'; return; }
    try {
        const s = await db.get('sessions', currentSessionId);
        if (!s || !s.date || s.closed) { bar.style.display = 'none'; return; }
        const now = new Date();
        const isAM = (s.timeType || '') === 'မနက်ပိုင်း';
        const [hh, mi] = isAM ? [11, 55] : [15, 55];
        const parts = String(s.date).split('.');
        let cutoff;
        if (parts.length === 3) {
            cutoff = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]), hh, mi, 0);
        } else {
            return;
        }
        const msLeft = cutoff.getTime() - now.getTime();
        if (msLeft > 0 && msLeft <= 15 * 60 * 1000) {
            const mins = Math.max(1, Math.ceil(msLeft / 60000));
            bar.className = 'reminder-bar warn';
            bar.textContent = `⏰ ${mins} မိနစ် အလို — ထိုးခွင့် ပိတ်တော့မယ်`;
            bar.style.display = '';
            if (!_agentRemind.warned[s.id]) {
                _agentRemind.warned[s.id] = true;
                try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
            }
        } else {
            bar.style.display = 'none';
        }
    } catch (e) { /* ignore */ }
}

async function getAgentSessions() {
    try {
        const sessions = await db.query('sessions', 'by_tenant', tenantId);
        // Pho Oct 21: NEVER show two sessions for the same day-part.
        // If a duplicate ever slips in, keep the one holding this agent's
        // records (tie: the earliest created) and hide the twin.
        const groups = new Map();
        for (const s of sessions) {
            const key = (s.date || '') + '|' + (s.timeType || '');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(s);
        }
        const out = [];
        for (const grp of groups.values()) {
            if (grp.length === 1) { out.push(grp[0]); continue; }
            let best = grp[0], bestCount = -1;
            for (const s of grp) {
                let cnt = 0;
                try { cnt = (await db.query('lottery_records', 'by_session', s.id)).length; } catch (e) {}
                if (cnt > bestCount || (cnt === bestCount && (s.created || 0) < (best.created || 0))) { best = s; bestCount = cnt; }
            }
            out.push(best);
        }
        return out.sort((a, b) => (b.created || 0) - (a.created || 0));
    } catch (e) {
        return [];
    }
}

/** This agent's records in a session, entry order (oldest first). */
async function getSessionRecords(sessId) {
    try {
        const recs = await db.query('lottery_records', 'by_session', sessId);
        return recs
            .filter((r) => (r.agent_name || '') === agentName)
            .sort((a, b) => (a.created || 0) - (b.created || 0));
    } catch (e) {
        return [];
    }
}

/* ================= Screens (home menu navigation) ================= */

let activeScreen = 'home';

/** Open a feature screen. */
window.openScreen = function openScreen(name) {
    activeScreen = name;
    document.querySelectorAll('.screenpane').forEach((p) => { p.hidden = true; });
    const pane = document.getElementById('screen-' + name);
    if (pane) pane.hidden = false;
    window.scrollTo(0, 0);
    if (name === 'entry') hideEntryKeyboard(); // keypad hidden by default
    refreshActiveScreen();
};

/** Back to the home menu screen. */
window.goHome = function goHome() {
    hideEntryKeyboard();
    activeScreen = 'home';
    document.querySelectorAll('.screenpane').forEach((p) => { p.hidden = true; });
    document.getElementById('screen-home').hidden = false;
    window.scrollTo(0, 0);
    refreshActiveScreen();
};

/** Entry-screen keypad: hidden by default. It is a pure overlay layer —
 *  fixed to the phone bottom, never moves, never pushes content.
 *  Close it to scroll the records sheet underneath. */
function hideEntryKeyboard() {
    const kp = document.getElementById('entryKeypad');
    if (kp) kp.hidden = true;
    const btn = document.getElementById('entryKbToggle');
    if (btn) btn.classList.remove('active');
}

/** Toggle the entry-screen keypad (⌨️ button next to the player select).
 *  The keypad is a fixed bottom overlay: it sticks to the screen bottom
 *  and stays dead still (never moves when records are added);
 *  closing it hides it completely (display:none). */
window.toggleEntryKeyboard = function toggleEntryKeyboard() {
    const kp = document.getElementById('entryKeypad');
    if (!kp) return;
    kp.hidden = !kp.hidden;
    const btn = document.getElementById('entryKbToggle');
    if (btn) btn.classList.toggle('active', !kp.hidden);
};

/** Floating scroll-to-top button. */
window.scrollToTop = function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.addEventListener('scroll', () => {
    const btn = document.getElementById('scrollTopBtn');
    if (btn) btn.hidden = window.scrollY < 300;
}, { passive: true });

/** Re-render whichever screen is currently visible. */
function refreshActiveScreen() {
    if (activeScreen === 'home') { updateMenuSubs(); }
    else if (activeScreen === 'entry') refreshEntryScreen();
    else if (activeScreen === 'records') renderRecordsView();
    else if (activeScreen === 'players') renderPlayers();
    else if (activeScreen === 'daily') renderDaily();
    else if (activeScreen === 'weekly') renderWeekly();
}

async function updateMenuSubs() {
    try {
        const players = await getPlayers();
        const el = document.getElementById('menuPlayersSub');
        if (el) el.textContent = players.length ? players.length + ' ယောက်' : 'လူ ထည့်ရန်';
    } catch (e) { /* ignore */ }
}

/* ================= Players (လူစာရင်း) ================= */

let editingPlayerId = null;

async function getPlayers() {
    try {
        const all = await db.query('players', 'by_tenant', tenantId);
        return all
            .filter((p) => (p.agent_name || '') === agentName)
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    } catch (e) {
        console.warn('[agent] getPlayers failed', e);
        return [];
    }
}

window.openPlayerModal = function openPlayerModal(editId) {
    editingPlayerId = editId || null;
    document.getElementById('playerModalTitle').textContent = editId ? '✏️ လူ ပြင်မည်' : '👥 လူအသစ်';
    document.getElementById('playerNameInput').value = '';
    document.getElementById('playerPhoneInput').value = '';
    document.getElementById('playerCommInput').value = '';
    document.getElementById('playerMultInput').value = '';
    if (editId) {
        db.get('players', editId).then((p) => {
            if (p) {
                document.getElementById('playerNameInput').value = p.name || '';
                document.getElementById('playerPhoneInput').value = p.phone || '';
                document.getElementById('playerCommInput').value = p.commission != null ? p.commission : '';
                document.getElementById('playerMultInput').value = p.multiplier != null ? p.multiplier : '';
            }
        });
    }
    document.getElementById('playerModal').hidden = false;
    setTimeout(() => document.getElementById('playerNameInput').focus(), 100);
};

window.closePlayerModal = function closePlayerModal() {
    document.getElementById('playerModal').hidden = true;
    editingPlayerId = null;
};

window.savePlayer = async function savePlayer() {
    const name = document.getElementById('playerNameInput').value.trim();
    const phone = document.getElementById('playerPhoneInput').value.trim();
    const commRaw = document.getElementById('playerCommInput').value.trim();
    const multRaw = document.getElementById('playerMultInput').value.trim();
    const commission = commRaw === '' ? 0 : parseFloat(commRaw) || 0;
    const multiplier = multRaw === '' ? 80 : parseFloat(multRaw) || 80;
    if (!name) { showToast('နာမည် ထည့်ပါ'); return; }
    try {
        if (editingPlayerId) {
            const existing = (await db.get('players', editingPlayerId)) || {};
            await sync.mutate('update', 'players', Object.assign({}, existing, {
                id: editingPlayerId, name, phone, commission, multiplier
            }));
            showToast('✅ ပြင်ပြီးပြီ');
        } else {
            await sync.mutate('create', 'players', {
                id: uid(),
                tenant: tenantId,
                agent_name: agentName,
                name, phone, commission, multiplier,
                created: Date.now()
            });
            showToast('✅ လူ ထည့်ပြီးပြီ');
        }
        closePlayerModal();
        await renderPlayers();
        updateSyncPill();
    } catch (e) {
        showToast('❌ သိမ်းမရပါ: ' + e.message);
    }
};

window.deletePlayer = async function deletePlayer(id) {
    const p = await db.get('players', id);
    if (!p) return;
    if (!confirm('"' + p.name + '" ကို ဖျက်မှာလား?')) return;
    await sync.mutate('delete', 'players', { id });
    await renderPlayers();
    showToast('🗑️ ဖျက်ပြီးပြီ');
};

async function renderPlayers() {
    const listEl = document.getElementById('playersList');
    const emptyEl = document.getElementById('playersEmpty');
    const players = await getPlayers();

    let sessRecs = [];
    if (currentSessionId) {
        sessRecs = (await getSessionRecords(currentSessionId));
    }
    const totals = {};
    sessRecs.forEach((r) => {
        const k = r.player_name || '';
        totals[k] = totals[k] || { amount: 0, count: 0 };
        totals[k].amount += Number(r.amount) || 0;
        totals[k].count += 1;
    });

    if (!players.length) {
        listEl.innerHTML = '';
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = players.map((p) => {
        const t = totals[p.name] || { amount: 0, count: 0 };
        return '<div class="player-row">' +
            '<div class="player-info" onclick="openPlayerModal(\'' + p.id + '\')">' +
                '<div class="player-name">👤 ' + escHtml(p.name) + '</div>' +
                (p.phone ? '<div class="player-phone">📞 ' + escHtml(p.phone) + '</div>' : '') +
                '<div class="player-sess">ဒီ session: ' + formatMoney(t.amount) + '</div>' +
            '</div>' +
            '<button class="rec-del" onclick="deletePlayer(\'' + p.id + '\')" title="ဖျက်မည်">🗑️</button>' +
        '</div>';
    }).join('');
}

/* ================= ENTRY SCREEN (စာရင်းသွင်းရန်) ================= */

let activeBox = 'no'; // 'no' | 'amt' | 'rev'

function $(id) { return document.getElementById(id); }
function boxNo() { return $('boxNo'); }
function boxAmt() { return $('boxAmt'); }
function boxRev() { return $('boxRev'); }

window.setFocusBox = function setFocusBox(boxName) {
    activeBox = boxName;
    boxNo().classList.remove('active-box');
    boxAmt().classList.remove('active-box');
    boxRev().classList.remove('active-box');
    if (boxName === 'no') boxNo().classList.add('active-box');
    else if (boxName === 'amt') boxAmt().classList.add('active-box');
    else if (boxName === 'rev') boxRev().classList.add('active-box');
};

window.appendNum = function appendNum(val) {
    if (activeBox === 'no') boxNo().value += val;
    else if (activeBox === 'amt') boxAmt().value += val;
    else if (activeBox === 'rev') boxRev().value += val;
};

window.backspaceNum = function backspaceNum() {
    if (activeBox === 'no') boxNo().value = boxNo().value.slice(0, -1);
    else if (activeBox === 'amt') boxAmt().value = boxAmt().value.slice(0, -1);
    else if (activeBox === 'rev') boxRev().value = boxRev().value.slice(0, -1);
};

window.clearInputs = function clearInputs() {
    boxNo().value = ''; boxAmt().value = ''; boxRev().value = '';
    setFocusBox('no');
};

/**
 * Keyboard formula buttons (screenshot layout).
 * Labels insert into the ဂဏန်း box exactly as shown; known formulas
 * map to their parser spelling. Then focus moves to the ဒဲ့ box.
 */
const FORMULA_INSERT = {
    'ထိပ်': 'ထိပ်',
    'နောက်': 'နောက်',
    'ပတ်': 'ပတ်',
    'ပူး': 'ပူး',
    'ပါဝါ': 'ပါဝါ',
    'နက္ခတ်': 'နက္ခတ်',
    'ဘရိတ်': 'ဘရိတ်',
    'ခွေ': 'ခွေ',
    'ခွေပူးပါ': 'ခွေပူးပါ',
    'ညီအစ်ကို': 'ညီအစ်ကို',
    'စုံစုံ': 'စုံစုံ',
    'မမ': 'မမ',
    'စုံမ': 'စုံမ',
    'မစုံ': 'မစုံ'
};

window.applyFormula = function applyFormula(fName) {
    const insert = FORMULA_INSERT[fName] || fName;
    const cur = boxNo().value.trim();
    boxNo().value = cur ? cur + insert : insert;
    setFocusBox('amt');
};

window.toggleRVal = function toggleRVal() {
    boxRev().value = boxRev().value.trim() ? '' : 'R';
};

/** Refresh the entry screen: player select, session select, table, totals. */
async function refreshEntryScreen() {
    // Player select (preserve selection)
    const pSel = $('entryPlayerSelect');
    const prevPlayer = pSel.value;
    const players = await getPlayers();
    pSel.innerHTML = '<option value="">-- ထိုးသား ရွေးပါ --</option>' +
        players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
    if (prevPlayer && Array.from(pSel.options).some((o) => o.value === prevPlayer)) {
        pSel.value = prevPlayer;
    }

    // Session select
    const sSel = $('entrySessionSelect');
    const sessions = await getAgentSessions();
    const prevSess = sSel.value;
    sSel.innerHTML = sessions.map((s) =>
        '<option value="' + s.id + '">' + escHtml(s.name || 'Session') + '</option>').join('') ||
        '<option value="">Session မရှိပါ</option>';
    if (prevSess && Array.from(sSel.options).some((o) => o.value === prevSess)) {
        sSel.value = prevSess;
    } else if (currentSessionId) {
        sSel.value = currentSessionId;
    }

    await renderEntryTable();
}

window.onEntrySessionChange = function onEntrySessionChange(sel) {
    if (!sel.value) return;
    currentSessionId = sel.value;
    localStorage.setItem(LS_SESSION, currentSessionId);
    refreshEntryScreen();
};

/** Entry table: PENDING entries (typed, not saved yet).
 *  Press ထည့်မည် to add to this table; press 💾 Save (top) to store as a batch. */
async function renderEntryTable() {
    const tbody = $('entryTableBody');
    const total = pendingEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    $('entryTotal').textContent = formatMoney(total);
    $('entryCount').textContent = pendingEntries.length;

    if (!pendingEntries.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">စာရင်း မရှိသေးပါ။</td></tr>';
        return;
    }
    // Group by (formula_text, line_idx) for compact display — each input line is its own row (Pho)
    const byF = {}; const fOrder = [];
    pendingEntries.forEach((e, idx) => {
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
            return '<tr>' +
                '<td>' + escHtml(e0.player_name || 'ကိုယ်တိုင်') + '</td>' +
                '<td class="cell-no">' + escHtml(ft) + ' (' + g.entries.length + ')</td>' +
                '<td class="cell-amt">' + formatMoney(gTotal) + '</td>' +
                '<td class="cell-del"><button class="rec-del" onclick="deletePendingGroup(\'' + idxList + '\')" title="ဖျက်မည်">🗑️</button></td>' +
            '</tr>';
        }
        const e = g.entries[0]; const i = g.indices[0];
        return '<tr>' +
            '<td>' + escHtml(e.player_name || 'ကိုယ်တိုင်') + '</td>' +
            '<td class="cell-no">' + escHtml(e.number) + '</td>' +
            '<td class="cell-amt">' + formatMoney(e.amount) + '</td>' +
            '<td class="cell-del"><button class="rec-del" onclick="deletePendingEntry(' + i + ')" title="ဖျက်မည်">🗑️</button></td>' +
        '</tr>';
    }).join('');
}

/** Remove one pending (unsaved) entry. */
window.deletePendingEntry = function deletePendingEntry(i) {
    pendingEntries.splice(i, 1);
    renderEntryTable();
};

/** Remove a group of pending entries (by indices). */
window.deletePendingGroup = function deletePendingGroup(idxList) {
    const idxs = idxList.split(',').map((x) => parseInt(x, 10)).sort((a, b) => b - a);
    idxs.forEach((i) => pendingEntries.splice(i, 1));
    renderEntryTable();
};

/** Next batch number for (agent, session, player). */
async function getNextBatchNo(playerName) {
    const recs = currentSessionId ? await getSessionRecords(currentSessionId) : [];
    let max = 0;
    recs.forEach((r) => {
        if ((r.player_name || '') === (playerName || '')) {
            const b = Number(r.batch_no) || 0;
            if (b > max) max = b;
        }
    });
    return max + 1;
}

/**
 * ထည့်မည် — expand the number-box formula and add to the PENDING table.
 * Nothing is saved yet; press 💾 Save (top button) to store as a new batch.
 */
window.submitEntry = async function submitEntry() {
    const lkE = await isAgentSessionLocked(currentSessionId);
    if (lkE.locked) { showToast('🔒 ' + lkE.reason + ' — တင် မရပါ'); return; }
    const playerName = $('entryPlayerSelect').value || null;
    if (!playerName) { showToast('❌ အမည် ရွေးပါ (မရွေးရင် တင်မရ)'); return; }
    const noText = boxNo().value.trim();
    const amtText = boxAmt().value.trim().replace(/[^\d]/g, '');
    const revText = boxRev().value.trim();

    if (!noText) { showToast('❌ ဂဏန်း (သို့) ဖော်မြူလာ ထည့်ပါ'); setFocusBox('no'); return; }
    const mainAmt = parseInt(amtText, 10) || 0;
    if (mainAmt <= 0) { showToast('❌ ပမာဏ ထည့်ပါ'); setFocusBox('amt'); return; }

    let line = noText + '=' + mainAmt;
    if (revText) {
        if (/^r$/i.test(revText)) line += 'r' + mainAmt;
        else {
            const revAmt = parseInt(revText.replace(/[^\d]/g, ''), 10) || 0;
            if (revAmt > 0) line += 'r' + revAmt;
        }
    }

    const { items, invalidLines } = parseBoardReport(line);
    // Guard: the parser can echo unknown formula text into "numbers"
    // (e.g. 12ဖုံ → "12ဖုံ"). Only accept real 2-digit numbers with amount > 0.
    const validItems = items.filter((it) => /^\d{2}$/.test(String(it.number)) && (Number(it.amount) || 0) > 0);
    if (!validItems.length) {
        showToast('❌ ဖော်မြူလာ မသိပါ (ဂဏန်း မှားနေတယ်)' + (invalidLines.length ? ': ' + invalidLines[0] : ''));
        return;
    }

    // 🚫 ဒိုင်ပိတ်: blocked numbers cannot be bet
    const blockedSet = new Set(await getAgentBlocked(currentSessionId));
    const blockedHit = [];
    const allowedItems = validItems.filter((it) => {
        const nn = String(it.number).padStart(2, '0');
        if (blockedSet.has(nn)) { blockedHit.push(nn); return false; }
        return true;
    });
    if (!allowedItems.length) { clearInputs(); showToast('🚫 ဒိုင်ပိတ် ဂဏန်းတွေ ချည်း — တင် မရပါ'); return; }
    let addedCount = 0;
    const isFormulaLine = lineHasFormula(line);
    allowedItems.forEach((it) => {
        if (addPendingUnique(playerName, it.number, it.amount, isFormulaLine)) addedCount++;
    });
    // Pho: duplicates allowed — no safety-net dedup
    clearInputs();
    await renderEntryTable();
    const skipped = invalidLines.length + (items.length - validItems.length) + blockedHit.length;
    const blkMsg = blockedHit.length ? ' (🚫 ' + [...new Set(blockedHit)].join(',') + ' ပိတ်)' : '';
    showToast('✅ ထည့်ပြီးပြီ' +
        (skipped ? ' (⚠️ ' + skipped + ' လိုင်း ကျန်)' : '') + blkMsg);
};

/**
 * 💾 Save (top button) — persist all pending entries as NEW batches
 * (one batch number per player), then clear the table and reset the total.
 */
window.savePendingBatch = async function savePendingBatch() {
    if (saveInFlight) return;
    // Pho Oct 18: set the guard SYNCHRONOUSLY before any await —
    // two rapid taps must not both pass.
    saveInFlight = true;
    if (await checkAgentDisabled()) { saveInFlight = false; return; }
    if (!pendingEntries.length) { saveInFlight = false; showToast('စာရင်း မရှိသေးပါ'); return; }
    // Block if any pending entry has no player name
    if (pendingEntries.some((e) => !(e.player_name || '').trim())) { saveInFlight = false; showToast('❌ အမည် မပါ တဲ့ စာရင်း ရှိ — ဖျက် ပြီး ပြန် ထည့်'); return; }
    if (!currentSessionId) { saveInFlight = false; showToast('⚠️ Session မရှိသေးပါ'); return; }
    // Pho Oct 19 Option B: Verify session actually exists in local DB (not just ID truthy).
    // Prevents blank/invalid session 400 errors.
    const sessCheck = await db.get('sessions', currentSessionId);
    if (!sessCheck) { saveInFlight = false; showToast('⚠️ Session မတွေ့ပါ — ပြန်ရွေးပါ'); currentSessionId = null; localStorage.removeItem(LS_SESSION); await refreshSession(); return; }
    const lkS = await isAgentSessionLocked(currentSessionId);
    if (lkS.locked) { saveInFlight = false; showToast('🔒 ' + lkS.reason + ' — သိမ်း မရပါ'); return; }
    // Hot-number limits (cumulative per session; formula-derived excluded)
    const limitErr = await checkAgentLimits();
    if (limitErr) { saveInFlight = false; showToast('❌ ' + limitErr); return; }

    try {
        // Group pending by player, preserving first-appearance order
        const order = [];
        const byPlayer = {};
        pendingEntries.forEach((e) => {
            const k = e.player_name || '';
            if (!byPlayer[k]) { byPlayer[k] = []; order.push(k); }
            byPlayer[k].push(e);
        });
        const batchNos = {};
        for (const k of order) batchNos[k] = await getNextBatchNo(k || null);

        let count = 0;
        for (const k of order) {
            for (const e of byPlayer[k]) {
                await sync.mutate('create', 'lottery_records', {
                    id: uid(),
                    tenant: tenantId,
                    session: currentSessionId,
                    number: e.number,
                    amount: e.amount,
                    agent_name: agentName,
                    player_name: e.player_name,
                    record_type: 'pos',
                    batch_no: batchNos[k],
                    fromFormula: !!e.fromFormula,
                    formula_text: e.formula_text || '',
                    created: Date.now()
                });
                count++;
            }
        }
        pendingEntries = [];
        await renderEntryTable();
        updateSyncPill();
        showToast('✅ သိမ်းပြီးပြီ');
        // Push to server immediately so Master sees the numbers within seconds
        sync.syncNow().catch(() => {});
    } catch (e) {
        console.error('[agent] savePendingBatch failed', e);
        showToast('❌ သိမ်းမရပါ: ' + e.message);
    } finally {
        saveInFlight = false;
    }
};

/* ================= RECORDS VIEW (စာရင်းများ — batches) ================= */

let lastVoucher = null; // for Copy/Print/Share
let batchDetailCtx = null; // {sessId, playerKey, batchNo} for the open detail modal

/**
 * Group records by number, preserving FIRST-APPEARANCE (entry) order.
 * Never numerically re-sorted — matches what was sent.
 */
function groupByNumberKeepOrder(recs) {
    const order = [];
    const map = {};
    recs.forEach((r) => {
        const n = String(r.number || '');
        if (!map[n]) { map[n] = { number: n, amount: 0, count: 0 }; order.push(n); }
        map[n].amount += Number(r.amount) || 0;
        map[n].count += 1;
    });
    return order.map((n) => map[n]);
}

function batchLabel(b) {
    return 'NO ' + (Number(b) || 0);
}

/** "02:28 PM" style timestamp for voucher batch headers (v1 format). */
function fmtTime12(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return String(h).padStart(2, '0') + ':' + m + ' ' + ap;
}

function playerLabel(key) {
    return key ? key : '🧍 ကိုယ်တိုင်';
}

window.renderRecordsView = async function renderRecordsView() {
    const playerSel = $('recordsPlayer');
    const sessSel = $('recordsSession');
    const content = $('recordsViewContent');

    const players = await getPlayers();
    const sessions = await getAgentSessions();

    const prevPlayer = playerSel.value;
    const prevSess = sessSel.value;

    let pHtml = '<option value="__all">-- အားလုံး --</option>';
    pHtml += players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
    playerSel.innerHTML = pHtml;
    if (prevPlayer !== undefined && Array.from(playerSel.options).some((o) => o.value === prevPlayer)) {
        playerSel.value = prevPlayer;
    } else {
        playerSel.value = '__all';
    }

    sessSel.innerHTML = sessions.map((s) =>
        '<option value="' + s.id + '">' + escHtml(s.name || 'Session') + '</option>').join('');
    if (prevSess && Array.from(sessSel.options).some((o) => o.value === prevSess)) {
        sessSel.value = prevSess;
    } else if (currentSessionId) {
        sessSel.value = currentSessionId;
    }

    const selPlayer = playerSel.value; // '__all' | '' (self) | name
    const sessId = sessSel.value;
    if (!sessId) {
        lastVoucher = null;
        content.innerHTML = '<div class="empty-state">Session မရှိသေးပါ</div>';
        return;
    }

    let recs = await getSessionRecords(sessId);
    if (selPlayer !== '__all') {
        recs = recs.filter((r) => (r.player_name || '') === (selPlayer === '' ? '' : selPlayer));
    }
    if (!recs.length) {
        lastVoucher = null;
        content.innerHTML = '<div class="empty-state">စာရင်း မရှိသေးပါ</div>';
        return;
    }

    // Winning numbers for yellow highlight
    let winNums = new Set();
    try {
        const wins = await _getWins(sessId);
        winNums = new Set(wins.map((w) => String(w.number).padStart(2, '0')));
    } catch (e) { /* ignore */ }

    // Play a soft beep when Ok appears (Pho's request)
    const playOkSound = () => {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.frequency.value = 880; o.type = 'sine';
            g.gain.setValueAtTime(0.15, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.3);
        } catch (e) { /* ignore */ }
    };

    // Fetch Master acks (for "Ok" badges) - TRUE confirmation only
    let ackedBatches = new Set();
    try {
        const ackRes = await pb.list('batch_acks', { perPage: 200 });
        for (const a of (ackRes.items || ackRes)) {
            if (a.batch_key) ackedBatches.add(a.batch_key);
        }
    } catch (e) { /* ignore */ }
    const isBatchAcked = (agentName, playerName, batchNo) => {
        const prefix = [agentName, playerName || '', batchNo].join('|') + '|';
        for (const ak of ackedBatches) {
            if (ak.startsWith(prefix)) return true;
        }
        return false;
    };

    // Group: player (entry order of first appearance) → batch_no asc → numbers keep order
    const playerOrder = [];
    const byPlayer = {};
    recs.forEach((r) => {
        const k = r.player_name || '';
        if (!byPlayer[k]) { byPlayer[k] = []; playerOrder.push(k); }
        byPlayer[k].push(r);
    });

    const sessName = (sessions.find((s) => s.id === sessId) || {}).name || 'Session';
    const voucherPlayers = [];
    let grandAmt = 0, grandCount = 0;

    playerOrder.forEach((k) => {
        const pRecs = byPlayer[k]; // already entry order
        const batchOrder = [];
        const byBatch = {};
        pRecs.forEach((r) => {
            const b = Number(r.batch_no) || 0;
            if (!byBatch[b]) { byBatch[b] = []; batchOrder.push(b); }
            byBatch[b].push(r);
        });
        batchOrder.sort((a, b) => a - b);

        const batches = batchOrder.map((b) => {
            let items = byBatch[b]; // entry order — NEVER re-sorted, matches what was sent
            // Pho: NO dedup — duplicates are legitimate and must all show
            const tAmt = items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            const t0 = items.length && items[0].created ? items[0].created : 0;
            return { no: b, label: batchLabel(b), items, totalAmt: tAmt, totalCount: items.length, time: fmtTime12(t0) };
        });
        const pAmt = batches.reduce((s, b) => s + b.totalAmt, 0);
        const pCount = batches.reduce((s, b) => s + b.totalCount, 0);
        grandAmt += pAmt;
        grandCount += pCount;
        voucherPlayers.push({ key: k, label: playerLabel(k), batches, totalAmt: pAmt, totalCount: pCount });
    });

    lastVoucher = {
        players: voucherPlayers,
        playerFilter: selPlayer,
        sessId,
        sessionName: sessName,
        dateLabel: formatDateStr(new Date()),
        totalAmt: grandAmt,
        totalCount: grandCount
    };

    let html = '';
    let hasOk = false;
    voucherPlayers.forEach((p, pIdx) => {
        if (pIdx > 0) html += '<div style="border-top:1px dashed #3b82f6;margin:12px 0;opacity:0.5"></div>';
        html += '<div class="v-player-block">' +
            '<div class="v-player-name">' + escHtml(p.label) + '</div>';
        p.batches.forEach((b) => {
            const bFirst = b.items[0];
            const bAcked = bFirst && isBatchAcked(bFirst.agent_name, p.key, b.no);
            const bOkBadge = bAcked ? ' <span style="color:#4ade80;font-size:12px">✅ Ok</span>' : '';
            if (bAcked) hasOk = true;
            html += '<div class="v-batch">' +
                '<div class="v-batch-no" onclick="openBatchDetail(\'' + escHtml(p.key) + '\',' + b.no + ')" title="အသေးစိတ် ကြည့်ရန် (ပြင်/ဖျက်)">' + escHtml(b.label) + bOkBadge + '</div>' +
                '<table class="v-table"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th></tr></thead><tbody>' +
                (() => {
                    // Group by formula_text for compact display
                    const byF = {}; const fOrder = [];
                    b.items.forEach((r) => {
                        const ft = (r.formula_text || '').trim();
                        const key = ft || `__s__${r.id}`;
                        if (!byF[key]) { byF[key] = []; fOrder.push(key); }
                        byF[key].push(r);
                    });
                    return fOrder.map((key) => {
                        const grp = byF[key];
                        if (grp.length > 1) {
                            const ft = (grp[0].formula_text || '').trim();
                            const total = grp.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                            const ids = grp.map((r) => r.id).join(',');
                            return '<tr data-rids="' + escHtml(ids) + '" style="user-select:none;-webkit-user-select:none;"><td>' + escHtml(ft) + '</td><td>(' + grp.length + ') ' + formatMoney(total) + '</td></tr>';
                        }
                        const r = grp[0];
                        const numStr = String(r.number).padStart(2, '0');
                        const isWin = winNums.has(numStr);
                        return '<tr data-rid="' + escHtml(r.id) + '" style="user-select:none;-webkit-user-select:none;"' + (isWin ? ' class="win-row"' : '') + '><td' + (isWin ? ' class="win-cell"' : '') + '>' +
                            escHtml(r.number) + '</td><td' + (isWin ? ' class="win-cell"' : '') + '>' + formatMoney(r.amount) + '</td></tr>';
                    }).join('');
                })() +
                '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(b.totalAmt) + '</td></tr></tfoot></table>' +
                '</div>';
        });
        html += '</div>';
    });
    html += '<div class="voucher-total"><span>စုစုပေါင်း</span><b>' + formatMoney(grandAmt) +
        '</b></div>';
    if (hasOk) playOkSound();
        content.innerHTML = html;
};

/* ================= Voucher actions: Copy / Print / Share ================= */

function buildVoucherText() {
    const v = lastVoucher;
    if (!v || !v.players.length) return '';
    const lines = [];
    v.players.forEach((p, pi) => {
        if (pi > 0) lines.push('');
        lines.push(p.label);
        p.batches.forEach((b, bi) => {
            if (bi > 0) lines.push('');
            lines.push(b.label);
            const byF = {}; const fOrder = [];
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
                    lines.push(`${ft} (${grp.length}) ${total}`);
                } else {
                    const r = grp[0];
                    lines.push(r.number + ' ' + (Number(r.amount) || 0));
                }
            });
            lines.push('Total ' + b.totalAmt);
        });
    });
    return lines.join('\n');
}

async function copyTextToClipboard(text) {
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
        } catch (e2) {
            return false;
        }
    }
}

window.copyVoucher = async function copyVoucher() {
    const text = buildVoucherText();
    if (!text) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    const ok = await copyTextToClipboard(text);
    showToast(ok ? '✅ ကူးပြီးပြီ' : '❌ ကူးမရပါ');
};

window.printVoucher = function printVoucher() {
    const v = lastVoucher;
    if (!v || !v.players.length) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    const area = $('printArea');
    let body = '';
    v.players.forEach((p) => {
        body += '<div class="pr-player">' + escHtml(p.label) + '</div>';
        p.batches.forEach((b) => {
            body += '<div class="pr-batch">' + escHtml(b.label) +
                (b.time ? ' <span class="pr-time">' + escHtml(b.time) + '</span>' : '') + '</div>' +
                '<table class="pr-table"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th></tr></thead><tbody>' +
                b.items.map((r) =>
                    '<tr><td>' + escHtml(r.number) + '</td><td>' + formatMoney(r.amount) + '</td></tr>'
                ).join('') +
                '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(b.totalAmt) + '</td></tr></tfoot></table>';
        });
    });
    area.innerHTML =
        '<div class="print-receipt">' +
            '<div class="pr-title">🧾 ဘောက်ချာ</div>' +
            '<div class="pr-sub">' + escHtml(v.dateLabel) + ' | ' + escHtml(v.sessionName) + '</div>' +
            '<div class="pr-line"></div>' + body +
            '<div class="pr-line"></div>' +
            '<div class="pr-total"><span>စုစုပေါင်း</span><span>' + formatMoney(v.totalAmt) +
            '</span></div>' +
        '</div>';
    window.print();
};

window.shareVoucher = async function shareVoucher() {
    const text = buildVoucherText();
    if (!text) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    if (navigator.share) {
        try { await navigator.share({ title: '🧾 ဘောက်ချာ', text }); } catch (e) { /* cancelled */ }
    } else {
        const ok = await copyTextToClipboard(text);
        showToast(ok ? '✅ ကူးပြီးပြီ (share မရလို့)' : '❌ မျှဝေမရပါ');
    }
};

/* ================= Batch detail (per-batch edit/delete) ================= */

window.openBatchDetail = async function openBatchDetail(playerKey, batchNo) {
    const v = lastVoucher;
    if (!v) return;
    batchDetailCtx = { sessId: v.sessId, playerKey: String(playerKey), batchNo: Number(batchNo) };

    const recs = (await getSessionRecords(v.sessId))
        .filter((r) => (r.player_name || '') === batchDetailCtx.playerKey &&
                       (Number(r.batch_no) || 0) === batchDetailCtx.batchNo);

    $('batchDetailTitle').textContent = '🧾 ' + playerLabel(batchDetailCtx.playerKey) +
        ' (' + batchLabel(batchDetailCtx.batchNo) + ')';
    $('batchDetailList').innerHTML = recs.length ?
        '<table class="v-table v-table-edit"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th><th></th></tr></thead><tbody>' +
        recs.map((r) =>
        '<tr>' +
            '<td>' + escHtml(r.number) + '</td>' +
            '<td>' + formatMoney(r.amount) + '</td>' +
            '<td class="v-actions">' +
                '<button class="rec-edit" onclick="openEditRecord(\'' + r.id + '\')" title="ပြင်မည်">✏️</button>' +
                '<button class="rec-del" onclick="deleteRecord(\'' + r.id + '\')" title="ဖျက်မည်">🗑️</button>' +
            '</td>' +
        '</tr>'
    ).join('') + '</tbody></table>' : '<div class="empty-state">စာရင်း မရှိပါ</div>';
    $('batchDetailModal').hidden = false;
};

window.closeBatchDetail = function closeBatchDetail() {
    $('batchDetailModal').hidden = true;
    batchDetailCtx = null;
};

async function refreshBatchDetail() {
    if (!$('batchDetailModal') || !$('batchDetailModal').hidden || !batchDetailCtx) return;
    await openBatchDetail(batchDetailCtx.playerKey, batchDetailCtx.batchNo);
}

/* ================= Records: edit / delete ================= */

window.deleteRecord = async function deleteRecord(id) {
    const rec = await db.get('lottery_records', id);
    if (!rec) return;
    if (!confirm(rec.number + ' (' + formatMoney(rec.amount) + ') ဖျက်မှာလား?')) return;
    await sync.mutate('delete', 'lottery_records', { id });
    if (activeScreen === 'records') await renderRecordsView();
    await refreshBatchDetail();
    showToast('🗑️ ဖျက်ပြီးပြီ');
};

let editingRecordId = null;

window.openEditRecord = async function openEditRecord(id) {
    const rec = await db.get('lottery_records', id);
    if (!rec) return;
    editingRecordId = id;
    $('editNumberInput').value = rec.number || '';
    $('editAmountInput').value = rec.amount || '';
    $('editModal').hidden = false;
    setTimeout(() => $('editAmountInput').focus(), 100);
};

window.closeEditModal = function closeEditModal() {
    $('editModal').hidden = true;
    editingRecordId = null;
};

window.saveEditRecord = async function saveEditRecord() {
    if (!editingRecordId) return;
    const num = $('editNumberInput').value.trim();
    const amt = Number($('editAmountInput').value);
    if (!/^\d{1,2}$/.test(num)) { showToast('နံပါတ် မှန်အောင်ထည့်ပါ (0-99)'); return; }
    if (!amt || amt <= 0) { showToast('ငွေ ထည့်ပါ'); return; }
    try {
        const existing = (await db.get('lottery_records', editingRecordId)) || {};
        await sync.mutate('update', 'lottery_records', Object.assign({}, existing, {
            id: editingRecordId,
            number: num.padStart(2, '0'),
            amount: amt
        }));
        closeEditModal();
        if (activeScreen === 'records') await renderRecordsView();
        await refreshBatchDetail();
        updateSyncPill();
        showToast('✅ ပြင်ပြီးပြီ');
    } catch (e) {
        showToast('❌ သိမ်းမရပါ: ' + e.message);
    }
};

/* ================= Digital board modal (paste/type alternative) ================= */

/** Formula notice board: tap 📖 to show, tap again (or ✕/outside) to hide. */
window.toggleFormulaSheet = function toggleFormulaSheet() {
    const m = document.getElementById('formulaSheet');
    if (m) m.hidden = !m.hidden;
};

window.openBoard = function openBoard() {
    if (!currentSessionId) {
        showToast('⚠️ Session မရှိသေးပါ');
        return;
    }
    populateBoardPlayer();
    $('boardModal').hidden = false;
    $('boardPreview').hidden = true;
    const ta = $('boardTextarea');
    ta.value = '';
    setTimeout(() => ta.focus(), 100);
};

async function populateBoardPlayer() {
    const sel = $('boardPlayer');
    const players = await getPlayers();
    sel.innerHTML = players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
    sel.value = players.length ? players[0].name : '';
}

window.closeBoard = function closeBoard() {
    $('boardModal').hidden = true;
};

window.pasteToBoard = async function pasteToBoard() {
    try {
        const text = await navigator.clipboard.readText();
        const ta = $('boardTextarea');
        ta.value = (ta.value ? ta.value + '\n' : '') + text;
        updateBoardPreview();
    } catch (e) {
        showToast('📋 Paste ခွင့်မရှိပါ — ကိုယ်တိုင် paste လုပ်ပါ');
    }
};

/** Strict per-line check: parse must succeed AND every number must be 2-digit. Never guesses. */
function boardLineOk(line) {
    let parsed = [];
    try { parsed = parseLine(line); } catch (e) { parsed = []; }
    return parsed.length > 0 && parsed.every((p) => /^\d{2}$/.test(String(p.number)));
}

const updateBoardPreview = debounce(() => {
    const text = $('boardTextarea').value;
    const box = $('boardPreview');
    if (!text.trim()) { box.hidden = true; return; }
    let html = '';
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const ok = boardLineOk(line);
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
    box.hidden = false;
    box.innerHTML = html;
}, 400);

document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'boardTextarea') updateBoardPreview();
});



/** Board save → one new batch for the selected player. */
window.saveBoard = async function saveBoard() {
    if (saveInFlight) return;
    // Pho Oct 18: set the guard SYNCHRONOUSLY before any await.
    saveInFlight = true;
    const lkB = await isAgentSessionLocked(currentSessionId);
    if (lkB.locked) { saveInFlight = false; showToast('🔒 ' + lkB.reason + ' — တင် မရပါ'); return; }
    const ta = $('boardTextarea');
    const text = ta.value;
    if (!text.trim()) { saveInFlight = false; showToast('စာရွက် လွတ်နေတယ်'); return; }
    if (!currentSessionId) { saveInFlight = false; showToast('⚠️ Session မရှိသေးပါ'); return; }
    // Pho Oct 19 Option B: Verify session actually exists in local DB.
    const sessCheckB = await db.get('sessions', currentSessionId);
    if (!sessCheckB) { saveInFlight = false; showToast('⚠️ Session မတွေ့ပါ — ပြန်ရွေးပါ'); currentSessionId = null; localStorage.removeItem(LS_SESSION); await refreshSession(); return; }

    try {
        const playerName = $('boardPlayer').value || null;
        if (!playerName) { saveInFlight = false; showToast('❌ အမည် ရွေးပါ (မရွေးရင် တင်မရ)'); return; }
        // Strict per-line: only fully-valid lines are entered. Bad lines stay
        // on the board for fixing — never guess-entered.
        const okItems = [];
        const badLines = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            if (!boardLineOk(line)) { badLines.push(line); continue; }
            let parsed = [];
            try { parsed = parseLine(line); } catch (e) { parsed = []; }
            const isF = lineHasFormula(line);
            for (const p of parsed) okItems.push({ ...p, _fromFormula: isF, formula_text: line.trim() });
        }
        if (!okItems.length) {
            showToast('❌ ဝင်မယ့် လိုင်း မရှိပါ');
            saveInFlight = false;
            return;
        }
        // 🚫 ဒိုင်ပိတ်: blocked numbers cannot be bet
        const blockedSetB = new Set(await getAgentBlocked(currentSessionId));
        const blockedHitB = [];
        const allowedBoard = okItems.filter((it) => {
            const nn = String(it.number).padStart(2, '0');
            if (blockedSetB.has(nn)) { blockedHitB.push(nn); return false; }
            return true;
        });
        if (!allowedBoard.length) { saveInFlight = false; showToast('🚫 ဒိုင်ပိတ် ဂဏန်းတွေ ချည်း — တင် မရပါ'); return; }
        let addedBoard = 0;
        allowedBoard.forEach((it) => {
            if (addPendingUnique(playerName, it.number, it.amount, it._fromFormula, it.formula_text, it.line_idx)) addedBoard++;
        });
        await renderEntryTable();
        const blkMsgB = blockedHitB.length ? ' (🚫 ' + [...new Set(blockedHitB)].join(',') + ' ပိတ်)' : '';
        if (badLines.length) {
            // Keep bad lines on the board for fixing; keep modal open.
            ta.value = badLines.join('\n');
            updateBoardPreview();
            showToast('✅ ထည့်ပြီးပြီ · ❌ ' + badLines.length + ' လိုင်း ကျန် — ပြင်ပြီး Save ပြန်နှိပ်' + blkMsgB);
        } else {
            ta.value = '';
            closeBoard();
            showToast('✅ ထည့်ပြီးပြီ' + blkMsgB);
        }
    } catch (e) {
        console.error('[agent] saveBoard failed', e);
        showToast('❌ သိမ်းမရပါ: ' + e.message);
    } finally {
        saveInFlight = false;
    }
};

/* ================= Settings & sync ================= */

window.openSettings = function openSettings() {
    $('settingsSyncState').textContent =
        pb.isLoggedIn() ? '✅ ' + (sync.isOnline() ? 'Online' : 'Offline') : '📴 Local only';
    $('settingsModal').hidden = false;
};

window.closeSettings = function closeSettings() {
    $('settingsModal').hidden = true;
};

window.syncNowManual = async function syncNowManual() {
    updateSyncPill('working');
    try {
        const res = await sync.syncNow();
        const pushed = (res.push && res.push.pushed) || 0;
        const pulled = (res.pull && res.pull.pulled) || 0;
        const pullErr = (res.pull && res.pull.error) ? ' ❌' + res.pull.error : '';
        showToast('🔄 Sync ပြီးပြီ (↑' + pushed + ' ↓' + pulled + ')' + pullErr);
        await refreshSession();
        refreshActiveScreen();
    } catch (e) {
        showToast('❌ Sync မရပါ: ' + e.message);
    }
    updateSyncPill();
};

/** Pho Oct 18: Re-queue ALL local records for push (fixes records saved but never queued). */
window.repushAllManual = async function repushAllManual() {
    updateSyncPill('working');
    try {
        const res = await sync.repushAll();
        // Show the ACTUAL push result from repushAll (not a second skipped syncNow)
        let msg = '📤 ' + (res.queued || 0) + ' ခု queue';
        msg += '\n✅ ' + (res.pushed || 0) + ' တင်';
        if (res.failed) msg += ' ❌ ' + res.failed + ' မရ';
        if (res.errors && res.errors.length) {
            msg += '\n' + res.errors.slice(0, 5).join('\n');
        }
        showToast(msg);
        await refreshSession();
        refreshActiveScreen();
    } catch (e) {
        showToast('❌ မရပါ: ' + e.message);
    }
    updateSyncPill();
};

/** Diagnose: try pushing ONE queued item and show the exact error. */
window.diagnosePush = async function diagnosePush() {
    const q = await db.getAll('sync_queue').catch(() => []);
    if (!q.length) { showToast('Queue ဗလာ'); return; }
    const entry = q[0];
    showToast(`🔍 စမ်း: ${entry.op}:${entry.collection}…`);
    try {
        // Use the internal push for one entry (imported via sync module)
        const res = await sync.testPushOne(entry);
        showToast(`✅ ရတယ်: ${res}`);
    } catch (e) {
        showToast(`❌ Error ${e.code || '?'}: ${e.message || e}`);
    }
};

function updateSyncPill(force) {
    const pill = $('syncPill');
    if (!pill) return;
    // Pho Oct 19: Tap pill to see last error (mobile has no hover)
    if (!pill._errHandler) {
        pill._errHandler = true;
        pill.style.cursor = 'pointer';
        pill.addEventListener('click', () => {
            const e = (sync.lastPushError && sync.lastPushError()) || (sync.getLastPushError && sync.getLastPushError());
            if (e) alert('Sync Error:\n' + e);
            else showToast('✅ Sync OK — error မရှိ');
        });
    }
    pill.classList.remove('online', 'offline', 'working');
    const entryPill = $('entrySyncPill');
    const setPill = (el, cls, txt, title) => {
        if (!el) return;
        el.classList.remove('online', 'offline', 'working');
        el.classList.add(cls);
        el.textContent = txt;
        el.title = title;
    };
    // Pho Oct 19: Show last push error in title (for debugging)
    const lastErr = (sync.lastPushError && sync.lastPushError()) || null;
    if (force === 'working' || sync.isSyncing()) {
        setPill(pill, 'working', '🟡', 'Syncing…' + (lastErr ? ' | Err: ' + lastErr : ''));
        setPill(entryPill, 'working', '🟡 REST ပုံစံဖြင့် အလုပ်လုပ်နေသည်', 'Syncing…' + (lastErr ? ' | Err: ' + lastErr : ''));
    } else if (!sync.isOnline()) {
        setPill(pill, 'offline', '🔴', 'Offline — local only');
        setPill(entryPill, 'offline', '🔴', 'Offline');
    } else if (pb.isLoggedIn()) {
        // If there's a push error, show red instead of green
        if (lastErr) {
            setPill(pill, 'offline', '🔴', 'Push failed: ' + lastErr);
            setPill(entryPill, 'offline', '🔴 Push failed: ' + lastErr, 'Push failed');
        } else {
            setPill(pill, 'online', '🟢', 'Online & synced');
            setPill(entryPill, 'online', '🟢', 'Online');
        }
    } else {
        setPill(pill, 'offline', '⚪', 'Local only (no sync account)');
        setPill(entryPill, 'offline', '⚪', 'Local only');
    }
}

// Close modals on backdrop tap
document.addEventListener('click', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('modal')) {
        e.target.hidden = true;
    }
});

/* ================= Daily (တနေ့စာ) ================= */

const BURMESE_DAYS = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKey(ts) {
    let d;
    if (typeof ts === 'string' && isNaN(Number(ts))) {
        // ISO string from server (e.g., "2026-10-07T08:39:11.876Z")
        d = new Date(ts);
    } else {
        d = new Date(Number(ts) || 0);
    }
    if (isNaN(d.getTime())) d = new Date(0);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function toISODate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

async function getAgentRecords() {
    try {
        const all = await db.query('lottery_records', 'by_tenant', tenantId);
        return all.filter((r) => (r.agent_name || '') === agentName);
    } catch (e) {
        return [];
    }
}

window.renderDaily = async function renderDaily() {
    const dateInput = $('dailyDate');
    const playerSel = $('dailyPlayer');
    const content = $('dailyContent');
    if (!dateInput.value) dateInput.value = toISODate(new Date());
    const key = dateInput.value;

    // Populate person dropdown
    const players = await getPlayers().catch(() => []);
    const prevVal = playerSel.value;
    let pHtml = '<option value="__all">-- အားလုံး --</option>';
    pHtml += players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
    playerSel.innerHTML = pHtml;
    if (prevVal && Array.from(playerSel.options).some((o) => o.value === prevVal)) {
        playerSel.value = prevVal;
    }

    let recs = (await getAgentRecords()).filter((r) => dateKey(r.created) === key);
    const selPlayer = playerSel.value;
    if (selPlayer !== '__all') {
        recs = recs.filter((r) => (r.player_name || '') === selPlayer);
    }
    content.innerHTML = await renderDailyTable(recs, key);
};

/**
 * Daily summary table: grouped by session (AM/PM), rows = Name | တက်ငွေ | အပေါက်
 */
async function renderDailyTable(recs, dateKeyStr) {
    if (!recs.length) return '<div class="empty-state">ဒီနေ့ စာရင်း မရှိပါ</div>';

    // Player info for commission/multiplier
    const players = await getPlayers().catch(() => []);
    const playerInfo = {};
    players.forEach((p) => {
        playerInfo[p.name || ''] = {
            commission: Number(p.commission) || 0,
            multiplier: Number(p.multiplier) || 80
        };
    });
    const getInfo = (name) => playerInfo[name || ''] || { commission: 0, multiplier: 80 };

    // Sessions for names
    const sessions = await getAgentSessions().catch(() => []);
    const sessName = (id) => (sessions.find((s) => s.id === id) || {}).name || '';

    // Winning numbers per session
    const sessIds = [...new Set(recs.map((r) => r.session).filter(Boolean))];
    const winBySess = {};
    for (const sid of sessIds) {
        try {
            const wins = await _getWins(sid);
            winBySess[sid] = new Set(wins.map((w) => String(w.number).padStart(2, '0')));
        } catch (e) { winBySess[sid] = new Set(); }
    }

    // Group by session
    const bySess = {};
    const sessOrder = [];
    recs.forEach((r) => {
        const sid = r.session || '__nosess';
        if (!bySess[sid]) { bySess[sid] = []; sessOrder.push(sid); }
        bySess[sid].push(r);
    });

    let html = '';
    for (const sid of sessOrder) {
        const sRecs = bySess[sid];
        const sName = sessName(sid);
        const winNums = winBySess[sid] || new Set();

        // Group by player within session
        const byPlayer = {};
        const pOrder = [];
        sRecs.forEach((r) => {
            const k = r.player_name || '';
            if (!byPlayer[k]) { byPlayer[k] = []; pOrder.push(k); }
            byPlayer[k].push(r);
        });

        html += '<div class="day-section"><div class="day-head"><span>📅 ' + escHtml(sName || dateKeyStr) + '</span></div>';
        html += '<table class="v-table"><thead><tr><th>အမည်</th><th>တက်ငွေ</th><th>အပေါက်</th></tr></thead><tbody>';

        let sessBet = 0, sessWin = 0;
        for (const k of pOrder) {
            const pRecs = byPlayer[k];
            const bet = pRecs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            const win = pRecs
                .filter((r) => winNums.has(String(r.number).padStart(2, '0')))
                .reduce((s, r) => s + (Number(r.amount) || 0), 0);
            sessBet += bet;
            sessWin += win;
            html += '<tr><td>' + escHtml(playerLabel(k)) + '</td><td>' + formatMoney(bet) + '</td><td>' + formatMoney(win) + '</td></tr>';
        }
        html += '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(sessBet) + '</td><td>' + formatMoney(sessWin) + '</td></tr></tfoot></table>';
        html += '</div>';
    }
    return html;
}

/**
 * Records grouped by player → per-player number groups (entry order) + totals.
 * Shared by daily & weekly views.
 * Applies per-player commission: net = amount × (1 - commission/100).
 */
async function renderPlayerGroups(recs, emptyMsg) {
    if (!recs.length) return '<div class="empty-state">' + escHtml(emptyMsg || 'စာရင်း မရှိပါ') + '</div>';

    // Check which batches Master has confirmed (via batch_acks)
    // Ok shows ONLY when Master has truly received the batch
    // Note: ack uses SERVER session ID, local records use local ID - map via _pbId
    let ackedBatches = new Set();
    try {
        const ackRes = await pb.list('batch_acks', { perPage: 200 });
        for (const a of (ackRes.items || ackRes)) {
            if (a.batch_key) ackedBatches.add(a.batch_key);
        }
    } catch (e) { /* ignore */ }
    // Match ack by (agent|player|batch) prefix - session-independent
    // This avoids local/server session ID mismatch issues
    const batchKeyPrefixFor = (r) => {
        return [r.agent_name, r.player_name || '', r.batch_no].join('|') + '|';
    };
    const isAcked = (r) => {
        const prefix = batchKeyPrefixFor(r);
        for (const ak of ackedBatches) {
            if (ak.startsWith(prefix)) return true;
        }
        return false;
    };

    // Build player info map: name → {commission, multiplier}
    const players = await getPlayers().catch(() => []);
    const playerInfo = {};
    players.forEach((p) => {
        playerInfo[p.name || ''] = {
            commission: Number(p.commission) || 0,
            multiplier: Number(p.multiplier) || 80
        };
    });
    const getInfo = (name) => playerInfo[name || ''] || { commission: 0, multiplier: 80 };
    const netAmt = (r) => {
        const info = getInfo(r.player_name);
        return (Number(r.amount) || 0) * (1 - info.commission / 100);
    };

    // Get winning numbers for sessions in these records
    const sessIds = [...new Set(recs.map((r) => r.session).filter(Boolean))];
    const winNums = new Set();
    for (const sid of sessIds) {
        try {
            const wins = await _getWins(sid);
            wins.forEach((w) => winNums.add(String(w.number).padStart(2, '0')));
        } catch (e) { /* ignore */ }
    }
    const isWin = (r) => winNums.has(String(r.number).padStart(2, '0'));

    const byPlayer = {};
    const order = [];
    recs.forEach((r) => {
        const k = r.player_name || '';
        if (!byPlayer[k]) { byPlayer[k] = []; order.push(k); }
        byPlayer[k].push(r);
    });

    let grandAmt = 0;
    let html = '';

    for (const k of order) {
        const pRecs = byPlayer[k];
        const info = getInfo(k);
        const pBet = pRecs.reduce((s, r) => s + netAmt(r), 0);
        const pWinRaw = pRecs.filter(isWin).reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const pPayout = pWinRaw * info.multiplier;
        const pTotal = pBet - pPayout;
        grandAmt += pTotal;
        // group by batch_no, entry order of first appearance
        const byBatch = {};
        const batchOrder = [];
        pRecs.forEach((r) => {
            const b = Number(r.batch_no) || 0;
            if (!byBatch[b]) { byBatch[b] = []; batchOrder.push(b); }
            byBatch[b].push(r);
        });
        batchOrder.sort((a, b) => a - b);
        html += '<div class="player-group">' +
            '<div class="player-group-name">' + escHtml(playerLabel(k)) + '</div>';
        batchOrder.forEach((b) => {
            const bAmt = byBatch[b].reduce((s, r) => s + netAmt(r), 0);
            const firstR = byBatch[b][0];
            const acked = firstR && isAcked(firstR);
            const okBadge = acked ? ' <span style="color:#4ade80;font-size:12px">✅ Ok</span>' : '';
            html += '<div class="v-batch">' +
                '<div class="v-batch-no">' + escHtml(batchLabel(b)) + okBadge + '</div>' +
                '<table class="v-table"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th></tr></thead><tbody>' +
                byBatch[b].map((r) =>
                    '<tr><td>' + escHtml(r.number) + '</td><td>' + formatMoney(netAmt(r)) + '</td></tr>'
                ).join('') +
                '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(bAmt) + '</td></tr></tfoot></table>' +
                '</div>';
        });
        // Summary: ထိုးငွေပေါင်း | အပေါက် | Total
        html += '<div class="player-summary" style="display:flex;gap:8px;margin:8px 0;font-size:14px">' +
            '<span>ထိုးငွေ: <b>' + formatMoney(pBet) + '</b></span>' +
            '<span>အပေါက်: <b>' + formatMoney(pWinRaw) + '</b></span>' +
            '<span>Total: <b style="color:' + (pTotal >= 0 ? '#22c55e' : '#ef4444') + '">' + formatMoney(pTotal) + '</b></span>' +
            '</div>';
        html += '</div>';
    }

    html += '<div class="voucher-total"><span>စုစုပေါင်း</span><b>' + formatMoney(grandAmt) +
        '</b></div>';
    return html;
}

/* ================= Weekly (တပတ်စာ) ================= */

let weekOffset = 0; // 0 = this week, -1 = last week, +1 = next week

window.changeWeek = function changeWeek(d) {
    weekOffset = (d === 0) ? 0 : weekOffset + d;
    renderWeekly();
};

window.renderWeekly = async function renderWeekly() {
    const label = $('weekLabel');
    const content = $('weeklyContent');

    const base = new Date();
    base.setDate(base.getDate() + weekOffset * 7);
    const monday = getWeekMonday(base);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);

    label.textContent = formatDateStr(monday) + ' – ' + formatDateStr(sunday);

    const recs = await getAgentRecords();
    // Player info for commission/multiplier
    const players = await getPlayers().catch(() => []);
    const playerInfo = {};
    players.forEach((p) => {
        playerInfo[p.name || ''] = {
            commission: Number(p.commission) || 0,
            multiplier: Number(p.multiplier) || 80
        };
    });
    const getInfo = (name) => playerInfo[name || ''] || { commission: 0, multiplier: 80 };
    // Winning numbers per session
    const sessIds = [...new Set(recs.map((r) => r.session).filter(Boolean))];
    const winBySess = {};
    for (const sid of sessIds) {
        try {
            const wins = await _getWins(sid);
            winBySess[sid] = new Set(wins.map((w) => String(w.number).padStart(2, '0')));
        } catch (e) { winBySess[sid] = new Set(); }
    }
    const byDay = {};
    recs.forEach((r) => {
        const k = dateKey(r.created);
        (byDay[k] = byDay[k] || []).push(r);
    });

    let weekBet = 0, weekWin = 0, weekTotal = 0;
    let html = '';
    let shownDays = 0;

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        const key = toISODate(d);
        const dayRecs = byDay[key] || [];
        if (!dayRecs.length) continue;
        shownDays++;

        const dayName = BURMESE_DAYS[d.getDay()];
        html += '<div class="day-section">' +
            '<div class="day-head"><span>📅 ' + dayName + ' <span class="muted-sm">' + formatDateStr(d) + '</span></span></div>';

        const perPlayer = {};
        const pOrder = [];
        dayRecs.forEach((r) => {
            const k = r.player_name || '';
            if (!perPlayer[k]) { perPlayer[k] = { bet: 0, win: 0 }; pOrder.push(k); }
            // Columns show RAW entered amounts; commission is applied only inside Total.
            perPlayer[k].bet += Number(r.amount) || 0;
            const winNums = winBySess[r.session] || new Set();
            if (winNums.has(String(r.number).padStart(2, '0'))) {
                perPlayer[k].win += Number(r.amount) || 0;
            }
        });
        html += '<table class="v-table"><thead><tr><th>အမည်</th><th>တက်ငွေ</th><th>အပေါက်</th><th>Total</th></tr></thead><tbody>';
        let dayBet = 0, dayWin = 0, dayTotal = 0;
        pOrder.forEach((k) => {
            const info = getInfo(k);
            const bet = perPlayer[k].bet;
            const win = perPlayer[k].win;
            const total = (win * info.multiplier) - (bet * (1 - info.commission / 100));
            dayBet += bet; dayWin += win; dayTotal += total;
            html += '<tr><td>' + escHtml(playerLabel(k)) + '</td><td>' + formatMoney(bet) + '</td><td>' + formatMoney(win) +
                '</td><td style="color:' + (total >= 0 ? '#22c55e' : '#ef4444') + '">' + formatMoney(total) + '</td></tr>';
        });
        html += '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(dayBet) + '</td><td>' + formatMoney(dayWin) +
            '</td><td>' + formatMoney(dayTotal) + '</td></tr></tfoot></table>';
        html += '</div>';
        weekBet += dayBet; weekWin += dayWin; weekTotal += dayTotal;
    }

    if (!shownDays) {
        html = '<div class="empty-state">စာရင်း မရှိပါ</div>';
    } else {
        html += '<div class="voucher-total"><span>📊 တပတ် စုစုပေါင်း</span><b>' + formatMoney(weekTotal) +
            '</b></div>';
    }
    content.innerHTML = html;
};

/* 🔄 App Reset: clear all local data and reload */
window.resetAgentApp = async function resetAgentApp() {
    if (!confirm('App data အကုန် ရှင်း မလား? (code ပြန် ထည့် ရ မယ်)')) return;
    // Pho Oct 19: Nuclear reset — clear each store directly.
    try {
        const stores = ['tenants', 'sessions', 'lottery_records', 'winning_numbers', 'agents', 'app_settings', 'players', 'sync_queue'];
        for (const s of stores) {
            try { await db.clear(s); } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
    location.reload();
};

/** Long-press Edit/Delete for voucher rows (Pho's spec: nothing shows until long-press) */
(function() {
    let pressTimer = null;
    let pressTarget = null;

    const clearPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        pressTarget = null;
    };

    let startX = 0, startY = 0;
    const onPressStart = (e) => {
        let tgt = e.target;
        // Handle text nodes
        if (tgt && tgt.nodeType === 3) tgt = tgt.parentElement;
        if (!tgt || !tgt.closest) return;
        const trG = tgt.closest('tr[data-rids]');
        if (trG) {
            pressTarget = trG;
            const tg = e.touches ? e.touches[0] : e;
            startX = tg.clientX || 0; startY = tg.clientY || 0;
            pressTimer = setTimeout(() => {
                showGroupMenu(pressTarget.getAttribute('data-rids'), e);
                clearPress();
            }, 600);
            return;
        }
        const tr = tgt.closest('tr[data-rid]');
        if (!tr) return;
        pressTarget = tr;
        const t = e.touches ? e.touches[0] : e;
        startX = t.clientX || 0; startY = t.clientY || 0;
        pressTimer = setTimeout(() => {
            showEditDeleteMenu(pressTarget.getAttribute('data-rid'), e);
            clearPress();
        }, 600);
    };
    const onPressMove = (e) => {
        if (!pressTimer) return;
        const t = e.touches ? e.touches[0] : e;
        const dx = Math.abs((t.clientX || 0) - startX);
        const dy = Math.abs((t.clientY || 0) - startY);
        if (dx > 10 || dy > 10) clearPress();
    };

    document.addEventListener('touchstart', onPressStart, { passive: true });
    document.addEventListener('touchend', clearPress);
    document.addEventListener('touchmove', onPressMove, { passive: true });
    // Use contextmenu (long-press) as primary trigger - more reliable on Android
    document.addEventListener('contextmenu', (e) => {
        let tgt = e.target;
        if (tgt && tgt.nodeType === 3) tgt = tgt.parentElement;
        if (tgt && tgt.closest) {
            const trG = tgt.closest('tr[data-rids]');
            if (trG) {
                e.preventDefault();
                clearPress();
                showGroupMenu(trG.getAttribute('data-rids'), e);
                return;
            }
            const tr = tgt.closest('tr[data-rid]');
            if (tr) {
                e.preventDefault();
                clearPress();
                showEditDeleteMenu(tr.getAttribute('data-rid'), e);
            }
        }
    });
    document.addEventListener('mousedown', (e) => { if (e.button === 0) onPressStart(e); });
    document.addEventListener('mouseup', clearPress);
    document.addEventListener('mousemove', (e) => { if (pressTimer && e.buttons === 0) clearPress(); });

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
        setTimeout(() => {
            document.addEventListener('click', closeEditDeleteMenu, { once: true });
        }, 100);
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
            const r = await db.get('lottery_records', rid);
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
            const r = await db.get('lottery_records', rid);
            if (!r) return;
            r.number = num;
            r.amount = amt;
            await db.put('lottery_records', r);
            await sync.mutate('update', 'lottery_records', { id: rid, number: num, amount: amt });
            closeEditDeleteMenu();
            if (window.renderRecordsView) await window.renderRecordsView();
        } catch (e) { alert('Error: ' + e.message); }
    };

    window.deleteRecord = async function(rid) {
        closeEditDeleteMenu();
        if (!confirm('ဖျက်မလား?')) return;
        try {
            await db.del('lottery_records', rid);
            await sync.mutate('delete', 'lottery_records', { id: rid });
            if (window.renderRecordsView) await window.renderRecordsView();
        } catch (e) { alert('Error: ' + e.message); }
    };

    // Pho Oct 20: Long-press on GROUPED formula rows — edit/delete the whole group.
    // Grouped rows carry data-rids (all record IDs in the formula group).
    let _grpIds = [];
    const _grpRefresh = async () => {
        if (window.renderRecordsView) await window.renderRecordsView();
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
        setTimeout(() => {
            document.addEventListener('click', closeEditDeleteMenu, { once: true });
        }, 100);
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
            const r = await db.get('lottery_records', id);
            if (r) recs.push(r);
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
                const r = await db.get('lottery_records', id);
                if (!r) continue;
                if (String(r.number) !== num || Number(r.amount) !== amt) {
                    r.number = num; r.amount = amt;
                    await db.put('lottery_records', r);
                    await sync.mutate('update', 'lottery_records', { id, number: num, amount: amt });
                }
            }
            closeEditDeleteMenu();
            await _grpRefresh();
        } catch (e) { alert('Error: ' + e.message); }
    };
    window.deleteOneInGroup = async function(rid) {
        if (!confirm('ဒီ ၁ ကွက် ဖျက်မလား?')) return;
        try {
            await db.del('lottery_records', rid);
            await sync.mutate('delete', 'lottery_records', { id: rid });
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
            const r = await db.get('lottery_records', id);
            if (r) total += Number(r.amount) || 0;
        }
        if (!confirm(ids.length + ' ကွက် လုံး ဖျက်မလား? (စုစုပေါင်း ' + total + ')')) return;
        try {
            for (const id of ids) {
                await db.del('lottery_records', id);
                await sync.mutate('delete', 'lottery_records', { id });
            }
            await _grpRefresh();
        } catch (e) { alert('Error: ' + e.message); }
    };
})();

