const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const script = fs.readFileSync(0, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let n = 0; n < 12; n++) await tick(); }
const ok = () => ({ok: true, blob: async () => ({size: 10})});
const failed = (status = 502) => ({ok: false, status, json: async () => ({error: 'Błąd syntezy'})});
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
    const context = vm.createContext({window: {}, document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => []}, Audio, fetch, FormData, AbortController,
        DOMException, TypeError, URL: {createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL() {}},
        setTimeout: fn => setTimeout(fn, 0), clearTimeout, alert() {}});
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    context.document.getElementById('voiceSelect').value = 'pl-PL-ZofiaNeural';
    context.document.getElementById('rateSlider').value = '0';
    return {run, context, elements, audios};
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
    assert.deepEqual(segments('Pierwszy\nwiersz\n\nDrugi akapit\r\n\r\nTrzeci.'), ['Pierwszy wiersz', 'Drugi akapit', 'Trzeci.']);
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
    const oldPlayer = h.audios.at(-1);
    h.run('sentences = ["Nowy."]; window.startFrom(0)');
    pending[1](ok());
    await settle();
    const newSource = h.run('audio.src');
    pending[0](ok());
    await settle();
    assert.equal(h.run('audio.src'), newSource);
    assert.equal(oldPlayer.plays, 0);
    assert.equal(h.run('audio.plays'), 1);
});
test('Błąd prefetch nie blokuje następnego zdania', async () => {
    let failNext = true;
    const h = harness(async (url, options) => options.body.get('text') === 'Drugie.' && failNext ? failed(400) : ok());
    h.run('sentences = ["Pierwsze.", "Drugie."]; window.startFrom(0)');
    await settle();
    failNext = false;
    h.run('audio.onended()');
    await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.run('audio.plays'), 2);
});
test('Błąd TTS zatrzymuje sesję i pozwala ponowić to samo zdanie', async () => {
    const h = harness(async () => failed(400));
    h.run('sentences = ["Tekst."]; window.startFrom(0)');
    await settle();
    assert.equal(h.run('isReading'), false);
    assert.match(h.context.document.getElementById('statusText').innerText, /ponowić bieżące zdanie/);
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
(async () => {
    for (const [name, fn] of cases) {
        await fn();
        console.log(`OK: ${name}`);
    }
    console.log(`${cases.length} testów JavaScript zakończonych powodzeniem.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
