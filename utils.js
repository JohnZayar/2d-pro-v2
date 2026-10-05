/**
 * utils.js — Small helpers for 2D Pro v2
 *
 * Use as ES6 module:  import { formatMoney, getWeekMonday, ... } from './utils.js'
 */

/** Format a number with thousands separators: 5000 -> "5,000". */
export function formatMoney(n) {
    const num = Number(n) || 0;
    return num.toLocaleString('en-US');
}

/** Parse "DD.MM.YYYY" (optionally followed by day name) into a Date. */
export function parseDateStr(dateStr) {
    try {
        const part = String(dateStr || '').substring(0, 10);
        const [dd, mm, yyyy] = part.split('.').map(Number);
        if (!dd || !mm || !yyyy) return null;
        return new Date(yyyy, mm - 1, dd);
    } catch (e) {
        return null;
    }
}

/** Format a Date as "DD.MM.YYYY". */
export function formatDateStr(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Get the Monday of the week containing `date` (Mon-Fri weeks; weekends
 * map to the Monday of their week). Returns a Date at midnight.
 */
export function getWeekMonday(date) {
    const d = date instanceof Date ? new Date(date) : new Date();
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

/** "DD.MM.YYYY" string of the week's Monday for a date. */
export function getWeekMondayStr(date) {
    return formatDateStr(getWeekMonday(date));
}

/**
 * Extract unique digit characters from a winning number string.
 * extractDigits('55') -> ['5']; extractDigits('57') -> ['5','7']
 */
export function extractDigits(winningNumber) {
    const seen = new Set();
    String(winningNumber || '').split('').forEach((c) => {
        if (c >= '0' && c <= '9') seen.add(c);
    });
    return Array.from(seen);
}

/**
 * Digits 0-9 that have NOT appeared in the given winning numbers.
 * @param {string[]} winningNumbers e.g. ['55','57','38']
 * @returns {string[]} e.g. ['0','1','2','4','6','9']
 */
export function remainingDigits(winningNumbers) {
    const appeared = new Set();
    (winningNumbers || []).forEach((wn) => {
        extractDigits(wn).forEach((d) => appeared.add(d));
    });
    const out = [];
    for (let i = 0; i <= 9; i++) {
        if (!appeared.has(String(i))) out.push(String(i));
    }
    return out;
}

/** Debounce: delay invoking fn until ms have passed since the last call. */
export function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}

/** Generate a local unique id (timestamp + random). */
export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Show a transient toast message. Creates a container on first use.
 * No dependency on any UI framework.
 */
export function showToast(msg, ms = 2500) {
    try {
        let box = document.getElementById('v2-toast-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'v2-toast-box';
            box.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
            document.body.appendChild(box);
        }
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'background:#1f2937;color:#f9fafb;padding:10px 18px;border-radius:10px;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:90vw;';
        box.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity .4s';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 450);
        }, ms);
    } catch (e) {
        // Non-DOM environment (node tests): fall back to console.
        console.log('[toast]', msg);
    }
}

/** Escape HTML special chars (for injecting user text into HTML). */
export function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
