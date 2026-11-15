# OCR-02 — skaner wielostronicowy

W **+ Dodaj treść → Skanuj dokument** można dodawać kolejne zdjęcia z aparatu albo jedną lub wiele stron z galerii. Lista pokazuje kolejność, miniatury i stan każdej strony. Strony można przesuwać przyciskami, usuwać i ponawiać zdjęcie. Każda strona ma niezależny kadr z podglądem OCR-01C; przycięcie jest opcjonalne.

**Rozpoznaj wszystkie strony** przetwarza tylko strony oczekujące na OCR, kolejno na jednym workerze Tesseract. Postęp wskazuje numer strony. Anulowanie zachowuje już rozpoznane strony; błąd jednej strony nie usuwa pozostałych i można ponowić tylko tę stronę. Edytor zachowuje poprawki przy przechodzeniu między stronami. Kolejność tekstów podąża za kolejnością zdjęć. Zmiana kadru, wymiana lub usunięcie strony z ręcznymi poprawkami wymaga potwierdzenia.

**Czytaj dokument** po potwierdzeniu łączy niepuste teksty w kolejności stron, oddziela je akapitami i przekazuje jako jeden dokument o wybranej nazwie do istniejącego Lektora, biblioteki i historii. Odtwarzanie nie startuje automatycznie. Zamknięcie niezapisanego skanu wymaga potwierdzenia.

Zdjęcia są przechowywane tylko w pamięci bieżącej sesji, bez zapisu binariów w IndexedDB i bez wysyłania ich do serwera. Miniatury mają najwyżej 160 px na dłuższym boku. Pełny obraz jest dekodowany pojedynczo przy kadrowaniu lub rozpoznawaniu, a canvasy i ImageBitmap są zwalniane po użyciu. Limit to 10 stron i 60 MB zdjęć na sesję, oprócz dotychczasowych limitów 12 MB i 16 MP na zdjęcie. Budżet 60 MB ogranicza pamięć telefonu przy wielu zdjęciach bliskich limitowi 12 MB. Odświeżenie strony usuwa niezapisany skan.

Weryfikacja lokalna: `python -m unittest discover -s tests -v`, `node --check ocr_prototype/app-ocr.js`, `node --check tests/reader.test.cjs`, `git diff --check`. Po wdrożeniu należy sprawdzić cały przebieg dotykiem na Xiaomi 14T, w tym aparat, galerię, kadrowanie, klawiaturę, wznowienie z biblioteki i pamięć przy długiej sesji.
