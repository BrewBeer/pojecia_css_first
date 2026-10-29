// Backtest i stres-test na prawdziwej historii GPW (momentum/data/history.json z npm run update).
// Raport wyników drukuje się w wyjściu testu (diagnostyka); asercje sprawdzają poprawność, nie wynik finansowy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { E, invariantHook } = require('./helpers.js');

const file = path.join(__dirname, '..', 'data', 'history.json');
const skip = !fs.existsSync(file) && 'brak momentum/data/history.json (uruchom npm run update)';
const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1).padStart(6) + '%' : '     –';

let data, eng, res;
function load() {
    if (res) return;
    data = E.decodePack(JSON.parse(fs.readFileSync(file, 'utf8')));
    eng = E.createEngine({ data, settings: { bench: data.bench } });
    res = eng.runBacktest({ start: 20100104, capital: 100000, onDay: invariantHook(eng) });
}

test('historia GPW od 2010: symulacja przechodzi bez naruszenia niezmienników', { skip }, t => {
    load();
    const st = E.perfStats(res.dates, res.twr), bs = E.perfStats(res.dates, res.bench);
    assert.ok(st && Number.isFinite(st.cagr) && Number.isFinite(st.mdd));
    assert.ok(res.rebalances >= 12 * (Math.floor(res.endDate / 10000) - 2010));
    t.diagnostic(`okres ${E.plDate(res.dates[0])} – ${E.plDate(res.endDate)}, rebalansów ${res.rebalances}, transakcji ${res.trades.length}, prowizje ${res.fees.toFixed(0)} zł`);
    t.diagnostic(`strategia: CAGR ${pct(st.cagr)}, maks. obsunięcie ${pct(st.mdd)}, zmienność ${pct(st.vol)}`);
    t.diagnostic(`WIG:       CAGR ${pct(bs.cagr)}, maks. obsunięcie ${pct(bs.mdd)}`);
    res.trTwr.forEach((v, k) => { const s = E.perfStats(res.dates, v); t.diagnostic(`transza ${k + 1}: CAGR ${pct(s.cagr)}, maks. obsunięcie ${pct(s.mdd)}`); });
});

test('historia GPW: zakupy tylko spółek z uniwersum obowiązującego w dniu sygnału', { skip }, () => {
    load();
    const cal = eng.calendar();
    for (const x of res.trades.filter(x => x.side === 'buy')) {
        const sig = cal[E.lastIdx(cal, x.date) - 1];
        assert.ok(eng.universeAt(sig).includes(x.t), `${x.t} kupiona ${x.date} spoza uniwersum`);
    }
});

test('stres-test historyczny: okresy kryzysów', { skip }, t => {
    load();
    for (const [name, from, to] of E.CRISES) {
        const w = E.windowStats(res, from, to);
        if (!w) continue;
        assert.ok(Number.isFinite(w.strategy.total));
        t.diagnostic(`${name.padEnd(32)} strategia ${pct(w.strategy.total)} (obsun. ${pct(w.strategy.mdd)}) | WIG ${pct(w.bench?.total)} (obsun. ${pct(w.bench?.mdd)}) | gotówka śr. ${pct(w.avgCash)}`);
    }
});

test('wrażliwość na parametry: próg momentum × liczba spółek', { skip }, t => {
    load();
    for (const momMin of [10, 20, 30]) {
        const row = [];
        for (const slots of [3, 5, 7]) {
            const e = E.createEngine({ data, params: { momMin, slots }, settings: { bench: data.bench } });
            const r = e.runBacktest({ start: 20100104, capital: 100000 });
            const s = E.perfStats(r.dates, r.twr);
            assert.ok(Number.isFinite(s.cagr));
            row.push(`${slots} spółek: CAGR ${pct(s.cagr)} / DD ${pct(s.mdd)}`);
        }
        t.diagnostic(`momentum ≥ ${momMin}: ${row.join(' | ')}`);
    }
});
