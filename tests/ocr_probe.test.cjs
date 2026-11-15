const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {distance, score, MAX_CELLS} = require('../ocr_prototype/metrics.js');
const source = fs.readFileSync('ocr_prototype/probe.js', 'utf8');

assert.equal(distance('kot', 'kot'), 0);
assert.equal(distance('kot', 'koc'), 1);
assert.equal(score('Zażółć gęślą', 'zażółć gęślą').quality.cer, 0);
assert.equal(score('Ala ma kota', 'Ala ma psa').quality.wer, 1 / 3);
assert.equal(score('zażółć', 'zazólc').quality.cer, 3 / 6);
assert.equal(score('e\u0301', 'é').quality.cer, 0);
assert.equal(score(' Ala\n\tma   kota ', 'ala ma kota').quality.wer, 0);
assert.equal(score('', 'tekst').error, 'empty_reference');
assert.equal(score('tekst', '').quality.cer, 1);
assert.equal(score('a'.repeat(5001), 'a').error, 'text_limit');
assert.equal(score('a'.repeat(3000), 'b'.repeat(3000)).error, 'complexity_limit');
assert.equal(score('abc '.repeat(150), 'abc '.repeat(150)).quality.cer, 0);
assert.equal(MAX_CELLS, 4000000);
assert.ok(!source.includes("fetch('/upload'"));
const metricWorkerSource = fs.readFileSync('ocr_prototype/metrics-worker.js', 'utf8');
const metricMessages = [];
const workerContext = vm.createContext({self: {ocrProbeMetrics: {score}, postMessage: message => metricMessages.push(message)},
  importScripts: path => assert.equal(path, '/ocr-probe-assets/metrics.js')});
vm.runInContext(metricWorkerSource, workerContext);
workerContext.self.onmessage({data: {id: 7, reference: 'a'.repeat(3000), recognized: 'b'.repeat(3000)}});
assert.equal(metricMessages[0].error, 'complexity_limit');
assert.equal(metricMessages[0].id, 7);

function harness({deferRecognition = false} = {}) {
  const listeners = {};
  const elements = {};
  const ocrWorkers = [];
  const metricWorkers = [];
  let pendingResolve;
  const canvas = {width: 0, height: 0, getContext: () => ({fillRect() {}, drawImage() {}, getImageData() { return {data: []}; }, putImageData() {}})};
  for (const id of ['photo', 'run', 'cancel', 'score', 'export', 'result', 'reference', 'status', 'measurements', 'category', 'grayscale']) {
    elements[id] = {value: '', checked: false, disabled: false, textContent: '', addEventListener(name, fn) { listeners[`${id}.${name}`] = fn; }};
  }
  elements.preview = canvas;
  elements.category.value = 'print';
  const context = vm.createContext({
    document: {getElementById: id => elements[id]},
    performance: {now: (() => { let n = 0; return () => ++n; })()},
    location: {origin: 'https://example.test'},
    createImageBitmap: async () => ({width: 300, height: 200, close() {}}),
    setTimeout, clearTimeout,
    addEventListener(name, fn) { listeners[`global.${name}`] = fn; },
    Tesseract: {async createWorker() {
      const worker = {terminated: false, async terminate() { this.terminated = true; },
        recognize() { return deferRecognition ? new Promise(resolve => { pendingResolve = resolve; }) : Promise.resolve({data: {text: 'tekst'}}); }};
      ocrWorkers.push(worker); return worker;
    }},
    Worker: class {
      constructor(path) { assert.equal(path, '/ocr-probe-assets/metrics-worker.js'); this.terminated = false; metricWorkers.push(this); }
      postMessage(data) { this.data = data; }
      terminate() { this.terminated = true; }
    }
  });
  vm.runInContext(source, context);
  return {listeners, elements, ocrWorkers, metricWorkers,
    choose: file => listeners['photo.change']({target: {files: [file]}}),
    completeRecognition: () => pendingResolve({data: {text: 'spóźniony tekst'}}),
    measurements: () => JSON.parse(elements.measurements.textContent)};
}

(async () => {
  const h = harness();
  await h.choose({size: 100}); await h.listeners['run.click']();
  await h.choose({size: 200}); await h.listeners['run.click']();
  assert.equal(h.ocrWorkers.length, 1, 'choosing another photo must reuse idle OCR worker');
  const [first, second] = h.measurements();
  assert.equal(first.cold, true); assert.equal(first.workerReused, false);
  assert.equal(second.cold, false); assert.equal(second.workerReused, true);
  assert.equal(second.image, 2); assert.equal(first.networkCache, 'not-observed');
  assert.equal(second.networkCache, 'worker-reused-no-fetch');
  assert.equal(second.variant, 'original'); assert.equal(second.status, 'success');
  assert.equal(second.error, null);
  h.elements.reference.value = 'tekst'; h.listeners['score.click']();
  assert.equal(h.metricWorkers.length, 1);
  assert.equal(h.measurements()[1].cer, undefined, 'score is dispatched instead of calculated on UI thread');
  h.metricWorkers[0].onmessage({data: {quality: {cer: 0, wer: 0}, error: null}});
  assert.equal(h.measurements()[1].cer, 0);
  h.elements.reference.value = 'a'.repeat(5001);
  h.listeners['score.click']();
  assert.equal(h.metricWorkers.length, 1, 'oversize input is rejected before copying into worker');
  assert.equal(h.measurements()[1].scoreError, 'text_limit');
  assert.equal(h.measurements()[1].cer, undefined, 'old score is cleared when reference changes');
  h.elements.reference.value = 'tekst';
  h.listeners['score.click']();
  h.metricWorkers[1].onmessage({data: {quality: {cer: 0, wer: 0}, error: null}});
  h.listeners['score.click']();
  const staleScore = h.metricWorkers[2];
  await h.choose({size: 300});
  assert.equal(staleScore.terminated, true, 'image change cancels a pending metric calculation');
  staleScore.onmessage({data: {quality: {cer: 1, wer: 1}, error: null}});
  assert.equal(h.measurements()[1].cer, undefined, 'late score cannot overwrite the prior sample');
  assert.equal(h.measurements()[1].scoreError, 'cancelled');
  h.listeners['cancel.click']();
  assert.equal(h.ocrWorkers[0].terminated, true);
  h.elements.reference.value = '';
  await h.listeners['run.click']();
  assert.equal(h.ocrWorkers.length, 2);
  assert.equal(h.measurements()[2].cold, true);

  const active = harness({deferRecognition: true});
  await active.choose({size: 100});
  const oldRun = active.listeners['run.click']();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(active.ocrWorkers.length, 1);
  await active.choose({size: 200});
  assert.equal(active.ocrWorkers[0].terminated, true, 'active OCR must be terminated before new image');
  active.completeRecognition(); await oldRun;
  assert.equal(active.elements.result.value, '', 'late result must not update UI');
  assert.equal(active.measurements()[0].status, 'cancelled');
  const newRun = active.listeners['run.click']();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(active.ocrWorkers.length, 2, 'new image gets fresh worker after active cancellation');
  active.completeRecognition(); await newRun;
  assert.equal(active.measurements()[1].cold, true);
  console.log('OCR probe metrics, worker lifecycle and privacy guard: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
