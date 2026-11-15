'use strict';
importScripts('/ocr-probe-assets/metrics.js');
self.onmessage = event => {
  try {
    self.postMessage({id: event.data.id, ...self.ocrProbeMetrics.score(event.data.reference, event.data.recognized)});
  } catch {
    self.postMessage({id: event.data.id, quality: null, error: 'calculation_failed'});
  }
};
