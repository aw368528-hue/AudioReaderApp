(function (root) {
    'use strict';
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const fullCrop = () => ({x: 0, y: 0, w: 1, h: 1});
    function moveCrop(rect, handle, dx, dy, minW, minH) {
        if (handle === 'move') return {x: clamp(rect.x + dx, 0, 1 - rect.w),
            y: clamp(rect.y + dy, 0, 1 - rect.h), w: rect.w, h: rect.h};
        let left = rect.x, right = rect.x + rect.w, top = rect.y, bottom = rect.y + rect.h;
        if (handle.includes('w')) left = clamp(left + dx, 0, right - minW);
        if (handle.includes('e')) right = clamp(right + dx, left + minW, 1);
        if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minH);
        if (handle.includes('s')) bottom = clamp(bottom + dy, top + minH, 1);
        return {x: left, y: top, w: right - left, h: bottom - top};
    }
    function pixelCrop(rect, width, height) {
        const x = Math.floor(rect.x * width), y = Math.floor(rect.y * height);
        return {x, y, w: Math.max(1, Math.min(width - x, Math.ceil((rect.x + rect.w) * width) - x)),
            h: Math.max(1, Math.min(height - y, Math.ceil((rect.y + rect.h) * height) - y))};
    }
    root.ocrCropGeometry = {moveCrop, pixelCrop, fullCrop};
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
    let cropRect = fullCrop();
    let appliedCrop = null;
    let cropDirty = false;
    let cropDrag = null;

    function setOcrStatus(message, progress = null) {
        document.getElementById('ocrStatus').textContent = message;
        const bar = document.getElementById('ocrProgress');
        if (progress !== null) bar.value = Math.max(0, Math.min(100, progress));
    }

    function renderCropSelection() {
        const selection = document.getElementById('ocrCropSelection');
        selection.style.left = `${cropRect.x * 100}%`;
        selection.style.top = `${cropRect.y * 100}%`;
        selection.style.width = `${cropRect.w * 100}%`;
        selection.style.height = `${cropRect.h * 100}%`;
    }

    function invalidateOcrResult() {
        if (ocrBusy) cancelOcrRecognition();
        ocrResultReady = false;
        document.getElementById('ocrText').value = '';
        document.getElementById('ocrText').hidden = true;
        document.getElementById('ocrTextLabel').hidden = true;
        document.getElementById('ocrApply').hidden = true;
        document.getElementById('ocrExpand').hidden = true;
        setEditorExpanded(false);
    }

    function setEditorExpanded(expanded) {
        const dialog = document.getElementById('addContentDialog');
        dialog.classList.toggle('ocr-editor-expanded', expanded);
        const button = document.getElementById('ocrExpand');
        button.textContent = expanded ? 'Zwiń edytor' : 'Rozwiń edytor';
        button.setAttribute?.('aria-expanded', String(expanded));
        if (expanded) {
            syncEditorViewport();
            document.getElementById('ocrText').focus?.();
        }
    }

    function syncEditorViewport() {
        const viewport = window.visualViewport;
        if (!viewport) return;
        const dialog = document.getElementById('addContentDialog');
        dialog.style.setProperty('--ocr-viewport-height', `${Math.round(viewport.height)}px`);
        dialog.style.setProperty('--ocr-viewport-top', `${Math.round(viewport.offsetTop)}px`);
    }

    window.visualViewport?.addEventListener('resize', syncEditorViewport);
    window.visualViewport?.addEventListener('scroll', syncEditorViewport);
    window.addEventListener?.('orientationchange', () => { cropDrag = null; syncEditorViewport(); });

    window.toggleOcrEditor = function() {
        if (!ocrResultReady) return;
        const dialog = document.getElementById('addContentDialog');
        setEditorExpanded(!dialog.classList.contains('ocr-editor-expanded'));
    };

    window.applyOcrCrop = function() {
        if (!ocrImageReady) return;
        appliedCrop = {...cropRect};
        cropDirty = false;
        document.getElementById('ocrRun').disabled = ocrBusy;
        setOcrStatus('Kadr zastosowany. Uruchom rozpoznawanie.');
    };

    window.resetOcrCrop = function() {
        if (!ocrImageReady) return;
        const changed = cropDirty || appliedCrop !== null ||
            cropRect.x !== 0 || cropRect.y !== 0 || cropRect.w !== 1 || cropRect.h !== 1;
        if (changed) invalidateOcrResult();
        cropRect = fullCrop();
        appliedCrop = null;
        cropDirty = false;
        cropDrag = null;
        renderCropSelection();
        document.getElementById('ocrRun').disabled = ocrBusy;
        setOcrStatus('Całe zdjęcie. Możesz uruchomić OCR bez przycinania.');
    };

    const cropSelection = document.getElementById('ocrCropSelection');
    cropSelection.addEventListener('pointerdown', event => {
        const handle = event.target?.dataset?.cropHandle;
        if (!handle || !ocrImageReady) return;
        event.preventDefault();
        cropDrag = {id: event.pointerId, handle, x: event.clientX, y: event.clientY, rect: {...cropRect}};
        cropSelection.setPointerCapture?.(event.pointerId);
    });
    cropSelection.addEventListener('pointermove', event => {
        if (!cropDrag || event.pointerId !== cropDrag.id) return;
        event.preventDefault();
        const canvas = document.getElementById('ocrPreview');
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const dx = (event.clientX - cropDrag.x) / bounds.width;
        const dy = (event.clientY - cropDrag.y) / bounds.height;
        const minW = Math.min(1, 120 / canvas.width), minH = Math.min(1, 80 / canvas.height);
        const next = moveCrop(cropDrag.rect, cropDrag.handle, dx, dy, minW, minH);
        if (next.x === cropRect.x && next.y === cropRect.y && next.w === cropRect.w && next.h === cropRect.h) return;
        cropRect = next;
        appliedCrop = null;
        cropDirty = true;
        invalidateOcrResult();
        document.getElementById('ocrRun').disabled = true;
        setOcrStatus('Ustaw kadr, a potem wybierz „Zastosuj kadr”.');
        renderCropSelection();
    });
    const endCropDrag = event => {
        if (cropDrag?.id !== event.pointerId) return;
        cropSelection.releasePointerCapture?.(event.pointerId);
        cropDrag = null;
    };
    cropSelection.addEventListener('pointerup', endCropDrag);
    cropSelection.addEventListener('pointercancel', endCropDrag);

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
        document.getElementById('ocrApplyCrop').disabled = !ocrImageReady;
        document.getElementById('ocrResetCrop').disabled = !ocrImageReady;
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
        cropRect = fullCrop();
        appliedCrop = null;
        cropDirty = false;
        cropDrag = null;
        setEditorExpanded(false);
        const canvas = document.getElementById('ocrPreview');
        canvas.width = canvas.height = 0;
        canvas.hidden = true;
        document.getElementById('ocrCropStage').hidden = true;
        document.getElementById('ocrCropTitle').hidden = true;
        document.getElementById('ocrCropActions').hidden = true;
        document.getElementById('ocrCropHint').hidden = true;
        document.getElementById('ocrApplyCrop').disabled = true;
        document.getElementById('ocrResetCrop').disabled = true;
        renderCropSelection();
        document.getElementById('ocrRun').disabled = true;
        document.getElementById('ocrText').value = '';
        document.getElementById('ocrText').hidden = true;
        document.getElementById('ocrTextLabel').hidden = true;
        document.getElementById('ocrApply').hidden = true;
        document.getElementById('ocrExpand').hidden = true;
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
            document.getElementById('ocrCropStage').hidden = false;
            document.getElementById('ocrCropTitle').hidden = false;
            document.getElementById('ocrCropActions').hidden = false;
            document.getElementById('ocrCropHint').hidden = false;
            document.getElementById('ocrApplyCrop').disabled = false;
            document.getElementById('ocrResetCrop').disabled = false;
            document.getElementById('ocrCropStage').scrollTop = 0;
            renderCropSelection();
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
        if (!ocrImageReady || ocrBusy || cropDirty) return;
        const token = ++ocrGeneration, action = ocrAction, revision = ocrRevision;
        const canvas = document.getElementById('ocrPreview');
        const crop = appliedCrop ? pixelCrop(appliedCrop, canvas.width, canvas.height) : null;
        const input = crop ? document.createElement('canvas') : canvas;
        if (crop) {
            input.width = crop.w;
            input.height = crop.h;
            input.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.w, crop.h,
                0, 0, crop.w, crop.h);
        }
        ocrBusy = true;
        ocrResultReady = false;
        document.getElementById('ocrRun').disabled = true;
        document.getElementById('ocrCancel').disabled = false;
        document.getElementById('ocrApplyCrop').disabled = true;
        document.getElementById('ocrResetCrop').disabled = true;
        document.getElementById('ocrProgress').hidden = false;
        document.getElementById('ocrText').hidden = true;
        document.getElementById('ocrTextLabel').hidden = true;
        document.getElementById('ocrApply').hidden = true;
        document.getElementById('ocrExpand').hidden = true;
        setEditorExpanded(false);
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
                return created.recognize(input);
            })();
            const result = await Promise.race([operation, cancelled, limit]);
            if (!currentOcr(token, action, revision)) return;
            const text = String(result.data?.text || '');
            document.getElementById('ocrText').value = text;
            document.getElementById('ocrText').hidden = false;
            document.getElementById('ocrTextLabel').hidden = false;
            document.getElementById('ocrApply').hidden = false;
            document.getElementById('ocrExpand').hidden = false;
            ocrResultReady = true;
            setOcrStatus(text.trim() ? 'Popraw tekst i wybierz „Czytaj tekst”.' :
                'Nie rozpoznano tekstu. Możesz wpisać go ręcznie lub spróbować ponownie.', 100);
        } catch {
            if (currentOcr(token, action, revision)) setOcrStatus('OCR nie powiodło się. Spróbuj ponownie.');
        } finally {
            clearTimeout(timeout);
            if (crop) input.width = input.height = 0;
            if (token === ocrGeneration) {
                ocrReject = null;
                ocrBusy = false;
                releaseOcrWorker();
                document.getElementById('ocrCancel').disabled = true;
                document.getElementById('ocrApplyCrop').disabled = !ocrImageReady;
                document.getElementById('ocrResetCrop').disabled = !ocrImageReady;
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
