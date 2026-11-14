# MOB-03A — kontrolowany bufor i diagnostyka

Baza: `e5e037dcf21101196cff8102daa6db553a68dabd` (TXT-01 i TXT-02).
Gałąź PR: `fix/mob-03-audio-buffer-v2`. Bez merge ani wdrożenia.

Poprzednia, nieukończona implementacja pozostała bez zmian w osobnym worktree
`/workspace/AudioReaderApp`, na `fix/mob-03-audio-buffer`. Integrację wykonano
w `/workspace/AudioReaderApp-mob03a`. Konflikty dotyczyły miejsca dawnego
clearAudioCache oraz dopisywanych testów; zachowano segmentację i jej regresje.

## Zachowanie

- Standardowy adres: bufor dwóch następnych fragmentów, bez panelu i diagnostyki.
- `?buffer=0`: awaryjne wyłączenie prefetch bez włączania diagnostyki.
  Brak parametru, `buffer=2` lub inna wartość pozostawia domyślny bufor dwóch.
- `?test=1&buffer=0`: pomiary, przygotowanie fragmentu dopiero po końcu poprzedniego.
- `?test=1&buffer=2`: pomiary i przygotowanie maksymalnie dwóch następnych
  fragmentów podczas bieżącego odczytu. Samo `?buffer=2` nie włącza testu.
- Panel pozwala przełączyć bufor bez zmiany kodu. Przełączenie zatrzymuje
  bieżącą sesję i czyści cache; ▶ wznawia od początku bieżącego fragmentu.
- W obu trybach działa nowa kolejka i ograniczenie cache. Buffer=0 to punkt
  odniesienia bez prefetch, a nie dosłownie stary kod bez limitów pamięci.
- Pojedyncza kolejka obejmuje fetch i odbieranie body. Priorytet ma bieżący
  fragment; dołącza do już trwającego przygotowania, zamiast je powielać.
  Rozpoczętego żądania nie przerywamy wyłącznie w celu zmiany priorytetu.
- Blokada kolejki pozostaje do rozstrzygnięcia anulowanego żądania, także
  podczas stop/start, zmiany pozycji, dokumentu, głosu lub tempa. Stare
  odpowiedzi i zdarzenia nie mogą odtworzyć ani zatrzymać nowego fragmentu.
- Pauza nie odtwarza pobranego audio. Trwające pobieranie może się zakończyć;
  kolejne spekulacyjne pobrania czekają do wznowienia. Bieżące przygotowanie
  i jego ograniczone próby mogą zakończyć się podczas pauzy.

## Zabezpieczenia MOB-02

Backend /tts, limity czasu i klasyfikacja błędów pozostały bez zmian.
Frontend zachowuje najwyżej trzy próby na cykl syntezy fragmentu, wspólny cooldown,
Retry-After w sekundach lub dacie i zakaz automatycznego ponawiania jawnego
odrzucenia dostawcy. Odstępy bazowe wynoszą 3 i 8 s; no_audio z backendu
wymaga przynajmniej 10 s. Cooldown przetrwa zatrzymanie i ręczne wznowienie.

Prefetch wykonuje jedną próbę. Błąd wstrzymuje dalsze spekulacyjne pobieranie,
ale nie przerywa odtwarzanego audio. Gdy fragment stanie się bieżący, dziedziczy
licznik prób, błąd i cooldown. Po trzecim niepowodzeniu pozycja zostaje zachowana,
a status wskazuje możliwość ponowienia przyciskiem ▶. Dopiero jawne rozpoczęcie
nowej sesji daje nowy budżet; nie ma nieskończonego automatycznego restartu.
Puste fragmenty są pomijane bez żądania TTS.

## Pamięć

Cache obejmuje maksymalnie 3 pliki (bieżący + 2 przyszłe) i 8 MiB danych blob.
URL przypięty do odtwarzacza jest chroniony. Po zakończeniu, zmianie pozycji lub
stop najpierw odłączamy src, potem zwalniamy URL. Usuwane są też niepotrzebne
zadania i ich tekstowe referencje. Diagnostyka ma limit 2000 zdarzeń i 2000
próbek przerw; raport podaje liczbę odrzuconych starszych wpisów.

Gdy bufor nie pomieści przyszłego audio, nie zachowuje go i wstrzymuje prefetch.
Po zwolnieniu miejsca może być potrzebne ponowne pobranie. Poprawne audio
kończy cykl prób także wtedy, gdy nie mieści się w cache; nowa synteza po
nietrafieniu w cache dostaje nowy budżet. Same błędy ani przekazanie zadania
z prefetch do odtwarzania nie odnawiają budżetu. Plik większy niż 8 MiB jest odrzucany z czytelnym komunikatem,
bez automatycznych ponowień. Nie tniemy ani nie usuwamy tekstu.
Limit dotyczy zachowanych blobów, nie całej pamięci Chrome: w trakcie odbierania
body występuje dodatkowy blob, dekoder ma własną pamięć, a tekst i DOM dokumentu
pozostają w pamięci. Nie gwarantujemy pełnego przygotowania dwóch plików przy
każdym rozmiarze audio, czasie syntezy lub błędzie dostawcy.

## Diagnostyka

Lokalne zdarzenia obejmują ended, fetch_start/fetch_end (do odebrania body),
play_call, playing, waiting, stalled, błędy, cooldown, zmianę widoczności,
trafienia/nietrafienia i zwalnianie cache. Kod błędu HTTP pochodzi z zamkniętej
listy; treści komunikatów nie są zapisywane w raporcie. Błędy odczytu body także
zamykają pomiar pobierania. Spóźnione odpowiedzi zachowują numer starej sesji.

Przerwa to czas od callbacku ended poprzedniego fragmentu do pierwszego playing
następnego. Wielokrotne playing nie dubluje próbki. Pauza/stop anuluje pomiar;
błąd przejścia zwiększa failed_transitions. Raport zawiera medianę, p95 (nearest
rank), maksimum, liczbę próbek, błędów i anulowań, oczekujące przejście oraz
statystyki według buffer=0/2 i visible/hidden/mixed/unknown. Liczniki trafień
obejmują żądania bieżącego odtwarzania, nie samo uzupełnianie bufora.

Raport nie zawiera tekstu, nazwy pliku, głosu, adresów blob, identyfikatorów
użytkownika ani komunikatów wyjątków. Dane nie są wysyłane do dodatkowej usługi,
localStorage ani serwera. Znikają po odświeżeniu strony. Zwykłe /tts nadal musi
przesłać tekst do istniejącej usługi syntezy.

## Test na Xiaomi 14T

Potrzebny jest dostęp telefonu do uruchomionej **wersji tej gałęzi**. Produkcyjny
main nie ma jeszcze tych zmian; w tej pracy nie uruchomiono wdrożenia.

1. Otwórz `<adres-wersji-testowej>/?test=1&buffer=0` w Chrome. Użyj jawnego,
   nieprywatnego tekstu z wieloma zdaniami. Zachowaj ten sam tekst, głos i tempo
   we wszystkich porównywanych próbach.
2. Odtwarzaj kilka minut z włączonym ekranem. W panelu wybierz **Pobierz raport
   JSON**; plik `audioreader-diagnostics.json` znajdziesz w Pobranych Chrome.
   Opcjonalnie wybierz **Kopiuj raport**; wymaga dostępności schowka i zwykle HTTPS.
3. Przed kolejną próbą pobierz raport, odśwież stronę, wczytaj ten sam tekst
   i odtwórz od tej samej pozycji. Zablokuj ekran po rozpoczęciu odczytu.
   Zanotuj osobno moment blokady/odblokowania i słyszalne przerwy. Po odblokowaniu
   pobierz raport. Nie odświeżaj strony przed eksportem.
4. Powtórz oba scenariusze pod `?test=1&buffer=2`. Można też użyć przełącznika
   w panelu; wyniki jednej strony są grupowane według trybu, ale świeża strona
   ułatwia porównanie oddzielnych prób. Nadaj pobranym plikom rozróżnialne nazwy.
5. Dodatkowo sprawdź pauzę podczas generowania i odtwarzania, ▶, stop, przejście
   dalej/wstecz, zmianę Zofia/Marek, tempa i dokumentu. Nie powinno być starego
   nagrania, podwójnego przejścia ani odtwarzania podczas pauzy. Po rzeczywistym
   błędzie oczekuj ograniczonych prób i wznowienia tego samego fragmentu.
6. Porównaj liczbę próbek, medianę/p95/max, failed_transitions, trafienia bufora,
   waiting/stalled i czasy fetch. Samo hidden nie dowodzi blokady ekranu.
   Opóźnienie callbacków w tle może zafałszować pomiar rzeczywistej ciszy;
   niezależny odsłuch/nagranie zewnętrzne jest potrzebne do potwierdzenia.
7. Aby wyłączyć diagnostykę, usuń `test=1` i otwórz stronę ponownie (lub użyj
   `test=0`). Bufor nadal działa domyślnie. Aby awaryjnie wyłączyć także bufor,
   otwórz `?buffer=0` bez `test=1`. Samo przełączenie bufora w panelu na 0 nie
   wyłącza diagnostyki. Przed ponownym otwarciem strony pobierz raport, ponieważ
   ta operacja usuwa dotychczasowe pomiary.

## Weryfikacja lokalna

- 17 testów Python, w tym uruchomione 58 testów JavaScript: PASS.
- 40 scenariuszy Chromium: 32 przebiegi importu/odczytu (dwa komplety
  TXT/PDF/DOCX i wklejanie ręczne; standardowo, awaryjne `?buffer=0`,
  testowe buffer=0/2) oraz 8 kontroli
  panelu (360×640 i 393×852, buffer=0/2, lektor/edytor): PASS.
  Panel, przyciski i wybór bufora sprawdzane są przez pełne prostokąty
  w viewporcie i elementFromPoint przed kliknięciem, także przy długim statusie
  błędu; każdy z 8 przypadków pobiera i odczytuje JSON.
- Dokładne payloady TTS, brak pominięć/duplikatów w przebiegu bez błędów,
  rzeczywiste zdarzenia playing/ended, kolejność, pojedynczy fetch, limity
  cache, zwolnienie URL i pobranie raportu z panelu: PASS.
- Regresje JS obejmują trzy no_audio, wspólne próby prefetch/foreground,
  odrzucenie dostawcy, anulowanie, późne body i play(), priorytet kolejki,
  zmiany ustawień, pauzę, eksport, ograniczenie danych diagnostycznych
  i dłuższy odczyt 30 fragmentów. Zegar, DOM i audio w JS są atrapami.
- Porównanie kodu z bazą potwierdza identyczną segmentację TXT-01/TXT-02,
  backend/import, standardowy HTML/CSS, głosy, Procfile i requirements.txt.
- `git diff --check`: PASS.

Chromium używa syntetycznego WAV zamiast prawdziwego MP3 z usługi; import trafia
lokalnie do TestClient. W tej weryfikacji nie testowano rzeczywistego edge-tts, Xiaomi, blokady
Androida, sieci mobilnej ani Render. Biblioteki nie aktualizowano. TestClient
emituje ostrzeżenie o wycofywaniu integracji httpx, które nie blokuje testów.

## Pozostałe ryzyka

Bufor przesuwa generowanie wcześniej, lecz nie zmniejsza liczby udanych syntez
na pełny dokument. Może wykonać zbędną pracę dla fragmentów pominiętych przez
użytkownika. Pojedynczy fetch obowiązuje w danej karcie, nie globalnie między
użytkownikami; anulowanie fetch nie gwarantuje przerwania syntezy na serwerze.
Nie obchodzimy odrzucenia dostawcy. Limit 45 s syntezy dla bardzo długich
fragmentów pozostaje bez zmian. Chrome może ograniczać JS, timery i fetch w tle;
nie ma gwarancji ciągłego odczytu po blokadzie ekranu. Nie dodano Media Session,
nowego dostawcy, bufora MOB-03 poza tym zakresem ani natywnego odtwarzacza.

## Uzupełniający przegląd PR #4

Na bazie 1302bbb odtworzono dwa powiązane problemy licznika prób:

- Sukces w trzeciej próbie, releaseJob i ponowne żądanie w tej samej sesji
  zwracały poprzedni błąd zamiast rozpocząć nową syntezę. To test cyklu życia
  cache; nie dowodzi błędu standardowego cofania, które resetuje sesję.
- W rzeczywistym cyklu odtwarzania nagranie A (7 MiB) blokuje zapis udanego
  prefetch B (2 MiB). Po końcu A odtwarzacz musi ponownie pobrać B. Dawniej
  sukces prefetch zajmował jedną próbę i po dwóch błędach nowego pobrania
  odczyt zatrzymywał się przed trzecią próbą. Test odtwarza ten scenariusz
  przez startFrom, fillBuffer i onended, bez ręcznego usuwania cache.

Po poprawnym zakończeniu synthesize zerowane są attempts i poprzedni error;
limit trzech prób nieprzerwanej nieudanej syntezy pozostaje w mocy. Test nowego
cyklu po zwolnieniu URL potwierdza trzy próby oraz brak czwartej automatycznej
próby po porażce. Globalny cooldown nie jest zerowany. Pozostały kod odtwarzacza,
segmentacja, dostawca i wygląd aplikacji nie wymagają zmian. Kontrola geometrii
panelu w obu żądanych rozmiarach nie wykazała potrzeby zmiany CSS.

## Domyślny bufor produkcyjny

Po akceptacji testów Xiaomi 14T zgłoszonej przez użytkownika domyślnie włączono
buffer=2. Zmiana kodu względem 8dd5f2e dotyczy wyłącznie inicjalizacji bufferMode;
warunek test=1 dla diagnostyki, kolejka, limity, próby i segmentacja pozostały
bez zmian. Regresje obejmują domyślne przygotowanie dwóch fragmentów bez panelu,
awaryjne wyłączenie oraz niezależność parametrów test i buffer.
