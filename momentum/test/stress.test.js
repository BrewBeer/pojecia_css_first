// Stres-testy: krachy, delisting, zawieszenia, złe dane, skrajne kwoty, losowe rynki.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, sessions, path, series, engine, qualifying, invariantHook } = require('./helpers.js');

const N = 900;
const dates = sessions(20180102, N);
const flat = () => series(dates, path(N, { noise: 0.008, seed: 99 }));
const trending = (k, extra = {}) => series(dates, path(N, { annual: 0.3 + 0.05 * k, noise: 0.006, seed: k + 1, ...extra }));

test('krach -40% jednego dnia: strata ograniczona zaangażowaniem, brak błędów', () => {
    const crash = 700;
    const data = { WIG: series(dates, path(N, { noise: 0.008, seed: 99, shocks: { [crash]: -0.4 } })) };
    for (let k = 0; k < 8; k++) data['S' + k] = trending(k, { shocks: { [crash]: -0.4 } });
    const eng = engine(data);
    const res = eng.runBacktest({ start: dates[260], capital: 100000, onDay: invariantHook(eng) });
    const i = res.dates.indexOf(dates[crash]);
    const dayLoss = res.value[i] / res.value[i - 1] - 1;
    const invested = 1 - res.cashPct[i - 1];
    assert.ok(dayLoss < 0);
    assert.ok(dayLoss >= -0.4 * invested - 1e-9, `strata ${dayLoss} większa niż 40% × zaangażowanie ${invested}`);
    assert.ok(res.value.at(-1) > 0);
});

test('delisting: spółka bez dalszych notowań jest wyceniana po ostatnim kursie i sprzedawana', () => {
    const data = { WIG: flat() };
    for (let k = 0; k < 6; k++) data['S' + k] = trending(k);
    const s = data.S5;
    const cut = 650;
    data.S5 = { d: s.d.slice(0, cut), c: s.c.slice(0, cut), h: s.h.slice(0, cut), l: s.l.slice(0, cut) };
    const eng = engine(data);
    const res = eng.runBacktest({ start: dates[260], capital: 100000, onDay: invariantHook(eng) });
    assert.ok(res.trades.some(x => x.t === 'S5' && x.side === 'buy' && x.date < dates[cut]), 'S5 była kupiona');
    assert.ok(res.final.every(tr => !tr.pos.S5), 'S5 sprzedana');
    assert.ok(res.value.every(Number.isFinite));
});

test('zawieszenie notowań na 30 dni: spółka nie jest kupowana w trakcie przerwy', () => {
    const data = { WIG: flat() };
    for (let k = 0; k < 6; k++) data['S' + k] = trending(k);
    const s = data.S5, keep = i => i < 600 || i >= 622;
    const idx = [...s.d.keys()].filter(keep);
    data.S5 = { d: Int32Array.from(idx, i => s.d[i]), c: Float64Array.from(idx, i => s.c[i]), h: Float64Array.from(idx, i => s.h[i]), l: Float64Array.from(idx, i => s.l[i]) };
    const eng = engine(data);
    const gapEnd = dates[621];
    assert.equal(eng.stockStats('S5', gapEnd).status, 'stale');
    const res = eng.runBacktest({ start: dates[260], capital: 100000, onDay: invariantHook(eng) });
    assert.ok(!res.trades.some(x => x.t === 'S5' && x.side === 'buy' && x.date > E.addDays(dates[600], 10) && x.date <= gapEnd));
});

test('złe dane: zerowe i brakujące kursy są pomijane przy imporcie', () => {
    const txt = '<TICKER>,<PER>,<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>\n' +
        'X,D,20240102,000000,1,1,1,10,1,0\nX,D,20240103,000000,1,1,1,0,1,0\nX,D,20240104,000000,1,1,1,,1,0\nX,D,20240105,000000,1,1,1,-3,1,0\nX,D,20240108,000000,1,1,1,11,1,0\n';
    const x = E.parseStooq('x.txt', txt).X;
    assert.deepEqual(Array.from(x.c), [10, 11]);
});

test('mały kapitał (300 zł): prowizja minimalna nie zadłuża konta', () => {
    const data = { WIG: flat() };
    for (let k = 0; k < 6; k++) data['S' + k] = trending(k, { start: 40 + k * 30 });
    const eng = engine(data);
    const res = eng.runBacktest({ start: dates[260], capital: 300, onDay: invariantHook(eng) });
    assert.ok(res.value.at(-1) > 0);
});

test('duży kapitał (1 mld zł): wyniki skończone, akcje całkowite', () => {
    const data = { WIG: flat() };
    for (let k = 0; k < 6; k++) data['S' + k] = trending(k);
    const eng = engine(data);
    const res = eng.runBacktest({ start: dates[260], capital: 1e9, onDay: invariantHook(eng) });
    assert.ok(res.value.every(Number.isFinite));
});

test('puste uniwersum: cała kwota w gotówce, bez błędu', () => {
    const res = engine({ WIG: flat() }).runBacktest({ start: dates[260], capital: 1000 });
    assert.equal(res.value.at(-1), 1000);
});

test('skrajna zmienność: spółka z wahaniami ±10% dziennie dostaje mniejszą wagę', () => {
    const base = { WIG: flat() };
    const data = { ...base, CALM: qualifying(dates, { annual: 0.4, noise: 0.005 }, 0.005, base), WILD: qualifying(dates, { annual: 0.6, noise: 0.03 }, 0.1, base) };
    const { top } = engine(data).rankAt(dates[N - 1]);
    assert.equal(top.length, 2);
    const w = Object.fromEntries(top.map(r => [r.t, r.weight]));
    assert.ok(w.CALM > w.WILD);
});

test('losowe rynki (25 przebiegów): niezmienniki zawsze spełnione', () => {
    for (let seed = 1; seed <= 25; seed++) {
        const data = E.makeDemo({ seed, stocks: 12, from: 20170102, to: 20211231 });
        const eng = engine(data);
        const res = eng.runBacktest({ start: 20180102, capital: 50000 + seed * 1000, onDay: invariantHook(eng) });
        assert.ok(res.twr.every(x => Number.isFinite(x) && x > 0), `seed ${seed}`);
        const fees = res.trades.reduce((a, x) => a + x.fee, 0);
        assert.ok(Math.abs(fees - res.fees) < 1e-6);
    }
});
