/*
 * Notowania dzienne z Yahoo Finance (publiczne API wykresów, bez klucza).
 * Kursy skorygowane o dywidendy i splity (adjclose), tak jak w paczkach Stooq.
 *
 * Pułapka: gdy feed Yahoo się spóźnia, sesję wypełnia sztuczną świecą (O=H=L=C = poprzednie zamknięcie,
 * wolumen 0) i potem jej nie poprawia. Takie świece są tu odrzucane — lepsza luka niż fałszywy kurs.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../engine.js');

const URL_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SESSION_CLOSED_HOUR = 18;     // po tej godzinie (czasu warszawskiego) dzisiejsza świeca jest ostateczna

const warsawNow = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).map(x => [x.type, x.value]));
    return { date: +(p.year + p.month + p.day), hour: +p.hour };
};

async function getJson(url, tries = 3) {
    for (let k = 1; ; k++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } catch (e) {
            if (k >= tries) throw e;
            await new Promise(res => setTimeout(res, 1000 * k));
        }
    }
}

// { d, c, h, l, v } od daty from (yyyymmdd) albo null, gdy Yahoo nie zna symbolu
export async function fetchDaily(symbol, from = 19700101) {
    const p1 = Math.floor(E.toDate(from) / 1000), p2 = Math.floor(Date.now() / 1000);
    const j = await getJson(`${URL_BASE}${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=div,split`);
    const x = j?.chart?.result?.[0];
    if (!x?.timestamp) return null;
    const q = x.indicators.quote[0], adj = x.indicators.adjclose?.[0]?.adjclose || q.close;
    const now = warsawNow();
    const out = { d: [], c: [], h: [], l: [], v: [] };
    x.timestamp.forEach((ts, i) => {
        const d = E.ymd(new Date((ts + x.meta.gmtoffset) * 1000));
        const c = q.close[i], a = adj[i];
        if (!(c > 0 && a > 0)) return;
        if (d > now.date || (d === now.date && now.hour < SESSION_CLOSED_HOUR)) return;
        const filled = !q.volume[i] && q.open[i] === c && q.high[i] === c && q.low[i] === c;
        if (filled && x.meta.instrumentType !== 'CURRENCY') return;
        if (out.d.length && out.d[out.d.length - 1] === d) return;
        const k = a / c;
        out.d.push(d); out.c.push(a); out.h.push(q.high[i] * k); out.l.push(q.low[i] * k); out.v.push(q.volume[i] || 0);
    });
    return out.d.length ? out : null;
}

// równoległe pobieranie z limitem: mapa klucz → wynik (null przy błędzie, błędy w errors)
export async function fetchMany(items, fn, { concurrency = 8 } = {}) {
    const res = new Map(), errors = [];
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map(async it => {
            try { res.set(it, await fn(it)); } catch (e) { res.set(it, null); errors.push(`${it}: ${e.message}`); }
        }));
    }
    return { res, errors };
}
