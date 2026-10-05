/**
 * app.js — 2D Agent Pro v2 (local-first)
 *
 * Flow:
 *  1. First run → link screen (tenant link code + agent name).
 *  2. Connected → main screen: session banner, big board button, records list.
 *  3. Digital board → parseBoard() → optimistic local save via sync.mutate()
 *     (instant UI + background PocketBase sync).
 *  4. Background sync: syncNow() on boot, startAutoSync(60s), manual button.
 */

import * as db from '../shared/db.js';
import * as pb from '../shared/pb.js';
import * as sync from '../shared/sync.js';
import { parseBoard, parseBoardReport } from '../shared/parser.js';
import { uid, formatMoney, formatDateStr, getWeekMonday, showToast, escHtml, debounce } from '../shared/utils.js';

const LS_TENANT = 'v2_agent_tenant';
const LS_AGENT_NAME = 'v2_agent_name';
const LS_SESSION = 'v2_agent_session';

let tenantId = null;
let agentName = null;
let currentSessionId = null;
let saveInFlight = false; // double-tap guard

/* ================= Boot ================= */

document.addEventListener('DOMContentLoaded', init);

async function init() {
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

    if (tenantId && agentName) {
        showApp();
        await refreshSession();
        await renderRecords();
        // Background sync (non-blocking)
        sync.startAutoSync(60000);
        sync.syncNow().then(() => {
            updateSyncPill();
            refreshSession();
            renderRecords();
            refreshActiveScreen();
        }).catch(() => updateSyncPill());
    } else {
        showLinkScreen();
    }
    updateSyncPill();
    window.addEventListener('online', updateSyncPill);
    window.addEventListener('offline', updateSyncPill);
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
    const errEl = document.getElementById('linkError');

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
        // Record will reconcile on first sync.
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
        await renderRecords();
        sync.startAutoSync(60000);
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
            banner.innerHTML = '📌 <b>' + escHtml(pick.name || 'Session') + '</b>';
        } else {
            currentSessionId = null;
            localStorage.removeItem(LS_SESSION);
            banner.textContent = 'Session မရှိသေးပါ — Main ဖွင့်မှ ပေါ်မယ်';
        }
    } catch (e) {
        console.warn('[agent] refreshSession failed', e);
    }
}

/* ================= Digital board ================= */

window.openBoard = function openBoard() {
    if (!currentSessionId) {
        showToast('⚠️ Session မရှိသေးပါ');
        return;
    }
    populateBoardPlayer();
    document.getElementById('boardModal').hidden = false;
    document.getElementById('boardPreview').hidden = true;
    document.getElementById('boardKeyboard').hidden = true;
    const ta = document.getElementById('boardTextarea');
    ta.value = '';
    setTimeout(() => ta.focus(), 100);
};

/** Fill the "who is this bet for" select in the board modal. */
async function populateBoardPlayer() {
    const sel = document.getElementById('boardPlayer');
    const players = await getPlayers();
    let html = '<option value="">🧍 ကိုယ်တိုင်</option>';
    html += players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
    sel.innerHTML = html;
    // Default to first player when players exist, else self.
    sel.value = players.length ? players[0].name : '';
}

window.closeBoard = function closeBoard() {
    document.getElementById('boardModal').hidden = true;
};

window.pasteToBoard = async function pasteToBoard() {
    try {
        const text = await navigator.clipboard.readText();
        const ta = document.getElementById('boardTextarea');
        ta.value = (ta.value ? ta.value + '\n' : '') + text;
        updateBoardPreview();
    } catch (e) {
        showToast('📋 Paste ခွင့်မရှိပါ — ကိုယ်တိုင် paste လုပ်ပါ');
    }
};

const updateBoardPreview = debounce(() => {
    const text = document.getElementById('boardTextarea').value;
    const box = document.getElementById('boardPreview');
    if (!text.trim()) { box.hidden = true; return; }
    const { items, invalidLines } = parseBoardReport(text);
    box.hidden = false;
    box.innerHTML = '✅ <b>' + items.length + '</b> ကွက် ဝင်မယ်' +
        (invalidLines.length ? ' &nbsp; <span class="warn">⚠️ ' + invalidLines.length + ' လိုင်း ပြင်ရန်</span>' : '');
}, 400);

document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'boardTextarea') updateBoardPreview();
});

/**
 * Save board → parse → optimistic local records via sync.mutate().
 * Valid lines save; invalid lines stay in the textarea for correction.
 */
window.saveBoard = async function saveBoard() {
    if (saveInFlight) return;
    const ta = document.getElementById('boardTextarea');
    const text = ta.value;
    if (!text.trim()) { showToast('စာရွက် လွတ်နေတယ်'); return; }
    if (!currentSessionId) { showToast('⚠️ Session မရှိသေးပါ'); return; }

    saveInFlight = true;
    try {
        const { items, invalidLines } = parseBoardReport(text);
        const playerName = document.getElementById('boardPlayer').value || null;
        let savedCount = 0;

        for (const it of items) {
            await sync.mutate('create', 'lottery_records', {
                id: uid(),
                tenant: tenantId,
                session: currentSessionId,
                number: it.number,
                amount: it.amount,
                agent_name: agentName,
                player_name: playerName,
                record_type: 'pos',
                batch_no: null,
                created: Date.now()
            });
            savedCount++;
        }

        // Optimistic UI: re-render immediately from local DB.
        await renderRecords();
        refreshActiveScreen();

        if (invalidLines.length) {
            ta.value = invalidLines.join('\n');
            showToast('✅ ' + savedCount + ' ကွက် ဝင်ပြီ — ⚠️ ' + invalidLines.length + ' လိုင်း ပြင်ရန်');
        } else {
            ta.value = '';
            closeBoard();
            showToast('✅ ' + savedCount + ' ကွက် သိမ်းပြီးပြီ');
        }
        updateSyncPill();
    } catch (e) {
        console.error('[agent] saveBoard failed', e);
        showToast('❌ သိမ်းမရပါ: ' + e.message);
    } finally {
        saveInFlight = false;
    }
};

/* ================= Records list ================= */

async function renderRecords() {
    const listEl = document.getElementById('recordsList');
    const emptyEl = document.getElementById('recordsEmpty');
    if (!currentSessionId) {
        listEl.innerHTML = '';
        emptyEl.hidden = false;
        document.getElementById('recordCount').textContent = '0';
        document.getElementById('totalAmount').textContent = '0';
        document.getElementById('totalCount').textContent = '0';
        return;
    }
    let recs = [];
    try {
        recs = await db.query('lottery_records', 'by_session', currentSessionId);
    } catch (e) {
        console.warn('[agent] renderRecords query failed', e);
    }
    // This agent's records only, newest first.
    recs = recs
        .filter((r) => (r.agent_name || '') === agentName)
        .sort((a, b) => (b.created || 0) - (a.created || 0));

    document.getElementById('recordCount').textContent = recs.length;
    const total = recs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    document.getElementById('totalAmount').textContent = formatMoney(total);
    document.getElementById('totalCount').textContent = recs.length;

    if (!recs.length) {
        listEl.innerHTML = '';
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = recs.map((r) =>
        '<div class="record-row">' +
            '<span class="rec-no">' + escHtml(r.number) +
                (r.player_name ? '<span class="rec-player">' + escHtml(r.player_name) + '</span>' : '') +
            '</span>' +
            '<span class="rec-amt">' + formatMoney(r.amount) + '</span>' +
            '<span class="rec-actions">' +
                '<button class="rec-edit" onclick="openEditRecord(\'' + r.id + '\')" title="ပြင်မည်">✏️</button>' +
                '<button class="rec-del" onclick="deleteRecord(\'' + r.id + '\')" title="ဖျက်မည်">🗑️</button>' +
            '</span>' +
        '</div>'
    ).join('');
}

window.deleteRecord = async function deleteRecord(id) {
    const rec = await db.get('lottery_records', id);
    if (!rec) return;
    if (!confirm(rec.number + ' (' + formatMoney(rec.amount) + ') ဖျက်မှာလား?')) return;
    await sync.mutate('delete', 'lottery_records', { id });
    await renderRecords();
    refreshActiveScreen();
    refreshVoucherDetail();
    showToast('🗑️ ဖျက်ပြီးပြီ');
};

/* ================= Edit record (အမှားပြင်ရန်) ================= */

let editingRecordId = null;

window.openEditRecord = async function openEditRecord(id) {
    const rec = await db.get('lottery_records', id);
    if (!rec) return;
    editingRecordId = id;
    document.getElementById('editNumberInput').value = rec.number || '';
    document.getElementById('editAmountInput').value = rec.amount || '';
    document.getElementById('editModal').hidden = false;
    setTimeout(() => document.getElementById('editAmountInput').focus(), 100);
};

window.closeEditModal = function closeEditModal() {
    document.getElementById('editModal').hidden = true;
    editingRecordId = null;
};

window.saveEditRecord = async function saveEditRecord() {
    if (!editingRecordId) return;
    const num = document.getElementById('editNumberInput').value.trim();
    const amt = Number(document.getElementById('editAmountInput').value);
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
        await renderRecords();
        refreshActiveScreen();
        refreshVoucherDetail();
        updateSyncPill();
        showToast('✅ ပြင်ပြီးပြီ');
    } catch (e) {
        showToast('❌ သိမ်းမရပါ: ' + e.message);
    }
};

/* ================= Settings & sync ================= */

window.openSettings = function openSettings() {
    document.getElementById('settingsSyncState').textContent =
        pb.isLoggedIn() ? '✅ ' + (sync.isOnline() ? 'Online' : 'Offline') : '📴 Local only';
    document.getElementById('settingsModal').hidden = false;
};

window.closeSettings = function closeSettings() {
    document.getElementById('settingsModal').hidden = true;
};

window.syncNowManual = async function syncNowManual() {
    updateSyncPill('working');
    try {
        const res = await sync.syncNow();
        const pushed = (res.push && res.push.pushed) || 0;
        const pulled = (res.pull && res.pull.pulled) || 0;
        showToast('🔄 Sync ပြီးပြီ (↑' + pushed + ' ↓' + pulled + ')');
        await refreshSession();
        await renderRecords();
        refreshActiveScreen();
    } catch (e) {
        showToast('❌ Sync မရပါ: ' + e.message);
    }
    updateSyncPill();
};

function updateSyncPill(force) {
    const pill = document.getElementById('syncPill');
    if (!pill) return;
    pill.classList.remove('online', 'offline', 'working');
    if (force === 'working' || sync.isSyncing()) {
        pill.classList.add('working');
        pill.textContent = '🟡';
        pill.title = 'Syncing…';
    } else if (!sync.isOnline()) {
        pill.classList.add('offline');
        pill.textContent = '🔴';
        pill.title = 'Offline — local only';
    } else if (pb.isLoggedIn()) {
        pill.classList.add('online');
        pill.textContent = '🟢';
        pill.title = 'Online & synced';
    } else {
        pill.classList.add('offline');
        pill.textContent = '⚪';
        pill.title = 'Local only (no sync account)';
    }
}

// Close modals on backdrop tap
document.addEventListener('click', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('modal')) {
        e.target.hidden = true;
    }
});

/* ================= Screens (home menu navigation) ================= */

let activeScreen = 'home';

/** Open a feature screen (players / voucher / daily / weekly). */
window.openScreen = function openScreen(name) {
    activeScreen = name;
    document.querySelectorAll('.screenpane').forEach((p) => { p.hidden = true; });
    const pane = document.getElementById('screen-' + name);
    if (pane) pane.hidden = false;
    // Always start at the top of the new screen.
    window.scrollTo(0, 0);
    refreshActiveScreen();
};

/** Back to the home menu screen. */
window.goHome = function goHome() {
    activeScreen = 'home';
    document.querySelectorAll('.screenpane').forEach((p) => { p.hidden = true; });
    document.getElementById('screen-home').hidden = false;
    window.scrollTo(0, 0);
    refreshActiveScreen();
};

/** Floating scroll-to-top button: show only when scrolled down. */
window.scrollToTop = function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.addEventListener('scroll', () => {
    const btn = document.getElementById('scrollTopBtn');
    if (btn) btn.hidden = window.scrollY < 300;
}, { passive: true });

/** Re-render whichever screen is currently visible (after data changes). */
function refreshActiveScreen() {
    if (activeScreen === 'home') { renderRecords(); updateMenuSubs(); }
    else if (activeScreen === 'players') renderPlayers();
    else if (activeScreen === 'voucher') renderVoucher();
    else if (activeScreen === 'daily') renderDaily();
    else if (activeScreen === 'weekly') renderWeekly();
}

/** Update the small subtitles on home menu cards (e.g. player count). */
async function updateMenuSubs() {
    try {
        const players = await getPlayers();
        const el = document.getElementById('menuPlayersSub');
        if (el) el.textContent = players.length ? players.length + ' ယောက်' : 'လူ ထည့်ရန်';
    } catch (e) { /* ignore */ }
}

/* ================= Players (လူစာရင်း) ================= */

let editingPlayerId = null;

/** This agent's players, sorted by name. */
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
    if (editId) {
        db.get('players', editId).then((p) => {
            if (p) {
                document.getElementById('playerNameInput').value = p.name || '';
                document.getElementById('playerPhoneInput').value = p.phone || '';
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
    if (!name) { showToast('နာမည် ထည့်ပါ'); return; }
    try {
        if (editingPlayerId) {
            const existing = (await db.get('players', editingPlayerId)) || {};
            await sync.mutate('update', 'players', Object.assign({}, existing, {
                id: editingPlayerId, name, phone
            }));
            showToast('✅ ပြင်ပြီးပြီ');
        } else {
            await sync.mutate('create', 'players', {
                id: uid(),
                tenant: tenantId,
                agent_name: agentName,
                name, phone,
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

    // Current-session totals per player (for quick reference).
    let sessRecs = [];
    if (currentSessionId) {
        try {
            sessRecs = (await db.query('lottery_records', 'by_session', currentSessionId))
                .filter((r) => (r.agent_name || '') === agentName);
        } catch (e) { /* ignore */ }
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
                '<div class="player-sess">ဒီ session: ' + formatMoney(t.amount) + ' (' + t.count + ' ကွက်)</div>' +
            '</div>' +
            '<button class="rec-del" onclick="deletePlayer(\'' + p.id + '\')" title="ဖျက်မည်">🗑️</button>' +
        '</div>';
    }).join('');
}

/* ================= Custom keyboard ================= */

window.toggleKeyboard = function toggleKeyboard() {
    const kb = document.getElementById('boardKeyboard');
    kb.hidden = !kb.hidden;
};

/** Insert key at cursor (or handle BS/CLR). */
window.kbPress = function kbPress(k) {
    const ta = document.getElementById('boardTextarea');
    if (k === 'BS') {
        const s = ta.selectionStart || ta.value.length;
        const e = ta.selectionEnd || ta.value.length;
        if (s !== e) ta.value = ta.value.slice(0, s) + ta.value.slice(e);
        else ta.value = ta.value.slice(0, Math.max(0, s - 1)) + ta.value.slice(s);
        const pos = Math.max(0, (s !== e ? s : s - 1));
        ta.setSelectionRange(pos, pos);
    } else if (k === 'CLR') {
        ta.value = '';
    } else {
        const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
        const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
        ta.value = ta.value.slice(0, s) + k + ta.value.slice(e);
        const pos = s + k.length;
        ta.setSelectionRange(pos, pos);
    }
    ta.focus();
    updateBoardPreview();
};

/* ================= Voucher (တဦးချင်းဘောက်ချာ) ================= */

/** Last rendered voucher context — used by Copy/Print/Share and detail view. */
let lastVoucher = null;
/** Number currently open in the voucher detail modal (for refresh after edit/delete). */
let voucherDetailNumber = null;

/** Group records by number → { number, amount, count }, sorted by number. */
function groupByNumber(recs) {
    const map = {};
    recs.forEach((r) => {
        const n = String(r.number || '');
        if (!map[n]) map[n] = { number: n, amount: 0, count: 0 };
        map[n].amount += Number(r.amount) || 0;
        map[n].count += 1;
    });
    return Object.values(map).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

async function getAgentSessions() {
    try {
        const sessions = await db.query('sessions', 'by_tenant', tenantId);
        return sessions.sort((a, b) => (b.created || 0) - (a.created || 0));
    } catch (e) {
        return [];
    }
}

window.renderVoucher = async function renderVoucher() {
    const playerSel = document.getElementById('voucherPlayer');
    const sessSel = document.getElementById('voucherSession');
    const content = document.getElementById('voucherContent');

    const players = await getPlayers();
    const sessions = await getAgentSessions();

    // Preserve selections across re-renders.
    const prevPlayer = playerSel.value;
    const prevSess = sessSel.value;

    let pHtml = '<option value="">🧍 ကိုယ်တိုင်</option>';
    pHtml += players.map((p) => '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>').join('');
    playerSel.innerHTML = pHtml;
    if (prevPlayer !== undefined && Array.from(playerSel.options).some((o) => o.value === prevPlayer)) {
        playerSel.value = prevPlayer;
    }

    sessSel.innerHTML = sessions.map((s) =>
        '<option value="' + s.id + '">' + escHtml(s.name || 'Session') + '</option>').join('');
    if (prevSess && Array.from(sessSel.options).some((o) => o.value === prevSess)) {
        sessSel.value = prevSess;
    } else if (currentSessionId) {
        sessSel.value = currentSessionId;
    }

    const selPlayer = playerSel.value; // '' = self (no player_name)
    const sessId = sessSel.value;
    if (!sessId) {
        lastVoucher = null;
        content.innerHTML = '<div class="empty-state">Session မရှိသေးပါ</div>';
        return;
    }

    let recs = [];
    try {
        recs = await db.query('lottery_records', 'by_session', sessId);
    } catch (e) { /* ignore */ }
    recs = recs.filter((r) =>
        (r.agent_name || '') === agentName &&
        (selPlayer ? (r.player_name || '') === selPlayer : !(r.player_name || ''))
    );

    if (!recs.length) {
        lastVoucher = null;
        content.innerHTML = '<div class="empty-state">စာရင်း မရှိသေးပါ</div>';
        return;
    }

    const grouped = groupByNumber(recs);
    const totalAmt = grouped.reduce((s, g) => s + g.amount, 0);
    const totalCount = grouped.reduce((s, g) => s + g.count, 0);

    // Save context for Copy/Print/Share + detail modal.
    const sessName = (sessions.find((s) => s.id === sessId) || {}).name || 'Session';
    lastVoucher = {
        playerName: selPlayer,
        playerLabel: selPlayer || 'ကိုယ်တိုင်',
        sessId,
        sessionName: sessName,
        dateLabel: formatDateStr(new Date()),
        groups: grouped,
        totalAmt,
        totalCount
    };

    content.innerHTML =
        '<div class="voucher-head">🧾 ' + escHtml(selPlayer || 'ကိုယ်တိုင်') +
        ' — <b>' + grouped.length + '</b> မျိုး, <b>' + formatMoney(totalAmt) + '</b></div>' +
        grouped.map((g) =>
            '<div class="voucher-row" onclick="openVoucherDetail(\'' + escHtml(g.number) + '\')" title="အသေးစိတ် ကြည့်ရန် / ပြင်ရန်">' +
                '<span class="v-no">' + escHtml(g.number) + '</span>' +
                '<span class="v-amt">' + formatMoney(g.amount) + '</span>' +
                '<span class="v-count">' + g.count + ' ကြိမ်</span>' +
            '</div>'
        ).join('') +
        '<div class="voucher-total"><span>စုစုပေါင်း</span><b>' + formatMoney(totalAmt) +
        ' (' + totalCount + ' ကွက်)</b></div>';
};

/* ================= Voucher actions: Copy / Print / Share ================= */

/** Build the paper-receipt text for the current voucher. */
function buildVoucherText() {
    const v = lastVoucher;
    if (!v) return '';
    const lines = [];
    lines.push('🧾 ဘောက်ချာ - ' + v.playerLabel);
    lines.push('📅 ' + v.dateLabel + ' | ' + v.sessionName);
    lines.push('─────────────');
    v.groups.forEach((g) => {
        lines.push(g.number + ' - ' + formatMoney(g.amount) + ' (' + g.count + ' ကြိမ်)');
    });
    lines.push('─────────────');
    lines.push('စုစုပေါင်း: ' + formatMoney(v.totalAmt) + ' (' + v.totalCount + ' ကွက်)');
    return lines.join('\n');
}

async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        // Fallback for older browsers / non-secure contexts.
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
    if (!v) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    const area = document.getElementById('printArea');
    area.innerHTML =
        '<div class="print-receipt">' +
            '<div class="pr-title">🧾 ဘောက်ချာ</div>' +
            '<div class="pr-sub">' + escHtml(v.playerLabel) + '</div>' +
            '<div class="pr-sub">' + escHtml(v.dateLabel) + ' | ' + escHtml(v.sessionName) + '</div>' +
            '<div class="pr-line"></div>' +
            v.groups.map((g) =>
                '<div class="pr-row"><span>' + escHtml(g.number) + '</span>' +
                '<span>' + formatMoney(g.amount) + ' (' + g.count + ' ကြိမ်)</span></div>'
            ).join('') +
            '<div class="pr-line"></div>' +
            '<div class="pr-total"><span>စုစုပေါင်း</span><span>' + formatMoney(v.totalAmt) +
            ' (' + v.totalCount + ' ကွက်)</span></div>' +
        '</div>';
    window.print();
};

window.shareVoucher = async function shareVoucher() {
    const text = buildVoucherText();
    if (!text) { showToast('ဘောက်ချာ မရှိသေးပါ'); return; }
    if (navigator.share) {
        try {
            await navigator.share({ title: '🧾 ဘောက်ချာ', text });
        } catch (e) {
            // User cancelled — no toast needed.
        }
    } else {
        // No Web Share API → fall back to copy.
        const ok = await copyTextToClipboard(text);
        showToast(ok ? '✅ ကူးပြီးပြီ (share မရလို့)' : '❌ မျှဝေမရပါ');
    }
};

/* ================= Voucher group detail (per-number edit/delete) ================= */

window.openVoucherDetail = async function openVoucherDetail(number) {
    const v = lastVoucher;
    if (!v) return;
    voucherDetailNumber = number;

    let recs = [];
    try {
        recs = await db.query('lottery_records', 'by_session', v.sessId);
    } catch (e) { /* ignore */ }
    recs = recs.filter((r) =>
        (r.agent_name || '') === agentName &&
        (v.playerName ? (r.player_name || '') === v.playerName : !(r.player_name || '')) &&
        String(r.number) === String(number)
    ).sort((a, b) => (b.created || 0) - (a.created || 0));

    document.getElementById('voucherDetailTitle').textContent = '🧾 ' + number +
        ' (' + recs.length + ' ကြိမ်)';
    document.getElementById('voucherDetailList').innerHTML = recs.length ? recs.map((r) =>
        '<div class="record-row">' +
            '<span class="rec-no">' + escHtml(r.number) + '</span>' +
            '<span class="rec-amt">' + formatMoney(r.amount) + '</span>' +
            '<span class="rec-actions">' +
                '<button class="rec-edit" onclick="openEditRecord(\'' + r.id + '\')" title="ပြင်မည်">✏️</button>' +
                '<button class="rec-del" onclick="deleteRecord(\'' + r.id + '\')" title="ဖျက်မည်">🗑️</button>' +
            '</span>' +
        '</div>'
    ).join('') : '<div class="empty-state">စာရင်း မရှိပါ</div>';
    document.getElementById('voucherDetailModal').hidden = false;
};

window.closeVoucherDetail = function closeVoucherDetail() {
    document.getElementById('voucherDetailModal').hidden = true;
    voucherDetailNumber = null;
};

/** Re-render the open detail modal after an edit/delete inside it. */
async function refreshVoucherDetail() {
    const modal = document.getElementById('voucherDetailModal');
    if (!modal || modal.hidden || voucherDetailNumber == null) return;
    await openVoucherDetail(voucherDetailNumber);
}

/* ================= Daily (တနေ့စာစာရင်း) ================= */

const BURMESE_DAYS = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** Local date key "YYYY-MM-DD" for a timestamp. */
function dateKey(ts) {
    const d = new Date(Number(ts) || 0);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** "YYYY-MM-DD" for a Date (for <input type=date>). */
function toISODate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** Display label for a player key ('' = self). */
function playerLabel(key) {
    return key ? key : '🧍 ကိုယ်တိုင်';
}

/** All of this agent's records in this tenant. */
async function getAgentRecords() {
    try {
        const all = await db.query('lottery_records', 'by_tenant', tenantId);
        return all.filter((r) => (r.agent_name || '') === agentName);
    } catch (e) {
        return [];
    }
}

window.renderDaily = async function renderDaily() {
    const dateInput = document.getElementById('dailyDate');
    const content = document.getElementById('dailyContent');
    if (!dateInput.value) dateInput.value = toISODate(new Date());
    const key = dateInput.value;

    const recs = (await getAgentRecords()).filter((r) => dateKey(r.created) === key);
    content.innerHTML = renderPlayerGroups(recs, 'ဒီနေ့ စာရင်း မရှိပါ');
};

/**
 * Render records grouped by player → per-player number groups + totals,
 * plus a grand total. Shared by daily & weekly views.
 */
function renderPlayerGroups(recs, emptyMsg) {
    if (!recs.length) return '<div class="empty-state">' + escHtml(emptyMsg || 'စာရင်း မရှိပါ') + '</div>';

    const byPlayer = {};
    recs.forEach((r) => {
        const k = r.player_name || '';
        (byPlayer[k] = byPlayer[k] || []).push(r);
    });

    const playerKeys = Object.keys(byPlayer).sort((a, b) => a.localeCompare(b));
    let grandAmt = 0, grandCount = 0;
    let html = '';

    playerKeys.forEach((k) => {
        const grouped = groupByNumber(byPlayer[k]);
        const pAmt = grouped.reduce((s, g) => s + g.amount, 0);
        const pCount = grouped.reduce((s, g) => s + g.count, 0);
        grandAmt += pAmt;
        grandCount += pCount;
        html += '<div class="player-group">' +
            '<div class="player-group-head"><span>👤 ' + escHtml(playerLabel(k)) + '</span>' +
            '<b>' + formatMoney(pAmt) + ' <span class="muted-sm">(' + pCount + ' ကွက်)</span></b></div>' +
            grouped.map((g) =>
                '<div class="voucher-row">' +
                    '<span class="v-no">' + escHtml(g.number) + '</span>' +
                    '<span class="v-amt">' + formatMoney(g.amount) + '</span>' +
                    '<span class="v-count">' + g.count + ' ကြိမ်</span>' +
                '</div>'
            ).join('') +
        '</div>';
    });

    html += '<div class="voucher-total"><span>စုစုပေါင်း</span><b>' + formatMoney(grandAmt) +
        ' (' + grandCount + ' ကွက်)</b></div>';
    return html;
}

/* ================= Weekly (တပတ်စာစာရင်း) ================= */

let weekOffset = 0; // 0 = this week, -1 = last week, +1 = next week

window.changeWeek = function changeWeek(d) {
    weekOffset = (d === 0) ? 0 : weekOffset + d;
    renderWeekly();
};

window.renderWeekly = async function renderWeekly() {
    const label = document.getElementById('weekLabel');
    const content = document.getElementById('weeklyContent');

    const base = new Date();
    base.setDate(base.getDate() + weekOffset * 7);
    const monday = getWeekMonday(base);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);

    label.textContent = formatDateStr(monday) + ' – ' + formatDateStr(sunday);

    const recs = await getAgentRecords();
    const byDay = {};
    recs.forEach((r) => {
        const k = dateKey(r.created);
        (byDay[k] = byDay[k] || []).push(r);
    });

    let weekAmt = 0, weekCount = 0;
    let html = '';

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        const key = toISODate(d);
        const dayRecs = byDay[key] || [];
        const dayAmt = dayRecs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        weekAmt += dayAmt;
        weekCount += dayRecs.length;

        const dayName = BURMESE_DAYS[d.getDay()];
        html += '<div class="day-section">' +
            '<div class="day-head"><span>📅 ' + dayName + ' <span class="muted-sm">' + formatDateStr(d) + '</span></span>' +
            '<b>' + formatMoney(dayAmt) + ' <span class="muted-sm">(' + dayRecs.length + ' ကွက်)</span></b></div>';

        if (dayRecs.length) {
            // Per-player totals for the day.
            const perPlayer = {};
            dayRecs.forEach((r) => {
                const k = r.player_name || '';
                perPlayer[k] = perPlayer[k] || { amount: 0, count: 0 };
                perPlayer[k].amount += Number(r.amount) || 0;
                perPlayer[k].count += 1;
            });
            html += Object.keys(perPlayer).sort((a, b) => a.localeCompare(b)).map((k) =>
                '<div class="day-player"><span>👤 ' + escHtml(playerLabel(k)) + '</span>' +
                '<span>' + formatMoney(perPlayer[k].amount) + ' <span class="muted-sm">(' + perPlayer[k].count + ' ကွက်)</span></span></div>'
            ).join('');
        } else {
            html += '<div class="day-empty">— စာရင်း မရှိပါ —</div>';
        }
        html += '</div>';
    }

    html += '<div class="voucher-total"><span>📊 တပတ် စုစုပေါင်း</span><b>' + formatMoney(weekAmt) +
        ' (' + weekCount + ' ကွက်)</b></div>';
    content.innerHTML = html;
};
