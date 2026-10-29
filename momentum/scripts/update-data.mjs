#!/usr/bin/env node
/*
 * Aktualizuje pliki danych aplikacji (momentum/data/history.json i live.json).
 *
 *   npm run update                       # dociąga brakujące sesje z Yahoo Finance (bez pobierania paczek)
 *   npm run update -- --stooq            # pełna przebudowa z paczki Stooq i rewizja składu (raz na kwartał)
 *   npm run update -- --stooq ścieżka    # jw. ze wskazanej paczki lub folderu
 *   npm run update -- --push             # dodatkowo testy + commit + push danych
 *
 * Paczka Stooq (d_pl_txt.zip) jest potrzebna do rewizji składu, bo tylko ona ma historię kapitalizacji.
 * Szukana w ./d_pl_txt, ./d_pl_txt.zip, potem w ~/Downloads/d_pl_txt*.zip.
 * Benchmarki ETF zawsze pochodzą z Yahoo Finance, notowania w EUR przeliczane kursem EURPLN.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fetchDaily, fetchMany } from './yahoo.mjs';

const require = createRequire(import.meta.url);
const E = require('../engine.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const OUT = path.join(ROOT, 'momentum', 'data');
const HISTORY_FROM = 20090101;      // 250 sesji rozgrzewki przed pierwszym rebalansem w 2010
const UNIVERSE_FROM = 2009;         // pierwszy rok rewizji składu
const UNIVERSE_SIZE = 140;          // WIG20 + mWIG40 + sWIG80
const OVERLAP_DAYS = 45;            // zakładka z istniejącą historią do wyrównania skali kursów

const BENCHMARKS = [
    { t: 'ETFBW20TR', name: 'BETA ETF WIG20TR', symbol: 'ETFBW20TR.WA', currency: 'PLN' },
    { t: 'VUAA', name: 'Vanguard S&P 500 (Acc)', symbol: 'VUAA.MI', currency: 'EUR' },
    { t: 'VWCE', name: 'Vanguard FTSE All-World', symbol: 'VWCE.DE', currency: 'EUR' },
];
const LIVE_MONTHS = 20;             // ile historii trafia do lekkiego pliku live.json

const args = process.argv.slice(2);
const push = args.includes('--push');
const srcArg = args.find(a => !a.startsWith('--'));
const stooqMode = args.includes('--stooq') || !!srcArg;

function log(...a) { console.log('•', ...a); }
function fail(msg) { console.error('✗', msg); process.exit(1); }
const last = a => a[a.length - 1];
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// ---------- kalendarz rewizji składu
// Ranking na ostatniej sesji lutego/maja/sierpnia/listopada, zmiana od sesji po 3. piątku marca/czerwca/września/grudnia.
function thirdFriday(y, m) {
    let d = y * 10000 + m * 100 + 1, fridays = 0;
    while (true) {
        if (E.toDate(d).getDay() === 5 && ++fridays === 3) return d;
        d = E.addDays(d, 1);
    }
}
function lastSessionOfMonth(y, m) {
    const s = E.sessionsOfMonth(y, m);
    return s[s.length - 1];
}
function reviews(lastDate) {
    const out = [];
    for (let y = UNIVERSE_FROM; y <= Math.floor(lastDate / 10000); y++) {
        for (const m of [3, 6, 9, 12]) {
            const R = lastSessionOfMonth(y, m - 1);
            if (R <= lastDate) out.push({ ranked: R, from: E.addDays(thirdFriday(y, m), 1) });
        }
    }
    return out;
}

// ---------- A. pełna przebudowa z paczki Stooq
function findSource() {
    const cands = [];
    if (srcArg) cands.push(path.resolve(srcArg));
    cands.push(path.join(ROOT, 'd_pl_txt'), path.join(ROOT, 'd_pl_txt.zip'));
    const dl = path.join(os.homedir(), 'Downloads');
    if (fs.existsSync(dl)) {
        fs.readdirSync(dl).filter(f => /^d_pl_txt.*\.zip$/i.test(f))
            .map(f => path.join(dl, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
            .forEach(f => cands.push(f));
    }
    const found = cands.find(p => fs.existsSync(p));
    if (!found) fail('Nie znaleziono paczki Stooq. Pobierz d_pl_txt.zip ze stooq.pl/db/h/ (dane dzienne, Polska, ASCII).');
    return found;
}

function extract(zip) {
    const dir = path.join(os.tmpdir(), 'momentum-' + path.basename(zip, '.zip'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    log(`Rozpakowuję ${path.basename(zip)}…`);
    try {
        execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'ignore' });
    } catch {
        execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'ignore' });
    }
    return dir;
}

function findPlDir(base) {
    const stack = [base];
    while (stack.length) {
        const d = stack.pop();
        if (fs.existsSync(path.join(d, 'wse stocks'))) return d;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
    fail('W paczce nie ma folderu „wse stocks” (oczekiwano data/daily/pl/wse stocks).');
}

function loadStooq() {
    const src = findSource();
    const plDir = findPlDir(fs.statSync(src).isDirectory() ? src : extract(src));
    log(`Źródło: ${plDir}`);

    const stocks = {};
    for (const f of fs.readdirSync(path.join(plDir, 'wse stocks')).filter(f => f.endsWith('.txt'))) {
        Object.assign(stocks, E.parseStooq(f, fs.readFileSync(path.join(plDir, 'wse stocks', f), 'utf8'), { volume: true }));
    }
    const mv = {};
    const indDir = path.join(plDir, 'wse stocks indicators');
    if (fs.existsSync(indDir)) {
        for (const f of fs.readdirSync(indDir).filter(f => /_mv\.txt$/i.test(f))) {
            const t = f.replace(/_mv\.txt$/i, '').toUpperCase();
            const parsed = Object.values(E.parseStooq(f, fs.readFileSync(path.join(indDir, f), 'utf8')))[0];
            if (parsed) mv[t] = parsed;
        }
    }
    const wigFile = path.join(plDir, 'wse indices', 'wig.txt');
    if (!fs.existsSync(wigFile)) fail('Brak pliku indeksu WIG (wse indices/wig.txt).');
    const wig = E.parseStooq('wig.txt', fs.readFileSync(wigFile, 'utf8')).WIG;
    const lastDate = last(wig.d);
    log(`Spółek: ${Object.keys(stocks).length}, kapitalizacji: ${Object.keys(mv).length}, ostatnia sesja: ${E.plDate(lastDate)}`);

    // Kwartalny skład uniwersum (przybliżenie WIG140). Kryterium: średnia z miejsc w rankingu kapitalizacji
    // i rocznych obrotów (GPW używa free floatu, którego w paczce nie ma).
    function rankAtReview(R) {
        const rows = [];
        for (const [t, s] of Object.entries(stocks)) {
            const i = E.lastIdx(s.d, R);
            if (i < 0 || E.daysBetween(s.d[i], R) > E.STALE_DAYS) continue;
            const j0 = E.lastIdx(s.d, E.addDays(R, -365));
            if (i - j0 < 60) continue;
            let turnover = 0;
            for (let j = j0 + 1; j <= i; j++) turnover += s.c[j] * (s.v[j] || 0);
            const m = mv[t], k = m ? E.lastIdx(m.d, R) : -1;
            const cap = k >= 0 && E.daysBetween(m.d[k], R) <= E.STALE_DAYS ? m.c[k] : NaN;
            if (!(cap > 0) || !(turnover > 0)) continue;
            rows.push({ t, cap, turnover: turnover / (i - j0) * 250 });
        }
        const byCap = [...rows].sort((a, b) => b.cap - a.cap).map(r => r.t);
        const byTo = [...rows].sort((a, b) => b.turnover - a.turnover).map(r => r.t);
        const pos = t => (byCap.indexOf(t) + byTo.indexOf(t)) / 2;
        return rows.map(r => ({ ...r, score: pos(r.t) })).sort((a, b) => a.score - b.score).slice(0, UNIVERSE_SIZE).map(r => r.t).sort();
    }

    const universe = [];
    for (const { ranked, from } of reviews(lastDate)) {
        const tickers = rankAtReview(ranked);
        if (tickers.length) universe.push({ from, ranked, tickers });
    }
    return { stocks, wig, universe, lastDate, stooqDate: lastDate };
}

// ---------- B. dociągnięcie brakujących sesji z Yahoo Finance do istniejącej historii
async function loadFromYahoo() {
    const file = path.join(OUT, 'history.json');
    if (!fs.existsSync(file)) fail('Brak data/history.json. Za pierwszym razem uruchom pełną przebudowę: npm run update -- --stooq');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const H = E.decodePack(raw);
    const skip = new Set(['WIG', ...H.benchmarks.map(b => b.t)]);
    const stocks = Object.fromEntries(Object.entries(H.series).filter(([t]) => !skip.has(t)));
    const active = Object.keys(stocks).filter(t => E.daysBetween(last(stocks[t].d), H.lastDate) <= E.STALE_DAYS);
    log(`Yahoo Finance: dociągam sesje po ${E.plDate(H.lastDate)} dla ${active.length} notowanych spółek…`);
    const { res, errors } = await fetchMany(active, t => fetchDaily(t + '.WA', E.addDays(last(stocks[t].d), -OVERLAP_DAYS)));
    if (errors.length) log(`Błędy pobierania (${errors.length}): ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''}`);

    // Skala: Stooq i Yahoo korygują kursy o dywidendy tak samo, ale po nowej dywidendzie lub splicie Yahoo
    // przelicza całą swoją historię. Nowe sesje mnożymy więc przez medianę stosunku kursów z zakładki.
    const fresh = {}, missing = [], jumps = [];
    for (const t of active) {
        const y = res.get(t), s = stocks[t];
        if (!y) { missing.push(t); continue; }
        const ratios = [];
        y.d.forEach((d, i) => { const k = E.lastIdx(s.d, d); if (k >= 0 && s.d[k] === d) ratios.push(s.c[k] / y.c[i]); });
        if (!ratios.length) { missing.push(t); continue; }
        const r = median(ratios.slice(-10));
        const i0 = y.d.findIndex(d => d > last(s.d));
        if (i0 < 0) continue;
        fresh[t] = { d: y.d.slice(i0), c: y.c.slice(i0).map(x => x * r), h: y.h.slice(i0).map(x => x * r), l: y.l.slice(i0).map(x => x * r) };
        if (Math.abs(Math.log(fresh[t].c[0] / last(s.c))) > 0.4) jumps.push(t);
    }
    if (missing.length) log(`Brak notowań w Yahoo (${missing.length}): ${missing.join(', ')}`);
    if (jumps.length) log(`Uwaga, skok kursu ponad 40% na styku danych (sprawdź split/scalenie): ${jumps.join(', ')}`);

    // Sesja wchodzi tylko, gdy Yahoo ma ją dla co najmniej połowy spółek — inaczej to niepełny lub opóźniony dzień.
    const cover = new Map();
    for (const f of Object.values(fresh)) for (const d of f.d) cover.set(d, (cover.get(d) || 0) + 1);
    const ok = new Set([...cover].filter(([d, n]) => n >= active.length / 2 && E.isSession(d)).map(([d]) => d));
    const partial = [...cover.keys()].filter(d => !ok.has(d)).sort();
    if (partial.length) log(`Pomijam niepełne sesje: ${partial.map(E.plDate).join(', ')}`);

    for (const [t, f] of Object.entries(fresh)) {
        const keep = f.d.map((d, i) => ok.has(d) ? i : -1).filter(i => i >= 0);
        if (!keep.length) continue;
        const s = stocks[t];
        stocks[t] = {
            d: Int32Array.from([...s.d, ...keep.map(i => f.d[i])]),
            c: Float64Array.from([...s.c, ...keep.map(i => f.c[i])]),
            h: Float64Array.from([...s.h, ...keep.map(i => f.h[i])]),
            l: Float64Array.from([...s.l, ...keep.map(i => f.l[i])]),
        };
    }
    const lastDate = Math.max(H.lastDate, ...ok);
    log(ok.size ? `Dopisano sesje: ${[...ok].sort().map(E.plDate).join(', ')}` : 'Brak nowych sesji.');
    const stooqDate = raw.stooqDate || last(H.series.WIG.d);
    if (lastDate > last(H.series.WIG.d)) log(`Indeks WIG (brak dziennych notowań w Yahoo) kończy się na ${E.plDate(last(H.series.WIG.d))} — uzupełni go następna paczka Stooq.`);

    const due = reviews(lastDate).filter(r => r.from > last(H.universe).from);
    if (due.length) log(`Czas na rewizję składu (ranking z ${E.plDate(last(due).ranked)}): pobierz paczkę Stooq i uruchom npm run update -- --stooq`);
    return { stocks, wig: H.series.WIG, universe: H.universe, lastDate, stooqDate, prevBench: H.series };
}

// ---------- benchmarki (ETF-y) w złotych, z Yahoo Finance
async function loadBenchmarks(lastDate, prev = {}) {
    const symbols = [...BENCHMARKS.map(b => b.symbol), ...new Set(BENCHMARKS.filter(b => b.currency !== 'PLN').map(b => b.currency + 'PLN=X'))];
    const { res, errors } = await fetchMany(symbols, s => fetchDaily(s));
    if (errors.length) log(`Błędy pobierania benchmarków: ${errors.join('; ')}`);
    const series = {}, meta = [];
    for (const b of BENCHMARKS) {
        let s = res.get(b.symbol);
        const fx = b.currency === 'PLN' ? null : res.get(b.currency + 'PLN=X');
        if (s && fx) {
            const rate = d => { const i = E.lastIdx(fx.d, d); return i >= 0 && E.daysBetween(fx.d[i], d) <= E.STALE_DAYS ? fx.c[i] : NaN; };
            const keep = s.d.map((d, i) => [i, rate(d)]).filter(([, r]) => r > 0);
            s = { d: keep.map(([i]) => s.d[i]), c: keep.map(([i, r]) => s.c[i] * r), h: keep.map(([i, r]) => s.h[i] * r), l: keep.map(([i, r]) => s.l[i] * r) };
        } else if (s && b.currency !== 'PLN') s = null;
        if (!s?.d.length) {
            if (prev[b.t]) { series[b.t] = prev[b.t]; meta.push({ t: b.t, name: b.name, source: b.symbol, currency: b.currency }); }
            log(`Benchmark ${b.name}: brak danych z Yahoo (${b.symbol})${prev[b.t] ? ' — zostawiam poprzednie notowania' : ' — pomijam'}.`);
            continue;
        }
        series[b.t] = s;
        meta.push({ t: b.t, name: b.name, source: b.symbol, currency: b.currency });
        const end = last(s.d);
        log(`Benchmark ${b.name}: ${b.symbol}${b.currency !== 'PLN' ? ` (${b.currency} → PLN)` : ''}, ${E.plDate(s.d[0])} – ${E.plDate(end)}` +
            (E.daysBetween(end, lastDate) > E.STALE_DAYS ? '  ⚠ notowania kończą się wcześniej niż dane GPW' : ''));
    }
    return { series, meta };
}

// ---------- zapis
const data = stooqMode ? loadStooq() : await loadFromYahoo();
const { stocks, wig, universe, lastDate, stooqDate } = data;

const manualFile = path.join(OUT, 'wig140.txt');
const manual = fs.existsSync(manualFile) ? E.parseTickers(fs.readFileSync(manualFile, 'utf8').replace(/#.*$/gm, '')) : [];
const current = last(universe);
if (stooqMode && manual.length) {
    const auto = new Set(current.tickers);
    const missing = manual.filter(t => !stocks[t]);
    log(`Lista ręczna wig140.txt: ${manual.length} spółek, zgodność z przybliżeniem ${manual.filter(t => auto.has(t)).length}/${manual.length}.`);
    if (missing.length) log(`Brak notowań dla: ${missing.join(', ')}`);
    current.tickers = manual.filter(t => stocks[t]).sort();
    current.source = 'manual';
}
log(`Rewizji składu: ${universe.length}, bieżący skład od ${E.plDate(current.from)} (${current.tickers.length} spółek${current.source ? ', z listy ręcznej' : stooqMode ? ', przybliżony' : ''}).`);

const bench = await loadBenchmarks(lastDate, data.prevBench);

fs.mkdirSync(OUT, { recursive: true });
const everIn = new Set(universe.flatMap(u => u.tickers));
const source = stooqMode ? 'stooq.pl d_pl_txt' : `stooq.pl d_pl_txt do ${E.iso(stooqDate)} + Yahoo Finance`;
function pack(kind, tickers, from, entries) {
    const series = { WIG: E.encodeSeries(wig, from) };
    for (const [t, s] of Object.entries(bench.series)) { const enc = E.encodeSeries(s, from); if (enc) series[t] = enc; }
    for (const t of [...tickers].sort()) {
        const enc = stocks[t] && E.encodeSeries(stocks[t], from);
        if (enc) series[t] = enc;
    }
    return { kind, generated: new Date().toISOString(), source, stooqDate, lastDate, bench: 'WIG', benchmarks: bench.meta.filter(b => series[b.t]), universe: entries, series };
}
function write(name, obj) {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    log(`Zapisano ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${Object.keys(obj.series).length} serii)`);
}

write('history.json', pack('history', everIn, HISTORY_FROM, universe.map(({ from, tickers }) => ({ from, tickers }))));

const liveFrom = E.addDays(lastDate, -LIVE_MONTHS * 31);
const liveEntries = universe.filter(u => u.from >= E.addDays(lastDate, -400));
const liveTickers = new Set(liveEntries.flatMap(u => u.tickers));
write('live.json', pack('live', liveTickers, liveFrom, (liveEntries.length ? liveEntries : [current]).map(({ from, tickers }) => ({ from, tickers }))));

if (stooqMode) {
    fs.writeFileSync(path.join(OUT, 'wig140-auto.txt'),
        `# Przybliżony skład WIG140 wyznaczony ${new Date().toISOString().slice(0, 10)} z danych do ${E.plDate(lastDate)}\n` +
        `# (ranking kapitalizacji i obrotów z ${E.plDate(current.ranked)}). Oficjalny skład: GPW Benchmark, indeks WIG140 (PL9999998377).\n` +
        `# Żeby użyć oficjalnej listy, wklej tickery do wig140.txt w tym folderze.\n` +
        current.tickers.join('\n') + '\n');
}

// ---------- opcjonalnie: testy + commit + push
if (push) {
    const run = (cmd, a) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    run('npm', ['test']);
    run('git', ['add', 'momentum/data']);
    try {
        run('git', ['commit', '-m', `Dane notowań do ${E.iso(lastDate)}`]);
        run('git', ['push']);
    } catch {
        log('Brak zmian do zatwierdzenia albo push się nie udał.');
    }
}
