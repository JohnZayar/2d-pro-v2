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

import * as db from '../shared/db.js';
import * as pb from '../shared/pb.js';
import * as sync from '../shared/sync.js?v=5';
import { parseBoardReport, parseLine } from '../shared/parser.js';
import { uid, formatMoney, formatDateStr, getWeekMonday, showToast, escHtml, debounce } from '../shared/utils.js';

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
        const wins = await db.query('winning_numbers', 'by_session', sessionId);
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

async function init() {
    pb.loadBaseUrl(); // custom server URL override (if Pho set one)
    pb.loadAuth();
    // Auto-login as shared agent account for PocketBase sync (if not already logged in)
    if (!pb.isLoggedIn()) {
        try {
            await pb.login('agent@2dpro.local', 'Agent2DPro2026Sync!');
        } catch (e) {
            // Sync will work offline; login failure is non-fatal
            console.warn('Agent auto-login failed:', e.message);
        }
    }
    try {
        await db.openDB();
    } catch (e) {
        showToast('❌ Local DB ဖွင့်မရပါ: ' + e.message);
        return;
    }

    tenantId = localStorage.getItem(LS_TENANT) || '';
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

    if (tenantId && agentName) {
        showApp();
        await refreshSession();
        // Background sync (non-blocking) — refreshes UI when new data arrives
        sync.startAutoSync(60000, autoSyncRefresh);
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
    }
    updateSyncPill();
    window.addEventListener('online', updateSyncPill);
    window.addEventListener('offline', updateSyncPill);
    // Phone sleep → foreground: sync immediately so stale data doesn't linger
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && pb.isLoggedIn()) {
            sync.syncNow().then((res) => autoSyncRefresh(res)).catch(() => updateSyncPill());
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
    document.getElementById('settingsTenantCode').textContent = tenantId;
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
        // Verify tenant exists: try local DB first, then PocketBase (if logged in).
        let tenant = await db.get('tenants', code);
        if (!tenant && pb.isLoggedIn()) {
            try {
                const pbTenant = await pb.getOne('tenants', code);
                tenant = { id: pbTenant.id, name: pbTenant.name };
                await db.put('tenants', tenant);
            } catch (e) { /* not found remotely either */ }
        }
        // Local-first: accept the code even if unverified (works offline).
        if (!tenant) {
            tenant = { id: code, name: 'Main (' + code.slice(0, 6) + '…)' };
            await db.put('tenants', tenant);
        }

        tenantId = code;
        agentName = name;
        localStorage.setItem(LS_TENANT, code);
        localStorage.setItem(LS_AGENT_NAME, name);

        showApp();
        await refreshSession();
        sync.startAutoSync(60000, autoSyncRefresh);
        sync.syncNow().catch(() => {});
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

window.disconnectAgent = function disconnectAgent() {
    if (!confirm('ထွက်မှာလား? (local စာရင်းတွေ ဖုန်းထဲ ကျန်မယ်)')) return;
    localStorage.removeItem(LS_TENANT);
    localStorage.removeItem(LS_AGENT_NAME);
    localStorage.removeItem(LS_SESSION);
    location.reload();
};

/* ================= Sessions ================= */

/** Pick the latest open session for this tenant (local-first). */
async function refreshSession() {
    try {
        const sessions = (await db.query('sessions', 'by_tenant', tenantId))
            .sort((a, b) => (b.created || 0) - (a.created || 0));
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
                const wins = await db.query('winning_numbers', 'by_session', pick.id);
                if (wins && wins.length) {
                    winHtml = ' &nbsp;🏆 <b>' + wins.map((w) => escHtml(String(w.number).padStart(2, '0'))).join(' ') + '</b>';
                    // 🔔 NEW winning number alert (first sighting only)
                    if (!_agentRemind.knownWins[pick.id]) {
                        _agentRemind.knownWins[pick.id] = true;
                        const nums = wins.map((w) => String(w.number).padStart(2, '0')).join(' ');
                        showToast('🏆 ပေါက်သီး ထွက်ပြီ: ' + nums);
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
        return sessions.sort((a, b) => (b.created || 0) - (a.created || 0));
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
    tbody.innerHTML = pendingEntries.map((e, i) =>
        '<tr>' +
            '<td>' + escHtml(e.player_name || 'ကိုယ်တိုင်') + '</td>' +
            '<td class="cell-no">' + escHtml(e.number) + '</td>' +
            '<td class="cell-amt">' + formatMoney(e.amount) + '</td>' +
            '<td class="cell-del"><button class="rec-del" onclick="deletePendingEntry(' + i + ')" title="ဖျက်မည်">🗑️</button></td>' +
        '</tr>'
    ).join('');
}

/** Remove one pending (unsaved) entry. */
window.deletePendingEntry = function deletePendingEntry(i) {
    pendingEntries.splice(i, 1);
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
    // (e.g. 12ဖုံ → "12ဖုံ"). Only accept real 2-digit numbers.
    const validItems = items.filter((it) => /^\d{2}$/.test(String(it.number)));
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
    allowedItems.forEach((it) => {
        pendingEntries.push({ player_name: playerName, number: it.number, amount: it.amount });
    });
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
    if (!pendingEntries.length) { showToast('စာရင်း မရှိသေးပါ'); return; }
    if (!currentSessionId) { showToast('⚠️ Session မရှိသေးပါ'); return; }
    const lkS = await isAgentSessionLocked(currentSessionId);
    if (lkS.locked) { showToast('🔒 ' + lkS.reason + ' — သိမ်း မရပါ'); return; }

    saveInFlight = true;
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
                    created: Date.now()
                });
                count++;
            }
        }
        pendingEntries = [];
        await renderEntryTable();
        updateSyncPill();
        showToast('✅ သိမ်းပြီးပြီ');
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
    pHtml += '<option value="">🧍 ကိုယ်တိုင်</option>';
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
        const wins = await db.query('winning_numbers', 'by_session', sessId);
        winNums = new Set(wins.map((w) => String(w.number).padStart(2, '0')));
    } catch (e) { /* ignore */ }

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
            const items = byBatch[b]; // entry order — NEVER re-sorted, matches what was sent
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
    voucherPlayers.forEach((p) => {
        html += '<div class="v-player-block">' +
            '<div class="v-player-name">' + escHtml(p.label) + '</div>';
        p.batches.forEach((b) => {
            html += '<div class="v-batch">' +
                '<div class="v-batch-no" onclick="openBatchDetail(\'' + escHtml(p.key) + '\',' + b.no + ')" title="အသေးစိတ် ကြည့်ရန် (ပြင်/ဖျက်)">' + escHtml(b.label) + '</div>' +
                '<table class="v-table"><thead><tr><th>ဂဏန်း</th><th>ပမာဏ</th></tr></thead><tbody>' +
                b.items.map((r) => {
                    const numStr = String(r.number).padStart(2, '0');
                    const isWin = winNums.has(numStr);
                    return '<tr' + (isWin ? ' class="win-row"' : '') + '><td' + (isWin ? ' class="win-cell"' : '') + '>' +
                        escHtml(r.number) + '</td><td' + (isWin ? ' class="win-cell"' : '') + '>' + formatMoney(r.amount) + '</td></tr>';
                }).join('') +
                '</tbody><tfoot><tr><td>Total</td><td>' + formatMoney(b.totalAmt) + '</td></tr></tfoot></table>' +
                '</div>';
        });
        html += '</div>';
    });
    html += '<div class="voucher-total"><span>စုစုပေါင်း</span><b>' + formatMoney(grandAmt) +
        '</b></div>';
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
            b.items.forEach((r) => {
                lines.push(r.number + ' ' + (Number(r.amount) || 0));
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
    sel.innerHTML = '<option value="">🧍 ကိုယ်တိုင်</option>' +
        players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
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
        html += `<div class="bline ${ok ? 'ok' : 'bad'}"><span class="mk">${ok ? '✅' : '❌'}</span><span class="tx">${escHtml(line)}</span></div>`;
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
    const lkB = await isAgentSessionLocked(currentSessionId);
    if (lkB.locked) { showToast('🔒 ' + lkB.reason + ' — တင် မရပါ'); return; }
    const ta = $('boardTextarea');
    const text = ta.value;
    if (!text.trim()) { showToast('စာရွက် လွတ်နေတယ်'); return; }
    if (!currentSessionId) { showToast('⚠️ Session မရှိသေးပါ'); return; }

    saveInFlight = true;
    try {
        const playerName = $('boardPlayer').value || null;
        // Strict per-line: only fully-valid lines are entered. Bad lines stay
        // on the board for fixing — never guess-entered.
        const okItems = [];
        const badLines = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            if (!boardLineOk(line)) { badLines.push(line); continue; }
            let parsed = [];
            try { parsed = parseLine(line); } catch (e) { parsed = []; }
            for (const p of parsed) okItems.push(p);
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
        allowedBoard.forEach((it) => {
            pendingEntries.push({ player_name: playerName, number: it.number, amount: it.amount });
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
    const urlInput = $('serverUrlInput');
    if (urlInput) {
        const cur = pb.getBaseUrl();
        const def = pb.getDefaultBaseUrl();
        urlInput.value = cur === def ? '' : cur;
        urlInput.placeholder = def;
    }
    $('settingsModal').hidden = false;
};

window.saveServerUrl = function saveServerUrl() {
    const v = ($('serverUrlInput').value || '').trim();
    if (v && !/^https?:\/\//i.test(v)) { showToast('URL က https:// နဲ့ စရမယ်'); return; }
    if (v) pb.setBaseUrl(v); else pb.clearBaseUrl();
    showToast('✅ Server URL သိမ်းပြီးပြီ — reload လုပ်ပါ');
    closeSettings();
};

window.resetServerUrl = function resetServerUrl() {
    pb.clearBaseUrl();
    $('serverUrlInput').value = '';
    showToast('✅ Default URL ပြန်သုံးမယ် — reload လုပ်ပါ');
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
        showToast('🔄 Sync ပြီးပြီ (↑' + pushed + ' ↓' + pulled + ')');
        await refreshSession();
        refreshActiveScreen();
    } catch (e) {
        showToast('❌ Sync မရပါ: ' + e.message);
    }
    updateSyncPill();
};

function updateSyncPill(force) {
    const pill = $('syncPill');
    if (!pill) return;
    pill.classList.remove('online', 'offline', 'working');
    const entryPill = $('entrySyncPill');
    const setPill = (el, cls, txt, title) => {
        if (!el) return;
        el.classList.remove('online', 'offline', 'working');
        el.classList.add(cls);
        el.textContent = txt;
        el.title = title;
    };
    if (force === 'working' || sync.isSyncing()) {
        setPill(pill, 'working', '🟡', 'Syncing…');
        setPill(entryPill, 'working', '🟡 REST ပုံစံဖြင့် အလုပ်လုပ်နေသည်', 'Syncing…');
    } else if (!sync.isOnline()) {
        setPill(pill, 'offline', '🔴', 'Offline — local only');
        setPill(entryPill, 'offline', '🔴', 'Offline');
    } else if (pb.isLoggedIn()) {
        setPill(pill, 'online', '🟢', 'Online & synced');
        setPill(entryPill, 'online', '🟢', 'Online');
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
    pHtml += '<option value="">🧍 ကိုယ်တိုင်</option>';
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
            const wins = await db.query('winning_numbers', 'by_session', sid);
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
            const info = getInfo(k);
            const bet = pRecs.reduce((s, r) => s + (Number(r.amount) || 0) * (1 - info.commission / 100), 0);
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
            const wins = await db.query('winning_numbers', 'by_session', sid);
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
            html += '<div class="v-batch">' +
                '<div class="v-batch-no">' + escHtml(batchLabel(b)) + '</div>' +
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
            const wins = await db.query('winning_numbers', 'by_session', sid);
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
