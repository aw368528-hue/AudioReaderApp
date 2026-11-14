import io
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
                                      (TimeoutError(), 503, 'communication_error')]:
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

    def test_frontend(self):
        # Test the actual JavaScript returned by FastAPI, after Python escaping.
        script = self.client.get('/').text.split('<script>')[1].split('</script>')[0]
        result = subprocess.run(['node', 'tests/reader.test.cjs'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout.strip())


if __name__ == '__main__':
    unittest.main()
