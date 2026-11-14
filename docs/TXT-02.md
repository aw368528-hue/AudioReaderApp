# TXT-02: nagłówek i pola informacyjne

Baza: main 75b0870 (wdrożony TXT-01).
Gałąź: fix/text-metadata-boundaries. Zakres PR: wyłącznie TXT-02; bez merge i wdrożenia.

## Diagnoza

Dla dokładnego tekstu zgłoszenia segmenter TXT-01 zwracał dwa fragmenty:
tytuł razem z Data oraz uczestnicy razem ze Status. Jest to potwierdzony
wynik uruchomienia kodu bazowego, bez potrzeby odtwarzania dźwięku.

TXT zachowuje znaki nowej linii, a DOCX zachowuje akapity i style nagłówków.
W syntetycznym PDF cztery fizyczne wiersze są łączone przez istniejące
normalize_pdf_text w jeden wiersz. Niezależnie od importu TXT-01 celowo
łączy niedokończone wypowiedzi i krótki nagłówek z treścią; nie miał osobnego
modelu pól informacyjnych. Nie dysponowano oryginalnym plikiem użytkownika,
więc nie przypisujemy mu konkretnego błędu ekstrakcji na podstawie samego
wklejonego tekstu.

## Zmiana

Nowy etap documentUnits rozpoznaje znane etykiety pól w kontekście struktury:
na początku wiersza, po tytule pisanym wielkimi literami lub w nagłówku
potwierdzonym wskazówką DOCX. Wtedy kolejne znane etykiety mogą wyznaczać
granice także wewnątrz jednego wiersza. Rozpoznawane są m.in. Data,
Uczestnicy konfrontacji, Status, Autor/Autorzy, Wersja, Temat, Projekt,
Tytuł, Numer dokumentu oraz Data utworzenia/modyfikacji/aktualizacji.

Nie dzielimy po każdym dwukropku. Etykiety w cytatach i nawiasach oraz
w zwykłej narracji nie są automatycznie separatorami. Zawinięte wartości
pól mogą być kontynuowane; nagłówki i listy nie są wchłaniane jako ciąg
dalszy pola. Każde rozpoznane pole jest jedną jednostką syntezy.

Tekst źródłowy, import i wskazówki DOCX pozostają bez zmian. displayText
zachowuje lokalny układ, natomiast tekst wysyłany do /tts różni się od niego
wyłącznie normalizacją białych znaków. Nie dodano kropki ani innej wskazówki
prozodycznej. Granicę tworzy osobny fragment istniejącego odtwarzacza.

## Sprawdzenie

17 testów Python (w tym 33 scenariusze JavaScript): PASS.
Chromium: 8 scenariuszy dla TXT-01 i TXT-02, manual/TXT/PDF/DOCX: PASS.
Testy porównują dokładne treści, kolejność słów i formularze TTS, również
wariant jednego wiersza i wariant z osobnymi akapitami. Brak zmian w HTML/CSS,
głosach, kodzie odtwarzania/ponowień MOB-02, backendzie i konfiguracji.

Syntetyczne pliki metadata_document.* zawierają dokładny przykład zgłoszenia.
Oczekiwane cztery fragmenty znajdują się w metadata_document.expected.json.
Chromium używa lokalnego importu i syntetycznego WAV; nie testowano prawdziwej
syntezy Zofii/Marka ani telefonu Xiaomi. git diff --check: PASS.

Końcowy przegląd dodał negatywne regresje dla zwykłych słów status, data
i projekt: bez dwukropków, z dwukropkami w narracji, w cytatach i przy
zawiniętym Risk Engine. Porównanie z aktualnym main potwierdza brak
zmian poza segmentacją i jej testami/dokumentacją.

## Ograniczenia

Rozpoznawanie opiera się na skończonej liście etykiet i heurystykach kontekstu.
Nieznane pola oraz pozbawiony stylu tytuł zapisany mieszaną wielkością liter
na wspólnej linii z metadanymi mogą wymagać dalszych przykładów. Niejednoznaczne
użycie nazwy znanego pola w środku wartości może nadal wyglądać jak następne
pole. Brakujące lub niesparowane znaki cytowania mogą ograniczyć detekcję.
Nie wprowadzono zmian w OCR, układzie wielokolumnowym ani limicie 45 s.
