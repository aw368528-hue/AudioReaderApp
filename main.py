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
    let activePlayback = null;
    const mediaSession = typeof navigator !== 'undefined' && navigator.mediaSession ? navigator.mediaSession : null;
    let ttsNotBefore = 0;
    let ttsAttempt = 1;

    // Layout whitespace is retained for display; only the speech projection collapses it.
    function normalizeLayout(text) {
        return text.replace(/\\r\\n?/g, '\\n').replace(/[^\\S\\n]+/gu, ' ')
            .replace(/ *\\n */g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    }

    function documentUnits(text, hints) {
        const source = text.replace(/\\r\\n?/g, '\\n');
        const units = [];
        let offset = 0;
        let scanned = 0;
        let depth = 0;
        let quote = null;
        let hintIndex = 0;
        const outside = end => {
            for (; scanned < end; scanned++) {
                const char = source[scanned];
                if (quote) { if (char === quote) quote = null; continue; }
                if (char === '„') quote = '”';
                else if (char === '«') quote = '»';
                else if (char === '"') quote = '"';
                else if ('([{'.includes(char)) depth++;
                else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
            }
            return depth === 0 && quote === null;
        };
        for (const raw of source.split('\\n')) {
            while (hintIndex < hints.length && hints[hintIndex].end <= offset) hintIndex++;
            const hint = hints[hintIndex] && offset >= hints[hintIndex].start ? hints[hintIndex] : null;
            const labels = /(?<![\\p{L}\\p{N}])(?:Data(?:\\s+(?:utworzenia|modyfikacji|aktualizacji))?|Uczestnicy(?:\\s+konfrontacji)?|Status|Autor(?:zy)?|Wersja|Temat|Projekt|Tytuł|Numer\\s+dokumentu)\\s*:/giu;
            const matches = [...raw.matchAll(labels)].filter(match => outside(offset + match.index));
            const first = matches[0];
            const prefix = first ? raw.slice(0, first.index).trim() : '';
            const capitals = /\\p{Lu}/u.test(prefix) && !/\\p{Ll}/u.test(prefix);
            // Inline labels are structural only after an unambiguous title or a
            // field at line start. Ordinary prose mentioning "Status:" is unchanged.
            const structural = first && (!prefix || capitals || hint?.kind === 'heading');
            if (structural) {
                if (prefix) units.push({raw: raw.slice(0, first.index), start: offset, kind: 'metadata-title'});
                for (let index = 0; index < matches.length; index++) {
                    const begin = matches[index].index;
                    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
                    units.push({raw: raw.slice(begin, end), start: offset + begin, kind: 'metadata'});
                }
            } else units.push({raw, start: offset, kind: 'text'});
            offset += raw.length + 1;
        }
        return units;
    }

    function readingGroups(text, hints = []) {
        const units = documentUnits(text, hints);
        const groups = [];
        let current = '';
        let hasBody = false;
        let protectedPrefix = 0;
        let atomic = false;
        let previous = '';
        let blank = false;
        let hintIndex = 0;
        const flush = () => {
            if (current.trim()) groups.push({layout: normalizeLayout(current), protectedPrefix, atomic});
            current = ''; hasBody = false; protectedPrefix = 0; atomic = false;
        };
        for (const unit of units) {
            const {raw, start} = unit;
            const line = raw.replace(/[^\\S\\n]+/gu, ' ').trim();
            if (!line) { if (current) current += '\\n\\n'; blank = true; continue; }
            while (hintIndex < hints.length && hints[hintIndex].end <= start) hintIndex++;
            const hint = hints[hintIndex] && start >= hints[hintIndex].start ? hints[hintIndex] : null;
            if (unit.kind !== 'text') {
                flush();
                current = line;
                atomic = true;
                hasBody = true;
                previous = line;
                blank = false;
                continue;
            }
            const marker = /^(?:\\d+(?:\\.\\d+)*[.)]|[a-ząćęłńóśźż][.)]|[IVXLCDM]+[.)]|[•●▪–—-])(?:\\s+|$)/u.exec(line);
            if (atomic) {
                // Keep wrapped values, but never absorb a following heading/list.
                const continuation = (/[,;]$/u.test(previous) || /^\\p{Ll}/u.test(line)) &&
                    !marker && hint?.kind !== 'heading' && hint?.kind !== 'list';
                if (continuation) {
                    current += (blank ? '\\n\\n' : '\\n') + line;
                    previous = line; blank = false;
                    continue;
                }
                flush();
            }
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
            if (group.atomic) {
                result.push({text: source.replace(/\\s+/gu, ' '), displayText: source});
                continue;
            }
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

    const testMode = new URLSearchParams(location.search).get('test') === '1';
    let bufferMode = new URLSearchParams(location.search).get('buffer') === '0' ? 0 : 2;
    const CACHE_MAX_FRAGMENTS = 3;
    const CACHE_MAX_BYTES = 8 * 1024 * 1024;
    let jobs = new Map();
    let queueRunning = false;
    let prefetchBlocked = false;
    let attachedKey = null;
    let transition = null;
    const diagnostics = testMode ? {started: performance.now(), events: [], dropped: 0,
        gaps: [], droppedGaps: 0, failed: 0, cancelled: 0, hits: 0, misses: 0,
        recoveryAttempts: 0, observedPlayers: new WeakSet(), progressAt: new WeakMap(), visibleProbe: 0, visibleTimer: null} : null;

    function setMediaPlaybackState(state) {
        if (!mediaSession || !('playbackState' in mediaSession)) return;
        try { mediaSession.playbackState = state; } catch {}
    }

    function registerMediaSessionActions() {
        if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return;
        try {
            if (typeof MediaMetadata === 'function') {
                mediaSession.metadata = new MediaMetadata({title: 'AudioReader AI', artist: 'Odtwarzanie tekstu'});
            }
        } catch {}
        const actions = {
            play: () => { if (!isReading || isPaused) window.togglePlay(); },
            pause: () => { if (isReading && !isPaused) window.togglePlay(); },
            stop: () => { if (isReading) window.stopReading(); }
        };
        for (const [action, handler] of Object.entries(actions)) {
            try { mediaSession.setActionHandler(action, handler); } catch {}
        }
    }

    function handleUnexpectedPause(player) {
        const playback = activePlayback;
        if (!playback || playback.player !== player || playback.token !== session ||
            playback.idx !== currentIdx || playback.ended || player.ended || !player.paused) return;
        setMediaPlaybackState('paused');
        if (isPaused) return;
        const age = performance.now() - playback.startedAt;
        const currentTime = Number(player.currentTime);
        // Recover only the short startup interruption seen in MOB-04A. Later pauses
        // are ambiguous and stay paused for the user to resume explicitly.
        const eligible = isReading && playback.startedAt !== null && age >= 0 && age <= 500 &&
            Number.isFinite(currentTime) && currentTime <= 0.5 &&
            (document.visibilityState || 'unknown') === 'hidden';
        if (!eligible || playback.recoveryTried) {
            isPaused = true;
            document.getElementById('playBtn').innerText = '▶';
            setStatus('Odtwarzanie zostało wstrzymane. Naciśnij ▶, aby wznowić.');
            trace('recovery_result', {fragment: playback.idx, result: 'left_paused', reason: playback.recoveryTried ? 'retry_used' : 'outside_recovery_window'});
            return;
        }
        playback.recoveryTried = true;
        trace('recovery_scheduled', {fragment: playback.idx, playback_age_ms: age, current_time: currentTime});
        setTimeout(async () => {
            if (activePlayback !== playback || playback.token !== session || playback.idx !== currentIdx ||
                player !== audio || !isReading || isPaused ||
                (document.visibilityState || 'unknown') !== 'hidden' || !player.paused || player.ended) {
                const samePlayback = activePlayback === playback && playback.token === session && playback.idx === currentIdx && player === audio;
                if (samePlayback && isReading && !isPaused && player.paused) {
                    isPaused = true;
                    setMediaPlaybackState('paused');
                    document.getElementById('playBtn').innerText = '▶';
                    setStatus('Odtwarzanie zostało wstrzymane. Naciśnij ▶, aby wznowić.');
                }
                trace('recovery_cancelled', {fragment: playback.idx, same_playback: samePlayback});
                return;
            }
            if (diagnostics) diagnostics.recoveryAttempts++;
            trace('recovery_attempt', {fragment: playback.idx, current_time: Number.isFinite(player.currentTime) ? player.currentTime : null});
            try {
                await player.play();
                if (activePlayback === playback && playback.token === session && playback.idx === currentIdx &&
                    player === audio && isReading && !isPaused) {
                    setMediaPlaybackState('playing');
                    trace('recovery_result', {fragment: playback.idx, result: 'play_resolved'});
                }
            } catch (error) {
                if (activePlayback !== playback || playback.token !== session || playback.idx !== currentIdx || player !== audio) return;
                isPaused = true;
                setMediaPlaybackState('paused');
                document.getElementById('playBtn').innerText = '▶';
                setStatus('Odtwarzanie zostało wstrzymane. Naciśnij ▶, aby wznowić.');
                trace('recovery_result', {fragment: playback.idx, result: 'play_rejected', error_name: error?.name || 'Error'});
            }
        }, 150);
    }

    function observePlaybackPause(player) {
        if (typeof player.addEventListener !== 'function') return;
        player.addEventListener('pause', () => {
            handleUnexpectedPause(player);
            if (diagnostics) trace('media_event', {media_event: 'pause', player: playerSnapshot(player)});
        });
    }

    observePlaybackPause(audio);

    function playerSnapshot(player = audio) {
        const numberOrNull = value => Number.isFinite(value) ? value : null;
        return {paused: !!player.paused, ended: !!player.ended,
            current_time: numberOrNull(player.currentTime), duration: numberOrNull(player.duration),
            ready_state: Number.isFinite(player.readyState) ? player.readyState : null,
            network_state: Number.isFinite(player.networkState) ? player.networkState : null,
            playback_rate: numberOrNull(player.playbackRate),
            media_error_code: player.error && Number.isFinite(player.error.code) ? player.error.code : null};
    }

    function trace(type, fields = {}) {
        if (!diagnostics) return;
        if (diagnostics.events.length === 2000) { diagnostics.events.shift(); diagnostics.dropped++; }
        diagnostics.events.push({type, ms: performance.now() - diagnostics.started,
            session, index: currentIdx, buffer: bufferMode,
            visibility: document.visibilityState || 'unknown', player: playerSnapshot(), ...fields});
    }

    function observePlayer(player) {
        if (!diagnostics || diagnostics.observedPlayers.has(player)) return;
        diagnostics.observedPlayers.add(player);
        for (const type of ['playing', 'waiting', 'stalled', 'suspend', 'ended', 'error']) {
            player.addEventListener(type, () => trace('media_event', {media_event: type,
                player: playerSnapshot(player)}));
        }
        player.addEventListener('timeupdate', () => {
            const now = performance.now();
            const previous = diagnostics.progressAt.get(player) ?? -Infinity;
            if (now - previous < 5000) return;
            diagnostics.progressAt.set(player, now);
            trace('playback_progress', {player: playerSnapshot(player)});
        });
    }

    observePlayer(audio);

    function finishTransition(outcome) {
        if (!transition) return;
        if (diagnostics) {
            if (outcome === 'failed') diagnostics.failed++;
            if (outcome === 'cancelled') diagnostics.cancelled++;
            if (outcome === 'playing') {
                const gap = Math.max(0, performance.now() - transition.ended);
                const visibility = !transition.mixed && transition.visibility === document.visibilityState ? transition.visibility : 'mixed';
                if (diagnostics.gaps.length === 2000) { diagnostics.gaps.shift(); diagnostics.droppedGaps++; }
                diagnostics.gaps.push({ms: gap, visibility, buffer: transition.buffer});
                trace('gap', {gap_ms: gap, from: transition.from, to: transition.to, gap_visibility: visibility});
            } else trace('transition_' + outcome, {from: transition.from, to: transition.to});
        }
        transition = null;
    }

    function diagnosticReport() {
        if (!diagnostics) return null;
        const stats = values => {
            const sorted = values.slice().sort((a, b) => a - b);
            const n = sorted.length;
            return {count: n, median_ms: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
                p95_ms: n ? sorted[Math.ceil(n * .95) - 1] : null, max_ms: n ? sorted[n - 1] : null};
        };
        const groups = {};
        for (const mode of [0, 2]) for (const visibility of ['visible', 'hidden', 'mixed', 'unknown']) {
            groups[`buffer=${mode}/${visibility}`] = stats(diagnostics.gaps.filter(g => g.buffer === mode && g.visibility === visibility).map(g => g.ms));
        }
        return {schema: 'MOB-04A/1', elapsed_ms: performance.now() - diagnostics.started,
            buffer: bufferMode, limits: {fragments: CACHE_MAX_FRAGMENTS, bytes: CACHE_MAX_BYTES},
            gaps: stats(diagnostics.gaps.map(g => g.ms)), groups,
            failed_transitions: diagnostics.failed, cancelled_transitions: diagnostics.cancelled,
            pending_transition: transition ? {from: transition.from, to: transition.to, elapsed_ms: performance.now() - transition.ended} : null,
            buffer_hits: diagnostics.hits, buffer_misses: diagnostics.misses,
            recovery_attempts: diagnostics.recoveryAttempts,
            dropped_events: diagnostics.dropped, dropped_gap_samples: diagnostics.droppedGaps,
            cache: {fragments: prefetchCache.size, bytes: cacheBytes()},
            note: 'Hidden nie potwierdza blokady ekranu. media_event zawiera stan odtwarzacza i currentTime. Po powrocie do widocznej strony wykonywany jest punkt kontrolny po 5 s; playback_advanced oznacza zmianę currentTime ponad 0,05 s. Przerwy ended/playing mierzą callbacki. Rejestrowanych jest maksymalnie 2000 zdarzeń.',
            events: diagnostics.events.map(event => ({...event}))};
    }

    function exportDiagnostics() {
        const report = diagnosticReport();
        if (!report) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'audioreader-diagnostics.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function cacheBytes() { return [...prefetchCache.values()].reduce((sum, job) => sum + job.bytes, 0); }
    function releaseJob(job) {
        if (job.key === attachedKey) return false;
        if (job.url) { URL.revokeObjectURL(job.url); trace('cache_release', {fragment: job.idx, bytes: job.bytes}); job.url = null; }
        prefetchCache.delete(job.key);
        if (job.status === 'done') job.status = 'deferred';
        return true;
    }
    function trimCache() {
        for (const job of prefetchCache.values()) {
            if (job.idx < currentIdx || job.idx > currentIdx + bufferMode) releaseJob(job);
        }
        for (const [key, job] of jobs) {
            if (key !== attachedKey && (job.idx < currentIdx || job.idx > currentIdx + bufferMode) && !['queued', 'running'].includes(job.status)) jobs.delete(key);
        }
    }
    function clearAudioCache() {
        for (const job of prefetchCache.values()) releaseJob(job);
        prefetchCache = new Map();
    }
    function storeAudio(job, blob) {
        if (blob.size > CACHE_MAX_BYTES) {
            const error = new Error('Fragment audio przekracza limit pamięci (8 MiB).');
            error.retryable = false;
            throw error;
        }
        trimCache();
        for (const cached of [...prefetchCache.values()].sort((a, b) => b.idx - a.idx)) {
            if (cacheBytes() + blob.size <= CACHE_MAX_BYTES && prefetchCache.size < CACHE_MAX_FRAGMENTS) break;
            if (job.foreground || cached.idx > job.idx) releaseJob(cached);
        }
        if (cacheBytes() + blob.size > CACHE_MAX_BYTES || prefetchCache.size >= CACHE_MAX_FRAGMENTS) return false;
        job.bytes = blob.size;
        job.url = URL.createObjectURL(blob);
        prefetchCache.set(job.key, job);
        trace('cache_store', {fragment: job.idx, bytes: job.bytes, cache_bytes: cacheBytes(), cache_fragments: prefetchCache.size});
        return true;
    }

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
                const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, Math.min(2147483647, ttsNotBefore - Date.now()));
                signal.addEventListener('abort', cancel, {once: true});
            });
        }
        if (signal.aborted) throw new DOMException('Anulowano', 'AbortError');
    }

    async function synthesize(job, signal, token) {
        while (job.attempts < 3) {
            job.waiting = true;
            if (job.foreground && token === session) { ttsAttempt = job.attempts + 1; showGenerationStatus(); }
            await waitForTts(signal);
            job.waiting = false;
            if (job.foreground && token === session) showGenerationStatus();
            job.attempts++;
            let fetchFinished = false;
            const fetched = fields => {
                if (fetchFinished) return;
                fetchFinished = true;
                trace('fetch_end', {session: token, fragment: job.idx, attempt: job.attempts, ...fields});
            };
            try {
                const formData = new FormData();
                formData.append('text', job.text);
                formData.append('voice', job.voice);
                formData.append('rate', job.rate);
                trace('fetch_start', {session: token, fragment: job.idx, attempt: job.attempts, prefetch: !job.foreground});
                const response = await fetch('/tts', {method: 'POST', body: formData, signal});
                if (signal.aborted || token !== session) throw new DOMException('Anulowano', 'AbortError');
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    fetched({status: response.status});
                    const message = typeof data.error === 'string' ? data.error :
                        (response.status < 500 && response.status !== 429 ? 'Nieprawidłowe dane wejściowe TTS.' : 'Błąd komunikacji z serwerem TTS.');
                    const error = new Error(`${message} (HTTP ${response.status})`);
                    const codes = ['no_audio', 'timeout', 'connection_rejected', 'connection_refused',
                        'communication_error', 'invalid_input', 'synthesis_error'];
                    error.code = codes.includes(data.code) ? data.code : 'http_error';
                    error.retryable = typeof data.retryable === 'boolean' ? data.retryable : response.status === 429 || response.status >= 500;
                    const header = response.headers.get('Retry-After');
                    const seconds = Number(header);
                    const delay = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
                    error.retryDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
                    throw error;
                }
                const blob = await response.blob();
                fetched({status: response.status || 200, bytes: blob.size});
                if (signal.aborted || token !== session) throw new DOMException('Anulowano', 'AbortError');
                if (!blob.size) { const error = new Error('Usługa TTS nie zwróciła audio.'); error.code = 'no_audio'; error.retryDelay = 10000; throw error; }
                return storeAudio(job, blob);
            } catch (error) {
                fetched({result: signal.aborted || token !== session ? 'aborted' : 'network_error'});
                if (signal.aborted || token !== session || error.name === 'AbortError') throw error;
                trace('tts_error', {fragment: job.idx, attempt: job.attempts,
                    code: error.code || (error instanceof TypeError ? 'communication_error' : 'audio_error'),
                    retryable: error.retryable !== false});
                if (error.retryable !== false || error.retryDelay > 0) {
                    ttsNotBefore = Math.max(ttsNotBefore, Date.now() + Math.max(error.retryDelay || 0, job.attempts === 1 ? 3000 : 8000));
                    trace('cooldown', {fragment: job.idx, delay_ms: ttsNotBefore - Date.now()});
                }
                if (error instanceof TypeError) error = new Error('Błąd komunikacji z serwerem TTS. Sprawdź połączenie.');
                job.error = error;
                if (job.attempts === 3 && error.retryable !== false) error.message += ' Wyczerpano 3 próby.';
                // Speculation never starts its own retry cycle. Foreground inherits the budget.
                if (!job.foreground || error.retryable === false || job.attempts === 3) throw error;
            }
        }
        throw job.error || new Error('Wyczerpano 3 próby przygotowania fragmentu.');
    }

    function pumpQueue() {
        if (queueRunning || ![...jobs.values()].some(job => job.status === 'queued' &&
            (job.foreground || (isReading && !isPaused && bufferMode === 2 && !prefetchBlocked)))) return;
        const token = session;
        const signal = controller.signal;
        queueRunning = true;
        (async () => {
            try {
                while (!signal.aborted && token === session) {
                    const available = [...jobs.values()].filter(job => job.status === 'queued' &&
                        (job.foreground || (isReading && !isPaused && bufferMode === 2 && !prefetchBlocked)));
                    available.sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.idx - b.idx);
                    const job = available[0];
                    if (!job) break;
                    job.status = 'running';
                    try {
                        const stored = await synthesize(job, signal, token);
                        if (token !== session || signal.aborted) throw new DOMException('Anulowano', 'AbortError');
                        // Valid audio ends this synthesis cycle, even if cache capacity
                        // prevents retaining it. A later cache miss starts a new budget.
                        job.attempts = 0;
                        job.error = null;
                        job.status = stored ? 'done' : 'deferred';
                        if (!stored) prefetchBlocked = true;
                        job.resolve(stored ? job.url : null);
                        if (job.foreground && stored) prefetchBlocked = false;
                    } catch (error) {
                        job.status = 'failed'; job.error = error;
                        job.reject(error);
                        if (token !== session || signal.aborted) break;
                        if (!job.foreground) prefetchBlocked = true;
                    }
                }
            } finally {
                // Keep the lock across session changes until the aborted fetch settles.
                queueRunning = false;
                pumpQueue();
            }
        })();
    }

    function fetchAudioBlob(idx, signal = controller.signal, foreground = true) {
        const text = (sentences[idx] || '').trim();
        if (!text) return Promise.resolve(null);
        if (signal.aborted || signal !== controller.signal) return Promise.reject(new DOMException('Anulowano', 'AbortError'));
        const voice = document.getElementById('voiceSelect').value;
        const rate = document.getElementById('rateSlider').value;
        const key = JSON.stringify([idx, voice, rate]);
        let job = jobs.get(key);
        const hit = !!(job && job.url);
        if (diagnostics && foreground) diagnostics[hit ? 'hits' : 'misses']++;
        trace(hit ? 'buffer_hit' : 'buffer_miss', {fragment: idx, in_flight: !!job && ['queued', 'running'].includes(job.status), prefetch: !foreground});
        if (hit) return Promise.resolve(job.url);
        if (job && ['queued', 'running'].includes(job.status)) {
            job.foreground ||= foreground;
            if (foreground && job.status === 'running') {
                ttsAttempt = Math.max(1, job.attempts + Number(!!job.waiting));
                showGenerationStatus();
            }
            pumpQueue();
            return job.promise;
        }
        if (job && (job.attempts >= 3 || job.error?.retryable === false)) return Promise.reject(job.error || new Error('Wyczerpano 3 próby.'));
        if (!job) { job = {key, idx, voice, rate, text, attempts: 0, url: null, bytes: 0}; jobs.set(key, job); }
        job.foreground = foreground;
        job.status = 'queued';
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        pumpQueue();
        return job.promise;
    }

    function fillBuffer() {
        if (bufferMode !== 2 || !isReading || isPaused || prefetchBlocked) return;
        trimCache();
        // Queue sequentially. A cache/transport failure freezes speculation.
        const token = session;
        const from = currentIdx + 1;
        const through = currentIdx + 2;
        (async () => {
            for (let idx = from; idx <= through && idx < sentences.length; idx++) {
                if (token !== session || !isReading || isPaused || prefetchBlocked) break;
                try {
                    if (idx <= currentIdx || idx > currentIdx + bufferMode) continue;
                    const url = await fetchAudioBlob(idx, controller.signal, false);
                    if (!url) break;
                } catch { break; }
            }
        })();
    }

    function playbackFailed(error, token) {
        if (token !== session) return;
        trace("playback_error");
        finishTransition("failed");
        window.stopReading();
        setStatus('Błąd odtwarzania: ' + error.message + ' Naciśnij ▶, aby wznowić ten sam fragment po przerwie.');
    }

    async function playReady(token) {
        if (token !== session || !isReading || isPaused || !ready) return;
        const idx = currentIdx;
        setStatus(`Czytanie zdania ${currentIdx + 1} z ${sentences.length}`);
        trace("play_call");
        setMediaPlaybackState('playing');
        try {
            await audio.play();
            if (token === session && currentIdx === idx && isReading && !isPaused) fillBuffer();
        }
        catch (error) {
            if (token !== session || currentIdx !== idx) return;
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
            if (!audioUrl) throw new Error('Brak miejsca na fragment audio.');
            attachedKey = null;
            player.src = audioUrl;
            attachedKey = [...prefetchCache.values()].find(job => job.url === audioUrl)?.key || null;
            trimCache();
            let started = false;
            activePlayback = {token, idx, player, startedAt: null, recoveryTried: false, ended: false};
            player.onplaying = () => {
                if (token !== session || currentIdx !== idx) return;
                if (activePlayback?.token === token && activePlayback.idx === idx && activePlayback.player === player && activePlayback.startedAt === null) {
                    activePlayback.startedAt = performance.now();
                }
                trace('playing');
                if (!started) { started = true; finishTransition('playing'); }
            };
            player.onwaiting = () => { if (token === session && currentIdx === idx) trace('waiting'); };
            player.onstalled = () => { if (token === session && currentIdx === idx) trace('stalled'); };
            ready = true;
            player.onended = () => {
                if (token !== session || !isReading || currentIdx !== idx) return;
                const endedAt = performance.now();
                if (activePlayback?.token === token && activePlayback.idx === idx && activePlayback.player === player) activePlayback.ended = true;
                player.onended = null;
                trace('ended');
                attachedKey = null;
                ready = false;
                if (idx + 1 < sentences.length && !isPaused) transition = {ended: endedAt, from: idx, to: idx + 1,
                    visibility: document.visibilityState || 'unknown', buffer: bufferMode};
                currentIdx++;
                trimCache();
                if (!isPaused) playCurrent();
            };
            player.onerror = () => {
                if (currentIdx === idx) playbackFailed(new Error('Nie można odtworzyć otrzymanego audio.'), token);
            };

            await playReady(token);
        } catch (error) { playbackFailed(error, token); }
    }

    window.startFrom = function(idx) {
        window.stopReading();
        currentIdx = idx;
        isReading = true;
        setMediaPlaybackState('playing');
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
            finishTransition("cancelled");
            trace("pause");
            setMediaPlaybackState('paused');
            audio.pause();
            document.getElementById('playBtn').innerText = '▶';
            setStatus('Wstrzymano');
        } else {
            isPaused = false;
            setMediaPlaybackState('playing');
            document.getElementById('playBtn').innerText = '⏸';
            if (ready) playReady(session);
            else if (!loading) playCurrent();
            else showGenerationStatus();
        }
    };

    window.stopReading = function() {
        finishTransition('cancelled');
        trace('stop');
        session++;
        activePlayback = null;
        controller.abort();
        controller = new AbortController();
        isReading = false;
        isPaused = false;
        ready = false;
        loading = false;
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        audio.onwaiting = null;
        audio.onstalled = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        setMediaPlaybackState('none');
        audio = new Audio();
        observePlaybackPause(audio);
        observePlayer(audio);
        attachedKey = null;
        clearAudioCache();
        for (const job of jobs.values()) {
            if (['queued', 'running'].includes(job.status)) job.reject(new DOMException('Anulowano', 'AbortError'));
        }
        jobs = new Map();
        prefetchBlocked = false;
        document.getElementById('playBtn').innerText = '▶';
        setStatus('Zatrzymano');
    };

    window.skip = function(delta) {
        if (sentences.length === 0) return;
        const next = Math.max(0, Math.min(sentences.length - 1, currentIdx + delta));
        window.startFrom(next);
    };

    function settingsChanged() {
        const reading = isReading;
        const paused = isPaused;
        if (reading) {
            window.startFrom(currentIdx);
            if (paused) window.togglePlay();
        } else window.stopReading();
    }
    document.getElementById('voiceSelect').addEventListener('change', settingsChanged);
    document.getElementById('rateSlider').addEventListener('change', settingsChanged);

    registerMediaSessionActions();

    if (testMode) {
        document.addEventListener('visibilitychange', () => {
            if (transition) transition.mixed = true;
            const state = document.visibilityState || 'unknown';
            trace('visibility');
            const probe = ++diagnostics.visibleProbe;
            if (diagnostics.visibleTimer !== null) clearTimeout(diagnostics.visibleTimer);
            diagnostics.visibleTimer = null;
            if (state === 'visible') {
                const player = audio;
                const token = session;
                const baseline = playerSnapshot(player);
                const startedAt = performance.now();
                diagnostics.visibleTimer = setTimeout(() => {
                    if (probe !== diagnostics.visibleProbe || document.visibilityState !== 'visible') return;
                    diagnostics.visibleTimer = null;
                    const latest = playerSnapshot(player);
                    const delta = baseline.current_time === null || latest.current_time === null
                        ? null : latest.current_time - baseline.current_time;
                    trace('visible_progress_check', {probe, session_unchanged: token === session,
                        player_unchanged: player === audio, elapsed_ms: performance.now() - startedAt,
                        current_time_before: baseline.current_time, current_time_after: latest.current_time,
                        current_time_delta: delta, playback_advanced: delta !== null && delta > 0.05,
                        checked_player: latest});
                }, 5000);
            }
        });
        const panel = document.createElement('div');
        panel.className = 'player-card';
        panel.style.flexShrink = '0';
        panel.innerHTML = '<div>Test MOB-04A • raport lokalny, bez tekstu dokumentu</div><label>Bufor <select id="diagnosticBuffer"><option value="0">0 — bez prefetch</option><option value="2">2 — dwa fragmenty</option></select></label><div><button class="btn-tonal" id="diagnosticDownload">Pobierz raport JSON</button><button class="btn-tonal" id="diagnosticCopy">Kopiuj raport</button></div><small id="diagnosticResult">Hidden nie oznacza jednoznacznie blokady ekranu.</small>';
        document.body.appendChild(panel);
        document.getElementById('diagnosticBuffer').value = String(bufferMode);
        document.getElementById('diagnosticBuffer').addEventListener('change', event => {
            window.stopReading();
            bufferMode = event.target.value === '2' ? 2 : 0;
            trace('buffer_mode');
            setStatus('Zmieniono tryb bufora. Naciśnij ▶, aby wznowić bieżący fragment.');
        });
        document.getElementById('diagnosticDownload').addEventListener('click', exportDiagnostics);
        document.getElementById('diagnosticCopy').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(JSON.stringify(diagnosticReport(), null, 2));
                document.getElementById('diagnosticResult').innerText = 'Skopiowano raport.';
            } catch {
                document.getElementById('diagnosticResult').innerText = 'Kopiowanie niedostępne. Użyj Pobierz raport JSON.';
            }
        });
        trace('test_start');
    }

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
