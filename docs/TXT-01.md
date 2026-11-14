# TXT-01: granice wypowiedzi niezależne od układu

Gałąź fix/text-segmentation-v2, baza 3417757e1b2fd17659633ef807621c5c403d6027.
Bez zmian MOB-02, bez bufora MOB-03A, bez publikacji.

## Przyczyna

Dotychczasowy splitSentences traktował każdą pustą linię jako koniec fragmentu,
nawet w środku zdania. Sam przecinek nie był separatorem. normalize_pdf_text
zachowuje odstępy wynikające z pustych wierszy, wcięć oraz granic stron;
taki układ nie daje pewnej informacji o granicach zdań. Numer listy zakończony
kropką także mógł stać się samodzielnym fragmentem.

## Implementacja

- normalizeLayout ogranicza nadmiar białych znaków, zachowując podział wizualny.
- readingGroups rozpoznaje granice list oraz nagłówki. Zwykła pusta linia
  nie kończy wypowiedzi. Numer na osobnej linii pozostaje z treścią pozycji.
- speechSegments zwraca oddzielne displayText oraz text: ten pierwszy zachowuje
  układ, drugi normalizuje białe znaki do spacji i trafia do tablicy sentences,
  z której istniejący fetchAudioBlob wysyła formularz do /tts.
- Krótki nagłówek jest łączony z pierwszą wypowiedzią sekcji. Samodzielne
  pozycje list pozostają rozdzielone także bez kropki na końcu.
- Reguły obejmują polskie skróty, inicjały, liczby, cytaty, dopowiedzenia po
  cytacie, nawiasy, wielokropki i odwołania do przepisów. Przecinek nie jest
  granicą audio. Nie ma arbitralnego cięcia po liczbie słów.
- DOCX przekazuje wskazówki o stylach nagłówków/list i numPr, niezależnie od
  tekstu. Offsety odpowiadają UTF-16 używanemu przez JavaScript (także emoji).
- PDF normalizuje również nietypowe poziome białe znaki; zachowuje układ
  akapitów, nie zamieniając go bezpośrednio na granice nagrań.
- TXT obsługuje UTF-8 i UTF-8 z BOM. Nieznane kodowanie jest jawnie odrzucane
  zamiast usuwania znaków przez errors=ignore. Nie zgadujemy kodowania.

## Testy

    python -m unittest discover -s tests -v

Opcjonalny test przeglądarkowy, wymagający lokalnego Playwright i Chromium:

    python tests/browser_segmentation.py

Regresje porównują pełne fragmenty, kolejność tokenów i dokładną zawartość
formularzy TTS. Pliki tests/fixtures/wrapped_document.{txt,pdf,docx} są
syntetyczne i zawierają tę samą treść: Risk/Engine rozdzielone pustym wierszem,
zdanie z przecinkiem i ≤5%, polskie znaki, numer 4. na osobnej linii,
śródtytuły oraz listy. Oczekiwane wypowiedzi zapisano w jawnej postaci JSON.
PDF ma osadzoną czcionkę DejaVu Sans. DOCX zawiera rzeczywiste style nagłówków.
Dodatkowy DOCX generowany w teście sprawdza List Number, zawijanie wewnątrz
pozycji listy i offsety po emoji.

Test Chromium używa prawdziwych zdarzeń HTMLAudioElement z syntetycznym WAV.
Import jest wykonywany przez lokalny TestClient, a transport jest przechwycony
przez Playwright (bajty pliku dostarcza ta sama lokalna fixture). Nie stanowi
to testu produkcyjnego przesyłania plików ani głosu dostawcy. Nie korzysta
z sieci zewnętrznej, dokumentów prywatnych ani prawdziwej syntezy.

## Ograniczenia

Algorytm jest heurystyczny, nie rozumie znaczenia. Dwuznaczny skrót na końcu
zdania lub nietypowo zapisany nagłówek nadal może zostać połączony niewłaściwie.
W TXT/PDF nagłówki nie mają pewnej semantyki; krótkich linii wewnątrz
niedokończonej wypowiedzi nie traktujemy automatycznie jako śródtytułów.
Tekst bez interpunkcji może tworzyć długi fragment. Krótkie pełne odpowiedzi
(Tak./Nie!) i krótkie rzeczywiste pozycje list pozostają krótkimi fragmentami.
Samotny nagłówek lub numer bez jakiejkolwiek treści nie jest usuwany.

Nie dodano OCR, rekonstrukcji tabel, wielokolumnowego składu ani usuwania
łączników przy przenoszeniu wyrazów (mogłoby zmienić treść). Automatyczna
numeracja DOCX jest rozpoznawana jako struktura listy, lecz jej wizualne
etykiety nie są rekonstruowane; tekst python-docx zachowuje dotychczasowy
zakres ekstrakcji. Ręcznie wpisane numery pozostają bez zmian.

Nie zmieniono wyglądu, głosów, konfiguracji Render ani ponowień MOB-02.
Nie wykonano odsłuchu na Xiaomi ani testu naturalnej prozodii Zofii/Marka.

## Końcowa kontrola: długie wypowiedzi i limit 45 s

Regresja przekazuje jeden fragment około 120 tys. znaków bez interpunkcji
przez segmentację i formularz /tts: bez arbitralnego cięcia i bez utraty treści.
Dla każdej ścieżki wejścia sprawdzana jest też zgodność tekstu wyświetlanego
(po normalizacji białych znaków) z dokładnym tekstem wysyłanym do TTS.

Limit 45 s obejmuje pełne comm.save(), a nie długość odtwarzanego audio.
Test symulowanej wolnej syntezy potwierdza zachowanie limitu 45 s,
anulowanie zadania, HTTP 504/timeout, Retry-After: 8 i usunięcie pliku
roboczego. Czas w teście jest przyspieszony; nie mierzono rzeczywistej
przepustowości dostawcy. Nie można zagwarantować, że długa wypowiedź zmieści
się w 45 s. Trzy timeouty mogą zająć około 151 s plus narzuty sieciowe
(3 x 45 s + dwie przerwy po 8 s), nadal bez utraty bieżącej pozycji.

Ryzyko jest jawne, ale nie zmieniamy MOB-02 w TXT-01. Minimalne osobne
rozwiązanie do rozważenia: ograniczony, konfigurowalny budżet czasu syntezy
uwzględniający długość tekstu, po zmierzeniu przepustowości i sprawdzeniu
limitów infrastruktury. Nie wymaga cięcia wypowiedzi ani zmiany treści.
Nie należy utożsamiać liczby znaków lub długości nagrania z pewnym czasem
syntezy ani wprowadzać nieograniczonego timeoutu.
