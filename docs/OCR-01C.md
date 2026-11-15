# OCR-01C — potwierdzenie zastosowanego kadru

Po wybraniu **Zastosuj kadr** w dialogu importu zdjęcia pojawia się podgląd samych przyciętych pikseli, bez ramki. Nagłówek **Kadr gotowy ✓** i główna akcja **Rozpoznaj zaznaczony tekst** wskazują, co zostanie rozpoznane. OCR używa tego samego canvasa, który jest widoczny w podglądzie. Nie uruchamia się automatycznie.

**Zmień kadr** przywraca ramkę i zachowuje wynik tekstowy, dopóki użytkownik faktycznie nie przesunie jej krawędzi. Zmiana ramki anuluje trwający OCR i unieważnia poprzedni wynik. **Całe zdjęcie** wraca do oryginalnego obrazu oraz akcji **Rozpoznaj tekst**. Jeśli użytkownik ręcznie poprawił wynik, przed utratą poprawek wskutek zmiany ramki, wyboru całego zdjęcia lub ponownego OCR pojawia się prośba o potwierdzenie.

Długi obraz można przewijać w obszarze podglądu. Niski, szeroki wycinek jest powiększany do co najmniej 120 px wysokości i można go przewijać poziomo. Regresje w `tests/reader.test.cjs` obejmują przejścia stanów, piksele przekazane do OCR, poprawki tekstu, anulowanie oraz spóźniony wynik. Sprawdzenie dotykiem na Xiaomi 14T pozostaje częścią testu po wdrożeniu.
