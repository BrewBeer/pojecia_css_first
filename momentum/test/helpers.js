// Generatory danych syntetycznych i wspólne asercje dla testów strategii.
const assert = require('node:assert/strict');
const E = require('../engine.js');

function sessions(from, n) {
    const out = [];
    for (let d = from; out.length < n; d = E.addDays(d, 1)) if (E.isSession(d)) out.push(d);
    return out;
}

function rng(seed) {
    let s = seed | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// seria z rocznym tempem `annual` (np. 0.4 = +40%/rok) i dziennym szumem `noise`
function path(n, { annual = 0, noise = 0, start = 100, seed = 1, shocks = {} } = {}) {
    const r = rng(seed), mu = Math.log(1 + annual) / 250, out = [];
    let p = start;
    for (let i = 0; i < n; i++) {
        if (i) p *= Math.exp(mu + noise * (Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())));
        if (shocks[i]) p *= 1 + shocks[i];
        out.push(p);
    }
    return out;
}

function series(dates, closes, range = 0.01) {
    const c = Float64Array.from(closes);
    return { d: Int32Array.from(dates), c, h: c.map(x => x * (1 + range)), l: c.map(x => x * (1 - range)) };
}

function engine(series, params = {}, extra = {}) {
    return E.createEngine({ params, data: { series, ...extra }, settings: { bench: 'WIG' } });
}

// seria spełniająca warunki zakupu na ostatniej sesji (szum bywa za duży dla danego ziarna)
function qualifying(dates, opts, range, base = {}) {
    for (let seed = opts.seed || 1; seed < 500; seed++) {
        const s = series(dates, path(dates.length, { ...opts, seed }), range);
        if (engine({ ...base, Q: s }).stockStats('Q', dates[dates.length - 1]).status === 'ok') return s;
    }
    throw new Error('nie udało się wygenerować kwalifikującej się spółki');
}

// niezmienniki sprawdzane po każdej sesji symulacji
function invariantHook(eng) {
    return (date, trs, V) => {
        assert.ok(Number.isFinite(V), `wartość portfela nie jest liczbą (${date})`);
        for (const tr of trs) {
            assert.ok(tr.cash > -1e-6, `ujemna gotówka ${tr.cash} (${date})`);
            const pos = Object.entries(tr.pos);
            assert.ok(pos.length <= eng.params.slots, `za dużo spółek w transzy (${date})`);
            for (const [t, n] of pos) assert.ok(Number.isInteger(n) && n > 0, `zła liczba akcji ${t}=${n} (${date})`);
        }
    };
}

module.exports = { E, sessions, rng, path, series, engine, qualifying, invariantHook };
