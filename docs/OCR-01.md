# OCR-01 — lokalne rozpoznawanie zdjęć

## Implementacja w aplikacji

W dialogu **Dodaj treść → Zdjęcie** można uruchomić aparat (`capture=environment`) albo wybrać plik z galerii. Aplikacja przyjmuje pojedynczy JPEG, PNG lub WebP do 12 MB, dekoduje go lokalnie i ogranicza canvas do 2600 px dłuższej krawędzi. Obrazy powyżej 16 MP są odrzucane z czytelnym komunikatem; zwykła rozdzielczość aparatu jest zalecana. Podgląd pozwala sprawdzić zdjęcie przed naciśnięciem **Rozpoznaj tekst**. Tesseract.js 7.0.0 ładuje się dopiero na żądanie, z tym samym polskim modelem i przypiętymi adresami workera/core co prototyp Gate 0. Postęp oraz anulowanie są widoczne w dialogu; próba ma limit 90 sekund.

Wynik trafia do **edytowalnego** pola. Użytkownik poprawia go i wybiera **Czytaj tekst**. Zatwierdzony tekst wchodzi przez istniejące `renderSentences`, więc korzysta z dotychczasowej segmentacji, podświetlania, głosów Edge TTS, MOB-06, lokalnej biblioteki i historii. Historia zapisuje rzeczywiste odtwarzanie, nie samo rozpoznanie. Zapis IndexedDB obejmuje tekst, nazwę „Tekst ze zdjęcia” i dotychczasowe metadane dokumentu; aplikacja nie zapisuje ani nie wysyła pliku zdjęcia. Plik i podgląd są zwalniane po zamknięciu dialogu lub zmianie dokumentu. Token operacji i rewizja dokumentu blokują spóźnione wyniki po anulowaniu, zamknięciu dialogu i otwarciu innego dokumentu. Logika OCR mieści się w osobnym `ocr_prototype/app-ocr.js`; `main.py` dostarcza tylko dialog i przekazanie zatwierdzonego tekstu do istniejącego przepływu.

Pierwsza wersja obejmuje **jedno zdjęcie** i ręczną korektę. Jakość, szybkość i pamięć na Xiaomi 14T trzeba sprawdzić po wdrożeniu; testów automatycznych nie należy interpretować jako walidacji urządzenia. Wciąż dostępna jest diagnostyczna trasa `/ocr-probe` do pomiarów, lecz zwykły użytkownik korzysta z dialogu aplikacji. Biblioteka JS, worker i WASM są pobierane z jsDelivr, a polski model z hosta aplikacji. Przed produkcyjnym wymaganiem pełnego offline potrzebny jest self-hosting tych zasobów.

### Próba na Xiaomi 14T po wdrożeniu

1. W Chrome otwórz produkcyjną aplikację, wybierz **Dodaj treść → Zdjęcie → Zrób zdjęcie**. Powtórz ścieżkę z **Wybierz z galerii**. Użyj niesensytywnych próbek z polskimi znakami, jasnego i słabszego oświetlenia oraz układu z akapitami.
2. Sprawdź podgląd, komunikaty ładowania, postęp, anulowanie i ponowną próbę. Porównaj wynik z fotografią, popraw błędy w polu edycji i wybierz **Czytaj tekst**.
3. Sprawdź podświetlanie zdań, pauzę i wznowienie, zapis dokumentu w bibliotece oraz wpis w Historii po rozpoczęciu odtwarzania. Zweryfikuj ponowne otwarcie dokumentu po odświeżeniu strony.
4. Zanotuj czas, użycie pamięci widoczne w narzędziach telefonu, błędy polskich znaków i kolejność akapitów. Test jakości na urządzeniu jest odrębny od automatycznych testów regresyjnych.

## Pierwotny punkt kontrolny Gate 0

Izolowany prototyp pomiarowy pod `/ocr-probe` powstał przed włączeniem OCR do aplikacji. Jakość i czas na Xiaomi 14T Chrome nadal są niezmierzone. Ta trasa służy do szczegółowych pomiarów cold/warm i CER/WER; nie zastępuje zwykłej ścieżki w aplikacji.

## Technologia i rozmiar

- Tesseract.js `7.0.0` i tesseract.js-core `7.0.0`, przypięte adresami jsDelivr. Biblioteka tworzy Web Worker, który ładuje WASM. [Tesseract.js](https://github.com/naptha/tesseract.js/releases/tag/v7.0.0), [core](https://github.com/naptha/tesseract.js-core/releases/tag/v7.0.0).
- Metadane npm `dist.unpackedSize` dla tych wersji: Tesseract.js **1 411 341 bajtów**, core **45 262 431 bajtów** (rozmiary pełnych rozpakowanych paczek, a nie transfer do jednej sesji). W przeglądarce core dobiera wariant WASM; rzeczywisty transfer wymaga pomiaru na urządzeniu.
- Polski model `pol` pochodzi z [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast). Plik w repozytorium `ocr_prototype/pol.traineddata.gz` jest deterministycznie skompresowaną kopią `pol.traineddata`, pobraną 15.11.2026 z oficjalnego repozytorium. Rozmiar na dysku: **2 026 921 bajtów**; SHA-256: `ffeedad4581eb8fdfcd7a6ad8c8103354fc7b70c8f01c611c8c1e7f93a56cf82`. Nieskompresowany plik miał 4 765 518 bajtów. Model ładuje się z tego samego hosta co aplikacja. Rozmiar całego transferu JS/worker/core/WASM i zachowanie cache trzeba zmierzyć w Chrome na telefonie; prototyp nie zgaduje tych liczb.
- Tesseract.js, core i `tessdata_fast` są objęte Apache 2.0; pełne licencje są w ich repozytoriach. Kod workera i silnika jest pobierany z CDN, co tworzy połączenie telefonu z jsDelivr. Przed włączeniem produkcyjnym trzeba ocenić self-hosting tych plików i integralność łańcucha dostaw. [Instalacja lokalna Tesseract.js](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [licencja modelu](https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE).

## Prywatność i ograniczenia prototypu

Zdjęcie jest dekodowane przez `createImageBitmap` i rysowane na lokalnym canvasie. Kod prototypu nie wywołuje `/upload` ani zewnętrznego OCR API; nie zapisuje zdjęcia w IndexedDB i nie eksportuje zdjęcia, nazwy pliku, transkrypcji ani wyniku OCR. Eksport JSON zawiera tylko kategorię próbki, wymiary, czasy i miary błędów. Referencję i wynik należy wpisywać wyłącznie dla niesensytywnych próbek. Zależność z CDN wykonuje kod w przeglądarce, więc samo przypięcie wersji nie daje gwarancji wobec kompromitacji CDN. Obecny Edge TTS nadal wysyła zatwierdzony tekst sieciowo w istniejącej aplikacji.

Progi **12 MB pliku, 16 MP źródła, 2600 px dłuższej krawędzi canvasu, 90 s na próbę** służą ochronie pamięci w prototypie. Nie są jeszcze zweryfikowanymi limitami dla Xiaomi. Obsługę JPEG/PNG/WebP rozstrzyga rzeczywiste dekodowanie; HEIC/HEIF nie jest deklarowany jako obsługiwany. Opcja skali szarości pozwala porównać preprocessing z oryginałem bez nadpisywania pliku.

## Dodatkowy pomiar Gate 0 na Xiaomi 14T

1. Jeśli potrzebny jest szczegółowy pomiar, otwórz HTTPS `/ocr-probe` po wdrożeniu lub w zatwierdzonym podglądzie. W Chrome zanotuj wersję przeglądarki, Androida i warunki sieci.
2. Przygotuj **12–20 niesensytywnych** obrazów z ręczną transkrypcją: wydruk A4, polskie znaki, screenshot, dwie kolumny, nagłówki/listy, drobny druk, kąt/obrót, słabe światło i rozmycie. Co najmniej trzy trudne przypadki.
3. Dla każdej próbki wybierz kategorię i **inne zdjęcie**, uruchom OCR, wklej właściwą dla niego referencję, kliknij **Przelicz błędy**. W jednej otwartej karcie pierwszy odczyt po uruchomieniu workera jest `cold`, kolejne zdjęcia przy zachowanym workerze są `warm` (`workerReused=true`). Zmiana zdjęcia po zakończonym OCR nie zwalnia workera; gdy poprzednie rozpoznawanie jeszcze trwa, zostaje anulowane, worker zwolniony, a następna próba znów będzie `cold`. Przycisk **Anuluj i zwolnij model** również resetuje workera. Porównaj co najmniej kilka obrazów w skali szarości i bez niej; każdy wariant ma osobny wpis. Referencja czyści się przy wyborze zdjęcia, aby nie przypisać miar do niewłaściwego obrazu.
4. Sprawdź ręcznie polskie znaki, akapity i kolejność czytania, zwłaszcza przy dwóch kolumnach. Zapisz obserwacje osobno bez prywatnych treści. Zwróć uwagę na zawieszenie UI i przeładowanie karty. Eksportuj JSON bez tekstu i zdjęć.
5. W Chrome DevTools lub monitorze ruchu zanotuj pierwszy transfer biblioteki, workera, core/WASM i modelu oraz zachowanie cache przy ponownym otwarciu. `cold` oznacza nowego workera, **nie** zimny cache sieciowy. Osobne pole `networkCache` raportuje zaobserwowany transfer modelu (`network-transfer-observed` lub `browser-cache-observed`), brak widocznego wpisu (`not-observed`) albo brak żądania przy zachowanym workerze (`worker-reused-no-fetch`). Brak wpisu może oznaczać m.in. cache IndexedDB Tesseract; nie dowodzi braku transferu wszystkich zasobów. Do porównania cold network otwórz nową kartę po wyczyszczeniu właściwego cache i zanotuj to poza JSON. `performance.memory` w raporcie jest tylko przybliżonym heapem JS i nie obejmuje wiarygodnie całej pamięci workera/WASM.

CER i WER liczone są po normalizacji Unicode NFC, małych liter i białych znaków. Obliczenie odbywa się w osobnym, lokalnym Web Workerze (`metrics-worker.js`); ma limit 5000 znaków na tekst, 4 mln porównywanych komórek i 15 s. Przekroczenie limitu daje jawne `scoreError` zamiast blokady interfejsu. Puste referencje nie są punktowane. Miar tych nie należy traktować jako oceny układu akapitów ani kolejności kolumn — sprawdź je ręcznie. Każda próba ma identyfikator zdjęcia w kolejności wyboru (bez nazwy pliku), wariant, status i kod błędu. Eksport nie zawiera treści tekstu ani obrazu. Orientacyjny cel porównawczy z Issue #14 to mediana warm OCR czytelnej strony około **15 s** i szybka ręczna korekta. Wynik Xiaomi nadal jest nieznany.

## Wcześniejsza ocena izolowanego podglądu HTTPS na Render

Review PR #15 odnotował, że produkcyjny AudioReaderApp śledzi `main`, a podglądy PR są wyłączone. Sama gałąź nie ma obecnie potwierdzonego adresu HTTPS. Render obsługuje osobne [podglądy pojedynczych usług](https://render.com/docs/service-previews.md) z własnym adresem TLS oraz [osobne serwisy Free](https://render.com/docs/free.md), lecz ich utworzenie lub włączenie może używać limitów i generować koszty. Podgląd PR dziedziczy ustawienia serwisu bazowego, w tym zmienne środowiskowe, dlatego wymaga ich przeglądu przed uruchomieniem. Nie zmieniono ustawień produkcyjnego serwisu ani nie uruchomiono podglądu.

Wariant do zatwierdzenia: osobny Web Service na gałęzi `feat/ocr-01-photo-local`, plan Free **$0/mies.** w ramach dostępnych 750 godzin instancji na workspace i limitów transferu oraz minut builda. Po ich przekroczeniu Render może naliczyć opłaty albo zawiesić usługę zależnie od metody płatności. Alternatywa płatna `0.5c-512mb` to **$7/mies.**, naliczane proporcjonalnie do czasu działania; podgląd PR kosztuje tyle co plan bazowy. [Cennik](https://render.com/pricing), [limity Free](https://render.com/docs/free.md). Przed decyzją trzeba sprawdzić w Dashboard bieżący plan, zużycie i ustawienia rozliczeń. Żadnej usługi nie utworzono. Link testowy można podać dopiero po rzeczywistym wdrożeniu i weryfikacji `/ocr-probe`.

## Weryfikacja lokalna

- `python -m unittest discover -s tests -v` — regresje aplikacji i izolacji route/modelu.
- W powyższym zestawie: integracja OCR z dialogiem, edycją, zapisem i historią, anulowanie i spóźnione wyniki, awaria CDN oraz regresje MOB-06/UX/UI.
- `node tests/ocr_probe.test.cjs` — CER/WER, limity, zachowanie workera między zdjęciami, anulowanie aktywnej próby, spóźniony wynik i brak wywołania `/upload`.
- `git diff --check`.

Nie uruchamiano OCR na Xiaomi ani nie wykonywano pomiarów CER/WER, czasu lub pamięci urządzenia. Implementacja w aplikacji wymaga weryfikacji po wdrożeniu.
