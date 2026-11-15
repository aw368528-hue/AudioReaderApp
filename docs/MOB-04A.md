# MOB-04A — odtwarzanie w tle: diagnostyka

Gałąź: `fix/mob-04a-background-diagnostics`, bazowa rewizja `515f272`.
Zmiany dotyczą wyłącznie pomiarów dostępnych przez `?test=1`; odtwarzanie,
buforowanie, Supertonic 3, backend i zależności pozostają bez zmian.

## Co zapisuje raport

- `media_event` dla `pause`, `playing`, `waiting`, `stalled`, `suspend`,
  `ended` i `error`, wraz ze stanem odtwarzacza: `paused`, `ended`,
  `current_time`, `duration`, `ready_state`, `network_state`, szybkością
  odtwarzania i numerycznym kodem błędu.
- `playback_progress` z `current_time` najwyżej raz na pięć sekund podczas
  zdarzeń `timeupdate`.
- `visibility` ze stanem odtwarzacza oraz `visible_progress_check` pięć sekund
  po powrocie strony do widoczności. `playback_advanced: false` wskazuje, że
  `currentTime` nie wzrósł o więcej niż 0,05 s w tym oknie. `elapsed_ms`,
  `session_unchanged` i `player_unchanged` pomagają ocenić, czy pomiar dotyczy
  tej samej sesji i elementu audio. Nieaktualny punkt kontrolny jest pomijany,
  jeśli strona znów stanie się ukryta.

Raport ma schemat `MOB-04A/1` i przechowuje maksymalnie 2000 zdarzeń, tak jak
wcześniej. Migawki nie zawierają źródła audio, adresu blob, tekstu dokumentu,
nazwy pliku, głosu ani komunikatu wyjątku. Diagnostyka działa tylko przy
`?test=1`; dane pozostają lokalne i znikają po odświeżeniu.

## Kontrolowany test na Xiaomi 14T

Wymagany jest adres uruchomionej wersji z tej gałęzi; sama gałąź nie jest
wdrożona. Test nie zmienia kodu telefonu ani ustawień oszczędzania baterii.

1. W Chrome otwórz `<adres-wersji-testowej>/?test=1&buffer=0`. Użyj
   nieszkodliwego tekstu z wieloma zdaniami i pozostaw tę samą treść, głos oraz
   tempo w kolejnych przebiegach.
2. Rozpocznij odtwarzanie, poczekaj na zdarzenie `playing`, zablokuj ekran na
   ustalony czas, a następnie odblokuj telefon i wróć do karty. Zapisz osobno
   godzinę blokady, odblokowania i to, czy dźwięk wrócił.
3. Po co najmniej pięciu sekundach od powrotu pobierz raport z panelu
   diagnostycznego. Nie odświeżaj strony przed pobraniem.
4. Powtórz próbę na świeżo otwartej stronie pod
   `?test=1&buffer=2`. Zachowaj ten sam tekst, głos, tempo i czas blokady.
   Nadaj pobranym plikom nazwy rozróżniające `buffer-0` i `buffer-2`.
5. W raporcie sprawdź ostatnie `visibility`, `media_event` i
   `playback_progress`, a także `visible_progress_check`. `playback_advanced:
   false`, stan `paused`, brak `playing` po powrocie albo rosnący `current_time`
   bez `ended` pomagają ustalić, na jakim etapie stanął odczyt.

Zdarzenie `visibility` opisuje kartę, a nie potwierdza zablokowania ekranu.
Punkt kontrolny mierzy postęp w JavaScript po wznowieniu karty; sam w sobie nie
potwierdza, czy Android wyciszył dźwięk w tle. Porównaj go z własną notatką o
tym, co było słyszalne. Diagnostyka tylko zbiera dowody; automatycznego
wznawiania nie dodano.

## Weryfikacja

Uruchomiono `python -m unittest discover -s tests -v`: wszystkie 17 testów
Python i 61 testów JavaScript uruchamianych przez test frontendu zakończyły się
powodzeniem. Testy używają atrap sieci i odtwarzacza, więc nie zastępują próby
na rzeczywistym Xiaomi 14T, Chrome, blokadzie Androida ani Edge TTS.
