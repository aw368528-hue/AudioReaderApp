# OCR-01B — kadr zdjęcia i edycja tekstu na telefonie

## Przepływ w aplikacji

W **Dodaj treść → Zdjęcie** użytkownik robi fotografię lub wybiera obraz z galerii. Podgląd zachowuje proporcje także dla długiego zrzutu ekranu; jego obszar można przewijać. Ramkę kadru przesuwa się środkowym uchwytem, a jej krawędzie lub rogi pozostałymi uchwytami. Po wybraniu **Zastosuj kadr** przycisk **Rozpoznaj tekst** uruchamia OCR na przyciętych pikselach. **Całe zdjęcie** przywraca dotychczasowe rozpoznawanie bez kadrowania. Zmiana ramki unieważnia wcześniejszy tekst i wymaga ponownego zastosowania kadru oraz OCR.

Po rozpoznaniu przycisk **Rozwiń edytor** powiększa pole tekstowe w tym samym dialogu. Edytor korzysta z wysokości widocznego obszaru (`VisualViewport`), gdy pojawia się klawiatura, oraz z marginesów bezpiecznych telefonu. **Czytaj tekst** pozostaje na dole edytora. Zwinięcie i ponowne rozwinięcie nie usuwa poprawek. Zatwierdzenie przekazuje tekst do istniejącego Lektora, biblioteki i historii.

## Technika i ograniczenia

- Obraz jest dekodowany jak w OCR-01 z `imageOrientation: 'from-image'`. Ramka używa współrzędnych względnych obrazu, a przed OCR jest przeliczana na piksele canvasa. Dla całego zdjęcia OCR używa oryginalnego podglądu; dla wybranego kadru tworzy tymczasowy canvas z faktycznie przyciętymi pikselami.
- Minimalny kadr ma 120 × 80 pikseli źródłowych, o ile zdjęcie nie jest mniejsze. Ruch i zmiana rozmiaru są ograniczone do granic obrazu. Tymczasowy canvas jest zwalniany po zakończeniu lub anulowaniu rozpoznania.
- Zmiana kadru podczas OCR anuluje bieżącą operację. Istniejące tokeny operacji i rewizja dokumentu odrzucają spóźnione wyniki po zmianie dokumentu, zamknięciu dialogu lub anulowaniu.
- Aplikacja nie zapisuje zdjęcia ani kadru w IndexedDB. Zapisuje tylko zatwierdzony tekst zgodnie z OCR-01. Nie zmieniono Edge TTS, MOB-06, segmentacji, głosów, biblioteki ani historii.
- Jeden obraz pozostaje limitem importu. Kadrowanie nie prostuje perspektywy ani nie poprawia jakości rozmazanego zdjęcia.

## Weryfikacja

`python -m unittest discover -s tests -v` uruchamia testy serwera oraz testy JavaScript Lektora i OCR. Regresje OCR-01B sprawdzają geometrię, mapowanie współrzędnych, długi zrzut, OCR całego obrazu, spóźniony wynik przy zmianie kadru, edycję, zachowanie poprawek i zapis dokumentu. `node tests/ocr_probe.test.cjs` sprawdza niezależny moduł pomiarowy OCR-01.

Po wdrożeniu na Xiaomi 14T trzeba jeszcze sprawdzić palcem kadrowanie długiego zrzutu, przewijanie podglądu, czytelność tekstu OCR, zachowanie klawiatury i przycisku **Czytaj tekst** oraz jakość rozpoznania kilku zdjęć. Testy automatyczne nie stanowią walidacji urządzenia.
