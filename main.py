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
from pathlib import Path
import docx
import edge_tts
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse, Response, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from pypdf import PdfReader
import uvicorn
from aiohttp import ClientError, ClientResponseError, ClientConnectorError
from edge_tts.exceptions import NoAudioReceived

app = FastAPI()
OCR_PROBE_DIR = Path(__file__).resolve().parent / "ocr_prototype"
app.mount("/ocr-probe-assets", StaticFiles(directory=OCR_PROBE_DIR), name="ocr-probe-assets")

@app.get("/ocr-probe", include_in_schema=False)
async def ocr_probe():
    return FileResponse(OCR_PROBE_DIR / "index.html", media_type="text/html")
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="theme-color" content="#121316">
    <link rel="manifest" href="/manifest.json">
    <title>AudioReader AI</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #121316; --surface: #1e2025; --surface-light: #2a2d35;
            --primary: #3b82f6; --text: #f3f4f6; --text-muted: #9ca3af;
            --ocr-ready: #a6edc0; --ocr-action: #1d4ed8;
            --highlight-bg: #78350f; --highlight-border: #f59e0b;
        }
        body.light {
            --bg: #f3f4f6; --surface: #ffffff; --surface-light: #e5e7eb;
            --primary: #2563eb; --text: #111827; --text-muted: #6b7280;
            --ocr-ready: #166534; --ocr-action: #1d4ed8;
            --highlight-bg: #fef3c7; --highlight-border: #f59e0b;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg); color: var(--text);
            margin: 0; padding: max(10px, env(safe-area-inset-top)) 12px max(10px, env(safe-area-inset-bottom));
            height: 100dvh; min-height: 100dvh;
            display: flex; flex-direction: column; gap: 9px; overflow: hidden;
        }
        .header { position: relative; display: flex; justify-content: space-between; align-items: center; min-height: 38px; flex: 0 0 auto; }
        .logo { display: flex; align-items: center; gap: 8px; min-width: 0; white-space: nowrap; font-size: clamp(1rem, 4vw, 1.2rem); font-weight: 700; }
        .logo span { color: var(--primary); font-size: 1.25rem; }
        .header-actions { display: flex; gap: 8px; }
        .btn-tonal {
            background: var(--surface-light); color: var(--text);
            border: none; padding: 8px 14px; border-radius: 20px;
            font-weight: 600; font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; gap: 6px;
        }
        .tabs { display: flex; gap: 8px; flex: 0 0 auto; }
        .tab-btn {
            flex: 1; min-width: 0; min-height: 44px; padding: 9px 12px; border-radius: 20px; border: none;
            background: var(--surface); color: var(--text-muted);
            font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: 0.2s;
        }
        .tab-btn.active { background: var(--primary); color: white; }
        .view-box {
            flex: 1; min-height: 0; min-width: 0; background: var(--surface); border-radius: 16px;
            padding: 12px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px;
        }
        .app-views { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; }
        #readerView { overflow: hidden; }
        .reader-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
        #sentenceList { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
        .history-scroll { min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; overscroll-behavior: contain; }
        #historyView { overflow: hidden; }
        .history-scroll { flex: 1 1 auto; }
        #calendarView[hidden] { display: none; }
        .reader-toolbar { display: flex; flex-direction: column; align-items: stretch; gap: 6px; flex: 0 0 auto; min-width: 0; }
        .doc-title { width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .88rem; font-weight: 600; }
        .reader-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
        .add-content-btn, .resume-actions button, .library-entry button, .history-entry button, .history-toolbar button {
            min-height: 44px; border: 0; border-radius: 12px; padding: 9px 12px; color: var(--text);
            background: var(--surface-light); font: inherit; font-weight: 600; cursor: pointer;
        }
        .add-content-btn { background: var(--primary); color: white; white-space: nowrap; }
        .resume-panel { flex: 0 0 auto; width: fit-content; max-width: 100%; padding: 0; background: none; border: 0; }
        .resume-copy, .resume-note { display: none; }
        .resume-actions { display: flex; }
        .resume-actions button.primary { background: var(--surface-light); color: var(--text); }
        .resume-status { min-width: 0; font-size: .76rem; color: var(--text-muted); overflow-wrap: anywhere; }
        .reader-empty { display: flex; flex: 1; min-height: 160px; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 18px; color: var(--text-muted); text-align: center; }
        .reader-empty[hidden], .document-title[hidden] { display: none; }
        .import-status { min-height: 0; color: var(--text-muted); font-size: .82rem; overflow-wrap: anywhere; }
        .import-status:empty { display: none; }
        .sentence {
            padding: 12px 14px; border-radius: 12px; font-size: 1.02rem; line-height: 1.5;
            cursor: pointer; transition: 0.15s; border: 1px solid transparent; overflow-wrap: anywhere;
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
            box-shadow: 0 8px 20px rgba(0,0,0,0.25); flex: 0 0 auto;
        }
        .progress-bg { height: 5px; background: var(--surface-light); border-radius: 3px; overflow: hidden; }
        .progress-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.2s; }
        .status { text-align: center; font-size: 0.8rem; color: var(--text-muted); }
        .controls-row { display: flex; justify-content: center; align-items: center; gap: 22px; }
        .icon-btn {
            background: none; border: none; color: var(--text); font-size: 1.5rem;
            cursor: pointer; padding: 8px; min-width: 44px; min-height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
        .play-btn {
            background: var(--primary); color: white; width: 60px; height: 60px;
            font-size: 1.6rem; box-shadow: 0 4px 12px rgba(59,130,246,0.4);
        }
        .settings-row { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; }
        select {
            background: var(--surface-light); color: var(--text); border: none;
            padding: 8px 12px; border-radius: 10px; font-weight: 500; outline: none;
        }
        input[type="range"] { flex: 1; accent-color: var(--primary); }
        .resume-panel[hidden] { display: none; }
        .resume-actions { display: flex; gap: 6px; }
        .resume-actions button[hidden] { display: none; }
        .history-toolbar, .history-nav, .history-entry, .library-entry { display: flex; align-items: center; gap: 8px; }
        .history-toolbar, .history-nav { justify-content: space-between; }
        .history-subnav { display: flex; gap: 8px; }
        .history-subnav button { flex: 1; min-height: 44px; border: 0; border-radius: 12px; color: var(--text-muted); background: var(--bg); font: inherit; font-weight: 600; }
        .history-subnav button.active { color: white; background: var(--primary); }
        .history-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; width: 100%; }
        .history-grid button, .history-nav button {
            min-height: 44px; border: 0; border-radius: 10px; padding: 8px; color: var(--text);
            background: var(--surface-light); font: inherit; cursor: pointer;
        }
        .history-grid .history-weekday { min-height: 28px; display: grid; place-items: center; padding: 3px 0; background: transparent; color: var(--text-muted); font-size: .72rem; }
        .history-grid button.has-sessions { outline: 2px solid var(--primary); }
        .history-grid button.selected { background: var(--primary); color: white; }
        .history-grid button.empty { visibility: hidden; }
        .history-list, .library-list { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
        .library-list[hidden], #calendarView[hidden] { display: none; }
        .history-entry, .library-entry { justify-content: space-between; background: var(--bg); border-radius: 10px; padding: 8px; }
        .history-entry-copy, .library-entry-copy { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 3px; }
        .history-entry-title, .library-entry-title { display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; font-weight: 600; }
        .history-entry-meta, .library-entry-meta { color: var(--text-muted); font-size: .75rem; overflow-wrap: anywhere; }
        .history-entry button, .library-entry button { flex: 0 0 auto; }
        .history-empty { color: var(--text-muted); text-align: center; padding: 20px 8px; }
        .settings-panel { position: absolute; z-index: 5; top: calc(100% + 8px); right: 0; width: min(300px, calc(100vw - 24px)); padding: 14px; border: 1px solid var(--surface-light); border-radius: 14px; background: var(--surface); box-shadow: 0 8px 28px rgba(0,0,0,.32); }
        .settings-panel[hidden] { display: none; }
        .settings-panel p { margin: 10px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.45; }
        .settings-panel button { min-height: 44px; width: 100%; border: 0; border-radius: 10px; color: var(--text); background: var(--surface-light); font: inherit; font-weight: 600; }
        .settings-btn { width: 44px; height: 44px; border: 0; border-radius: 50%; color: var(--text); background: var(--surface-light); font-size: 1.15rem; cursor: pointer; }
        .add-content-dialog { width: min(100%, 560px); max-height: min(90dvh, 760px); margin: auto; padding: 0; border: 1px solid var(--surface-light); border-radius: 20px; color: var(--text); background: var(--surface); box-shadow: 0 16px 50px rgba(0,0,0,.4); overflow: auto; }
        .add-content-dialog::backdrop { background: rgba(0,0,0,.62); }
        .sheet-content { display: flex; flex-direction: column; gap: 14px; padding: 18px; }
        .sheet-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .sheet-heading h2 { margin: 0; font-size: 1.05rem; }
        .sheet-close { width: 44px; height: 44px; border: 0; border-radius: 50%; color: var(--text); background: var(--surface-light); font-size: 1.2rem; }
        .import-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
        .import-options button { min-height: 64px; border: 1px solid var(--surface-light); border-radius: 14px; color: var(--text); background: var(--bg); font: inherit; font-weight: 600; }
        .text-import-form[hidden] { display: none; }
        .text-import-form { display: flex; min-height: min(45dvh, 340px); flex-direction: column; gap: 10px; }
        .text-import-form textarea { min-height: 150px; }
        .ocr-import[hidden], .ocr-import textarea[hidden], .ocr-import canvas[hidden], .ocr-import progress[hidden], .ocr-crop-stage[hidden], .ocr-crop-actions[hidden], .ocr-crop-hint[hidden], .ocr-crop-selection[hidden], .ocr-import button[hidden], .ocr-import label[hidden] { display: none; }
        .ocr-import { display: flex; flex-direction: column; gap: 10px; }
        .ocr-choices { display: flex; flex-wrap: wrap; gap: 8px; }
        .ocr-choices button, .ocr-actions button, .ocr-crop-actions button, #ocrExpand { min-height: 44px; border: 0; border-radius: 12px; padding: 9px 12px; color: var(--text); background: var(--surface-light); font: inherit; font-weight: 600; }
        .ocr-choices button { flex: 1 1 145px; }
        .ocr-crop-stage { width: 100%; max-height: min(48dvh, 500px); overflow: auto; overscroll-behavior: contain; padding: 6px 14px 6px 6px; border-radius: 10px; background: var(--bg); }
        .ocr-crop-surface { position: relative; width: 100%; overflow: hidden; }
        .ocr-crop-surface.is-applied { overflow: visible; }
        .ocr-crop-surface canvas { display: block; width: 100%; height: auto; background: white; }
        .ocr-crop-surface #ocrAppliedPreview { width: max(100%, var(--ocr-applied-min-width, 0px)); max-width: none; }
        .ocr-crop-selection { position: absolute; border: 2px solid var(--highlight-border); box-shadow: 0 0 0 3000px rgba(0,0,0,.38); pointer-events: none; }
        .ocr-crop-selection button { position: absolute; z-index: 1; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: transparent; pointer-events: auto; touch-action: none; }
        .ocr-crop-selection button::after { content: ''; display: block; width: 14px; height: 14px; margin: auto; border-radius: 50%; border: 2px solid white; background: var(--highlight-border); box-shadow: 0 1px 5px #000; }
        .ocr-crop-selection button[data-crop-handle="move"] { left: 50%; top: 50%; width: 72px; border-radius: 22px; background: var(--primary); color: white; font-size: .78rem; font-weight: 700; transform: translate(-50%,-50%); }
        .ocr-crop-selection button[data-crop-handle="move"]::after { display: none; }
        .ocr-crop-selection button[data-crop-handle="nw"] { left: 0; top: 0; }
        .ocr-crop-selection button[data-crop-handle="n"] { left: 50%; top: 0; transform: translateX(-50%); }
        .ocr-crop-selection button[data-crop-handle="ne"] { right: 0; top: 0; }
        .ocr-crop-selection button[data-crop-handle="e"] { right: 0; top: 50%; transform: translateY(-50%); }
        .ocr-crop-selection button[data-crop-handle="se"] { right: 0; bottom: 0; }
        .ocr-crop-selection button[data-crop-handle="s"] { left: 50%; bottom: 0; transform: translateX(-50%); }
        .ocr-crop-selection button[data-crop-handle="sw"] { left: 0; bottom: 0; }
        .ocr-crop-selection button[data-crop-handle="w"] { left: 0; top: 50%; transform: translateY(-50%); }
        .ocr-crop-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .ocr-crop-actions button { flex: 1 1 145px; }
        .ocr-crop-hint { color: var(--text-muted); font-size: .76rem; line-height: 1.4; }
        #ocrCropTitle { color: var(--text); font-size: .95rem; }
        #ocrCropTitle.is-applied { color: var(--ocr-ready); }
        #ocrStatus { color: var(--text); }
        #ocrRun:not(:disabled) { color: white; background: var(--ocr-action); }
        .ocr-import progress { width: 100%; accent-color: var(--primary); }
        .ocr-import textarea { flex: none; min-height: 170px; resize: vertical; }
        #ocrExpand { width: 100%; }
        .ocr-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .ocr-actions button { flex: 1 1 140px; }
        .ocr-actions .apply-btn { margin-top: 0; color: white; background: var(--primary); }
        .ocr-import button:disabled { opacity: .55; }
        .add-content-dialog.ocr-editor-expanded { position: fixed; inset: var(--ocr-viewport-top, 0px) 0 auto; width: min(100%, 760px); max-width: none; height: var(--ocr-viewport-height, 100dvh); max-height: none; margin: 0 auto; border-radius: 0; overflow: hidden; }
        .add-content-dialog.ocr-editor-expanded .sheet-content { height: 100%; min-height: 0; overflow: hidden; padding-top: max(12px, env(safe-area-inset-top)); padding-bottom: max(12px, env(safe-area-inset-bottom)); }
        .add-content-dialog.ocr-editor-expanded .import-options, .add-content-dialog.ocr-editor-expanded .ocr-choices, .add-content-dialog.ocr-editor-expanded .ocr-crop-stage, .add-content-dialog.ocr-editor-expanded .ocr-crop-actions, .add-content-dialog.ocr-editor-expanded .ocr-crop-hint, .add-content-dialog.ocr-editor-expanded .ocr-actions, .add-content-dialog.ocr-editor-expanded #ocrProgress, .add-content-dialog.ocr-editor-expanded #importStatus { display: none; }
        .add-content-dialog.ocr-editor-expanded .ocr-import { flex: 1; min-height: 0; overflow: hidden; }
        .add-content-dialog.ocr-editor-expanded #ocrText { flex: 1; min-height: 0; overflow: auto; resize: none; }
        .add-content-dialog.ocr-editor-expanded #ocrApply { flex: 0 0 auto; position: sticky; bottom: 0; margin-top: 0; }
        .scan-import[hidden], .scan-import [hidden] { display: none; }
        .scan-import { display: flex; flex-direction: column; gap: 12px; }
        .scan-import button { min-height: 44px; border: 0; border-radius: 12px; padding: 9px 12px; color: var(--text); background: var(--surface-light); font: inherit; font-weight: 600; }
        .scan-import button:disabled { opacity: .55; }
        .scan-actions, .scan-page-actions, .scan-crop-actions, .scan-editor-nav { display: flex; flex-wrap: wrap; gap: 8px; }
        .scan-actions button, .scan-crop-actions button, .scan-editor-nav button { flex: 1 1 140px; }
        .scan-pages { display: flex; flex-direction: column; gap: 8px; }
        .scan-page { display: flex; gap: 10px; align-items: flex-start; padding: 9px; border: 1px solid var(--surface-light); border-radius: 12px; }
        .scan-page img { width: 64px; height: 82px; object-fit: contain; flex: 0 0 auto; background: white; border-radius: 6px; }
        .scan-page-details { min-width: 0; flex: 1; }
        .scan-page-details strong, .scan-page-details small { display: block; }
        .scan-page-details small { color: var(--text-muted); margin: 3px 0 8px; }
        .scan-page-actions button { min-height: 40px; flex: 1 1 74px; font-size: .82rem; }
        .scan-crop-stage { max-height: min(48dvh, 500px); overflow: auto; padding: 6px 14px 6px 6px; border-radius: 10px; background: var(--bg); }
        .scan-crop-surface { position: relative; width: 100%; overflow: hidden; }
        .scan-crop-surface.is-applied { overflow: visible; }
        .scan-crop-surface canvas { display: block; width: 100%; height: auto; background: white; }
        .scan-crop-surface #scanAppliedPreview { width: max(100%, var(--scan-applied-min-width, 0px)); max-width: none; }
        .scan-crop-selection { position: absolute; border: 2px solid var(--highlight-border); box-shadow: 0 0 0 3000px rgba(0,0,0,.38); pointer-events: none; }
        .scan-crop-selection button { position: absolute; z-index: 1; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: transparent; pointer-events: auto; touch-action: none; }
        .scan-crop-selection button::after { content: ''; display: block; width: 14px; height: 14px; margin: auto; border-radius: 50%; border: 2px solid white; background: var(--highlight-border); box-shadow: 0 1px 5px #000; }
        .scan-crop-selection button[data-scan-handle="move"] { left: 50%; top: 50%; width: 72px; border-radius: 22px; background: var(--primary); color: white; font-size: .78rem; font-weight: 700; transform: translate(-50%,-50%); }
        .scan-crop-selection button[data-scan-handle="move"]::after { display: none; }
        .scan-crop-selection button[data-scan-handle="nw"] { left: 0; top: 0; }
        .scan-crop-selection button[data-scan-handle="n"] { left: 50%; top: 0; transform: translateX(-50%); }
        .scan-crop-selection button[data-scan-handle="ne"] { right: 0; top: 0; }
        .scan-crop-selection button[data-scan-handle="e"] { right: 0; top: 50%; transform: translateY(-50%); }
        .scan-crop-selection button[data-scan-handle="se"] { right: 0; bottom: 0; }
        .scan-crop-selection button[data-scan-handle="s"] { left: 50%; bottom: 0; transform: translateX(-50%); }
        .scan-crop-selection button[data-scan-handle="sw"] { left: 0; bottom: 0; }
        .scan-crop-selection button[data-scan-handle="w"] { left: 0; top: 50%; transform: translateY(-50%); }
        .scan-editor-view { display: flex; flex-direction: column; gap: 10px; }
        #scanEditorText { min-height: min(45dvh, 360px); width: 100%; resize: vertical; }
        .scan-import progress { width: 100%; accent-color: var(--primary); }
        .scan-import #scanRecognize:not(:disabled), .scan-import #scanRead:not(:disabled) { color: white; background: var(--ocr-action); }
        .scan-import #scanCropTitle.is-applied { color: var(--ocr-ready); }
        .scan-import #scanDocumentName { width: 100%; }
        .scan-note { color: var(--text-muted); font-size: .76rem; line-height: 1.4; }
        .add-content-dialog.scan-editor-expanded { position: fixed; inset: var(--ocr-viewport-top, 0px) 0 auto; width: min(100%, 760px); max-width: none; height: var(--ocr-viewport-height, 100dvh); max-height: none; margin: 0 auto; border-radius: 0; overflow: hidden; }
        .add-content-dialog.scan-editor-expanded .sheet-content { height: 100%; min-height: 0; overflow: hidden; padding-top: max(12px, env(safe-area-inset-top)); padding-bottom: max(12px, env(safe-area-inset-bottom)); }
        .add-content-dialog.scan-editor-expanded .import-options, .add-content-dialog.scan-editor-expanded .scan-main, .add-content-dialog.scan-editor-expanded #importStatus { display: none; }
        .add-content-dialog.scan-editor-expanded .scan-import, .add-content-dialog.scan-editor-expanded .scan-editor-view { flex: 1; min-height: 0; overflow: hidden; }
        .add-content-dialog.scan-editor-expanded #scanEditorText { flex: 1; min-height: 0; overflow: auto; resize: none; }
        .mini-player { display: flex; align-items: center; gap: 10px; min-height: 58px; flex: 0 0 auto; padding: 7px 10px; border: 1px solid var(--surface-light); border-radius: 16px; background: var(--surface); }
        .mini-player[hidden] { display: none; }
        .mini-player-main { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 2px; cursor: pointer; }
        .mini-player-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; font-weight: 600; }
        .mini-player-status { color: var(--text-muted); font-size: .72rem; }
        .mini-player button { width: 44px; height: 44px; flex: 0 0 auto; border: 0; border-radius: 50%; color: white; background: var(--primary); font-size: 1.15rem; }
        body.history-active .player-card { display: none; }
        body.history-active .mini-player[hidden] { display: none; }
        body.modal-open .player-card, body.modal-open .mini-player { display: none; }
        body.keyboard-open .player-card { display: none; }
        @media (max-width: 600px) {
            .add-content-dialog { position: fixed; inset: auto 0 0; width: 100%; max-width: none; max-height: min(88dvh, 760px); margin: 0; border-radius: 20px 20px 0 0; }
            .sheet-content { padding-bottom: max(18px, env(safe-area-inset-bottom)); }
        }
        @media (max-width: 480px) {
            .import-options { grid-template-columns: 1fr; gap: 6px; }
            .import-options button { min-height: 48px; }
            .history-toolbar { align-items: stretch; flex-direction: column; }
            .history-subnav { width: 100%; }
            .history-subnav button { flex: 1 1 0; white-space: nowrap; }
        }
        @media (max-width: 360px) {
            body { padding-left: 9px; padding-right: 9px; gap: 7px; }
            .view-box { padding: 9px; }
            .history-entry, .library-entry { gap: 6px; padding: 7px; }
            .history-entry button, .library-entry button { padding-left: 9px; padding-right: 9px; }
        }
        @media (max-height: 520px) and (orientation: landscape) {
            body { gap: 5px; padding-top: max(5px, env(safe-area-inset-top)); }
            .header { min-height: 32px; }
            .tabs .tab-btn { min-height: 44px; padding-top: 6px; padding-bottom: 6px; }
            .player-card { gap: 5px; padding: 7px 10px; border-radius: 14px; }
            .controls-row { gap: 12px; }
            .icon-btn { min-height: 44px; }
            .play-btn { width: 46px; height: 46px; }
            .settings-row { gap: 6px; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
        }
    </style>
</head>
<body>

    <div class="header">
        <div class="logo"><span>ılılı</span> AudioReader AI</div>
        <div class="header-actions">
            <button class="settings-btn" id="settingsToggle" aria-label="Ustawienia" aria-expanded="false" onclick="window.toggleSettings()">⚙</button>
        </div>
        <section class="settings-panel" id="settingsPanel" aria-label="Ustawienia aplikacji" hidden>
            <button id="themeToggle" onclick="document.body.classList.toggle('light'); window.saveThemePreference()">☀️ / 🌙 Zmień motyw</button>
            <p>Motyw i dokumenty są zapisywane lokalnie w tej przeglądarce.</p>
        </section>
    </div>

    <input type="file" id="fileInput" accept=".txt,.pdf,.docx" hidden>
    <input type="file" id="ocrCameraInput" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
    <input type="file" id="ocrGalleryInput" accept="image/jpeg,image/png,image/webp" hidden>
    <nav class="tabs" aria-label="Główna nawigacja">
        <button class="tab-btn active" id="tabReader" aria-current="page" onclick="window.switchTab('reader')">🎧 Lektor</button>
        <button class="tab-btn" id="tabHistory" onclick="window.switchTab('history')">📅 Historia</button>
    </nav>

    <main class="app-views">
      <section class="view-box" id="readerView" aria-label="Lektor">
        <div class="reader-toolbar">
            <div class="doc-title" id="documentTitle" hidden title=""></div>
            <div class="reader-actions">
                <div class="resume-panel" id="resumePanel" aria-live="polite" hidden>
                    <span class="resume-copy"><span class="resume-title" id="resumeTitle">Zapis lokalny</span><span class="resume-name" id="resumeName"></span><span class="resume-note" id="resumeNote">Tekst jest zapamiętywany lokalnie w tej przeglądarce. Chrome i Edge nie współdzielą zapisu.</span></span>
                    <div class="resume-actions"><button class="primary" id="resumeContinue" onclick="window.continueSavedDocument()" hidden>Kontynuuj</button><span class="resume-status" id="resumeDelete" hidden></span></div>
                </div>
                <button class="add-content-btn" id="addContentButton" onclick="window.openAddContentDialog()">＋ Dodaj treść</button>
            </div>
        </div>
        <div class="reader-scroll" id="readerScroll">
          <div class="reader-empty" id="readerEmpty">
              <span>Dodaj dokument lub wklej tekst, aby rozpocząć słuchanie.</span>
          </div>
          <div id="sentenceList"></div>
        </div>
      </section>

      <section class="view-box" id="historyView" aria-label="Historia odsłuchów" style="display:none;">
        <div class="history-toolbar"><strong id="historyHeading">Historia odsłuchów</strong><div class="history-subnav" role="tablist" aria-label="Widok historii"><button id="calendarToggle" class="active" role="tab" aria-selected="true" onclick="window.toggleLibraryView(false)">Kalendarz</button><button id="libraryToggle" role="tab" aria-selected="false" onclick="window.toggleLibraryView(true)">Dokumenty</button></div></div>
        <div class="history-scroll" id="historyScroll">
        <div id="calendarView">
            <div class="history-nav"><button id="historyPrev" aria-label="Poprzedni miesiąc">‹</button><strong id="historyMonth"></strong><button id="historyNext" aria-label="Następny miesiąc">›</button></div>
            <div class="history-grid" id="historyGrid"></div>
            <div class="history-list" id="historyList"></div>
        </div>
        <div class="library-list" id="libraryList" hidden></div>
        <small class="resume-note">Biblioteka mieści do 10 dokumentów. Historia obejmuje rzeczywiste sesje odtwarzania w tej przeglądarce.</small>
        </div>
      </section>
    </main>

    <dialog class="add-content-dialog" id="addContentDialog" aria-labelledby="addContentTitle">
        <div class="sheet-content">
            <div class="sheet-heading"><h2 id="addContentTitle">Dodaj treść</h2><button class="sheet-close" aria-label="Zamknij" onclick="window.closeAddContentDialog()">×</button></div>
            <div class="import-options"><button id="chooseFileImport" onclick="window.chooseFileImport()">📂 Wybierz PDF, DOCX lub TXT</button><button id="chooseTextImport" onclick="window.showTextImport()">📝 Wklej tekst</button><button id="choosePhotoImport" onclick="window.showPhotoImport()">📷 Zdjęcie</button><button id="chooseScanImport" onclick="window.showDocumentScanner()">📄 Skanuj dokument</button></div>
            <form class="text-import-form" id="textImportForm" hidden onsubmit="event.preventDefault(); window.applyText()">
                <label for="rawText">Tekst do przeczytania</label>
                <textarea id="rawText" placeholder="Wklej tutaj dowolny tekst do przeczytania..."></textarea>
                <button class="apply-btn" type="submit">✔️ Czytaj tekst</button>
            </form>
            <section class="ocr-import" id="ocrImport" aria-label="Rozpoznawanie tekstu ze zdjęcia" hidden>
                <div class="ocr-choices"><button type="button" id="ocrCameraButton" onclick="window.chooseOcrPhoto('camera')">Zrób zdjęcie</button><button type="button" id="ocrGalleryButton" onclick="window.chooseOcrPhoto('gallery')">Wybierz z galerii</button></div>
                <strong class="ocr-crop-hint" id="ocrCropTitle" hidden>Przytnij zdjęcie (opcjonalnie)</strong>
                <div class="ocr-crop-stage" id="ocrCropStage" hidden>
                    <div class="ocr-crop-surface" id="ocrCropSurface">
                        <canvas id="ocrPreview" aria-label="Podgląd wybranego zdjęcia" hidden></canvas>
                        <canvas id="ocrAppliedPreview" aria-label="Podgląd zastosowanego kadru" hidden></canvas>
                        <div class="ocr-crop-selection" id="ocrCropSelection" aria-label="Zaznaczony kadr">
                            <button type="button" data-crop-handle="nw" aria-label="Zmień lewy górny róg kadru"></button>
                            <button type="button" data-crop-handle="n" aria-label="Zmień górną krawędź kadru"></button>
                            <button type="button" data-crop-handle="ne" aria-label="Zmień prawy górny róg kadru"></button>
                            <button type="button" data-crop-handle="e" aria-label="Zmień prawą krawędź kadru"></button>
                            <button type="button" data-crop-handle="se" aria-label="Zmień prawy dolny róg kadru"></button>
                            <button type="button" data-crop-handle="s" aria-label="Zmień dolną krawędź kadru"></button>
                            <button type="button" data-crop-handle="sw" aria-label="Zmień lewy dolny róg kadru"></button>
                            <button type="button" data-crop-handle="w" aria-label="Zmień lewą krawędź kadru"></button>
                            <button type="button" data-crop-handle="move" aria-label="Przesuń kadr">Przesuń</button>
                        </div>
                    </div>
                </div>
                <div class="ocr-crop-actions" id="ocrCropActions" hidden><button type="button" id="ocrApplyCrop" onclick="window.applyOcrCrop()" disabled>Zastosuj kadr</button><button type="button" id="ocrChangeCrop" onclick="window.changeOcrCrop()" hidden>Zmień kadr</button><button type="button" id="ocrResetCrop" onclick="window.resetOcrCrop()" disabled>Całe zdjęcie</button></div>
                <small class="ocr-crop-hint" id="ocrCropHint" hidden>Przesuń kadr środkowym uchwytem albo zmień jego krawędzie. Długi obraz przewijaj poza uchwytami. Wybierz „Całe zdjęcie”, aby pominąć kadrowanie.</small>
                <div class="import-status" id="ocrStatus" role="status" aria-live="polite">Wybierz jedno zdjęcie. Rozpoznawanie odbywa się na telefonie.</div>
                <progress id="ocrProgress" max="100" value="0" aria-label="Postęp rozpoznawania" hidden></progress>
                <div class="ocr-actions"><button type="button" id="ocrRun" onclick="window.runOcr()" disabled>Rozpoznaj tekst</button><button type="button" id="ocrCancel" onclick="window.cancelOcrRecognition()" disabled>Anuluj</button></div>
                <label for="ocrText" id="ocrTextLabel" hidden>Popraw rozpoznany tekst</label>
                <button type="button" id="ocrExpand" aria-expanded="false" onclick="window.toggleOcrEditor()" hidden>Rozwiń edytor</button>
                <textarea id="ocrText" aria-labelledby="ocrTextLabel" spellcheck="true" hidden></textarea>
                <button class="apply-btn" type="button" id="ocrApply" onclick="window.applyOcrText()" hidden>✔️ Czytaj tekst</button>
            </section>
            <section class="scan-import" id="scanImport" aria-label="Skanowanie dokumentu" hidden>
                <div class="scan-main">
                    <div class="scan-actions"><button type="button" id="scanCameraButton" onclick="window.chooseScanPhoto('camera')">Zrób zdjęcie strony</button><button type="button" id="scanGalleryButton" onclick="window.chooseScanPhoto('gallery')">Dodaj strony z galerii</button></div>
                    <input type="file" id="scanCameraInput" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
                    <input type="file" id="scanGalleryInput" accept="image/jpeg,image/png,image/webp" multiple hidden>
                    <strong id="scanCount">0 stron</strong>
                    <div class="scan-pages" id="scanPages" aria-label="Strony dokumentu"></div>
                    <div id="scanPageView" hidden>
                        <strong id="scanCropTitle">Przytnij stronę (opcjonalnie)</strong>
                        <div class="scan-crop-stage" id="scanCropStage">
                            <div class="scan-crop-surface" id="scanCropSurface">
                                <canvas id="scanPreview" aria-label="Podgląd strony"></canvas>
                                <canvas id="scanAppliedPreview" aria-label="Podgląd zastosowanego kadru" hidden></canvas>
                                <div class="scan-crop-selection" id="scanCropSelection" aria-label="Zaznaczony kadr strony">
                                    <button type="button" data-scan-handle="nw" aria-label="Zmień lewy górny róg kadru"></button><button type="button" data-scan-handle="n" aria-label="Zmień górną krawędź kadru"></button><button type="button" data-scan-handle="ne" aria-label="Zmień prawy górny róg kadru"></button><button type="button" data-scan-handle="e" aria-label="Zmień prawą krawędź kadru"></button><button type="button" data-scan-handle="se" aria-label="Zmień prawy dolny róg kadru"></button><button type="button" data-scan-handle="s" aria-label="Zmień dolną krawędź kadru"></button><button type="button" data-scan-handle="sw" aria-label="Zmień lewy dolny róg kadru"></button><button type="button" data-scan-handle="w" aria-label="Zmień lewą krawędź kadru"></button><button type="button" data-scan-handle="move" aria-label="Przesuń kadr">Przesuń</button>
                                </div>
                            </div>
                        </div>
                        <div class="scan-crop-actions"><button type="button" id="scanApplyCrop" onclick="window.applyScanCrop()">Zastosuj kadr</button><button type="button" id="scanChangeCrop" onclick="window.changeScanCrop()" hidden>Zmień kadr</button><button type="button" id="scanWholePhoto" onclick="window.resetScanCrop()">Całe zdjęcie</button><button type="button" id="scanClosePage" onclick="window.closeScanPage()">Wróć do stron</button></div>
                    </div>
                    <div id="scanStatus" class="import-status" role="status" aria-live="polite">Dodaj pierwszą stronę. Zdjęcia pozostają tylko w pamięci do zamknięcia skanu.</div>
                    <progress id="scanProgress" max="100" value="0" aria-label="Postęp rozpoznawania" hidden></progress>
                    <div class="scan-actions"><button type="button" id="scanRecognize" onclick="window.recognizeScanPages()" disabled>Rozpoznaj wszystkie strony</button><button type="button" id="scanCancel" onclick="window.cancelScanRecognition()" disabled>Anuluj OCR</button></div>
                    <label for="scanDocumentName">Nazwa dokumentu</label><input id="scanDocumentName" value="Skan dokumentu" maxlength="120">
                    <button type="button" id="scanRead" onclick="window.readScanDocument()" disabled>Czytaj dokument</button>
                    <small class="scan-note">Skan jest tymczasowy. Odświeżenie lub zamknięcie strony usunie zdjęcia i niezapisane poprawki.</small>
                </div>
                <div class="scan-editor-view" id="scanEditorView" hidden>
                    <strong id="scanEditorPage">Strona 1 z 1</strong>
                    <div class="scan-editor-nav"><button type="button" id="scanPreviousPage" onclick="window.navigateScanEditor(-1)">Poprzednia</button><button type="button" id="scanNextPage" onclick="window.navigateScanEditor(1)">Następna</button></div>
                    <label for="scanEditorText">Popraw tekst strony</label><textarea id="scanEditorText" spellcheck="true"></textarea>
                    <button type="button" id="scanEditorDone" onclick="window.closeScanEditor()">Wróć do stron</button>
                </div>
            </section>
            <div class="import-status" id="importStatus" role="status" aria-live="polite"></div>
        </div>
    </dialog>

    <div class="mini-player" id="miniPlayer" hidden>
        <div class="mini-player-main" role="button" tabindex="0" aria-label="Wróć do lektora" onclick="window.switchTab('reader')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.switchTab('reader')}"><span class="mini-player-title" id="miniPlayerTitle"></span><span class="mini-player-status" id="miniPlayerStatus">Gotowy</span></div>
        <button id="miniPlayBtn" aria-label="Odtwórz lub wstrzymaj" onclick="window.togglePlay()">▶</button>
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

<script src="/ocr-probe-assets/app-ocr.js"></script>
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
    let continuousPlayback = null;
    const STREAM_MIME = 'audio/mpeg';
    const STREAM_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
    const STREAM_RETAIN_SECONDS = 30;
    const mediaSession = typeof navigator !== 'undefined' && navigator.mediaSession ? navigator.mediaSession : null;
    let ttsNotBefore = 0;
    let ttsAttempt = 1;
    const RESUME_DB_NAME = 'AudioReaderAI';
    const RESUME_DB_VERSION = 2;
    const RESUME_STORE = 'documents';
    const SESSION_STORE = 'sessions';
    const RESUME_KEY = 'last';
    const MAX_LIBRARY_DOCUMENTS = 10;
    const MAX_HISTORY_SESSIONS = 500;
    const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
    const SESSION_GROUP_MS = 30 * 60 * 1000;
    const SEGMENTATION_VERSION = 1;
    const RESUME_SAVE_INTERVAL_MS = 10000;
    let resumeDbPromise = null;
    let resumeWriteQueue = Promise.resolve();
    let resumeDocumentRevision = 0;
    let resumeUserAction = 0;
    let librarySelectionRevision = 0;
    let lastProgressSaveAt = 0;
    let lastProgressSavedIndex = null;
    let resumeWriteSequence = 0;
    let lastDocumentUseStamp = 0;
    let resumeStoredRecord = null;
    let currentDocument = null;
    let resumeSavingEnabled = true;
    const deletedDocumentIds = new Set();
    let activeListeningSession = null;
    let historyMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    let selectedHistoryDay = dateKey(new Date());
    let showingLibrary = false;
    let activeTab = 'reader';
    let historyDocuments = [];
    let historySessions = [];
    let dialogReturnFocus = null;

    window.toggleSettings = function(force) {
        const panel = document.getElementById('settingsPanel');
        const button = document.getElementById('settingsToggle');
        const open = typeof force === 'boolean' ? force : panel.hidden;
        panel.hidden = !open;
        button.setAttribute?.('aria-expanded', String(open));
    };

    window.saveThemePreference = function() {
        try { localStorage.setItem('audioReaderTheme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch {}
    };

    try { if (localStorage.getItem('audioReaderTheme') === 'light') document.body.classList.add('light'); } catch {}

    function setImportStatus(message) {
        const status = document.getElementById('importStatus');
        if (status) status.textContent = message;
    }

    const ocrImport = typeof window.createOcrImport === 'function' ? window.createOcrImport({
        getAction: () => resumeUserAction,
        nextAction: () => ++resumeUserAction,
        getRevision: () => resumeDocumentRevision,
        commitText: text => {
            resumeUserAction++;
            renderSentences(text, [], {name: 'Tekst ze zdjęcia'});
            window.closeAddContentDialog();
            window.switchTab('reader');
        }
    }) : {reset() {}, active() { return false; }};
    if (typeof window.showPhotoImport !== 'function')
        window.showPhotoImport = () => setImportStatus('OCR jest chwilowo niedostępny. Wybierz plik lub wklej tekst.');
    const scanner = typeof window.createDocumentScanner === 'function' ? window.createDocumentScanner({
        getAction: () => resumeUserAction,
        nextAction: () => ++resumeUserAction,
        getRevision: () => resumeDocumentRevision,
        resetPhotoImport: () => ocrImport.reset(),
        commitText: (text, name) => {
            resumeUserAction++;
            renderSentences(text, [], {name});
            window.closeAddContentDialog();
            window.switchTab('reader');
        }
    }) : {reset() {}, confirmLeave() { return true; }, active() { return false; }};
    if (typeof window.showDocumentScanner !== 'function')
        window.showDocumentScanner = () => setImportStatus('Skanowanie jest chwilowo niedostępne. Wybierz plik lub wklej tekst.');
    const showSinglePhotoImport = window.showPhotoImport;
    window.showPhotoImport = function() {
        if (!scanner.confirmLeave()) return;
        scanner.reset();
        showSinglePhotoImport();
    };

    window.openAddContentDialog = function() {
        if (!scanner.confirmLeave()) return;
        const dialog = document.getElementById('addContentDialog');
        dialogReturnFocus = document.activeElement;
        document.getElementById('textImportForm').hidden = true;
        ocrImport.reset();
        scanner.reset();
        setImportStatus('');
        document.body.classList.add('modal-open');
        dialog.hidden = false;
        if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
        else { dialog.open = true; dialog.hidden = false; }
        document.getElementById('chooseFileImport').focus?.();
    };

    window.closeAddContentDialog = function() {
        if (!scanner.confirmLeave()) return false;
        scanner.reset();
        ocrImport.reset();
        const dialog = document.getElementById('addContentDialog');
        const nativeDialog = typeof dialog.showModal === 'function' && typeof dialog.close === 'function';
        if (nativeDialog) { if (dialog.open) dialog.close(); }
        else { dialog.open = false; dialog.hidden = true; }
        document.body.classList.remove('modal-open', 'keyboard-open');
        dialogReturnFocus?.focus?.();
        return true;
    };

    window.showTextImport = function() {
        if (!scanner.confirmLeave()) return;
        scanner.reset();
        ocrImport.reset();
        document.getElementById('textImportForm').hidden = false;
        document.getElementById('rawText').focus?.();
    };

    window.chooseFileImport = function() {
        if (!window.closeAddContentDialog()) return;
        document.getElementById('fileInput').click();
    };

    document.getElementById('addContentDialog').addEventListener('click', event => {
        if (event.target === document.getElementById('addContentDialog')) window.closeAddContentDialog();
    });
    document.getElementById('addContentDialog').addEventListener('close', () => {
        scanner.reset();
        ocrImport.reset();
        document.body.classList.remove('modal-open', 'keyboard-open');
        dialogReturnFocus?.focus?.();
    });
    document.getElementById('addContentDialog').addEventListener('cancel', event => {
        if (!scanner.confirmLeave()) { event.preventDefault(); return; }
        scanner.reset();
        ocrImport.reset();
        document.body.classList.remove('modal-open', 'keyboard-open');
        dialogReturnFocus?.focus?.();
    });
    document.getElementById('rawText').addEventListener('focus', () => document.body.classList.add('keyboard-open'));
    document.getElementById('rawText').addEventListener('blur', () => document.body.classList.remove('keyboard-open'));
    document.getElementById('ocrText').addEventListener('focus', () => document.body.classList.add('keyboard-open'));
    document.getElementById('ocrText').addEventListener('blur', () => document.body.classList.remove('keyboard-open'));
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', event => {
        if (event.key === 'Escape') window.toggleSettings(false);
    });

    function updateMiniPlayer() {
        const mini = document.getElementById('miniPlayer');
        const title = document.getElementById('miniPlayerTitle');
        const play = document.getElementById('miniPlayBtn');
        if (!mini) return;
        mini.hidden = !currentDocument || activeTab !== 'history';
        title.textContent = currentDocument?.name || '';
        title.title = currentDocument?.name || '';
        play.textContent = isReading && !isPaused ? '⏸' : '▶';
        play.setAttribute?.('aria-label', isReading && !isPaused ? 'Wstrzymaj odtwarzanie' : 'Wznów odtwarzanie');
        document.getElementById('miniPlayerStatus').textContent = document.getElementById('statusText').innerText || 'Gotowy';
    }
    updateMiniPlayer();

    function resumeMessage(title, detail, record = null) {
        const panel = document.getElementById('resumePanel');
        if (!panel) return;
        const saveWarning = /nie udało|nie został zapisany|niedostępny|błąd/i.test(title);
        panel.hidden = !record && !saveWarning;
        document.getElementById('resumeTitle').textContent = title;
        document.getElementById('resumeName').textContent = detail;
        document.getElementById('resumeNote').textContent = 'Tekst jest zapamiętywany lokalnie w tej przeglądarce. Chrome i Edge nie współdzielą zapisu.';
        document.getElementById('resumeContinue').hidden = !record;
        const compactStatus = document.getElementById('resumeDelete');
        compactStatus.hidden = !!record || !saveWarning;
        compactStatus.textContent = compactStatus.hidden ? '' : detail;
        if (record) {
            const button=document.getElementById('resumeContinue');
            button.textContent = record.completed ? 'Od początku' : 'Kontynuuj';
            button.setAttribute?.('aria-label', record.completed ? 'Czytaj ukończony dokument od początku' : 'Kontynuuj czytanie od zapisanego miejsca');
        }
    }

    function openResumeDatabase() {
        if (resumeDbPromise) return resumeDbPromise;
        resumeDbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) return reject(new Error('indexeddb_unavailable'));
            let request;
            try { request = window.indexedDB.open(RESUME_DB_NAME, RESUME_DB_VERSION); }
            catch (error) { reject(error); return; }
            request.onupgradeneeded = event => {
                const db = request.result;
                const upgrade = request.transaction;
                let documents;
                if (!db.objectStoreNames.contains(RESUME_STORE)) documents = db.createObjectStore(RESUME_STORE, {keyPath: 'id'});
                else documents = upgrade.objectStore(RESUME_STORE);
                if (!documents.indexNames.contains('lastUsedAt')) documents.createIndex('lastUsedAt', 'lastUsedAt');
                let sessions;
                if (!db.objectStoreNames.contains(SESSION_STORE)) sessions = db.createObjectStore(SESSION_STORE, {keyPath: 'id'});
                else sessions = upgrade.objectStore(SESSION_STORE);
                if (!sessions.indexNames.contains('documentId')) sessions.createIndex('documentId', 'documentId');
                if (!sessions.indexNames.contains('startedAt')) sessions.createIndex('startedAt', 'startedAt');
                if (event.oldVersion === 1) {
                    const legacy = documents.get(RESUME_KEY);
                    legacy.onsuccess = () => {
                        if (!legacy.result) return;
                        const old = legacy.result;
                        const migrated = {...old, id: 'doc_migrated_v1_last', version: 1,
                            createdAt: Number(old.savedAt) || Date.now(), lastUsedAt: Number(old.savedAt) || Date.now(),
                            migratedFrom: 'ux01-v1'};
                        const put = documents.put(migrated);
                        put.onsuccess = () => documents.delete(RESUME_KEY);
                    };
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
            request.onblocked = () => reject(new Error('indexeddb_blocked'));
        }).catch(error => { resumeDbPromise = null; throw error; });
        return resumeDbPromise;
    }

    async function readResumeRecord() {
        const db = await openResumeDatabase();
        return new Promise((resolve, reject) => {
            let request;
            try { request = db.transaction(RESUME_STORE, 'readonly').objectStore(RESUME_STORE).getAll(); }
            catch (error) { reject(error); return; }
            request.onsuccess = () => {
                const documents=(request.result || []).filter(item=>item.id!==RESUME_KEY);
                const valid=documents.filter(item=>validResumeRecord(item) &&
                    speechSegments(item.text,item.blocks).length===item.sentenceCount);
                documents.filter(item=>!valid.includes(item)).forEach(item=>queueInvalidResumeCleanup(item,resumeUserAction,resumeDocumentRevision));
                resolve(valid.sort((a,b) => (Number(b.lastUsedAt) || Number(b.savedAt) || 0) -
                    (Number(a.lastUsedAt) || Number(a.savedAt) || 0))[0] || null);
            };
            request.onerror = () => reject(request.error || new Error('indexeddb_read_failed'));
        });
    }

    async function readAllRecords(storeName) {
        const db = await openResumeDatabase();
        return new Promise((resolve, reject) => {
            let request;
            try { request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll(); }
            catch (error) { reject(error); return; }
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('indexeddb_read_failed'));
        });
    }

    function makeDocumentId() {
        return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
    }

    async function readDocumentById(id) {
        const db = await openResumeDatabase();
        return new Promise((resolve, reject) => {
            let request;
            try { request = db.transaction(RESUME_STORE, 'readonly').objectStore(RESUME_STORE).get(id); }
            catch (error) { reject(error); return; }
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('indexeddb_read_failed'));
        });
    }

    function writeSessionRecord(record) {
        resumeWriteQueue = resumeWriteQueue.catch(() => {}).then(async () => {
            const db = await openResumeDatabase();
            await new Promise((resolve, reject) => {
                let tx;
                try { tx = db.transaction([RESUME_STORE, SESSION_STORE], 'readwrite'); }
                catch (error) { reject(error); return; }
                tx.oncomplete = resolve;
                tx.onerror = tx.onabort = () => reject(tx.error || new Error('indexeddb_session_write_failed'));
                const exists=tx.objectStore(RESUME_STORE).get(record.documentId);
                exists.onsuccess=()=>{ if (exists.result) tx.objectStore(SESSION_STORE).put(record); };
                exists.onerror=()=>reject(exists.error||new Error('indexeddb_session_write_failed'));
            });
            await pruneHistory();
            if (activeTab === 'history') refreshHistory().catch(() => {});
        });
        resumeWriteQueue.catch(() => {});
        return resumeWriteQueue;
    }

    async function pruneHistory() {
        const sessions = await readAllRecords(SESSION_STORE);
        const cutoff = Date.now() - HISTORY_RETENTION_MS;
        const ordered = sessions.sort((a,b) => a.startedAt - b.startedAt);
        const remove = ordered.filter(item => item.startedAt < cutoff).concat(ordered.slice(0, Math.max(0, ordered.length - MAX_HISTORY_SESSIONS)));
        const ids = new Set(remove.map(item => item.id));
        if (!ids.size) return;
        const db = await openResumeDatabase();
        await new Promise((resolve, reject) => {
            let tx;
            try { tx = db.transaction(SESSION_STORE, 'readwrite'); }
            catch (error) { reject(error); return; }
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('indexeddb_prune_failed'));
            ids.forEach(id => tx.objectStore(SESSION_STORE).delete(id));
        });
    }

    function persistListeningSession() {
        if (!activeListeningSession) return;
        const item = {...activeListeningSession};
        writeSessionRecord(item);
    }

    function beginListeningSession() {
        if (!currentDocument?.id) return;
        const now = Date.now();
        if (activeListeningSession?.documentId === currentDocument.id) {
            if (activeListeningSession.status === 'playing') return;
            if (now - activeListeningSession.lastResumedAt <= SESSION_GROUP_MS) {
                activeListeningSession.status = 'playing';
                activeListeningSession.lastResumedAt = now;
                activeListeningSession.voice = document.getElementById('voiceSelect').value;
                activeListeningSession.rate = String(document.getElementById('rateSlider').value);
                persistListeningSession();
                return;
            }
            finishListeningSession('interrupted');
        } else if (activeListeningSession) finishListeningSession('interrupted');
        activeListeningSession = {id: `listen_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
            documentId: currentDocument.id, documentName: currentDocument.name, startedAt: now,
            lastResumedAt: now, playedMs: 0, status: 'playing', voice: document.getElementById('voiceSelect').value,
            rate: String(document.getElementById('rateSlider').value), updatedAt: now};
        persistListeningSession();
    }

    function pauseListeningSession() {
        if (!activeListeningSession || activeListeningSession.status !== 'playing') return;
        const now = Date.now();
        activeListeningSession.playedMs += Math.max(0, now - activeListeningSession.lastResumedAt);
        activeListeningSession.lastResumedAt = now;
        activeListeningSession.status = 'paused';
        activeListeningSession.updatedAt = now;
        persistListeningSession();
    }

    function finishListeningSession(status) {
        if (!activeListeningSession) return;
        if (activeListeningSession.status === 'playing')
            activeListeningSession.playedMs += Math.max(0, Date.now() - activeListeningSession.lastResumedAt);
        const item = {...activeListeningSession, status, endedAt: Date.now(), updatedAt: Date.now()};
        activeListeningSession = null;
        writeSessionRecord(item);
    }

    function dateKey(date) {
        const d = date instanceof Date ? date : new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    function formatLocalDate(key) {
        const [year, month, day] = key.split('-').map(Number);
        return new Intl.DateTimeFormat('pl-PL', {weekday:'long', day:'numeric', month:'long', year:'numeric'})
            .format(new Date(year, month - 1, day));
    }

    async function refreshHistory() {
        try {
            const [docs, sessions] = await Promise.all([readAllRecords(RESUME_STORE), readAllRecords(SESSION_STORE)]);
            historyDocuments = docs.filter(item => item.id !== RESUME_KEY && validResumeRecord(item))
                .sort((a,b) => (Number(b.lastUsedAt) || Number(b.savedAt) || 0) - (Number(a.lastUsedAt) || Number(a.savedAt) || 0));
            historySessions = sessions.filter(item => Number.isFinite(item.startedAt) && typeof item.documentId === 'string');
            renderHistory();
        } catch { /* Storage failure must not affect playback. */ }
    }

    function renderHistory() {
        const grid = document.getElementById('historyGrid');
        if (!grid) return;
        const monthName = new Intl.DateTimeFormat('pl-PL', {month:'long', year:'numeric'}).format(historyMonth);
        document.getElementById('historyMonth').textContent = monthName;
        grid.innerHTML = '';
        const weekdays = ['Pn','Wt','Śr','Cz','Pt','So','Nd'];
        weekdays.forEach(label => { const el=document.createElement('div'); el.className='history-weekday'; el.innerText=label; grid.appendChild(el); });
        const first = new Date(historyMonth.getFullYear(), historyMonth.getMonth(), 1);
        const offset = (first.getDay() + 6) % 7;
        const days = new Date(historyMonth.getFullYear(), historyMonth.getMonth()+1, 0).getDate();
        const activeDates = new Set(historySessions.map(item => dateKey(item.startedAt)));
        for (let i=0;i<offset;i++) { const spacer=document.createElement('div'); spacer.className='empty'; grid.appendChild(spacer); }
        for (let day=1;day<=days;day++) {
            const date=new Date(historyMonth.getFullYear(),historyMonth.getMonth(),day), key=dateKey(date);
            const button=document.createElement('button'); button.innerText=String(day);
            if (activeDates.has(key)) button.classList.add('has-sessions');
            if (selectedHistoryDay===key) button.classList.add('selected');
            button.setAttribute?.('aria-label', `${day} ${monthName}${activeDates.has(key) ? ', sesja odsłuchu' : ''}`);
            button.onclick=()=>{ selectedHistoryDay=key; renderHistory(); };
            grid.appendChild(button);
        }
        const list=document.getElementById('historyList'); list.innerHTML='';
        const entries=historySessions.filter(item=>dateKey(item.startedAt)===selectedHistoryDay).sort((a,b)=>a.startedAt-b.startedAt);
        if (!entries.length) { const empty=document.createElement('div'); empty.className='history-empty'; empty.innerText='Brak sesji odsłuchu tego dnia.'; list.appendChild(empty); return; }
        entries.forEach(item=>{
            const row=document.createElement('div'); row.className='history-entry';
            const copy=document.createElement('div'); copy.className='history-entry-copy';
            const time=new Intl.DateTimeFormat('pl-PL',{hour:'2-digit',minute:'2-digit'}).format(new Date(item.startedAt));
            const statusLabels={playing:'Odtwarzanie',paused:'Wstrzymana',stopped:'Zatrzymana',completed:'Ukończona',interrupted:'Przerwana'};
            const name=item.documentName || historyDocuments.find(d=>d.id===item.documentId)?.name || 'Dokument usunięty';
            const title=document.createElement('strong'); title.className='history-entry-title'; title.innerText=name; title.title=name; copy.appendChild(title);
            const voiceLabels={'pl-PL-MarekNeural':'Marek','pl-PL-ZofiaNeural':'Zofia'};
            const details=[`Start: ${time}`, voiceLabels[item.voice] || (item.voice ? item.voice.replace('pl-PL-','') : ''), statusLabels[item.status] || item.status];
            if (Boolean(item.endedAt) && Number.isFinite(item.endedAt) && item.endedAt >= item.startedAt)
                details.splice(1, 0, `Koniec: ${new Intl.DateTimeFormat('pl-PL',{hour:'2-digit',minute:'2-digit'}).format(new Date(item.endedAt))}`);
            if (Number.isFinite(item.playedMs) && item.playedMs > 0) {
                const seconds=Math.floor(item.playedMs/1000), duration=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
                details.push(`Czas: ${duration}`);
            }
            const meta=document.createElement('span'); meta.className='history-entry-meta'; meta.innerText=details.filter(Boolean).join(' • '); copy.appendChild(meta);
            row.appendChild(copy);
            const doc=historyDocuments.find(d=>d.id===item.documentId);
            if (doc) { const button=document.createElement('button'); button.innerText=doc.completed?'Powtórz':'Otwórz'; button.onclick=()=>openLibraryDocument(doc.id); row.appendChild(button); }
            list.appendChild(row);
        });
    }

    async function renderLibrary() {
        await refreshHistory();
        const list=document.getElementById('libraryList'); list.innerHTML='';
        if (!historyDocuments.length) { const empty=document.createElement('div'); empty.className='history-empty'; empty.innerText='Biblioteka jest pusta. Wklej tekst lub wgraj dokument.'; list.appendChild(empty); return; }
        historyDocuments.forEach(record=>{
            const row=document.createElement('div'); row.className='library-entry';
            const copy=document.createElement('div'); copy.className='library-entry-copy';
            const title=document.createElement('strong'); title.className='library-entry-title'; title.innerText=record.name; title.title=record.name; copy.appendChild(title);
            const meta=document.createElement('span'); meta.className='library-entry-meta'; meta.innerText=record.completed?'Ukończony':`zdanie ${Math.min(record.index+1,record.sentenceCount)} z ${record.sentenceCount}`; copy.appendChild(meta);
            row.appendChild(copy);
            const open=document.createElement('button'); open.innerText='Otwórz'; open.onclick=()=>openLibraryDocument(record.id); row.appendChild(open);
            const remove=document.createElement('button'); remove.innerText='Usuń'; remove.setAttribute?.('aria-label',`Usuń ${record.name}`); remove.onclick=()=>{ if (typeof window.confirm !== 'function' || window.confirm(`Usunąć „${record.name}” wraz z historią?`)) deleteLibraryDocument(record.id); }; row.appendChild(remove);
            list.appendChild(row);
        });
    }

    async function openLibraryDocument(id) {
        if (deletedDocumentIds.has(id)) return;
        const selection = ++librarySelectionRevision;
        const action = ++resumeUserAction;
        const revision = resumeDocumentRevision;
        try {
            const record=await readDocumentById(id);
            if (selection !== librarySelectionRevision || action !== resumeUserAction ||
                revision !== resumeDocumentRevision || deletedDocumentIds.has(id) ||
                !record || !validResumeRecord(record) || speechSegments(record.text,record.blocks).length !== record.sentenceCount) return;
            resumeStoredRecord=record;
            document.getElementById('rawText').value=record.text;
            if (record.voice) document.getElementById('voiceSelect').value=record.voice;
            document.getElementById('rateSlider').value=String(record.rate);
            document.getElementById('rateLabel').innerText=(Number(record.rate)>=0?'+':'')+record.rate+'%';
            lastDocumentUseStamp = Math.max(lastDocumentUseStamp, Number(record.lastUsedAt) || 0);
            renderSentences(record.text,record.blocks,{name:record.name,restored:true,id:record.id,index:record.index,completed:record.completed,createdAt:record.createdAt,lastUsedAt:record.lastUsedAt});
            saveResumeProgress(true);
            window.switchTab('reader');
            setStatus(record.completed?'Dokument ukończony. Możesz zacząć od początku.':'Dokument przywrócony. Wybierz ▶, aby kontynuować.');
        } catch {}
    }

    async function deleteLibraryDocument(id) {
        const wasCurrent=currentDocument?.id===id;
        if (wasCurrent) { finishListeningSession('stopped'); window.stopReading(); }
        deletedDocumentIds.add(id);
        if (wasCurrent) resumeDocumentRevision++;
        const deletionRevision=resumeDocumentRevision;
        resumeWriteQueue=resumeWriteQueue.catch(()=>{}).then(async()=>{
            const db=await openResumeDatabase();
            await new Promise((resolve,reject)=>{
                const tx=db.transaction([RESUME_STORE,SESSION_STORE],'readwrite');
                tx.oncomplete=resolve; tx.onerror=tx.onabort=()=>reject(tx.error||new Error('indexeddb_delete_failed'));
                tx.objectStore(RESUME_STORE).delete(id);
                const all=tx.objectStore(SESSION_STORE).getAll();
                all.onsuccess=()=> (all.result||[]).filter(item=>item.documentId===id).forEach(item=>tx.objectStore(SESSION_STORE).delete(item.id));
            });
            if (wasCurrent && currentDocument?.id===id && resumeDocumentRevision===deletionRevision) {
                currentDocument=null;
                sentences=[];
                document.getElementById('sentenceList').innerHTML='';
                document.getElementById('readerEmpty').hidden=false;
                document.getElementById('documentTitle').hidden=true;
                updateMiniPlayer();
                resumeMessage('Dokument usunięty','Treść, postęp i historia dokumentu zostały usunięte z tej przeglądarki.');
            }
            await renderLibrary();
        }).catch(()=>resumeMessage('Nie udało się usunąć dokumentu','Pamięć lokalna jest niedostępna.'));
        return resumeWriteQueue;
    }

    window.toggleLibraryView = function(showLibrary) {
        showingLibrary=typeof showLibrary==='boolean'?showLibrary:!showingLibrary;
        document.getElementById('calendarView').hidden=showingLibrary;
        document.getElementById('libraryList').hidden=!showingLibrary;
        document.getElementById('calendarToggle').classList.toggle('active',!showingLibrary);
        document.getElementById('calendarToggle').setAttribute?.('aria-selected',String(!showingLibrary));
        document.getElementById('libraryToggle').classList.toggle('active',showingLibrary);
        document.getElementById('libraryToggle').setAttribute?.('aria-selected',String(showingLibrary));
        if (showingLibrary) renderLibrary(); else refreshHistory();
    };

    document.getElementById('historyPrev').addEventListener('click',()=>{historyMonth=new Date(historyMonth.getFullYear(),historyMonth.getMonth()-1,1);selectedHistoryDay=dateKey(historyMonth);renderHistory();});
    document.getElementById('historyNext').addEventListener('click',()=>{historyMonth=new Date(historyMonth.getFullYear(),historyMonth.getMonth()+1,1);selectedHistoryDay=dateKey(historyMonth);renderHistory();});

    async function writeResumeRecord(record) {
        const db = await openResumeDatabase();
        let rotated = null;
        await new Promise((resolve, reject) => {
            let transaction;
            try {
                transaction = db.transaction([RESUME_STORE, SESSION_STORE], 'readwrite');
            } catch (error) { reject(error); return; }
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('indexeddb_write_failed'));
            transaction.onabort = () => reject(transaction.error || new Error('indexeddb_write_failed'));
            const documents = transaction.objectStore(RESUME_STORE);
            const existing = documents.getAll();
            existing.onsuccess = () => {
                const library = (existing.result || []).filter(item => item.id !== RESUME_KEY);
                if (!library.some(item => item.id === record.id) && library.length >= MAX_LIBRARY_DOCUMENTS) {
                    rotated = library.filter(item => item.id !== currentDocument?.id)
                        .sort((a,b) => (Number(a.lastUsedAt) || Number(a.savedAt) || 0) - (Number(b.lastUsedAt) || Number(b.savedAt) || 0))[0];
                    if (!rotated) { reject(new Error('library_full_active_document_protected')); return; }
                    documents.delete(rotated.id);
                    const sessions = transaction.objectStore(SESSION_STORE).getAll();
                    sessions.onsuccess = () => (sessions.result || []).filter(item => item.documentId === rotated.id)
                        .forEach(item => transaction.objectStore(SESSION_STORE).delete(item.id));
                }
                documents.put(record);
            };
            existing.onerror = () => reject(existing.error || new Error('indexeddb_read_failed'));
        });
        return rotated;
    }

    function sameResumeRecord(left, right) {
        if (!left || !right) return false;
        if (typeof left.writeToken === 'string' || typeof right.writeToken === 'string')
            return typeof left.writeToken === 'string' && left.writeToken === right.writeToken;
        return left.id === right.id && left.version === right.version &&
            left.segmentationVersion === right.segmentationVersion && left.text === right.text &&
            left.name === right.name && left.index === right.index && left.completed === right.completed &&
            left.savedAt === right.savedAt && JSON.stringify(left.blocks) === JSON.stringify(right.blocks);
    }

    async function eraseResumeRecord(expectedRecord = null, stillCurrent = () => true) {
        const db = await openResumeDatabase();
        return new Promise((resolve, reject) => {
            let transaction;
            try {
                transaction = db.transaction([RESUME_STORE, SESSION_STORE], 'readwrite');
            } catch (error) { reject(error); return; }
            let removed = false;
            transaction.oncomplete = () => resolve(removed);
            transaction.onerror = () => reject(transaction.error || new Error('indexeddb_delete_failed'));
            transaction.onabort = () => reject(transaction.error || new Error('indexeddb_delete_failed'));
            try {
                const store = transaction.objectStore(RESUME_STORE);
                if (!expectedRecord) {
                    if (currentDocument?.id) {
                        store.delete(currentDocument.id);
                        const sessions = transaction.objectStore(SESSION_STORE).getAll();
                        sessions.onsuccess = () => (sessions.result || []).filter(item => item.documentId === currentDocument.id)
                            .forEach(item => transaction.objectStore(SESSION_STORE).delete(item.id));
                    }
                    removed = true;
                } else {
                    const request = store.get(expectedRecord.id);
                    request.onsuccess = () => {
                        if (!stillCurrent() || !sameResumeRecord(request.result, expectedRecord)) return;
                        store.delete(expectedRecord.id);
                        removed = true;
                    };
                    request.onerror = () => reject(request.error || new Error('indexeddb_delete_failed'));
                }
            } catch (error) { reject(error); }
        });
    }

    function queueInvalidResumeCleanup(expectedRecord, action, revision) {
        resumeWriteQueue = resumeWriteQueue.catch(() => {}).then(() => {
            // Document IDs are immutable and cleanup rechecks the exact record in its write transaction.
            // A new document has another ID, so a changed UI revision must not strand invalid migrated data.
            return eraseResumeRecord(expectedRecord, () => true);
        });
        return resumeWriteQueue;
    }

    function safeResumeBlocks(blocks, textLength) {
        if (!Array.isArray(blocks)) return null;
        return blocks.map(block => {
            if (!block || !Number.isInteger(block.start) || !Number.isInteger(block.end) ||
                block.start < 0 || block.end <= block.start || block.end > textLength || typeof block.kind !== 'string') return null;
            return {start: block.start, end: block.end, kind: block.kind};
        }).every(Boolean) ? blocks.map(({start, end, kind}) => ({start, end, kind})) : null;
    }

    function validResumeRecord(record) {
        if (!record || typeof record.id !== 'string' || !record.id || record.id === RESUME_KEY || record.version !== 1 ||
            record.segmentationVersion !== SEGMENTATION_VERSION || typeof record.text !== 'string' ||
            !record.text.trim() || typeof record.name !== 'string' || !Array.isArray(record.blocks) ||
            !Number.isInteger(record.sentenceCount) || !Number.isInteger(record.index) ||
            typeof record.completed !== 'boolean' || !['pl-PL-ZofiaNeural', 'pl-PL-MarekNeural'].includes(record.voice) ||
            !Number.isInteger(Number(record.rate)) || String(Number(record.rate)) !== String(record.rate) ||
            Number(record.rate) < -50 || Number(record.rate) > 50 || Number(record.rate) % 10 !== 0 ||
            record.sentenceCount < 1) return false;
        if (record.index < 0 || record.index > record.sentenceCount || (!record.completed && record.index >= record.sentenceCount)) return false;
        return safeResumeBlocks(record.blocks, record.text.length) !== null;
    }

    function makeResumeRecord() {
        if (!currentDocument) return null;
        const blocks = safeResumeBlocks(currentDocument.blocks, currentDocument.text.length);
        if (!blocks) return null;
        const now = Date.now();
        lastDocumentUseStamp = Math.max(now, lastDocumentUseStamp + 1, Number(currentDocument.lastUsedAt) || 0);
        currentDocument.lastUsedAt = lastDocumentUseStamp;
        return {id: currentDocument.id || makeDocumentId(), version: 1, segmentationVersion: SEGMENTATION_VERSION,
            text: currentDocument.text, name: currentDocument.name, blocks, sentenceCount: sentences.length,
            index: currentDocument.completed ? sentences.length : Math.max(0, Math.min(currentIdx, Math.max(0, sentences.length - 1))),
            completed: !!currentDocument.completed,
            voice: document.getElementById('voiceSelect').value,
            rate: String(document.getElementById('rateSlider').value), savedAt: now,
            createdAt: currentDocument.createdAt || now, lastUsedAt: lastDocumentUseStamp,
            writeToken: `${Date.now()}-${++resumeWriteSequence}-${Math.random().toString(36).slice(2)}`};
    }

    function saveResumeProgress(force = false) {
        if (!currentDocument || !resumeSavingEnabled || !sentences.length) return;
        const now = Date.now();
        if (!force && currentIdx === lastProgressSavedIndex && now - lastProgressSaveAt < RESUME_SAVE_INTERVAL_MS) return;
        const record = makeResumeRecord();
        if (!record) return;
        const revision = resumeDocumentRevision;
        lastProgressSaveAt = now;
        lastProgressSavedIndex = currentIdx;
        resumeWriteQueue = resumeWriteQueue.catch(() => {}).then(async () => {
            if (!resumeSavingEnabled || deletedDocumentIds.has(record.id)) return;
            const rotated = await writeResumeRecord(record);
            if (deletedDocumentIds.has(record.id)) return;
            resumeStoredRecord = record;
            if (revision === resumeDocumentRevision) {
                resumeMessage(rotated ? 'Biblioteka pełna' : 'Zapis lokalny', rotated
                    ? `Usunięto najdawniej używany dokument „${rotated.name}” i jego historię. Aktualny dokument pozostaje zapisany.`
                    : `${record.name} • Dokument jest zapisany lokalnie (limit biblioteki: 10).`, record);
            }
            refreshHistory().catch(() => {});
        });
        resumeWriteQueue.catch(() => {
            if (revision === resumeDocumentRevision && resumeSavingEnabled)
                resumeMessage('Postęp nie został zapisany', 'Brak miejsca lub niedostępna pamięć lokalna. Odtwarzanie działa dalej.');
        });
    }

    function paintRestoredPosition(record) {
        document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active'));
        if (!record.completed) {
            const active = document.getElementById('sent-' + currentIdx);
            if (active) active.classList.add('active');
        }
        document.getElementById('progressBar').style.width = (record.completed ? 100 :
            (sentences.length ? ((currentIdx + 1) / sentences.length) * 100 : 0)) + '%';
    }

    async function restoreSavedDocument() {
        const action = resumeUserAction;
        const originalRevision = resumeDocumentRevision;
        try {
            const record = await readResumeRecord();
            if (action !== resumeUserAction || originalRevision !== resumeDocumentRevision) return;
            if (!record) {
                resumeStoredRecord = null;
                resumeMessage('Zapis lokalny', 'Brak zapamiętanego dokumentu.');
                return;
            }
            const blocks = safeResumeBlocks(record.blocks, typeof record.text === 'string' ? record.text.length : -1);
            if (!validResumeRecord(record) || !blocks || speechSegments(record.text, blocks).length !== record.sentenceCount) {
                await queueInvalidResumeCleanup(record, action, originalRevision);
                if (action === resumeUserAction && originalRevision === resumeDocumentRevision) {
                    resumeStoredRecord = null;
                    resumeMessage('Zapis lokalny', 'Nie udało się zweryfikować starego zapisu. Wczytaj dokument ponownie.');
                }
                return;
            }
            if (action !== resumeUserAction || originalRevision !== resumeDocumentRevision) return;
            resumeStoredRecord = record;
            document.getElementById('rawText').value = record.text;
            lastDocumentUseStamp = Math.max(lastDocumentUseStamp, Number(record.lastUsedAt) || 0);
            renderSentences(record.text, blocks, {name: record.name, restored: true, id: record.id,
                createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, index: record.index, completed: record.completed});
            if (record.voice) document.getElementById('voiceSelect').value = record.voice;
            document.getElementById('rateSlider').value = String(record.rate);
            document.getElementById('rateLabel').innerText = (Number(record.rate) >= 0 ? '+' + record.rate : record.rate) + '%';
            paintRestoredPosition(record);
            setStatus(record.completed ? 'Dokument ukończony. Możesz zacząć od początku.' : 'Dokument przywrócony. Wybierz „Kontynuuj od tego miejsca”.');
            resumeMessage('Biblioteka lokalna', record.name, record);
            refreshHistory().catch(() => {});
        } catch (error) {
            if (action === resumeUserAction && originalRevision === resumeDocumentRevision)
                resumeMessage('Zapis lokalny niedostępny', 'Ten dokument nie zostanie zapamiętany. Odtwarzanie działa dalej.');
        }
    }

    window.continueSavedDocument = function() {
        const record = resumeStoredRecord;
        if (!record || !currentDocument || currentDocument.text !== record.text) return;
        currentDocument.completed = false;
        window.startFrom(record.completed ? 0 : currentIdx);
    };

    window.deleteSavedDocument = function() {
        if (currentDocument?.id) deleteLibraryDocument(currentDocument.id);
    };

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
        if (tab === 'editor') {
            if (!document.getElementById('addContentDialog').open) window.openAddContentDialog();
            window.showTextImport();
            return;
        }
        if (document.getElementById('addContentDialog').open &&
            (!document.getElementById('ocrImport').hidden || scanner.active()) &&
            !window.closeAddContentDialog()) return;
        tab = tab === 'history' ? 'history' : 'reader';
        activeTab = tab;
        document.getElementById('readerView').style.display = tab === 'reader' ? 'flex' : 'none';
        document.getElementById('historyView').style.display = tab === 'history' ? 'flex' : 'none';
        document.getElementById('tabReader').classList.toggle('active', tab === 'reader');
        document.getElementById('tabHistory').classList.toggle('active', tab === 'history');
        document.getElementById('tabReader').setAttribute?.('aria-current', tab === 'reader' ? 'page' : 'false');
        document.getElementById('tabHistory').setAttribute?.('aria-current', tab === 'history' ? 'page' : 'false');
        document.body.classList.toggle('history-active', tab === 'history');
        if (tab === 'history') {
            if (showingLibrary) renderLibrary(); else refreshHistory();
        }
        updateMiniPlayer();
    };

    window.applyText = function() {
        const text = document.getElementById('rawText').value.trim();
        if (!text) { setImportStatus('Wklej tekst przed zatwierdzeniem.'); return setStatus('Wklej tekst przed zatwierdzeniem.'); }
        resumeUserAction++;
        renderSentences(text, [], {name: 'Wklejony tekst'});
        setImportStatus('Tekst gotowy do czytania.');
        window.closeAddContentDialog();
        window.switchTab('reader');
    };

    function renderSentences(text, hints = [], options = {}) {
        if (ocrImport.active()) ocrImport.reset();
        if (scanner.active()) scanner.reset();
        window.stopReading();
        if (!options.restored) resumeUserAction++;
        resumeDocumentRevision++;
        resumeSavingEnabled = true;
        lastProgressSavedIndex = null;
        lastProgressSaveAt = 0;
        const box = document.getElementById('sentenceList');
        box.innerHTML = '';
        const segments = speechSegments(text, hints);
        sentences = segments.map(segment => segment.text);
        const blocks = safeResumeBlocks(hints, text.length);
        resumeStoredRecord = options.restored ? resumeStoredRecord : null;
        currentDocument = {id: options.id || makeDocumentId(), createdAt: options.createdAt || Date.now(), lastUsedAt: options.lastUsedAt || 0,
            text, name: options.name || 'Dokument', blocks: blocks || [], completed: !!options.completed};
        const title = document.getElementById('documentTitle');
        title.textContent = currentDocument.name;
        title.title = currentDocument.name;
        title.hidden = false;
        document.getElementById('readerEmpty').hidden = sentences.length > 0;
        resumeMessage('Zapamiętany dokument', currentDocument.name, resumeStoredRecord);
        updateMiniPlayer();

        sentences.forEach((s, idx) => {
            const div = document.createElement('div');
            div.className = 'sentence';
            div.id = 'sent-' + idx;
            div.innerText = segments[idx].displayText;
            div.onclick = () => window.startFrom(idx);
            box.appendChild(div);
        });
        currentIdx = options.restored ? options.index : 0;
        if (options.restored) {
            paintRestoredPosition({completed: !!options.completed});
            resumeMessage('Zapamiętany dokument', currentDocument.name, resumeStoredRecord);
            refreshHistory().catch(() => {});
        } else {
            document.getElementById('progressBar').style.width = '0%';
            setStatus(`Gotowy • Zdań: ${sentences.length}`);
            if (sentences.length) saveResumeProgress(true);
        }
    }

    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        const importAction=++resumeUserAction;
        const importRevision=resumeDocumentRevision;
        setStatus(`⏳ Wysyłanie pliku (${file.name})...`);
        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Błąd serwera HTTP ' + res.status);
            const data = await res.json();
            if (importAction !== resumeUserAction || importRevision !== resumeDocumentRevision) return;
            if (data.error) throw new Error(data.error);

            document.getElementById('rawText').value = data.text;
            if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('Plik nie zawiera tekstu do czytania.');
            renderSentences(data.text, data.blocks || [], {name: file.name});
            window.closeAddContentDialog();
            window.switchTab('reader');
            setStatus(`✔️ Wczytano plik: ${file.name}`);
        } catch (err) {
            if (importAction !== resumeUserAction || importRevision !== resumeDocumentRevision) return;
            window.openAddContentDialog();
            setImportStatus('Nie udało się wczytać pliku: ' + err.message);
            setStatus('❌ Błąd odczytu pliku');
            if (!currentDocument) restoreSavedDocument();
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
        recoveryAttempts: 0, stream: {mode: 'not_checked', is_type_supported: null, appended_bytes: 0,
            buffered_bytes: 0, buffered_seconds: 0, last_error: null},
        observedPlayers: new WeakSet(), progressAt: new WeakMap(), visibleProbe: 0, visibleTimer: null} : null;

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
        if (continuousPlayback && continuousPlayback.player === player && continuousPlayback.token === session) {
            setMediaPlaybackState('paused');
            if (isReading && !isPaused && !player.ended) {
                isPaused = true;
                document.getElementById('playBtn').innerText = '▶';
                setStatus('Odtwarzanie zostało wstrzymane. Naciśnij ▶, aby wznowić.');
                trace('stream_pause', {stream_index: continuousPlayback.currentIndex, current_time: Number.isFinite(player.currentTime) ? player.currentTime : null});
            }
            return;
        }
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
        const observedSession=session;
        player.addEventListener('playing', () => {
            if (player !== audio || observedSession !== session || !isReading || isPaused || !currentDocument?.id) return;
            beginListeningSession();
            setMediaPlaybackState('playing');
        });
        player.addEventListener('pause', () => {
            pauseListeningSession();
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
            stream: {...diagnostics.stream},
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
        job.blob = null;
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
        job.blob = blob;
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

    function setCurrentSentenceVisual(idx, force = false) {
        if (idx < 0 || idx >= sentences.length || (idx === currentIdx && !force)) return;
        currentIdx = idx;
        saveResumeProgress(true);
        document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active'));
        const activeEl = document.getElementById('sent-' + idx);
        if (activeEl) {
            activeEl.classList.add('active');
            if (activeTab === 'reader') activeEl.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
        document.getElementById('progressBar').style.width = (((idx + 1) / sentences.length) * 100) + '%';
        if (!isPaused) setStatus(`Czytanie zdania ${idx + 1} z ${sentences.length}`);
    }

    function nextSpeakableIndex(idx) {
        while (idx < sentences.length && !sentences[idx].trim()) idx++;
        return idx;
    }

    function completeCurrentDocument() {
        if (!sentences.length) return;
        if (currentDocument) currentDocument.completed = true;
        currentIdx = sentences.length;
        document.getElementById('progressBar').style.width = '100%';
        if (currentDocument) saveResumeProgress(true);
    }

    function streamBufferedEnd(sourceBuffer) {
        const ranges = sourceBuffer?.buffered;
        if (!ranges?.length) return 0;
        return ranges.end(ranges.length - 1);
    }

    function streamBufferedStart(sourceBuffer) {
        const ranges = sourceBuffer?.buffered;
        if (!ranges?.length) return 0;
        return ranges.start(0);
    }

    function retainedSegmentBytes(segment) {
        const start = Math.max(segment.start, segment.retainedStart ?? segment.start);
        return segment.end <= start ? 0 : segment.bytes * (segment.end - start) / Math.max(0.001, segment.end - segment.start);
    }

    function streamStateIsCurrent(state) {
        return continuousPlayback === state && !state.cancelled && state.token === session && state.player === audio;
    }

    function streamFail(state, error, restartIndex = state.currentIndex) {
        if (!streamStateIsCurrent(state)) return;
        const wasPaused = isPaused;
        const idx = Math.max(0, Math.min(sentences.length - 1, Number.isFinite(restartIndex) ? restartIndex : currentIdx));
        trace('stream_error', {code: error?.name || 'stream_error', fragment: idx});
        if (diagnostics) {
            diagnostics.stream.mode = 'fallback';
            diagnostics.stream.last_error = error?.name || 'stream_error';
        }
        trace('stream_fallback', {fragment: idx, reason: error?.name || 'stream_error'});
        window.stopReading();
        currentIdx = idx;
        isReading = true;
        isPaused = wasPaused;
        setMediaPlaybackState(wasPaused ? 'paused' : 'playing');
        document.getElementById('playBtn').innerText = wasPaused ? '▶' : '⏸';
        playCurrent();
    }

    function handleStreamUpdateEnd(state) {
        if (!streamStateIsCurrent(state)) return;
        const sourceBuffer = state.sourceBuffer;
        if (state.pendingRemove !== null) {
            const cutoff = state.pendingRemove;
            state.pendingRemove = null;
            state.appended = state.appended.filter(segment => segment.end > cutoff);
            for (const segment of state.appended) segment.retainedStart = Math.max(segment.retainedStart ?? segment.start, cutoff);
            state.bufferedBytes = state.appended.reduce((sum, segment) => sum + retainedSegmentBytes(segment), 0);
            state.lastRemovedTo = cutoff;
            if (diagnostics) diagnostics.stream.buffered_bytes = state.bufferedBytes;
            trace('stream_remove', {before_seconds: cutoff, buffered_bytes: state.bufferedBytes});
        } else if (state.pendingAppend) {
            const appended = state.pendingAppend;
            state.pendingAppend = null;
            state.waitingForData = false;
            const end = streamBufferedEnd(sourceBuffer);
            const start = state.timelineEnd;
            if (!Number.isFinite(end) || end <= start + 0.001) {
                streamFail(state, new Error('SourceBuffer returned no playable range.'), state.currentIndex);
                return;
            }
            state.timelineEnd = end;
            state.appended.push({idx: appended.idx, start, end, bytes: appended.bytes, retainedStart: start});
            state.bufferedBytes += appended.bytes;
            state.nextAppendIdx = appended.idx + 1;
            if (diagnostics) {
                diagnostics.stream.appended_bytes += appended.bytes;
                diagnostics.stream.buffered_bytes = state.bufferedBytes;
                diagnostics.stream.buffered_seconds = Math.max(0, end - state.player.currentTime);
            }
            trace('stream_append_end', {fragment: appended.idx, byte_length: appended.bytes,
                start_seconds: start, end_seconds: end, buffered_bytes: state.bufferedBytes,
                buffered_seconds: Math.max(0, end - state.player.currentTime)});
            releaseJob(appended.job);
            jobs.delete(appended.job.key);
            if (!state.playCalled) {
                state.playCalled = true;
                ready = true;
                loading = false;
                if (!isPaused) {
                    setMediaPlaybackState('playing');
                    state.player.play().then(() => {
                        if (streamStateIsCurrent(state) && !isPaused) {
                            state.started = true;
                            trace('stream_playing', {fragment: state.currentIndex});
                        }
                    }).catch(error => streamFail(state, error, state.currentIndex));
                }
            }
        }
        if (state.nextAppendIdx >= sentences.length && !state.pendingFailure && !state.ended &&
            state.mediaSource.readyState === 'open' && !sourceBuffer.updating) {
            try {
                state.mediaSource.endOfStream();
                state.ended = true;
                trace('stream_end_of_stream', {fragments: state.appended.length});
            } catch (error) { streamFail(state, error, state.currentIndex); return; }
        }
        updateContinuousPosition(state);
        pumpContinuous(state);
    }

    function trimContinuousBuffer(state) {
        const sourceBuffer = state.sourceBuffer;
        if (!sourceBuffer || sourceBuffer.updating || state.pendingRemove !== null ||
            state.mediaSource.readyState !== 'open') return;
        const cutoff = state.player.currentTime - STREAM_RETAIN_SECONDS;
        const start = streamBufferedStart(sourceBuffer);
        if (cutoff <= start || cutoff - state.lastRemovedTo < 2) return;
        try {
            state.pendingRemove = cutoff;
            sourceBuffer.remove(start, cutoff);
            trace('stream_remove_start', {from_seconds: start, to_seconds: cutoff});
        } catch (error) {
            state.pendingRemove = null;
            streamFail(state, error, state.currentIndex);
        }
    }

    function updateContinuousPosition(state) {
        if (!streamStateIsCurrent(state)) return;
        const time = state.player.currentTime;
        let currentSegment = state.appended.find(segment => time >= segment.start && time < segment.end);
        if (currentSegment) setCurrentSentenceVisual(currentSegment.idx);
        else {
            const last = state.appended[state.appended.length - 1];
            if (last && time >= last.end - 0.05 && last.idx + 1 < sentences.length) {
                const next = nextSpeakableIndex(last.idx + 1);
                if (next < sentences.length) setCurrentSentenceVisual(next);
            }
        }
        state.currentIndex = currentIdx;
        if (diagnostics) {
            diagnostics.stream.buffered_bytes = state.bufferedBytes;
            diagnostics.stream.buffered_seconds = Math.max(0, streamBufferedEnd(state.sourceBuffer) - time);
        }
        saveResumeProgress(false);
        trimContinuousBuffer(state);
        pumpContinuous(state);
    }

    function handleContinuousWaiting(state) {
        if (!streamStateIsCurrent(state)) return;
        const bufferedEnd = streamBufferedEnd(state.sourceBuffer);
        const remaining = bufferedEnd - state.player.currentTime;
        const nearBufferEnd = remaining <= Math.max(0.5, (state.player.playbackRate || 1) * 0.5);
        state.waitingForData = nearBufferEnd;
        trace('stream_waiting', {fragment: state.currentIndex,
            buffered_seconds: Math.max(0, remaining), boundary_demand: nearBufferEnd});
        if (state.pendingFailure && nearBufferEnd) {
            const failure = state.pendingFailure;
            state.pendingFailure = null;
            streamFail(state, failure.error, failure.idx);
            return;
        }
        pumpContinuous(state);
    }

    async function pumpContinuous(state) {
        if (!streamStateIsCurrent(state) || !state.sourceBuffer || state.sourceBuffer.updating || state.pumping || state.pendingFailure) return;
        state.pumping = true;
        try {
            while (streamStateIsCurrent(state) && !state.sourceBuffer.updating) {
                const idx = state.nextAppendIdx;
                if (idx >= sentences.length) break;
                // In buffer=0 mode only synthesize the next sentence after the
                // media element reports starvation. timeupdate may lag the edge.
                const boundaryDemand = bufferMode === 0 && state.waitingForData &&
                    idx === state.currentIndex + 1;
                if (idx > state.currentIndex + bufferMode && !boundaryDemand) break;
                if (!sentences[idx].trim()) {
                    state.nextAppendIdx++;
                    continue;
                }
                const audioUrl = await fetchAudioBlob(idx, controller.signal, idx === state.currentIndex || boundaryDemand);
                if (!streamStateIsCurrent(state)) return;
                if (!audioUrl) throw new Error('Brak miejsca na fragment audio.');
                const job = [...prefetchCache.values()].find(candidate => candidate.url === audioUrl);
                if (!job?.blob) throw new Error('Brak danych audio do dopisania.');
                if (state.bufferedBytes > 0 && state.bufferedBytes + job.bytes > STREAM_BUFFER_MAX_BYTES) break;
                const data = await job.blob.arrayBuffer();
                if (!streamStateIsCurrent(state)) return;
                state.pendingAppend = {idx, bytes: job.bytes, job};
                if (diagnostics) trace('stream_append_start', {fragment: idx, byte_length: job.bytes});
                state.sourceBuffer.appendBuffer(data);
                break;
            }
        } catch (error) {
            if (!streamStateIsCurrent(state) || error?.name === 'AbortError') return;
            const failedIndex = state.nextAppendIdx;
            if (state.appended.length) {
                if (state.waitingForData) {
                    state.waitingForData = false;
                    streamFail(state, error, failedIndex);
                    return;
                }
                state.pendingFailure = {idx: failedIndex, error};
                trace('stream_error_waiting_for_buffer_end', {fragment: failedIndex, code: error?.name || 'stream_error'});
            } else streamFail(state, error, failedIndex);
        } finally {
            state.pumping = false;
            if (streamStateIsCurrent(state) && state.nextAppendIdx >= sentences.length && !state.pendingFailure &&
                !state.ended && state.mediaSource.readyState === 'open' && !state.sourceBuffer.updating) {
                try {
                    state.mediaSource.endOfStream();
                    state.ended = true;
                    trace('stream_end_of_stream', {fragments: state.appended.length});
                } catch (error) { streamFail(state, error, state.currentIndex); }
            }
        }
    }

    function startContinuousPlayback(idx) {
        idx = nextSpeakableIndex(idx);
        if (idx >= sentences.length) {
            window.stopReading();
            setStatus('Zakończono czytanie');
            return;
        }
        setCurrentSentenceVisual(idx, true);
        let supported = false;
        try { supported = typeof MediaSource === 'function' && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(STREAM_MIME); }
        catch {}
        if (diagnostics) {
            diagnostics.stream.mode = supported ? 'mse_initializing' : 'fallback';
            diagnostics.stream.is_type_supported = supported;
        }
        trace('stream_capability', {mime_type: STREAM_MIME, is_type_supported: supported});
        if (!supported) {
            trace('stream_fallback', {fragment: idx, reason: 'mime_not_supported'});
            playCurrent();
            return;
        }
        let state = null;
        try {
            const mediaSource = new MediaSource();
            state = {token: session, player: audio, mediaSource, sourceBuffer: null, objectUrl: null,
                currentIndex: idx, nextAppendIdx: idx, appended: [], timelineEnd: 0, bufferedBytes: 0,
                lastRemovedTo: 0, pendingAppend: null, pendingRemove: null, pendingFailure: null,
                pumping: false, playCalled: false, started: false, ended: false, cancelled: false,
                waitingForData: false};
            continuousPlayback = state;
            activePlayback = null;
            state.objectUrl = URL.createObjectURL(mediaSource);
            state.player.ontimeupdate = () => updateContinuousPosition(state);
            state.player.onwaiting = () => handleContinuousWaiting(state);
            state.player.onended = () => {
                if (!streamStateIsCurrent(state)) return;
                state.ended = true;
                trace('stream_ended', {fragments: state.appended.length});
                completeCurrentDocument();
                window.stopReading();
                setStatus('Zakończono czytanie');
            };
            state.player.onerror = () => streamFail(state, new Error('Nie można odtworzyć strumienia MP3.'), state.currentIndex);
            mediaSource.addEventListener('sourceopen', () => {
                if (!streamStateIsCurrent(state)) return;
                try {
                    state.sourceBuffer = mediaSource.addSourceBuffer(STREAM_MIME);
                    state.sourceBuffer.mode = 'sequence';
                    state.sourceBuffer.addEventListener('updateend', () => handleStreamUpdateEnd(state));
                    state.sourceBuffer.addEventListener('error', () => streamFail(state, new Error('SourceBuffer append failed.'), state.currentIndex));
                    if (diagnostics) diagnostics.stream.mode = 'mse';
                    trace('stream_open', {mime_type: STREAM_MIME, mode: state.sourceBuffer.mode});
                    pumpContinuous(state);
                } catch (error) { streamFail(state, error, state.currentIndex); }
            }, {once: true});
            state.player.src = state.objectUrl;
            isReading = true;
            ready = false;
            loading = true;
            if (mediaSource.readyState === 'open') mediaSource.dispatchEvent(new Event('sourceopen'));
        } catch (error) {
            if (state && streamStateIsCurrent(state)) streamFail(state, error, idx);
            else {
                if (diagnostics) { diagnostics.stream.mode = 'fallback'; diagnostics.stream.last_error = error?.name || 'setup_error'; }
                trace('stream_fallback', {fragment: idx, reason: error?.name || 'setup_error'});
                playCurrent();
            }
        }
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
            if (activeTab === 'reader') activeEl.scrollIntoView({behavior: 'smooth', block: 'center'});
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
            player.ontimeupdate = () => { if (token === session && currentIdx === idx) saveResumeProgress(false); };
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
                if (currentIdx >= sentences.length) {
                    completeCurrentDocument();
                    window.stopReading();
                    setStatus('Zakończono czytanie');
                    return;
                }
                saveResumeProgress(true);
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
        if (currentDocument) currentDocument.completed = false;
        saveResumeProgress(true);
        isReading = true;
        setMediaPlaybackState('playing');
        document.getElementById('playBtn').innerText = '⏸';
        document.querySelectorAll('.sentence').forEach(el => el.classList.remove('active'));
        const activeEl = document.getElementById('sent-' + idx);
        if (activeEl) {
            activeEl.classList.add('active');
            if (activeTab === 'reader') activeEl.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
        document.getElementById('progressBar').style.width = (((idx + 1) / sentences.length) * 100) + '%';
        setStatus(`Czytanie zdania ${idx + 1} z ${sentences.length}`);
        startContinuousPlayback(idx);
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
            saveResumeProgress(true);
            document.getElementById('playBtn').innerText = '▶';
            setStatus('Wstrzymano');
        } else {
            isPaused = false;
            setMediaPlaybackState('playing');
            document.getElementById('playBtn').innerText = '⏸';
            if (continuousPlayback && continuousPlayback.token === session) {
                // Resume background synthesis jobs that could not run while paused.
                pumpQueue();
                if (continuousPlayback.playCalled) {
                    continuousPlayback.player.play().catch(error => streamFail(continuousPlayback, error, currentIdx));
                } else pumpContinuous(continuousPlayback);
            }
            else if (ready) playReady(session);
            else if (!loading) playCurrent();
            else showGenerationStatus();
        }
    };

    window.stopReading = function() {
        resumeUserAction++;
        finishTransition('cancelled');
        trace('stop');
        saveResumeProgress(true);
        finishListeningSession(currentDocument?.completed ? 'completed' : 'stopped');
        const previousStream = continuousPlayback;
        continuousPlayback = null;
        if (previousStream) {
            previousStream.cancelled = true;
            if (previousStream.sourceBuffer?.updating) {
                try { previousStream.sourceBuffer.abort(); } catch {}
            }
        }
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
        if (previousStream?.objectUrl) URL.revokeObjectURL(previousStream.objectUrl);
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

    if (typeof window.addEventListener === 'function')
        window.addEventListener('pagehide', () => { saveResumeProgress(true); finishListeningSession('interrupted'); });
    if (typeof document.addEventListener === 'function')
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveResumeProgress(true);
        });
    restoreSavedDocument();

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
        updateMiniPlayer();
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
