"""Optional Chromium integration: local import + real media events, synthetic WAV TTS.
Run from repo root: python tests/browser_segmentation.py
Requires development-only Playwright and Chromium; no external requests or synthesis.
"""
import io
import json
from pathlib import Path
import sys
import wave
from email import policy
from email.parser import BytesParser

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from fastapi.testclient import TestClient
from playwright.sync_api import sync_playwright

root = Path(__file__).parent / 'fixtures'
wave_output = io.BytesIO()
with wave.open(wave_output, 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(16000)
    audio.writeframes(b'\x00\x00' * 1600)
client = TestClient(main.app)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for fixture, mode, query in [(fixture, mode, query) for fixture in ['wrapped_document', 'metadata_document']
                           for mode in ['manual', 'txt', 'pdf', 'docx']
                           for query in ['', '?buffer=0', '?test=1&buffer=0', '?test=1&buffer=2']]:
        expected = json.loads((root / (fixture + '.expected.json')).read_text())
        page = browser.new_page(viewport={'width': 393, 'height': 852})
        page.add_init_script('''
            window.probe = {active: 0, maximum: 0, playing: [], created: [], revoked: [], unsafeReleases: []};
            const nativeFetch = window.fetch;
            window.fetch = async (...args) => {
                if (args[0] !== '/tts') return nativeFetch(...args);
                probe.active++; probe.maximum = Math.max(probe.maximum, probe.active);
                let finished = false;
                const finish = () => {if (!finished) {finished = true; probe.active--;}};
                try {
                    const response = await nativeFetch(...args);
                    for (const kind of ['blob', 'json']) {
                        const read = response[kind].bind(response);
                        response[kind] = async () => {try {return await read();} finally {finish();}};
                    }
                    return response;
                } catch (error) {finish(); throw error;}
            };
            const NativeAudio = window.Audio;
            window.Audio = function(...args) {
                const player = new NativeAudio(...args);
                player.addEventListener('playing', () => probe.playing.push(currentIdx));
                return player;
            };
            const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => {const url = create(blob); probe.created.push(url); return url;};
            URL.revokeObjectURL = url => {
                if (audio.src === url) probe.unsafeReleases.push(url);
                probe.revoked.push(url); revoke(url);
            };
        ''')
        sent = []
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: (print('DIALOG:', dialog.message, flush=True), dialog.accept()))

        def route_request(route):
            request = route.request
            if request.url == 'https://reader.test/' + query:
                route.fulfill(status=200, content_type='text/html', body=main.HTML_PAGE)
                return
            if request.url in ['https://reader.test/upload', 'https://reader.test/tts']:
                message = BytesParser(policy=policy.default).parsebytes(
                    b'Content-Type: ' + request.headers['content-type'].encode() +
                    b'\r\nMIME-Version: 1.0\r\n\r\n' + request.post_data_buffer)
                parts = {part.get_param('name', header='content-disposition'): part for part in message.iter_parts()}
                if request.url.endswith('/upload'):
                    part = parts['file']
                    # Chromium interception can omit file bytes from post_data_buffer.
                    # Use the same synthetic fixture for the local API import.
                    filename = part.get_filename()
                    assert filename == fixture + '.' + mode
                    response = client.post('/upload', files={'file': (filename, (root / filename).read_bytes())})
                    route.fulfill(status=response.status_code, content_type='application/json', body=response.text)
                else:
                    sent.append(parts['text'].get_payload(decode=True).decode('utf-8'))
                    route.fulfill(status=200, content_type='audio/wav', body=wave_output.getvalue())
                return
            route.abort()

        page.route('**/*', route_request)
        page.goto('https://reader.test/' + query)
        assert page.evaluate('bufferMode') == (0 if 'buffer=0' in query else 2)
        if mode == 'manual':
            page.evaluate("window.switchTab('editor')")
            page.locator('#rawText').fill((root / (fixture + '.txt')).read_text())
            page.locator('.apply-btn').click()
        else:
            page.locator('#fileInput').set_input_files(str(root / (fixture + '.' + mode)))
        try:
            page.wait_for_function('(count) => sentences.length === count', arg=len(expected), timeout=5000)
        except Exception:
            print('DEBUG', mode, page.evaluate('({sentences, raw: document.getElementById("rawText").value, status: document.getElementById("statusText").innerText})'), errors, flush=True)
            raise
        assert page.evaluate('sentences') == expected, mode
        displayed = page.locator('#readerView .sentence').all_inner_texts()
        assert [' '.join(text.split()) for text in displayed] == expected, mode
        page.locator('#playBtn').click()
        page.wait_for_function("document.getElementById('statusText').innerText === 'Zakończono czytanie'", timeout=20000)
        assert sent == expected, (mode, sent)
        probe = page.evaluate('probe')
        assert probe['maximum'] == 1, probe
        assert probe['playing'] == list(range(len(expected))), probe
        assert probe['unsafeReleases'] == [], probe
        assert sorted(probe['created']) == sorted(probe['revoked']), probe
        assert page.evaluate('prefetchCache.size') == 0
        if 'test=1' in query:
            report = page.evaluate('diagnosticReport()')
            assert report['gaps']['count'] == len(expected) - 1, report
            assert report['failed_transitions'] == 0, report
            assert report['groups'][f'buffer={query[-1]}/visible']['count'] == len(expected) - 1
            assert not any(text in json.dumps(report, ensure_ascii=False) for text in expected)
            stores = [event for event in report['events'] if event['type'] == 'cache_store']
            assert all(event['cache_fragments'] <= 3 and event['cache_bytes'] <= 8 * 1024 * 1024 for event in stores)
            if mode == 'manual':
                with page.expect_download() as download:
                    page.locator('#diagnosticDownload').click()
                downloaded = json.loads(Path(download.value.path()).read_text())
                assert downloaded['schema'] == 'MOB-03A/1'
                assert downloaded['gaps'] == report['gaps']
                assert page.locator('#diagnosticDownload').is_visible()
        else:
            assert page.locator('#diagnosticDownload').count() == 0
            assert page.evaluate('diagnosticReport()') is None
        assert not errors, errors
        print(f'PASS Chromium {fixture}/{mode}/{query or "standard"}: {len(expected)} exact TTS payloads, ordered playback, serial fetch, released URLs', flush=True)
        page.close()
    # A DOM element can be "visible" yet clipped by body overflow:hidden.
    # Check full rectangles and hit targets before clicks (which can auto-scroll).
    for width, height in [(360, 640), (393, 852)]:
        for buffer in [0, 2]:
            for tab in ['reader', 'editor']:
                page = browser.new_page(viewport={'width': width, 'height': height})
                query = f'?test=1&buffer={buffer}'
                page.route('**/*', lambda route: route.fulfill(content_type='text/html', body=main.HTML_PAGE)
                           if route.request.url == 'https://reader.test/' + query else route.abort())
                page.goto('https://reader.test/' + query)
                page.evaluate('(tab) => {renderSentences("Test dokumentu. ".repeat(100)); window.switchTab(tab);}', tab)
                for status in ['Gotowy', 'Oczekiwanie na TTS • przerwa 120 s • próba 3/3 • zdanie 100/100',
                               'Błąd odtwarzania: Usługa syntezy nie zwróciła audio. Wyczerpano 3 próby. Naciśnij ▶, aby wznowić ten sam fragment po przerwie.']:
                    page.evaluate('(status) => setStatus(status)', status)
                    geometry = page.evaluate('''() => {
                        const ids=['diagnosticBuffer','diagnosticDownload','diagnosticCopy','playBtn'];
                        const nodes=ids.map(id=>document.getElementById(id));
                        nodes.push(nodes[1].parentElement.parentElement);
                        return nodes.map(e=>{const r=e.getBoundingClientRect();return {
                            id:e.id || 'panel', top:r.top, bottom:r.bottom,
                            inside:r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth,
                            hit:e.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2))};});
                    }''')
                    assert all(item['inside'] and item['hit'] for item in geometry), (width, height, tab, status, geometry)
                with page.expect_download() as download:
                    page.locator('#diagnosticDownload').click()
                report = json.loads(Path(download.value.path()).read_text())
                assert report['schema'] == 'MOB-03A/1' and report['buffer'] == buffer
                assert 'Test dokumentu' not in json.dumps(report)
                assert page.evaluate('window.scrollY') == 0
                print(f'PASS Chromium panel {width}x{height}/buffer={buffer}/{tab}: geometry, hit targets, JSON download', flush=True)
                page.close()
    browser.close()
