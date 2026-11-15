# OCR-01 — punkt kontrolny Gate 0

## Stan i decyzja

Gałąź zawiera izolowany prototyp pomiarowy pod `/ocr-probe`. Nie dodaje jeszcze opcji **Zdjęcie** do panelu **Dodaj treść** ani nie przekazuje OCR do Lektora. Jakość i czas na Xiaomi 14T Chrome są niezmierzone, więc decyzja o pełnej implementacji OCR-01 wymaga testu urządzeniowego. Nie wolno traktować przejścia testów Python/JS jako wyniku tego testu.

## Technologia i rozmiar

- Tesseract.js `7.0.0` i tesseract.js-core `7.0.0`, przypięte adresami jsDelivr. Biblioteka tworzy Web Worker, który ładuje WASM. [Tesseract.js](https://github.com/naptha/tesseract.js/releases/tag/v7.0.0), [core](https://github.com/naptha/tesseract.js-core/releases/tag/v7.0.0).
- Metadane npm `dist.unpackedSize` dla tych wersji: Tesseract.js **1 411 341 bajtów**, core **45 262 431 bajtów** (rozmiary pełnych rozpakowanych paczek, a nie transfer do jednej sesji). W przeglądarce core dobiera wariant WASM; rzeczywisty transfer wymaga pomiaru na urządzeniu.
- Polski model `pol` pochodzi z [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast). Plik w repozytorium `ocr_prototype/pol.traineddata.gz` jest deterministycznie skompresowaną kopią `pol.traineddata`, pobraną 15.11.2026 z oficjalnego repozytorium. Rozmiar na dysku: **2 026 921 bajtów**; SHA-256: `ffeedad4581eb8fdfcd7a6ad8c8103354fc7b70c8f01c611c8c1e7f93a56cf82`. Nieskompresowany plik miał 4 765 518 bajtów. Model ładuje się z tego samego hosta co aplikacja. Rozmiar całego transferu JS/worker/core/WASM i zachowanie cache trzeba zmierzyć w Chrome na telefonie; prototyp nie zgaduje tych liczb.
- Tesseract.js, core i `tessdata_fast` są objęte Apache 2.0; pełne licencje są w ich repozytoriach. Kod workera i silnika jest pobierany z CDN, co tworzy połączenie telefonu z jsDelivr. Przed włączeniem produkcyjnym trzeba ocenić self-hosting tych plików i integralność łańcucha dostaw. [Instalacja lokalna Tesseract.js](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [licencja modelu](https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE).

## Prywatność i ograniczenia prototypu

Zdjęcie jest dekodowane przez `createImageBitmap` i rysowane na lokalnym canvasie. Kod prototypu nie wywołuje `/upload` ani zewnętrznego OCR API; nie zapisuje zdjęcia w IndexedDB i nie eksportuje zdjęcia, nazwy pliku, transkrypcji ani wyniku OCR. Eksport JSON zawiera tylko kategorię próbki, wymiary, czasy i miary błędów. Referencję i wynik należy wpisywać wyłącznie dla niesensytywnych próbek. Zależność z CDN wykonuje kod w przeglądarce, więc samo przypięcie wersji nie daje gwarancji wobec kompromitacji CDN. Obecny Edge TTS nadal wysyła zatwierdzony tekst sieciowo w istniejącej aplikacji.

Progi **12 MB pliku, 16 MP źródła, 2600 px dłuższej krawędzi canvasu, 90 s na próbę** służą ochronie pamięci w prototypie. Nie są jeszcze zweryfikowanymi limitami dla Xiaomi. Obsługę JPEG/PNG/WebP rozstrzyga rzeczywiste dekodowanie; HEIC/HEIF nie jest deklarowany jako obsługiwany. Opcja skali szarości pozwala porównać preprocessing z oryginałem bez nadpisywania pliku.

## Instrukcja pomiaru na Xiaomi 14T

1. Otwórz HTTPS `/ocr-probe` z gałęzi testowej lub podglądu PR. Nie używaj produkcyjnego deploymentu. W Chrome zanotuj wersję przeglądarki, Androida i warunki sieci.
2. Przygotuj **12–20 niesensytywnych** obrazów z ręczną transkrypcją: wydruk A4, polskie znaki, screenshot, dwie kolumny, nagłówki/listy, drobny druk, kąt/obrót, słabe światło i rozmycie. Co najmniej trzy trudne przypadki.
3. Dla każdej próbki wybierz kategorię i zdjęcie, uruchom OCR, wklej referencję, kliknij **Przelicz błędy**. Pierwszy odczyt jest *cold*, kolejne przy zachowanym workerze są *warm*. Porównaj co najmniej kilka obrazów w skali szarości i bez niej; wybierz plik ponownie, jeśli zmieniasz wariant.
4. Sprawdź ręcznie polskie znaki, akapity i kolejność czytania, zwłaszcza przy dwóch kolumnach. Zapisz obserwacje osobno bez prywatnych treści. Zwróć uwagę na zawieszenie UI i przeładowanie karty. Eksportuj JSON bez tekstu i zdjęć.
5. W Chrome DevTools lub monitorze ruchu zanotuj pierwszy transfer biblioteki, workera, core/WASM i modelu oraz zachowanie cache przy ponownym otwarciu. `performance.memory` w raporcie jest tylko przybliżonym heapem JS i nie obejmuje wiarygodnie całej pamięci workera/WASM.

CER i WER liczone są po normalizacji Unicode NFC, małych liter i białych znaków. Długość referencji/wyniku do obliczeń ograniczono do 5000 znaków, aby obliczenie nie zawiesiło telefonu. Orientacyjny cel decyzyjny z Issue #14 to mediana warm OCR czytelnej strony około **15 s** i szybka ręczna korekta. Bez wyników Xiaomi nie ma potwierdzenia wykonalności.

## Weryfikacja lokalna

- `python -m unittest discover -s tests -v` — regresje aplikacji i izolacji route/modelu.
- `node tests/ocr_probe.test.cjs` — funkcje CER/WER oraz brak wywołania `/upload` w prototypie.
- `git diff --check`.

Nie uruchamiano OCR na Xiaomi ani nie wykonywano pomiarów CER/WER, czasu lub pamięci urządzenia. Zatrzymanie na Gate 0 zapobiega wdrożeniu niesprawdzonej jakości do istniejącego Lektora.
