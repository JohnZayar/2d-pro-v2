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
import { uid, formatMoney, showToast, escHtml, debounce } from '../shared/utils.js';

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
    document.getElementById('boardModal').hidden = false;
    document.getElementById('boardPreview').hidden = true;
    const ta = document.getElementById('boardTextarea');
    ta.value = '';
    setTimeout(() => ta.focus(), 100);
};

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
        let savedCount = 0;

        for (const it of items) {
            await sync.mutate('create', 'lottery_records', {
                id: uid(),
                tenant: tenantId,
                session: currentSessionId,
                number: it.number,
                amount: it.amount,
                agent_name: agentName,
                record_type: 'pos',
                batch_no: null,
                created: Date.now()
            });
            savedCount++;
        }

        // Optimistic UI: re-render immediately from local DB.
        await renderRecords();

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
            '<span class="rec-no">' + escHtml(r.number) + '</span>' +
            '<span class="rec-amt">' + formatMoney(r.amount) + '</span>' +
            '<button class="rec-del" onclick="deleteRecord(\'' + r.id + '\')" title="ဖျက်မည်">🗑️</button>' +
        '</div>'
    ).join('');
}

window.deleteRecord = async function deleteRecord(id) {
    const rec = await db.get('lottery_records', id);
    if (!rec) return;
    if (!confirm(rec.number + ' (' + formatMoney(rec.amount) + ') ဖျက်မှာလား?')) return;
    await sync.mutate('delete', 'lottery_records', { id });
    await renderRecords();
    showToast('🗑️ ဖျက်ပြီးပြီ');
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
