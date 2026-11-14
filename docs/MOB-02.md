# MOB-02: brak audio podczas dłuższego odczytu

Baza: 5eb613ce74e9e99038506d6218797dec7db3ab7e.
Gałąź: fix/mob-02-tts-recovery. Bez wdrożenia i bez aktualizacji zależności.

## Diagnoza

Zgłoszone logi Render potwierdzają NoAudioReceived, a nie przyczynę po stronie
usługi. Kod bazowy klasyfikował ten wyjątek jako ogólny synthesis_error (502).
Frontend ponawiał po 400 i 800 ms. Błąd prefetch usuwano z cache; wejście na
następne zdanie mogło rozpocząć nowy cykl trzech prób. Na jeden problematyczny
fragment przypadało zatem do sześciu żądań w tych dwóch cyklach. Nie ma dowodu,
że dostawca zastosował limit, ani że aktualizacja biblioteki rozwiąże problem.

Lokalnie edge-tts 7.3.1. Wersja produkcyjna nieustalona: brak dostępu do powłoki
Render i historii instalacji. requirements.txt nie przypina wersji. Odczyt
publicznych endpointów nie ujawnia wersji pakietu. Po ewentualnym wdrożeniu
nowe logi każdego wywołania podadzą pole edge_tts. W istniejącej powłoce Render
można ją ustalić bez zmiany instalacji:

    python -c 'from importlib.metadata import version; print(version("edge-tts"))'

## Zmiany

- Osobne kody: no_audio, timeout, connection_rejected, connection_refused,
  communication_error, invalid_input, synthesis_error.
- Diagnostyka: losowy request_id, wersja biblioteki, kategoria, typ wyjątku,
  liczba znaków, głos z listy dozwolonych, tempo, czas, bajty audio, status
  dostawcy. Bez tekstu, fragmentów, hashy treści, URL dostawcy i komunikatów
  wyjątków. Odpowiedzi walidacyjne nie zwracają przesłanych danych.
- Maksymalnie 3 próby w frontendzie, bez dodatkowych prób backendu.
  Odstępy bazowe 3 i 8 s po odpowiedzi, a dla no_audio minimum 10 s.
  Retry-After jest respektowane, także po przerwaniu i ręcznym wznowieniu.
- Jawne odrzucenie HTTP przez dostawcę nie jest automatycznie ponawiane.
  Obowiązuje minimum 30 s i ewentualny dłuższy Retry-After dostawcy.
- Usunięty prefetch: kolejne zdanie jest generowane dopiero po zakończeniu
  aktywnego. Błąd nie uruchamia niewidocznej równoległej serii prób.
- Istniejące pole statusu pokazuje oczekiwanie, długość przerwy i numer próby;
  pauza zachowuje komunikat Wstrzymano.
- Zdarzenie końca zdania jest obsługiwane najwyżej raz dla danego indeksu.
- Po wyczerpaniu prób bieżący indeks pozostaje bez zmian, cache błędu jest
  usuwany, a komunikat wskazuje wznowienie przyciskiem odtwarzania.

## Koszt i ograniczenia

N niebuforowanych zdań oznacza N żądań do aplikacji i N obiektów Communicate.
To kosztowne dla krótkich zdań. Lokalna biblioteka może dodatkowo dzielić tekst
na kawałki i wewnętrznie powtórzyć handshake 403; trzy próby aplikacji nie
stanowią gwarancji trzech połączeń TCP/WebSocket. Tego zachowania biblioteki
nie modyfikowano i nie dodano mechanizmów obchodzenia ograniczeń.

Usunięcie prefetch ogranicza nakładanie żądań i zbędną pracę, lecz nie zmniejsza
liczby udanych syntez dla pełnego dokumentu. Może zwiększyć przerwy między
zdaniami. Ewentualne grupowanie zdań w większe fragmenty wymaga osobnej pracy
nad synchronizacją podświetlenia; nie wchodzi w ten zakres.

Cooldown jest lokalny dla karty przeglądarki, nie globalny dla wszystkich
użytkowników serwera. Anulowanie fetch nie gwarantuje przerwania pracy już
rozpoczętej przez serwer. Nadal zależymy od dostępności dostawcy. Nie testowano
tej gałęzi na Renderze ani na prawdziwym urządzeniu mobilnym. Regresje używają
atrap usług oraz zegara; nie symulują limitów konkretnego dostawcy.
