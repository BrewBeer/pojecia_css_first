# Momentum GPW

Aplikacja do prowadzenia portfela IKZE według strategii momentum z systemtrader.pl:
WIG140, trzy transze rebalansowane co kwartał, ranking z regresji wykładniczej i parytet ryzyka.

| Plik | Rola |
|---|---|
| `../momentum.html` | aplikacja (otwierana z GitHub Pages) |
| `engine.js` | reguły strategii: ranking, wagi, plan rebalansu, symulacja |
| `app.js`, `app.css` | interfejs |
| `sync.js`, `config.js` | synchronizacja portfela przez Supabase |
| `scripts/update-data.mjs` | przetwarzanie paczki Stooq i wyznaczanie składu WIG140 |
| `data/live.json`, `data/history.json` | notowania dla aplikacji (generowane) |
| `data/wig140.txt` | opcjonalna oficjalna lista WIG140 (nadpisuje przybliżenie) |
| `test/` | testy jednostkowe, scenariusze, stres-testy, backtest na historii |

## Cotygodniowa aktualizacja danych

Stooq blokuje automatyczne pobieranie, więc paczkę pobierasz ręcznie w przeglądarce, a resztę robi skrypt.

1. Na [stooq.pl/db/h](https://stooq.pl/db/h/) pobierz dane dzienne dla Polski w formacie ASCII (`d_pl_txt.zip`).
2. Zostaw plik w folderze projektu albo w Pobranych.
3. Uruchom:

   ```
   npm run update -- --push
   ```

Skrypt rozpakuje paczkę, wyznaczy kwartalny skład WIG140 i zapisze dane do `momentum/data/`. Potem uruchomi testy, zrobi commit i push. GitHub Actions jeszcze raz uruchomi testy i opublikuje stronę.

Skład WIG140 jest przybliżony rankingiem kapitalizacji i rocznych obrotów, bo w danych Stooq nie ma free floatu, którego używa GPW. Bieżące przybliżenie zapisuje się w `data/wig140-auto.txt`. Żeby użyć oficjalnego składu z GPW Benchmark (indeks WIG140, ISIN PL9999998377), wklej tickery do `data/wig140.txt`.

## Synchronizacja portfela (Supabase)

1. Załóż projekt na [supabase.com](https://supabase.com) (wystarczy plan darmowy).
2. W **SQL Editor** uruchom `supabase/schema.sql`. Tworzy tabelę `portfolios` z Row Level Security, więc każdy użytkownik widzi tylko swój portfel.
3. W **Authentication → URL Configuration** wpisz adres strony z GitHub Pages jako Site URL.
4. Z **Project Settings → API** skopiuj *Project URL* i klucz *anon public* do `config.js`, a potem zrób commit i push. Klucz anon jest jawny z założenia.
5. Na stronie kliknij **Zaloguj** i załóż konto e-mailem. Po potwierdzeniu adresu portfel, parametry i dziennik synchronizują się między urządzeniami.

## Publikacja (GitHub Pages)

W ustawieniach repozytorium wybierz **Settings → Pages → Source: GitHub Actions**. Workflow `.github/workflows/momentum.yml` publikuje stronę po każdym pushu na `main`, pod warunkiem że testy przeszły. Aplikacja będzie pod adresem `https://<użytkownik>.github.io/<repo>/momentum.html`. Pages w darmowym planie GitHuba wymaga publicznego repozytorium. Notowania są wtedy publiczne, ale portfel zostaje prywatny w Supabase.

## Testy

```
npm test                 # wszystkie (ok. 3 s)
npm run test:history     # tylko backtest i stres-testy na historii GPW, z raportem
```

- `engine.test.js`: momentum, kalendarz GPW, import, wagi, filtry, zlecenia, nadwyżka.
- `backtest.test.js`: scenariusze o znanym wyniku (trend, bessa, harmonogram, wpłaty, zmiana składu indeksu, determinizm).
- `stress.test.js`: krach -40%, delisting, zawieszenie notowań, złe dane, skrajne kwoty, 25 losowych rynków.
- `history.test.js`: pełna historia od 2010, okresy kryzysów i wrażliwość na parametry.
