import io
import asyncio
import logging
import re
import time
import uuid
from importlib.metadata import version
from email.utils import parsedate_to_datetime
import socket
import tempfile
import os
import docx
import edge_tts
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse, Response, JSONResponse
from fastapi.exceptions import RequestValidationError
from pypdf import PdfReader
import uvicorn
from aiohttp import ClientError, ClientResponseError, ClientConnectorError
from edge_tts.exceptions import NoAudioReceived

app = FastAPI()
TTS_VERSION = version("edge-tts")
TTS_LOG = logging.getLogger("uvicorn.error.tts")
TTS_LOG.setLevel(logging.INFO)

@app.get("/manifest.json")
async def manifest():
    return {
        "name": "AudioReader AI",
        "short_name": "AudioReader",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#121316",
        "theme_color": "#121316",
        "icons": [
            {
                "src": "https://cdn-icons-png.flaticon.com/512/3241/3241642.png",
                "sizes": "512x512",
                "type": "image/png"
            }
        ]
    }

HTML_PAGE = """
<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#121316">
    <link rel="manifest" href="/manifest.json">
    <title>AudioReader AI</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #121316; --surface: #1e2025; --surface-light: #2a2d35;
            --primary: #3b82f6; --text: #f3f4f6; --text-muted: #9ca3af;
            --highlight-bg: #78350f; --highlight-border: #f59e0b;
        }
        body.light {
            --bg: #f3f4f6; --surface: #ffffff; --surface-light: #e5e7eb;
            --primary: #2563eb; --text: #111827; --text-muted: #6b7280;
            --highlight-bg: #fef3c7; --highlight-border: #f59e0b;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg); color: var(--text);
            margin: 0; padding: 14px; height: 100dvh;
            display: flex; flex-direction: column; gap: 12px; overflow: hidden;
        }
        .header { display: flex; justify-content: space-between; align-items: center; }
        .logo { display: flex; align-items: center; gap: 10px; font-size: 1.25rem; font-weight: 700; }
        .logo span { color: var(--primary); font-size: 1.5rem; }
        .header-actions { display: flex; gap: 8px; }
        .btn-tonal {
            background: var(--surface-light); color: var(--text);
            border: none; padding: 8px 14px; border-radius: 20px;
            font-weight: 600; font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; gap: 6px;
        }
        .tabs { display: flex; gap: 8px; }
        .tab-btn {
            flex: 1; padding: 10px; border-radius: 20px; border: none;
            background: var(--surface); color: var(--text-muted);
            font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: 0.2s;
        }
        .tab-btn.active { background: var(--primary); color: white; }
        .view-box {
            flex: 1; background: var(--surface); border-radius: 16px;
            padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
        }
        .sentence {
            padding: 12px 14px; border-radius: 12px; font-size: 1.02rem; line-height: 1.5;
            cursor: pointer; transition: 0.15s; border: 1px solid transparent;
        }
        .sentence:hover { background: var(--surface-light); }
        .sentence.active {
            background: var(--highlight-bg); border-color: var(--highlight-border); font-weight: 500;
        }
        textarea {
            width: 100%; flex: 1; background: var(--bg); color: var(--text);
            border: 1px solid var(--surface-light); border-radius: 12px; padding: 12px;
            font-size: 1rem; resize: none; font-family: inherit;
        }
        .apply-btn {
            background: var(--primary); color: white; border: none; padding: 14px;
            border-radius: 12px; font-weight: 600; font-size: 0.95rem; cursor: pointer; margin-top: 8px;
        }
        .player-card {
            background: var(--surface); border-radius: 20px; padding: 14px 16px;
            display: flex; flex-direction: column; gap: 10px;
            box-shadow: 0 8px 20px rgba(0,0,0,0.25);
        }
        .progress-bg { height: 5px; background: var(--surface-light); border-radius: 3px; overflow: hidden; }
        .progress-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.2s; }
        .status { text-align: center; font-size: 0.8rem; color: var(--text-muted); }
        .controls-row { display: flex; justify-content: center; align-items: center; gap: 22px; }
        .icon-btn {
            background: none; border: none; color: var(--text); font-size: 1.5rem;
            cursor: pointer; padding: 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
        .play-btn {
            background: var(--primary); color: white; width: 56px; height: 56px;
            font-size: 1.6rem; box-shadow: 0 4px 12px rgba(59,130,246,0.4);
        }
        .settings-row { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; }
        select {
            background: var(--surface-light); color: var(--text); border: none;
            padding: 8px 12px; border-radius: 10px; font-weight: 500; outline: none;
        }
        input[type="range"] { flex: 1; accent-color: var(--primary); }
    </style>
</head>
<body>

    <div class="header">
        <div class="logo"><span>ılılı</span> AudioReader AI</div>
        <div class="header-actions">
            <label class="btn-tonal" for="fileInput">📂 Wgraj plik</label>
            <input type="file" id="fileInput" accept=".txt,.pdf,.docx" style="display:none">
            <button class="btn-tonal" onclick="document.body.classList.toggle('light')">☀️/🌙</button>
        </div>
    </div>

    <div class="tabs">
        <button class="tab-btn active" id="tabReader" onclick="window.switchTab('reader')">🎧 Lektor</button>
        <button class="tab-btn" id="tabEditor" onclick="window.switchTab('editor')">📝 Wklej tekst</button>
    </div>

    <div class="view-box" id="readerView">
        <div style="color:var(--text-muted); text-align:center; margin:auto;">
            Wczytaj plik PDF, DOCX lub TXT przyciskiem u góry lub wklej tekst w drugiej zakładce.
        </div>
    </div>

    <div class="view-box" id="editorView" style="display:none;">
        <textarea id="rawText" placeholder="Wklej tutaj dowolny tekst do przeczytania..."></textarea>
        <button class="apply-btn" onclick="window.applyText()">✔️ Zatwierdź tekst</button>
    </div>

    <div class="player-card">
        <div class="progress-bg"><div class="progress-fill" id="progressBar"></div></div>
        <div class="status" id="statusText">Gotowy do pracy</div>
        <div class="controls-row">
            <button class="icon-btn" onclick="window.skip(-1)">⏮</button>
            <button class="icon-btn play-btn" id="playBtn" onclick="window.togglePlay()">▶</button>
            <button class="icon-btn" onclick="window.stopReading()">⏹</button>
            <button class="icon-btn" onclick="window.skip(1)">⏭</button>
        </div>
        <div class="settings-row">
            <select id="voiceSelect">
                <option value="pl-PL-ZofiaNeural">Zofia (AI)</option>
                <option value="pl-PL-MarekNeural">Marek (AI)</option>
            </select>
            <span>🚀 <b id="rateLabel">0%</b></span>
            <input type="range" id="rateSlider" min="-50" max="50" step="10" value="0"
                   oninput="document.getElementById('rateLabel').innerText = (this.value>=0?'+'+this.value:this.value)+'%'">
        </div>
    </div>

<script>
    let sentences = [];
    let currentIdx = 0;
    let isReading = false;
    let isPaused = false;
    let audio = new Audio();
    let prefetchCache = new Map();
    let session = 0;
    let controller = new AbortController();
    let ready = false;
    let loading = false;
    let ttsNotBefore = 0;
    let ttsAttempt = 1;

    // Layout whitespace is retained for display; only the speech projection collapses it.
    function normalizeLayout(text) {
        return text.replace(/\\r\\n?/g, '\\n').replace(/[^\\S\\n]+/gu, ' ')
            .replace(/ *\\n */g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    }

    function readingGroups(text, hints = []) {
        const lines = text.replace(/\\r\\n?/g, '\\n').split('\\n');
        const groups = [];
        let offset = 0;
        let current = '';
        let hasBody = false;
        let protectedPrefix = 0;
        let previous = '';
        let blank = false;
        let hintIndex = 0;
        const flush = () => {
            if (current.trim()) groups.push({layout: normalizeLayout(current), protectedPrefix});
            current = ''; hasBody = false; protectedPrefix = 0;
        };
        for (const raw of lines) {
            const start = offset;
            offset += raw.length + 1;
            const line = raw.replace(/[^\\S\\n]+/gu, ' ').trim();
            if (!line) { if (current) current += '\\n\\n'; blank = true; continue; }
            while (hintIndex < hints.length && hints[hintIndex].end <= start) hintIndex++;
            const hint = hints[hintIndex] && start >= hints[hintIndex].start ? hints[hintIndex] : null;
            const marker = /^(?:\\d+(?:\\.\\d+)*[.)]|[a-ząćęłńóśźż][.)]|[IVXLCDM]+[.)]|[•●▪–—-])(?:\\s+|$)/u.exec(line);
            const markerOnly = !!marker && line === marker[0].trim();
            const explicitHeading = hint?.kind === 'heading' || /^#{1,6}\\s/u.test(line);
            // A short capitalized block is only a heading after a completed utterance,
            // or at the document start. Never infer one inside an unfinished sentence.
            const titleShape = /^[\\p{Lu}\\d]/u.test(line) && line.length <= 80 && line.split(/\\s+/).length <= 8 && !/[.!?…,;]$/u.test(line);
            const inferredHeading = (blank || !previous) && titleShape && (!previous || /[.!?…][”’»"')\\]]*$/u.test(previous));
            const heading = explicitHeading || (!marker && inferredHeading);
            const reportingClause = /^[–—-]\\s+\\p{Ll}/u.test(line) && /[.!?…][”»"']$/u.test(previous);
            const referenceContinuation = !!marker && /^(?:\\d)/u.test(line) && /(?:\\b(?:art|ust|pkt|nr|rozdz)\\.?|§)\\s*$/iu.test(previous);
            const list = (!!marker && !reportingClause && !referenceContinuation) || (hint?.kind === 'list' && start === hint.start);
            if ((heading || list) && hasBody) flush();
            if (current && !current.endsWith('\\n')) current += '\\n';
            current += line;
            if (heading || markerOnly) {
                protectedPrefix = normalizeLayout(current).length;
            } else hasBody = true;
            previous = line;
            blank = false;
        }
        flush();
        return groups;
    }

    function speechSegments(text, hints = []) {
        const result = [];
        const alwaysAbbreviation = /(?<![\\p{L}\\p{N}])(?:np|tj|tzn|tzw|dr|mgr|prof|inż|ul|al|im|nr|godz|str|ust|art|pkt|św|śp|ok|zob|por|ds|wg|mln|mld|tys|proc|poz|rys|tab|wyd|ang|łac|ww|m\\.in|p\\.n\\.e|n\\.e|sp|z\\s+o\\.o)\\.$/iu;
        const contextualAbbreviation = /(?<![\\p{L}\\p{N}])(?:itd|itp|r|w)\\.$/iu;
        for (const group of readingGroups(text, hints)) {
            const source = group.layout;
            let start = 0;
            let balance = 0;
            let balanceCursor = 0;
            const boundaries = /[.!?…]+[”’»"')\\]]*(?=\\s|$)/gu;
            const append = end => {
                const displayText = source.slice(start, end).trim();
                if (displayText) result.push({text: displayText.replace(/\\s+/gu, ' '), displayText});
                start = end;
            };
            for (const match of source.matchAll(boundaries)) {
                const end = match.index + match[0].length;
                const prefix = source.slice(Math.max(0, end - 160), end);
                for (const char of source.slice(balanceCursor, end)) {
                    if ('(['.includes(char)) balance++;
                    if (')]'.includes(char)) balance--;
                }
                balanceCursor = end;
                const tail = source.slice(end).trimStart();
                if (end <= group.protectedPrefix && tail) continue;
                const candidate = source.slice(start, end).trim();
                const point = match[0] === '.';
                if (point && tail) {
                    if (alwaysAbbreviation.test(prefix)) continue;
                    if (contextualAbbreviation.test(prefix) && !/^[„«"'([]*\\p{Lu}/u.test(tail)) continue;
                    if (/(?<!\\p{L})[A-ZĄĆĘŁŃÓŚŹŻ]\\.$/u.test(prefix)) continue;
                    if (/\\d\\.$/u.test(prefix) && /^(?:\\p{Ll}|\\d)/u.test(tail)) continue;
                    // A list label belongs to its item, including labels on a separate line.
                    if (/^(?:\\d+(?:\\.\\d+)*|[a-ząćęłńóśźż]|[IVXLCDM]+)\\.$/u.test(candidate)) continue;
                    if (/(?:\\b(?:art|ust|pkt|nr|rozdz)\\.|§)\\s*\\d+\\.$/iu.test(prefix)) continue;
                }
                if (tail && balance > 0) continue;
                if (tail && /^[—–-]\\s*\\p{Ll}/u.test(tail)) continue;
                if (tail && /[)\\]]$/u.test(match[0]) && /^\\p{Ll}/u.test(tail)) continue;
                if (tail && /(?:\\.{2,}|…)/u.test(match[0]) && /^\\p{Ll}/u.test(tail)) continue;
                append(end);
            }
            append(source.length);
        }
        return result;
    }

    function splitSentences(text) {
        return speechSegments(text).map(segment => segment.text);
    }

    function clearAudioCache() {
        for (const promise of prefetchCache.values()) {
            promise.then(url => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
        }
        prefetchCache = new Map();
    }

    window.switchTab = function(tab) {
        document.getElementById('readerView').style.display = tab === 'reader' ? 'flex' : 'none';
        document.getElementById('editorView').style.display = tab === 'editor' ? 'flex' : 'none';
        document.getElementById('tabReader').classList.toggle('active', tab === 'reader');
        document.getElementById('tabEditor').classList.toggle('active', tab === 'editor');
    };

    window.applyText = function() {
        const text = document.getElementById('rawText').value.trim();
        renderSentences(text);
        window.switchTab('reader');
    };

    function renderSentences(text, hints = []) {
        window.stopReading();
        const box = document.getElementById('readerView');
        box.innerHTML = '';
        const segments = speechSegments(text, hints);
        sentences = segments.map(segment => segment.text);

        sentences.forEach((s, idx) => {
            const div = document.createElement('div');
            div.className = 'sentence';
            div.id = 'sent-' + idx;
            div.innerText = segments[idx].displayText;
            div.onclick = () => window.startFrom(idx);
            box.appendChild(div);
        });
        currentIdx = 0;
        document.getElementById('progressBar').style.width = '0%';
        setStatus(`Gotowy • Zdań: ${sentences.length}`);
    }

    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setStatus(`⏳ Wysyłanie pliku (${file.name})...`);
        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Błąd serwera HTTP ' + res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            document.getElementById('rawText').value = data.text;
            renderSentences(data.text, data.blocks || []);
            window.switchTab('reader');
            setStatus(`✔️ Wczytano plik: ${file.name}`);
        } catch (err) {
            alert('Błąd wczytywania pliku: ' + err.message);
            setStatus('❌ Błąd odczytu pliku');
        }
    });

    function showGenerationStatus() {
        if (!isReading || isPaused) return;
        const seconds = Math.max(0, Math.ceil((ttsNotBefore - Date.now()) / 1000));
        setStatus(seconds > 0
            ? `Oczekiwanie na TTS • przerwa ${seconds} s • próba ${ttsAttempt}/3 • zdanie ${currentIdx + 1}/${sentences.length}`
            : `Generowanie AI (${currentIdx + 1}/${sentences.length}) • próba ${ttsAttempt}/3...`);
    }

    async function waitForTts(signal) {
        while (ttsNotBefore > Date.now()) {
            if (signal.aborted) throw new DOMException('Anulowano', 'AbortError');
            await new Promise((resolve, reject) => {
                const cancel = () => { clearTimeout(timer); reject(new DOMException('Anulowano', 'AbortError')); };
                const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ttsNotBefore - Date.now());
                signal.addEventListener('abort', cancel, {once: true});
            });
        }
        if (signal.aborted) throw new DOMException('Anulowano', 'AbortError');
    }

    async function fetchAudioBlob(idx, signal = controller.signal) {
        const text = (sentences[idx] || '').trim();
        if (!text) return null;
        const voice = document.getElementById('voiceSelect').value;
        const rate = document.getElementById('rateSlider').value;
        const key = JSON.stringify([text, voice, rate]);
        const cache = prefetchCache;
        if (cache.has(key)) return cache.get(key);
        const promise = (async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (signal.aborted) throw new DOMException('Anulowano', 'AbortError');
                if (signal === controller.signal && isReading) {
                    ttsAttempt = attempt + 1;
                    showGenerationStatus();
                }
                await waitForTts(signal);
                if (signal === controller.signal) showGenerationStatus();
                try {
                    const formData = new FormData();
                    formData.append('text', text);
                    formData.append('voice', voice);
                    formData.append('rate', rate);
                    const response = await fetch('/tts', {method: 'POST', body: formData, signal});
                    if (!response.ok) {
                        const data = await response.json().catch(() => ({}));
                        const message = typeof data.error === 'string' ? data.error :
                            (response.status < 500 && response.status !== 429 ? 'Nieprawidłowe dane wejściowe TTS.' : 'Błąd komunikacji z serwerem TTS.');
                        const error = new Error(`${message} (HTTP ${response.status})`);
                        error.retryable = typeof data.retryable === 'boolean' ? data.retryable :
                            response.status === 429 || response.status >= 500;
                        const retryHeader = response.headers.get('Retry-After');
                        const seconds = Number(retryHeader);
                        const delay = retryHeader && !Number.isFinite(seconds) ? Date.parse(retryHeader) - Date.now() : seconds * 1000;
                        error.retryDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
                        throw error;
                    }
                    const blob = await response.blob();
                    if (!blob.size) {
                        const error = new Error('Usługa TTS nie zwróciła audio.');
                        error.retryDelay = 10000;
                        throw error;
                    }
                    if (signal.aborted) throw new DOMException('Anulowano', 'AbortError');
                    return URL.createObjectURL(blob);
                } catch (error) {
                    if (error.name === 'AbortError' || signal.aborted) throw error;
                    if (error.retryable !== false || error.retryDelay > 0) {
                        ttsNotBefore = Math.max(ttsNotBefore, Date.now() + Math.max(error.retryDelay || 0, 3000));
                    }
                    if (error.retryable === false || attempt === 2) {
                        if (error instanceof TypeError) error = new Error('Błąd komunikacji z serwerem TTS. Sprawdź połączenie.');
                        if (attempt === 2 && error.retryable !== false) error.message += ' Wyczerpano 3 próby.';
                        throw error;
                    }
                    // A single retry owner; retain the cooldown across stop/resume.
                    ttsNotBefore = Math.max(ttsNotBefore, Date.now() + Math.max(error.retryDelay || 0, attempt === 0 ? 3000 : 8000));
                }
            }
        })();
        cache.set(key, promise);
        try { return await promise; }
        catch (error) { if (cache.get(key) === promise) cache.delete(key); throw error; }
    }

    function playbackFailed(error, token) {
        if (token !== session) return;
        window.stopReading();
        setStatus('Błąd odtwarzania: ' + error.message + ' Naciśnij ▶, aby wznowić ten sam fragment po przerwie.');
    }

    async function playReady(token) {
        if (token !== session || !isReading || isPaused || !ready) return;
        setStatus(`Czytanie zdania ${currentIdx + 1} z ${sentences.length}`);
        try { await audio.play(); }
        catch (error) {
            if (token === session && isPaused && error.name === 'AbortError') return;
            playbackFailed(error, token);
        }
    }

    async function playCurrent() {
        const token = session;
        while (currentIdx < sentences.length && !sentences[currentIdx].trim()) currentIdx++;
        if (!isReading) return;
        if (currentIdx >= sentences.length) {
            window.stopReading();
            setStatus('Zakończono czytanie');
            return;
        }
        const idx = currentIdx;
        ttsAttempt = 1;
        const player = audio;
        ready = false;
        loading = true;
        document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active'));
        const activeEl = document.getElementById('sent-' + idx);
        if (activeEl) {
            activeEl.classList.add('active');
            activeEl.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
        document.getElementById('progressBar').style.width = (((idx + 1) / sentences.length) * 100) + '%';
        setStatus(`Generowanie AI (${idx + 1}/${sentences.length})...`);
        try {
            const audioUrl = await fetchAudioBlob(idx);
            if (token !== session || !isReading) return;
            loading = false;
            player.src = audioUrl;
            ready = true;
            player.onended = () => {
                if (token !== session || !isReading || currentIdx !== idx) return;
                player.onended = null;
                ready = false;
                currentIdx++;
                if (!isPaused) playCurrent();
            };
            player.onerror = () => playbackFailed(new Error('Nie można odtworzyć otrzymanego audio.'), token);
            // Generate only the active fragment; no speculative retries in parallel.
            await playReady(token);
        } catch (error) { playbackFailed(error, token); }
    }

    window.startFrom = function(idx) {
        window.stopReading();
        currentIdx = idx;
        isReading = true;
        document.getElementById('playBtn').innerText = '⏸';
        playCurrent();
    };

    window.togglePlay = function() {
        if (sentences.length === 0) {
            renderSentences(document.getElementById('rawText').value);
            if (!sentences.length) return setStatus('Najpierw wczytaj plik lub wklej tekst!');
        }
        if (!isReading) {
            window.startFrom(currentIdx >= sentences.length ? 0 : currentIdx);
        } else if (!isPaused) {
            isPaused = true;
            audio.pause();
            document.getElementById('playBtn').innerText = '▶';
            setStatus('Wstrzymano');
        } else {
            isPaused = false;
            document.getElementById('playBtn').innerText = '⏸';
            if (ready) playReady(session);
            else if (!loading) playCurrent();
            else showGenerationStatus();
        }
    };

    window.stopReading = function() {
        session++;
        controller.abort();
        controller = new AbortController();
        isReading = false;
        isPaused = false;
        ready = false;
        loading = false;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio = new Audio();
        clearAudioCache();
        document.getElementById('playBtn').innerText = '▶';
        setStatus('Zatrzymano');
    };

    window.skip = function(delta) {
        if (sentences.length === 0) return;
        const next = Math.max(0, Math.min(sentences.length - 1, currentIdx + delta));
        window.startFrom(next);
    };

    function setStatus(msg) {
        document.getElementById('statusText').innerText = msg;
    }
</script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTML_PAGE

def normalize_pdf_text(text: str) -> str:
    """Join extraction line wraps while preserving visible paragraph clues."""
    paragraphs = []
    current = ""
    previous_indent = None
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = re.sub(r"[^\S\n]+", " ", raw).strip()
        if not line:
            if current:
                paragraphs.append(current)
                current = ""
            previous_indent = None
            continue
        indent = len(raw) - len(raw.lstrip())
        new_block = bool((previous_indent is not None and indent >= previous_indent + 2)
                         or re.match(r"^(?:[•●▪–—-]|\d+[.)])\s+", line))
        if current and new_block:
            paragraphs.append(current)
            current = ""
        current = f"{current} {line}" if current else line
        previous_indent = indent
    if current:
        paragraphs.append(current)
    return "\n\n".join(paragraphs)


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        content = await file.read()
        name = file.filename.lower()
        extracted = ""
        if name.endswith(".txt"):
            try:
                extracted = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                return {"error": "Nie można bezpiecznie odczytać kodowania TXT. Zapisz plik jako UTF-8 i wczytaj ponownie."}
        elif name.endswith(".docx"):
            doc = docx.Document(io.BytesIO(content))
            parts = []
            blocks = []
            offset = 0
            for paragraph in doc.paragraphs:
                value = paragraph.text
                style = paragraph.style.style_id if paragraph.style else ""
                kind = "heading" if style.startswith(("Heading", "Title", "Subtitle")) else "body"
                if kind == "body" and (style.startswith("List") or paragraph._p.xpath("./w:pPr/w:numPr")):
                    kind = "list"
                length = len(value.encode("utf-16-le")) // 2
                blocks.append({"start": offset, "end": offset + length, "kind": kind})
                parts.append(value)
                offset += length + 2
            extracted = "\n\n".join(parts)
            return {"text": extracted, "blocks": blocks}
        elif name.endswith(".pdf"):
            reader = PdfReader(io.BytesIO(content))
            extracted = "\n\n".join(
                text for page in reader.pages
                if (text := normalize_pdf_text(page.extract_text(extraction_mode="layout") or ""))
            )
        return {"text": extracted}
    except Exception as e:
        return {"error": str(e)}

@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    if request.url.path != "/tts":
        from fastapi.exception_handlers import request_validation_exception_handler
        return await request_validation_exception_handler(request, error)
    request_id = uuid.uuid4().hex
    TTS_LOG.warning("tts request_id=%s category=invalid_input edge_tts=%s validation_errors=%d",
                    request_id, TTS_VERSION, len(error.errors()))
    return JSONResponse(status_code=422, headers={"X-TTS-Request-ID": request_id},
                        content={"error": "Nieprawidłowy format danych wejściowych TTS.",
                                 "code": "invalid_input", "retryable": False, "request_id": request_id})


@app.post("/tts")
async def tts_endpoint(text: str = Form(""), voice: str = Form(""), rate: int = Form(0)):
    started = time.monotonic()
    request_id = uuid.uuid4().hex
    text = text.strip()

    def diagnostic(category, exception=None, provider_status=None, audio_bytes=0):
        # Never log document text, exception messages, provider URLs or payloads.
        TTS_LOG.log(
            logging.INFO if category == "success" else logging.WARNING,
            "tts request_id=%s category=%s edge_tts=%s chars=%d voice=%s rate=%d elapsed_ms=%d exception=%s provider_status=%s audio_bytes=%d",
            request_id, category, TTS_VERSION, len(text),
            voice if voice in {"pl-PL-ZofiaNeural", "pl-PL-MarekNeural"} else "invalid",
            rate, int((time.monotonic() - started) * 1000),
            type(exception).__name__ if exception else "none", provider_status, audio_bytes,
        )

    def failure(status, code, message, retryable, exception=None, retry_after=None, provider_status=None):
        diagnostic(code, exception, provider_status)
        headers = {"X-TTS-Request-ID": request_id}
        if retry_after is not None:
            headers["Retry-After"] = str(retry_after)
        return JSONResponse(status_code=status, headers=headers,
                            content={"error": message, "code": code, "retryable": retryable, "request_id": request_id})

    if not text or not any(char.isalnum() for char in text) or voice not in {"pl-PL-ZofiaNeural", "pl-PL-MarekNeural"} or not -50 <= rate <= 50:
        return failure(400, "invalid_input", "Nieprawidłowe dane TTS: wymagany tekst z literą lub cyfrą, obsługiwany głos i tempo od -50 do 50.", False)
    path = None
    try:
        fd, path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        comm = edge_tts.Communicate(text, voice, rate=f"{rate:+d}%")
        await asyncio.wait_for(comm.save(path), timeout=45)
        with open(path, "rb") as f:
            audio_bytes = f.read()
        if not audio_bytes:
            raise NoAudioReceived("Empty audio response")
        diagnostic("success", audio_bytes=len(audio_bytes))
        return Response(content=audio_bytes, media_type="audio/mpeg", headers={"X-TTS-Request-ID": request_id})
    except NoAudioReceived as error:
        return failure(502, "no_audio", "Usługa syntezy nie zwróciła audio. Spróbuj ponownie po przerwie.", True, error, 10)
    except asyncio.TimeoutError as error:
        return failure(504, "timeout", "Przekroczono czas oczekiwania na syntezę.", True, error, 8)
    except ClientResponseError as error:
        # Do not evade explicit provider refusals with repeated connections.
        retry_after = 30
        provider_delay = (error.headers or {}).get("Retry-After", "")
        try:
            retry_after = max(retry_after, int(provider_delay))
        except (ValueError, TypeError):
            try:
                retry_after = max(retry_after, int(parsedate_to_datetime(provider_delay).timestamp() - time.time()) + 1)
            except (ValueError, TypeError, OverflowError):
                pass
        return failure(503, "connection_rejected", "Dostawca syntezy odrzucił połączenie. Spróbuj później.", False, error, retry_after, error.status)
    except (ClientConnectorError, ConnectionRefusedError) as error:
        return failure(503, "connection_refused", "Nie udało się nawiązać połączenia z usługą syntezy.", True, error, 8)
    except (ClientError, ConnectionError, OSError) as error:
        return failure(503, "communication_error", "Błąd komunikacji z usługą syntezy.", True, error, 8)
    except ValueError as error:
        return failure(400, "invalid_input", "Usługa syntezy nie zaakceptowała danych wejściowych.", False, error)
    except Exception as error:
        return failure(502, "synthesis_error", "Usługa syntezy nie wygenerowała audio.", True, error, 8)
    finally:
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass

if __name__ == "__main__":
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)
    print("\n" + "=" * 55)
    print("🚀 AUDIOREADER AI URUCHOMIONY!")
    print(f"👉 Adres lokalny: http://{local_ip}:8550")
    print("=" * 55 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8550)