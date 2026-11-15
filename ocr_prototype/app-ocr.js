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
    const OCR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    const OCR_MAX_FILE_BYTES = 12 * 1024 * 1024;
    const OCR_MAX_SOURCE_PIXELS = 16 * 1000 * 1000;
    const OCR_MAX_EDGE = 2600;
    const OCR_TIMEOUT_MS = 90000;
    root.createOcrImport = function(callbacks) {
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
    let cropMode = 'editing';
    let cropDrag = null;
    let recognizedText = '';

    const isFullCrop = rect => rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1;

    function updateCropControls() {
        const applied = cropMode === 'applied';
        document.getElementById('ocrCropSurface').classList.toggle('is-applied', applied);
        document.getElementById('ocrPreview').hidden = !ocrImageReady || applied;
        document.getElementById('ocrAppliedPreview').hidden = !ocrImageReady || !applied;
        document.getElementById('ocrCropSelection').hidden = !ocrImageReady || applied;
        document.getElementById('ocrApplyCrop').hidden = applied;
        document.getElementById('ocrApplyCrop').disabled = !ocrImageReady || ocrBusy;
        document.getElementById('ocrChangeCrop').hidden = !applied;
        document.getElementById('ocrChangeCrop').disabled = !ocrImageReady || ocrBusy;
        document.getElementById('ocrResetCrop').disabled = !ocrImageReady || ocrBusy;
        document.getElementById('ocrCropHint').hidden = !ocrImageReady || applied;
        const title = document.getElementById('ocrCropTitle');
        title.textContent = applied ? 'Kadr gotowy ✓' : 'Przytnij zdjęcie (opcjonalnie)';
        title.classList.toggle('is-applied', applied);
        document.getElementById('ocrRun').textContent = applied ? 'Rozpoznaj zaznaczony tekst' : 'Rozpoznaj tekst';
        document.getElementById('ocrRun').disabled = !ocrImageReady || ocrBusy || cropDirty || (!applied && !isFullCrop(cropRect));
    }

    function confirmDiscardEdits() {
        return !ocrResultReady || document.getElementById('ocrText').value === recognizedText ||
            window.confirm('Zmiana kadru lub ponowne rozpoznawanie usunie poprawki tekstu. Kontynuować?');
    }

    function clearAppliedPreview() {
        const preview = document.getElementById('ocrAppliedPreview');
        preview.width = preview.height = 0;
        preview.style.setProperty('--ocr-applied-min-width', '0px');
    }

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
        recognizedText = '';
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
        if (!ocrImageReady || ocrBusy || cropMode === 'applied') return;
        appliedCrop = {...cropRect};
        cropDirty = false;
        const canvas = document.getElementById('ocrPreview');
        const crop = pixelCrop(appliedCrop, canvas.width, canvas.height);
        const preview = document.getElementById('ocrAppliedPreview');
        preview.width = crop.w;
        preview.height = crop.h;
        preview.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.w, crop.h,
            0, 0, crop.w, crop.h);
        preview.style.setProperty('--ocr-applied-min-width', crop.w / crop.h > 4 ? `${Math.ceil(120 * crop.w / crop.h)}px` : '0px');
        document.getElementById('ocrCropStage').scrollTop = 0;
        document.getElementById('ocrCropStage').scrollLeft = 0;
        cropMode = 'applied';
        updateCropControls();
        setOcrStatus('Kadr gotowy ✓ Wybierz „Rozpoznaj zaznaczony tekst”.');
    };

    window.changeOcrCrop = function() {
        if (!ocrImageReady || ocrBusy || cropMode !== 'applied') return;
        cropMode = 'editing';
        updateCropControls();
        setOcrStatus('Zmień ramkę i ponownie wybierz „Zastosuj kadr”.');
    };

    window.resetOcrCrop = function() {
        if (!ocrImageReady || ocrBusy) return;
        const changed = cropDirty || appliedCrop !== null || !isFullCrop(cropRect);
        if (changed && !confirmDiscardEdits()) return;
        if (changed) invalidateOcrResult();
        cropRect = fullCrop();
        appliedCrop = null;
        cropDirty = false;
        cropMode = 'editing';
        cropDrag = null;
        clearAppliedPreview();
        renderCropSelection();
        updateCropControls();
        setOcrStatus('Całe zdjęcie. Możesz uruchomić OCR bez przycinania.');
    };

    const cropSelection = document.getElementById('ocrCropSelection');
    cropSelection.addEventListener('pointerdown', event => {
        const handle = event.target?.dataset?.cropHandle;
        if (!handle || !ocrImageReady || cropMode !== 'editing') return;
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
        if (!confirmDiscardEdits()) {
            cropSelection.releasePointerCapture?.(event.pointerId);
            cropDrag = null;
            return;
        }
        cropRect = next;
        appliedCrop = null;
        cropDirty = true;
        invalidateOcrResult();
        clearAppliedPreview();
        updateCropControls();
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
        document.getElementById('ocrCancel').disabled = true;
        updateCropControls();
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
        cropMode = 'editing';
        cropDrag = null;
        recognizedText = '';
        setEditorExpanded(false);
        const canvas = document.getElementById('ocrPreview');
        canvas.width = canvas.height = 0;
        canvas.hidden = true;
        clearAppliedPreview();
        document.getElementById('ocrCropStage').hidden = true;
        document.getElementById('ocrCropTitle').hidden = true;
        document.getElementById('ocrCropActions').hidden = true;
        document.getElementById('ocrCropHint').hidden = true;
        renderCropSelection();
        updateCropControls();
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
            updateCropControls();
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
        if (!ocrImageReady || ocrBusy || cropDirty || (cropMode !== 'applied' && !isFullCrop(cropRect)) ||
            !confirmDiscardEdits()) return;
        const token = ++ocrGeneration, action = ocrAction, revision = ocrRevision;
        const input = document.getElementById(cropMode === 'applied' ? 'ocrAppliedPreview' : 'ocrPreview');
        ocrBusy = true;
        ocrResultReady = false;
        recognizedText = '';
        document.getElementById('ocrCancel').disabled = false;
        updateCropControls();
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
            recognizedText = text;
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
            if (token === ocrGeneration) {
                ocrReject = null;
                ocrBusy = false;
                releaseOcrWorker();
                document.getElementById('ocrCancel').disabled = true;
                updateCropControls();
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

    root.createDocumentScanner = function(callbacks) {
        const MAX_PAGES = 10;
        const MAX_SESSION_BYTES = 60 * 1024 * 1024;
        const isFullCrop = rect => rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1;
        const el = id => document.getElementById(id);
        let pages = [];
        let active = false, adding = false, busy = false;
        let generation = 0, viewGeneration = 0, runGeneration = 0;
        let action = 0, revision = 0, nextPageId = 1;
        let selectedId = null, editorId = null, replaceId = null, cropDrag = null;
        let worker = null, cancelReject = null, libraryPromise = null;

        const pageById = id => pages.find(page => page.id === id);
        const validSession = token => active && token === generation &&
            action === callbacks.getAction() && revision === callbacks.getRevision();
        const validRun = (token, run) => validSession(token) && run === runGeneration && busy;
        const needsCropConfirmation = page => page.dirty || (!page.applied && !isFullCrop(page.crop));
        const edited = page => page?.text !== null && page?.text !== page?.recognizedText;
        const confirmPageReset = page => !edited(page) ||
            window.confirm('Zmiana tej strony usunie ręczne poprawki jej tekstu. Kontynuować?');
        const pagePosition = page => pages.indexOf(page) + 1;
        const countLabel = count => `${count} ${count === 1 ? 'strona' : count >= 2 && count <= 4 ? 'strony' : 'stron'}`;
        const setStatus = message => { el('scanStatus').textContent = message; };

        function clearCanvas(canvas) { canvas.width = canvas.height = 0; }
        function clearView() {
            viewGeneration++;
            selectedId = null;
            cropDrag = null;
            el('scanPageView').hidden = true;
            clearCanvas(el('scanPreview'));
            clearCanvas(el('scanAppliedPreview'));
        }
        function refreshControls() {
            el('scanCount').textContent = countLabel(pages.length);
            el('scanCameraButton').disabled = adding || busy || pages.length >= MAX_PAGES;
            el('scanGalleryButton').disabled = adding || busy || pages.length >= MAX_PAGES;
            el('scanRecognize').disabled = !active || adding || busy || !pages.length ||
                pages.some(needsCropConfirmation) || pages.every(page => page.text !== null && !page.error);
            el('scanCancel').disabled = !busy;
            el('scanRead').disabled = !active || adding || busy || !pages.length ||
                pages.some(page => !page.text?.trim());
        }
        function button(label, callback, disabled = false) {
            const node = document.createElement('button');
            node.type = 'button';
            node.textContent = label;
            node.disabled = disabled;
            node.addEventListener('click', callback);
            return node;
        }
        function renderPages() {
            const list = el('scanPages');
            list.replaceChildren();
            pages.forEach((page, index) => {
                const row = document.createElement('div');
                row.className = 'scan-page';
                const image = document.createElement('img');
                image.src = page.thumb;
                image.alt = `Miniatura strony ${index + 1}`;
                row.appendChild(image);
                const details = document.createElement('div');
                details.className = 'scan-page-details';
                const title = document.createElement('strong');
                title.textContent = `Strona ${index + 1}`;
                details.appendChild(title);
                const status = document.createElement('small');
                status.textContent = needsCropConfirmation(page) ? 'Kadr do zatwierdzenia' : page.error ?
                    'Błąd OCR — ponów tę stronę' : page.text === null ?
                    (page.applied ? 'Kadr gotowy ✓ · czeka na OCR' : 'Całe zdjęcie · czeka na OCR') :
                    page.text.trim() ? (edited(page) ? 'Poprawiony tekst ✓' : 'Tekst gotowy ✓') :
                    'Brak tekstu — popraw ręcznie';
                details.appendChild(status);
                const actions = document.createElement('div');
                actions.className = 'scan-page-actions';
                const up = button('↑', () => movePage(page.id, -1), busy || adding || index === 0);
                up.setAttribute('aria-label', `Przesuń stronę ${index + 1} w górę`);
                actions.appendChild(up);
                const down = button('↓', () => movePage(page.id, 1), busy || adding || index === pages.length - 1);
                down.setAttribute('aria-label', `Przesuń stronę ${index + 1} w dół`);
                actions.appendChild(down);
                actions.appendChild(button('Kadr', () => openPage(page.id), busy || adding));
                actions.appendChild(button('Edytuj tekst', () => openEditor(page.id), busy || adding));
                if (page.error || page.text === '')
                    actions.appendChild(button('Ponów OCR', () => recognizePages([page.id]),
                        busy || adding || needsCropConfirmation(page)));
                actions.appendChild(button('Ponów zdjęcie', () => retakePage(page.id), busy || adding));
                actions.appendChild(button('Usuń', () => removePage(page.id), busy || adding));
                details.appendChild(actions);
                row.appendChild(details);
                list.appendChild(row);
            });
            refreshControls();
        }

        async function decodeBitmap(file) {
            if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
                file.size <= 0 || file.size > OCR_MAX_FILE_BYTES)
                throw new Error('Strona musi być JPEG, PNG lub WebP do 12 MB.');
            let bitmap;
            try { bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
            catch { try { bitmap = await createImageBitmap(file); }
                catch { throw new Error('Nie można odczytać tego zdjęcia w przeglądarce.'); } }
            if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > OCR_MAX_SOURCE_PIXELS) {
                bitmap.close();
                throw new Error('Zdjęcie przekracza 16 MP. Zrób zdjęcie w zwykłej rozdzielczości.');
            }
            return bitmap;
        }
        function drawBitmap(bitmap, canvas, maxEdge = OCR_MAX_EDGE) {
            const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        }
        function drawApplied(page) {
            const source = el('scanPreview'), preview = el('scanAppliedPreview');
            const crop = pixelCrop(page.crop, source.width, source.height);
            preview.width = crop.w;
            preview.height = crop.h;
            preview.getContext('2d').drawImage(source, crop.x, crop.y, crop.w, crop.h,
                0, 0, crop.w, crop.h);
            preview.style.setProperty('--scan-applied-min-width',
                crop.w / crop.h > 4 ? `${Math.ceil(120 * crop.w / crop.h)}px` : '0px');
        }
        function renderCrop() {
            const page = pageById(selectedId);
            if (!page) return;
            const selection = el('scanCropSelection');
            selection.style.left = `${page.crop.x * 100}%`;
            selection.style.top = `${page.crop.y * 100}%`;
            selection.style.width = `${page.crop.w * 100}%`;
            selection.style.height = `${page.crop.h * 100}%`;
            selection.hidden = page.applied;
            el('scanPreview').hidden = page.applied;
            el('scanAppliedPreview').hidden = !page.applied;
            el('scanCropSurface').classList.toggle('is-applied', page.applied);
            el('scanApplyCrop').hidden = page.applied;
            el('scanChangeCrop').hidden = !page.applied;
            el('scanCropTitle').textContent = page.applied ? 'Kadr gotowy ✓' :
                `Strona ${pagePosition(page)} — przytnij (opcjonalnie)`;
            el('scanCropTitle').classList.toggle('is-applied', page.applied);
        }

        async function openPage(id) {
            if (!active || adding || busy) return;
            const page = pageById(id);
            if (!page) return;
            clearView();
            selectedId = id;
            const view = viewGeneration, token = generation;
            setStatus(`Przygotowywanie strony ${pagePosition(page)}…`);
            let bitmap;
            try {
                bitmap = await decodeBitmap(page.file);
                if (!validSession(token) || view !== viewGeneration || selectedId !== id) return;
                drawBitmap(bitmap, el('scanPreview'));
                if (page.applied) drawApplied(page);
                el('scanPageView').hidden = false;
                el('scanCropStage').scrollTop = 0;
                el('scanCropStage').scrollLeft = 0;
                renderCrop();
                el('scanPageView').scrollIntoView?.({block: 'start', behavior: 'smooth'});
                setStatus(page.applied ? 'Kadr gotowy ✓' : 'Ustaw kadr albo zachowaj całe zdjęcie.');
            } catch (error) {
                if (validSession(token) && view === viewGeneration) setStatus(error.message);
            } finally { bitmap?.close(); }
        }
        function movePage(id, direction) {
            if (!active || busy || adding) return;
            const index = pages.findIndex(page => page.id === id);
            const next = index + direction;
            if (index < 0 || next < 0 || next >= pages.length) return;
            [pages[index], pages[next]] = [pages[next], pages[index]];
            renderPages();
            if (selectedId !== null) renderCrop();
            setStatus(`Kolejność zmieniona. ${countLabel(pages.length)}.`);
        }
        function removePage(id) {
            if (!active || busy || adding) return;
            const page = pageById(id);
            if (!page || !confirmPageReset(page)) return;
            if (selectedId === id) clearView();
            if (editorId === id) closeEditor();
            pages = pages.filter(item => item.id !== id);
            page.file = null;
            page.thumb = '';
            renderPages();
            setStatus(`Usunięto stronę. ${countLabel(pages.length)}.`);
        }
        function retakePage(id) {
            if (!active || busy || adding) return;
            const page = pageById(id);
            if (!page || !confirmPageReset(page)) return;
            replaceId = id;
            el('scanCameraInput').click();
        }
        async function addFiles(files, targetId = null) {
            if (!active || adding || busy || !files.length) return;
            const token = generation;
            adding = true;
            refreshControls();
            let added = 0, issue = '';
            for (const file of files) {
                if (!validSession(token)) break;
                const replacing = targetId === null ? null : pageById(targetId);
                if (targetId !== null && !replacing) break;
                if (!replacing && pages.length >= MAX_PAGES) { issue = `Limit: ${MAX_PAGES} stron.`; break; }
                const bytes = pages.reduce((sum, page) => sum + page.file.size, 0) -
                    (replacing?.file.size || 0) + file.size;
                if (bytes > MAX_SESSION_BYTES) { issue = 'Limit pamięci skanu: 60 MB zdjęć. Usuń stronę, aby dodać kolejną.'; break; }
                let bitmap, thumbCanvas;
                try {
                    bitmap = await decodeBitmap(file);
                    if (!validSession(token)) break;
                    thumbCanvas = document.createElement('canvas');
                    drawBitmap(bitmap, thumbCanvas, 160);
                    const thumb = thumbCanvas.toDataURL('image/jpeg', .7);
                    const page = {id: replacing?.id || nextPageId++, file, thumb,
                        crop: fullCrop(), applied: false, dirty: false, text: null,
                        recognizedText: null, error: false};
                    if (replacing) {
                        if (selectedId === page.id) clearView();
                        if (editorId === page.id) closeEditor();
                        pages[pages.indexOf(replacing)] = page;
                        replacing.file = null;
                        replacing.thumb = '';
                    } else pages.push(page);
                    added++;
                    renderPages();
                } catch (error) { issue = error.message; }
                finally { bitmap?.close(); if (thumbCanvas) clearCanvas(thumbCanvas); }
                if (targetId !== null) break;
            }
            if (validSession(token)) {
                adding = false;
                renderPages();
                setStatus(issue || (added ? `Dodano ${added} ${added === 1 ? 'stronę' : 'strony'}. ${countLabel(pages.length)}.` :
                    'Nie dodano strony.'));
            }
        }
        async function selectPhotos(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            const target = replaceId;
            replaceId = null;
            if (files.length) await addFiles(files, target);
        }
        el('scanCameraInput').addEventListener('change', selectPhotos);
        el('scanGalleryInput').addEventListener('change', selectPhotos);
        window.chooseScanPhoto = function(source) {
            if (!active || adding || busy) return;
            if (pages.length >= MAX_PAGES) return setStatus(`Limit: ${MAX_PAGES} stron.`);
            replaceId = null;
            el(source === 'camera' ? 'scanCameraInput' : 'scanGalleryInput').click();
        };

        const selection = el('scanCropSelection');
        selection.addEventListener('pointerdown', event => {
            const page = pageById(selectedId), handle = event.target?.dataset?.scanHandle;
            if (!page || page.applied || busy || !handle) return;
            event.preventDefault();
            cropDrag = {id: event.pointerId, handle, x: event.clientX, y: event.clientY,
                rect: {...page.crop}, pageId: page.id};
            selection.setPointerCapture?.(event.pointerId);
        });
        selection.addEventListener('pointermove', event => {
            if (!cropDrag || cropDrag.id !== event.pointerId) return;
            const page = pageById(cropDrag.pageId), canvas = el('scanPreview');
            if (!page || selectedId !== page.id) return;
            event.preventDefault();
            const bounds = canvas.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            const next = moveCrop(cropDrag.rect, cropDrag.handle,
                (event.clientX - cropDrag.x) / bounds.width,
                (event.clientY - cropDrag.y) / bounds.height,
                Math.min(1, 120 / canvas.width), Math.min(1, 80 / canvas.height));
            if (next.x === page.crop.x && next.y === page.crop.y &&
                next.w === page.crop.w && next.h === page.crop.h) return;
            if (!confirmPageReset(page)) {
                selection.releasePointerCapture?.(event.pointerId);
                cropDrag = null;
                return;
            }
            page.crop = next;
            page.applied = false;
            page.dirty = true;
            page.text = null;
            page.recognizedText = null;
            page.error = false;
            clearCanvas(el('scanAppliedPreview'));
            renderCrop();
            renderPages();
            setStatus(`Strona ${pagePosition(page)}: wybierz „Zastosuj kadr”.`);
        });
        const endDrag = event => {
            if (cropDrag?.id !== event.pointerId) return;
            selection.releasePointerCapture?.(event.pointerId);
            cropDrag = null;
        };
        selection.addEventListener('pointerup', endDrag);
        selection.addEventListener('pointercancel', endDrag);
        window.applyScanCrop = function() {
            const page = pageById(selectedId);
            if (!page || busy || page.applied) return;
            page.applied = true;
            page.dirty = false;
            drawApplied(page);
            renderCrop();
            renderPages();
            setStatus(`Strona ${pagePosition(page)}: Kadr gotowy ✓`);
        };
        window.changeScanCrop = function() {
            const page = pageById(selectedId);
            if (!page || busy || !page.applied) return;
            page.applied = false;
            renderCrop();
            renderPages();
            setStatus('Zmień ramkę i ponownie wybierz „Zastosuj kadr”.');
        };
        window.resetScanCrop = function() {
            const page = pageById(selectedId);
            if (!page || busy || !confirmPageReset(page)) return;
            const changed = page.applied || page.dirty || !isFullCrop(page.crop);
            page.crop = fullCrop();
            page.applied = false;
            page.dirty = false;
            if (changed) { page.text = null; page.recognizedText = null; page.error = false; }
            clearCanvas(el('scanAppliedPreview'));
            renderCrop();
            renderPages();
            setStatus(`Strona ${pagePosition(page)}: całe zdjęcie.`);
        };
        window.closeScanPage = function() { clearView(); setStatus('Wybierz stronę lub rozpoznaj wszystkie strony.'); };

        function syncEditorViewport() {
            const viewport = window.visualViewport;
            if (!viewport) return;
            const dialog = el('addContentDialog');
            dialog.style.setProperty('--ocr-viewport-height', `${Math.round(viewport.height)}px`);
            dialog.style.setProperty('--ocr-viewport-top', `${Math.round(viewport.offsetTop)}px`);
        }
        window.visualViewport?.addEventListener('resize', syncEditorViewport);
        window.visualViewport?.addEventListener('scroll', syncEditorViewport);
        function showEditorPage() {
            const page = pageById(editorId);
            if (!page) return;
            const index = pages.indexOf(page);
            el('scanEditorPage').textContent = `Strona ${index + 1} z ${pages.length}`;
            el('scanEditorText').value = page.text ?? '';
            el('scanPreviousPage').disabled = index === 0;
            el('scanNextPage').disabled = index === pages.length - 1;
        }
        function openEditor(id) {
            if (!active || adding || busy || !pageById(id)) return;
            clearView();
            editorId = id;
            el('scanEditorView').hidden = false;
            el('addContentDialog').classList.add('scan-editor-expanded');
            showEditorPage();
            syncEditorViewport();
            el('scanEditorText').focus?.();
        }
        function closeEditor() {
            editorId = null;
            el('scanEditorView').hidden = true;
            el('addContentDialog').classList.remove('scan-editor-expanded');
            renderPages();
        }
        el('scanEditorText').addEventListener('input', () => {
            const page = pageById(editorId);
            if (!page) return;
            page.text = el('scanEditorText').value;
            page.error = false;
            refreshControls();
        });
        window.navigateScanEditor = function(direction) {
            const index = pages.findIndex(page => page.id === editorId);
            const next = index + direction;
            if (index < 0 || next < 0 || next >= pages.length) return;
            editorId = pages[next].id;
            showEditorPage();
            el('scanEditorText').focus?.();
        };
        window.closeScanEditor = closeEditor;

        function loadLibrary() {
            if (window.Tesseract?.createWorker) return Promise.resolve();
            if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = OCR_SCRIPT_URL;
                script.async = true;
                script.onload = () => window.Tesseract?.createWorker ? resolve() : reject(new Error('library_unavailable'));
                script.onerror = () => { script.remove(); reject(new Error('library_unavailable')); };
                document.head.appendChild(script);
            }).catch(error => { libraryPromise = null; throw error; });
            return libraryPromise;
        }
        function releaseWorker() {
            const previous = worker;
            worker = null;
            if (previous) Promise.resolve(previous.terminate()).catch(() => {});
        }
        function cancelRecognition(message = 'Anulowano OCR. Gotowe strony i ich poprawki zostały zachowane.') {
            runGeneration++;
            const reject = cancelReject;
            cancelReject = null;
            if (reject) reject(new Error('cancelled'));
            releaseWorker();
            busy = false;
            el('scanProgress').hidden = true;
            renderPages();
            if (reject) setStatus(message);
        }
        window.cancelScanRecognition = cancelRecognition;
        async function prepareInput(page, token, run) {
            let bitmap, source, input;
            try {
                if (needsCropConfirmation(page)) return null;
                bitmap = await decodeBitmap(page.file);
                if (!validRun(token, run) || needsCropConfirmation(page)) return null;
                source = document.createElement('canvas');
                drawBitmap(bitmap, source);
                if (page.applied) {
                    const crop = pixelCrop(page.crop, source.width, source.height);
                    input = document.createElement('canvas');
                    input.width = crop.w;
                    input.height = crop.h;
                    input.getContext('2d').drawImage(source, crop.x, crop.y, crop.w, crop.h,
                        0, 0, crop.w, crop.h);
                    clearCanvas(source);
                } else input = source;
                return input;
            } finally { bitmap?.close(); }
        }
        async function recognizePages(ids) {
            if (!active || adding || busy || !pages.length) return;
            if (pages.some(needsCropConfirmation)) {
                setStatus('Potwierdź kadr strony przed uruchomieniem OCR.');
                return;
            }
            const targets = ids ? ids.map(pageById).filter(Boolean) :
                pages.filter(page => page.text === null || page.error);
            if (!targets.length) return;
            if (targets.some(edited) && !window.confirm('Ponowne OCR usunie ręczne poprawki wybranej strony. Kontynuować?')) return;
            const token = generation, run = ++runGeneration;
            busy = true;
            renderPages();
            el('scanProgress').hidden = false;
            el('scanProgress').value = 0;
            let timeout;
            let progressIndex = 0;
            let startupFailed = false, cropBlocked = false;
            try {
                const cancelled = new Promise((_, reject) => { cancelReject = reject; });
                await Promise.race([loadLibrary(), cancelled]);
                if (!validRun(token, run)) return;
                const pendingWorker = window.Tesseract.createWorker('pol', 1, {
                    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
                    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
                    langPath: `${location.origin}/ocr-probe-assets`,
                    logger: event => {
                        if (validRun(token, run) && event.progress)
                            el('scanProgress').value = Math.min(99,
                                Math.round((progressIndex + event.progress) / pages.length * 100));
                    }
                });
                Promise.resolve(pendingWorker).then(created => {
                    if (validRun(token, run)) worker = created;
                    else return created.terminate();
                }).catch(() => {});
                const created = await Promise.race([pendingWorker, cancelled]);
                if (!validRun(token, run)) return;
                worker = created;
                for (const page of targets) {
                    if (!validRun(token, run) || !pageById(page.id)) break;
                    const index = pagePosition(page), total = pages.length;
                    progressIndex = index - 1;
                    setStatus(`Rozpoznawanie: strona ${index} z ${total}…`);
                    let input;
                    try {
                        input = await prepareInput(page, token, run);
                        if (!validRun(token, run)) break;
                        if (!input) { cropBlocked = true; break; }
                        const timedOut = new Promise((_, reject) => { timeout = setTimeout(() =>
                            reject(new Error('timeout')), OCR_TIMEOUT_MS); });
                        const result = await Promise.race([worker.recognize(input), cancelled, timedOut]);
                        if (!validRun(token, run)) break;
                        page.text = String(result.data?.text || '');
                        page.recognizedText = page.text;
                        page.error = false;
                    } catch (error) {
                        if (!validRun(token, run)) break;
                        page.error = true;
                        page.text = null;
                        page.recognizedText = null;
                        setStatus(`Błąd OCR strony ${index} z ${total}. Pozostałe strony są zachowane.`);
                        if (error?.message === 'timeout') { releaseWorker(); break; }
                    } finally {
                        clearTimeout(timeout);
                        timeout = null;
                        if (input) clearCanvas(input);
                        if (validRun(token, run)) {
                            el('scanProgress').value = Math.round(index / total * 100);
                            renderPages();
                        }
                    }
                }
            } catch {
                if (validRun(token, run)) {
                    startupFailed = true;
                    setStatus('Nie można uruchomić OCR. Spróbuj ponownie.');
                }
            } finally {
                clearTimeout(timeout);
                if (validRun(token, run)) {
                    cancelReject = null;
                    releaseWorker();
                    busy = false;
                    el('scanProgress').hidden = true;
                    renderPages();
                    const failures = pages.filter(page => page.error).length;
                    if (cropBlocked) setStatus('Potwierdź kadr strony przed uruchomieniem OCR.');
                    else if (!startupFailed && failures)
                        setStatus(`OCR zakończony. Błędy: ${failures}. Ponów OCR tylko dla błędnych stron.`);
                    else if (!startupFailed)
                        setStatus('OCR zakończony. Popraw tekst stron i wybierz „Czytaj dokument”.');
                }
            }
        }
        window.recognizeScanPages = () => recognizePages();

        window.readScanDocument = function() {
            if (!active || adding || busy || !pages.length || pages.some(page => !page.text?.trim())) return;
            const name = el('scanDocumentName').value.trim() || 'Skan dokumentu';
            if (!window.confirm(`Połączyć ${countLabel(pages.length)} w jeden dokument „${name}” i otworzyć w Lektorze?`)) return;
            const text = pages.map(page => page.text.trim()).join('\n\n');
            reset();
            callbacks.commitText(text, name);
        };
        function confirmLeave() {
            return !active || !pages.length ||
                window.confirm('Zamknąć skan? Zdjęcia i niezapisane poprawki zostaną utracone.');
        }
        function reset() {
            generation++;
            cancelRecognition();
            clearView();
            closeEditor();
            for (const page of pages) { page.file = null; page.thumb = ''; }
            pages = [];
            active = false;
            adding = false;
            replaceId = null;
            action = revision = 0;
            el('scanImport').hidden = true;
            el('scanCameraInput').value = '';
            el('scanGalleryInput').value = '';
            el('scanDocumentName').value = 'Skan dokumentu';
            el('scanProgress').hidden = true;
            renderPages();
            setStatus('Dodaj pierwszą stronę. Zdjęcia pozostają tylko w pamięci do zamknięcia skanu.');
        }
        window.showDocumentScanner = function() {
            if (!confirmLeave()) return;
            reset();
            callbacks.resetPhotoImport();
            active = true;
            action = callbacks.nextAction();
            revision = callbacks.getRevision();
            el('textImportForm').hidden = true;
            el('ocrImport').hidden = true;
            el('importStatus').textContent = '';
            el('scanImport').hidden = false;
            renderPages();
            el('scanCameraButton').focus?.();
        };
        return {reset, confirmLeave, active: () => active};
    };
})(globalThis);
