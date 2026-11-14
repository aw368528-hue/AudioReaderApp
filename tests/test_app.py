import io
import asyncio
import json
import logging
from pathlib import Path
import subprocess
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

import main


def pdf_bytes(lines):
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    content = DecodedStreamObject()
    commands = ['BT /F1 12 Tf 16 TL 50 780 Td']
    for index, line in enumerate(lines):
        if index:
            commands.append('T*')
        if line:
            commands.append(f'({line}) Tj')
    commands.append('ET')
    content.set_data('\n'.join(commands).encode('ascii'))
    page[NameObject('/Contents')] = writer._add_object(content)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_pdf_single_line_wraps(self):
        response = self.client.post('/upload', files={'file': ('sample.pdf', pdf_bytes(['Ala', 'ma', 'kota.']), 'application/pdf')})
        self.assertEqual(response.json()['text'], 'Ala ma kota.')

    def test_pdf_paragraphs(self):
        response = self.client.post('/upload', files={'file': ('sample.pdf', pdf_bytes(['Pierwszy akapit.', '', 'Drugi akapit.']), 'application/pdf')})
        self.assertEqual(response.json()['text'], 'Pierwszy akapit.\n\nDrugi akapit.')

    def test_pdf_indentation_and_lists(self):
        self.assertEqual(main.normalize_pdf_text('    Ala\n    ma kota\n\nLista\n- jeden\n- dwa'),
                         'Ala ma kota\n\nLista\n\n- jeden\n\n- dwa')
        self.assertEqual(main.normalize_pdf_text('Akapit\n  Nowy akapit\nkontynuacja'), 'Akapit\n\nNowy akapit kontynuacja')

    def test_docx_paragraphs(self):
        import docx
        doc = docx.Document()
        doc.add_paragraph('Jeden')
        doc.add_paragraph('Dwa')
        buf = io.BytesIO()
        doc.save(buf)
        response = self.client.post('/upload', files={'file': ('sample.docx', buf.getvalue())})
        self.assertEqual(response.json()['text'], 'Jeden\n\nDwa')

    def test_empty_tts_and_invalid_fields(self):
        with patch.object(main.edge_tts, 'Communicate') as communicate:
            for text in ['', ' ', '\n\t']:
                response = self.client.post('/tts', data={'text': text, 'voice': 'pl-PL-ZofiaNeural', 'rate': 0})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['code'], 'invalid_input')
            for values in [{'voice': 'bad', 'rate': 0}, {'voice': 'pl-PL-MarekNeural', 'rate': 100}]:
                self.assertEqual(self.client.post('/tts', data={'text': 'Tekst', **values}).status_code, 400)
            communicate.assert_not_called()
        self.assertEqual(self.client.post('/tts', data={'text': 'A', 'rate': 'bad'}).status_code, 422)

    def test_tts_errors_and_cleanup(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        for error, code, category in [(RuntimeError('provider'), 502, 'synthesis_error'),
                                      (main.ClientError('network'), 503, 'communication_error'),
                                      (TimeoutError(), 504, 'timeout')]:
            paths = []
            async def fail(path):
                paths.append(path)
                raise error
            with patch.object(main.edge_tts, 'Communicate') as communicate:
                communicate.return_value.save = fail
                response = self.client.post('/tts', data={'text': 'Tekst.', 'voice': 'pl-PL-ZofiaNeural', 'rate': 0})
            self.assertEqual(response.status_code, code)
            self.assertEqual(response.json()['code'], category)
            self.assertTrue(paths)
            self.assertFalse(Path(paths[0]).exists())

    def test_tts_success_both_voices(self):
        for voice in ['pl-PL-ZofiaNeural', 'pl-PL-MarekNeural']:
            async def save(path):
                Path(path).write_bytes(b'test-audio')
            with patch.object(main.edge_tts, 'Communicate') as communicate:
                communicate.return_value.save = save
                response = self.client.post('/tts', data={'text': ' Tekst. ', 'voice': voice, 'rate': 10})
                communicate.assert_called_once_with('Tekst.', voice, rate='+10%')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, b'test-audio')
            self.assertEqual(response.headers['content-type'], 'audio/mpeg')

    def test_tts_empty_audio(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        with patch.object(main.edge_tts, 'Communicate') as communicate:
            communicate.return_value.save = AsyncMock()
            response = self.client.post('/tts', data={'text': 'Tekst', 'voice': 'pl-PL-ZofiaNeural'})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()['code'], 'no_audio')

    def test_repeated_no_audio_diagnostics(self):
        secret = 'PRYWATNY-TEKST-TESTOWY'
        for _ in range(3):
            with patch.object(main.edge_tts, 'Communicate') as communicate, self.assertLogs('uvicorn.error.tts') as logs:
                communicate.return_value.save = AsyncMock(side_effect=main.NoAudioReceived(secret))
                response = self.client.post('/tts', data={'text': secret, 'voice': 'pl-PL-ZofiaNeural'})
            self.assertEqual(response.status_code, 502)
            self.assertEqual(response.json()['code'], 'no_audio')
            self.assertTrue(response.json()['retryable'])
            self.assertEqual(response.headers['retry-after'], '10')
            self.assertIn('edge_tts=' + main.TTS_VERSION, logs.output[0])
            self.assertIn('exception=NoAudioReceived', logs.output[0])
            self.assertNotIn(secret, ''.join(logs.output) + response.text)
            self.assertEqual(response.headers['x-tts-request-id'], response.json()['request_id'])

    def test_connection_refusal_and_provider_rejection(self):
        from aiohttp import ClientResponseError
        errors = [(ConnectionRefusedError('secret'), 'connection_refused', True),
                  (ClientResponseError(None, (), status=429, message='secret', headers={'Retry-After': '120'}), 'connection_rejected', False)]
        for error, code, retryable in errors:
            with patch.object(main.edge_tts, 'Communicate') as communicate, self.assertLogs('uvicorn.error.tts') as logs:
                communicate.return_value.save = AsyncMock(side_effect=error)
                response = self.client.post('/tts', data={'text': 'Test', 'voice': 'pl-PL-MarekNeural'})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()['code'], code)
            self.assertEqual(response.json()['retryable'], retryable)
            self.assertNotIn('secret', ''.join(logs.output))
            if code == 'connection_rejected':
                self.assertEqual(response.headers['retry-after'], '120')

    def check_segment_cases(self, cases):
        script = self.client.get('/').text.split('<script>')[1].split('</script>')[0]
        result = subprocess.run(['node', 'tests/segment_check.cjs'],
                                input=json.dumps({'script': script, 'cases': cases}),
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout.strip())

    def test_realistic_files_and_manual_text_exact_speech(self):
        root = Path(__file__).parent / 'fixtures'
        expected = json.loads((root / 'wrapped_document.expected.json').read_text())
        original = (root / 'wrapped_document.txt').read_text()
        cases = [{'name': 'manual', 'text': original, 'expected': expected}]
        for suffix in ['txt', 'pdf', 'docx']:
            response = self.client.post('/upload', files={'file': ('sample.' + suffix,
                                       (root / ('wrapped_document.' + suffix)).read_bytes())})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('error', response.json())
            data = response.json()
            # Verify extraction has not already lost, repeated or reordered words.
            self.assertEqual(data['text'].split(), original.split(), suffix)
            cases.append({'name': suffix, **data, 'expected': expected})
        self.check_segment_cases(cases)
        received = []
        async def save(path):
            Path(path).write_bytes(b'test-audio')
        with patch.object(main.edge_tts, 'Communicate') as communicate:
            def create(text, *args, **kwargs):
                received.append(text)
                result = AsyncMock()
                result.save = save
                return result
            communicate.side_effect = create
            for fragment in expected:
                self.assertEqual(self.client.post('/tts', data={'text': fragment, 'voice': 'pl-PL-ZofiaNeural'}).status_code, 200)
        self.assertEqual(received, expected)

    def test_docx_semantic_lists_wrapped_lines_and_unicode_offsets(self):
        import docx
        doc = docx.Document()
        doc.add_paragraph('Tekst z emoji 🚀 trwa dalej.')
        doc.add_heading('Ocena ryzyka', level=1)
        doc.add_paragraph('Pierwsza lista z Risk\nEngine i kontrolą.', style='List Number')
        doc.add_paragraph('Druga pozycja bez kropki', style='List Number')
        output = io.BytesIO()
        doc.save(output)
        data = self.client.post('/upload', files={'file': ('sample.docx', output.getvalue())}).json()
        self.assertEqual([block['kind'] for block in data['blocks']], ['body','heading','list','list'])
        self.check_segment_cases([{'name': 'semantic DOCX', **data, 'expected': [
            'Tekst z emoji 🚀 trwa dalej.',
            'Ocena ryzyka Pierwsza lista z Risk Engine i kontrolą.',
            'Druga pozycja bez kropki']}])

    def test_txt_encoding_no_silent_content_loss(self):
        text = 'Zażółć gęślą jaźń.\n\nRisk Engine działa.'
        for content in [text.encode('utf-8'), text.encode('utf-8-sig')]:
            response = self.client.post('/upload', files={'file': ('sample.txt', content)})
            self.assertEqual(response.json()['text'], text)
        response = self.client.post('/upload', files={'file': ('sample.txt', text.encode('cp1250'))})
        self.assertIn('error', response.json())
        self.assertNotIn('text', response.json())

    def test_long_unpunctuated_fragment_and_45_second_timeout(self):
        # A formatting break must not introduce arbitrary cuts or content loss.
        text = ('Bardzo długa wypowiedź bez interpunkcji i bez pomijania treści ' * 2000).strip()
        boundary = text.rfind(' ', 0, len(text)//2)
        formatted = text[:boundary] + '\n\n' + text[boundary+1:]
        expected = text
        self.check_segment_cases([{'name': 'long unpunctuated (120k chars)',
                                  'text': formatted, 'expected': [expected]}])
        original_wait_for = asyncio.wait_for
        timeouts = []
        cancelled = []
        paths = []
        async def accelerated_wait_for(awaitable, timeout):
            timeouts.append(timeout)
            return await original_wait_for(awaitable, timeout=0.01)
        async def slow_save(path):
            paths.append(path)
            try:
                await asyncio.sleep(5)
            finally:
                cancelled.append(True)
        with patch.object(main.edge_tts, 'Communicate') as communicate, \
                patch.object(main.asyncio, 'wait_for', side_effect=accelerated_wait_for), \
                self.assertLogs('uvicorn.error.tts'):
            communicate.return_value.save = slow_save
            response = self.client.post('/tts', data={'text': expected, 'voice': 'pl-PL-ZofiaNeural'})
            self.assertEqual(communicate.call_args.args[0], expected)
        self.assertEqual(timeouts, [45])
        self.assertEqual(cancelled, [True])
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()['code'], 'timeout')
        self.assertTrue(response.json()['retryable'])
        self.assertEqual(response.headers['retry-after'], '8')
        self.assertFalse(Path(paths[0]).exists())

    def test_frontend(self):
        # Test the actual JavaScript returned by FastAPI, after Python escaping.
        script = self.client.get('/').text.split('<script>')[1].split('</script>')[0]
        result = subprocess.run(['node', 'tests/reader.test.cjs'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout.strip())


if __name__ == '__main__':
    unittest.main()
