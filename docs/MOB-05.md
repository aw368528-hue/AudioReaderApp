# MOB-05 — stabilne odtwarzanie w tle

## Zmiany

- Stan Media Session odzwierciedla odtwarzanie, pauzę i zatrzymanie. Dostępne
  kontrolki systemowe `play`, `pause` i `stop` wywołują te same przejścia co
  kontrolki aplikacji. Brak Media Session API nie blokuje odtwarzania.
- Po naturalnym końcu fragmentu element audio nie jest resetowany przez
  `removeAttribute('src')` i `load()`. Następny URL zastępuje poprzednie źródło;
  URL zakończonego fragmentu nadal zwalnia dotychczasowe zarządzanie cache.
- Jedna próba odzyskania jest dopuszczona tylko po pauzie w ukrytej karcie,
  najwyżej 500 ms od `playing`, przy `currentTime` do 0,5 s. Odczekuje 150 ms
  i ponownie sprawdza sesję, fragment, element audio, widoczność oraz stan
  pauzy. Po wykorzystaniu próby dalsze pauzy pozostają pauzą do działania
  użytkownika. Pauza z kontrolki aplikacji lub Media Session jest intencjonalna
  i nie uruchamia odzyskiwania.
- Raport `?test=1` dodaje zdarzenia odzyskiwania i licznik `recovery_attempts`.

## Weryfikacja

Automatyczne testy symulują dwa zgłoszone przypadki (fragmenty 2 i 4 przy
`buffer=2`), pauzę Media Session, zatrzymanie/stary element, późną pauzę,
przejście między fragmentami, zwalnianie URL oraz buforowanie. Nie odtwarzają
zachowania Androida ani rzeczywistej polityki baterii.

Przed uznaniem problemu za rozwiązany należy powtórzyć kontrolowaną próbę na
Xiaomi 14T w Chrome, na wersji z tej gałęzi, z `?test=1&buffer=2`, i sprawdzić
raport po zablokowaniu ekranu. Test fizyczny nie został wykonany w ramach
zmian kodu.
