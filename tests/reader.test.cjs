const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const script = fs.readFileSync(0, 'utf8');
const ocrModule = fs.readFileSync('ocr_prototype/app-ocr.js', 'utf8');
async function settle() { for (let n = 0; n < 12; n++) await new Promise(r => setTimeout(r, 1)); }
const ok = () => ({ok: true, blob: async () => ({size: 10, arrayBuffer: async () => new ArrayBuffer(10)})});
const failed = (status = 502) => ({ok: false, status, headers: {get: () => null}, json: async () => ({error: 'Błąd syntezy'})});
function latestDocument(idb) { return [...idb.data.values()].filter(item=>item.id!=='last')
    .sort((a,b)=>(b.lastUsedAt||b.savedAt||0)-(a.lastUsedAt||a.savedAt||0))[0]; }
function namedDocument(idb, name) { return [...idb.data.values()].find(item=>item.name===name); }
function memoryIndexedDB() {
    const data = new Map();
    const sessions = new Map();
    const stores = new Map([['documents', data]]);
    const control = {data, sessions, stores, failWrites: 0, holdNextReadwriteGet: false, releaseHeldRead: null,
        holdReadonlyGetKey: null, releaseHeldReadonlyGet: null, holdNextReadwriteDelete: false, releaseHeldDelete: null,
        oldVersion: 0, simulateUpgradeAbort: false};
    function objectStore(name, mode, tx) {
        const records = stores.get(name);
        return {
            indexNames: {contains: () => false}, createIndex() {},
            get(key) {
                const request = {};
                const run = () => schedule(() => { request.result = records.get(key) || null; request.onsuccess?.(); }, tx);
                if (mode === 'readwrite' && control.holdNextReadwriteGet) {
                    control.holdNextReadwriteGet = false;
                    control.releaseHeldRead = run;
                } else if (mode === 'readonly' && control.holdReadonlyGetKey === key) {
                    control.holdReadonlyGetKey = null;
                    control.releaseHeldReadonlyGet = run;
                } else run();
                return request;
            },
            getAll() {
                const request = {};
                schedule(() => { request.result = Array.from(records.values()); request.onsuccess?.(); }, tx);
                return request;
            },
            put(record) {
                const request = {};
                schedule(() => {
                    if (control.failWrites) {
                        control.failWrites--;
                        tx.error = Object.assign(new Error('quota exceeded'), {name: 'QuotaExceededError'});
                        tx.onerror?.(); tx.onabort?.(); request.onerror?.();
                    } else { records.set(record.id, JSON.parse(JSON.stringify(record))); request.result = record.id; request.onsuccess?.(); }
                }, tx);
                return request;
            },
            delete(key) {
                const run=()=>schedule(()=>{records.delete(key);},tx);
                if (mode !== 'readonly' && control.holdNextReadwriteDelete) {
                    control.holdNextReadwriteDelete=false;
                    control.releaseHeldDelete=run;
                } else run();
            }
        };
    }
    function schedule(callback, tx) {
        tx.pending++;
        setTimeout(() => { callback(); tx.pending--; completeWhenIdle(tx); }, 0);
    }
    function completeWhenIdle(tx) {
        if (!tx.pending && !tx.completionScheduled) {
            tx.completionScheduled=true;
            setTimeout(() => { tx.completionScheduled=false; if (!tx.pending) tx.oncomplete?.(); }, 0);
        }
    }
    const db = {
        objectStoreNames: {contains: name => stores.has(name)},
        createObjectStore(name) { const map=new Map(); stores.set(name,map); if(name==='documents')control.data=map;if(name==='sessions')control.sessions=map; return objectStore(name,'versionchange',{pending:0}); },
        transaction(name, mode) {
            const tx = {error: null, pending:0, completionScheduled:false, objectStore: storeName => objectStore(storeName,mode,tx)};
            setTimeout(()=>completeWhenIdle(tx),0);
            return tx;
        }
    };
    const upgradeTx = {error:null,pending:0,completionScheduled:false,objectStore: storeName=>objectStore(storeName,'versionchange',upgradeTx)};
    db.createObjectStore = (name, options) => {
        const map=new Map(); stores.set(name,map); if(name==='documents')control.data=map;if(name==='sessions')control.sessions=map;
        return {indexNames:{contains:()=>false},createIndex(){}, ...objectStore(name,'versionchange',upgradeTx)};
    };
    let upgraded = false;
    return Object.assign(control, {open() {
        const request = {};
        request.transaction=upgradeTx;
        request.oldVersion=control.oldVersion || (data.has('last') ? 1 : 0);
        setTimeout(() => {
            request.result = db;
            if (!upgraded && !control.simulateUpgradeAbort) { upgraded = true; request.onupgradeneeded?.({oldVersion:request.oldVersion}); }
            setTimeout(()=>{
                if (control.simulateUpgradeAbort) { upgraded=false; request.onerror?.(); return; }
                request.onsuccess?.();
            }, 5);
        }, 0);
        return request;
    }});
}
function harness(fetch, query = '', withMediaSession = true, mseSupport = null, indexedDBApi = null, ocrOptions = {}) {
    const elements = new Map();
    function element() {
        const classes = new Set();
        return {value: '', style: {}, innerText: '', innerHTML: '', children: [], hidden: false, attributes: {}, clickCount: 0,
            classList: {toggle(name, force) { const active=force === undefined ? !classes.has(name) : !!force; if(active)classes.add(name);else classes.delete(name);return active; }, add(name) { classes.add(name); }, remove(...names) { names.forEach(name=>classes.delete(name)); }, contains(name) { return classes.has(name); }},
            listeners: {}, click() { this.clickCount++; this.onclick?.({target:this}); this.listeners.click?.({target:this}); }, remove() {},
            focus() { this.focused = true; }, setAttribute(name,value) { this.attributes[name]=String(value); },
            showModal() { this.showModalCalls=(this.showModalCalls||0)+1; if(this.hidden)throw Error('dialog_hidden'); this.open=true; }, close() { this.open=false; this.listeners.close?.({target:this}); },
            dispatch(type, event={}) { this.listeners[type]?.({type,target:this,...event}); },
            appendChild(child) { this.children.push(child); }, addEventListener(type, callback) { this.listeners[type] = callback; }, scrollIntoView() { this.scrollCount=(this.scrollCount||0)+1; }};
    }
    const audios = [];
    const revoked = [];
    const created = [];
    const body = element();
    const documentListeners = {};
    const windowListeners = {};
    const mediaActions = {};
    const mediaSession = {playbackState: 'none', metadata: null,
        setActionHandler(action, callback) { mediaActions[action] = callback; }};
    const mediaSources = [];
    const sourceBuffers = [];
    let performanceTime = 0;
    class Audio {
        constructor() { this.plays = 0; this._src = ''; this.paused = true; this.ended = false;
            this.currentTime = 0; this.duration = 12; this.readyState = 4; this.networkState = 1;
            this.playbackRate = 1; this.listeners = {}; audios.push(this); }
        get src() { return this._src; }
        set src(value) {
            this._src = value;
            if (value.startsWith('mse:')) setTimeout(() => {
                const source = mediaSources.find(item => item.url === value);
                if (source) { source.readyState = 'open'; source.dispatchEvent(new Event('sourceopen')); }
            }, 0);
        }
        async play() { this.plays++; this.paused = false; }
        pause() { this.paused = true; this.dispatch('pause'); }
        load() { this.loads = (this.loads || 0) + 1; }
        removeAttribute() { this.src = ''; }
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
        dispatch(type) { for (const callback of this.listeners[type] || []) callback({type}); }
    }
    class SourceBuffer {
        constructor() { this.mode = 'segments'; this.updating = false; this.listeners = {}; this.ranges = []; sourceBuffers.push(this); }
        get buffered() { const ranges = this.ranges; return {length:ranges.length, start:i=>ranges[i].start, end:i=>ranges[i].end}; }
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
        emit(type) { for (const callback of this.listeners[type] || []) callback({type}); }
        appendBuffer() {
            if (mseSupport === 'append_error') throw new Error('AppendError');
            this.updating = true;
            setTimeout(() => { const end=this.ranges.at(-1)?.end || 0; this.ranges.push({start:end,end:end+10}); this.updating=false; this.emit('updateend'); }, 0);
        }
        remove(start,end) {
            this.updating = true;
            setTimeout(() => { this.ranges=this.ranges.filter(range=>range.end>end); if(this.ranges.length && this.ranges[0].start<end)this.ranges[0].start=end; this.updating=false; this.emit('updateend'); }, 0);
        }
        abort() { this.updating=false; }
    }
    class MediaSource {
        constructor() { this.readyState='closed'; this.listeners={}; this.url=null; mediaSources.push(this); }
        static isTypeSupported(type) { return (mseSupport === true || mseSupport === 'add_error' || mseSupport === 'append_error') && type === 'audio/mpeg'; }
        addEventListener(type,callback,options={}) { this.listeners[type]={callback,once:!!options.once}; }
        dispatchEvent(event) { const listener=this.listeners[event.type]; if(listener){listener.callback(event); if(listener.once)delete this.listeners[event.type];} }
        addSourceBuffer(type) { if(type!=='audio/mpeg'||mseSupport==='add_error')throw new Error('NotSupportedError'); return new SourceBuffer(); }
        endOfStream() { this.readyState='ended'; }
    }
    let now = 0;
    const delays = [];
    class Clock extends Date { static now() { return now; } }
    const window = {addEventListener(type, callback) { windowListeners[type] = callback; }, ...(indexedDBApi ? {indexedDB: indexedDBApi} : {}),
        ...(ocrOptions.tesseract ? {Tesseract: ocrOptions.tesseract} : {})};
    const context = vm.createContext({window, location: {search: query, origin: 'https://example.test'}, URLSearchParams, Blob, Event,
        navigator: {clipboard: {writeText: async text => { context.copied = text; }}, ...(withMediaSession ? {mediaSession} : {})},
        MediaMetadata: class MediaMetadata { constructor(data) { Object.assign(this, data); } },
        performance: {now: () => performanceTime}, document: {body, visibilityState: 'visible',
        addEventListener(type, callback) { documentListeners[type] = callback; }, activeElement: null,
        getElementById(id) {
            if (!elements.has(id)) {
                const value=element();
                if (id==='ocrPreview') value.getContext=()=>({fillRect() {},drawImage() {}});
                elements.set(id,value);
            }
            return elements.get(id);
        },
        head: {appendChild(script) { ocrOptions.onScript?.(script, window); }},
        createElement: element, querySelectorAll: () => []}, Audio, ...(mseSupport === null ? {} : {MediaSource}), fetch, FormData, AbortController,
        createImageBitmap: ocrOptions.createImageBitmap || (async () => ({width:1200,height:800,close() {}})),
        DOMException, TypeError, URL: {createObjectURL: blob => {
            if (blob instanceof MediaSource) { const url=`mse:${mediaSources.length}`; blob.url=url; return url; }
            const url = `blob:${created.length}`; created.push({url, blob}); return url;
        }, revokeObjectURL: url => revoked.push(url)},
        Date: Clock, setTimeout: (fn, ms) => {
            delays.push(ms);
            if ((ocrOptions.tesseract || ocrOptions.onScript) && ms===90000) return setTimeout(fn,ms);
            return setTimeout(() => { now += ms; fn(); }, 0);
        }, clearTimeout, alert() {}});
    if (!ocrOptions.skipModule) {
        vm.runInContext(ocrModule, context);
        window.createOcrImport = context.createOcrImport;
    }
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    context.document.getElementById('voiceSelect').value = 'pl-PL-ZofiaNeural';
    context.document.getElementById('rateSlider').value = '0';
    return {run, context, elements, audios, delays, revoked, created, documentListeners, windowListeners, mediaSession, mediaActions, mediaSources, sourceBuffers, indexedDBApi,
        advance(ms) { performanceTime += ms; }, setNow(ms) { now=ms; }};
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
    assert.equal(h.context.document.getElementById('sentenceList').children[0].innerText, input);
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
    const visible=h.context.document.getElementById('sentenceList').children.map(node=>node.innerText.replace(/\s+/gu,' ').trim());
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
    assert.equal(JSON.parse(h.context.copied).schema, 'MOB-04A/1');
    h.context.document.getElementById('diagnosticDownload').click();
    const exported = h.created.at(-1);
    assert.equal(JSON.parse(await exported.blob.text()).schema, 'MOB-04A/1');
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
test('Diagnostyka MOB-04A zapisuje zdarzenia i stan audio bez źródeł audio', async () => {
    const secret = 'TAJNY TEKST test@example.com';
    const h = harness(async()=>ok(), '?test=1&buffer=0');
    h.run(`sentences=[${JSON.stringify(secret)}]; window.startFrom(0)`);
    await settle();
    h.run('audio.currentTime=1.25');
    for (const type of ['pause','playing','waiting','stalled','suspend','ended','error']) {
        h.run(`audio.dispatch(${JSON.stringify(type)})`);
    }
    h.run('audio.dispatch("timeupdate")');
    h.advance(4999); h.run('audio.currentTime=2.5; audio.dispatch("timeupdate")');
    assert.equal(h.run('diagnosticReport().events.filter(e=>e.type==="playback_progress").length'), 1);
    h.advance(1); h.run('audio.currentTime=3.5; audio.dispatch("timeupdate")');
    const report = h.run('diagnosticReport()');
    assert.deepEqual(Array.from(report.events.filter(e=>e.type==='media_event'), e=>e.media_event),
        ['pause','pause','playing','waiting','stalled','suspend','ended','error']);
    assert.ok(report.events.some(e=>e.type==='playback_progress' && e.player.current_time===1.25));
    assert.ok(report.events.some(e=>e.type==='playback_progress' && e.player.current_time===3.5));
    assert.ok(report.events.find(e=>e.type==='media_event').player.paused);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes('blob:'));
});
test('Kontrola po powrocie wykrywa brak postępu currentTime', async () => {
    const h = harness(async()=>ok(), '?test=1');
    h.run('sentences=["A."]; window.startFrom(0)'); await settle();
    h.context.document.visibilityState='hidden'; h.documentListeners.visibilitychange();
    h.context.document.visibilityState='visible'; h.documentListeners.visibilitychange();
    await settle();
    let checks = h.run('diagnosticReport().events.filter(e=>e.type==="visible_progress_check")');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].playback_advanced, false);
    h.context.document.visibilityState='hidden'; h.documentListeners.visibilitychange();
    h.context.document.visibilityState='visible'; h.documentListeners.visibilitychange();
    h.run('audio.currentTime=0.2'); h.advance(5000); await settle();
    checks = h.run('diagnosticReport().events.filter(e=>e.type==="visible_progress_check")');
    assert.equal(checks.length, 2);
    assert.equal(checks[1].playback_advanced, true);
    assert.equal(checks[1].current_time_delta, 0.2);
});
test('Zdarzenia odtwarzacza są wyłączone bez test=1', async () => {
    const h = harness(async()=>ok(), '?test=0');
    assert.equal(h.run('diagnostics'), null);
    assert.deepEqual(Object.keys(h.audios[0].listeners), ['playing', 'pause']);
    assert.equal(h.run('diagnosticReport()'), null);
});
test('MOB-05 odzyskuje jedną wczesną pauzę w tle dla fragmentów 2 i 4 z buffer=2', async () => {
    for (const idx of [2, 4]) {
        const sentences = Array.from({length: 7}, (_, n) => `Zdanie ${n}.`);
        const h = harness(async()=>ok(), '?test=1&buffer=2');
        h.run(`sentences=${JSON.stringify(sentences)}; window.startFrom(${idx})`);
        await settle();
        assert.ok(h.run(`prefetchCache.has([...jobs.values()].find(job=>job.idx===${idx + 1})?.key)`));
        h.context.document.visibilityState = 'hidden';
        h.run('audio.currentTime=0.071; audio.onplaying()');
        const player = h.audios.at(-1);
        h.advance(145);
        h.run('audio.paused=true; audio.dispatch("pause")');
        await settle();
        assert.equal(player.plays, 2, `fragment ${idx} should have one recovery play`);
        assert.equal(h.run('diagnosticReport().recovery_attempts'), 1);
        assert.ok(h.run(`diagnosticReport().events.some(event=>event.type==="recovery_attempt" && event.index===${idx})`));
        h.run('audio.paused=true; audio.dispatch("pause")');
        await settle();
        assert.equal(player.plays, 2, 'recovery must not loop');
    }
});
test('MOB-05 respektuje pauzę Media Session i nie wznawia po stopie ani późnej pauzie', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=2');
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    assert.equal(h.mediaSession.playbackState, 'playing');
    assert.equal(h.mediaSession.metadata.title, 'AudioReader AI');
    assert.deepEqual(Object.keys(h.mediaActions).sort(), ['pause','play','stop']);
    h.context.document.visibilityState = 'hidden';
    h.run('audio.onplaying()'); h.advance(145);
    h.mediaActions.pause(); await settle();
    assert.equal(h.run('isPaused'), true);
    assert.equal(h.mediaSession.playbackState, 'paused');
    assert.equal(h.audios.at(-1).plays, 1);
    h.mediaActions.play(); await settle();
    assert.equal(h.run('isPaused'), false);
    assert.equal(h.audios.at(-1).plays, 2);

    h.run('window.stopReading()');
    const stoppedPlayer = h.audios.at(-1);
    assert.equal(h.mediaSession.playbackState, 'none');
    h.run('sentences=["New."]; window.startFrom(0)'); await settle();
    h.context.document.visibilityState = 'hidden'; h.run('audio.onplaying()'); h.advance(800);
    h.run('audio.paused=true; audio.dispatch("pause")'); await settle();
    const currentPlayer = h.audios.at(-1);
    assert.equal(currentPlayer.plays, 1, 'a later pause must remain paused');
    stoppedPlayer.paused = true; stoppedPlayer.dispatch('pause'); await settle();
    assert.equal(currentPlayer.plays, 1, 'a stale player from the stopped session must not resume');
});
test('MOB-05 anuluje oczekującą próbę po zmianie dokumentu i nie odzyskuje pauzy widocznej karty', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=0');
    h.run('sentences=["A."]; window.startFrom(0)'); await settle();
    const player = h.audios.at(-1);
    h.context.document.visibilityState = 'hidden';
    h.run('audio.onplaying()'); h.advance(145);
    h.run('audio.paused=true; audio.dispatch("pause"); renderSentences("Nowy dokument.")');
    await settle();
    assert.equal(player.plays, 1, 'document/session change must invalidate the timer');

    h.run('window.startFrom(0)'); await settle();
    const visiblePlayer = h.audios.at(-1);
    h.context.document.visibilityState = 'visible';
    h.run('audio.onplaying()'); h.advance(145);
    h.run('audio.paused=true; audio.dispatch("pause")'); await settle();
    assert.equal(visiblePlayer.plays, 1, 'visible pauses stay paused');
    assert.equal(h.run('isPaused'), true);
});
test('MOB-05 Media Session API jest opcjonalne', async () => {
    const h = harness(async()=>ok(), '', false);
    h.run('sentences=["A."]; window.startFrom(0)'); await settle();
    assert.equal(h.run('mediaSession'), null);
    assert.equal(h.audios.at(-1).plays, 1);
});
test('Przejście fragmentu nie resetuje elementu audio ani nie narusza zwalniania cache', async () => {
    const h = harness(async()=>ok(), '?buffer=2');
    h.run('sentences=["A.","B.","C."]; window.startFrom(0)'); await settle();
    const player = h.audios.at(-1);
    const firstUrl = player.src;
    const loadsBeforeEnd = player.loads;
    h.run('audio.onended()'); await settle();
    assert.equal(player.loads, loadsBeforeEnd);
    assert.notEqual(player.src, firstUrl);
    assert.ok(h.revoked.includes(firstUrl), 'completed fragment URL should be released');
    assert.ok(h.run('prefetchCache.has([...jobs.values()].find(job=>job.idx===1)?.key)'), 'next cached fragment remains attached');
});
test('MOB-06: MSE appenduje MP3 w kolejności do jednego źródła bez play na granicy zdań', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=2', true, true);
    h.run('sentences=["A.","B.","C.","D."]; window.startFrom(0)');
    await settle();
    const player = h.audios.at(-1);
    assert.equal(h.run('diagnosticReport().stream.mode'), 'mse');
    assert.equal(h.run('diagnosticReport().stream.is_type_supported'), true);
    assert.equal(h.sourceBuffers.length, 1);
    assert.equal(h.sourceBuffers[0].mode, 'sequence');
    assert.equal(h.sourceBuffers[0].ranges.length, 3, 'buffer=2 appends the current segment and two ahead');
    assert.equal(player.plays, 1);
    assert.equal(player.src, 'mse:1');
    assert.equal(h.run('diagnosticReport().stream.appended_bytes'), 30);
    assert.equal(h.run('jobs.size'), 0, 'appended sentence text is not retained by the synthesis job map');
    const source = player.src;
    h.run('audio.currentTime=10; audio.ontimeupdate()'); await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(h.sourceBuffers[0].ranges.length, 4);
    assert.equal(h.run('diagnosticReport().stream.appended_bytes'), 40);
    h.run('audio.currentTime=20; audio.ontimeupdate()'); await settle();
    assert.equal(h.run('currentIdx'), 2);
    assert.equal(player.src, source);
    assert.equal(player.plays, 1, 'play() is called once for the whole stream');
    h.run('audio.ended=true; audio.onended()');
    assert.equal(h.run('isReading'), false);
    assert.equal(h.context.document.getElementById('progressBar').style.width, '100%');
});
test('MOB-06: buffer=0 czeka na koniec bieżącego bufora przed dopisaniem następnego MP3', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=0', true, true);
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    const player = h.audios.at(-1);
    assert.equal(h.sourceBuffers[0].ranges.length, 1);
    assert.equal(h.sourceBuffers[0].mode, 'sequence');
    h.run('audio.currentTime=9; audio.ontimeupdate(); audio.onwaiting()'); await settle();
    assert.equal(h.sourceBuffers[0].ranges.length, 1, 'waiting well before buffer end must not prefetch');
    h.run('audio.currentTime=9.7; audio.ontimeupdate()'); await settle();
    assert.equal(h.sourceBuffers[0].ranges.length, 1, 'timeupdate before the edge still must not prefetch');
    h.run('audio.onwaiting()'); await settle();
    assert.equal(h.run('diagnosticReport().stream.buffered_seconds'), 10.3);
    assert.equal(h.sourceBuffers[0].ranges.length, 2, 'waiting near the buffered edge must demand the next MP3 without an exact-boundary timeupdate');
    assert.equal(player.plays, 1, 'MSE resumes the same playback without another play() call');
    assert.equal(player.paused, false);
    assert.equal(h.run('currentIdx'), 0, 'the delayed timeupdate has not crossed the sentence boundary');
});
test('MOB-06: błąd TTS po wyczerpaniu bufora natychmiast uruchamia ograniczony fallback', async () => {
    let calls = 0;
    const h = harness(async()=>++calls === 1 ? ok() : failed(400), '?test=1&buffer=0', true, true);
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    h.run('audio.currentTime=9.7; audio.ontimeupdate(); audio.onwaiting()'); await settle();
    assert.equal(h.run('diagnosticReport().stream.mode'), 'fallback');
    assert.ok(h.run('diagnosticReport().events.some(event=>event.type==="stream_fallback")'), 'legacy fallback path is entered');
    assert.equal(calls, 3, 'one successful MSE fragment, one failed next fragment and one bounded fallback request');
    assert.equal(h.run('isReading'), false, 'a second TTS failure stops instead of retrying without limit');
    h.run('window.stopReading()');
});
test('MOB-06: wznowienie odblokowuje syntezę tła zatrzymaną przez pauzę', async () => {
    let finishFirst;
    let calls = 0;
    const h = harness(async()=>{
        calls++;
        if (calls === 1) return new Promise(resolve=>{finishFirst=()=>resolve(ok());});
        return ok();
    }, '?test=1&buffer=2', true, true);
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    h.run('window.togglePlay()');
    finishFirst(); await settle();
    assert.equal(h.sourceBuffers[0].ranges.length, 1);
    assert.equal(h.run('isPaused'), true);
    h.run('window.togglePlay()'); await settle();
    assert.equal(h.run('isPaused'), false);
    assert.equal(h.sourceBuffers[0].ranges.length, 2, 'the queued background TTS job resumes and appends');
    assert.equal(calls, 2);
    h.run('window.stopReading()');
    assert.equal(h.run('isReading'), false, 'stop ends the resumed stream session');
});
test('MOB-06: brak obsługi MSE, addSourceBuffer lub append bezpiecznie przechodzi na audio Blob', async () => {
    for (const support of [false, 'add_error', 'append_error']) {
        const h = harness(async()=>ok(), '?test=1', true, support);
        h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
        assert.equal(h.run('isReading'), true);
        assert.equal(h.audios.at(-1).src.startsWith('blob:'), true);
        assert.equal(h.audios.at(-1).plays, 1);
        assert.equal(h.run('diagnosticReport().stream.mode'), 'fallback');
    }
});
test('MOB-06: zmiana sesji anuluje opóźniony TTS przed dopisaniem do SourceBuffer', async () => {
    let finish;
    const h = harness(async()=>new Promise(resolve=>{finish=()=>resolve(ok());}), '?test=1&buffer=2', true, true);
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    const player = h.audios.at(-1);
    h.run('window.stopReading()');
    finish(); await settle();
    assert.equal(h.sourceBuffers.length, 1);
    assert.equal(h.sourceBuffers[0].ranges.length, 0, 'cancelled generation must never append');
    assert.equal(player.plays, 0);
    assert.equal(h.run('isReading'), false);
});
test('MOB-06: błędne TTS przechodzi do ograniczonego fallbacku i zgłasza błąd', async () => {
    let calls = 0;
    const h = harness(async()=>{calls++; return failed(400);}, '?test=1', true, true);
    h.run('sentences=["A.","B."]; window.startFrom(0)'); await settle();
    assert.equal(h.run('diagnosticReport().stream.mode'), 'fallback');
    assert.equal(h.run('diagnosticReport().stream.last_error'), 'Error');
    assert.equal(h.run('isReading'), false);
    assert.equal(calls, 2, 'one MSE request and one bounded legacy fallback request');
});
test('MOB-06: Media Session, pauza, wznowienie i skip zachowują sesję stream', async () => {
    const h = harness(async()=>ok(), '?test=1&buffer=2', true, true);
    h.run('sentences=["A.","B.","C."]; window.startFrom(0)'); await settle();
    const firstPlayer=h.audios.at(-1);
    assert.equal(h.mediaSession.playbackState, 'playing');
    h.mediaActions.pause();
    assert.equal(h.run('isPaused'), true);
    assert.equal(firstPlayer.paused, true);
    h.mediaActions.play(); await settle();
    assert.equal(h.run('isPaused'), false);
    assert.equal(firstPlayer.plays, 2);
    h.run('window.skip(2)'); await settle();
    assert.equal(h.run('currentIdx'), 2);
    assert.equal(h.audios.at(-1).src.startsWith('mse:'), true);
    assert.equal(h.mediaSession.playbackState, 'playing');
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
test('UX-02 atomowo migruje pełny rekord UX-01 i po przerwaniu można ponowić migrację', async () => {
    const idb=memoryIndexedDB();
    const legacy={id:'last',version:1,segmentationVersion:1,text:'Pierwsze. Drugie.',name:'migracja.txt',blocks:[],
        sentenceCount:2,index:1,completed:false,voice:'pl-PL-MarekNeural',rate:'20',savedAt:1234};
    idb.data.set('last',legacy);
    idb.simulateUpgradeAbort=true;
    const interrupted=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    assert.deepEqual(idb.data.get('last'),legacy,'legacy row remains untouched when upgrade is interrupted');
    assert.equal(interrupted.run('isReading'),false);
    idb.simulateUpgradeAbort=false;
    const reopened=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    const migrated=idb.data.get('doc_migrated_v1_last');
    assert.equal(idb.data.has('last'),false);
    assert.equal(migrated.text,legacy.text);
    assert.deepEqual(migrated.blocks,legacy.blocks);
    assert.equal(migrated.index,1);
    assert.equal(migrated.completed,false);
    assert.equal(migrated.voice,legacy.voice);
    assert.equal(migrated.rate,legacy.rate);
    assert.equal(reopened.run('currentIdx'),1);
    assert.equal(reopened.run('currentDocument.id'),'doc_migrated_v1_last');
    assert.equal(reopened.run('isReading'),false,'migration never starts audio');
    assert.equal(idb.sessions.size,0,'no history is inferred for UX-01 data');
});
test('UX-02 zapisuje odsłuch dopiero na playing i grupuje pauzę ze wznowieniem', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    h.context.document.getElementById('rawText').value='Pierwsze zdanie.';
    h.run('window.applyText()'); await settle();
    h.run("window.switchTab('history')"); await settle();
    assert.equal(idb.sessions.size,0,'upload, apply, and opening history do not create a session');
    h.run('window.startFrom(0)'); await settle();
    assert.equal(idb.sessions.size,0,'play() preparation is not actual playback');
    h.run('audio.dispatch("playing")'); await settle();
    assert.equal(idb.sessions.size,1);
    let item=[...idb.sessions.values()][0];
    assert.equal(item.status,'playing');
    assert.equal(item.documentId,h.run('currentDocument.id'));
    const startedAt=item.startedAt;
    h.run('audio.paused=true; audio.dispatch("pause")'); await settle();
    assert.equal([...idb.sessions.values()][0].status,'paused');
    h.run('window.togglePlay()'); await settle();
    h.run('audio.dispatch("playing")'); await settle();
    assert.equal(idb.sessions.size,1,'resume remains in the same grouped session');
    item=[...idb.sessions.values()][0];
    assert.equal(item.startedAt,startedAt);
    assert.equal(item.status,'playing');
    h.run('window.stopReading()'); await settle();
    assert.equal([...idb.sessions.values()][0].status,'stopped');
    assert.equal([...idb.sessions.values()][0].playedMs>=0,true);
});
test('UX-02 Media Session respektuje pauzę systemową, koniec i pagehide', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    h.run('renderSentences("Koniec dokumentu.",[],{name:"media.txt"}); window.startFrom(0)'); await settle();
    h.audios.at(-1).dispatch('playing'); await settle();
    const first=[...idb.sessions.values()][0].id;
    h.mediaActions.pause(); await settle();
    assert.equal([...idb.sessions.values()][0].status,'paused');
    h.mediaActions.play(); await settle();
    h.audios.at(-1).dispatch('playing'); await settle();
    assert.equal([...idb.sessions.values()][0].id,first);
    h.run('audio.onended()'); await settle();
    assert.equal([...idb.sessions.values()][0].status,'completed');

    h.run('window.startFrom(0)'); await settle();
    h.audios.at(-1).dispatch('playing'); await settle();
    h.windowListeners.pagehide(); await settle();
    assert.equal([...idb.sessions.values()].find(item=>item.id!==first).status,'interrupted');
});
test('UX-02 dwa dokumenty zachowują niezależny postęp i usunięcie kasuje ich historię', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    h.run('renderSentences("Pierwsze. Drugie.",[],{name:"jeden.txt"})'); await settle();
    const firstId=h.run('currentDocument.id');
    h.run('window.startFrom(1)'); await settle();
    h.run('renderSentences("Drugi dokument.",[],{name:"dwa.txt"})'); await settle();
    const secondId=h.run('currentDocument.id');
    assert.notEqual(firstId,secondId);
    await h.run(`openLibraryDocument(${JSON.stringify(firstId)})`); await settle();
    assert.equal(h.run('currentDocument.id'),firstId);
    assert.equal(h.run('currentIdx'),1);
    h.run('window.startFrom(1)'); await settle();
    h.run('audio.dispatch("playing")'); await settle();
    assert.equal(idb.sessions.size,1);
    await h.run(`deleteLibraryDocument(${JSON.stringify(firstId)})`); await settle();
    assert.equal(idb.data.has(firstId),false);
    assert.equal([...idb.sessions.values()].some(item=>item.documentId===firstId),false);
});
test('UX-02 opóźnione usunięcie A nie czyści ani nie nadpisuje nowo otwartego B', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    h.run('renderSentences("Dokument A.",[],{name:"A.txt"})'); await settle();
    const idA=h.run('currentDocument.id');
    h.run('renderSentences("Dokument B.",[],{name:"B.txt"})'); await settle();
    const idB=h.run('currentDocument.id');
    await h.run(`openLibraryDocument(${JSON.stringify(idA)})`); await settle();
    idb.holdNextReadwriteDelete=true;
    const deletion=h.run(`deleteLibraryDocument(${JSON.stringify(idA)})`);
    await settle();
    assert.equal(typeof idb.releaseHeldDelete,'function','delete transaction is paused before completion');
    await h.run(`openLibraryDocument(${JSON.stringify(idB)})`); await settle();
    assert.equal(h.run('currentDocument.id'),idB);
    idb.releaseHeldDelete();
    await deletion; await settle();
    assert.equal(h.run('currentDocument.id'),idB,'late delete completion cannot clear the newer reader document');
    assert.equal(h.run('currentDocument.text'),'Dokument B.');
    assert.equal(idb.data.has(idB),true,'newly opened B remains stored after queued writes settle');
    assert.equal(idb.data.has(idA),false);
});
test('UX-02 spóźniony odczyt biblioteki i import nie nadpisują nowszego wyboru', async () => {
    const idb=memoryIndexedDB();
    let finishImport;
    const h=harness(async url=>url==='/upload'
        ? new Promise(resolve=>{finishImport=resolve;}) : ok(),' ',true,null,idb);
    await settle();
    h.run('renderSentences("Dokument A.",[],{name:"A.txt"})'); await settle();
    const idA=h.run('currentDocument.id');
    h.run('renderSentences("Dokument B.",[],{name:"B.txt"})'); await settle();
    const idB=h.run('currentDocument.id');
    idb.holdReadonlyGetKey=idA;
    const openA=h.run(`openLibraryDocument(${JSON.stringify(idA)})`);
    await settle();
    assert.equal(typeof idb.releaseHeldReadonlyGet,'function','A library read is deliberately delayed');
    await h.run(`openLibraryDocument(${JSON.stringify(idB)})`); await settle();
    idb.releaseHeldReadonlyGet();
    await openA; await settle();
    assert.equal(h.run('currentDocument.id'),idB,'older library selection cannot replace the newer selection');

    const file=new Blob(['input']); file.name='spozniony.txt';
    const pendingImport=h.context.document.getElementById('fileInput').listeners.change({target:{files:[file]}});
    await settle();
    await h.run(`openLibraryDocument(${JSON.stringify(idA)})`); await settle();
    finishImport({ok:true,json:async()=>({text:'Późny import.',blocks:[]})});
    await pendingImport; await settle();
    assert.equal(h.run('currentDocument.id'),idA,'late import cannot replace the newer library choice');
    assert.equal([...idb.data.values()].some(item=>item.name==='spozniony.txt'),false);
});
test('UX-02 spóźnione playing starego odtwarzacza nie zapisuje sesji nowego dokumentu', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    h.run('renderSentences("Dokument A.",[],{name:"A.txt"}); window.startFrom(0)'); await settle();
    const oldPlayer=h.audios.at(-1);
    h.run('renderSentences("Dokument B.",[],{name:"B.txt"})'); await settle();
    const idB=h.run('currentDocument.id');
    oldPlayer.dispatch('playing'); await settle();
    assert.equal(idb.sessions.size,0,'a detached player event does not create an entry');
    h.run('window.startFrom(0)'); await settle();
    h.audios.at(-1).dispatch('playing'); await settle();
    assert.equal(idb.sessions.size,1);
    assert.equal([...idb.sessions.values()][0].documentId,idB,'only actual playback of B is recorded');
});
test('UX-02 jeden dokument pojawia się w historii dwóch lokalnych dni', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    h.run('renderSentences("Dokument do historii.",[],{name:"historia.txt"})'); await settle();
    const docId=h.run('currentDocument.id');
    h.setNow(Date.parse('2026-11-01T23:30:00Z'));
    h.run('window.startFrom(0)'); await settle();
    h.audios.at(-1).dispatch('playing'); await settle();
    h.run('window.stopReading()'); await settle();
    h.setNow(Date.parse('2026-11-02T23:30:00Z'));
    h.run('window.startFrom(0)'); await settle();
    h.audios.at(-1).dispatch('playing'); await settle();
    h.run('window.stopReading()'); await settle();
    const entries=[...idb.sessions.values()].filter(item=>item.documentId===docId);
    assert.equal(entries.length,2);
    assert.deepEqual(entries.map(item=>h.run(`dateKey(${item.startedAt})`)),['2026-11-02','2026-11-03']);
});
test('UX-02 limit 10 dokumentów rotuje najstarszy, ale zachowuje nowy aktywny', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,null,idb);
    await settle();
    for(let i=0;i<11;i++) {
        h.run(`renderSentences("Dokument ${i}.",[],{name:"${i}.txt"})`);
        await settle();
    }
    assert.equal(idb.data.size,10);
    assert.ok(idb.data.has(h.run('currentDocument.id')),'active document is never evicted');
    assert.equal([...idb.data.values()].some(item=>item.name==='0.txt'),false,'least recently used item rotated out');
});
test('UX-02 MSE zachowuje jedną sesję mimo granicy fragmentu', async () => {
    const idb=memoryIndexedDB();
    const h=harness(async()=>ok(),' ',true,true,idb);
    await settle();
    h.run('renderSentences("Pierwsze. Drugie.",[],{name:"mse.txt"}); window.startFrom(0)'); await settle();
    const player=h.audios.at(-1);
    player.dispatch('playing'); await settle();
    const id=[...idb.sessions.values()][0].id;
    h.run('audio.currentTime=10; audio.ontimeupdate()'); await settle();
    assert.equal(h.run('currentIdx'),1);
    assert.equal(idb.sessions.size,1);
    assert.equal([...idb.sessions.values()][0].id,id);
    h.run('window.stopReading()'); await settle();
});
test('UX-02 kalendarz używa poniedziałku jako pierwszego dnia i daty lokalnej', () => {
    const h=harness(async()=>ok());
    assert.equal(h.run('dateKey(new Date(2026, 10, 15))'), '2026-11-15');
    assert.equal(h.run('((new Date(2026, 10, 1).getDay()+6)%7)'), 6, 'Sunday is placed after Saturday in Monday-first calendar');
    assert.match(h.run('formatLocalDate("2026-11-15")'), /listopada/);
});
test('UX-01 wklejony tekst i miejsce wracają lokalnie bez automatycznego odtwarzania', async () => {
    const idb = memoryIndexedDB();
    const h = harness(async()=>ok(), '', true, null, idb);
    await settle();
    h.context.document.getElementById('voiceSelect').value = 'pl-PL-MarekNeural';
    h.context.document.getElementById('rateSlider').value = '20';
    h.context.document.getElementById('rawText').value = 'Pierwsze zdanie. Drugie zdanie.';
    h.run('window.applyText()'); await settle();
    assert.equal(latestDocument(idb).name, 'Wklejony tekst');
    assert.equal(latestDocument(idb).text, 'Pierwsze zdanie. Drugie zdanie.');
    h.run('window.startFrom(1)'); await settle();
    h.run('window.togglePlay()'); await settle();
    assert.equal(latestDocument(idb).index, 1);
    assert.equal(latestDocument(idb).voice, 'pl-PL-MarekNeural');
    assert.equal(latestDocument(idb).rate, '20');

    let reopenedFetches = 0;
    const reopened = harness(async()=>{reopenedFetches++; return ok();}, '', true, null, idb);
    await settle();
    assert.deepEqual(Array.from(reopened.run('sentences')), ['Pierwsze zdanie.', 'Drugie zdanie.']);
    assert.equal(reopened.run('currentIdx'), 1);
    assert.equal(reopened.run('isReading'), false, 'reload must never start playback automatically');
    assert.equal(reopened.audios.at(-1).plays, 0);
    assert.equal(reopened.context.document.getElementById('voiceSelect').value, 'pl-PL-MarekNeural');
    assert.equal(reopened.context.document.getElementById('rateSlider').value, '20');
    assert.equal(reopened.context.document.getElementById('resumeContinue').hidden, false);
    assert.equal(reopened.context.document.getElementById('resumeContinue').textContent, 'Kontynuuj');
    assert.equal(reopened.context.document.getElementById('resumeContinue').attributes['aria-label'], 'Kontynuuj czytanie od zapisanego miejsca');
    assert.equal(reopenedFetches, 0, 'restoring a document does not send it to the backend or generate TTS');
    assert.match(reopened.context.document.getElementById('resumeNote').textContent, /lokalnie w tej przeglądarce/);
    reopened.run('window.continueSavedDocument()'); await settle();
    assert.equal(reopened.run('isReading'), true);
    assert.equal(reopened.run('currentIdx'), 1);
    assert.equal(reopened.audios.at(-1).plays, 1);
});
test('UX-01 import zapisuje nazwę i bloki; nieudany następny import zachowuje poprzedni dokument', async () => {
    const idb = memoryIndexedDB();
    idb.data.set('last', {id:'last', version:1, segmentationVersion:1, text:'Stary zapis.', name:'stary.txt',
        blocks:[], sentenceCount:1, index:0, completed:false, voice:'pl-PL-ZofiaNeural', rate:'0'});
    let imports = 0;
    const h = harness(async url => {
        if (url !== '/upload') return ok();
        imports++;
        if (imports === 1) return {ok:true, json:async()=>({text:'Nagłówek.\nTreść dokumentu.', blocks:[{start:0,end:10,kind:'heading'}]})};
        return {ok:false, status:500};
    }, '', true, null, idb);
    await settle();
    assert.equal(h.run('currentDocument.name'), 'stary.txt');
    const firstFile = new Blob(['pdf']); firstFile.name = 'raport.pdf';
    h.context.document.getElementById('fileInput').listeners.change({target:{files:[firstFile]}});
    await settle();
    const saved = JSON.parse(JSON.stringify(namedDocument(idb, 'raport.pdf')));
    assert.equal(saved.name, 'raport.pdf');
    assert.notEqual(saved.text, 'Stary zapis.', 'a successful new import replaces the prior remembered document');
    assert.deepEqual(saved.blocks, [{start:0,end:10,kind:'heading'}]);
    assert.equal(saved.text, 'Nagłówek.\nTreść dokumentu.');
    const secondFile = new Blob(['bad']); secondFile.name = 'bad.pdf';
    h.context.document.getElementById('fileInput').listeners.change({target:{files:[secondFile]}});
    await settle();
    assert.deepEqual(latestDocument(idb), saved, 'failed import leaves the known-good local document untouched');
    assert.equal(imports, 2, 'local save/restore causes no extra upload request');
});
test('UX-01 spóźniony zapis poprzedniego dokumentu nie nadpisuje aktualnego', async () => {
    const idb = memoryIndexedDB();
    const h = harness(async()=>ok(), '', true, null, idb);
    await settle();
    h.context.document.getElementById('rawText').value = 'Dokument poprzedni.';
    h.run('window.applyText()');
    h.context.document.getElementById('rawText').value = 'Dokument aktualny.';
    h.run('window.applyText()');
    await settle();
    assert.equal(latestDocument(idb).text, 'Dokument aktualny.');
    assert.equal(latestDocument(idb).name, 'Wklejony tekst');
});
test('UX-01 przejście zdania w MSE zapisuje indeks bez zmiany streamu', async () => {
    const idb = memoryIndexedDB();
    const h = harness(async()=>ok(), '?buffer=2', true, true, idb);
    await settle();
    h.run('renderSentences("Pierwsze. Drugie.", [], {name:"test.txt"}); window.startFrom(0)'); await settle();
    const player = h.audios.at(-1);
    const source = player.src;
    h.run('audio.currentTime=10; audio.ontimeupdate()'); await settle();
    assert.equal(h.run('currentIdx'), 1);
    assert.equal(latestDocument(idb).index, 1);
    assert.equal(player.src, source);
    assert.equal(player.plays, 1, 'saving resume position does not restart the MSE stream');
    h.run('window.stopReading()');
});
test('UX-01 końcówka dokumentu zapisuje ukończenie i pozwala zacząć od początku', async () => {
    const idb = memoryIndexedDB();
    const h = harness(async()=>ok(), '', true, null, idb);
    await settle();
    h.context.document.getElementById('rawText').value = 'Jedno zdanie.';
    h.run('window.applyText()'); await settle();
    h.run('window.startFrom(0)'); await settle();
    h.run('audio.onended()'); await settle();
    assert.equal(latestDocument(idb).completed, true);
    assert.equal(latestDocument(idb).index, 1);
    const reopened = harness(async()=>ok(), '', true, null, idb);
    await settle();
    assert.equal(reopened.run('isReading'), false);
    assert.equal(reopened.run('currentIdx'), 1);
    assert.equal(reopened.context.document.getElementById('resumeContinue').textContent, 'Od początku');
    assert.equal(reopened.context.document.getElementById('resumeContinue').attributes['aria-label'], 'Czytaj ukończony dokument od początku');
    reopened.run('window.continueSavedDocument()'); await settle();
    assert.equal(reopened.run('currentIdx'), 0);
    assert.equal(reopened.run('isReading'), true);
});
test('UX-01 stary lub uszkodzony zapis jest odrzucany do pustego stanu', async () => {
    const idb = memoryIndexedDB();
    idb.data.set('last', {id:'last', version:1, segmentationVersion:99, text:'Nieaktualny zapis.', name:'old.txt',
        blocks:[], sentenceCount:1, index:0, completed:false, voice:'pl-PL-ZofiaNeural', rate:'0'});
    const h = harness(async()=>ok(), '', true, null, idb);
    await settle();
    assert.deepEqual(Array.from(h.run('sentences')), []);
    assert.equal(h.run('isReading'), false);
    assert.equal(h.audios.at(-1).plays, 0);
    assert.equal(idb.data.has('last'), false);
});
test('UX-01 opóźnione czyszczenie starego rekordu nie usuwa nowego dokumentu', async () => {
    const idb = memoryIndexedDB();
    idb.data.set('last', {id:'last', version:1, segmentationVersion:99, text:'Stary niezgodny tekst.', name:'old.txt',
        blocks:[], sentenceCount:1, index:0, completed:false, voice:'pl-PL-ZofiaNeural', rate:'0', savedAt:100});
    idb.holdNextReadwriteGet = true;
    const h = harness(async()=>ok(), '', true, null, idb);
    await settle();
    assert.equal(typeof idb.releaseHeldRead, 'function', 'invalid-record cleanup is paused in its readwrite transaction');

    h.run('renderSentences("Nowy dokument.", [], {name:"nowy.txt"})');
    idb.releaseHeldRead();
    await settle();
    assert.equal(latestDocument(idb).text, 'Nowy dokument.');
    assert.equal(latestDocument(idb).name, 'nowy.txt');
    assert.equal(latestDocument(idb).segmentationVersion, 1);
});
test('UX-01 usuń czyści dokument i nie zapisuje go ponownie podczas stopu', async () => {
    const idb = memoryIndexedDB();
    const h = harness(async()=>ok(), '', true, null, idb);
    await settle();
    h.context.document.getElementById('rawText').value = 'Do usunięcia.';
    h.run('window.applyText()'); await settle();
    assert.ok(latestDocument(idb));
    h.run('window.deleteSavedDocument()'); await settle();
    assert.equal(idb.data.size, 0);
    h.run('window.startFrom(0)'); await settle();
    h.run('window.stopReading()'); await settle();
    assert.equal(idb.data.size, 0, 'deleted content and position stay deleted for the current document');
});
test('UX-01 brak IndexedDB lub quota nie blokuje odtwarzania', async () => {
    const noStorage = harness(async()=>ok());
    noStorage.context.document.getElementById('rawText').value = 'Odtwarzanie bez zapisu.';
    noStorage.run('window.applyText()'); await settle();
    noStorage.run('window.startFrom(0)'); await settle();
    assert.equal(noStorage.run('isReading'), true);
    assert.equal(noStorage.audios.at(-1).plays, 1);

    const idb = memoryIndexedDB(); idb.failWrites = 1;
    const quota = harness(async()=>ok(), '', true, null, idb);
    await settle();
    quota.context.document.getElementById('rawText').value = 'Odtwarzanie przy pełnej pamięci.';
    quota.run('window.applyText()'); await settle();
    assert.match(quota.context.document.getElementById('resumeTitle').textContent, /nie został zapisany/);
    quota.run('window.startFrom(0)'); await settle();
    assert.equal(quota.run('isReading'), true);
    assert.equal(quota.audios.at(-1).plays, 1);
});
test('UI-01 dwa widoki zachowują aktywną sesję i pokazują mini-odtwarzacz', async () => {
    const h=harness(async()=>ok());
    h.context.document.getElementById('rawText').value='Pierwsze zdanie. Drugie zdanie.';
    h.run('window.applyText()'); await settle();
    h.run("window.startFrom(0)"); await settle();
    const player=h.audios.at(-1), token=h.run('session');
    h.context.document.getElementById('voiceSelect').value='pl-PL-MarekNeural';
    h.context.document.getElementById('rateSlider').value='20';
    h.run("window.switchTab('history')"); await settle();
    assert.equal(h.run('session'),token,'view change does not restart audio session');
    assert.equal(h.audios.at(-1),player,'view change preserves the same audio element');
    assert.equal(h.run('currentDocument.name'),'Wklejony tekst');
    assert.equal(h.context.document.getElementById('miniPlayer').hidden,false);
    assert.equal(h.context.document.getElementById('miniPlayerTitle').textContent,'Wklejony tekst');
    assert.equal(h.context.document.body.classList.contains('history-active'),true);
    h.run('window.togglePlay()');
    assert.equal(h.run('isPaused'),true,'mini-player control respects normal pause behavior');
    h.run("window.switchTab('reader')");
    assert.equal(h.context.document.body.classList.contains('history-active'),false);
    assert.equal(h.context.document.getElementById('miniPlayer').hidden,true,'reader uses the full player without a duplicate mini-player');
});
test('UI-01 dialog importu zachowuje roboczy tekst i otwiera wybraną treść', () => {
    const h=harness(async()=>ok());
    h.run('window.openAddContentDialog()');
    const dialog=h.context.document.getElementById('addContentDialog');
    assert.equal(dialog.open,true);
    h.run('window.showTextImport()');
    assert.equal(h.context.document.getElementById('textImportForm').hidden,false);
    h.context.document.getElementById('rawText').value='Roboczy tekst bez utraty.';
    h.run('window.closeAddContentDialog()');
    assert.equal(h.context.document.getElementById('rawText').value,'Roboczy tekst bez utraty.');
    h.run('window.openAddContentDialog(); window.showTextImport(); window.applyText()');
    assert.equal(dialog.open,false);
    assert.equal(h.run('activeTab'),'reader');
    assert.equal(h.run('currentDocument.name'),'Wklejony tekst');
    assert.equal(h.context.document.getElementById('resumePanel').hidden,true,'no persistent save panel before a record exists');
    h.run('window.openAddContentDialog(); window.chooseFileImport()');
    assert.equal(h.context.document.getElementById('fileInput').clickCount,1);
    assert.equal(dialog.open,false);
});
test('UI-01 dialog natywny można ponownie otworzyć po sukcesie, anulowaniu, błędzie i Escape', async () => {
    let failUpload=false, imports=0;
    const h=harness(async url=>{
        if(url!=='/upload')return ok();
        imports++;
        if(failUpload)return {ok:false,status:503};
        return {ok:true,json:async()=>({text:`Zaimportowany plik ${imports}.`,blocks:[]})};
    });
    const dialog=h.context.document.getElementById('addContentDialog');
    const input=h.context.document.getElementById('fileInput');
    async function upload(name) {
        const file=new Blob([name]); file.name=name;
        await input.listeners.change({target:{files:[file],value:name}});
        await settle();
    }
    h.run('window.openAddContentDialog(); window.chooseFileImport()');
    await upload('one.txt');
    assert.equal(dialog.open,false);
    assert.equal(dialog.hidden,false,'closing a native dialog does not set hidden');
    h.run('window.openAddContentDialog()');
    assert.equal(dialog.open,true,'first successful upload leaves the dialog reusable');
    h.run('window.chooseFileImport()'); // File picker is cancelled; no change event follows.
    h.run('window.openAddContentDialog()');
    assert.equal(dialog.open,true,'cancelled file selection leaves the dialog reusable');
    h.run('window.chooseFileImport()');
    await upload('two.txt');
    assert.equal(imports,2,'consecutive successful imports both reach the upload handler');
    assert.equal(dialog.hidden,false);
    failUpload=true;
    h.run('window.openAddContentDialog(); window.chooseFileImport()');
    await upload('broken.txt');
    assert.equal(dialog.open,true,'upload errors reopen the import dialog with contextual status');
    assert.match(h.context.document.getElementById('importStatus').textContent,/Nie udało się wczytać/);
    dialog.dispatch('cancel'); // Native cancel is the event generated by Escape.
    dialog.open=false;
    dialog.dispatch('close');
    h.run('window.openAddContentDialog()');
    assert.equal(dialog.open,true,'Escape does not leave hidden set');
    assert.equal(dialog.hidden,false);
    assert.ok(dialog.showModalCalls>=5);
});
test('UI-01 przejście zdań w historii nie przewija ani nie przełącza widoku', async () => {
    const h=harness(async()=>ok());
    h.run('renderSentences("Pierwsze. Drugie.",[],{name:"Czytany dokument"}); window.startFrom(0)');
    await settle();
    h.run("window.switchTab('history')");
    h.audios.at(-1).onended(); await settle();
    assert.equal(h.run('activeTab'),'history');
    assert.equal(h.context.document.getElementById('sent-1').scrollCount||0,0);
});
test('UX-02 historia opisuje start, opcjonalny koniec i krótki czas odsłuchu', () => {
    const h=harness(async()=>ok());
    h.run(`historyDocuments=[]; historySessions=[
        {id:'live',documentId:'gone-a',documentName:'Aktywna sesja',startedAt:Date.UTC(2026,10,15,10,0),playedMs:13000,status:'paused'},
        {id:'done',documentId:'gone-b',documentName:'Krótka sesja',startedAt:Date.UTC(2026,10,15,11,0),endedAt:Date.UTC(2026,10,15,11,1),playedMs:65000,status:'completed'}
    ]; selectedHistoryDay='2026-11-15'; renderHistory()`);
    const rows=h.context.document.getElementById('historyList').children;
    assert.equal(rows.length,2);
    const liveMeta=rows[0].children[0].children[1].innerText;
    assert.match(liveMeta,/Start:/);
    assert.doesNotMatch(liveMeta,/Koniec:/);
    assert.match(liveMeta,/Czas: 0:13/);
    assert.doesNotMatch(liveMeta,/0 min/);
    const doneMeta=rows[1].children[0].children[1].innerText;
    assert.match(doneMeta,/Start:/);
    assert.match(doneMeta,/Koniec:/);
    assert.match(doneMeta,/Czas: 1:05/);
});
test('UI-01 ustawienia są opcjonalnym panelem z kontrolą stanu dostępności', () => {
    const h=harness(async()=>ok());
    const panel=h.context.document.getElementById('settingsPanel');
    h.run('window.toggleSettings(true)');
    assert.equal(panel.hidden,false);
    assert.equal(h.context.document.getElementById('settingsToggle').attributes['aria-expanded'],'true');
    h.run('window.toggleSettings(false)');
    assert.equal(panel.hidden,true);
    assert.equal(h.context.document.getElementById('miniPlayer').hidden,true,'mini-player stays absent without a document');
});
test('OCR-01 aparat i galeria prowadzą przez podgląd, edycję i istniejący zapis Lektora', async () => {
    const idb=memoryIndexedDB();
    let createCalls=0, terminated=0;
    const tesseract={async createWorker(language, mode, options) {
        createCalls++;
        assert.equal(language,'pol'); assert.equal(mode,1);
        assert.equal(options.langPath,'https://example.test/ocr-probe-assets');
        options.logger({status:'recognizing text',progress:.55});
        return {recognize: async () => ({data:{text:'Ala ma kota. Drugie zdanie.'}}),
            terminate: async () => {terminated++;}};
    }};
    const h=harness(async()=>ok(),' ',true,true,idb,{tesseract,
        createImageBitmap:async(_file,options)=>{
            assert.equal(options.imageOrientation,'from-image');
            return {width:900,height:1400,close(){}};
        }});
    await settle();
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    assert.equal(h.context.document.getElementById('ocrImport').hidden,false);
    h.run("window.chooseOcrPhoto('camera'); window.chooseOcrPhoto('gallery')");
    assert.equal(h.context.document.getElementById('ocrCameraInput').clickCount,1);
    assert.equal(h.context.document.getElementById('ocrGalleryInput').clickCount,1);
    const file=new Blob(['photo'],{type:'image/jpeg'}); file.name='private-photo.jpg';
    await h.context.document.getElementById('ocrCameraInput').listeners.change({target:{files:[file],value:'private-photo.jpg'}});
    assert.equal(h.context.document.getElementById('ocrPreview').hidden,false);
    assert.equal(h.context.document.getElementById('ocrRun').disabled,false);
    assert.equal(idb.data.size,0,'selecting a photo does not persist it');
    await h.run('window.runOcr()');
    assert.equal(createCalls,1); assert.equal(terminated,1);
    assert.equal(h.context.document.getElementById('ocrText').hidden,false);
    assert.equal(h.context.document.getElementById('ocrText').value,'Ala ma kota. Drugie zdanie.');
    h.context.document.getElementById('ocrText').value='Poprawione zdanie. Drugie poprawione.';
    h.run('window.applyOcrText()'); await settle();
    const acceptedId=h.run('currentDocument.id');
    h.run('window.applyOcrText()');
    assert.equal(h.run('currentDocument.id'),acceptedId,'double tap cannot create a second document');
    assert.equal(h.run('currentDocument.name'),'Tekst ze zdjęcia');
    assert.equal(h.run('currentDocument.text'),'Poprawione zdanie. Drugie poprawione.');
    assert.equal(h.run('sentences.length'),2);
    assert.equal(h.context.document.getElementById('addContentDialog').open,false);
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    assert.equal(h.context.document.getElementById('addContentDialog').open,true,'OCR dialog reopens after acceptance');
    assert.equal(h.context.document.getElementById('ocrText').value,'');
    h.run('window.closeAddContentDialog()');
    const record=latestDocument(idb);
    assert.equal(record.text,'Poprawione zdanie. Drugie poprawione.');
    assert.equal(JSON.stringify(record).includes('private-photo.jpg'),false);
    assert.equal(idb.sessions.size,0,'OCR and document save do not invent a listening session');
    h.run('window.startFrom(0)'); await settle();
    h.run('audio.dispatch("playing")'); await settle();
    assert.equal(idb.sessions.size,1,'normal playback records the OCR document in history');
    assert.equal([...idb.sessions.values()][0].documentId,record.id);
});
test('OCR-01 anulowanie i zmiana dokumentu odrzucają spóźniony wynik i zwalniają worker', async () => {
    let resolveRecognition, terminated=0;
    const tesseract={async createWorker() { return {recognize: () => new Promise(resolve=>{resolveRecognition=resolve;}),
        terminate: async () => {terminated++;}}; }};
    const h=harness(async()=>ok(),' ',true,null,null,{tesseract});
    const photo=new Blob(['photo'],{type:'image/png'});
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    await h.context.document.getElementById('ocrGalleryInput').listeners.change({target:{files:[photo],value:'photo'}});
    const first=h.run('window.runOcr()');
    await h.run('window.runOcr()');
    for(let i=0;i<12 && !resolveRecognition;i++)await Promise.resolve();
    assert.ok(resolveRecognition);
    h.run('window.cancelOcrRecognition()');
    resolveRecognition({data:{text:'Spóźnione zdanie.'}});
    await first;
    assert.equal(terminated,1);
    assert.equal(h.context.document.getElementById('ocrText').hidden,true);
    assert.equal(h.run('currentDocument'),null);
    assert.equal(h.context.document.getElementById('ocrRun').disabled,false,'same preview can be retried');

    await h.context.document.getElementById('ocrGalleryInput').listeners.change({target:{files:[photo],value:'photo'}});
    resolveRecognition=null;
    const second=h.run('window.runOcr()');
    for(let i=0;i<12 && !resolveRecognition;i++)await Promise.resolve();
    h.run('renderSentences("Nowy dokument.", [], {name:"nowy.txt"})');
    resolveRecognition({data:{text:'Stary wynik OCR.'}});
    await second;
    assert.equal(terminated,2);
    assert.equal(h.run('currentDocument.name'),'nowy.txt');
    assert.equal(h.context.document.getElementById('ocrText').value,'');
});
test('OCR-01 odrzuca nieobsługiwany i zbyt duży obraz bez zmiany dokumentu', async () => {
    let calls=0;
    const h=harness(async()=>ok(),' ',true,null,null,{tesseract:{async createWorker(){calls++;throw Error('unneeded');}}});
    h.run('renderSentences("Istniejący dokument.",[],{name:"zapis.txt"})');
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    const input=h.context.document.getElementById('ocrGalleryInput');
    await input.listeners.change({target:{files:[new Blob(['x'],{type:'image/svg+xml'})],value:'x'}});
    assert.match(h.context.document.getElementById('ocrStatus').textContent,/JPEG, PNG lub WebP/);
    const large={type:'image/jpeg',size:13*1024*1024};
    await input.listeners.change({target:{files:[large],value:'large'}});
    assert.match(h.context.document.getElementById('ocrStatus').textContent,/do 12 MB/);
    assert.equal(h.context.document.getElementById('ocrRun').disabled,true);
    assert.equal(h.run('currentDocument.name'),'zapis.txt');
    assert.equal(calls,0);
    const pixels=harness(async()=>ok(),' ',true,null,null,{tesseract:{async createWorker(){throw Error('unneeded');}},
        createImageBitmap:async()=>({width:5000,height:4000,close(){}})});
    pixels.run('window.openAddContentDialog(); window.showPhotoImport()');
    await pixels.context.document.getElementById('ocrGalleryInput').listeners.change({target:{files:[new Blob(['x'],{type:'image/jpeg'})],value:'x'}});
    assert.match(pixels.context.document.getElementById('ocrStatus').textContent,/16 MP/);
    assert.equal(pixels.context.document.getElementById('ocrRun').disabled,true);
});
test('OCR-01 ładuje Tesseract na żądanie, pokazuje postęp i pozwala poprawić pusty wynik', async () => {
    let scripts=0, workers=0;
    const h=harness(async()=>ok(),' ',true,null,null,{onScript(script, window) {
        scripts++;
        assert.equal(script.src,'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js');
        window.Tesseract={async createWorker(_lang,_mode,options) {
            workers++;
            options.logger({status:'recognizing text',progress:.6});
            assert.equal(h.context.document.getElementById('ocrProgress').value,60);
            return {recognize: async()=>({data:{text:''}}),terminate:async()=>{}};
        }};
        script.onload();
    }});
    assert.equal(scripts,0,'normal reader does not download OCR JavaScript');
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    assert.equal(scripts,0,'photo preview itself does not download OCR JavaScript');
    const photo=new Blob(['x'],{type:'image/webp'});
    await h.context.document.getElementById('ocrGalleryInput').listeners.change({target:{files:[photo],value:'x'}});
    await h.run('window.runOcr()');
    assert.equal(scripts,1); assert.equal(workers,1);
    assert.equal(h.context.document.getElementById('ocrText').hidden,false);
    h.run('window.applyOcrText()');
    assert.match(h.context.document.getElementById('ocrStatus').textContent,/Popraw lub wpisz/);
    h.context.document.getElementById('ocrText').value='Wpisany po OCR tekst.';
    h.run('window.applyOcrText()');
    assert.equal(h.run('currentDocument.text'),'Wpisany po OCR tekst.');
});
test('OCR-01 zamknięcie dialogu podczas inicjalizacji unieważnia wynik i zwalnia spóźnionego workera', async () => {
    let resolveWorker, terminated=0;
    const tesseract={createWorker:()=>new Promise(resolve=>{resolveWorker=resolve;})};
    const h=harness(async()=>ok(),' ',true,null,null,{tesseract});
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    const photo=new Blob(['photo'],{type:'image/jpeg'});
    await h.context.document.getElementById('ocrCameraInput').listeners.change({target:{files:[photo],value:'photo'}});
    const running=h.run('window.runOcr()');
    for(let i=0;i<12 && !resolveWorker;i++)await Promise.resolve();
    assert.ok(resolveWorker);
    h.run('window.closeAddContentDialog()');
    resolveWorker({recognize:async()=>({data:{text:'Spóźniony tekst.'}}),terminate:async()=>{terminated++;}});
    await running;
    for(let i=0;i<8;i++)await Promise.resolve();
    assert.equal(terminated,1);
    assert.equal(h.run('currentDocument'),null);
    assert.equal(h.context.document.getElementById('ocrPreview').width,0);
    assert.equal(h.context.document.getElementById('ocrText').value,'');
});
test('OCR-01 zmiana zakładki anuluje OCR bez przerywania bieżącego odtwarzania', async () => {
    let resolveRecognition, terminated=0;
    const tesseract={async createWorker() { return {recognize:()=>new Promise(resolve=>{resolveRecognition=resolve;}),
        terminate:async()=>{terminated++;}}; }};
    const h=harness(async()=>ok(),' ',true,true,null,{tesseract});
    h.run('renderSentences("Aktualny dokument.",[],{name:"aktualny.txt"}); window.startFrom(0)');
    await settle();
    const player=h.audios.at(-1), session=h.run('session');
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    const photo=new Blob(['photo'],{type:'image/jpeg'});
    await h.context.document.getElementById('ocrCameraInput').listeners.change({target:{files:[photo],value:'photo'}});
    const running=h.run('window.runOcr()');
    for(let i=0;i<12 && !resolveRecognition;i++)await Promise.resolve();
    assert.ok(resolveRecognition);
    assert.equal(h.run('session'),session,'OCR does not restart the audio session');
    assert.equal(h.audios.at(-1),player);
    h.run("window.switchTab('history')");
    resolveRecognition({data:{text:'Nieaktualny OCR.'}});
    await running;
    assert.equal(terminated,1);
    assert.equal(h.run('currentDocument.name'),'aktualny.txt');
    assert.equal(h.run('session'),session);
    assert.equal(h.audios.at(-1),player);
    assert.equal(h.context.document.getElementById('addContentDialog').open,false);
});
test('OCR-01 błąd pobrania biblioteki pozostawia dokument i pozwala ponowić OCR', async () => {
    let attempts=0;
    const h=harness(async()=>ok(),' ',true,null,null,{onScript(script, window) {
        attempts++;
        if(attempts===1)script.onerror();
        else {
            window.Tesseract={async createWorker(){return {recognize:async()=>({data:{text:'Odzyskany tekst.'}}),terminate:async()=>{}};}};
            script.onload();
        }
    }});
    h.run('renderSentences("Istniejący tekst.",[],{name:"stary.txt"})');
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    const photo=new Blob(['photo'],{type:'image/jpeg'});
    await h.context.document.getElementById('ocrCameraInput').listeners.change({target:{files:[photo],value:'photo'}});
    await h.run('window.runOcr()');
    assert.match(h.context.document.getElementById('ocrStatus').textContent,/nie powiodło/);
    assert.equal(h.run('currentDocument.name'),'stary.txt');
    assert.equal(h.context.document.getElementById('ocrRun').disabled,false);
    await h.run('window.runOcr()');
    assert.equal(attempts,2);
    assert.equal(h.context.document.getElementById('ocrText').value,'Odzyskany tekst.');
});
test('OCR-01 brak modułu OCR nie blokuje zwykłego importu i Lektora', async () => {
    const h=harness(async()=>ok(),' ',true,null,null,{skipModule:true});
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    assert.match(h.context.document.getElementById('importStatus').textContent,/chwilowo niedostępny/);
    h.run('window.showTextImport()');
    h.context.document.getElementById('rawText').value='Zwykły tekst działa.';
    h.run('window.applyText()'); await settle();
    assert.equal(h.run('currentDocument.text'),'Zwykły tekst działa.');
    h.run('window.startFrom(0)'); await settle();
    assert.equal(h.run('isReading'),true);
});
test('OCR-01 spóźnione dekodowanie zdjęcia nie zasłania nowo otwartego dokumentu', async () => {
    let resolveBitmap, closed=0;
    const h=harness(async()=>ok(),' ',true,null,null,{createImageBitmap:()=>new Promise(resolve=>{resolveBitmap=resolve;})});
    h.run('window.openAddContentDialog(); window.showPhotoImport()');
    const photo=new Blob(['photo'],{type:'image/png'});
    const decoding=h.context.document.getElementById('ocrGalleryInput').listeners.change({target:{files:[photo],value:'photo'}});
    assert.ok(resolveBitmap);
    h.run('renderSentences("Nowszy dokument.",[],{name:"nowszy.txt"})');
    resolveBitmap({width:1200,height:800,close(){closed++;}});
    await decoding;
    assert.equal(closed,1);
    assert.equal(h.run('currentDocument.name'),'nowszy.txt');
    assert.equal(h.context.document.getElementById('ocrPreview').hidden,true);
    assert.equal(h.context.document.getElementById('ocrRun').disabled,true);
});
(async () => {
    for (const [name, fn] of cases) {
        await fn();
        console.log(`OK: ${name}`);
    }
    console.log(`${cases.length} testów JavaScript zakończonych powodzeniem.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
