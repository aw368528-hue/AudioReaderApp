Testy lokalne (Python z zależnościami aplikacji, httpx oraz Node.js):

    python -m unittest discover -s tests -v

Testy tworzą pliki PDF i DOCX w pamięci. Testy TTS zastępują usługę
zewnętrzną kontrolowanymi odpowiedziami; nie wykonują prawdziwej syntezy.
Test JavaScript uruchamia w Node.js kod strony zwrócony przez FastAPI,
z atrapami DOM, odtwarzacza, sieci i skróconymi opóźnieniami ponowień.
Nie zastępuje testów prawdziwego audio i przeglądarki na Renderze.

TXT-01: pełna ścieżka importu i dokładna treść formularzy TTS są sprawdzane
przez segment_check.cjs i syntetyczne pliki w tests/fixtures. Opcjonalny test
rzeczywistych zdarzeń audio w Chromium (z atrapą syntezy WAV):

    python tests/browser_segmentation.py

Wymaga Playwright i /usr/bin/chromium wyłącznie w środowisku developerskim.
Nie są one nowymi zależnościami aplikacji wdrażanej na Render.
