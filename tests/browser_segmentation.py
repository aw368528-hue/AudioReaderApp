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
expected = json.loads((root / 'wrapped_document.expected.json').read_text())
wave_output = io.BytesIO()
with wave.open(wave_output, 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(16000)
    audio.writeframes(b'\x00\x00' * 1600)
client = TestClient(main.app)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for mode in ['manual', 'txt', 'pdf', 'docx']:
        page = browser.new_page(viewport={'width': 393, 'height': 852})
        sent = []
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: (print('DIALOG:', dialog.message, flush=True), dialog.accept()))

        def route_request(route):
            request = route.request
            if request.url == 'https://reader.test/':
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
                    assert filename == 'wrapped_document.' + mode
                    response = client.post('/upload', files={'file': (filename, (root / filename).read_bytes())})
                    route.fulfill(status=response.status_code, content_type='application/json', body=response.text)
                else:
                    sent.append(parts['text'].get_payload(decode=True).decode('utf-8'))
                    route.fulfill(status=200, content_type='audio/wav', body=wave_output.getvalue())
                return
            route.abort()

        page.route('**/*', route_request)
        page.goto('https://reader.test/')
        if mode == 'manual':
            page.evaluate("window.switchTab('editor')")
            page.locator('#rawText').fill((root / 'wrapped_document.txt').read_text())
            page.locator('.apply-btn').click()
        else:
            page.locator('#fileInput').set_input_files(str(root / ('wrapped_document.' + mode)))
        try:
            page.wait_for_function('sentences.length === 7', timeout=5000)
        except Exception:
            print('DEBUG', mode, page.evaluate('({sentences, raw: document.getElementById("rawText").value, status: document.getElementById("statusText").innerText})'), errors, flush=True)
            raise
        assert page.evaluate('sentences') == expected, mode
        displayed = page.locator('#readerView .sentence').all_inner_texts()
        assert [' '.join(text.split()) for text in displayed] == expected, mode
        page.locator('#playBtn').click()
        page.wait_for_function("document.getElementById('statusText').innerText === 'Zakończono czytanie'", timeout=20000)
        assert sent == expected, (mode, sent)
        assert not errors, errors
        print(f'PASS Chromium {mode}: 7 exact TTS payloads, real ended events, no JS errors', flush=True)
        page.close()
    browser.close()
