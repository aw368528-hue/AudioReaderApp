(function (root) {
    'use strict';
    root.createOcrImport = function(callbacks) {
    const OCR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    const OCR_MAX_FILE_BYTES = 12 * 1024 * 1024;
    const OCR_MAX_SOURCE_PIXELS = 16 * 1000 * 1000;
    const OCR_MAX_EDGE = 2600;
    const OCR_TIMEOUT_MS = 90000;
    let ocrLibraryPromise = null;
    let ocrWorker = null;
    let ocrGeneration = 0;
    let ocrBusy = false;
    let ocrReject = null;
    let ocrDecoding = false;
    let ocrImageReady = false;
    let ocrResultReady = false;
    let ocrAction = 0;
    let ocrRevision = 0;

    function setOcrStatus(message, progress = null) {
        document.getElementById('ocrStatus').textContent = message;
        const bar = document.getElementById('ocrProgress');
        if (progress !== null) bar.value = Math.max(0, Math.min(100, progress));
    }

    function releaseOcrWorker() {
        const previous = ocrWorker;
        ocrWorker = null;
        if (previous) Promise.resolve(previous.terminate()).catch(() => {});
    }

    function cancelOcrRecognition() {
        ocrGeneration++;
        const reject = ocrReject;
        ocrReject = null;
        if (reject) reject(new Error('cancelled'));
        releaseOcrWorker();
        ocrBusy = false;
        document.getElementById('ocrRun').disabled = !ocrImageReady;
        document.getElementById('ocrCancel').disabled = true;
        document.getElementById('ocrProgress').hidden = true;
        if (reject) setOcrStatus('Anulowano rozpoznawanie. Możesz spróbować ponownie.');
    }
    window.cancelOcrRecognition = cancelOcrRecognition;

    function resetOcrImport() {
        cancelOcrRecognition();
        ocrImageReady = false;
        ocrResultReady = false;
        ocrDecoding = false;
        ocrAction = 0;
        ocrRevision = 0;
        const canvas = document.getElementById('ocrPreview');
        canvas.width = canvas.height = 0;
        canvas.hidden = true;
        document.getElementById('ocrRun').disabled = true;
        document.getElementById('ocrText').value = '';
        document.getElementById('ocrText').hidden = true;
        document.getElementById('ocrTextLabel').hidden = true;
        document.getElementById('ocrApply').hidden = true;
        document.getElementById('ocrCameraInput').value = '';
        document.getElementById('ocrGalleryInput').value = '';
        document.getElementById('ocrImport').hidden = true;
        setOcrStatus('Wybierz jedno zdjęcie. Rozpoznawanie odbywa się na telefonie.', 0);
    }

    function currentOcr(token, action, revision) {
        return token === ocrGeneration && action === callbacks.getAction() && revision === callbacks.getRevision();
    }

    async function decodeOcrPhoto(file, token, action, revision) {
        if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
            file.size <= 0 || file.size > OCR_MAX_FILE_BYTES)
            throw new Error('Wybierz zdjęcie JPEG, PNG lub WebP do 12 MB.');
        let bitmap;
        try { bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
        catch { try { bitmap = await createImageBitmap(file); }
            catch { throw new Error('Nie można odczytać tego zdjęcia w przeglądarce.'); } }
        try {
            if (!currentOcr(token, action, revision)) return;
            if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > OCR_MAX_SOURCE_PIXELS)
                throw new Error('Zdjęcie przekracza 16 MP. Zrób zdjęcie w zwykłej rozdzielczości.');
            const scale = Math.min(1, OCR_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
            const canvas = document.getElementById('ocrPreview');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            canvas.hidden = false;
        } finally { bitmap.close(); }
    }

    async function selectOcrPhoto(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        resetOcrImport();
        document.getElementById('ocrImport').hidden = false;
        const token = ++ocrGeneration;
        const action = callbacks.nextAction();
        const revision = callbacks.getRevision();
        ocrAction = action;
        ocrRevision = revision;
        ocrDecoding = true;
        setOcrStatus('Przygotowywanie podglądu zdjęcia…');
        try {
            await decodeOcrPhoto(file, token, action, revision);
            if (!currentOcr(token, action, revision)) return;
            ocrImageReady = true;
            document.getElementById('ocrRun').disabled = false;
            setOcrStatus('Zdjęcie gotowe. Uruchom rozpoznawanie.');
        } catch (error) {
            if (currentOcr(token, action, revision)) setOcrStatus(error.message);
        } finally {
            if (token === ocrGeneration) ocrDecoding = false;
        }
    }
    document.getElementById('ocrCameraInput').addEventListener('change', selectOcrPhoto);
    document.getElementById('ocrGalleryInput').addEventListener('change', selectOcrPhoto);

    function loadOcrLibrary() {
        if (window.Tesseract?.createWorker) return Promise.resolve();
        if (!ocrLibraryPromise) {
            ocrLibraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = OCR_SCRIPT_URL;
                script.async = true;
                script.onload = () => window.Tesseract?.createWorker ? resolve() : reject(new Error('library_unavailable'));
                script.onerror = () => { script.remove(); reject(new Error('library_unavailable')); };
                document.head.appendChild(script);
            }).catch(error => { ocrLibraryPromise = null; throw error; });
        }
        return ocrLibraryPromise;
    }

    window.showPhotoImport = function() {
        resetOcrImport();
        document.getElementById('importStatus').textContent = '';
        document.getElementById('textImportForm').hidden = true;
        document.getElementById('ocrImport').hidden = false;
        document.getElementById('ocrCameraButton').focus?.();
    };
    window.chooseOcrPhoto = function(source) {
        document.getElementById(source === 'camera' ? 'ocrCameraInput' : 'ocrGalleryInput').click();
    };

    window.runOcr = async function() {
        if (!ocrImageReady || ocrBusy) return;
        const token = ++ocrGeneration, action = ocrAction, revision = ocrRevision;
        const canvas = document.getElementById('ocrPreview');
        ocrBusy = true;
        ocrResultReady = false;
        document.getElementById('ocrRun').disabled = true;
        document.getElementById('ocrCancel').disabled = false;
        document.getElementById('ocrProgress').hidden = false;
        document.getElementById('ocrText').hidden = true;
        document.getElementById('ocrTextLabel').hidden = true;
        document.getElementById('ocrApply').hidden = true;
        setOcrStatus('Ładowanie polskiego modelu OCR…', 0);
        let timeout;
        try {
            const cancelled = new Promise((_, reject) => { ocrReject = reject; });
            const limit = new Promise((_, reject) => { timeout = setTimeout(() => {
                if (currentOcr(token, action, revision)) {
                    cancelOcrRecognition();
                    setOcrStatus('Przekroczono 90 sekund. Możesz spróbować ponownie.');
                }
                reject(new Error('timeout'));
            }, OCR_TIMEOUT_MS); });
            const operation = (async () => {
                await loadOcrLibrary();
                if (!currentOcr(token, action, revision)) throw new Error('cancelled');
                const created = await window.Tesseract.createWorker('pol', 1, {
                    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
                    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
                    langPath: `${location.origin}/ocr-probe-assets`,
                    logger: event => {
                        if (currentOcr(token, action, revision) && event.status)
                            setOcrStatus(`OCR: ${event.status}`, Math.round((event.progress || 0) * 100));
                    }
                });
                if (!currentOcr(token, action, revision)) {
                    await created.terminate();
                    throw new Error('cancelled');
                }
                ocrWorker = created;
                return created.recognize(canvas);
            })();
            const result = await Promise.race([operation, cancelled, limit]);
            if (!currentOcr(token, action, revision)) return;
            const text = String(result.data?.text || '');
            document.getElementById('ocrText').value = text;
            document.getElementById('ocrText').hidden = false;
            document.getElementById('ocrTextLabel').hidden = false;
            document.getElementById('ocrApply').hidden = false;
            ocrResultReady = true;
            setOcrStatus(text.trim() ? 'Popraw tekst i wybierz „Czytaj tekst”.' :
                'Nie rozpoznano tekstu. Możesz wpisać go ręcznie lub spróbować ponownie.', 100);
        } catch {
            if (currentOcr(token, action, revision)) setOcrStatus('OCR nie powiodło się. Spróbuj ponownie.');
        } finally {
            clearTimeout(timeout);
            if (token === ocrGeneration) {
                ocrReject = null;
                ocrBusy = false;
                releaseOcrWorker();
                document.getElementById('ocrCancel').disabled = true;
                document.getElementById('ocrRun').disabled = !ocrImageReady;
                document.getElementById('ocrProgress').hidden = true;
            }
        }
    };

    window.applyOcrText = function() {
        if (!ocrResultReady || ocrBusy || ocrAction !== callbacks.getAction() || ocrRevision !== callbacks.getRevision()) return;
        const text = document.getElementById('ocrText').value.trim();
        if (!text) return setOcrStatus('Popraw lub wpisz tekst przed zatwierdzeniem.');
        callbacks.commitText(text);
    };

    return {reset: resetOcrImport, active: () => ocrDecoding || ocrBusy || ocrImageReady || ocrResultReady};
    };
})(globalThis);
