// Interfejs aplikacji Momentum GPW. Logika strategii: engine.js, synchronizacja: sync.js.
(function () {
'use strict';

const E = window.MomentumEngine;
const S = window.MomentumSync;
const eng = E.createEngine();
const { MAX_TRANCHES, MONTHLY, TRANCHE_MONTHS, DEFAULT_PARAMS, plDate, iso, fromIso, ymd, lastIdx, daysBetween } = E;
const DATA_URL = 'momentum/data/';
const STATE_KEY = 'momentum.state';

// ---------- narzędzia DOM i formatowanie
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k in e && k !== 'list') e[k] = v;
        else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
}
const nf = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const pln = v => Number.isFinite(v) ? nf(v, 2) + ' zł' : '–';
const pct = (v, d = 1) => Number.isFinite(v) ? nf(v * 100, d) + '%' : '–';
const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const monthsLabel = k => k === MONTHLY ? 'co miesiąc' : TRANCHE_MONTHS[k].map(m => MONTHS[m - 1]).join(' · ');
// aktywne transze: 3 kwartalne + (opcjonalnie) miesięczna; portfel zawsze przechowuje wszystkie 4
const nT = () => eng.trancheCount();
const active = () => PF.tranches.slice(0, nT());
const today = () => ymd(new Date());

function figures(items) {
    return h('div', { class: 'figures' }, items.map(([label, value, sub]) =>
        h('div', { class: 'figure' }, h('div', { class: 'figure-label' }, label), h('div', { class: 'figure-value' }, value), sub ? h('div', { class: 'figure-sub' }, sub) : null)));
}
function panel(title, meta, ...body) {
    return h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, title), meta ? h('span', { class: 'meta' }, meta) : null),
        h('div', { class: 'panel-body' }, ...body));
}
// nagłówek z ">" na początku = kolumna liczbowa
function table(head, rows, cls = '') {
    return h('div', { class: 'table-wrap ' + cls }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, head.map(c => h('th', { class: c.startsWith('>') ? 'num' : '' }, c.replace(/^>/, ''))))),
        h('tbody', {}, rows)));
}
const td = (v, num) => h('td', { class: num ? 'num' : '' }, v);
const tk = t => h('span', { class: 'ticker' }, t);

function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* pamięć niedostępna */ } }

const idb = {
    _db: null,
    open() {
        return this._db ||= new Promise((res, rej) => {
            const r = indexedDB.open('momentum-gpw', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('kv');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    },
    async get(key) {
        const db = await this.open();
        return new Promise((res, rej) => {
            const q = db.transaction('kv').objectStore('kv').get(key);
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
        });
    },
    async set(key, val) {
        const db = await this.open();
        return new Promise((res, rej) => {
            const tx = db.transaction('kv', 'readwrite');
            if (val === undefined) tx.objectStore('kv').delete(key); else tx.objectStore('kv').put(val, key);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    },
};

// ---------- stan: portfel + parametry + ustawienia (lokalnie i w Supabase)
let PF = null;
let STATE = null;
let PLAN = null;
let ANALYSIS = 0;
let SOURCE = { kind: 'none' };
let HIST = null;
let BT = null;
let liveCharts = [];
let syncInfo = { state: 'off', at: null, error: '' };
let pushTimer = null;

function normalizePF(x) {
    const tr = Array.isArray(x?.tranches) ? x.tranches : [];
    return {
        tranches: Array.from({ length: MAX_TRANCHES }, (_, k) => ({
            cash: +tr[k]?.cash || 0,
            pos: Object.fromEntries(Object.entries(tr[k]?.pos || {})
                .filter(([, n]) => Math.floor(+n) > 0)
                .map(([t, n]) => [String(t).toUpperCase(), Math.floor(+n)])),
        })),
        journal: Array.isArray(x?.journal) ? x.journal.filter(j => j && typeof j.text === 'string').slice(-500) : [],
    };
}

function loadState() {
    let st = lsGet(STATE_KEY, null);
    if (!st) {
        // migracja z pierwszej wersji aplikacji
        st = { portfolio: lsGet('momentum.portfolio', null), params: lsGet('momentum.params', {}), settings: lsGet('momentum.settings', {}), savedAt: 0 };
    }
    applyState(st);
}
function applyState(st) {
    STATE = { portfolio: st.portfolio, params: { ...DEFAULT_PARAMS, ...(st.params || {}) }, settings: { bench: 'WIG', universe: '', ...(st.settings || {}) }, savedAt: st.savedAt || 0 };
    PF = normalizePF(st.portfolio);
    STATE.portfolio = PF;
    eng.configure({ params: STATE.params, settings: STATE.settings });
    PLAN = null;
}
function saveState() {
    STATE.portfolio = PF;
    STATE.params = eng.params;
    STATE.settings = eng.settings;
    STATE.savedAt = Date.now();
    lsSet(STATE_KEY, STATE);
    if (S.user) {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(syncPush, 700);
    }
}
function savePF() { PLAN = null; saveState(); }
function journal(text) { PF.journal.push({ ts: new Date().toISOString(), text }); }

async function syncPush() {
    try {
        setSync('busy');
        await S.push(STATE);
        setSync('ok');
    } catch (e) { setSync('err', e.message); }
}
async function syncPull(initial = false) {
    if (!S.user) return;
    try {
        setSync('busy');
        const remote = await S.pull();
        if (remote && (remote.savedAt || 0) > (STATE.savedAt || 0)) {
            applyState(remote);
            lsSet(STATE_KEY, STATE);
            renderAfterSettings();
        } else if (initial && (!remote || (STATE.savedAt || 0) > (remote.savedAt || 0))) {
            await S.push(STATE);
        }
        setSync('ok');
    } catch (e) { setSync('err', e.message); }
}
function setSync(state, error = '') {
    syncInfo = { state, at: state === 'ok' ? new Date() : syncInfo.at, error };
    renderAccount();
}

// ---------- konto i logowanie
function renderAccount() {
    const el = $('#account');
    el.replaceChildren();
    if (!S.available) {
        el.append(h('span', { class: 'dot' }), h('span', {}, 'Tylko to urządzenie'), h('button', { class: 'btn text sm', onclick: openLogin }, 'Synchronizacja'));
        return;
    }
    if (!S.user) {
        el.append(h('span', { class: 'dot' }), h('button', { class: 'btn line sm', onclick: openLogin }, 'Zaloguj'));
        return;
    }
    const label = syncInfo.state === 'busy' ? 'synchronizuję…'
        : syncInfo.state === 'err' ? 'błąd synchronizacji'
        : syncInfo.at ? `zsynchronizowano ${syncInfo.at.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}` : '';
    el.append(
        h('span', { class: 'dot ' + (syncInfo.state === 'err' ? 'err' : 'on'), title: syncInfo.error || '' }),
        h('span', {}, S.user.email, label ? h('span', { class: 'faint' }, ' · ' + label) : null),
        h('button', { class: 'btn text sm', onclick: () => S.signOut() }, 'Wyloguj'));
}

function openLogin() {
    const body = $('#login-body');
    body.replaceChildren();
    if (!S.configured) {
        body.append(
            h('p', { class: 'small', style: 'margin:0' }, 'Synchronizacja nie jest jeszcze skonfigurowana, więc portfel jest zapisany tylko w tej przeglądarce.'),
            h('ol', { class: 'plain small' },
                h('li', {}, 'Załóż darmowy projekt w Supabase.'),
                h('li', {}, 'W SQL Editor uruchom plik momentum/supabase/schema.sql.'),
                h('li', {}, 'Wklej Project URL i klucz anon public do momentum/config.js, a potem zrób commit i push.')));
    } else if (!S.available) {
        body.append(h('p', { class: 'small' }, 'Nie udało się wczytać biblioteki Supabase. Sprawdź połączenie z internetem i odśwież stronę.'));
    } else {
        const email = h('input', { type: 'email', autocomplete: 'email', required: true });
        const pass = h('input', { type: 'password', autocomplete: 'current-password', minLength: 8, required: true });
        const msg = h('p', { class: 'form-msg' });
        const run = async (fn) => {
            msg.className = 'form-msg';
            msg.textContent = '…';
            try {
                const needsConfirm = await fn(email.value.trim(), pass.value);
                if (needsConfirm === true) { msg.textContent = 'Wysłaliśmy e-mail z linkiem potwierdzającym. Po kliknięciu zaloguj się tutaj.'; return; }
                $('#login').close();
            } catch (e) {
                msg.className = 'form-msg err';
                msg.textContent = e.message === 'Invalid login credentials' ? 'Nieprawidłowy e-mail lub hasło.' : e.message;
            }
        };
        body.append(
            h('p', { class: 'small muted', style: 'margin:0' }, 'Portfel, parametry i dziennik będą dostępne na każdym urządzeniu po zalogowaniu.'),
            h('label', { class: 'field' }, 'E-mail', email),
            h('label', { class: 'field' }, 'Hasło (min. 8 znaków)', pass),
            msg,
            h('div', { class: 'row' },
                h('button', { class: 'btn', onclick: e => { e.preventDefault(); run(S.signIn); } }, 'Zaloguj się'),
                h('button', { class: 'btn line', onclick: e => { e.preventDefault(); run(S.signUp); } }, 'Załóż konto')));
    }
    $('#login').showModal();
}

// ---------- dane
async function loadData() {
    try {
        const r = await fetch(DATA_URL + 'live.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.status);
        const pack = E.decodePack(await r.json());
        return setData({ series: pack.series, universe: pack.universe, benchmarks: pack.benchmarks }, { kind: 'repo', lastDate: pack.lastDate, generated: pack.generated });
    } catch { /* brak serwera (plik z dysku) albo brak pliku danych */ }
    try {
        const saved = await idb.get('data');
        if (saved?.series) return setData(saved, { kind: saved.demo ? 'demo' : 'import' });
    } catch { /* IndexedDB niedostępne */ }
    setData({ series: {} }, { kind: 'none' });
}

function setData(data, source) {
    eng.configure({ data });
    SOURCE = source;
    HIST = null;
    BT = null;
    renderBacktest();
    onDataChanged();
}

async function historyData() {
    if (HIST) return HIST;
    if (SOURCE.kind === 'repo') {
        $('#bt-status').textContent = 'Pobieram pełną historię notowań…';
        const r = await fetch(DATA_URL + 'history.json', { cache: 'no-cache' });
        if (r.ok) {
            const pack = E.decodePack(await r.json());
            return (HIST = { series: pack.series, universe: pack.universe, benchmarks: pack.benchmarks });
        }
    }
    return (HIST = eng.data);
}

const hasData = () => eng.universeAt(ANALYSIS).length > 0;

function onDataChanged() {
    PLAN = null;
    const cal = eng.calendar();
    const inp = $('#an-date');
    ANALYSIS = cal.length ? cal[cal.length - 1] : 0;
    if (cal.length) {
        inp.min = iso(cal[0]);
        inp.max = iso(ANALYSIS);
        inp.value = iso(ANALYSIS);
        inp.disabled = false;
    } else {
        inp.value = '';
        inp.disabled = true;
    }
    $('#an-info').textContent = cal.length ? `ostatnia sesja w danych: ${plDate(ANALYSIS)}` : 'brak notowań';
    $('#tickers').replaceChildren(...Object.keys(eng.data.series).sort().map(t => h('option', { value: t })));
    renderNotices();
    renderDataStatus();
    renderRanking();
    renderPortfolio();
}

function renderAfterSettings() {
    $('#set-universe').value = eng.settings.universe;
    $('#set-bench').value = eng.settings.bench;
    renderParams();
    onDataChanged();
}

function renderNotices() {
    const el = $('#notices');
    el.replaceChildren();
    if (SOURCE.kind === 'demo') el.append(h('div', { class: 'notice' }, 'Wczytane są dane demonstracyjne (syntetyczne spółki DEMO01–DEMO40). Służą wyłącznie do przetestowania aplikacji.'));
    if (SOURCE.kind === 'none') el.append(h('div', { class: 'notice info' }, 'Brak notowań. Otwórz aplikację z serwera (GitHub Pages) albo wczytaj pliki Stooq w zakładce Dane.'));
    const hidden = PF.tranches.slice(nT()).filter(tr => tr.cash > 0 || Object.keys(tr.pos).length);
    if (hidden.length) el.append(h('div', { class: 'notice' }, 'Transza miesięczna jest wyłączona w parametrach, ale ma środki lub akcje. Włącz ją ponownie albo przenieś środki do innych transz.'));
    const last = eng.calendar().at(-1);
    if (last && SOURCE.kind !== 'demo') {
        const age = daysBetween(last, today());
        if (age > 7) el.append(h('div', { class: 'notice' }, `Notowania kończą się ${plDate(last)} (${age} dni temu). Pobierz nową paczkę Stooq i uruchom npm run update -- --push.`));
    }
}

async function importFiles(list) {
    const files = [...list].filter(f => /\.(csv|txt)$/i.test(f.name) && f.size > 0);
    const st = $('#in-status');
    if (!files.length) { st.textContent = 'Nie znaleziono plików .csv ani .txt.'; return; }
    const series = SOURCE.kind === 'import' ? { ...eng.data.series } : {};
    let done = 0, ok = 0;
    for (const f of files) {
        try {
            for (const [t, s] of Object.entries(E.parseStooq(f.name, await f.text()))) { series[t] = s; ok++; }
        } catch { /* pomijamy uszkodzony plik */ }
        if (++done % 25 === 0) { st.textContent = `Wczytuję ${done}/${files.length}…`; await new Promise(r => setTimeout(r)); }
    }
    st.textContent = `Wczytano ${ok} serii z ${files.length} plików.`;
    const data = { series, universe: null, demo: false };
    idb.set('data', data).catch(() => {});
    setData(data, { kind: 'import' });
}

function renderDataStatus() {
    const el = $('#data-status');
    el.replaceChildren();
    const cal = eng.calendar(), uni = eng.universeAt(ANALYSIS), src = eng.universeSource();
    const sourceLabel = { repo: 'plik danych z repozytorium (live.json)', import: 'pliki wczytane ręcznie', demo: 'dane demonstracyjne', none: 'brak' }[SOURCE.kind];
    const uniLabel = { manual: 'lista ręczna', history: 'przybliżony WIG140 (ranking kapitalizacji i obrotów)', all: 'wszystkie wczytane serie' }[src];
    el.append(h('dl', { class: 'kv' },
        h('dt', {}, 'Źródło'), h('dd', {}, sourceLabel),
        h('dt', {}, 'Notowania'), h('dd', {}, cal.length ? `${plDate(cal[0])} – ${plDate(cal.at(-1))}` : '–'),
        SOURCE.generated ? [h('dt', {}, 'Wygenerowano'), h('dd', {}, new Date(SOURCE.generated).toLocaleString('pl-PL'))] : null,
        h('dt', {}, 'Benchmark'), h('dd', {}, eng.data.series[eng.benchTicker()] ? eng.benchTicker() : 'brak'),
        h('dt', {}, 'Uniwersum'), h('dd', {}, `${uni.length} spółek`)));
    const entry = eng.data.universe?.filter(u => u.from <= (ANALYSIS || Infinity)).at(-1);
    $('#uni-meta').textContent = uniLabel + (src === 'history' && entry ? `, obowiązuje od ${plDate(entry.from)}` : '');
    $('#uni-list').textContent = uni.join('  ') || '–';
    const missing = eng.manualList().filter(t => !eng.data.series[t]);
    if (missing.length) el.append(h('div', { class: 'notice' }, `Brak notowań dla ${missing.length} spółek z listy ręcznej: ${missing.join(', ')}`));
}

// ---------- ranking
const STATUS = r => {
    if (r.top) return ['TOP ' + eng.params.slots, 'top'];
    return {
        ok: ['kwalifikuje się', 'ok'],
        weak: [`momentum < ${eng.params.momMin}`, ''],
        rise: [`wzrost > ${eng.params.riseMax}% / ${eng.params.riseDays} sesji`, 'warn'],
        short: ['za krótka historia', ''],
        stale: ['brak bieżących notowań', 'bad'],
        nodata: ['brak danych', 'bad'],
    }[r.status];
};
const statusEl = r => { const [l, c] = STATUS(r); return h('span', { class: 'status ' + c }, l); };
const volLabel = () => eng.params.volMode === 'atr' ? `ATR ${eng.params.volDays}/kurs` : `Zmienn. ${eng.params.volDays}`;
const volFmt = v => eng.params.volMode === 'atr' ? pct(v, 2) : pct(v);

function renderRanking() {
    const figs = $('#rk-figures'), host = $('#rk-table');
    figs.replaceChildren();
    host.replaceChildren();
    if (!hasData()) { host.append(h('p', { class: 'muted' }, 'Brak notowań. Wczytaj dane w zakładce Dane.')); return; }
    const { rows, top, eligible } = eng.rankAt(ANALYSIS);
    const invested = top.reduce((a, r) => a + r.weight, 0);
    figs.append(figures([
        ['Dzień rankingu', plDate(ANALYSIS), `${eng.sessionNumber(ANALYSIS)}. sesja miesiąca`],
        ['Uniwersum', String(rows.length), 'spółek'],
        ['Spełnia warunki', String(eligible), `momentum ≥ ${eng.params.momMin}, wzrost ≤ ${eng.params.riseMax}%`],
        ['Zaangażowanie transzy', pct(invested, 0), `${top.length} z ${eng.params.slots} spółek`],
    ]));
    let n = 0;
    host.append(table(['>#', 'Spółka', '>Kurs', `>Mom. ${eng.params.momShort}`, `>Mom. ${eng.params.momLong}`, '>Momentum', `>Zmiana ${eng.params.riseDays} s.`, '>' + volLabel(), '>Waga', 'Status'],
        rows.map(r => h('tr', { class: r.top ? 'mark' : '' },
            td(r.status === 'ok' || r.top ? String(++n) : '', true),
            h('td', {}, tk(r.t)),
            td(nf(r.price), true),
            td(nf(r.m1, 1), true),
            td(nf(r.m2, 1), true),
            h('td', { class: 'num' }, h('b', {}, nf(r.mom, 1))),
            td(pct(r.rise), true),
            td(volFmt(r.vol), true),
            td(r.top ? pct(r.weight) : '', true),
            h('td', {}, statusEl(r))))));
}

// ---------- portfel
function renderPortfolio() {
    const date = ANALYSIS;
    $('#pf-date').textContent = hasData() ? `Wycena po kursach zamknięcia z ${plDate(date)}` : 'Brak notowań do wyceny';
    const vals = active().map(tr => eng.trancheValue(tr, date));
    const total = vals.reduce((a, b) => a + b, 0);
    const cash = active().reduce((a, tr) => a + tr.cash, 0);
    const npos = active().reduce((a, tr) => a + Object.keys(tr.pos).length, 0);
    const next = active().map((_, k) => eng.nextRebalance(k, today()));
    const soonest = next.reduce((best, x, k) => x.exe && (best < 0 || x.exe < next[best].exe) ? k : best, -1);
    $('#dep-target option[value="3"]').hidden = nT() < MAX_TRANCHES;
    $('#pf-figures').replaceChildren(figures([
        ['Wartość portfela', pln(total)],
        ['Gotówka', pln(cash), total > 0 ? `${pct(cash / total)} portfela` : ''],
        ['Pozycje', `${npos} / ${eng.params.slots * nT()}`],
        ['Najbliższy rebalans', soonest >= 0 ? plDate(next[soonest].exe) : '–', soonest >= 0 ? `Transza ${soonest + 1}, sygnał ${plDate(next[soonest].sig)}` : ''],
    ]));
    renderMarket();
    $('#pf-calendar').replaceChildren(table(['Transza', 'Miesiące', '>Sygnał (9. sesja)', '>Transakcje (10. sesja)'],
        next.map((x, k) => h('tr', { class: k === soonest ? 'mark' : '' },
            h('td', {}, h('b', {}, `Transza ${k + 1}`)), td(monthsLabel(k)), td(plDate(x.sig), true), td(plDate(x.exe), true)))));

    const cards = $('#pf-cards');
    cards.replaceChildren();
    active().forEach((tr, k) => {
        const v = vals[k];
        const posRows = Object.entries(tr.pos).sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => {
            const p = eng.priceAt(t, date);
            return h('tr', {},
                h('td', {}, tk(t)),
                h('td', { class: 'num' }, h('input', {
                    type: 'number', min: 0, step: 1, value: n, class: 'in-num', 'aria-label': `Liczba akcji ${t}`,
                    onchange: e => { const x = Math.floor(+e.target.value); if (x > 0) tr.pos[t] = x; else delete tr.pos[t]; savePF(); renderPortfolio(); },
                })),
                td(nf(n * p), true),
                td(pct(n * p / v), true),
                h('td', { class: 'num' }, h('button', { class: 'icon-x', title: 'Usuń pozycję', 'aria-label': `Usuń ${t}`, onclick: () => { delete tr.pos[t]; savePF(); renderPortfolio(); } }, '×')));
        });
        const addT = h('input', { placeholder: 'Ticker', list: 'tickers', class: 'in-ticker', 'aria-label': 'Ticker' });
        const addN = h('input', { type: 'number', min: 1, step: 1, placeholder: 'Akcje', class: 'in-num', 'aria-label': 'Liczba akcji' });
        cards.append(h('section', { class: 'panel' },
            h('div', { class: 'panel-head' }, h('h2', {}, `Transza ${k + 1}`), h('span', { class: 'meta' }, monthsLabel(k))),
            h('div', { class: 'panel-body' },
                h('div', { class: 'tranche-value' }, pln(v)),
                h('div', { class: 'tranche-meta' },
                    h('span', {}, total > 0 ? `${pct(v / total)} portfela` : '—'),
                    h('span', {}, `rebalans ${plDate(next[k].exe)}`)),
                posRows.length ? table(['Spółka', '>Akcje', '>Wartość', '>Udział', ''], posRows) : h('p', { class: 'small muted' }, 'Brak akcji w transzy.'),
                h('div', { class: 'row', style: 'margin-top:14px' },
                    h('label', { class: 'small muted row', style: 'gap:8px' }, 'Gotówka', h('input', {
                        type: 'number', step: '0.01', value: Math.round(tr.cash * 100) / 100, class: 'in-num', style: 'width:120px',
                        onchange: e => { tr.cash = +e.target.value || 0; savePF(); renderPortfolio(); },
                    }))),
                h('div', { class: 'row' }, addT, addN, h('button', {
                    class: 'btn line sm',
                    onclick: () => {
                        const t = addT.value.trim().toUpperCase(), n = Math.floor(+addN.value);
                        if (!t || !(n > 0)) return;
                        tr.pos[t] = (tr.pos[t] || 0) + n;
                        savePF();
                        renderPortfolio();
                    },
                }, 'Dodaj'))),
            h('div', { class: 'panel-foot' }, h('button', {
                class: 'btn', disabled: !hasData(),
                onclick: () => { PLAN = eng.planTranche(active(), k, ANALYSIS); renderPlan(); $('#pf-plan').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
            }, 'Przygotuj rebalans'))));
    });
    renderPlan();
    renderJournal();
}

// stopy zwrotu WIG i ETF-ów z bieżących notowań
function renderMarket() {
    const host = $('#pf-market');
    host.replaceChildren();
    const list = [{ t: eng.benchTicker(), name: eng.benchTicker() }, ...eng.benchmarks()].filter(x => eng.data.series[x.t]);
    if (!list.length || !ANALYSIS) return;
    const y = Math.floor(ANALYSIS / 10000);
    const ret = (t, from) => { const a = eng.priceAt(t, from), b = eng.priceAt(t, ANALYSIS); return a > 0 && b > 0 ? b / a - 1 : NaN; };
    const periods = [['Od początku roku', (y - 1) * 10000 + 1231], ['3 miesiące', E.addDays(ANALYSIS, -91)], ['12 miesięcy', E.addDays(ANALYSIS, -365)]];
    host.append(panel('Rynek i benchmarki', 'stopy zwrotu w złotych, z dywidendami',
        table(['Benchmark', ...periods.map(p => '>' + p[0])], list.map(x => h('tr', {}, h('td', {}, h('b', {}, x.name)), periods.map(([, from]) => td(pct(ret(x.t, from)), true)))))));
}

function renderPlan() {
    const el = $('#pf-plan');
    el.replaceChildren();
    if (!PLAN) return;
    const pl = PLAN, k = pl.k, nextK = pl.to;
    const sess = eng.sessionNumber(pl.date), month = Math.floor(pl.date / 100) % 100;
    const onSchedule = sess === eng.params.signalSession && eng.tranchesForMonth(month).includes(k);
    const sim = structuredClone(PF.tranches[k]);
    let fees = 0;
    eng.executeOrders(sim, pl.orders, t => eng.priceAt(t, pl.date), x => { fees += x.fee; });
    const moved = Math.min(pl.excess, Math.max(0, sim.cash));
    const missingPx = pl.orders.filter(o => !(o.price > 0)).map(o => o.t);

    const body = [];
    if (!onSchedule) {
        body.push(h('div', { class: 'notice', style: 'margin:0 0 16px' },
            `Wybrany dzień to ${sess || '?'}. sesja miesiąca (${MONTHS[month - 1]}). Transza ${k + 1} rebalansuje się po ${eng.params.signalSession}. sesji (${k === MONTHLY ? 'co miesiąc' : 'w miesiącach: ' + monthsLabel(k)}). Ten plan jest poglądowy.`));
    }
    body.push(h('dl', { class: 'kv', style: 'margin-bottom:20px' },
        h('dt', {}, 'Wartość transzy'), h('dd', {}, pln(pl.V)),
        h('dt', {}, `1/${nT()} wartości portfela`), h('dd', {}, pln(pl.total / nT())),
        h('dt', {}, `Nadwyżka do transzy ${nextK + 1}`), h('dd', {}, pln(moved)),
        h('dt', {}, 'Do zainwestowania'), h('dd', {}, pln(pl.invest))));
    body.push(h('h3', { style: 'margin-bottom:8px' }, 'Docelowy skład'));
    body.push(pl.rk.top.length
        ? table(['>#', 'Spółka', '>Momentum', `>Zmiana ${eng.params.riseDays} s.`, '>' + volLabel(), '>Waga', '>Akcje', '>Kurs', '>Wartość'],
            pl.rk.top.map((r, j) => {
                const n = pl.target.get(r.t) || 0;
                return h('tr', {}, td(String(j + 1), true), h('td', {}, tk(r.t)), td(nf(r.mom, 1), true), td(pct(r.rise), true),
                    td(volFmt(r.vol), true), td(pct(r.weight), true), td(String(n), true), td(nf(r.price), true), td(nf(n * r.price), true));
            }))
        : h('p', { class: 'muted' }, 'Żadna spółka nie spełnia warunków. Cała transza zostaje w gotówce.'));
    if (pl.rk.top.length && pl.rk.top.length < eng.params.slots) {
        body.push(h('p', { class: 'small muted' }, `Warunki spełnia ${pl.rk.top.length} z ${eng.params.slots} spółek. Reszta transzy zostaje w gotówce.`));
    }
    body.push(h('h3', { style: 'margin:22px 0 8px' }, 'Zlecenia na następną sesję'));
    body.push(pl.orders.length
        ? table(['Operacja', 'Spółka', '>Akcje', '>Kurs zamkn.', '>Wartość', '>Prowizja', 'Powód'],
            pl.orders.map(o => h('tr', {},
                h('td', { class: o.side === 'buy' ? 'side-buy' : 'side-sell' }, o.side === 'buy' ? 'KUP' : 'SPRZEDAJ'),
                h('td', {}, tk(o.t)), td(String(o.shares), true), td(nf(o.price), true),
                td(nf(o.shares * o.price), true), td(nf(eng.fee(o.shares * o.price)), true), td(o.kind))))
        : h('p', { class: 'muted' }, 'Brak zmian w składzie transzy.'));
    if (missingPx.length) body.push(h('div', { class: 'notice' }, `Brak kursu dla: ${missingPx.join(', ')}. Te zlecenia zostaną pominięte przy księgowaniu.`));

    const copyBtn = h('button', { class: 'btn line' }, 'Kopiuj zlecenia');
    copyBtn.onclick = () => {
        const text = pl.orders.map(o => `${o.side === 'buy' ? 'KUP' : 'SPRZEDAJ'} ${o.t} ${o.shares} szt.`).join('\n') || 'Brak zleceń';
        navigator.clipboard?.writeText(text).then(() => { copyBtn.textContent = 'Skopiowano'; }, () => { copyBtn.textContent = 'Nie udało się skopiować'; });
    };
    el.append(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, `Plan rebalansu: Transza ${k + 1}`), h('span', { class: 'meta' }, `sygnał z zamknięcia ${plDate(pl.date)}`)),
        h('div', { class: 'panel-body' }, body),
        h('div', { class: 'panel-foot' },
            h('p', { style: 'margin:0 0 12px' }, `Szacunkowo: prowizje ${pln(fees)}, gotówka po transakcjach ${pln(sim.cash - moved)}. Zlecenia składa się na fazę zamknięcia następnej sesji. Po realizacji popraw gotówkę i liczby akcji według wyciągu z biura maklerskiego.`),
            h('div', { class: 'row' },
                h('button', { class: 'btn', onclick: bookPlan }, `Zaksięguj po kursach z ${plDate(pl.date)}`),
                copyBtn,
                h('button', { class: 'btn text', onclick: () => { PLAN = null; renderPlan(); } }, 'Zamknij')))));
}

function bookPlan() {
    const pl = PLAN, k = pl.k, parts = [];
    eng.executeOrders(PF.tranches[k], pl.orders, t => eng.priceAt(t, pl.date), x => parts.push(`${x.side === 'buy' ? 'kupno' : 'sprzedaż'} ${x.shares} ${x.t} po ${nf(x.price)}`));
    const moved = eng.transferExcess(active(), k, pl.excess, pl.to);
    journal(`Rebalans transzy ${k + 1} (sygnał ${plDate(pl.date)}): ${parts.join(', ') || 'bez zmian'}${moved ? `; nadwyżka ${pln(moved)} → transza ${pl.to + 1}` : ''}.`);
    savePF();
    renderPortfolio();
}

function renderJournal() {
    const ul = $('#pf-journal');
    ul.replaceChildren(...PF.journal.slice(-60).reverse().map(j =>
        h('li', {}, h('time', {}, new Date(j.ts).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })), h('span', {}, j.text))));
    if (!PF.journal.length) ul.append(h('li', { class: 'muted' }, h('time', {}, '—'), h('span', {}, 'Brak wpisów.')));
}

// ---------- wykres liniowy (canvas + kursor z podpowiedzią)
function niceTicks(a, b, count) {
    const raw = (b - a) / count, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
    const out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(+v.toFixed(10) || 0);
    return out;
}
function logTicks(lo, hi) {
    for (const ms of [[1, 2, 5], [1, 1.5, 2, 3, 5, 7]]) {
        const out = [];
        for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
            for (const m of ms) { const v = m * 10 ** e; if (v >= lo && v <= hi) out.push(v); }
        }
        if (out.length >= 4 || ms.length > 3) return out.length > 9 ? out.filter((_, i) => i % 2 === 0) : out;
    }
}

function lineChart(host, cfg) {
    host.replaceChildren();
    if (cfg.series.length > 1) {
        host.append(h('div', { class: 'legend' }, cfg.series.map(s => h('span', {}, h('i', { style: `background:var(${s.color})` }), s.name))));
    }
    const box = h('div', { class: 'chart-box', tabindex: 0, role: 'img', 'aria-label': cfg.label, style: `height:${cfg.height || 340}px` });
    const base = h('canvas'), over = h('canvas'), tip = h('div', { class: 'tip' });
    tip.hidden = true;
    box.append(base, over, tip);
    host.append(box);
    const n = cfg.x.length;
    let g = null, cur = -1;
    const MONO = "'IBM Plex Mono', ui-monospace, monospace";

    function draw() {
        const W = box.clientWidth, H = box.clientHeight;
        if (!W || !H || !n) return;
        const dpr = window.devicePixelRatio || 1;
        for (const c of [base, over]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
        const ctx = base.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const cs = getComputedStyle(document.documentElement);
        const col = name => cs.getPropertyValue(name).trim();
        const endLabels = cfg.series.length <= 4 && W > 520;
        const pad = { l: 54, r: endLabels ? 132 : 12, t: 10, b: 26 };
        const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
        let lo = Infinity, hi = -Infinity;
        for (const s of cfg.series) for (const v of s.values) if (Number.isFinite(v) && (!cfg.log || v > 0)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!Number.isFinite(lo)) return;
        if (cfg.zeroTop) hi = 0;
        const tf = v => cfg.log ? Math.log(v) : v;
        let a = tf(lo), b = tf(hi);
        if (a === b) { a -= 1; b += 1; }
        const span = b - a;
        a -= span * 0.04;
        if (!cfg.zeroTop) b += span * 0.04;
        const X = i => pad.l + (n > 1 ? i / (n - 1) : 0.5) * pw;
        const Y = v => pad.t + (1 - (tf(v) - a) / (b - a)) * ph;

        ctx.font = `400 11px ${MONO}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const t of cfg.log ? logTicks(Math.exp(a), Math.exp(b)) : niceTicks(a, b, 5)) {
            const y = Math.round(Y(t)) + 0.5;
            if (y < pad.t - 1 || y > pad.t + ph + 1) continue;
            ctx.strokeStyle = col('--grid');
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
            ctx.fillStyle = col('--ink-3');
            ctx.fillText(cfg.yFmt(t), pad.l - 8, y);
        }
        ctx.strokeStyle = col('--rule-strong');
        ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ph + 0.5); ctx.lineTo(pad.l + pw, pad.t + ph + 0.5); ctx.stroke();

        // oś X: lata, a przy krótkich zakresach miesiące
        const marks = [];
        const yearsSpan = Math.floor(cfg.x[n - 1] / 10000) - Math.floor(cfg.x[0] / 10000);
        for (let i = 1; i < n; i++) {
            const pm = Math.floor(cfg.x[i - 1] / 100), m = Math.floor(cfg.x[i] / 100);
            if (yearsSpan >= 3 ? Math.floor(pm / 100) !== Math.floor(m / 100) : pm !== m) {
                marks.push([i, yearsSpan >= 3 ? String(Math.floor(m / 100)) : `${E.pad2(m % 100)}.${String(Math.floor(m / 100)).slice(2)}`]);
            }
        }
        const every = Math.max(1, Math.ceil(marks.length / Math.max(1, Math.floor(pw / 60))));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = col('--ink-3');
        marks.forEach(([i, label], j) => {
            if (j % every) return;
            ctx.fillRect(Math.round(X(i)), pad.t + ph, 1, 4);
            ctx.fillText(label, X(i), pad.t + ph + 8);
        });

        for (const s of cfg.series) {
            ctx.strokeStyle = col(s.color);
            ctx.lineWidth = s.width || 2;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < n; i++) {
                const v = s.values[i];
                if (!Number.isFinite(v) || (cfg.log && v <= 0)) { pen = false; continue; }
                if (pen) ctx.lineTo(X(i), Y(v)); else ctx.moveTo(X(i), Y(v));
                pen = true;
            }
            ctx.stroke();
        }

        if (endLabels) {
            const items = cfg.series.map(s => {
                let i = n - 1;
                while (i >= 0 && !Number.isFinite(s.values[i])) i--;
                return i < 0 ? null : { s, v: s.values[i], y: Y(s.values[i]) };
            }).filter(Boolean).sort((p, q) => p.y - q.y);
            for (let j = 1; j < items.length; j++) if (items[j].y - items[j - 1].y < 30) items[j].y = items[j - 1].y + 30;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            for (const it of items) {
                ctx.fillStyle = col(it.s.color);
                ctx.fillRect(pad.l + pw + 8, it.y - 7, 10, 2);
                ctx.fillStyle = col('--ink');
                ctx.font = `500 12px ${MONO}`;
                ctx.fillText(cfg.yFmt(it.v, true), pad.l + pw + 22, it.y - 6);
                ctx.fillStyle = col('--ink-2');
                ctx.font = `400 11px ${getComputedStyle(document.body).fontFamily}`;
                ctx.fillText(it.s.name, pad.l + pw + 22, it.y + 8);
            }
        }
        g = { X, Y, pad, pw, ph, W, H, col, dpr };
        drawCursor();
    }

    function drawCursor() {
        if (!g) return;
        const ctx = over.getContext('2d');
        ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
        ctx.clearRect(0, 0, g.W, g.H);
        if (cur < 0) { tip.hidden = true; return; }
        const x = g.X(cur);
        ctx.strokeStyle = g.col('--ink-3');
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, g.pad.t); ctx.lineTo(Math.round(x) + 0.5, g.pad.t + g.ph); ctx.stroke();
        tip.replaceChildren(h('div', { class: 'tip-d' }, plDate(cfg.x[cur])));
        for (const s of cfg.series) {
            const v = s.values[cur];
            if (!Number.isFinite(v) || (cfg.log && v <= 0)) continue;
            ctx.fillStyle = g.col(s.color);
            ctx.strokeStyle = g.col('--sheet');
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(x, g.Y(v), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            tip.append(h('div', { class: 'tip-r' }, h('i', { style: `background:var(${s.color})` }), h('b', {}, cfg.yFmt(v, true)), h('span', {}, s.name)));
        }
        tip.hidden = false;
        const tw = tip.offsetWidth;
        tip.style.left = Math.max(0, x + 12 + tw > g.W ? x - 12 - tw : x + 12) + 'px';
        tip.style.top = g.pad.t + 'px';
    }

    box.addEventListener('pointermove', e => {
        if (!g) return;
        const r = box.getBoundingClientRect();
        cur = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - g.pad.l) / g.pw * (n - 1))));
        drawCursor();
    });
    box.addEventListener('pointerleave', () => { cur = -1; drawCursor(); });
    box.addEventListener('blur', () => { cur = -1; drawCursor(); });
    box.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = (e.shiftKey ? 20 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        cur = cur < 0 ? n - 1 : Math.max(0, Math.min(n - 1, cur + step));
        drawCursor();
    });
    new ResizeObserver(draw).observe(box);
    liveCharts.push(draw);
    return draw;
}

// ---------- symulacja i stres-testy
// seria benchmarku przeskalowana tak, by w dniu pierwszego notowania równała się wartości strategii
function rebase(values, ref) {
    const i = values.findIndex(v => v > 0);
    if (i < 0) return values;
    const k = ref[i] / values[i];
    return values.map(v => v > 0 ? v * k : NaN);
}

function parseDeposits(text) {
    return String(text || '').split(/\r?\n/).map(line => {
        const m = /^\s*(\d{4}-\d{2}-\d{2})\s+([\d\s.,]+?)\s*$/.exec(line);
        if (!m) return null;
        const amount = parseFloat(m[2].replace(/\s/g, '').replace(',', '.'));
        return amount > 0 ? { date: fromIso(m[1]), amount } : null;
    }).filter(Boolean);
}
function btInputs() {
    return { start: $('#bt-start').value, end: $('#bt-end').value, capital: $('#bt-capital').value, deposits: $('#bt-deposits').value };
}
async function backtestEngine(params) {
    const data = await historyData();
    return E.createEngine({ data, params: params || eng.params, settings: eng.settings });
}
function btConfig(e) {
    const raw = btInputs();
    lsSet('momentum.backtest', raw);
    const cal = e.calendar();
    return { start: fromIso(raw.start) || cal[Math.min(eng.params.momLong, cal.length - 1)], end: fromIso(raw.end), capital: Math.max(0, +raw.capital || 0), deposits: parseDeposits(raw.deposits) };
}

async function runBacktest() {
    const st = $('#bt-status');
    try {
        const e = await backtestEngine();
        if (!e.calendar().length) { st.textContent = 'Brak notowań do symulacji.'; return; }
        st.textContent = 'Liczę…';
        await new Promise(r => setTimeout(r, 20));
        const t0 = performance.now();
        BT = e.runBacktest(btConfig(e));
        BT.eng = e;
        renderBacktest();
        st.textContent = `Gotowe: ${plDate(BT.dates[0])} – ${plDate(BT.endDate)}, ${Math.round(performance.now() - t0)} ms.`;
    } catch (err) {
        st.textContent = 'Błąd: ' + err.message;
    }
}

async function runSensitivity() {
    const st = $('#bt-status');
    const host = h('div');
    try {
        const grid = [];
        for (const momMin of [10, 20, 30]) for (const slots of [3, 5, 7]) grid.push({ momMin, slots });
        const results = [];
        for (const [i, p] of grid.entries()) {
            st.textContent = `Analiza wrażliwości: ${i + 1}/${grid.length}…`;
            await new Promise(r => setTimeout(r, 10));
            const e = await backtestEngine({ ...eng.params, ...p });
            const r = e.runBacktest(btConfig(e));
            results.push({ ...p, s: E.perfStats(r.dates, r.twr) });
        }
        st.textContent = 'Analiza wrażliwości gotowa.';
        const cell = (m, k) => results.find(r => r.momMin === m && r.slots === k);
        host.append(panel('Analiza wrażliwości', 'CAGR / maksymalne obsunięcie dla innych progów momentum i liczby spółek w transzy',
            table(['Próg momentum', '>3 spółki', '>5 spółek', '>7 spółek'], [10, 20, 30].map(m => h('tr', { class: m === eng.params.momMin ? 'mark' : '' },
                h('td', {}, h('b', {}, `≥ ${m}`)),
                [3, 5, 7].map(k => { const c = cell(m, k).s; return td(`${pct(c?.cagr)} / ${pct(c?.mdd)}`, true); })))),
            h('p', { class: 'small muted', style: 'margin:12px 0 0' }, 'Stabilne wyniki w sąsiednich ustawieniach świadczą o tym, że strategia nie jest dopasowana do jednego zestawu parametrów.')));
        $('#bt-sens-out')?.remove();
        host.id = 'bt-sens-out';
        $('#bt-out').prepend(host);
    } catch (err) {
        st.textContent = 'Błąd: ' + err.message;
    }
}

function renderBacktest() {
    const out = $('#bt-out');
    out.replaceChildren();
    liveCharts = [];
    $('#bt-source').textContent = SOURCE.kind === 'repo' ? 'pełna historia z repozytorium (history.json)' : SOURCE.kind === 'none' ? '' : 'wczytane notowania';
    if (!BT) return;
    const res = BT;
    const st = E.perfStats(res.dates, res.twr), bs = E.perfStats(res.dates, res.bench);
    const b = eng.benchTicker() || 'Benchmark';
    const avgCash = res.cashPct.reduce((a, v) => a + v, 0) / res.cashPct.length;
    out.append(figures([
        ['Wartość końcowa', pln(res.value.at(-1)), `wpłaty ${pln(res.deposited)}`],
        ['CAGR strategii', pct(st?.cagr), `łącznie ${pct(st?.total, 0)}`],
        ['Maks. obsunięcie', pct(st?.mdd), `zmienność ${pct(st?.vol)}`],
        [`CAGR ${b}`, bs ? pct(bs.cagr) : '–', bs ? `obsunięcie ${pct(bs.mdd)}` : 'brak benchmarku'],
        ['Prowizje', pln(res.fees), `${res.trades.filter(x => x.side !== 'transfer').length} transakcji`],
        ['Średnio w gotówce', pct(avgCash), `${res.rebalances} rebalansów`],
    ]));

    const logCb = h('input', { type: 'checkbox', checked: true });
    const trCb = h('input', { type: 'checkbox' });
    const ext = res.extra.map(x => ({ ...x, rebased: rebase(x.values, res.twr) }));
    trCb.onclick = () => { if (trCb.checked) bmCb.checked = false; };
    const bmCb = h('input', { type: 'checkbox', checked: ext.length > 0, disabled: !ext.length, onclick: () => { if (bmCb.checked) trCb.checked = false; } });
    const chartHost = h('div'), ddHost = h('div');
    const hasBench = res.bench.some(Number.isFinite);
    let mainDraw = null;
    const drawMain = () => {
        const series = [{ name: 'Strategia', color: '--series-1', values: res.twr }];
        if (hasBench) series.push({ name: b, color: '--series-2', values: res.bench });
        if (bmCb.checked) ext.forEach((x, j) => series.push({ name: x.name, color: `--series-${j + 3}`, values: x.rebased, width: 1.5 }));
        if (trCb.checked) res.trTwr.forEach((v, k) => series.push({ name: `Transza ${k + 1}`, color: `--series-${k + 3}`, values: v, width: 1.5 }));
        liveCharts = liveCharts.filter(f => f !== mainDraw);
        mainDraw = lineChart(chartHost, { x: res.dates, series, log: logCb.checked, label: 'Wzrost wartości strategii na tle benchmarku', yFmt: (v, full) => nf(v, full ? 1 : 0) });
    };
    logCb.onchange = trCb.onchange = bmCb.onchange = drawMain;
    out.append(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' },
            h('h2', {}, 'Wzrost wartości'),
            h('div', { class: 'row', style: 'gap:18px' },
                h('label', { class: 'check small' }, logCb, 'Skala logarytmiczna'),
                h('label', { class: 'check small' }, bmCb, 'Benchmarki ETF'),
                h('label', { class: 'check small' }, trCb, 'Transze'))),
        h('div', { class: 'panel-body' }, h('p', { class: 'small muted', style: 'margin:0 0 12px' }, 'Indeks stopy zwrotu ważonej czasem, start = 100. Wpłaty nie zawyżają wyniku.'), chartHost)));
    drawMain();

    const ddSeries = [{ name: 'Strategia', color: '--series-1', values: E.drawdown(res.twr) }];
    if (hasBench) ddSeries.push({ name: b, color: '--series-2', values: E.drawdown(res.bench) });
    ext.forEach((x, j) => ddSeries.push({ name: x.name, color: `--series-${j + 3}`, values: E.drawdown(x.values), width: 1.5 }));
    out.append(panel('Obsunięcie od szczytu', null, ddHost));
    lineChart(ddHost, { x: res.dates, series: ddSeries, zeroTop: true, height: 220, label: 'Obsunięcie od szczytu', yFmt: (v, full) => pct(v, full ? 1 : 0) });

    const cmp = [{ name: b, values: res.bench }, ...ext].map(x => {
        const i0 = x.values.findIndex(v => v > 0);
        if (i0 < 0) return null;
        const d = res.dates.slice(i0), sS = E.perfStats(d, res.twr.slice(i0)), sB = E.perfStats(d, x.values.slice(i0));
        return h('tr', {}, h('td', {}, h('b', {}, x.name)), td(plDate(res.dates[i0])),
            td(pct(sB?.total), true), td(pct(sB?.cagr), true), td(pct(sB?.mdd), true),
            h('td', { class: 'num' }, h('b', {}, pct(sS?.cagr))), td(pct(sS?.mdd), true),
            td(Number.isFinite(sS?.cagr - sB?.cagr) ? nf((sS.cagr - sB.cagr) * 100, 1) + ' pp' : '–', true));
    }).filter(Boolean);
    out.append(panel('Porównanie z benchmarkami', 'każdy wiersz liczony od pierwszego notowania benchmarku w okresie symulacji, ceny w złotych',
        table(['Benchmark', 'Od', '>Wynik łącznie', '>CAGR', '>Obsunięcie', '>CAGR strategii', '>Obsunięcie strategii', '>Przewaga'], cmp),
        ext.length < 3 ? h('p', { class: 'small muted', style: 'margin:12px 0 0' }, 'Fundusze Vanguard pojawią się po dodaniu paczek Stooq dla Niemiec (d_de_txt) i walut (d_world_txt) i uruchomieniu npm run update.') : null));

    const crisisRows = E.CRISES.map(([name, from, to]) => {
        const w = E.windowStats(res, from, to);
        if (!w) return null;
        return h('tr', {}, h('td', {}, h('b', {}, name)), td(`${plDate(from)} – ${plDate(to)}`),
            td(pct(w.strategy?.total), true), td(pct(w.strategy?.mdd), true), td(pct(w.bench?.total), true), td(pct(w.bench?.mdd), true), td(pct(w.avgCash), true));
    }).filter(Boolean);
    if (crisisRows.length) {
        out.append(panel('Stres-test: okresy kryzysów', 'zachowanie strategii w historycznych spadkach',
            table(['Okres', 'Daty', '>Strategia', '>Obsunięcie', '>' + b, `>Obsunięcie ${b}`, '>Gotówka śr.'], crisisRows)));
    }

    const yr = E.yearlyReturns(res.dates, [res.twr, res.bench, ...res.trTwr, ...ext.map(x => x.values)]);
    const nTr = res.trTwr.length;
    out.append(panel('Stopy zwrotu w latach', 'pierwszy i ostatni rok mogą być niepełne',
        table(['Rok', '>Strategia', '>' + b, '>Różnica', ...res.trTwr.map((_, k) => `>T${k + 1}`), ...ext.map(x => '>' + x.t)], yr.map(r => h('tr', {},
            td(String(r.year)), h('td', { class: 'num' }, h('b', {}, pct(r.vals[0]))), td(pct(r.vals[1]), true),
            td(Number.isFinite(r.vals[1]) ? nf((r.vals[0] - r.vals[1]) * 100, 1) + ' pp' : '–', true),
            res.trTwr.map((_, k) => td(pct(r.vals[k + 2]), true)),
            ext.map((_, j) => td(pct(r.vals[2 + nTr + j]), true)))))));

    out.append(panel('Transze osobno', null,
        table(['Transza', 'Miesiące', '>CAGR', '>Obsunięcie', '>Wartość końcowa', 'Skład na koniec'], res.final.map((tr, k) => {
            const s = E.perfStats(res.dates, res.trTwr[k]);
            return h('tr', {}, h('td', {}, h('b', {}, `Transza ${k + 1}`)), td(monthsLabel(k)), td(pct(s?.cagr), true), td(pct(s?.mdd), true),
                td(pln(res.eng.trancheValue(tr, res.endDate)), true),
                td(Object.entries(tr.pos).map(([t, n]) => `${t} ${n}`).join(', ') || 'gotówka'));
        }))));

    out.append(panel(`Dziennik transakcji`, `${res.trades.length} pozycji`,
        table(['Data', 'Transza', 'Operacja', 'Spółka', '>Akcje', '>Kurs', '>Wartość', '>Prowizja'], res.trades.slice().reverse().map(x => h('tr', {},
            td(plDate(x.date)), td(`T${x.k + 1}`),
            h('td', { class: x.side === 'buy' ? 'side-buy' : x.side === 'sell' ? 'side-sell' : '' }, x.side === 'buy' ? 'KUP' : x.side === 'sell' ? 'SPRZEDAJ' : `nadwyżka → T${x.to + 1}`),
            h('td', {}, x.t ? tk(x.t) : ''), td(x.shares ? String(x.shares) : '', true), td(nf(x.price), true), td(nf(x.value), true), td(x.fee ? nf(x.fee) : '', true))), 'scroll')));
}

// ---------- parametry
const PARAM_UI = [
    ['momShort', 'Momentum: krótki okres (sesje)', 'int'],
    ['momLong', 'Momentum: długi okres (sesje)', 'int'],
    ['momMin', 'Minimalne momentum', 'num'],
    ['riseMax', 'Nie kupuj po wzroście większym niż (%)', 'num'],
    ['riseDays', 'Okres filtra wzrostu (sesje)', 'int'],
    ['slots', 'Maks. liczba spółek w transzy', 'int'],
    ['volDays', 'Okres zmienności (sesje)', 'int'],
    ['volMode', 'Miara zmienności', [['atr', 'ATR / kurs'], ['std', 'Odchylenie std. stóp zwrotu']]],
    ['weightMode', 'Wagi', [['st', 'Parytet ryzyka #ST (z-score, ±2)'], ['inv', 'Proste 1 / zmienność']]],
    ['zPop', 'Standaryzacja zmienności względem', [['top', 'spółek wybranych do transzy'], ['universe', 'całego uniwersum']]],
    ['commPct', 'Prowizja (%)', 'num'],
    ['commMin', 'Prowizja minimalna (zł)', 'num'],
    ['signalSession', 'Sygnał po sesji nr (transakcje na następnej)', 'int'],
    ['monthlyTranche', 'Czwarta transza rebalansowana co miesiąc', 'bool'],
    ['carryExcess', 'Nadwyżkę ponad równą część portfela przenoś do następnej transzy', 'bool'],
    ['riseFilterHeld', 'Filtr wzrostu stosuj też do spółek już trzymanych', 'bool'],
];
const PARAM_MIN = { momShort: 10, momLong: 10, riseDays: 1, slots: 1, volDays: 2, signalSession: 1, commPct: 0, commMin: 0 };

function renderParams() {
    const host = $('#params');
    host.replaceChildren();
    const P = eng.params;
    for (const [key, label, type] of PARAM_UI) {
        const changed = P[key] !== DEFAULT_PARAMS[key];
        const onchange = e => {
            let v;
            if (type === 'bool') v = e.target.checked;
            else if (Array.isArray(type)) v = e.target.value;
            else {
                v = type === 'int' ? Math.round(+e.target.value) : +e.target.value;
                if (!Number.isFinite(v) || v < (PARAM_MIN[key] ?? -Infinity)) v = DEFAULT_PARAMS[key];
                if (key === 'signalSession') v = Math.min(v, 17);
            }
            eng.configure({ params: { ...eng.params, [key]: v } });
            paramsChanged();
        };
        let input;
        if (type === 'bool') input = h('input', { type: 'checkbox', checked: P[key], onchange });
        else if (Array.isArray(type)) input = h('select', { onchange }, type.map(([v, l]) => h('option', { value: v, selected: P[key] === v }, l)));
        else input = h('input', { type: 'number', step: type === 'int' ? 1 : 'any', value: P[key], onchange });
        const text = h('span', {}, label, changed ? h('span', { class: 'status warn', style: 'margin-left:8px' }, `zmienione, w artykule: ${DEFAULT_PARAMS[key]}`) : null);
        host.append(type === 'bool' ? h('label', { class: 'check wide' }, input, text) : h('label', { class: 'field' }, text, input));
    }
}
function paramsChanged() {
    PLAN = null;
    saveState();
    renderParams();
    renderNotices();
    renderRanking();
    renderPortfolio();
}

// ---------- zakładki
function showTab(name) {
    if (!document.getElementById('tab-' + name)) name = 'portfel';
    document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== 'tab-' + name; });
    document.querySelectorAll('.nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    try { history.replaceState(null, '', '#' + name); } catch { /* file:// */ }
}

// ---------- start
async function init() {
    loadState();
    const bt = lsGet('momentum.backtest', null);
    $('#bt-start').value = bt?.start || '2010-01-04';
    $('#bt-end').value = bt?.end || '';
    $('#bt-capital').value = bt?.capital || 100000;
    $('#bt-deposits').value = bt?.deposits || '';
    $('#set-bench').value = eng.settings.bench;
    $('#set-universe').value = eng.settings.universe;

    document.querySelectorAll('.nav button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
    $('#an-date').onchange = e => {
        const cal = eng.calendar();
        ANALYSIS = cal[Math.max(0, lastIdx(cal, fromIso(e.target.value)))];
        e.target.value = iso(ANALYSIS);
        PLAN = null;
        renderRanking();
        renderPortfolio();
        renderDataStatus();
    };

    $('#in-files').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
    $('#in-dir').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
    const drop = $('#drop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); importFiles(e.dataTransfer.files); };
    $('#btn-demo').onclick = () => {
        const data = { series: E.makeDemo(), universe: null, demo: true };
        idb.set('data', data).catch(() => {});
        $('#in-status').textContent = 'Wczytano dane demonstracyjne.';
        setData(data, { kind: 'demo' });
    };
    $('#btn-repo').onclick = async () => {
        await idb.set('data', undefined).catch(() => {});
        $('#in-status').textContent = '';
        await loadData();
    };
    $('#set-bench').onchange = e => { eng.configure({ settings: { bench: e.target.value.trim().toUpperCase() } }); e.target.value = eng.settings.bench; saveState(); onDataChanged(); };
    $('#set-universe').onchange = e => { eng.configure({ settings: { universe: e.target.value } }); saveState(); onDataChanged(); };

    $('#dep-add').onclick = () => {
        const amt = Math.round(+$('#dep-amount').value * 100) / 100;
        if (!(amt > 0)) return;
        const target = $('#dep-target').value;
        if (target === 'all') {
            const n = nT(), part = Math.floor(amt / n * 100) / 100;
            active().forEach((tr, k) => { tr.cash += k === n - 1 ? amt - part * (n - 1) : part; });
            journal(`Wpłata ${pln(amt)} podzielona po równo na ${n} transze.`);
        } else {
            PF.tranches[+target].cash += amt;
            journal(`Wpłata ${pln(amt)} do transzy ${+target + 1}.`);
        }
        $('#dep-amount').value = '';
        savePF();
        renderPortfolio();
    };
    $('#pf-export').onclick = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(STATE, null, 2)], { type: 'application/json' }));
        const a = h('a', { href: url, download: `momentum-portfel-${iso(today())}.json` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $('#pf-import').onchange = async e => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
            const doc = JSON.parse(await f.text());
            applyState(doc.tranches ? { ...STATE, portfolio: doc } : doc);
            journal(`Zaimportowano portfel z pliku ${f.name}.`);
            saveState();
            renderAfterSettings();
        } catch {
            alert('Nie udało się odczytać pliku portfela.');
        }
    };
    $('#pf-reset').onclick = () => {
        if (!confirm('Wyzerować portfel (gotówkę, pozycje i dziennik)?')) return;
        PF = normalizePF(null);
        savePF();
        renderPortfolio();
    };
    $('#bt-run').onclick = runBacktest;
    $('#bt-sens').onclick = runSensitivity;
    $('#par-reset').onclick = () => { eng.configure({ params: DEFAULT_PARAMS }); paramsChanged(); };

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => liveCharts.forEach(f => f()));
    document.fonts?.ready.then(() => liveCharts.forEach(f => f()));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncPull(); });

    renderParams();
    renderAccount();
    showTab(location.hash.slice(1) || 'portfel');
    await loadData();
    S.init(user => { renderAccount(); if (user) syncPull(true); }).catch(e => setSync('err', e.message));
}
init();
})();
