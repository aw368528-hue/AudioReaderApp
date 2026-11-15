(function (root) {
  'use strict';
  const MAX_TEXT_LENGTH = 5000;
  const MAX_CELLS = 4000000;

  function distance(left, right) {
    let a = Array.from(left), b = Array.from(right);
    if (a.length > b.length) [a, b] = [b, a];
    let row = Array.from({length: a.length + 1}, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      const next = [j];
      for (let i = 1; i <= a.length; i++)
        next[i] = Math.min(next[i - 1] + 1, row[i] + 1, row[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[a.length];
  }

  function score(reference, recognized) {
    if (reference.length > MAX_TEXT_LENGTH || recognized.length > MAX_TEXT_LENGTH)
      return {quality: null, error: 'text_limit'};
    const normalize = value => value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
    const expected = normalize(reference), actual = normalize(recognized);
    if (!expected) return {quality: null, error: 'empty_reference'};
    const characters = Array.from(expected), actualCharacters = Array.from(actual);
    const words = expected.split(' '), actualWords = actual ? actual.split(' ') : [];
    if (characters.length * actualCharacters.length > MAX_CELLS || words.length * actualWords.length > MAX_CELLS)
      return {quality: null, error: 'complexity_limit'};
    return {quality: {
      cer: distance(characters, actualCharacters) / characters.length,
      wer: distance(words, actualWords) / words.length,
      referenceCharacters: characters.length, referenceWords: words.length
    }, error: null};
  }
  const api = {distance, score, MAX_TEXT_LENGTH, MAX_CELLS};
  root.ocrProbeMetrics = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
