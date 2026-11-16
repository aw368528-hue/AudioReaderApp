# AudioReader AI — stan projektu i następny krok

**Migawka:** 2026-11-16. Stan sprawdzony względem dostępnych rozmów, dokumentacji repozytorium, GitHub Issue #22 i ostatniego wdrożenia Render.  
**Dokument aktualizowany wraz z postępem.** Jeśli jest nieaktualny, porównać z `main`, otwartymi PR/Issue i bieżącymi testami; nie traktować historycznego opisu jako dowodu działania kodu.

## 1. Identyfikatory i środowisko

- Produkt: **AudioReader AI**; repo: `https://github.com/aw368528-hue/AudioReaderApp` (`main`).
- Działająca implementacja webowa: `https://audioreaderapp.onrender.com/` (Render).
- Ostatni potwierdzony live deploy w chwili sporządzenia: merge PR **#21**, commit `733e68a466c77b800531ec94eca4665cdedcf3b4` (`OCR-02`).
- Rzeczywiste urządzenie testowe: **Xiaomi 14T**, przeglądarka Chrome.
- Cel końcowy: **natywna aplikacja Android**, nie bieżąca PWA. Patrz `PRODUCT.md`.

## 2. Co zaimplementowano

| Funkcja / moduł | Stan | Uwagi |
|---|---|---|
| Import PDF / DOCX / TXT oraz wklejanie tekstu | Jest w bieżącej aplikacji | Import plików przez backend `/upload` |
| Głosy Zofia i Marek / Edge TTS | Działa | Backend `/tts`, suwak tempa od −50% do +50% |
| Segmentacja TXT-01 / TXT-02 | Zaimplementowana | Nagłówki, listy, pola informacyjne; nadal możliwe trudne przypadki |
| Odtwarzanie, buforowanie, próby ponowienia, Media Session, MOB-06 | Zaimplementowane | Testy automatyczne nie zastępują długiego odsłuchu na urządzeniu |
| Lokalna biblioteka (do 10 dokumentów), historia, kalendarz, wznowienie | Zaimplementowane | IndexedDB, biblioteka lokalna, bez synchronizacji między urządzeniami |
| OCR-01: pojedyncze zdjęcie → tekst → korekta → Lektor | Zaimplementowany i testowany na telefonie | OCR lokalnie w przeglądarce przez Tesseract.js |
| OCR-01B/01C: kadrowanie i potwierdzenie zastosowanego kadru | Zaimplementowane i testowane na telefonie | Widoczny podgląd kadru |
| OCR-02: wielostronicowy skaner | Zaimplementowany i wdrożony | Limit 10 stron / 60 MB na sesję, edycja, kolejność, lokalny OCR |
| UI-01: mobilna nawigacja Lektor / Historia | Zaimplementowana | Istnieją jasny i ciemny motyw |

## 3. Potwierdzone testy ręczne i obserwacje

- **OCR-02:** właściciel dodał **dwie strony**, potwierdził scalenie w jeden dokument, przekazanie do Lektora i skuteczne odczytanie tekstu.
- **Marek:** przy ustawieniu `0%` czytał dla właściciela zbyt szybko; po zmianie na **`−30%`** czytał zauważalnie wolniej i wyraźniej. **Regulator działa.** To preferencja właściciela, nie nowa globalna wartość startowa.
- Wcześniej potwierdzono ścieżkę OCR pojedynczej fotografii oraz kadrowanie i podgląd.
- Pozytywny test dwóch stron **nie oznacza pełnej walidacji** 10 stron, dużych zdjęć, długich dokumentów, jakości OCR w gorszym świetle ani wszystkich stanów odtwarzacza w tle.

## 4. Otwarte zadania i ustalenia

### Następne zadanie — Issue #22

**TTS-UX-01 — zapamiętywanie tempa osobno dla Zofii i Marka**  
https://github.com/aw368528-hue/AudioReaderApp/issues/22  
**Stan w chwili sprawdzenia:** `open`, implementacja niezrealizowana.

- Zapisywać lokalnie niezależne tempo każdej osoby lektorskiej i ostatni wybrany głos.
- Po powrocie do głosu i ponownym otwarciu aplikacji przywracać jego preferencje.
- W nowym profilu początkowo `0%`; nie ustawiać każdemu domyślnie `−30%`.
- Zachować postęp dokumentów i nie nadpisywać bieżących preferencji starym `voice/rate` z rekordów biblioteki.
- Testy i review PR przed merge; dopiero następnie Render i kontrola na Xiaomi 14T.

### Po #22 — domknięcie testów i przygotowanie natywnego Androida

1. Sprawdzić na Xiaomi 14T kilka bardziej wymagających dokumentów i większy skan, powrót z biblioteki, słuchanie przy zablokowanym ekranie, przełączanie głosu/tempa i długą sesję.
2. Porównać z wizją `PRODUCT.md`, które funkcje obecnego rozwiązania są rzeczywiście akceptowane i niezbędne do natywnego Androida.
3. Przygotować projekt przejścia do natywnego Androida, **przed wyborem architektury** zidentyfikować elementy do ponownego użycia / zastąpienia oraz ryzyka. Nie utożsamiać aplikacji WebView z natywną aplikacją.
4. Kontynuować rozwój zgodnie z faktycznymi potrzebami właściciela, bez uruchamiania planu komercjalizacji.

## 5. Decyzje i ograniczenia, których nie należy mylić

- PWA/Render = **aktualna implementacja**. Android native = **cel docelowy**.
- Testowanie na telefonie w Chrome nie stanowi testu aplikacji natywnej.
- Pomysł komercjalizacji został poruszony wcześnie; **obecnie jest wyłącznie możliwym bonusem na przyszłość**. Nie przygotowywać automatycznie planu sprzedaży, marketingu, testów rynkowych ani subskrypcji.
- **Supertonic zamrożony**; aktualnie pozostaje Edge TTS. Nie uruchamiać eksperymentów offline bez nowej decyzji.
- Eksploracja alternatywnych ikon nie zastępuje automatycznie pierwotnego wyboru graficznego; przed wdrożeniem ostatecznej ikony sprawdzić aktualnie zaakceptowany wariant.

## 6. Ważne obserwacje techniczne

- Zdjęcia OCR są przetwarzane lokalnie w przeglądarce; przesyłane pliki PDF/DOCX/TXT trafiają na backend, a tekst do syntezy jest wysyłany przez backend do usługi głosowej. **Nie deklarować, że cały produkt działa offline ani że wszystkie teksty pozostają wyłącznie na telefonie.**
- Dane biblioteki są lokalne w IndexedDB. Obecny limit biblioteki to 10 dokumentów, historia jest limitowana; nie obiecywać synchronizacji ani kopii między urządzeniami.
- W implementacji OCR-02 fotografie nie są trwale zapisywane; odświeżenie strony podczas niezakończonego skanowania usuwa roboczy skan.
- W dokumentacji modułów istnieją ograniczenia i niewykonane testy urządzeniowe — należy je rozróżniać od potwierdzonych wyników.

## 7. Zasada aktualizacji tego pliku

Po zakończeniu etapu: wpisać **konkretny wynik**, numer PR/Issue i commit, status wdrożenia, informację o teście automatycznym oraz (osobno) rzeczywistym teście na telefonie. Nie przekreślać poprzednich decyzji przez samo dopisanie sugestii. Gdy nowy wątek zmienia założenia `PRODUCT.md`, wymaga odrębnego wyjaśnienia właścicielowi i jego decyzji.

### Źródła historyczne

Rozmowy ChatGPT z 14–16.11.2026; GitHub `aw368528-hue/AudioReaderApp` (w tym `docs/OCR-02.md`, `docs/MOB-06.md`, `docs/UX-02.md`, `docs/UI-01.md`), Issue #22; Render — deploy OCR-02 `733e68a`. Pełny pierwotny transkrypt Gemini nie był dostępny przy sporządzaniu dokumentu.
