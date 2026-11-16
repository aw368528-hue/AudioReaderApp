# AudioReader AI — wizja i ustalenia produktowe

**Status dokumentu:** wersja 1.0, odtworzona z dostępnych rozmów ChatGPT i informacji potwierdzonych przez właściciela, 2026-11-16.  
**Przeznaczenie:** trwałe źródło założeń produktu dla rozmów ChatGPT i lokalnych agentów.  
**Nazwa produktu:** AudioReader AI. **Repozytorium aktualnej implementacji:** `aw368528-hue/AudioReaderApp`.

## 1. Cel produktu — nadrzędny

AudioReader AI powstaje **przede wszystkim na osobisty użytek właściciela**: ma umożliwiać wygodne słuchanie dokumentów i tekstów po polsku, zamiast konieczności czytania ich na ekranie. Właściciel współprojektuje aplikację, testuje ją na własnym telefonie i decyduje o jej finalnym kształcie.

**Docelowy produkt to natywna aplikacja na Androida.** Ten warunek był częścią pierwotnej wizji przedstawionej Gemini. Działająca aktualnie wersja webowa/PWA jest odziedziczoną implementacją i praktycznym środowiskiem rozwijania oraz weryfikowania funkcji, **nie dowodem rezygnacji z natywnego Androida**.

Należy chronić już zrealizowane i przetestowane funkcje. Wybór metody przejścia z obecnej implementacji na Androida wymaga analizy; **konkretna architektura natywna nie jest jeszcze zatwierdzoną decyzją**. Samo umieszczenie strony w WebView nie spełnia automatycznie celu „natywna aplikacja”.

## 2. Kluczowe potrzeby użytkownika

- Otwieranie i słuchanie tekstu z dokumentów PDF, DOCX i TXT oraz tekstu wklejonego ręcznie.
- Czytanie tekstu ze zdjęć i wielostronicowych skanów, z możliwością sprawdzenia i skorygowania wyników OCR przed odsłuchem.
- Naturalne polskie głosy; obecnie Zofia i Marek, z regulacją tempa i możliwością zapamiętywania preferencji.
- Pauza, wznowienie czytania od zapamiętanej pozycji oraz odtwarzanie przy wygaszonym/zablokowanym ekranie telefonu.
- Wygodna, nieskomplikowana obsługa, szczególnie na telefonie. Użytkownik wyrażał potrzebę możliwości wklejenia bardzo długiego tekstu; implementacja nie powinna dodawać arbitralnych ograniczeń bez uzasadnienia i wskazania technicznych konsekwencji.
- Zachowanie postępu i wygodny powrót do wcześniej odczytywanych dokumentów.

To są potrzeby produktowe. Ich wymienienie **nie stanowi zapewnienia**, że obecna implementacja obsługuje każdy przypadek bez ograniczeń.

## 3. Rzeczywiste decyzje a rozwiązania tymczasowe

| Kwestia | Ustalenie | Charakter |
|---|---|---|
| Główny odbiorca | Właściciel korzystający z AudioReader AI osobiście | Cel nadrzędny |
| Platforma docelowa | Natywny Android | Założenie docelowe |
| Bieżąca technologia | FastAPI + interfejs webowy/PWA, wdrożone na Renderze | Stan implementacji, nie docelowa platforma |
| Synteza głosu | Obecnie Edge TTS (Zofia, Marek) | Sprawdzone rozwiązanie bieżące |
| Supertonic | Eksperyment offline / potencjalnej komercjalizacji zamrożony | Nie wznawiać automatycznie |
| Komercjalizacja | Rozważana wcześnie, ale wyłącznie potencjalny bonus na przyszłość | **Nie jest obecnym ani automatycznym przyszłym priorytetem** |
| Publikacja / sprzedaż | Brak bieżącej decyzji o uruchamianiu oferty komercyjnej | Nie tworzyć wymagań sprzedażowych bez osobnej decyzji |

Wczesne pytanie o komercjalizację dotyczyło między innymi możliwości legalnego użycia głosów, kosztów i ewentualnej dystrybucji. **Zadanie pytania nie oznacza decyzji o komercjalizacji.** Android/Google Play jako platforma dystrybucji nie oznacza automatycznie płatnej aplikacji.

## 4. Zasady podejmowania decyzji

1. **Wizja końcowa ma pierwszeństwo** przed przyzwyczajeniami wynikającymi z aktualnego kodu i przed propozycjami asystentów.
2. Dzielić informacje na: *ustalenie zatwierdzone*, *stan implementacji*, *propozycję / eksperyment* i *kwestię otwartą*. Nie zamieniać jednej kategorii w drugą bez świadomej decyzji właściciela.
3. Gdy nowe zadanie, sugestia technologiczna lub zmiana zakresu **może kolidować z celem natywnego Androida albo osobistego zastosowania**, wyraźnie pokazać rozbieżność, konsekwencje i alternatywy **przed wdrożeniem**.
4. Porównywanie wariantów (np. projektów ikony, technologii, głosów) **nie jest samo w sobie anulowaniem wcześniejszego wyboru**.
5. Nie dodawać obowiązków związanych z marketingiem, kontami, płatnościami, ofertą, pozyskiwaniem klientów ani testami rynkowymi jako domyślnego planu rozwoju.
6. Nie wymyślać źródeł historycznych ani szczegółów niesprawdzonych w rozmowach lub kodzie. Jeśli istnieje rozbieżność, oznaczyć ją i sprawdzić.

## 5. Co pozostaje do rozstrzygnięcia

- Dokładny plan i kolejność przejścia ze sprawdzonej implementacji webowej do aplikacji natywnej Android.
- Zakres ponownego użycia backendu TTS, sposobu OCR, przechowywania dokumentów i interfejsu podczas migracji.
- Zestaw funkcji niezbędnych dla właściciela w pierwszej wygodnej wersji natywnej — do ustalenia w toku wspólnych testów, nie przez rynkową listę życzeń.
- Ewentualna komercjalizacja: **nie planować obecnie**; powrót wyłącznie po inicjatywie i odrębnej decyzji właściciela.

## 6. Pochodzenie i ograniczenia dokumentu

Wizję osobistego użytku, natywnego Androida i komercjalizacji jako dodatku właściciel jednoznacznie potwierdził w rozmowach ChatGPT 15–16.11.2026; początkowe ustalenia z Gemini znamy z jego relacji, **bez pełnego pierwotnego transkryptu Gemini**. Potrzeby Lektora i rodzaje treści potwierdzają rozmowy i wdrożenia z 14–15.11.2026. Ten dokument opisuje cele i świadome ustalenia; stan konkretnych wdrożeń jest w `STATE.md`, a źródłem rzeczywistego zachowania programu pozostaje aktualny kod i wynik testu na urządzeniu.
