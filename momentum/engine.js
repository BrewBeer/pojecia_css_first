/*
 * Silnik strategii momentum dla GPW (konto IKZE, systemtrader.pl).
 * Bez DOM: działa w przeglądarce (window.MomentumEngine) i w Node (require).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MomentumEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
'use strict';

const DEFAULT_PARAMS = {
    momShort: 125,
    momLong: 250,
    momMin: 20,
    riseMax: 30,
    riseDays: 90,
    slots: 5,
    volDays: 50,
    volMode: 'atr',
    weightMode: 'st',
    zPop: 'top',
    commPct: 0.5,
    commMin: 5,
    signalSession: 9,
    carryExcess: true,
    riseFilterHeld: false,
};
const TRANCHES = 3;
const TRANCHE_MONTHS = [[2, 5, 8, 11], [3, 6, 9, 12], [4, 7, 10, 1]];
const STALE_DAYS = 10;

// okresy do stres-testu na danych historycznych
const CRISES = [
    ['Kryzys strefy euro', 20110701, 20111231],
    ['Bessa średnich i małych spółek', 20180101, 20181231],
    ['Krach COVID-19', 20200201, 20200331],
    ['Bessa 2022 (wojna, stopy)', 20220101, 20221031],
];

// --- daty jako liczby RRRRMMDD
const ymd = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const toDate = n => new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100);
const pad2 = n => String(n).padStart(2, '0');
const iso = n => `${Math.floor(n / 10000)}-${pad2(Math.floor(n / 100) % 100)}-${pad2(n % 100)}`;
const plDate = n => n ? `${pad2(n % 100)}.${pad2(Math.floor(n / 100) % 100)}.${Math.floor(n / 10000)}` : '–';
const fromIso = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? +s.replaceAll('-', '') : 0;
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const addDays = (n, k) => { const d = toDate(n); d.setDate(d.getDate() + k); return ymd(d); };

function lastIdx(arr, x) {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (arr[m] <= x) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r;
}

function parseTickers(text) {
    return [...new Set(String(text || '').toUpperCase().split(/[^A-Z0-9_.\-]+/).filter(Boolean))];
}

const trancheOfMonth = m => (m + 1) % 3;

// --- kalendarz sesji GPW
function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), hh = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7, m = Math.floor((a + 11 * hh + 22 * l) / 451);
    const n = hh + l - 7 * m + 114;
    return new Date(y, Math.floor(n / 31) - 1, (n % 31) + 1);
}
const _holidays = {};
function gpwHolidays(y) {
    const e = ymd(easter(y));
    return new Set([101, 106, 501, 503, 815, 1101, 1111, 1224, 1225, 1226, 1231].map(md => y * 10000 + md)
        .concat([addDays(e, -2), addDays(e, 1), addDays(e, 60)]));
}
function isSession(n) {
    const d = toDate(n), wd = d.getDay();
    if (wd === 0 || wd === 6) return false;
    return !(_holidays[d.getFullYear()] ||= gpwHolidays(d.getFullYear())).has(n);
}
function sessionsOfMonth(y, m) {
    const out = [];
    for (let d = 1; d <= 31; d++) {
        const dt = new Date(y, m - 1, d);
        if (dt.getMonth() !== m - 1) break;
        if (isSession(ymd(dt))) out.push(ymd(dt));
    }
    return out;
}

// --- import plików Stooq (CSV ze strony notowań albo TXT z paczki bazy)
function parseDate(s) {
    s = String(s || '').trim();
    let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return +m[1] * 10000 + +m[2] * 100 + +m[3];
    if (/^\d{8}$/.test(s)) return +s;
    if ((m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s))) return +m[3] * 10000 + +m[2] * 100 + +m[1];
    return 0;
}

function parseStooq(name, text, { volume = false } = {}) {
    const lines = text.split(/\r?\n/);
    let hdr = 0;
    while (hdr < lines.length && !lines[hdr].trim()) hdr++;
    if (hdr >= lines.length) return {};
    const sep = lines[hdr].includes(',') ? ',' : lines[hdr].includes(';') ? ';' : '\t';
    const cols = lines[hdr].toLowerCase().split(sep).map(s => s.replace(/[<>"\s]/g, ''));
    const find = keys => cols.findIndex(c => keys.includes(c));
    const iT = find(['ticker']), iD = find(['date', 'data']);
    const iH = find(['high', 'najwyzszy', 'najwyższy']), iL = find(['low', 'najnizszy', 'najniższy']);
    const iC = find(['close', 'zamkniecie', 'zamknięcie']), iV = find(['vol', 'volume', 'wolumen']);
    if (iD < 0 || iC < 0) return {};
    const fileT = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/_d$/i, '').toUpperCase();
    const rows = {};
    for (let i = hdr + 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const f = lines[i].split(sep);
        const d = parseDate(f[iD]), c = +f[iC];
        if (!d || !(c > 0)) continue;
        const t = iT >= 0 ? String(f[iT]).trim().toUpperCase() : fileT;
        (rows[t] ||= []).push([d, iH >= 0 ? +f[iH] : NaN, iL >= 0 ? +f[iL] : NaN, c, iV >= 0 ? +f[iV] : NaN]);
    }
    const out = {};
    for (const [t, r] of Object.entries(rows)) {
        r.sort((a, b) => a[0] - b[0]);
        const u = r.filter((x, j) => j === 0 || x[0] !== r[j - 1][0]);
        out[t] = {
            d: Int32Array.from(u, x => x[0]),
            h: Float64Array.from(u, x => x[1]),
            l: Float64Array.from(u, x => x[2]),
            c: Float64Array.from(u, x => x[3]),
        };
        if (volume) out[t].v = Float64Array.from(u, x => x[4]);
    }
    return out;
}

// --- kompaktowy format JSON generowany przez scripts/update-data.mjs
// dd: odstępy dni między sesjami; cr: zmiany ln(kursu) w punktach bazowych (z korektą błędu zaokrągleń);
// h/l: odległość maksimum/minimum od zamknięcia w promilach (null = brak danych).
function decodePack(pack) {
    const series = {};
    for (const [t, s] of Object.entries(pack.series || {})) {
        const n = s.cr.length + 1, d = new Int32Array(n), c = new Float64Array(n);
        const h = new Float64Array(n).fill(NaN), l = new Float64Array(n).fill(NaN);
        const dt = toDate(s.start);
        c[0] = s.c0;
        for (let i = 0; i < n; i++) {
            if (i) {
                dt.setDate(dt.getDate() + s.dd[i - 1]);
                c[i] = c[i - 1] * Math.exp(s.cr[i - 1] / 1e4);
            }
            d[i] = ymd(dt);
            if (s.h && s.h[i] != null) h[i] = c[i] * (1 + s.h[i] / 1000);
            if (s.l && s.l[i] != null) l[i] = c[i] * (1 - s.l[i] / 1000);
        }
        series[t] = { d, c, h, l };
    }
    return { series, universe: pack.universe || null, bench: pack.bench || 'WIG', lastDate: pack.lastDate || 0, generated: pack.generated || '', kind: pack.kind || '' };
}

function encodeSeries(s, from = 0) {
    const i0 = from ? lastIdx(s.d, from - 1) + 1 : 0;
    if (i0 >= s.d.length) return null;
    const dd = [], cr = [], h = [], l = [];
    let rec = s.c[i0], hasHL = false;
    for (let i = i0; i < s.d.length; i++) {
        if (i > i0) {
            dd.push(daysBetween(s.d[i - 1], s.d[i]));
            const k = Math.round(1e4 * Math.log(s.c[i] / rec));
            cr.push(k);
            rec *= Math.exp(k / 1e4);
        }
        const hi = s.h[i], lo = s.l[i];
        const ok = hi > 0 && lo > 0;
        hasHL ||= ok;
        h.push(ok ? Math.max(0, Math.round(1000 * (hi / s.c[i] - 1))) : null);
        l.push(ok ? Math.max(0, Math.round(1000 * (1 - lo / s.c[i]))) : null);
    }
    return { start: s.d[i0], c0: +s.c[i0].toPrecision(6), dd, cr, ...(hasHL ? { h, l } : {}) };
}

// --- statystyki wyników
function perfStats(dates, v) {
    let i0 = -1, i1 = -1;
    for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i]) && v[i] > 0) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 < 0 || i1 <= i0) return null;
    const years = daysBetween(dates[i0], dates[i1]) / 365.25;
    let peak = -Infinity, mdd = 0, sum = 0, sq = 0, cnt = 0, prev = NaN;
    for (let i = i0; i <= i1; i++) {
        const x = v[i];
        if (!Number.isFinite(x)) continue;
        if (x > peak) peak = x;
        mdd = Math.min(mdd, x / peak - 1);
        if (Number.isFinite(prev)) { const r = x / prev - 1; sum += r; sq += r * r; cnt++; }
        prev = x;
    }
    return {
        total: v[i1] / v[i0] - 1,
        cagr: years > 0 ? Math.pow(v[i1] / v[i0], 1 / years) - 1 : NaN,
        mdd,
        vol: cnt > 1 ? Math.sqrt(Math.max(0, (sq - sum * sum / cnt) / (cnt - 1)) * 250) : NaN,
    };
}

function drawdown(v) {
    let peak = -Infinity;
    return v.map(x => {
        if (!Number.isFinite(x)) return NaN;
        if (x > peak) peak = x;
        return x / peak - 1;
    });
}

function yearlyReturns(dates, list) {
    const ends = [];
    for (let i = 0; i < dates.length; i++) {
        const y = Math.floor(dates[i] / 10000);
        if (i === dates.length - 1 || Math.floor(dates[i + 1] / 10000) !== y) ends.push([y, i]);
    }
    let p = -1;
    return ends.map(([year, i]) => {
        const vals = list.map(v => {
            let b = p >= 0 ? v[p] : NaN;
            if (!Number.isFinite(b)) for (let j = Math.max(p, 0); j <= i; j++) if (Number.isFinite(v[j])) { b = v[j]; break; }
            return Number.isFinite(b) && Number.isFinite(v[i]) ? v[i] / b - 1 : NaN;
        });
        p = i;
        return { year, vals };
    });
}

// wynik i obsunięcie strategii oraz benchmarku w zadanym okresie
function windowStats(res, from, to) {
    const i0 = res.dates.findIndex(d => d >= from);
    const i1 = lastIdx(res.dates, to);
    if (i0 < 0 || i1 <= i0) return null;
    const slice = v => v.slice(Math.max(0, i0 - 1), i1 + 1);
    const dates = res.dates.slice(Math.max(0, i0 - 1), i1 + 1);
    const s = perfStats(dates, slice(res.twr)), b = perfStats(dates, slice(res.bench));
    const cash = res.cashPct.slice(i0, i1 + 1);
    return { strategy: s, bench: b, avgCash: cash.reduce((a, x) => a + x, 0) / cash.length };
}

// --- dane demonstracyjne (syntetyczne, deterministyczne)
function makeDemo({ seed = 20260101, stocks = 40, from = 20120102, to = 0 } = {}) {
    let st = seed;
    const rnd = () => {
        st = (st + 0x6D2B79F5) | 0;
        let t = Math.imul(st ^ (st >>> 15), 1 | st);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const end = to || ymd(new Date());
    const dates = [];
    for (let d = from; d <= end; d = addDays(d, 1)) if (isSession(d)) dates.push(d);
    const n = dates.length;
    const build = (i0, i1, closes, vol) => {
        const c = Float64Array.from(closes.slice(i0, i1));
        return {
            d: Int32Array.from(dates.slice(i0, i1)),
            h: c.map(x => x * (1 + Math.abs(gauss()) * vol * 0.7)),
            l: c.map(x => x * (1 - Math.abs(gauss()) * vol * 0.7)),
            c,
        };
    };
    const mkt = [];
    let m = 1, drift = 0.0003;
    for (let i = 0; i < n; i++) {
        if (i % 180 === 0) drift = -0.0007 + rnd() * 0.0017;
        m *= Math.exp(drift + 0.011 * gauss());
        mkt.push(m);
    }
    const series = { WIG: build(0, n, mkt.map(x => x * 50000), 0.008) };
    for (let k = 1; k <= stocks; k++) {
        const beta = 0.6 + rnd() * 0.8, vol = 0.012 + rnd() * 0.02;
        let p = 5 + rnd() * 120, alpha = 0;
        const c = [];
        for (let i = 0; i < n; i++) {
            if (i % 120 === 0) alpha = (rnd() - 0.45) * 0.003;
            const mr = i ? Math.log(mkt[i] / mkt[i - 1]) : 0;
            p *= Math.exp(beta * mr + alpha + vol * gauss());
            c.push(p);
        }
        const i0 = k % 8 === 0 ? Math.floor(rnd() * n * 0.6) : 0;
        const i1 = k === 13 ? Math.floor(n * 0.7) : n;
        series['DEMO' + pad2(k)] = build(i0, i1, c, vol);
    }
    return series;
}

// --- instancja strategii: parametry + dane + ustawienia
function createEngine(init = {}) {
    let P = { ...DEFAULT_PARAMS };
    let DATA = { series: {}, universe: null, demo: false };
    let SET = { bench: 'WIG', universe: '' };
    let cal = null;
    const uniCache = new Map();

    function configure({ params, data, settings } = {}) {
        if (params) P = { ...DEFAULT_PARAMS, ...params };
        if (data) DATA = { series: {}, universe: null, demo: false, ...data };
        if (settings) SET = { ...SET, ...settings };
        cal = null;
        uniCache.clear();
    }
    configure(init);

    const benchTicker = () => String(SET.bench || '').trim().toUpperCase();
    const manualList = () => DATA.demo ? [] : parseTickers(SET.universe);

    // skład uniwersum na dzień: lista ręczna > historia składu WIG140 z danych > wszystkie serie
    function universeAt(date = 0) {
        if (uniCache.has(date)) return uniCache.get(date);
        const b = benchTicker();
        let base;
        const manual = manualList();
        if (manual.length) base = manual;
        else if (DATA.universe?.length) {
            let e = DATA.universe[0];
            for (const u of DATA.universe) { if (date && u.from > date) break; e = u; }
            base = e.tickers;
        } else base = Object.keys(DATA.series);
        const res = base.filter(t => t !== b && DATA.series[t]).sort();
        uniCache.set(date, res);
        return res;
    }

    function universeSource() {
        if (manualList().length) return 'manual';
        if (DATA.universe?.length) return 'history';
        return 'all';
    }

    function calendar() {
        if (cal) return cal;
        const set = new Set();
        for (const s of Object.values(DATA.series)) for (const d of s.d) set.add(d);
        return (cal = Int32Array.from([...set].sort((a, b) => a - b)));
    }

    function priceAt(t, date) {
        const s = DATA.series[t];
        if (!s) return NaN;
        const i = lastIdx(s.d, date);
        return i < 0 ? NaN : s.c[i];
    }

    function sessionNumber(date) {
        const c = calendar(), i = lastIdx(c, date);
        if (i < 0 || c[i] !== date) return 0;
        let n = 0;
        for (let j = i; j >= 0 && Math.floor(c[j] / 100) === Math.floor(date / 100); j--) n++;
        return n;
    }

    // regresja liniowa ln(ceny) na n ostatnich sesjach: roczne tempo wzrostu (%) × R²
    function momentumScore(c, end, n) {
        const start = end - n + 1;
        if (start < 0) return NaN;
        let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
        for (let k = 0; k < n; k++) {
            const y = Math.log(c[start + k]);
            if (!Number.isFinite(y)) return NaN;
            sx += k; sy += y; sxx += k * k; sxy += k * y; syy += y * y;
        }
        const cov = n * sxy - sx * sy, vx = n * sxx - sx * sx, vy = n * syy - sy * sy;
        const r2 = vy > 0 ? (cov * cov) / (vx * vy) : 0;
        return (Math.pow(Math.exp(cov / vx), 250) - 1) * 100 * r2;
    }

    // zmienność z P.volDays sesji: ATR/kurs albo roczne odchylenie std. log-stóp zwrotu
    function volatility(s, i) {
        const n = P.volDays;
        if (i < n) return NaN;
        let v;
        if (P.volMode === 'atr') {
            let sum = 0;
            for (let j = i - n + 1; j <= i; j++) {
                const pc = s.c[j - 1], hi = s.h[j], lo = s.l[j];
                sum += hi > 0 && lo > 0 ? Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)) : Math.abs(s.c[j] - pc);
            }
            v = sum / n / s.c[i];
        } else {
            let a = 0, b = 0;
            for (let j = i - n + 1; j <= i; j++) {
                const r = Math.log(s.c[j] / s.c[j - 1]);
                a += r; b += r * r;
            }
            v = Math.sqrt(Math.max(0, (b - a * a / n) / (n - 1)) * 250);
        }
        return v > 0 && Number.isFinite(v) ? v : NaN;
    }

    function stockStats(t, date) {
        const s = DATA.series[t];
        const i = s ? lastIdx(s.d, date) : -1;
        if (i < 0) return { t, status: 'nodata', mom: NaN, m1: NaN, m2: NaN, rise: NaN, vol: NaN, price: NaN };
        const r = { t, price: s.c[i], last: s.d[i] };
        r.m1 = momentumScore(s.c, i, P.momShort);
        r.m2 = momentumScore(s.c, i, P.momLong);
        r.mom = (r.m1 + r.m2) / 2;
        r.rise = i >= P.riseDays ? s.c[i] / s.c[i - P.riseDays] - 1 : NaN;
        r.vol = volatility(s, i);
        r.status = daysBetween(s.d[i], date) > STALE_DAYS ? 'stale'
            : !Number.isFinite(r.mom) || !Number.isFinite(r.vol) ? 'short'
            : r.mom < P.momMin ? 'weak'
            : r.rise > P.riseMax / 100 ? 'rise'
            : 'ok';
        return r;
    }

    // wagi parytetu ryzyka; suma wag = n / P.slots (puste sloty zostają w gotówce)
    function assignWeights(top, rows) {
        if (!top.length) return;
        let raw;
        if (P.weightMode === 'inv') {
            raw = top.map(r => 1 / r.vol);
        } else {
            const popRows = P.zPop === 'universe'
                ? rows.filter(r => Number.isFinite(r.vol) && r.status !== 'stale' && r.status !== 'nodata')
                : top;
            const pop = popRows.map(r => 1 / r.vol);
            const mean = pop.reduce((a, b) => a + b, 0) / pop.length;
            const sd = Math.sqrt(pop.reduce((a, b) => a + (b - mean) ** 2, 0) / pop.length);
            raw = top.map(r => {
                const z = sd > 0 ? Math.max(-2, Math.min(2, (1 / r.vol - mean) / sd)) : 0;
                return z > 0 ? 1 + z : 1 / (1 - z);
            });
        }
        const sum = raw.reduce((a, b) => a + b, 0);
        top.forEach((r, j) => { r.weight = raw[j] / sum * top.length / P.slots; });
    }

    const sortKey = v => Number.isFinite(v) ? v : -1e18;

    function rankAt(date, held = new Set()) {
        const rows = universeAt(date).map(t => stockStats(t, date));
        const cands = rows.filter(r => r.status === 'ok' || (r.status === 'rise' && !P.riseFilterHeld && held.has(r.t)));
        cands.sort((a, b) => b.mom - a.mom);
        const top = cands.slice(0, P.slots);
        top.forEach(r => { r.top = true; });
        assignWeights(top, rows);
        rows.sort((a, b) => sortKey(b.mom) - sortKey(a.mom));
        return { rows, top, eligible: cands.length };
    }

    const fee = v => v > 0 ? Math.max(P.commMin, v * P.commPct / 100) : 0;

    function trancheValue(tr, date) {
        let v = tr.cash;
        for (const [t, n] of Object.entries(tr.pos)) {
            const p = priceAt(t, date);
            if (Number.isFinite(p)) v += n * p;
        }
        return v;
    }

    // plan rebalansu transzy k na podstawie zamknięcia z dnia `date`
    function planTranche(trs, k, date) {
        const vals = trs.map(tr => trancheValue(tr, date));
        const total = vals.reduce((a, b) => a + b, 0);
        const V = vals[k];
        const excess = P.carryExcess ? Math.max(0, V - total / trs.length) : 0;
        const invest = Math.max(0, V - excess);
        const held = new Set(Object.keys(trs[k].pos));
        const rk = rankAt(date, held);
        const c = P.commPct / 100;
        const target = new Map();
        for (const r of rk.top) target.set(r.t, Math.floor(invest * r.weight / (r.price * (1 + c))));
        const orders = [];
        for (const t of new Set([...held, ...target.keys()])) {
            const cur = trs[k].pos[t] || 0, tgt = target.get(t) || 0, diff = tgt - cur;
            if (!diff) continue;
            orders.push({ t, side: diff > 0 ? 'buy' : 'sell', shares: Math.abs(diff), price: priceAt(t, date), kind: !cur ? 'nowa pozycja' : !tgt ? 'zamknięcie' : 'korekta wagi' });
        }
        const rankPos = new Map(rk.top.map((r, j) => [r.t, j]));
        orders.sort((a, b) => a.side !== b.side ? (a.side === 'sell' ? -1 : 1) : (rankPos.get(a.t) ?? 99) - (rankPos.get(b.t) ?? 99));
        return { k, date, vals, total, V, excess, invest, rk, target, orders };
    }

    function executeOrders(tr, orders, priceFn, onTrade) {
        const c = P.commPct / 100;
        for (const o of orders) {
            const px = priceFn(o.t);
            if (!(px > 0)) continue;
            if (o.side === 'sell') {
                const n = Math.min(o.shares, tr.pos[o.t] || 0);
                if (!n) continue;
                const value = n * px, f = fee(value);
                tr.cash += value - f;
                tr.pos[o.t] -= n;
                if (!tr.pos[o.t]) delete tr.pos[o.t];
                onTrade?.({ t: o.t, side: 'sell', shares: n, price: px, value, fee: f });
            } else {
                const n = Math.min(o.shares, Math.floor(tr.cash / (px * (1 + c))), Math.floor((tr.cash - P.commMin) / px));
                if (n <= 0) continue;
                const value = n * px, f = fee(value);
                tr.cash -= value + f;
                tr.pos[o.t] = (tr.pos[o.t] || 0) + n;
                onTrade?.({ t: o.t, side: 'buy', shares: n, price: px, value, fee: f });
            }
        }
    }

    function transferExcess(trs, k, amount) {
        const amt = Math.min(amount, Math.max(0, trs[k].cash));
        if (amt < 0.01) return 0;
        trs[k].cash -= amt;
        trs[(k + 1) % trs.length].cash += amt;
        return amt;
    }

    // indeks sesji wykonania -> numer transzy
    function rebalanceSchedule(c = calendar()) {
        const map = new Map();
        let month = -1, cnt = 0;
        for (let i = 0; i < c.length; i++) {
            const mk = Math.floor(c[i] / 100);
            if (mk !== month) { month = mk; cnt = 0; }
            if (++cnt === P.signalSession && i + 1 < c.length) map.set(i + 1, trancheOfMonth(mk % 100));
        }
        return map;
    }

    function nextRebalance(k, from) {
        let y = Math.floor(from / 10000), m = Math.floor(from / 100) % 100;
        for (let step = 0; step < 14; step++) {
            if (trancheOfMonth(m) === k) {
                const sess = sessionsOfMonth(y, m);
                const sig = sess[P.signalSession - 1], exe = sess[P.signalSession];
                if (exe && exe >= from) return { sig, exe };
            }
            if (++m > 12) { m = 1; y++; }
        }
        return { sig: 0, exe: 0 };
    }

    function runBacktest(cfg) {
        const c = calendar();
        let s = 0;
        while (s < c.length && c[s] < (cfg.start || 0)) s++;
        const e = cfg.end ? lastIdx(c, cfg.end) : c.length - 1;
        if (s >= c.length || e <= s) throw new Error('Brak sesji w wybranym zakresie dat.');
        const sched = rebalanceSchedule(c);
        const capital = cfg.capital || 0;
        const trs = Array.from({ length: TRANCHES }, () => ({ cash: capital / TRANCHES, pos: {} }));
        const deps = (cfg.deposits || []).slice().sort((a, b) => a.date - b.date);
        const bt = benchTicker();
        const out = { dates: [], value: [], twr: [], bench: [], cashPct: [], trTwr: trs.map(() => []), trades: [], fees: 0, deposited: capital, rebalances: 0 };
        let dp = 0, prevV = 0, idx = 100, b0 = NaN;
        let prevTV = trs.map(() => 0);
        const tIdx = trs.map(() => 100);
        for (let t = s; t <= e; t++) {
            const date = c[t];
            const flows = trs.map(() => 0);
            let dep = 0;
            while (dp < deps.length && deps[dp].date <= date) {
                const a = deps[dp++].amount;
                dep += a;
                trs.forEach((tr, k) => { tr.cash += a / TRANCHES; flows[k] += a / TRANCHES; });
            }
            out.deposited += dep;
            if (sched.has(t)) {
                const k = sched.get(t);
                const plan = planTranche(trs, k, c[t - 1]);
                executeOrders(trs[k], plan.orders, tk => priceAt(tk, date), x => {
                    out.trades.push({ date, k, ...x });
                    out.fees += x.fee;
                });
                const moved = transferExcess(trs, k, plan.excess);
                if (moved) {
                    flows[k] -= moved;
                    flows[(k + 1) % TRANCHES] += moved;
                    out.trades.push({ date, k, side: 'transfer', t: '', shares: 0, price: NaN, value: moved, fee: 0 });
                }
                out.rebalances++;
            }
            const tv = trs.map(tr => trancheValue(tr, date));
            const V = tv.reduce((a, b) => a + b, 0);
            if (prevV > 0) idx *= (V - dep) / prevV;
            trs.forEach((_, k) => {
                if (prevTV[k] > 0) tIdx[k] *= (tv[k] - flows[k]) / prevTV[k];
                out.trTwr[k].push(tIdx[k]);
            });
            prevV = V;
            prevTV = tv;
            const bp = priceAt(bt, date);
            if (!(b0 > 0) && bp > 0) b0 = bp;
            out.dates.push(date);
            out.value.push(V);
            out.twr.push(idx);
            out.bench.push(bp > 0 && b0 > 0 ? 100 * bp / b0 : NaN);
            out.cashPct.push(V > 0 ? trs.reduce((a, tr) => a + tr.cash, 0) / V : 1);
            cfg.onDay?.(date, trs, V);
        }
        out.final = trs;
        out.endDate = c[e];
        return out;
    }

    return {
        configure,
        get params() { return P; },
        get data() { return DATA; },
        get settings() { return SET; },
        benchTicker, universeAt, universeSource, manualList, calendar, priceAt, sessionNumber,
        momentumScore, volatility, stockStats, rankAt, fee, trancheValue,
        planTranche, executeOrders, transferExcess, rebalanceSchedule, nextRebalance, runBacktest,
    };
}

return {
    DEFAULT_PARAMS, TRANCHES, TRANCHE_MONTHS, STALE_DAYS, CRISES,
    ymd, toDate, pad2, iso, plDate, fromIso, daysBetween, addDays, lastIdx, parseTickers, trancheOfMonth,
    easter, gpwHolidays, isSession, sessionsOfMonth, parseDate, parseStooq, decodePack, encodeSeries,
    perfStats, drawdown, yearlyReturns, windowStats, makeDemo, createEngine,
};
});
