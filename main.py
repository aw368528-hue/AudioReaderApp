import io
import socket
import tempfile
import os
import docx
import edge_tts
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse, Response, JSONResponse
from pypdf import PdfReader
import uvicorn

app = FastAPI()

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
    let prefetchCache = {};

    window.switchTab = function(tab) {
        document.getElementById('readerView').style.display = tab === 'reader' ? 'flex' : 'none';
        document.getElementById('editorView').style.display = tab === 'editor' ? 'flex' : 'none';
        document.getElementById('tabReader').classList.toggle('active', tab === 'reader');
        document.getElementById('tabEditor').classList.toggle('active', tab === 'editor');
    };

    window.applyText = function() {
        const text = document.getElementById('rawText').value.trim();
        if (!text) return;
        renderSentences(text);
        window.switchTab('reader');
    };

    function renderSentences(text) {
        window.stopReading();
        const box = document.getElementById('readerView');
        box.innerHTML = '';
        sentences = text.split(/(?<=[.!?\\n])\\s+/).map(s => s.trim()).filter(Boolean);
        if (sentences.length === 0) sentences = [text];
        prefetchCache = {};

        sentences.forEach((s, idx) => {
            const div = document.createElement('div');
            div.className = 'sentence';
            div.id = 'sent-' + idx;
            div.innerText = s;
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
            renderSentences(data.text);
            window.switchTab('reader');
            setStatus(`✔️ Wczytano plik: ${file.name}`);
        } catch (err) {
            alert('Błąd wczytywania pliku: ' + err.message);
            setStatus('❌ Błąd odczytu pliku');
        }
    });

    async function fetchAudioBlob(idx) {
        const voice = document.getElementById('voiceSelect').value;
        const rate = document.getElementById('rateSlider').value;
        const key = `${idx}_${voice}_${rate}`;
        if (prefetchCache[key]) return prefetchCache[key];

        const formData = new FormData();
        formData.append('text', sentences[idx]);
        formData.append('voice', voice);
        formData.append('rate', rate);

        const promise = fetch('/tts', { method: 'POST', body: formData })
            .then(r => {
                if (!r.ok) throw new Error('TTS error');
                return r.blob();
            })
            .then(blob => URL.createObjectURL(blob));
        prefetchCache[key] = promise;
        return promise;
    }

    async function playCurrent() {
        if (!isReading || currentIdx >= sentences.length) {
            window.stopReading();
            setStatus('Zakończono czytanie');
            return;
        }

        document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active'));
        const activeEl = document.getElementById('sent-' + currentIdx);
        if (activeEl) {
            activeEl.classList.add('active');
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        document.getElementById('progressBar').style.width = (((currentIdx + 1) / sentences.length) * 100) + '%';
        setStatus(`Generowanie AI (${currentIdx + 1}/${sentences.length})...`);

        try {
            const audioUrl = await fetchAudioBlob(currentIdx);
            if (!isReading) return;

            if (currentIdx + 1 < sentences.length) {
                fetchAudioBlob(currentIdx + 1);
            }

            audio.src = audioUrl;
            setStatus(`Czytanie zdania ${currentIdx + 1} z ${sentences.length}`);
            await audio.play();
        } catch (err) {
            setStatus('Błąd odtwarzania: ' + err.message);
        }
    }

    audio.onended = () => {
        if (isReading && !isPaused) {
            currentIdx++;
            playCurrent();
        }
    };

    window.startFrom = function(idx) {
        window.stopReading();
        currentIdx = idx;
        isReading = true;
        isPaused = false;
        document.getElementById('playBtn').innerText = '⏸';
        playCurrent();
    };

    window.togglePlay = function() {
        if (sentences.length === 0) {
            const raw = document.getElementById('rawText').value.trim();
            if (raw) renderSentences(raw);
            else return setStatus('Najpierw wczytaj plik lub wklej tekst!');
        }

        if (!isReading) {
            window.startFrom(currentIdx);
        } else if (!isPaused) {
            audio.pause();
            isPaused = true;
            document.getElementById('playBtn').innerText = '▶';
            setStatus('Wstrzymano');
        } else {
            audio.play();
            isPaused = false;
            document.getElementById('playBtn').innerText = '⏸';
            setStatus(`Czytanie zdania ${currentIdx + 1} z ${sentences.length}`);
        }
    };

    window.stopReading = function() {
        isReading = false;
        isPaused = false;
        audio.pause();
        audio.currentTime = 0;
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

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        content = await file.read()
        name = file.filename.lower()
        extracted = ""
        if name.endswith(".txt"):
            extracted = content.decode("utf-8", errors="ignore")
        elif name.endswith(".docx"):
            doc = docx.Document(io.BytesIO(content))
            extracted = "\n".join([p.text for p in doc.paragraphs])
        elif name.endswith(".pdf"):
            reader = PdfReader(io.BytesIO(content))
            for page in reader.pages:
                t = page.extract_text()
                if t:
                    extracted += t + "\n"
        return {"text": extracted}
    except Exception as e:
        return {"error": str(e)}

@app.post("/tts")
async def tts_endpoint(text: str = Form(...), voice: str = Form(...), rate: int = Form(...)):
    rate_str = f"+{rate}%" if rate >= 0 else f"{rate}%"
    fd, path = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    try:
        comm = edge_tts.Communicate(text, voice, rate=rate_str)
        await comm.save(path)
        with open(path, "rb") as f:
            audio_bytes = f.read()
        return Response(content=audio_bytes, media_type="audio/mpeg")
    finally:
        if os.path.exists(path):
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