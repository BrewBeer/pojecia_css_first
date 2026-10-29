#!/usr/bin/env node
/*
 * Przetwarza paczkę notowań Stooq (d_pl_txt.zip lub rozpakowany folder d_pl_txt)
 * na lekkie pliki danych aplikacji i wyznacza kwartalny skład uniwersum (przybliżony WIG140).
 *
 *   npm run update                     # szuka ./d_pl_txt, ./d_pl_txt.zip, potem ~/Downloads/d_pl_txt*.zip
 *   npm run update -- ścieżka.zip      # wskazany plik lub folder
 *   npm run update -- --push           # dodatkowo testy + commit + push danych
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../engine.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const OUT = path.join(ROOT, 'momentum', 'data');
const HISTORY_FROM = 20090101;      // 250 sesji rozgrzewki przed pierwszym rebalansem w 2010
const UNIVERSE_FROM = 2009;         // pierwszy rok rewizji składu
const UNIVERSE_SIZE = 140;          // WIG20 + mWIG40 + sWIG80
const LIVE_MONTHS = 20;             // ile historii trafia do lekkiego pliku live.json

const args = process.argv.slice(2);
const push = args.includes('--push');
const srcArg = args.find(a => !a.startsWith('--'));

function log(...a) { console.log('•', ...a); }
function fail(msg) { console.error('✗', msg); process.exit(1); }

// ---------- 1. źródło danych
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
    const dir = path.join(os.tmpdir(), 'momentum-stooq');
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

// ---------- 2. odczyt
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
const lastDate = wig.d[wig.d.length - 1];
log(`Spółek: ${Object.keys(stocks).length}, kapitalizacji: ${Object.keys(mv).length}, ostatnia sesja: ${E.plDate(lastDate)}`);

// ---------- 3. kwartalny skład uniwersum (przybliżenie WIG140)
// Ranking na ostatniej sesji lutego/maja/sierpnia/listopada, zmiana od sesji po 3. piątku marca/czerwca/września/grudnia.
// Kryterium: średnia z miejsc w rankingu kapitalizacji i rocznych obrotów (GPW używa free floatu, którego w paczce nie ma).
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
for (let y = UNIVERSE_FROM; y <= Math.floor(lastDate / 10000); y++) {
    for (const m of [3, 6, 9, 12]) {
        const R = lastSessionOfMonth(y, m - 1);
        if (R > lastDate) continue;
        const tickers = rankAtReview(R);
        if (tickers.length) universe.push({ from: E.addDays(thirdFriday(y, m), 1), ranked: R, tickers });
    }
}

const manualFile = path.join(OUT, 'wig140.txt');
const manual = fs.existsSync(manualFile) ? E.parseTickers(fs.readFileSync(manualFile, 'utf8').replace(/#.*$/gm, '')) : [];
const current = universe[universe.length - 1];
if (manual.length) {
    const auto = new Set(current.tickers);
    const missing = manual.filter(t => !stocks[t]);
    log(`Lista ręczna wig140.txt: ${manual.length} spółek, zgodność z przybliżeniem ${manual.filter(t => auto.has(t)).length}/${manual.length}.`);
    if (missing.length) log(`Brak notowań dla: ${missing.join(', ')}`);
    current.tickers = manual.filter(t => stocks[t]).sort();
    current.source = 'manual';
}
log(`Rewizji składu: ${universe.length}, bieżący skład od ${E.plDate(current.from)} (${current.tickers.length} spółek${current.source ? ', z listy ręcznej' : ', przybliżony'}).`);

// ---------- 4. zapis
fs.mkdirSync(OUT, { recursive: true });
const everIn = new Set(universe.flatMap(u => u.tickers));
function pack(kind, tickers, from, entries) {
    const series = { WIG: E.encodeSeries(wig, from) };
    for (const t of [...tickers].sort()) {
        const enc = E.encodeSeries(stocks[t], from);
        if (enc) series[t] = enc;
    }
    return { kind, generated: new Date().toISOString(), source: 'stooq.pl d_pl_txt', lastDate, bench: 'WIG', universe: entries, series };
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

fs.writeFileSync(path.join(OUT, 'wig140-auto.txt'),
    `# Przybliżony skład WIG140 wyznaczony ${new Date().toISOString().slice(0, 10)} z danych do ${E.plDate(lastDate)}\n` +
    `# (ranking kapitalizacji i obrotów z ${E.plDate(current.ranked)}). Oficjalny skład: GPW Benchmark, indeks WIG140 (PL9999998377).\n` +
    `# Żeby użyć oficjalnej listy, wklej tickery do wig140.txt w tym folderze.\n` +
    current.tickers.join('\n') + '\n');

// ---------- 5. opcjonalnie: testy + commit + push
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
