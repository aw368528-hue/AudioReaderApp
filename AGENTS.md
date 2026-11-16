# AudioReader AI — stałe instrukcje dla lokalnego agenta programistycznego

**Zakres:** repozytorium `AudioReaderApp`. Te instrukcje mają zastąpić powtarzanie całego regulaminu w każdym zadaniu. Treść konkretnego Issue/polecenia określa **co** zrobić, a ten plik **jak** pracować.

## 1. Kontekst przed rozpoczęciem pracy

1. Przeczytaj `PRODUCT.md` (wizja i fundamentalne ustalenia) oraz `STATE.md` (ostatni zapisany stan i priorytety), jeśli znajdują się w repozytorium.
2. Sprawdź faktyczny stan `git status`, bieżącą gałąź, kod i dokumentację bez zakładania, że opisy w `STATE.md` są aktualne.
3. Przeczytaj pełny zakres konkretnego zadania i potrzebne pliki modułowe w `docs/`, np. OCR/TXT/MOB/UX.
4. **Jeśli wymagana dokumentacja nie istnieje lub jest niespójna**, zgłoś lukę. Nie wymyślaj ustaleń ani nie zastępuj celu projektu własną interpretacją.

## 2. Nadrzędne granice projektowe

- AudioReader AI jest budowany przede wszystkim **na użytek właściciela**. Komercjalizacja jest jedynie ewentualną możliwością na przyszłość, nie priorytetem aktualnych zadań.
- **Natywny Android jest platformą docelową.** Obecna PWA to sprawdzana implementacja przejściowa, a nie automatycznie zmieniona wizja. Nie zastępuj jej celem „pozostać web/PWA” ani samym WebView bez świadomej decyzji właściciela.
- Jeśli polecenie albo nowa propozycja istotnie zmienia wcześniejsze założenia, **nazwij konflikt i konsekwencje** przed wykonaniem. Nie podejmuj samodzielnie decyzji strategicznej.
- Analiza alternatywy nie oznacza zgody na jej wdrożenie. Supertonic jest zamrożony do osobnej decyzji.

## 3. Zasady implementacji

- Pracuj tylko w zatwierdzonym zakresie zadania; nie dodawaj „przy okazji” nowych funkcji, migracji, kont, płatności, analityki ani przepisania architektury.
- Zawsze preferuj najprostsze poprawne rozwiązanie. Nie dodawaj niepotrzebnych abstrakcji, zależności ani komplikacji; nie upraszczaj kosztem bezpieczeństwa i poprawności.
- Zanim zmienisz moduł, poznaj jego kontrakty, testy i zależności. **Rzeczywisty kod** rozstrzyga, co działa; `PRODUCT.md` rozstrzyga, do czego dążymy; `STATE.md` opisuje ostatni znany stan.
- Zachowuj istniejące dane użytkownika, kompatybilność bibliotek i postępu odsłuchu; każda migracja wymaga testów. Unikaj resetów IndexedDB/localStorage bez jawnej zgody.
- Nie loguj tekstu dokumentów, zdjęć, sekretów, treści wysyłanych do TTS ani prywatnych danych w raportach diagnostycznych.
- Nie nadpisuj niezwiązanych lokalnych zmian, nie porządkuj masowo repozytorium i nie usuwaj plików użytkownika bez zgody.
- Zmiana głosu/tempa i odtwarzania wymaga sprawdzenia anulowania żądań, bufora, pauzy/wznowienia i postępu. OCR wymaga sprawdzenia przypadków anulowania, błędów, edycji i pamięci.
- Nie obiecuj pracy offline, prywatności end-to-end ani natywności Androida, jeżeli implementacja tego nie zapewnia.

## 4. Git, testy i dostarczanie zmian

- Nie wdrażaj ani nie scalaj zmian samodzielnie. Pracuj na osobnej gałęzi od odpowiedniej uzgodnionej bazy; przygotuj PR do przeglądu, chyba że konkretne zadanie stanowi inaczej.
- Sprawdź `git status` przed i po pracy. Nie rób force push ani operacji destrukcyjnych bez osobnej zgody.
- Podstawowa komenda testów obecnej implementacji to `python -m unittest discover -s tests -v`. Test Python przekazuje kod strony do `tests/reader.test.cjs` przez standardowe wejście; nie uruchamiaj tego pliku samodzielnie przez `node --test`. Dodatkowo stosuj odpowiednie `node --check ocr_prototype/app-ocr.js`, `node --check tests/reader.test.cjs` i `git diff --check` (dostosuj do aktualnych plików; nie zgaduj sukcesu).
- Gdy Xiaomi 14T jest podłączony i dostępny przez ADB, po zmianach samodzielnie wykonuj odpowiednie testy urządzeniowe na zmienionej wersji, nie tylko na produkcyjnej. Korzystaj z najprostszej dostępnej automatyzacji. Oddziel sprawdzenia automatyczne od tych wymagających ludzkiej oceny; gdy test jest niemożliwy, zgłoś konkretną przeszkodę. Nie resetuj telefonu ani nie usuwaj jego danych bez zgody.
- Podaj konkretne wyniki: liczby testów i błędy, pliki zmienione, gałąź, commit/PR, rzeczy niezweryfikowane oraz procedurę ręcznego sprawdzenia na Xiaomi 14T.
- Odróżniaj **testy automatyczne**, **wdrożenie Render** i **test manualny na telefonie**. Jeden nie potwierdza automatycznie drugiego.

### Test rzeczywistej przeglądarki

- Po zmianach interfejsu, JavaScript, stanu zapisywanego w przeglądarce albo przepływu użytkownika uruchom `python tests/browser_app.py --browser edge` na Windows. Skrypt startuje lokalny serwer z **bieżącego kodu** i steruje prawdziwym Edge (Chromium) przez Playwright. Dla zainstalowanego Chrome użyj `--browser chrome`; dla Chromium `--browser chromium`. Playwright jest zależnością wyłącznie developerską: `python -m pip install --user playwright`; wariant Chromium wymaga też `python -m playwright install chromium`.
- Gdy Xiaomi 14T jest dostępny w `adb devices -l`, uruchom również `python tests/browser_app.py --android`. Skrypt uruchamia Chrome, jeśli trzeba, i łączy się przez ADB forward oraz Chrome DevTools Protocol; ADB reverse udostępnia lokalny serwer telefonowi. Przy kilku urządzeniach dodaj `--serial <numer>`. Na Windows ADB może być w `C:\Users\aw368\AppData\Local\Android\Sdk\platform-tools\adb.exe` poza `PATH`. Test otwiera i zamyka własną kartę na lokalnym adresie; nie resetuj telefonu ani nie usuwaj danych.
- Do obu komend można dodać `--artifacts <katalog>`. Wynik `result.json` zawiera PASS/FAIL i błędy; `server.log` zawiera log lokalnego serwera, a `screen.png` zrzut interfejsu. Skrypt zbiera wyjątki JavaScript, błędy konsoli, nieudane żądania i odpowiedzi HTTP co najmniej 400 (z wyjątkiem nieistniejącego favicon). Bez `--artifacts` zapisuje pliki w katalogu tymczasowym i wypisuje ścieżkę. Nie dołączaj do raportów prywatnych dokumentów ani treści TTS.
- PASS potwierdza tylko faktycznie wykonane asercje skryptu. Po zmianie funkcji dodaj do testu właściwe kroki i asercje, a następnie wykonaj go na zmienionej wersji. Odsłuch, jakość głosu, wygoda obsługi, działanie przy zablokowanym ekranie i inne oceny zmysłowe wymagają osobnego testu ręcznego właściciela. Raportuj osobno wyniki automatyczne i ręczne; przy błędzie podaj etap, komunikat, ścieżki diagnostyki i konkretną przeszkodę środowiskową. Nigdy nie deklaruj zaliczenia testu, którego nie uruchomiono.

## 5. Komunikacja i aktualizacja stanu

- Raportuj krótko i rzeczowo: **co zrobiono → co sprawdzono → co pozostało → czy potrzebna decyzja właściciela**. Nie powtarzaj w raporcie całego tego pliku.
- Po wykonaniu zaakceptowanego zadania zaproponuj aktualizację `STATE.md` o rzeczywisty wynik i identyfikatory. Nie aktualizuj nadrzędnej wizji `PRODUCT.md` na podstawie samego eksperymentu lub pomysłu.
- Jeśli rozpoczęto pracę w innym środowisku agenta (które nie wczytuje `AGENTS.md` automatycznie), najpierw zapewnij mu dostęp do niniejszych instrukcji. Powtarzanie ich w każdym promptcie nie jest właściwym zastępstwem konfiguracji.

## 6. Źródła informacji

- Wymagania produktu: `PRODUCT.md`.
- Aktualna migawka projektu: `STATE.md` (weryfikowana względem bieżącego repo).
- Szczegóły implementacji: aktualny kod, testy i modułowa dokumentacja `docs/`.
- Zakres konkretnego zadania: wskazane Issue / polecenie użytkownika.
- Ostateczne decyzje zmieniające wizję i zakres: właściciel projektu.
