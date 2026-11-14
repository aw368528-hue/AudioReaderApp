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

MOB-03A: ten sam zestaw unittest uruchamia też testy pojedynczej kolejki,
limitów cache, wspólnego budżetu prób i prywatności diagnostyki.
`browser_segmentation.py` sprawdza obecnie 24 scenariusze: TXT-01/TXT-02,
cztery drogi importu, tryb standardowy i testowe buffer=0/2. Używa prawdziwych
zdarzeń odtwarzacza z syntetycznym WAV, sprawdza porządek odtwarzania,
serializację pobierania, zwalnianie URL i pobranie JSON w mobilnym viewporcie.
Instrukcja fizycznego telefonu i granice pomiarów: docs/MOB-03A.md.
