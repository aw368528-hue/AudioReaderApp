const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const script = fs.readFileSync(0, 'utf8');
async function settle() { for (let n = 0; n < 12; n++) await new Promise(r => setTimeout(r, 1)); }
const ok = () => ({ok: true, blob: async () => ({size: 10})});
const failed = (status = 502) => ({ok: false, status, headers: {get: () => null}, json: async () => ({error: 'Błąd syntezy'})});
function harness(fetch, query = '') {
    const elements = new Map();
    function element() {
        return {value: '', style: {}, innerText: '', innerHTML: '', children: [],
            classList: {toggle() {}, add() {}, remove() {}}, listeners: {}, click() { this.listeners.click?.({target:this}); }, remove() {},
            appendChild(child) { this.children.push(child); }, addEventListener(type, callback) { this.listeners[type] = callback; }, scrollIntoView() {}};
    }
    const audios = [];
    const revoked = [];
    const created = [];
    const body = element();
    const documentListeners = {};
    let performanceTime = 0;
    class Audio {
        constructor() { this.plays = 0; this.src = ''; audios.push(this); }
        async play() { this.plays++; }
        pause() {}
        load() {}
        removeAttribute() { this.src = ''; }
    }
    let now = 0;
    const delays = [];
    class Clock extends Date { static now() { return now; } }
    const context = vm.createContext({window: {}, location: {search: query}, URLSearchParams, Blob,
        navigator: {clipboard: {writeText: async text => { context.copied = text; }}},
        performance: {now: () => performanceTime}, document: {body, visibilityState: 'visible',
        addEventListener(type, callback) { documentListeners[type] = callback; },
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => []}, Audio, fetch, FormData, AbortController,
        DOMException, TypeError, URL: {createObjectURL: blob => { const url = `blob:${created.length}`; created.push({url, blob}); return url; }, revokeObjectURL: url => revoked.push(url)},
        Date: Clock, setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(() => { now += ms; fn(); }, 0); }, clearTimeout, alert() {}});
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    context.document.getElementById('voiceSelect').value = 'pl-PL-ZofiaNeural';
    context.document.getElementById('rateSlider').value = '0';
    return {run, context, elements, audios, delays, revoked, created, documentListeners, advance(ms) { performanceTime += ms; }};
}
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
function segments(text) {
    const h = harness(async () => ok());
    return Array.from(h.run(`splitSentences(${JSON.stringify(text)})`));
}
test('Polskie skróty, inicjały, liczby i cudzysłowy', () => {
    assert.deepEqual(segments('Dr. A. Kowalski mówi np. o godz. 12.30. „Tak!” Potem pyta: „Czy to działa?” Działa.'),
        ['Dr. A. Kowalski mówi np. o godz. 12.30.', '„Tak!”', 'Potem pyta: „Czy to działa?”', 'Działa.']);
    assert.deepEqual(segments('To jest 3.14 zł. Dalej... Tak?! Koniec.'), ['To jest 3.14 zł.', 'Dalej...', 'Tak?!', 'Koniec.']);
});
test('Skróty wieloczłonowe i polskie litery', () => {
    assert.deepEqual(segments('To m.in. św. Jan i prof. Nowak. Następne zdanie.'),
        ['To m.in. św. Jan i prof. Nowak.', 'Następne zdanie.']);
});
test('Ręczne wklejenie, akapity i białe znaki', () => {
    assert.deepEqual(segments('Pierwszy\nwiersz\n\nDrugi akapit\r\n\r\nTrzeci.'), ['Pierwszy wiersz Drugi akapit Trzeci.']);
    assert.deepEqual(segments(' \n\t\r\n'), []);
    const h = harness(async () => { throw Error('Nie powinno być żądania'); });
    h.context.document.getElementById('rawText').value = 'Pierwsze zdanie. Drugie zdanie.';
    h.run('window.applyText()');
    assert.deepEqual(Array.from(h.run('sentences')), ['Pierwsze zdanie.', 'Drugie zdanie.']);
});
test('Puste fragmenty nie wysyłają żądań', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return ok(); });
    h.run('sentences = ["", "  ", "Tekst."]');
    assert.equal(await h.run('fetchAudioBlob(0)'), null);
    assert.equal(calls, 0);
    h.run('window.startFrom(0)');
    await settle();
    assert.equal(h.run('currentIdx'), 2);
    assert.equal(calls, 1);
});
test('TTS ponawia po błędzie i zachowuje udany wynik', async () => {
    let calls = 0;
    const h = harness(async () => ++calls === 1 ? failed() : ok());
    h.run('sentences = ["Tekst."]');
    await h.run('fetchAudioBlob(0)');
    await h.run('fetchAudioBlob(0)');
    assert.equal(calls, 2);
});
test('Trzy próby i usunięcie błędu z cache', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return failed(); });
    h.run('sentences = ["Tekst."]');
    await assert.rejects(h.run('fetchAudioBlob(0)'), /Błąd syntezy/);
    assert.equal(calls, 3);
    assert.equal(h.run('prefetchCache.size'), 0);
    h.context.fetch = async () => { calls++; return ok(); };
    // An exhausted budget is reset only by explicit session restart.
    h.run('window.stopReading()');
    await h.run('fetchAudioBlob(0)');
    assert.equal(calls, 4);
});
test('Nie ponawia błędu danych HTTP 400', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return failed(400); });
    h.run('sentences = ["Tekst."]');
    await assert.rejects(h.run('fetchAudioBlob(0)'), /HTTP 400/);
    assert.equal(calls, 1);
});
test('Błąd sieci ma ograniczone ponowienia i komunikat', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; throw new TypeError('Network'); });
    h.run('sentences = ["Tekst."]');
    await assert.rejects(h.run('fetchAudioBlob(0)'), /Błąd komunikacji/);
    assert.equal(calls, 3);
});
test('Pauza podczas generowania i wznowienie', async () => {
    let resolve;
    const h = harness(() => new Promise(r => { resolve = r; }));
    h.run('sentences = ["Tekst."]; window.startFrom(0); window.togglePlay()');
    await settle();
    resolve(ok());
    await settle();
    assert.equal(h.run('audio.plays'), 0);
    assert.equal(h.run('isPaused'), true);
    h.run('window.togglePlay()');
    await settle();
    assert.equal(h.run('audio.plays'), 1);
});
test('Pauza na końcu zdania pozwala wznowić następne', async () => {
    const h = harness(async () => ok());
    h.run('sentences = ["Pierwsze.", "Drugie."]; window.startFrom(0)');
    await settle();
    h.run('window.togglePlay(); audio.onended(); window.togglePlay()');
    await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 2);
});
test('Spóźniona odpowiedź i stare zdarzenia nie zmieniają nowej sesji', async () => {
    const pending = [];
    const h = harness(() => new Promise(resolve => pending.push(resolve)));
    h.run('sentences = ["Stary."]; window.startFrom(0)');
    await settle();
    const oldPlayer = h.audios.at(-1);
    h.run('sentences = ["Nowy."]; window.startFrom(0)');
    await settle();
    assert.equal(pending.length, 1); // The old request still owns the queue.
    pending[0](ok());
    await settle();
    assert.equal(h.created.length, 0); // Stale audio was not cached.
    assert.equal(pending.length, 2);
    pending[1](ok());
    await settle();
    assert.equal(h.run('audio.src'), h.created[0].url);
    assert.equal(oldPlayer.plays, 0);
    assert.equal(h.run('audio.plays'), 1);
});
test('Awaryjne buffer=0 nie generuje następnego fragmentu przed końcem aktywnego', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return ok(); }, '?buffer=0');
    h.run('sentences = ["Pierwsze.", "Drugie."]; window.startFrom(0)');
    await settle();
    assert.equal(calls, 1);
    h.run('audio.onended()');
    await settle();
    assert.equal(calls, 2);
});
test('Błąd TTS zatrzymuje sesję i pozwala ponowić to samo zdanie', async () => {
    const h = harness(async () => failed(400));
    h.run('sentences = ["Tekst."]; window.startFrom(0)');
    await settle();
    assert.equal(h.run('isReading'), false);
    assert.match(h.context.document.getElementById('statusText').innerText, /wznowić ten sam fragment/);
    h.context.fetch = async () => ok();
    h.run('window.togglePlay()');
    await settle();
    assert.equal(h.run('currentIdx'), 0);
    assert.equal(h.run('audio.plays'), 1);
});
test('Stare zdarzenie zakończenia nie przeskakuje nowego zdania', async () => {
    const h = harness(async () => ok());
    h.run('sentences = ["Stare."]; window.startFrom(0)');
    await settle();
    const ended = h.run('audio.onended');
    h.run('sentences = ["Nowe.", "Kolejne."]; window.startFrom(0)');
    await settle();
    ended();
    assert.equal(h.run('currentIdx'), 0);
});
test('Błąd dekodowania audio jest obsłużony', async () => {
    const h = harness(async () => ok());
    h.run('sentences = ["Tekst."]; window.startFrom(0)');
    await settle();
    h.run('audio.onerror()');
    assert.equal(h.run('isReading'), false);
    assert.match(h.context.document.getElementById('statusText').innerText, /Nie można odtworzyć/);
});
test('Kolejne NoAudioReceived: 3 próby z przerwą, wznowienie tego samego fragmentu', async () => {
    let calls = 0;
    const h = harness(async () => {
        calls++;
        return {ok: false, status: 502, headers: {get: () => '10'},
            json: async () => ({error: 'Brak audio', code: 'no_audio', retryable: true})};
    });
    h.run('sentences = ["Pierwsze.", "Drugie."]; window.startFrom(0)');
    // Timer callbacks model virtual seconds without a real wait.
    for (let n = 0; n < 30; n++) await new Promise(r => setTimeout(r, 1));
    assert.equal(calls, 3);
    assert.deepEqual(h.delays, [10000, 10000]);
    assert.equal(h.run('currentIdx'), 0);
    assert.equal(h.run('isReading'), false);
    assert.match(h.context.document.getElementById('statusText').innerText, /Wyczerpano 3 próby/);
    h.context.fetch = async () => { calls++; return ok(); };
    h.run('window.togglePlay()');
    for (let n = 0; n < 10; n++) await new Promise(r => setTimeout(r, 1));
    assert.equal(calls, 5); // Resumed current fragment and one prefetched successor.
    assert.equal(h.run('currentIdx'), 0);
    assert.equal(h.delays.at(-1), 10000);
});
test('Zatrzymanie w czasie przerwy anuluje kolejne próby', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return failed(); });
    const timers = [];
    h.context.setTimeout = (callback, delay) => { timers.push(callback); return 1; };
    h.context.clearTimeout = () => {};
    h.run('sentences = ["Tekst."]; window.startFrom(0)');
    await settle();
    assert.equal(calls, 1);
    assert.equal(timers.length, 1);
    h.run('window.stopReading()');
    await settle();
    assert.equal(calls, 1);
    assert.equal(h.run('isReading'), false);
});
test('Odrzucenie dostawcy nie jest automatycznie ponawiane', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return {ok: false, status: 503,
        headers: {get: () => '30'}, json: async () => ({error: 'Odrzucono', retryable: false})}; });
    h.run('sentences = ["Tekst."]');
    await assert.rejects(h.run('fetchAudioBlob(0)'), /Odrzucono/);
    assert.equal(calls, 1);
    assert.equal(h.run('ttsNotBefore'), 30000);
});
test('Oczekiwanie pokazuje próbę i przerwę; pauza nie uruchamia audio', async () => {
    let calls = 0;
    const h = harness(async () => ++calls === 1 ? failed() : ok());
    const timers = [];
    h.context.setTimeout = callback => { timers.push(callback); return 1; };
    h.context.clearTimeout = () => {};
    h.run('sentences = ["Poprzednie.", "Bieżące."]; window.startFrom(1)');
    await settle();
    const status = h.context.document.getElementById('statusText');
    assert.match(status.innerText, /Oczekiwanie na TTS.*3 s.*próba 2\/3.*zdanie 2\/2/);
    h.run('window.togglePlay()');
    assert.equal(status.innerText, 'Wstrzymano');
    h.run('window.togglePlay()');
    assert.match(status.innerText, /Oczekiwanie na TTS/);
    h.run('window.togglePlay(); ttsNotBefore = 0');
    timers.shift()();
    await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 0);
    assert.equal(status.innerText, 'Wstrzymano');
    h.run('window.togglePlay()');
    await settle();
    assert.equal(calls, 2);
    assert.equal(h.run('audio.plays'), 1);
});
test('Dwie nieudane próby odtwarzają zdanie raz i przesuwają pozycję raz', async () => {
    let calls = 0;
    const h = harness(async () => ++calls <= 2 ? failed() : ok());
    h.run('sentences = ["Pierwsze.", "Drugie."]; window.startFrom(0)');
    await settle();
    assert.equal(calls, 4); // Three attempts of current + one prefetched successor.
    assert.equal(h.run('audio.plays'), 1);
    assert.equal(h.run('currentIdx'), 0);
    const ended = h.run('audio.onended');
    ended();
    ended();
    await settle();
    assert.equal(calls, 4);
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 2);
    h.run('audio.onended()');
    assert.equal(h.run('isReading'), false);
    assert.equal(h.run('currentIdx'), 2);
});
test('Przejście dalej podczas oczekiwania nie przywraca starego zdania', async () => {
    const texts = [];
    const h = harness(async (url, options) => {
        const text = options.body.get('text'); texts.push(text);
        return text === 'Pierwsze.' ? failed() : ok();
    });
    const timers = [];
    h.context.setTimeout = callback => { timers.push(callback); return timers.length; };
    h.context.clearTimeout = () => {};
    h.run('sentences = ["Pierwsze.", "Drugie."]; window.startFrom(0)');
    await settle();
    h.run('window.skip(1)');
    await settle();
    h.run('ttsNotBefore = 0');
    for (const callback of timers) callback();
    await settle();
    assert.deepEqual(texts, ['Pierwsze.', 'Drugie.']);
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 1);
});
test('TXT-01: rzeczywiste przykłady nie dzielą Risk Engine ani zdania po przecinku', () => {
    const risk='Wszystkie trzy dokumenty chcą deterministycznego Risk\n\nEngine z prawem veta…';
    assert.deepEqual(segments(risk), ['Wszystkie trzy dokumenty chcą deterministycznego Risk Engine z prawem veta…']);
    const percent='20 strategii szumu nie dowodzi «≤5% fałszywych przepuszczeń»,\n\na forward paper 3–6 miesięcy nie może rozstrzygnąć o przewadze…';
    assert.deepEqual(segments(percent), ['20 strategii szumu nie dowodzi «≤5% fałszywych przepuszczeń», a forward paper 3–6 miesięcy nie może rozstrzygnąć o przewadze…']);
});
test('TXT-01: numeracja, śródtytuły i listy bez kropek końcowych', () => {
    assert.deepEqual(segments('4.\n\nOcena ryzyka\n\nPełna wypowiedź trwa dalej.\n\n5. Kolejny punkt\n6. Następny punkt.'),
        ['4. Ocena ryzyka Pełna wypowiedź trwa dalej.', '5. Kolejny punkt', '6. Następny punkt.']);
    assert.deepEqual(segments('Wstęp\n\nPierwsza wypowiedź.\n\nWnioski\n\nDruga wypowiedź.'),
        ['Wstęp Pierwsza wypowiedź.', 'Wnioski Druga wypowiedź.']);
    assert.deepEqual(segments('Lista:\n- pierwszy element\n- drugi element\n- trzeci element'),
        ['Lista: - pierwszy element', '- drugi element', '- trzeci element']);
});
test('TXT-01: polska interpunkcja, techniczne oznaczenia i dialog', () => {
    const text='Dr. A. B. Kowalski pracuje np. na ul. Długiej, tj. w centrum. Wersja v1.2.3 ma próg 3.14%, zakres 3–6 i API/RFC-8259. To (np. wersja testowa; pytanie? nadal ta sama wypowiedź) działa. „Tak!”\n— powiedział autor. Dalej... ale bez końca. Koniec.';
    assert.deepEqual(segments(text), [
        'Dr. A. B. Kowalski pracuje np. na ul. Długiej, tj. w centrum.',
        'Wersja v1.2.3 ma próg 3.14%, zakres 3–6 i API/RFC-8259.',
        'To (np. wersja testowa; pytanie? nadal ta sama wypowiedź) działa.',
        '„Tak!” — powiedział autor.', 'Dalej... ale bez końca.', 'Koniec.'
    ]);
    assert.deepEqual(segments('To m.in. sp. z o.o. oraz narzędzia itd. Następne zdanie.'),
        ['To m.in. sp. z o.o. oraz narzędzia itd.', 'Następne zdanie.']);
});
test('TXT-01: układ oddzielony od tekstu mówionego, dokładna treść wysłana do TTS', async () => {
    const h=harness(async (url, options) => { h.sent.push(options.body.get('text')); return ok(); });
    h.sent=[];
    const input='Wszystkie trzy dokumenty chcą deterministycznego Risk\n\nEngine z prawem veta,\n\nbez pominięć.';
    h.run(`renderSentences(${JSON.stringify(input)})`);
    const spoken='Wszystkie trzy dokumenty chcą deterministycznego Risk Engine z prawem veta, bez pominięć.';
    assert.deepEqual(Array.from(h.run('sentences')), [spoken]);
    assert.equal(h.context.document.getElementById('readerView').children[0].innerText, input);
    h.run('window.startFrom(0)'); await settle();
    assert.deepEqual(h.sent,[spoken]);
    assert.deepEqual(spoken.split(/\s+/),input.split(/\s+/));
});
test('TXT-01: dokładna kolejność słów, pełne zdania i krótkie uzasadnione odpowiedzi', () => {
    const input='Pierwsza\n\nwypowiedź, nadal bez kropki.\n\nDruga wypowiedź. Tak. Nie!\n\n4.\n\nDalsza wypowiedź.';
    const out=segments(input);
    assert.deepEqual(out,['Pierwsza wypowiedź, nadal bez kropki.','Druga wypowiedź.','Tak.','Nie!','4. Dalsza wypowiedź.']);
    assert.deepEqual(out.join(' ').split(/\s+/),input.split(/\s+/));
    assert.ok(!out.some(item=> /^\d+\.$/.test(item)));
});
test('TXT-01: numer przepisu po zawinięciu wiersza nie staje się listą', () => {
    assert.deepEqual(segments('Zgodnie z art.\n4.\nust. 2. wymagamy kontroli. Następne zdanie.'),
        ['Zgodnie z art. 4. ust. 2. wymagamy kontroli.', 'Następne zdanie.']);
    assert.deepEqual(segments('Próg to 3. miejsce, nie 4. wynik. Data 14. 11. 2026 r. wymaga kontroli.'),
        ['Próg to 3. miejsce, nie 4. wynik.', 'Data 14. 11. 2026 r. wymaga kontroli.']);
});
test('TXT-02: dokładny przykład użytkownika i wszystkie pola w jednym wierszu', async () => {
    const expected=JSON.parse(fs.readFileSync('tests/fixtures/metadata_document.expected.json','utf8'));
    const original=fs.readFileSync('tests/fixtures/metadata_document.txt','utf8');
    assert.deepEqual(segments(original),expected);
    assert.deepEqual(segments(original.replace(/\s+/gu,' ')),expected);
    assert.deepEqual(segments(expected.join('\n\n')),expected);
    const captured=[];
    const h=harness(async(url, options)=>{captured.push(options.body.get('text'));return ok();});
    h.run(`renderSentences(${JSON.stringify(original)})`);
    const visible=h.context.document.getElementById('readerView').children.map(node=>node.innerText.replace(/\s+/gu,' ').trim());
    assert.deepEqual(visible,expected);
    for(let idx=0;idx<expected.length;idx++)await h.run(`fetchAudioBlob(${idx})`);
    assert.deepEqual(captured,expected);
    assert.equal(captured.join(' '),original.replace(/\s+/gu,' '));
    assert.ok(!captured[0].endsWith('.'));
    assert.ok(!captured[3].endsWith('.'));
});
test('TXT-02: nie rozdziela każdego dwukropka ani etykiet w zwykłej narracji',()=>{
    const cases=[
        'Wyjaśnienie: wybieramy Risk Engine, a nie inny moduł.',
        'Autor wyjaśnia: Status: gotowy, Data: nie została potwierdzona.',
        'Status: Warunek: A > B; wynik: bez wdrożeń',
        'Status: Raport opisuje „Data: 22 października” i termin „Autor: zespół”.',
        'Analiza zawiera zapis «Status: wstępny», ale to zwykła wypowiedź.'
    ];
    for(const text of cases)assert.deepEqual(segments(text),[text]);
    assert.deepEqual(segments('Uczestnicy: OpenAI (Status: test), Google (Gemini) Status: gotowe'),
        ['Uczestnicy: OpenAI (Status: test), Google (Gemini)','Status: gotowe']);
});
test('TXT-02: typowe etykiety, zachowane wartości i zawijanie metadanych',()=>{
    assert.deepEqual(segments('Autor: Zespół Data utworzenia: 2026-10-22 Wersja: 2.1 Status: Do weryfikacji'),
        ['Autor: Zespół','Data utworzenia: 2026-10-22','Wersja: 2.1','Status: Do weryfikacji']);
    assert.deepEqual(segments('Uczestnicy: OpenAI,\nAnthropic,\nGoogle\nStatus: Raport i rewizja\n\narchitektoniczna; bez wdrożeń'),
        ['Uczestnicy: OpenAI, Anthropic, Google','Status: Raport i rewizja architektoniczna; bez wdrożeń']);
});
test('TXT-02: pola nie pochłaniają analizy, Risk Engine ani pozycji 4.',()=>{
    const input='Data: 22 października 2026 r.\n\nAnaliza\n\nWszystkie dokumenty chcą Risk\n\nEngine z prawem veta.\n\n4.\n\nKontrola ryzyka\n\n20 strategii nie dowodzi «≤5% fałszywych przepuszczeń»,\n\na test wymaga czasu.';
    const expected=['Data: 22 października 2026 r.','Analiza Wszystkie dokumenty chcą Risk Engine z prawem veta.',
        '4. Kontrola ryzyka 20 strategii nie dowodzi «≤5% fałszywych przepuszczeń», a test wymaga czasu.'];
    assert.deepEqual(segments(input),expected);
    assert.equal(expected.join(' '),input.replace(/\s+/gu,' '));
});
test('TXT-02: po polu nie są wchłaniane alfabetyczne pozycje listy',()=>{
    const input='Status: Do analizy\n\na) Pierwszy warunek\nb) Drugi warunek';
    assert.deepEqual(segments(input),['Status: Do analizy','a) Pierwszy warunek','b) Drugi warunek']);
});
test('TXT-02: zwykłe słowa status, data i projekt nie wyznaczają granic',()=>{
    const cases=[
        'Status projektu zależy od danych, a data spotkania nie jest znana.',
        'Omawiamy status: projekt trwa, data: nadal nieustalona, projekt: bez zmian.',
        'W raporcie zapisano „status: roboczy, data: nieznana, projekt: w toku”.',
        'Status jest następujący: data nie została ustalona, projekt trwa.',
        'Wskazano projekt: Risk\n\nEngine, a status i data pozostają bez zmian.'
    ];
    for(const text of cases) {
        const expected=text.replace(/\s+/gu,' ');
        assert.deepEqual(segments(text),[expected]);
        assert.equal(segments(text).join(' '),expected);
    }
    assert.deepEqual(segments('Projekt wymaga ustalenia daty i statusu. To pełna wypowiedź.'),
        ['Projekt wymaga ustalenia daty i statusu.','To pełna wypowiedź.']);
});
test('Domyślny bufor i awaryjny przełącznik są niezależne od diagnostyki', () => {
    for (const [query, buffer, debug] of [
        ['',2,false], ['?buffer=0',0,false], ['?buffer=2',2,false],
        ['?test=1&buffer=0',0,true], ['?test=1&buffer=2',2,true],
        ['?test=1',2,true], ['?test=0',2,false], ['?test=0&buffer=0',0,false],
        ['?buffer=invalid',2,false], ['?buffer=',2,false]
    ]) {
        const h=harness(async()=>ok(),query);
        assert.equal(h.run('bufferMode'),buffer,query);
        assert.equal(h.run('diagnosticReport() !== null'),debug,query);
        assert.equal(h.context.document.body.children.length,debug ? 1 : 0,query);
    }
});
test('Zwykły adres przygotowuje dwa fragmenty bez panelu i bez duplikatów', async () => {
    const texts=[];
    const h=harness(async(url, options)=>{texts.push(options.body.get('text'));return ok();});
    h.run('sentences=["A.","B.","C.","D."]; window.startFrom(0)'); await settle();
    assert.deepEqual(texts,['A.','B.','C.']);
    assert.equal(h.run('audio.plays'),1);
    assert.equal(h.run('diagnosticReport()'),null);
    assert.equal(h.context.document.body.children.length,0);
    h.run('audio.onended()'); await settle();
    assert.deepEqual(texts,['A.','B.','C.','D.']);
    assert.equal(h.run('audio.plays'),2);
    h.run('window.stopReading()');
});
test('Buffer=2: kolejka sekwencyjna i deduplikacja z promocją aktywnego zadania', async () => {
    const pending = [];
    const texts = [];
    let active = 0, maxActive = 0;
    const h = harness((url, options) => {
        active++; maxActive = Math.max(active, maxActive);
        texts.push(options.body.get('text'));
        return new Promise(resolve => pending.push(() => { active--; resolve(ok()); }));
    }, '?test=1&buffer=2');
    h.run('sentences = ["A.", "B.", "C.", "D."]; window.startFrom(0)');
    await settle();
    pending.shift()();
    await settle();
    assert.equal(texts.length, 2);
    const duplicate = h.run('fetchAudioBlob(1)');
    pending.shift()();
    await duplicate;
    await settle();
    assert.equal(texts.length, 3);
    pending.shift()();
    await settle();
    assert.equal(maxActive, 1);
    assert.deepEqual(texts, ['A.', 'B.', 'C.']);
    assert.equal(h.run('prefetchCache.size'), 3);
    assert.equal(h.run('audio.plays'), 1);
    const end = h.run('audio.onended');
    end(); end();
    await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 2);
    h.run('window.stopReading()');
    if (pending.length) pending.shift()();
    await settle();
});
test('Prefetch nie ma własnego cyklu ponowień: wspólny limit trzech NoAudioReceived', async () => {
    let a = 0, b = 0;
    const h = harness(async (url, options) => {
        if (options.body.get('text') === 'A.') { a++; return ok(); }
        b++;
        return {ok: false, status: 502, headers: {get: () => '10'},
            json: async () => ({error: 'Brak audio', retryable: true, code: 'no_audio'})};
    }, '?test=1&buffer=2');
    h.run('sentences = ["A.", "B.", "C."]; window.startFrom(0)');
    await settle();
    assert.equal(b, 1);
    assert.equal(h.run('isReading'), true);
    assert.equal(h.run('audio.plays'), 1);
    h.run('audio.onended()');
    await settle();
    assert.equal(b, 3);
    assert.equal(a, 1);
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('isReading'), false);
    assert.equal(h.run('diagnosticReport().failed_transitions'), 1);
    assert.match(h.context.document.getElementById('statusText').innerText, /Wyczerpano 3 próby/);
});
test('Odrzucenie dostawcy w prefetch nie uruchamia prób przy odtwarzaniu', async () => {
    let b = 0;
    const h = harness(async (url, options) => {
        if (options.body.get('text') === 'A.') return ok();
        b++;
        return {ok:false, status:503, headers:{get:()=> '120'}, json:async()=>({error:'Odrzucono',retryable:false})};
    }, '?test=1&buffer=2');
    h.run('sentences = ["A.", "B."]; window.startFrom(0)');
    await settle();
    assert.equal(h.run('isReading'), true);
    h.run('audio.onended()');
    await settle();
    assert.equal(b, 1);
    assert.equal(h.run('ttsNotBefore'), 120000);
    assert.equal(h.run('currentIdx'), 1);
});
test('Stop podczas prefetch anuluje sygnał, a późna odpowiedź nie tworzy URL', async () => {
    let finish, signal;
    const h = harness((url, options) => {
        if (options.body.get('text') === 'A.') return Promise.resolve(ok());
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    }, '?test=1&buffer=2');
    h.run('sentences = ["A.", "B.", "C."]; window.startFrom(0)');
    await settle();
    assert.equal(h.created.length, 1);
    h.run('window.stopReading()');
    assert.equal(signal.aborted, true);
    finish(ok());
    await settle();
    assert.equal(h.created.length, 1);
    assert.equal(h.revoked.length, 1);
    assert.equal(h.run('prefetchCache.size'), 0);
    assert.equal(h.run('jobs.size'), 0);
});
test('Zmiana pozycji ignoruje starą odpowiedź prefetch', async () => {
    let finish;
    const h = harness((url, options) => options.body.get('text') === 'B.'
        ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ok()), '?test=1&buffer=2');
    h.run('sentences = ["A.", "B.", "C."]; window.startFrom(0)');
    await settle();
    h.run('window.startFrom(2)');
    await settle();
    assert.equal(h.run('audio.src'), '');
    finish(ok());
    await settle();
    assert.equal(h.run('currentIdx'), 2);
    assert.equal(h.run('audio.src'), h.created.at(-1).url);
    assert.equal(h.run('audio.plays'), 1);
});
test('Zmiana głosu i tempa anuluje przygotowanie i zachowuje pauzę oraz indeks', async () => {
    const calls = [];
    let finish, oldSignal;
    const h = harness((url, options) => {
        const data = Object.fromEntries(options.body);
        calls.push(data);
        if (data.text === 'B.' && data.voice === 'pl-PL-ZofiaNeural') {
            oldSignal = options.signal;
            return new Promise(resolve => { finish = resolve; });
        }
        return Promise.resolve(ok());
    }, '?test=1&buffer=2');
    h.run('sentences = ["A.", "B."]; window.startFrom(0)');
    await settle();
    h.run('window.togglePlay()');
    const voice = h.context.document.getElementById('voiceSelect');
    voice.value = 'pl-PL-MarekNeural';
    voice.listeners.change();
    await settle();
    assert.equal(oldSignal.aborted, true);
    assert.equal(h.run('isPaused'), true);
    assert.equal(h.run('audio.plays'), 0);
    finish(ok());
    const rate = h.context.document.getElementById('rateSlider');
    rate.value = '20'; rate.listeners.change();
    await settle();
    assert.equal(h.run('currentIdx'), 0);
    assert.equal(h.run('isPaused'), true);
    assert.equal(h.run('audio.plays'), 0);
    assert.equal(calls.at(-1).voice, 'pl-PL-MarekNeural');
    assert.equal(calls.at(-1).rate, '20');
    h.run('window.togglePlay()');
    await settle();
    assert.equal(h.run('audio.plays'), 1);
});
test('Pauza podczas prefetch blokuje dalsze uzupełnianie i odtwarzanie', async () => {
    let finish;
    const texts = [];
    const h = harness((url, options) => {
        const text = options.body.get('text'); texts.push(text);
        if (text === 'B.') return new Promise(resolve => { finish = resolve; });
        return Promise.resolve(ok());
    }, '?test=1&buffer=2');
    h.run('sentences = ["A.", "B.", "C."]; window.startFrom(0)');
    await settle();
    h.run('window.togglePlay()');
    finish(ok());
    await settle();
    assert.deepEqual(texts, ['A.', 'B.']);
    assert.equal(h.run('audio.plays'), 1);
    assert.equal(h.run('isPaused'), true);
    h.run('window.togglePlay()');
    await settle();
    assert.deepEqual(texts, ['A.', 'B.', 'C.']);
});
test('Limity cache i URL: aktywny plik chroniony, odsłuchany zwalniany', async () => {
    const h = harness(async () => ({ok:true, blob:async()=>({size:3*1024*1024})}), '?test=1&buffer=2');
    h.run('sentences = ["A.", "B.", "C.", "D."]; window.startFrom(0)');
    await settle();
    assert.ok(h.run('cacheBytes()') <= 8*1024*1024);
    assert.ok(h.run('prefetchCache.size') <= 3);
    const activeUrl = h.run('audio.src');
    assert.ok(!h.revoked.includes(activeUrl));
    h.run('audio.onended()');
    await settle();
    assert.ok(h.revoked.includes(activeUrl));
    assert.ok(!h.revoked.includes(h.run('audio.src')));
    assert.ok(h.run('cacheBytes()') <= 8*1024*1024);
    h.run('window.stopReading()');
    await settle();
    assert.equal(h.run('cacheBytes()'), 0);
    assert.deepEqual([...new Set(h.revoked)].sort(), h.created.map(c=>c.url).sort());
});
test('Zbyt duży pojedynczy fragment nie przekracza limitu cache', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return {ok:true,blob:async()=>({size:9*1024*1024})}; });
    h.run('sentences = ["A."]; window.startFrom(0)');
    await settle();
    assert.equal(calls, 1);
    assert.equal(h.created.length, 0);
    assert.equal(h.run('cacheBytes()'), 0);
    assert.equal(h.run('isReading'), false);
});
test('Długi odczyt utrzymuje ograniczone cache i zwalnia wszystkie URL', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=2');
    h.run('sentences = Array.from({length:30}, (_,i) => "Zdanie " + i); window.startFrom(0)');
    for (let i=0; i<30; i++) {
        await settle();
        assert.ok(h.run('prefetchCache.size') <= 3);
        assert.ok(h.run('jobs.size') <= 3);
        assert.equal(h.run('currentIdx'), i);
        h.run('audio.onended()');
    }
    await settle();
    assert.equal(h.run('isReading'), false);
    assert.equal(h.created.length, 30);
    assert.equal(h.revoked.length, 30);
});
test('Raport mierzy playing zamiast play(), statystyki i widoczność bez tekstu', async () => {
    const secret = 'TAJNY DOKUMENT test@example.com';
    const h = harness(async()=>ok(), '?test=1&buffer=2');
    h.context.document.getElementById('rawText').value = secret;
    h.run(`sentences = Array(5).fill(${JSON.stringify(secret)}); window.startFrom(0)`);
    await settle();
    h.run('audio.onplaying()');
    for (const gap of [100,300,200,400]) {
        h.run('audio.onended()');
        await settle();
        h.advance(gap);
        h.run('audio.onplaying(); audio.onplaying()');
    }
    const report = h.run('diagnosticReport()');
    assert.equal(report.gaps.count, 4);
    assert.equal(report.gaps.median_ms, 250);
    assert.equal(report.gaps.p95_ms, 400);
    assert.equal(report.gaps.max_ms, 400);
    assert.equal(report.groups['buffer=2/visible'].count, 4);
    assert.ok(report.buffer_hits > 0);
    assert.ok(report.buffer_misses > 0);
    assert.equal(report.failed_transitions, 0);
    const json = JSON.stringify(report);
    assert.ok(!json.includes(secret));
    assert.ok(!json.includes('example.com'));
    assert.ok(!json.includes('blob:'));
    assert.ok(!json.includes('pl-PL'));
    assert.ok(report.events.some(e=>e.type==='fetch_start'));
    assert.ok(report.events.some(e=>e.type==='fetch_end'));
    assert.ok(report.events.some(e=>e.type==='play_call'));
    h.run('audio.onwaiting(); audio.onstalled()');
    h.context.document.visibilityState = 'hidden'; h.documentListeners.visibilitychange();
    assert.ok(h.run('diagnosticReport().events').some(e=>e.type==='visibility'));
    const copy = h.context.document.getElementById('diagnosticCopy');
    await copy.listeners.click();
    assert.equal(JSON.parse(h.context.copied).schema, 'MOB-03A/1');
    h.context.document.getElementById('diagnosticDownload').click();
    const exported = h.created.at(-1);
    assert.equal(JSON.parse(await exported.blob.text()).schema, 'MOB-03A/1');
    assert.ok(!JSON.stringify(JSON.parse(await exported.blob.text())).includes(secret));
});
test('Raport rozdziela hidden/mixed i niedokończone lub anulowane przejścia', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=0');
    h.context.document.visibilityState = 'hidden';
    h.run('sentences = ["A.", "B.", "C.", "D."]; window.startFrom(0)');
    await settle(); h.run('audio.onplaying(); audio.onended()');
    await settle();
    assert.ok(h.run('diagnosticReport().pending_transition'));
    h.advance(75); h.run('audio.onplaying(); audio.onended()');
    h.context.document.visibilityState='visible'; h.documentListeners.visibilitychange();
    h.context.document.visibilityState='hidden'; h.documentListeners.visibilitychange();
    await settle(); h.advance(125); h.run('audio.onplaying(); audio.onended()');
    h.run('window.togglePlay()');
    await settle();
    const report=h.run('diagnosticReport()');
    assert.equal(report.groups['buffer=0/hidden'].median_ms, 75);
    assert.equal(report.groups['buffer=0/mixed'].median_ms, 125);
    assert.equal(report.cancelled_transitions, 1);
    assert.equal(report.pending_transition, null);
});
test('Przełącznik bufora i zmiana dokumentu czyszczą poprzednią sesję', async () => {
    const h=harness(async()=>ok(), '?test=1&buffer=2');
    h.run('sentences=["A.","B.","C."]; window.startFrom(0)');
    await settle();
    const select=h.context.document.getElementById('diagnosticBuffer');
    select.value='0'; select.listeners.change({target:select});
    assert.equal(h.run('bufferMode'),0);
    assert.equal(h.run('isReading'),false);
    assert.equal(h.run('prefetchCache.size'),0);
    h.run('renderSentences("Nowy dokument.")');
    assert.equal(h.run('jobs.size'),0);
    assert.equal(h.run('currentIdx'),0);
    h.run('window.togglePlay()'); await settle();
    assert.equal(h.run('prefetchCache.size'),1);
});
test('Kolejka pozostaje pojedyncza także przy szybkim stop/start i późnym body', async () => {
    let finishBody, active = 0, maximum = 0;
    const texts = [];
    const h = harness(async (url, options) => {
        active++; maximum = Math.max(maximum, active);
        texts.push(options.body.get('text'));
        if (texts.length === 1) return {ok: true, blob: () => new Promise(resolve => {
            finishBody = () => {active--; resolve({size:10});};
        })};
        active--; return ok();
    }, '?test=1&buffer=2');
    h.run('sentences=["A.","B.","C."]; window.startFrom(0)');
    await settle();
    h.run('window.skip(1); window.skip(1)');
    await settle();
    assert.deepEqual(texts, ['A.']);
    finishBody(); await settle();
    assert.deepEqual(texts, ['A.', 'C.']);
    assert.equal(maximum, 1);
    assert.equal(h.created.length, 1);
    assert.equal(h.run('audio.plays'), 1);
    assert.equal(h.run('currentIdx'), 2);
});
test('Bieżący fragment ma pierwszeństwo przed oczekującym prefetch', async () => {
    const pending = [], texts = [];
    const h = harness((url, options) => {
        texts.push(options.body.get('text'));
        return new Promise(resolve => pending.push(resolve));
    }, '?test=1&buffer=2');
    h.run('sentences=["A.","B.","C."]; isReading=true');
    const a = h.run('fetchAudioBlob(0)'); await settle();
    const c = h.run('fetchAudioBlob(2, controller.signal, false)');
    const b = h.run('fetchAudioBlob(1)');
    pending.shift()(ok()); await a; await settle();
    assert.deepEqual(texts, ['A.', 'B.']);
    pending.shift()(ok()); await b; await settle();
    assert.deepEqual(texts, ['A.', 'B.', 'C.']);
    pending.shift()(ok()); await c;
    h.run('window.stopReading()');
});
test('Promocja trwającego prefetch: brak duplikatu, wspólne próby i jedno odtworzenie', async () => {
    let finish, b = 0;
    const h = harness(async (url, options) => {
        if (options.body.get('text') !== 'B.') return ok();
        b++;
        if (b === 1) return new Promise(resolve => {finish = resolve;});
        return b === 2 ? failed() : ok();
    }, '?test=1&buffer=2');
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    h.run('audio.onended()'); await settle();
    assert.equal(b, 1);
    finish(failed()); await settle();
    assert.equal(b, 3);
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 2);
    const ended = h.run('audio.onended'); ended(); ended();
    assert.equal(h.run('currentIdx'), 2);
});
test('Promocja prefetch podczas cooldown pokazuje oczekiwanie i zachowuje pauzę', async () => {
    let calls = 0;
    const h = harness(async () => {calls++; return ok();}, '?test=1&buffer=2');
    const timers = [];
    h.context.setTimeout = fn => {timers.push(fn); return 1;};
    h.context.clearTimeout = () => {};
    h.run('sentences=["A.","B."]; window.startFrom(0)');
    // Hold the next request behind a cooldown once A has started playing.
    await settle();
    h.run('window.stopReading(); ttsNotBefore=12000; isReading=true; currentIdx=1');
    const prefetched = h.run('fetchAudioBlob(1,controller.signal,false)');
    await settle();
    const foreground = h.run('fetchAudioBlob(1)');
    assert.equal(prefetched, foreground);
    assert.match(h.elements.get('statusText').innerText, /Oczekiwanie.*12 s.*próba 1\/3/);
    h.run('isPaused=true; showGenerationStatus()');
    h.run('ttsNotBefore=0'); timers.shift()();
    await foreground;
    assert.equal(h.run('audio.plays'), 0);
    h.run('window.stopReading()');
});
test('Spóźnione odrzucenie play() poprzedniego zdania nie zatrzymuje następnego', async () => {
    let rejectPlay;
    const h = harness(async () => ok(), '?test=1&buffer=2');
    h.run('sentences=["A.","B."]; window.startFrom(0)');
    h.run('audio').play = () => new Promise((resolve, reject) => {rejectPlay=reject;});
    await settle();
    h.run('audio').play = async () => {};
    const staleError = h.run('audio.onerror');
    h.run('audio.onended()'); await settle();
    rejectPlay(new Error('Late play rejection')); staleError(); await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('isReading'), true);
});
test('Błąd odbierania body kończy pomiar fetch i nie ujawnia komunikatu w raporcie', async () => {
    const secret='PRIVATE CONTENT test@example.com';
    const h = harness(async()=>({ok:true,blob:async()=>{throw new TypeError(secret);}}), '?test=1&buffer=0');
    h.run('sentences=["A."]; window.startFrom(0)'); await settle();
    const report=h.run('diagnosticReport()');
    assert.equal(report.events.filter(e=>e.type==='fetch_start').length,3);
    assert.equal(report.events.filter(e=>e.type==='fetch_end').length,3);
    assert.ok(report.events.some(e=>e.type==='tts_error' && e.code==='communication_error'));
    assert.ok(!JSON.stringify(report).includes(secret));
});
test('Diagnostyka nie rośnie bez ograniczeń i nie zachowuje tekstu błędów HTTP', async () => {
    const secret='SECRET test@example.com';
    const h = harness(async()=>({ok:false,status:400,headers:{get:()=>null},
        json:async()=>({error:secret,code:secret,retryable:false})}), '?test=1&buffer=0');
    h.run('sentences=["A."]; window.startFrom(0)'); await settle();
    assert.ok(!JSON.stringify(h.run('diagnosticReport()')).includes(secret));
    h.run(`for(let i=0;i<2100;i++) {
        trace('waiting');
        transition={ended:performance.now(),from:0,to:1,visibility:'visible',buffer:0};
        finishTransition('playing');
    }`);
    const report=h.run('diagnosticReport()');
    assert.equal(report.events.length,2000);
    assert.equal(report.gaps.count,2000);
    assert.equal(report.dropped_gap_samples,100);
    assert.ok(report.dropped_events>0);
});
test('Brak miejsca po udanym prefetch nie pomniejsza budżetu późniejszej syntezy', async () => {
    let b=0;
    const h=harness(async(url,options)=>{
        if(options.body.get('text')==='A.')return {ok:true,blob:async()=>({size:7*1024*1024})};
        b++;
        return b===2 || b===3 ? failed() : {ok:true,blob:async()=>({size:2*1024*1024})};
    },'?test=1&buffer=2');
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    const token=h.run('session');
    assert.equal(b,1);
    assert.equal(h.run('prefetchCache.size'),1); // B succeeded but could not fit beside A.
    h.run('audio.onended()'); await settle();
    assert.equal(b,4); // Successful discarded prefetch + 3 attempts of the new synthesis.
    assert.equal(h.run('session'),token);
    assert.equal(h.run('isReading'),true);
    assert.equal(h.run('audio.plays'),2);
    assert.equal(h.run('currentIdx'),1);
    assert.ok(h.run('cacheBytes()')<=8*1024*1024);
    h.run('window.stopReading()');
});
test('Udana trzecia próba, usunięcie URL i ponowna synteza bez restartu sesji', async () => {
    let calls=0;
    const h=harness(async()=>++calls % 3 === 0 ? ok() : failed(), '?test=1&buffer=2');
    h.run('sentences=["A."]');
    const token=h.run('session');
    const first=await h.run('fetchAudioBlob(0)');
    assert.equal(calls,3);
    assert.equal(h.run('releaseJob([...jobs.values()][0])'),true);
    assert.ok(h.revoked.includes(first));
    assert.equal(h.run('jobs.size'),1);
    const second=await h.run('fetchAudioBlob(0)');
    assert.equal(calls,6);
    assert.notEqual(second,first);
    assert.equal(h.run('session'),token);
    h.run('window.stopReading()');
});
test('Usunięcie udanego audio nie daje nieskończonych prób po nowym błędzie', async () => {
    let calls=0;
    const h=harness(async()=>++calls === 1 ? ok() : failed(), '?test=1&buffer=2');
    h.run('sentences=["A."]');
    await h.run('fetchAudioBlob(0)');
    h.run('releaseJob([...jobs.values()][0])');
    const token=h.run('session');
    await assert.rejects(h.run('fetchAudioBlob(0)'),/Wyczerpano 3 próby/);
    assert.equal(calls,4);
    await assert.rejects(h.run('fetchAudioBlob(0)'),/Wyczerpano 3 próby/);
    assert.equal(calls,4);
    assert.equal(h.run('session'),token);
});
(async () => {
    for (const [name, fn] of cases) {
        await fn();
        console.log(`OK: ${name}`);
    }
    console.log(`${cases.length} testów JavaScript zakończonych powodzeniem.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
