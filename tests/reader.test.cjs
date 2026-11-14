const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const script = fs.readFileSync(0, 'utf8');
async function settle() { for (let n = 0; n < 12; n++) await new Promise(r => setTimeout(r, 1)); }
const ok = () => ({ok: true, blob: async () => ({size: 10})});
const failed = (status = 502) => ({ok: false, status, headers: {get: () => null}, json: async () => ({error: 'Błąd syntezy'})});
function harness(fetch) {
    const elements = new Map();
    function element() {
        return {value: '', style: {}, innerText: '', innerHTML: '', children: [],
            classList: {toggle() {}, add() {}, remove() {}},
            appendChild(child) { this.children.push(child); }, addEventListener() {}, scrollIntoView() {}};
    }
    const audios = [];
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
    const context = vm.createContext({window: {}, document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => []}, Audio, fetch, FormData, AbortController,
        DOMException, TypeError, URL: {createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL() {}},
        Date: Clock, setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(() => { now += ms; fn(); }, 0); }, clearTimeout, alert() {}});
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    context.document.getElementById('voiceSelect').value = 'pl-PL-ZofiaNeural';
    context.document.getElementById('rateSlider').value = '0';
    return {run, context, elements, audios, delays};
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
    pending[1](ok());
    await settle();
    const newSource = h.run('audio.src');
    pending[0](ok());
    await settle();
    assert.equal(h.run('audio.src'), newSource);
    assert.equal(oldPlayer.plays, 0);
    assert.equal(h.run('audio.plays'), 1);
});
test('Nie generuje następnego fragmentu przed końcem aktywnego', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return ok(); });
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
    assert.equal(calls, 4);
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
    assert.equal(calls, 3);
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
(async () => {
    for (const [name, fn] of cases) {
        await fn();
        console.log(`OK: ${name}`);
    }
    console.log(`${cases.length} testów JavaScript zakończonych powodzeniem.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
