// Testy jednostkowe reguł strategii.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, sessions, path, series, engine, qualifying } = require('./helpers.js');

test('momentum: równy wzrost 20% rocznie z R² = 1 daje wynik 20', () => {
    const eng = engine({});
    const c = Float64Array.from({ length: 300 }, (_, i) => 100 * Math.pow(1.2, i / 250));
    assert.ok(Math.abs(eng.momentumScore(c, 299, 125) - 20) < 1e-6);
    assert.ok(Math.abs(eng.momentumScore(c, 299, 250) - 20) < 1e-6);
});

test('momentum: szum obniża wynik przez R², spadek daje wynik ujemny', () => {
    const eng = engine({});
    const smooth = Float64Array.from(path(300, { annual: 0.4 }));
    const noisy = Float64Array.from(path(300, { annual: 0.4, noise: 0.03, seed: 7 }));
    const down = Float64Array.from(path(300, { annual: -0.3 }));
    assert.ok(eng.momentumScore(noisy, 299, 250) < eng.momentumScore(smooth, 299, 250));
    assert.ok(eng.momentumScore(down, 299, 250) < 0);
    assert.ok(Number.isNaN(eng.momentumScore(smooth, 100, 250)), 'za krótka historia → NaN');
});

test('transze: luty/maj/sie/lis → T1, marzec/cze/wrz/gru → T2, kwiecień/lip/paź/sty → T3', () => {
    E.TRANCHE_MONTHS.forEach((months, k) => months.forEach(m => assert.equal(E.trancheOfMonth(m), k)));
});

test('kalendarz GPW: Wielkanoc, Boże Ciało, 11 listopada, Wigilia', () => {
    assert.equal(E.ymd(E.easter(2026)), 20260405);
    assert.equal(E.ymd(E.easter(2027)), 20270328);
    for (const d of [20260403, 20260406, 20260604, 20261111, 20261224, 20261231]) assert.equal(E.isSession(d), false, String(d));
    assert.equal(E.isSession(20261110), true);
    const nov = E.sessionsOfMonth(2026, 11);
    assert.equal(nov[8], 20261113, '9. sesja listopada 2026');
    assert.equal(nov[9], 20261116, '10. sesja listopada 2026');
});

test('harmonogram: następny rebalans każdej transzy', () => {
    const eng = engine({});
    assert.deepEqual(eng.nextRebalance(0, 20261029), { sig: 20261113, exe: 20261116 });
    assert.deepEqual(eng.nextRebalance(1, 20261029), { sig: 20261211, exe: 20261214 });
    assert.equal(Math.floor(eng.nextRebalance(2, 20261029).exe / 100), 202701);
});

test('import Stooq: CSV ze strony i TXT z paczki, błędne wiersze pomijane', () => {
    const csv = E.parseStooq('pko_d.csv', 'Data,Otwarcie,Najwyzszy,Najnizszy,Zamkniecie,Wolumen\n2024-01-03,1,2,1,41,9\n2024-01-02,1,2,1,40,9\nzle,1,1,1,1,1\n2024-01-04,1,1,1,0,1\n');
    assert.deepEqual(Object.keys(csv), ['PKO']);
    assert.deepEqual(Array.from(csv.PKO.d), [20240102, 20240103], 'posortowane, bez złych wierszy');
    const txt = E.parseStooq('wig.txt', '<TICKER>,<PER>,<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>\nWIG,D,20240102,000000,1,2,0.5,1.5,100,0\n', { volume: true });
    assert.equal(txt.WIG.c[0], 1.5);
    assert.equal(txt.WIG.v[0], 100);
});

test('format danych: kodowanie i dekodowanie zachowuje kursy z dokładnością 0,01%', () => {
    const dates = sessions(20200102, 600);
    const s = series(dates, path(600, { annual: 0.1, noise: 0.03, seed: 3 }), 0.02);
    const back = E.decodePack({ series: { X: E.encodeSeries(s) } }).series.X;
    assert.deepEqual(Array.from(back.d), dates);
    for (let i = 0; i < dates.length; i++) {
        assert.ok(Math.abs(back.c[i] / s.c[i] - 1) < 1e-4);
        assert.ok(Math.abs(back.h[i] / s.h[i] - 1) < 1e-3);
    }
});

test('prowizja: 0,5%, minimum 5 zł', () => {
    const eng = engine({});
    assert.equal(eng.fee(0), 0);
    assert.equal(eng.fee(500), 5);
    assert.equal(eng.fee(10000), 50);
});

test('wagi: suma = n/5, mniej zmienna spółka ma większą wagę, rozpiętość ograniczona winsoryzacją', () => {
    const dates = sessions(20200102, 400);
    const data = { WIG: series(dates, path(400, {})) };
    const noise = [0.004, 0.006, 0.01, 0.015, 0.02];
    noise.forEach((n, k) => { data['S' + k] = qualifying(dates, { annual: 0.5, noise: n, seed: k * 50 + 1 }, n * 1.5, { WIG: data.WIG }); });
    const eng = engine(data);
    const { top } = eng.rankAt(dates[399]);
    assert.equal(top.length, 5);
    const sum = top.reduce((a, r) => a + r.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    const byVol = [...top].sort((a, b) => a.vol - b.vol);
    for (let i = 1; i < byVol.length; i++) assert.ok(byVol[i].weight <= byVol[i - 1].weight + 1e-12, 'waga maleje ze zmiennością');
    assert.ok(byVol[0].weight / byVol[4].weight <= 9 + 1e-9, 'max stosunek wag 3 / (1/3) = 9');
});

test('mniej niż 5 kandydatów: reszta transzy w gotówce', () => {
    const dates = sessions(20200102, 400);
    const data = { WIG: series(dates, path(400, {})), A: series(dates, path(400, { annual: 0.5, noise: 0.005 })), B: series(dates, path(400, { annual: 0.4, noise: 0.008, seed: 2 })), C: series(dates, path(400, { annual: -0.2, seed: 3 })) };
    const { top } = engine(data).rankAt(dates[399]);
    assert.deepEqual(top.map(r => r.t).sort(), ['A', 'B']);
    assert.ok(Math.abs(top.reduce((a, r) => a + r.weight, 0) - 2 / 5) < 1e-9);
});

test('filtr wzrostu: nie kupuje po +30% w 90 sesjach, ale trzymanej spółki nie wyrzuca (chyba że włączono)', () => {
    const dates = sessions(20200102, 400);
    const data = { WIG: series(dates, path(400, {})), HOT: series(dates, path(400, { annual: 2.0, noise: 0.004 })), OK: series(dates, path(400, { annual: 0.4, noise: 0.004, seed: 2 })) };
    const eng = engine(data);
    const d = dates[399];
    assert.equal(eng.stockStats('HOT', d).status, 'rise');
    assert.deepEqual(eng.rankAt(d).top.map(r => r.t), ['OK']);
    assert.deepEqual(eng.rankAt(d, new Set(['HOT'])).top.map(r => r.t), ['HOT', 'OK']);
    eng.configure({ params: { riseFilterHeld: true } });
    assert.deepEqual(eng.rankAt(d, new Set(['HOT'])).top.map(r => r.t), ['OK']);
});

test('zlecenia: sprzedaże przed zakupami, gotówka nigdy ujemna, pełne akcje', () => {
    const dates = sessions(20200102, 400);
    const data = { WIG: series(dates, path(400, {})) };
    for (let k = 0; k < 6; k++) data['S' + k] = series(dates, path(400, { annual: 0.3 + k * 0.05, noise: 0.006, seed: k + 1 }));
    data.OLD = series(dates, path(400, { annual: -0.4, seed: 9 }));
    const eng = engine(data);
    const trs = [{ cash: 1000, pos: { OLD: 300 } }, { cash: 30000, pos: {} }, { cash: 30000, pos: {} }];
    const d = dates[399];
    const plan = eng.planTranche(trs, 0, d);
    assert.equal(plan.orders[0].side, 'sell');
    assert.equal(plan.orders[0].t, 'OLD');
    eng.executeOrders(trs[0], plan.orders, t => eng.priceAt(t, d));
    assert.ok(trs[0].cash >= 0);
    assert.ok(!('OLD' in trs[0].pos));
    assert.ok(Object.keys(trs[0].pos).length <= 5);
});

test('nadwyżka ponad 1/3 portfela przechodzi do kolejnej transzy', () => {
    const dates = sessions(20200102, 300);
    const eng = engine({ WIG: series(dates, path(300, {})) });
    const trs = [{ cash: 60000, pos: {} }, { cash: 20000, pos: {} }, { cash: 20000, pos: {} }];
    const plan = eng.planTranche(trs, 0, dates[299]);
    assert.ok(Math.abs(plan.excess - (60000 - 100000 / 3)) < 1e-6);
    const moved = eng.transferExcess(trs, 0, plan.excess);
    assert.ok(Math.abs(trs[1].cash - (20000 + moved)) < 1e-6);
    assert.ok(Math.abs(trs[0].cash - 100000 / 3) < 1e-6);
});
