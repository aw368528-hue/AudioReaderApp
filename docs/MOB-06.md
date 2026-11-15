# MOB-06 — ciągła sesja audio

## Sprawdzenie formatu

Zainstalowany `edge-tts` 7.3.1 używa domyślnie `audio-24khz-48kbitrate-mono-mp3`
i zwraca `audio/mpeg`. Specyfikacja [MPEG Audio Byte Stream Format](https://www.w3.org/TR/mse-byte-stream-format-mpeg-audio/)
definiuje MSE dla `audio/mpeg` i ramki MPEG Layer I/II/III. Format Edge TTS
spełnia tę klasę formatu; repozytorium edge-tts podaje dokładne ustawienie
wyjściowe w [communicate.py](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/communicate.py).

Obsługa formatu MSE jest opcjonalna. Aplikacja sprawdza
`MediaSource.isTypeSupported('audio/mpeg')`, a potem również powodzenie
`addSourceBuffer('audio/mpeg')` i appendowania. MP3 jest dopisywane do trybu
`sequence`, który zachowuje kolejność fragmentów bez timestampów. Każdy etap
niepowodzenia przełącza sesję na dotychczasowe odtwarzanie przez audio Blob.

## Strumień

- Przy obsłudze MSE jeden `HTMLAudioElement` i jeden URL MediaSource pozostają
  podpięte przez sesję czytania. `play()` jest wywoływane po dopisaniu pierwszego
  fragmentu; granice zdań nie zmieniają źródła ani nie wywołują kolejnego `play()`.
- Fragmenty są pobierane i dopisywane po kolei. `buffer=0` dopisuje następny
  fragment po wyczerpaniu bieżącego zakresu; `buffer=2` utrzymuje maksymalnie
  dwa fragmenty wyprzedzenia.
- Bufor SourceBuffer jest ograniczony do 8 MiB. Podczas otwartej sesji dane
  starsze niż 30 sekund są usuwane; po `endOfStream()` pozostaje tylko końcowy
  bufor, nadal ograniczony limitem bajtów. Zakończone blob URL-e są zwalniane
  po dopisaniu ich bajtów do SourceBuffer.
- Błąd TTS w trakcie czytania zachowuje już dopisane audio do końca dostępnego
  bufora; po jego wyczerpaniu fallback wznawia od brakującego fragmentu. Błąd
  początkowy, append, dekodowania lub inicjalizacji przechodzi od razu na fallback.
- Stop, skip i zmiana dokumentu/głosu/tempa unieważniają token sesji, anulują
  fetch, przerywają aktualizację SourceBuffer i zwalniają URL MediaSource.
- Nie ma automatycznego restartu po nieoczekiwanej pauzie w trybie MSE.
  Kontrolki Media Session nadal obsługują `play`, `pause` i `stop`.

## Diagnostyka i testy

Raport `?test=1` zawiera tryb MSE/fallback, wynik `isTypeSupported`, bajty
dopisane i zbuforowane, czas bufora, zdarzenia append/remove oraz kody błędów.
Nie przechowuje treści dokumentu.

Testy automatyczne używają atrap MediaSource i SourceBuffer. Sprawdzają kolejność,
ciągłość jednej sesji, buffer=0/2, pause/resume, Media Session, TTS error,
fallback i anulowanie. Nie sprawdzają rzeczywistego dekodera Chrome Android ani
ramki zwróconej przez usługę na telefonie.

Przed uznaniem problemu za rozwiązany należy wdrożyć gałąź na wersję testową
i wykonać próbę na Xiaomi 14T w Chrome z `?test=1&buffer=2`, sprawdzając
`stream.mode`, `stream_append_end`, `stream_waiting` i `media_event`. Dopóki
ta próba nie przejdzie, ciągła sesja jest zweryfikowana wyłącznie w atrapach.
