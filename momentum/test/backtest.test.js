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

const monthGap = (a, b) => (Math.floor(b / 100) - Math.floor(a / 100)) * 12 + (b % 100) - (a % 100);

test('harmonogram: transakcje tylko na 10. sesji, transze kwartalne co 3 miesiące, miesięczna co miesiąc', () => {
    const data = { WIG: flat(), A: series(dates, path(N, { annual: 0.5, noise: 0.005, seed: 3 })) };
    const eng = engine(data);
    const cal = eng.calendar();
    const sched = eng.rebalanceSchedule(cal);
    for (const [i, ks] of sched) {
        assert.equal(eng.sessionNumber(cal[i]), 10);
        assert.deepEqual(ks, [E.trancheOfMonth(Math.floor(cal[i] / 100) % 100), E.MONTHLY]);
    }
    for (const [k, gap] of [[0, 3], [1, 3], [2, 3], [E.MONTHLY, 1]]) {
        const months = [...sched].filter(([, ks]) => ks.includes(k)).map(([i]) => Math.floor(cal[i] / 100));
        for (let j = 1; j < months.length; j++) assert.equal(monthGap(months[j - 1], months[j]), gap, `transza ${k + 1}`);
    }
});

test('cztery transze: portfel dzielony na 4 równe części, transza miesięczna handluje co miesiąc', () => {
    const data = { WIG: flat() };
    for (let k = 0; k < 8; k++) data['S' + k] = series(dates, path(N, { annual: 0.25 + k * 0.05, noise: 0.012, seed: 30 + k }));
    const eng = engine(data);
    let first = null;
    const res = eng.runBacktest({ start: dates[260], capital: 100000, onDay: (d, trs) => { first ||= trs.map(tr => tr.cash); invariantHook(eng)(d, trs, 1); } });
    assert.equal(res.final.length, 4);
    assert.deepEqual(first, [25000, 25000, 25000, 25000]);
    const months = [...new Set(res.trades.filter(x => x.k === E.MONTHLY && x.side !== 'transfer').map(x => Math.floor(x.date / 100)))];
    assert.ok(months.length >= res.dates.length / 21 * 0.5, 'transza miesięczna zmienia skład regularnie');
    for (const x of res.trades.filter(x => x.side === 'transfer' && x.k === E.MONTHLY)) {
        assert.equal(x.to, E.trancheOfMonth(Math.floor(x.date / 100) % 100 % 12 + 1), 'nadwyżka do transzy kwartalnej z następnego miesiąca');
    }
});

test('tryb trzech transz (bez miesięcznej) nadal działa', () => {
    const data = { WIG: flat(), A: series(dates, path(N, { annual: 0.5, noise: 0.005, seed: 3 })) };
    const eng = engine(data, { monthlyTranche: false });
    const res = eng.runBacktest({ start: dates[260], capital: 90000 });
    assert.equal(res.final.length, 3);
    assert.ok([...eng.rebalanceSchedule().values()].every(ks => ks.length === 1));
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

test('benchmarki ETF: nie zmieniają kalendarza GPW, nie trafiają do uniwersum, są zapisywane w wyniku', () => {
    const data = { WIG: flat(), A: series(dates, path(N, { annual: 0.5, noise: 0.005, seed: 3 })) };
    // ETF z zagranicznej giełdy: notowany też w polskie święta i dopiero od połowy okresu
    const foreign = [];
    for (let d = dates[400]; d <= dates[N - 1]; d = E.addDays(d, 1)) if (E.toDate(d).getDay() % 6) foreign.push(d);
    data.ETF = series(foreign, path(foreign.length, { annual: 0.1, seed: 8 }));
    const eng = engine(data, {}, { benchmarks: [{ t: 'ETF', name: 'Test ETF' }] });
    assert.deepEqual(Array.from(eng.calendar()), dates);
    assert.ok(!eng.universeAt(dates[N - 1]).includes('ETF'));
    const res = eng.runBacktest({ start: dates[260], capital: 10000 });
    assert.equal(res.extra.length, 1);
    assert.ok(Number.isNaN(res.extra[0].values[0]), 'brak wartości przed debiutem');
    assert.ok(res.extra[0].values.at(-1) > 0);
    assert.ok(!res.trades.some(x => x.t === 'ETF'));
});
