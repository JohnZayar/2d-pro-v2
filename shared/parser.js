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
    const mmNums = ['၀', '၁', '၂', '၃', '၄', '၅', '၆', '၇', '၈', '၉'];
    const enNums = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (let i = 0; i < 10; i++) {
        str = str.replace(new RegExp(mmNums[i], 'g'), enNums[i]);
    }
    return str;
}

/** Normalize reverse markers to 'r'. */
function _normR(s) {
    return s.replace(/အာ/g, 'r').replace(/ရ/g, 'r').replace(/@/g, 'r');
}

/**
 * Expand a formula text into a list of 2-digit number strings.
 * E.g. expandFormula('6ထိပ်') -> ['60','61',...,'69']
 */
export function expandFormula(fullNoText) {
    const generatedNums = [];
    let cleanText = _normR(convertMyanmarNumbers(fullNoText).trim().normalize('NFC'));

    if (cleanText.includes('ခွေ') && cleanText.includes('ပူး')) {
        // ခွေပူး / အခွေအပူး — permutations WITH doubles (25 nums)
        const allDigits = cleanText.match(/\d+/g);
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
    } else if (cleanText.endsWith('R') || cleanText.endsWith('r')) {
        const cleanNo = cleanText.replace(/R|r/g, '').trim();
        // "34r 35r" list — expand each with reverse
        const rParts = cleanNo.split(/[\s,.\-\/]+/).filter((p) => p.length > 0);
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
        } else {
            generatedNums.push(cleanNo);
        }
    } else if (cleanText.includes('ထိပ်')) {
        // Multi-digit: 6.4.5ထိပ် -> 6ထိပ် + 4ထိပ် + 5ထိပ်
        const dPartH = cleanText.replace(/ထိပ်/g, '').trim();
        let dListH = dPartH.split(/[\.,\-\/\s]+/).filter((x) => x);
        if (dListH.length === 0) dListH = [dPartH.replace(/[^\d]/g, '') || '5'];
        const seenH = new Set();
        dListH.forEach((dd) => {
            const d = dd.replace(/[^\d]/g, '').slice(-1) || '5';
            for (let i = 0; i <= 9; i++) {
                const nn = `${d}${i}`;
                if (!seenH.has(nn)) { seenH.add(nn); generatedNums.push(nn); }
            }
        });
    } else if (cleanText.includes('နောက်')) {
        const dPartN = cleanText.replace(/နောက်/g, '').trim();
        let dListN = dPartN.split(/[\.,\-\/\s]+/).filter((x) => x);
        if (dListN.length === 0) dListN = [dPartN.replace(/[^\d]/g, '') || '5'];
        const seenN = new Set();
        dListN.forEach((dd) => {
            const d = dd.replace(/[^\d]/g, '').slice(-1) || '5';
            for (let i = 0; i <= 9; i++) {
                const nn = `${i}${d}`;
                if (!seenN.has(nn)) { seenN.add(nn); generatedNums.push(nn); }
            }
        });
    } else if (cleanText.includes('ပတ်')) {
        const d = cleanText.replace(/အပတ်|ပတ်/g, '').replace(/[^\d]/g, '').slice(-1) || '5';
        const setNums = new Set();
        for (let i = 0; i <= 9; i++) { setNums.add(`${d}${i}`); setNums.add(`${i}${d}`); }
        return Array.from(setNums);
    } else if (cleanText.includes('အပူး') || cleanText === 'ပူး') {
        return ['00', '11', '22', '33', '44', '55', '66', '77', '88', '99'];
    } else if (cleanText.includes('အပါ') || cleanText.includes('အပတ်') || cleanText.includes('ပါ')) {
        const d = cleanText.replace(/အပါ|အပတ်|ပါ/g, '').trim() || '5';
        const setNums = new Set();
        for (let i = 0; i <= 9; i++) { setNums.add(`${d}${i}`); setNums.add(`${i}${d}`); }
        return Array.from(setNums);
    } else if (cleanText.includes('အခွေ') || cleanText.includes('ခွေ')) {
        // ခွေ — permutations WITHOUT doubles (20 nums)
        let digits = cleanText.replace(/[^\d]/g, '').trim();
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
            const numsToProcess = cleanText.split(/[\.,\-\/\s]+/);
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
        let dList = ct.replace(/ထိပ်/g, '').trim().split(/[\.,\-\/\s]+/).filter((x) => x);
        if (dList.length === 0) dList = ['5'];
        dList.forEach((dd) => {
            const d = dd.replace(/[^\d]/g, '').slice(-1) || '5';
            for (let i = 0; i <= 9; i++) pushRev(`${i}${d}`);
        });
    } else if (ct.includes('နောက်')) {
        let dList = ct.replace(/နောက်/g, '').trim().split(/[\.,\-\/\s]+/).filter((x) => x);
        if (dList.length === 0) dList = ['5'];
        dList.forEach((dd) => {
            const d = dd.replace(/[^\d]/g, '').slice(-1) || '5';
            for (let i = 0; i <= 9; i++) pushRev(`${d}${i}`);
        });
    } else if (/^\d{2}$/.test(ct)) {
        const sw = ct[1] + ct[0];
        if (sw !== ct) rev.push(sw);
    } else if (/^\d-\d-\d/.test(ct) || /^[\d\.,\-\/\s]+$/.test(ct)) {
        ct.split(/[\.,\-\/\s]+/).forEach((p) => {
            if (/^\d{2}$/.test(p)) {
                const sw = p[1] + p[0];
                if (sw !== p && !rev.includes(sw)) rev.push(sw);
            }
        });
    }
    return rev;
}

/**
 * Parse a single board line into [{ number, amount }, ...].
 * Returns [] when the line cannot be parsed.
 */
export function parseLine(line) {
    const results = [];
    const cleanLine = (line || '').trim();
    if (!cleanLine) return results;

    let convertedLine = _normR(convertMyanmarNumbers(cleanLine));
    // v218.3: / and , as amount separators (12/500 -> 12=500, 12,500 -> 12=500)
    convertedLine = convertedLine.replace(/^(.+?)[/,](\d{3,})$/, '$1=$2');

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

    // 1) "formula=mainAmt r rAmt"  e.g. "12=500r200"
    let m = convertedLine.match(/^(.+?)\s*=\s*(\d+)\s*[rR]\s*(\d+)$/);
    if (m) {
        const expanded = expandFormula(m[1].trim());
        if (expanded.length > 0) {
            pushWithReverse(expanded, parseInt(m[2], 10), parseInt(m[3], 10));
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
            if (hasR) pushWithReverse(exp, mainAmt, mainAmt);
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
            pushWithReverse(exp, mainAmt, rAmt);
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
            if (isPlainNums) pushWithReverse(exp, amt, amt);
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
            if (hasR) pushWithReverse(exp, amt, amt);
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
 * Parse with per-line report: { items, invalidLines: [lineText...] }.
 * Useful for the v218.11-style UX: save valid lines, keep invalid visible.
 */
export function parseBoardReport(text) {
    const items = [];
    const invalidLines = [];
    (text || '').split('\n').forEach((line) => {
        if (!line.trim()) return;
        const parsed = parseLine(line);
        if (parsed.length > 0) {
            for (const p of parsed) items.push(p);
        } else {
            invalidLines.push(line);
        }
    });
    return { items, invalidLines };
}
