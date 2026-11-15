(function (root) {
  'use strict';
  const MAX_FILE_BYTES = 12 * 1024 * 1024;
  const MAX_SOURCE_PIXELS = 16 * 1000 * 1000;
  const MAX_EDGE = 2600;
  const MODEL_BYTES = 2026921;
  const TIMEOUT_MS = 90000;

  function distance(left, right) {
    let a = Array.from(left), b = Array.from(right);
    if (a.length > b.length) [a, b] = [b, a];
    let row = Array.from({length: a.length + 1}, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      const next = [j];
      for (let i = 1; i <= a.length; i++)
        next[i] = Math.min(next[i - 1] + 1, row[i] + 1, row[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[a.length];
  }

  function score(reference, recognized) {
    const normalize = value => value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
    const expected = normalize(reference), actual = normalize(recognized);
    if (!expected || expected.length > 5000 || actual.length > 5000) return null;
    const characters = Array.from(expected), words = expected.split(' ');
    return {cer: distance(characters, Array.from(actual)) / characters.length,
      wer: distance(words, actual ? actual.split(' ') : []) / words.length,
      referenceCharacters: characters.length, referenceWords: words.length};
  }
  root.ocrProbeMetrics = {distance, score, MAX_FILE_BYTES, MAX_SOURCE_PIXELS, MODEL_BYTES};
  if (typeof document === 'undefined') return;

  const el = id => document.getElementById(id);
  const canvas = el('preview'), context = canvas.getContext('2d', {willReadFrequently: true});
  const measurements = [];
  let worker = null, generation = 0, loaded = false, selectedFile = null, sourcePixels = 0, preprocessingMs = 0;
  let selectedFileBytes = 0;
  const status = message => { el('status').textContent = message; };
  const render = () => { el('measurements').textContent = JSON.stringify(measurements, null, 2); };

  function cancel(message = 'Anulowano. Model zwolniony.') {
    generation++;
    const old = worker; worker = null;
    if (old) Promise.resolve(old.terminate()).catch(() => {});
    el('run').disabled = false;
    status(message);
  }

  async function decode(file, token) {
    if (!file || file.size === 0 || file.size > MAX_FILE_BYTES) throw new Error('Wybierz pojedynczy obraz do 12 MB.');
    const started = performance.now();
    let bitmap;
    try { bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
    catch { try { bitmap = await createImageBitmap(file); } catch { throw new Error('Przeglądarka nie dekoduje tego obrazu. Wybierz PNG, JPEG lub WebP.'); } }
    try {
      if (token !== generation) throw new Error('Anulowano wybór zdjęcia.');
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_SOURCE_PIXELS)
        throw new Error('Obraz przekracza limit 16 megapikseli. Zmniejsz go przed próbą.');
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      sourcePixels = bitmap.width * bitmap.height;
      selectedFileBytes = file.size;
      loaded = true;
      preprocessingMs = performance.now() - started;
    } finally { bitmap.close(); }
  }

  el('photo').addEventListener('change', async event => {
    cancel('Dekodowanie zdjęcia…'); const token = generation; loaded = false; selectedFile = null; el('result').value = '';
    canvas.width = canvas.height = 0;
    try {
      const file = event.target.files?.[0];
      await decode(file, token);
      if (token !== generation) return;
      selectedFile = file;
      status(`Obraz gotowy: ${canvas.width} × ${canvas.height} px. Możesz uruchomić OCR.`);
    } catch (error) { if (token === generation) status(error.message); }
  });

  el('run').addEventListener('click', async () => {
    if (!loaded) { status('Najpierw wybierz poprawny obraz.'); return; }
    if (!root.Tesseract?.createWorker) { status('Nie udało się pobrać Tesseract.js. Sprawdź połączenie z CDN.'); return; }
    const token = ++generation, cold = !worker, started = performance.now();
    el('run').disabled = true;
    let timeout;
    try {
      status(cold ? 'Pobieranie modelu i uruchamianie workera…' : 'Rozpoznawanie w gotowym workerze…');
      const limit = new Promise((_, reject) => { timeout = setTimeout(() => { cancel('Przekroczono 90 sekund. Model zwolniony.'); reject(new Error('timeout')); }, TIMEOUT_MS); });
      const operation = (async () => {
        await decode(selectedFile, token); // Restore original pixels before every comparison run.
        let initMs = 0;
        if (!worker) {
          const initStart = performance.now();
          const created = await root.Tesseract.createWorker('pol', 1, {
            workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
            corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
            langPath: `${location.origin}/ocr-probe-assets`,
            logger: event => { if (token === generation && event.status) status(`OCR: ${event.status} ${Math.round((event.progress || 0) * 100)}%`); }
          });
          if (token !== generation) { await created.terminate(); throw new Error('cancelled'); }
          worker = created; initMs = performance.now() - initStart;
        }
        const processStart = performance.now();
        if (el('grayscale').checked) {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < pixels.data.length; i += 4) {
            const gray = Math.round(pixels.data[i] * .299 + pixels.data[i + 1] * .587 + pixels.data[i + 2] * .114);
            pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
          }
          context.putImageData(pixels, 0, 0);
        }
        const ocrStart = performance.now();
        const result = await worker.recognize(canvas);
        return {result, initMs, extraPreprocessMs: ocrStart - processStart, ocrMs: performance.now() - ocrStart};
      })();
      const {result, initMs, extraPreprocessMs, ocrMs} = await Promise.race([operation, limit]);
      if (token !== generation) return;
      const text = String(result.data?.text || '');
      el('result').value = text;
      const quality = score(el('reference').value, text);
      const memory = performance.memory?.usedJSHeapSize || null;
      measurements.push({sample: measurements.length + 1, category: el('category').value,
        variant: el('grayscale').checked ? 'grayscale' : 'original', cold,
        imageBytes: selectedFileBytes, sourcePixels, processedWidth: canvas.width, processedHeight: canvas.height,
        modelBytes: MODEL_BYTES, preprocessMs: Math.round(preprocessingMs + extraPreprocessMs), initMs: Math.round(initMs),
        ocrMs: Math.round(ocrMs), totalMs: Math.round(performance.now() - started),
        textCharacters: Array.from(text).length, jsHeapBytesApprox: memory, ...quality});
      render();
      status(text.trim() ? 'Rozpoznano. Sprawdź polskie znaki, kolejność i akapity.' : 'Brak tekstu. Spróbuj innego zdjęcia.');
    } catch (error) {
      if (token === generation) { cancel('OCR nie powiodło się: ' + (error?.message || 'błąd modelu')); }
    } finally { clearTimeout(timeout); if (token === generation) el('run').disabled = false; }
  });

  el('cancel').addEventListener('click', () => cancel());
  el('score').addEventListener('click', () => {
    if (!measurements.length) return status('Najpierw uruchom OCR.');
    const quality = score(el('reference').value, el('result').value);
    if (!quality) return status('Wpisz transkrypcję referencyjną do 5000 znaków.');
    Object.assign(measurements[measurements.length - 1], quality);
    render(); status('Przeliczono CER i WER dla ostatniej próby.');
  });
  el('export').addEventListener('click', () => {
    const report = {prototype: 'OCR-01-gate-0', tesseract: '7.0.0', language: 'pol-tessdata_fast', measurements};
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'ocr-01-pomiary.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  addEventListener('pagehide', () => cancel('Model zwolniony.'));
})(globalThis);
