/**
 * parser.js — 2D formula parser for 2D Pro v2
 *
 * Ported from 2D Pro v1 (v218.x series). Pure functions, no DOM, no network.
 *
 * Handles:
 *  - R/r/အာ/@ reverse marker
 *  - ထိပ် / နောက် (front/back digit), incl. multi-digit (6.4.5ထိပ်)
 *  - BK / ဘရိတ် (break: digit-sum)
 *  - ခွေ (permutations, no doubles), ခွေ+ပူး (with doubles), အပူး (doubles)
 *  - အပါ / အပတ် / ပါ (digit appears anywhere, 19 nums)
 *  - ပါဝါ, နက္ခတ်, စုံစုံ/မမ/စုံမ/မစုံ, ညီအစ်ကို
 *  - Single digit = အပါ expansion
 *  - Amount formats: 12=500, 12/500, 12,500, 12 500, 12500 (jammed),
 *    12r500, 12=500r200, 6ထိပ်7000r3000
 *
 * Main entry:  parseBoard(text) -> [{ number: '12', amount: 500 }, ...]
 *              Lines that cannot be parsed are skipped (use parseBoardReport
 *              for per-line success info).
 *
 * Use as ES6 module:  import { parseBoard } from './parser.js'
 */

/** Convert Myanmar digits to ASCII digits. */
export function convertMyanmarNumbers(str) {
    if (!str) return '';
    str = str.normalize('NFC');
    const mmNums = ['၀', '၁', '၂', '၃', '၄', '၅', '၆', '၇', '၈', '၉'];
    const enNums = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (let i = 0; i < 10; i++) {
        str = str.replace(new RegExp(mmNums[i], 'g'), enNums[i]);
    }
    // Subscript digits (U+2080–U+2089) — sometimes pasted from rich text
    const subNums = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
    for (let i = 0; i < 10; i++) {
        str = str.replace(new RegExp(subNums[i], 'g'), enNums[i]);
    }
    return str;
}

/** Normalize reverse markers to 'r'. */
function _normR(s) {
    return s.replace(/အာ/g, 'r').replace(/ရ/g, 'r').replace(/@/g, 'r');
}

/**
 * Custom replacement rules (admin-defined via Rule settings).
 * e.g. [{from:'$', to:' '}] lets "45$46$ 2000" parse as 45,46 x 2000.
 * If `to` is blank, the symbol is deleted.
 */
let customRules = [];
export function setCustomRules(rules) {
    customRules = Array.isArray(rules)
        ? rules.filter((r) => r && typeof r.from === 'string' && r.from.length > 0)
              .map((r) => ({ from: r.from, to: typeof r.to === 'string' ? r.to : '' }))
        : [];
}
export function getCustomRules() {
    return customRules.map((r) => ({ ...r }));
}
/** Apply admin replacement rules to input text before parsing. */
function applyCustomRules(text) {
    let t = text || '';
    for (const r of customRules) {
        if (r.from) t = t.split(r.from).join(r.to);
    }
    return t;
}
/** Build the number-list split regex: base seps only (custom handled via replacement). */
function sepRegex() {
    return /[\s,.\-\/]+/;
}

/**
 * Expand a formula text into a list of 2-digit number strings.
 * E.g. expandFormula('6ထိပ်') -> ['60','61',...,'69']
 */
export function expandFormula(fullNoText) {
    const generatedNums = [];
    let cleanText = _normR(convertMyanmarNumbers(fullNoText).trim().normalize('NFC'));

    // Pho Oct 17: ဘရိတ်/ပွင့်/Bk — Nဘရိတ် = pairs where (d1+d2)%10 == N (10 numbers per digit)
    // e.g. 1ဘရိတ် → 01 10 29 92 38 83 47 74 56 65; 123bk → 30 numbers
    if (cleanText.includes('ဘရိတ်') || cleanText.includes('ပွင့်') || /[bB][kK]/.test(cleanText)) {
        const beforeKw = cleanText.split(/ဘရိတ်|ပွင့်|[bB][kK]/)[0];
        const dStr = beforeKw.replace(/[^\d]/g, '');
        const targets = dStr ? Array.from(new Set(dStr.split(''))).map(Number) : [1];
        const setNums = new Set();
        for (const target of targets) {
            for (let d1 = 0; d1 <= 9; d1++) {
                for (let d2 = 0; d2 <= 9; d2++) {
                    if ((d1 + d2) % 10 === target) {
                        setNums.add(`${d1}${d2}`);
                    }
                }
            }
        }
        setNums.forEach((nn) => generatedNums.push(nn));
    } else if (cleanText.includes('ခွေ') && cleanText.includes('ပူး')) {
        // ခွေပူး / အခွေအပူး — permutations WITH doubles (25 nums)
        // Digits only from BEFORE the formula keyword (exclude amount)
        const beforeKw = cleanText.split(/ခွေ/)[0];
        const allDigits = beforeKw.match(/\d+/g);
        const digits = allDigits ? allDigits.join('') : '123';
        const uniqueDigits = Array.from(new Set(digits.split('')));
        const setNums = new Set();
        for (let i = 0; i < uniqueDigits.length; i++) {
            for (let j = 0; j < uniqueDigits.length; j++) {
                if (uniqueDigits[i] !== uniqueDigits[j]) setNums.add(`${uniqueDigits[i]}${uniqueDigits[j]}`);
            }
        }
        for (let i = 0; i < uniqueDigits.length; i++) {
            setNums.add(`${uniqueDigits[i]}${uniqueDigits[i]}`);
        }
        return Array.from(setNums);
    } else if (cleanText.includes('ပါဝါ') || cleanText === 'ပါဝါ') {
        return ['05', '50', '16', '61', '27', '72', '38', '83', '49', '94'];
    } else if (cleanText.includes('ဘရိတ်') || cleanText.includes('ရိတ်') || /bk/i.test(cleanText) || cleanText.includes('ဘ')) {
        // BK = ဘရိတ် (digit-sum). Multi-digit: 570BK -> 5BK + 7BK + 0BK
        let bkDigits = cleanText.replace(/ဘရိတ်|ရိတ်|bk/gi, '').replace(/[^\d]/g, '');
        if (bkDigits.length === 0) bkDigits = '2';
        const bkSeen = new Set();
        bkDigits.split('').forEach((dd) => {
            const bTarget = parseInt(dd, 10);
            for (let i = 0; i <= 9; i++) {
                for (let j = 0; j <= 9; j++) {
                    if ((i + j) % 10 === bTarget) {
                        const bn = `${i}${j}`;
                        if (!bkSeen.has(bn)) { bkSeen.add(bn); generatedNums.push(bn); }
                    }
                }
            }
        });
    } else if (cleanText.endsWith('R') || cleanText.endsWith('r') || cleanText.endsWith('အာ')) {
        const cleanNo = cleanText.replace(/R|r|အာ/g, '').trim();
        // "34r 35r" list — expand each with reverse
        const rParts = cleanNo.split(sepRegex()).filter((p) => p.length > 0);
        if (rParts.length > 1) {
            rParts.forEach((p) => {
                if (p.length === 2) {
                    generatedNums.push(p);
                    const rv = p[1] + p[0];
                    if (rv !== p) generatedNums.push(rv);
                } else if (p.length > 0) {
                    generatedNums.push(p);
                }
            });
        } else if (cleanNo.length === 2) {
            generatedNums.push(cleanNo, cleanNo[1] + cleanNo[0]);
        } else if (cleanNo.length === 3) {
            const d = cleanNo.split('');
            for (let i = 0; i < d.length; i++) {
                for (let j = 0; j < d.length; j++) {
                    if (i !== j) generatedNums.push(d[i] + d[j]);
                }
            }
        } else if (cleanNo.length === 1) {
            // Pho Oct 21: single digit + r/အာ/@ = အပါ set (same as bare digit)
            const sdSeen = new Set();
            for (let i = 0; i <= 9; i++) { sdSeen.add(`${cleanNo}${i}`); sdSeen.add(`${i}${cleanNo}`); }
            sdSeen.forEach((x) => generatedNums.push(x));
        } else {
            generatedNums.push(cleanNo);
        }
    } else if (cleanText.includes('ထိပ်')) {
        // Multi-digit: 758ထိပ် -> 7ထိပ် + 5ထိပ် + 8ထိပ် (each digit separate, Pho Oct 17)
        const dPartH = cleanText.replace(/ထိပ်/g, '').trim();
        const dStrH = dPartH.replace(/[^\d]/g, '');
        const dListH = dStrH ? Array.from(new Set(dStrH.split(''))) : ['5'];
        const seenH = new Set();
        dListH.forEach((d) => {
            for (let i = 0; i <= 9; i++) {
                const nn = `${d}${i}`;
                if (!seenH.has(nn)) { seenH.add(nn); generatedNums.push(nn); }
            }
        });
    } else if (cleanText.includes('နောက်')) {
        // Multi-digit: 758နောက် -> 7နောက် + 5နောက် + 8နောက် (each digit separate, Pho Oct 17)
        const dPartN = cleanText.replace(/နောက်/g, '').trim();
        const dStrN = dPartN.replace(/[^\d]/g, '');
        const dListN = dStrN ? Array.from(new Set(dStrN.split(''))) : ['5'];
        const seenN = new Set();
        dListN.forEach((d) => {
            for (let i = 0; i <= 9; i++) {
                const nn = `${i}${d}`;
                if (!seenN.has(nn)) { seenN.add(nn); generatedNums.push(nn); }
            }
        });
    } else if (cleanText.includes('ပတ်')) {
        // Multi-digit: "567ပတ်" = (5ပတ် 6ပတ် 7ပတ်) → 19×3=57, same as ပါ/အပါ (Pho)
        const dStr = cleanText.replace(/အပတ်|ပတ်/g, '').replace(/[^\d]/g, '');
        const digits = dStr ? Array.from(new Set(dStr.split(''))) : ['5'];
        for (const d of digits) {
            const seen = new Set();
            for (let i = 0; i <= 9; i++) {
                const a = `${d}${i}`, b = `${i}${d}`;
                if (!seen.has(a)) { seen.add(a); generatedNums.push(a); }
                if (!seen.has(b)) { seen.add(b); generatedNums.push(b); }
            }
        }
        // Note: no cross-digit dedup — overlaps are intentional double bets
    } else if (cleanText.includes('ပူး')) {
        const dPoo = cleanText.replace(/အပူး|ပူး/g, '').replace(/[^\d]/g, '').slice(-1);
        if (dPoo) return [`${dPoo}${dPoo}`];
        return ['00', '11', '22', '33', '44', '55', '66', '77', '88', '99'];
    } else if (cleanText.includes('အပါ') || cleanText.includes('အပတ်') || cleanText.includes('ပါ')) {
        // Multi-digit: "567ပါ" = (5ပါ 6ပါ 7ပါ) → 19×3=57, overlaps counted multiple times (Pho)
        // Within each digit: dedup (55 once). Across digits: keep duplicates (56 in both 5ပါ and 6ပါ).
        const dStr = cleanText.replace(/အပါ|အပတ်|ပါ/g, '').replace(/[^\d]/g, '');
        const digits = dStr ? Array.from(new Set(dStr.split(''))) : ['5'];
        for (const d of digits) {
            const seen = new Set();
            for (let i = 0; i <= 9; i++) {
                const a = `${d}${i}`, b = `${i}${d}`;
                if (!seen.has(a)) { seen.add(a); generatedNums.push(a); }
                if (!seen.has(b)) { seen.add(b); generatedNums.push(b); }
            }
        }
        // Note: no cross-digit dedup — overlaps (56,65,etc.) are intentional double bets
    } else if (cleanText.includes('အခွေ') || cleanText.includes('ခွေ')) {
        // ခွေ — permutations WITHOUT doubles (20 nums)
        // Digits only from BEFORE the formula keyword (exclude amount)
        const beforeKw = cleanText.split(/အခွေ|ခွေ/)[0];
        let digits = beforeKw.replace(/[^\d]/g, '').trim();
        if (!digits) digits = '123';
        const uniqueDigits = Array.from(new Set(digits.split('')));
        const setNums = new Set();
        for (let i = 0; i < uniqueDigits.length; i++) {
            for (let j = 0; j < uniqueDigits.length; j++) {
                if (uniqueDigits[i] !== uniqueDigits[j]) setNums.add(`${uniqueDigits[i]}${uniqueDigits[j]}`);
            }
        }
        return Array.from(setNums);
    } else if (cleanText.includes('နက္ခတ်')) {
        return ['07', '18', '24', '53', '69', '70', '81', '42', '35', '96'];
    } else if (cleanText.includes('စုံစုံ')) {
        for (let i = 0; i <= 9; i += 2) for (let j = 0; j <= 9; j += 2) generatedNums.push(`${i}${j}`);
    } else if (cleanText.includes('မမ')) {
        for (let i = 1; i <= 9; i += 2) for (let j = 1; j <= 9; j += 2) generatedNums.push(`${i}${j}`);
    } else if (cleanText.includes('စုံမ')) {
        for (let i = 0; i <= 9; i += 2) for (let j = 1; j <= 9; j += 2) generatedNums.push(`${i}${j}`);
    } else if (cleanText.includes('မစုံ')) {
        for (let i = 1; i <= 9; i += 2) for (let j = 0; j <= 9; j += 2) generatedNums.push(`${i}${j}`);
    } else if (cleanText.includes('ညီအစ်ကို')) {
        return ['01', '10', '12', '21', '23', '32', '34', '43', '45', '54', '56', '65', '67', '76', '78', '87', '89', '98', '90', '09'];
    } else {
        const pureDigits = cleanText.replace(/[^\d]/g, '');
        if (pureDigits.length > 3 && pureDigits.length % 2 === 0) {
            for (let i = 0; i < pureDigits.length; i += 2) {
                generatedNums.push(pureDigits.substr(i, 2));
            }
        } else {
            const numsToProcess = cleanText.split(sepRegex());
            numsToProcess.forEach((nStr) => {
                nStr = nStr.trim();
                if (nStr) {
                    // Single digit = အပါ
                    if (/^\d$/.test(nStr)) {
                        const sdSeen = new Set();
                        for (let i = 0; i <= 9; i++) { sdSeen.add(`${nStr}${i}`); sdSeen.add(`${i}${nStr}`); }
                        sdSeen.forEach((x) => generatedNums.push(x));
                    } else {
                        generatedNums.push(nStr);
                    }
                }
            });
        }
    }
    // Note: duplicates INTENTIONAL for multi-digit formulas (e.g. 5-6-7ပါ → 19×3=57).
    // Pho: each digit's set counts separately; do NOT deduplicate here.
    return generatedNums;
}

/**
 * Reverse expansion of a formula (ထိပ်<->နောက် swap, 2-digit swap).
 * Used for jammed "formulaAmt r reverseAmt" patterns like 6ထိပ်7000r3000.
 * Symmetric formulas return [].
 */
export function expandReverseFormula(formulaText) {
    const ct = _normR(convertMyanmarNumbers(formulaText)).replace(/[rR]+$/, '').trim();
    const rev = [];
    const revSeen = new Set();
    const pushRev = (x) => { if (!revSeen.has(x)) { revSeen.add(x); rev.push(x); } };

    if (ct.includes('ထိပ်')) {
        // Multi-digit: each digit separate (Pho Oct 17)
        const dStr = ct.replace(/ထိပ်/g, '').replace(/[^\d]/g, '');
        const dList = dStr ? Array.from(new Set(dStr.split(''))) : ['5'];
        dList.forEach((d) => {
            for (let i = 0; i <= 9; i++) pushRev(`${i}${d}`);
        });
    } else if (ct.includes('နောက်')) {
        const dStr = ct.replace(/နောက်/g, '').replace(/[^\d]/g, '');
        const dList = dStr ? Array.from(new Set(dStr.split(''))) : ['5'];
        dList.forEach((d) => {
            for (let i = 0; i <= 9; i++) pushRev(`${d}${i}`);
        });
    } else if (/^\d{2}$/.test(ct)) {
        const sw = ct[1] + ct[0];
        if (sw !== ct) rev.push(sw);
    } else if (/^\d-\d-\d/.test(ct) || /^[\d\.,\-\/\s]+$/.test(ct)) {
        ct.split(sepRegex()).forEach((p) => {
            if (/^\d{2}$/.test(p)) {
                const sw = p[1] + p[0];
                if (sw !== p && !rev.includes(sw)) rev.push(sw);
            }
        });
    }
    return rev;
}

/**
 * Split a combined formula line like "5ထိပ်400နောက်100" into ["5ထိပ်400", "နောက်100"].
 * Each part keeps its own amount.
 */
function splitCombinedFormula(line) {
    // Note: ခွေပူး variants must come FIRST so overlap logic keeps them as single units
    const keywords = ['ထိုင်းနက္ခတ်', 'နက္ခတ်', 'ညီအစ်ကို', 'အခွေအပူးပါ', 'အခွေအပူး', 'ခွေပူးပါ', 'ခွေအပူး', 'အခွေပူး', 'ခွေပူး', 'ဘရိတ်', 'ပွင့်', 'Bk', 'bk', 'BK', 'ထိပ်', 'နောက်', 'ပတ်', 'အပါ', 'ပါ', 'အပူး', 'ပူး', 'အခွေ', 'ခွေ', 'စုံမ', 'မစုံ'];
    // Find all keyword occurrences
    const positions = [];
    for (const kw of keywords) {
        let idx = 0;
        while ((idx = line.indexOf(kw, idx)) !== -1) {
            positions.push({ pos: idx, kw });
            idx += kw.length;
        }
    }
    if (positions.length <= 1) return [line];
    // Sort by position, remove overlaps (keep longest at same position)
    positions.sort((a, b) => a.pos - b.pos);
    const filtered = [];
    for (const p of positions) {
        const last = filtered[filtered.length - 1];
        if (last && p.pos < last.pos + last.kw.length) {
            // Overlap — keep the longer keyword
            if (p.kw.length > last.kw.length) filtered[filtered.length - 1] = p;
        } else {
            filtered.push(p);
        }
    }
    if (filtered.length <= 1) return [line];
    // Split into parts
    const parts = [];
    // Pho Oct 17: leading digits (e.g. "8,6,9" in "8,6,9ထိပ်600နောက်400") apply to ALL parts.
    // Parts after the first (e.g. "နောက်400") get the leading digits prepended.
    const firstKwPos = filtered[0].pos;
    const leadingDigits = line.substring(0, firstKwPos).trim();
    for (let i = 0; i < filtered.length; i++) {
        const start = (i === 0) ? 0 : filtered[i].pos;
        const end = (i + 1 < filtered.length) ? filtered[i + 1].pos : line.length;
        let part = line.substring(start, end).trim();
        if (i > 0 && leadingDigits && part.startsWith(filtered[i].kw)) {
            part = leadingDigits + part;
        }
        if (part) parts.push(part);
    }
    return parts.length > 1 ? parts : [line];
}

/**
 * Parse a single board line into [{ number, amount }, ...].
 * Returns [] when the line cannot be parsed.
 */
export function parseLine(line) {
    const results = [];
    let cleanLine = applyCustomRules((line || '').trim());
    if (!cleanLine) return results;

    // Pho Oct 18: aliases — (ထိပ်=ရှေ့=အရှေ့), (နောက်=ပိတ်=အပိတ်=အနောက်)
    // Normalize to canonical forms so all writing methods work
    cleanLine = cleanLine
        .replace(/အရှေ့/g, 'ထိပ်').replace(/ရှေ့/g, 'ထိပ်')
        .replace(/အနောက်/g, 'နောက်').replace(/အပိတ်/g, 'နောက်').replace(/ပိတ်/g, 'နောက်');

    // Handle combined formulas: "5ထိပ်400နောက်100" → parse each part separately
    const cParts = splitCombinedFormula(cleanLine);
    if (cParts.length > 1) {
        for (const part of cParts) {
            const sub = parseLine(part);
            results.push(...sub);
        }
        return results;
    }

    // Pho: ရ before a formula keyword is ignored (e.g. "567ရခွေပူး" → "567ခွေပူး")
    // (ရ as reverse marker only applies after a complete number, not mid-formula)
    // Do this BEFORE _normR converts ရ → r
    let preLine = convertMyanmarNumbers(cleanLine).replace(/ရ(?=\s*ခွေ|ခွေ|ပူး|ပါ|ပတ်|ထိပ်|နောက်|နက္ခတ်|စုံ)/g, '');
    let convertedLine = _normR(preLine);
    // v218.3: / and , as amount separators (12/500 -> 12=500, 12,500 -> 12=500)
    convertedLine = convertedLine.replace(/^(.+?)[/,](\d{3,})$/, '$1=$2');
    // Pho: "=" between digits and formula keyword = space (e.g. "567=ပါ" → "567 ပါ")
    // Only when = is followed by non-digit (formula keyword, not amount)
    convertedLine = convertedLine.replace(/=\s*(?=[^\d\s])/g, ' ');

    const pushNums = (nums, amt) => {
        nums.forEach((n) => results.push({ number: n, amount: amt }));
    };
    const pushWithReverse = (nums, mainAmt, rAmt) => {
        nums.forEach((numStr) => {
            results.push({ number: numStr, amount: mainAmt });
            if (numStr.length === 2) {
                const revNum = numStr[1] + numStr[0];
                if (revNum !== numStr) results.push({ number: revNum, amount: rAmt });
            }
        });
    };
    // Pho Oct 21: a BARE single digit + (အာ/r/R/@) means အပါ — the 19-number
    // contains-set, exactly like 1ပါ (a single digit has no reverse).
    // Two-digit operands keep the reverse meaning (12အာ = 12 + 21).
    const isBareDigit = (t) => /^\d$/.test((t || '').trim());

    // 1) "formula=mainAmt r rAmt"  e.g. "12=500r200"
    let m = convertedLine.match(/^(.+?)\s*=\s*(\d+)\s*[rR]\s*(\d+)$/);
    if (m) {
        const expanded = expandFormula(m[1].trim());
        if (expanded.length > 0) {
            if (isBareDigit(m[1])) pushNums(expanded, parseInt(m[2], 10));
            else pushWithReverse(expanded, parseInt(m[2], 10), parseInt(m[3], 10));
            return results;
        }
    }

    // 2) "formula=amt" with optional trailing r  e.g. "12=500", "12r=500"
    const parts = convertedLine.split(/=/);
    if (parts.length === 2) {
        let leftPart = parts[0].trim();
        const mainAmt = parseInt(parts[1].replace(/[^\d]/g, ''), 10);
        const hasR = leftPart.toLowerCase().endsWith('r');
        if (hasR) leftPart = leftPart.slice(0, -1).trim();
        const exp = expandFormula(leftPart);
        if (exp.length > 0 && !isNaN(mainAmt) && mainAmt > 0) {
            if (hasR && !isBareDigit(leftPart)) pushWithReverse(exp, mainAmt, mainAmt);
            else pushNums(exp, mainAmt);
            return results;
        }
    }

    // 3) "numbers amount r reverseAmount"  e.g. "12,13,14 500r100"
    m = convertedLine.match(/^(.+?)\s+(\d+)\s*[rR]\s*(\d+)$/);
    if (m) {
        const exp = expandFormula(m[1].trim());
        const mainAmt = parseInt(m[2], 10);
        const rAmt = parseInt(m[3], 10);
        if (exp.length > 0 && mainAmt > 0) {
            if (isBareDigit(m[1])) pushNums(exp, mainAmt);
            else pushWithReverse(exp, mainAmt, rAmt);
            return results;
        }
    }

    // 4) jammed "formulaAmt r reverseAmt"  e.g. "6ထိပ်7000r3000"
    m = convertedLine.match(/^(.+?[^0-9\s,.\-\/])(\d{2,})[rR](\d{2,})$/);
    if (m) {
        const formulaPart = m[1].trim();
        const mainAmt = parseInt(m[2], 10);
        const rAmt = parseInt(m[3], 10);
        const exp = expandFormula(formulaPart);
        const revExp = expandReverseFormula(formulaPart);
        if (exp.length > 0 && mainAmt > 0) {
            pushNums(exp, mainAmt);
            pushNums(revExp, rAmt);
            return results;
        }
    }

    // 5) r as amount separator  e.g. "12r500", "4-5-6r1000"
    m = convertedLine.match(/^(.+?)[rR](\d+)$/);
    if (m) {
        const formulaPart = m[1].trim();
        const amt = parseInt(m[2], 10);
        const exp = expandFormula(formulaPart);
        const isPlainNums = !/ထိပ်|နောက်|ပတ်|ပါ|ဘရိတ်|ရိတ်|ခွေ|ပူး|ပါဝါ|နက္ခတ်|စုံ|ညီအစ်ကို|bk/i.test(formulaPart);
        if (exp.length > 0 && amt > 0) {
            if (isPlainNums && !isBareDigit(formulaPart)) pushWithReverse(exp, amt, amt);
            else pushNums(exp, amt);
            return results;
        }
    }

    // 6) "formula r amount" with space  e.g. "12r 500"
    m = convertedLine.match(/^(.*?[\d]+[rR])\s*(\d+)$/i);
    if (m) {
        let leftPart = m[1].trim();
        const amt = parseInt(m[2], 10);
        const hasR = leftPart.toLowerCase().endsWith('r');
        if (hasR) leftPart = leftPart.slice(0, -1).trim();
        const exp = expandFormula(leftPart);
        if (exp.length > 0 && !isNaN(amt) && amt > 0) {
            if (hasR && !isBareDigit(leftPart)) pushWithReverse(exp, amt, amt);
            else pushNums(exp, amt);
            return results;
        }
    }

    // 7) space-separated "formula amount"  e.g. "12 500", "6ထိပ် 1000"
    m = convertedLine.match(/^(.*?)\s+(\d+)$/);
    if (m) {
        const exp = expandFormula(m[1].trim());
        const amt = parseInt(m[2], 10);
        if (exp.length > 0 && !isNaN(amt) && amt > 0) {
            pushNums(exp, amt);
            return results;
        }
    }

    // 8) jammed "formulaAmount"  e.g. "12500" (formula "12" + amount 500)
    //    Only when stripping trailing digits leaves a non-empty formula.
    m = convertedLine.match(/^(.*[^\d])(\d{2,})$/);
    if (m) {
        const exp = expandFormula(m[1].trim());
        const amt = parseInt(m[2], 10);
        if (exp.length > 0 && !isNaN(amt) && amt > 0) {
            pushNums(exp, amt);
            return results;
        }
    }

    // 9) plain formula / number list without amount (amount = 0; caller decides default)
    const exp = expandFormula(convertedLine);
    if (exp.length > 0) {
        // Avoid treating a bare amount-like line as numbers:
        // if the whole line is just digits and expandFormula echoed it back,
        // require at least a 2-digit number shape.
        const allNumLike = exp.every((n) => /^\d{1,3}$/.test(n));
        if (allNumLike) pushNums(exp, 0);
    }
    return results;
}

/**
 * Parse a whole board textarea into [{ number, amount }, ...].
 * Invalid/empty lines are skipped.
 */
export function parseBoard(text) {
    const out = [];
    (text || '').split('\n').forEach((line) => {
        const parsed = parseLine(line);
        for (const p of parsed) out.push(p);
    });
    return out;
}

/**
 * Parse board with source line attached: [{ number, amount, formula_text }, ...].
 * formula_text is the original input line (e.g. "အပူး 500").
 */
export function parseBoardWithSource(text) {
    const out = [];
    (text || '').split('\n').forEach((line) => {
        const trimmed = (line || '').trim();
        if (!trimmed) return;
        const parsed = parseLine(line);
        for (const p of parsed) out.push({ ...p, formula_text: trimmed });
    });
    return out;
}

/**
 * Parse with per-line report: { items, invalidLines: [lineText...] }.
 * Useful for the v218.11-style UX: save valid lines, keep invalid visible.
 */
export function parseBoardReport(text) {
    const items = [];
    const invalidLines = [];
    (text || '').split('\n').forEach((line, lineIdx) => {
        if (!line.trim()) return;
        const parsed = parseLine(line);
        if (parsed.length > 0) {
            for (const p of parsed) items.push({ ...p, formula_text: line.trim(), line_idx: lineIdx });
        } else {
            invalidLines.push(line);
        }
    });
    return { items, invalidLines };
}
