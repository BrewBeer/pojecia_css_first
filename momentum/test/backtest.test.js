// Scenariusze symulacji na danych syntetycznych o znanych własnościach.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, sessions, path, series, engine, invariantHook } = require('./helpers.js');

const N = 1000;
const dates = sessions(20180102, N);
const flat = () => series(dates, path(N, { noise: 0.008, seed: 99 }));

test('stały trend wygrywa: spółka rosnąca równo 40%/rok jest w każdej transzy', () => {
    const data = { WIG: flat(), TREND: series(dates, path(N, { annual: 0.4, noise: 0.004, seed: 1 })) };
    for (let k = 0; k < 10; k++) data['RW' + k] = series(dates, path(N, { noise: 0.025, seed: 10 + k }));
    const eng = engine(data);
    const res = eng.runBacktest({ start: dates[260], capital: 90000, onDay: invariantHook(eng) });
    for (const tr of res.final) assert.ok(tr.pos.TREND > 0, 'TREND w transzy');
    assert.ok(res.value.at(-1) > 90000);
});

test('bessa: gdy wszystko spada, portfel zostaje w gotówce bez transakcji', () => {
    const data = { WIG: flat() };
    for (let k = 0; k < 8; k++) data['D' + k] = series(dates, path(N, { annual: -0.25, noise: 0.01, seed: k + 1 }));
    const res = engine(data).runBacktest({ start: dates[260], capital: 50000 });
    assert.equal(res.trades.length, 0);
    assert.equal(res.value.at(-1), 50000);
    assert.ok(res.cashPct.every(x => x === 1));
});

test('harmonogram: transakcje tylko na 10. sesji miesiąca, każda transza co 3 miesiące', () => {
    const data = { WIG: flat(), A: series(dates, path(N, { annual: 0.5, noise: 0.005, seed: 3 })) };
    const eng = engine(data);
    const cal = eng.calendar();
    const sched = eng.rebalanceSchedule(cal);
    for (const [i, k] of sched) {
        assert.equal(eng.sessionNumber(cal[i]), 10);
        assert.equal(E.trancheOfMonth(Math.floor(cal[i] / 100) % 100), k);
    }
    const byTranche = [0, 1, 2].map(k => [...sched].filter(([, x]) => x === k).map(([i]) => Math.floor(cal[i] / 100)));
    for (const months of byTranche) {
        for (let j = 1; j < months.length; j++) {
            const a = months[j - 1], b = months[j];
            assert.equal((Math.floor(b / 100) - Math.floor(a / 100)) * 12 + (b % 100) - (a % 100), 3);
        }
    }
});

test('wpłaty nie zmieniają stopy zwrotu ważonej czasem (TWR)', () => {
    const data = { WIG: flat(), D: series(dates, path(N, { annual: -0.3, seed: 2 })) };
    const res = engine(data).runBacktest({ start: dates[260], capital: 10000, deposits: [{ date: dates[500], amount: 20000 }] });
    assert.equal(res.value.at(-1), 30000);
    assert.ok(res.twr.every(x => Math.abs(x - 100) < 1e-9));
    assert.equal(res.deposited, 30000);
});

test('zmiana składu uniwersum: spółka, która wypadła z indeksu, jest sprzedawana', () => {
    const data = { WIG: flat(), A: series(dates, path(N, { annual: 0.5, noise: 0.004, seed: 4 })), B: series(dates, path(N, { annual: 0.45, noise: 0.004, seed: 5 })) };
    const cut = dates[700];
    const eng = engine(data, {}, { universe: [{ from: dates[0], tickers: ['A', 'B'] }, { from: cut, tickers: ['B'] }] });
    let heldBefore = false;
    const res = eng.runBacktest({
        start: dates[260], capital: 90000,
        onDay: (d, trs) => { if (d < cut && trs.some(tr => tr.pos.A)) heldBefore = true; },
    });
    assert.ok(heldBefore, 'A była kupiona przed wypadnięciem');
    assert.ok(res.final.every(tr => !tr.pos.A), 'A sprzedana we wszystkich transzach');
    assert.ok(res.trades.filter(x => x.t === 'A' && x.side === 'buy').every(x => x.date < cut), 'brak zakupów A po wypadnięciu');
});

test('determinizm: dwa przebiegi dają identyczny wynik', () => {
    const data = E.makeDemo({ stocks: 15, from: 20160104, to: 20221230 });
    const a = engine(data).runBacktest({ start: 20170103, capital: 100000 });
    const b = engine(data).runBacktest({ start: 20170103, capital: 100000 });
    assert.deepEqual(a.value, b.value);
    assert.equal(a.trades.length, b.trades.length);
});
