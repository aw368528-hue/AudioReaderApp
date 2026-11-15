(function (root) {
  'use strict';
  const MAX_FILE_BYTES = 12 * 1024 * 1024;
  const MAX_SOURCE_PIXELS = 16 * 1000 * 1000;
  const MAX_EDGE = 2600;
  const MODEL_BYTES = 2026921;
  const TIMEOUT_MS = 90000;

  root.ocrProbeLimits = {MAX_FILE_BYTES, MAX_SOURCE_PIXELS, MODEL_BYTES};
  if (typeof document === 'undefined') return;

  const el = id => document.getElementById(id);
  const canvas = el('preview'), context = canvas.getContext('2d', {willReadFrequently: true});
  const measurements = [];
  let worker = null, busy = false, activeAttempt = null, generation = 0, imageSequence = 0, scoreRequest = 0;
  let stopScoring = null;
  let loaded = false, selectedFile = null, sourcePixels = 0, preprocessingMs = 0;
  let selectedFileBytes = 0;
  const status = message => { el('status').textContent = message; };
  const render = () => { el('measurements').textContent = JSON.stringify(measurements, null, 2); };

  function modelNetworkCache(since) {
    const entries = performance.getEntriesByType?.('resource') || [];
    const model = entries.findLast?.(entry => entry.startTime >= since && entry.name.endsWith('/ocr-probe-assets/pol.traineddata.gz'));
    if (!model) return 'not-observed'; // The language data may have come from Tesseract's IndexedDB cache.
    if (model.transferSize > 0) return 'network-transfer-observed';
    if (model.encodedBodySize > 0) return 'browser-cache-observed';
    return 'unclassified';
  }

  function resetWorker() {
    const old = worker; worker = null;
    if (old) Promise.resolve(old.terminate()).catch(() => {});
  }

  function cancelRecognition(message = 'Anulowano.') {
    generation++;
    if (stopScoring) stopScoring();
    // Terminate only an in-flight recognition; a completed worker stays warm for the next image.
    if (busy) resetWorker();
    busy = false;
    if (activeAttempt?.status === 'running') {
      activeAttempt.status = 'cancelled'; activeAttempt.error = 'cancelled'; render();
    }
    activeAttempt = null;
    el('run').disabled = false;
    status(message);
  }

  function scoreLatest(token, attempt, reference, recognized, announce) {
    if (!reference.trim()) return;
    if (stopScoring) stopScoring();
    for (const key of ['cer', 'wer', 'referenceCharacters', 'referenceWords']) delete attempt[key];
    attempt.scoreError = 'pending'; render();
    if (reference.length > 5000 || recognized.length > 5000) {
      attempt.scoreError = 'text_limit'; render();
      if (announce) status('Nie obliczono CER/WER: limit 5000 znaków.');
      return;
    }
    if (typeof Worker === 'undefined') {
      attempt.scoreError = 'worker_unavailable'; render();
      if (announce) status('Przeglądarka nie obsługuje workera miar.');
      return;
    }
    const request = ++scoreRequest;
    let scoreWorker;
    try { scoreWorker = new Worker('/ocr-probe-assets/metrics-worker.js'); }
    catch {
      attempt.scoreError = 'worker_failed'; render();
      if (announce) status('Nie można uruchomić workera miar.');
      return;
    }
    let done = false;
    const timeout = setTimeout(() => finish(null, 'calculation_timeout'), 15000);
    stopScoring = () => {
      done = true; clearTimeout(timeout); scoreWorker.terminate(); stopScoring = null;
      if (attempt.scoreError === 'pending') { attempt.scoreError = 'cancelled'; render(); }
    };
    function finish(quality, error) {
      if (done) return;
      stopScoring();
      if (token !== generation || request !== scoreRequest || attempt !== measurements[measurements.length - 1]) return;
      attempt.scoreError = error;
      if (quality) Object.assign(attempt, quality);
      render();
      if (announce) status(error ? `Nie obliczono CER/WER: ${error}.` : 'Przeliczono CER i WER dla ostatniej próby.');
    }
    scoreWorker.onmessage = event => finish(event.data.quality, event.data.error);
    scoreWorker.onerror = () => finish(null, 'worker_failed');
    try { scoreWorker.postMessage({id: attempt.sample, reference, recognized}); }
    catch { finish(null, 'worker_failed'); }
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
    cancelRecognition('Dekodowanie zdjęcia…'); const token = generation; loaded = false; selectedFile = null;
    el('result').value = ''; el('reference').value = '';
    canvas.width = canvas.height = 0;
    try {
      const file = event.target.files?.[0];
      await decode(file, token);
      if (token !== generation) return;
      selectedFile = file; imageSequence++;
      status(`Obraz gotowy: ${canvas.width} × ${canvas.height} px. Możesz uruchomić OCR.`);
    } catch (error) { if (token === generation) status(error.message); }
  });

  el('run').addEventListener('click', async () => {
    if (!loaded) { status('Najpierw wybierz poprawny obraz.'); return; }
    if (!root.Tesseract?.createWorker) { status('Nie udało się pobrać Tesseract.js. Sprawdź połączenie z CDN.'); return; }
    if (stopScoring) stopScoring();
    const token = ++generation, cold = !worker, started = performance.now();
    const grayscale = el('grayscale').checked;
    let modelResourceSince = started;
    const attempt = {sample: measurements.length + 1, image: imageSequence, category: el('category').value,
      variant: grayscale ? 'grayscale' : 'original', cold, workerReused: !cold,
      networkCache: cold ? 'pending' : 'worker-reused-no-fetch', status: 'running', error: null, scoreError: null};
    measurements.push(attempt); activeAttempt = attempt; busy = true; render();
    el('run').disabled = true;
    let timeout;
    try {
      status(cold ? 'Pobieranie modelu i uruchamianie workera…' : 'Rozpoznawanie w gotowym workerze…');
      const limit = new Promise((_, reject) => { timeout = setTimeout(() => {
        cancelRecognition('Przekroczono 90 sekund. Model zwolniony.');
        attempt.status = 'error'; attempt.error = 'timeout'; render(); reject(new Error('timeout'));
      }, TIMEOUT_MS); });
      const operation = (async () => {
        await decode(selectedFile, token); // Restore original pixels before every comparison run.
        let initMs = 0;
        if (!worker) {
          const initStart = performance.now();
          modelResourceSince = initStart;
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
        if (grayscale) {
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
      const memory = performance.memory?.usedJSHeapSize || null;
      Object.assign(attempt, {status: 'success', error: null,
        networkCache: cold ? modelNetworkCache(modelResourceSince) : 'worker-reused-no-fetch',
        imageBytes: selectedFileBytes, sourcePixels, processedWidth: canvas.width, processedHeight: canvas.height,
        modelBytes: MODEL_BYTES, preprocessMs: Math.round(preprocessingMs + extraPreprocessMs), initMs: Math.round(initMs),
        ocrMs: Math.round(ocrMs), totalMs: Math.round(performance.now() - started),
        textCharacters: Array.from(text).length, jsHeapBytesApprox: memory});
      busy = false; activeAttempt = null;
      render();
      scoreLatest(token, attempt, el('reference').value, text, false);
      status(text.trim() ? 'Rozpoznano. Sprawdź polskie znaki, kolejność i akapity.' : 'Brak tekstu. Spróbuj innego zdjęcia.');
    } catch (error) {
      if (token === generation) {
        attempt.status = 'error'; attempt.error = 'ocr_failure';
        resetWorker(); busy = false; activeAttempt = null; render();
        status('OCR nie powiodło się: ' + (error?.message || 'błąd modelu'));
      }
    } finally { clearTimeout(timeout); if (token === generation) el('run').disabled = false; }
  });

  el('cancel').addEventListener('click', () => { cancelRecognition('Anulowano. Model zwolniony.'); resetWorker(); });
  el('score').addEventListener('click', () => {
    if (!measurements.length) return status('Najpierw uruchom OCR.');
    const attempt = measurements[measurements.length - 1];
    if (attempt.status !== 'success') return status('Najpierw ukończ OCR.');
    if (!el('reference').value.trim()) {
      if (stopScoring) stopScoring();
      for (const key of ['cer', 'wer', 'referenceCharacters', 'referenceWords']) delete attempt[key];
      attempt.scoreError = 'empty_reference'; render();
      return status('Wpisz transkrypcję referencyjną.');
    }
    scoreLatest(generation, attempt, el('reference').value, el('result').value, true);
  });
  el('export').addEventListener('click', () => {
    const report = {prototype: 'OCR-01-gate-0', tesseract: '7.0.0', language: 'pol-tessdata_fast', measurements};
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'ocr-01-pomiary.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  addEventListener('pagehide', () => { cancelRecognition('Model zwolniony.'); resetWorker(); });
})(globalThis);
