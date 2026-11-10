import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLang, pickLang, guessFromScript} from '../shared/lang.js';
import {splitSentences} from '../shared/segment.js';
import {buildChunks, splitLong, maxSecondsFor, HARD_CHARS} from '../shared/chunker.js';
import {hostMatches, isListed} from '../shared/settings.js';

test('mapLang maps BCP 47 tags to server codes', () => {
  assert.equal(mapLang('en'), 'en_us');
  assert.equal(mapLang('en-US'), 'en_us');
  assert.equal(mapLang('en-GB'), 'en_gb');
  assert.equal(mapLang('en_AU'), 'en_gb');
  assert.equal(mapLang('zh-Hans-CN'), 'cmn');
  assert.equal(mapLang('pt-PT'), 'pt_br');
  assert.equal(mapLang('fr-CA'), 'fr_fr');
  assert.equal(mapLang('hi-IN'), 'hi');
  assert.equal(mapLang('in'), 'id');
  assert.equal(mapLang('ru'), 'ru');
  assert.equal(mapLang('nl'), null);
  assert.equal(mapLang(''), null);
});

test('pickLang: override > confident CLD3 disagreement > html lang > CLD3 > script', () => {
  assert.equal(pickLang({override: 'ja', tag: 'en'}).lang, 'ja');
  const cldJa = {isReliable: true, languages: [{language: 'ja', percentage: 95}]};
  assert.equal(pickLang({override: 'auto', tag: 'en', cld: cldJa}).lang, 'ja');
  const cldWeak = {isReliable: false, languages: [{language: 'ja', percentage: 60}]};
  assert.equal(pickLang({override: 'auto', tag: 'en-GB', cld: cldWeak}).lang, 'en_gb');
  assert.equal(pickLang({tag: '', cld: {isReliable: true, languages: [{language: 'de', percentage: 99}]}}).lang, 'de');
  assert.equal(pickLang({tag: '', cld: null, text: 'これは日本語のテキストです。ひらがなとカタカナ。'}).lang, 'ja');
  const r = pickLang({tag: 'nl', cld: null, text: 'Dit is Nederlands'});
  assert.equal(r.lang, 'en_us');
  assert.equal(r.unsupported, true);
  assert.equal(guessFromScript('한국어 텍스트입니다 한국어 텍스트입니다'), 'ko');
  assert.equal(guessFromScript('Это русский текст. Это русский текст.'), 'ru');
});

test('splitSentences keeps abbreviations together and trims spans', () => {
  const text = '  Dr. Smith went to Washington. He met the U.S. president at 3 p.m. on Friday!  Then he left.';
  const spans = splitSentences(text, 'en_us').map(s => text.slice(s.start, s.end));
  assert.deepEqual(spans, [
    'Dr. Smith went to Washington.',
    'He met the U.S. president at 3 p.m. on Friday!  Then he left.',
  ]);
});

test('splitSentences merges very short fragments into a neighbour', () => {
  const text = 'Yes. This is a much longer sentence that follows. No.';
  const spans = splitSentences(text, 'en_us').map(s => text.slice(s.start, s.end));
  assert.equal(spans.length, 1);
  assert.equal(spans[0], text);
});

test('splitSentences handles CJK punctuation', () => {
  const text = '今日は良い天気ですね。散歩に行きましょうか、それとも家で本を読みましょうか。明日は雨が降るそうです。';
  const spans = splitSentences(text, 'ja');
  assert.ok(spans.length >= 2, `got ${spans.length}`);
});

const para = (n, words = 12) => ({sents: Array.from({length: n}, (_, i) => ({
  text: `Sentence ${i} has ${'some words '.repeat(words).trim()}.`, ref: i,
}))});

test('buildChunks ramps 8 s / 18 s / 40 s and never splits sentences', () => {
  const blocks = Array.from({length: 8}, () => para(5));
  const chunks = buildChunks(blocks, {lang: 'en_us'});
  assert.ok(chunks.length > 4);
  const rate = 0.062;
  // first chunk is one or two sentences, close to 8 s
  assert.ok(chunks[0].sents.length <= 2);
  assert.ok(chunks[0].estSec <= 8 || chunks[0].sents.length === 1);
  assert.ok(chunks[1].estSec <= 18 + 1e-9 || chunks[1].sents.length === 1);
  for (const c of chunks.slice(2)) assert.ok(c.text.length * rate <= 40 + 1e-9, `chunk ${c.id} too long: ${c.estSec}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= HARD_CHARS);
    assert.equal(c.sents.length, c.refs.length);
    for (const [s, e] of c.sents) assert.match(c.text.slice(s, e), /^Sentence \d+ has .*\.$/);
    assert.equal(c.maxSeconds, maxSecondsFor(c.estSec));
  }
  const total = chunks.reduce((n, c) => n + c.sents.length, 0);
  assert.equal(total, 40);
});

test('buildChunks closes chunks at paragraph boundaries when the next paragraph will not fit', () => {
  // ~25 s paragraphs: after the ramp, each 40 s chunk should hold exactly one whole paragraph
  const blocks = Array.from({length: 5}, () => para(3, 11));
  const chunks = buildChunks(blocks, {lang: 'en_us'});
  assert.equal(chunks.length, 6);
  for (const c of chunks.slice(2)) { assert.equal(c.text.slice(0, 10), 'Sentence 0'); assert.equal(c.sents.length, 3); }
});

test('buildChunks adds a period to headings and keeps refs', () => {
  const chunks = buildChunks([{heading: true, sents: [{text: 'Introduction', ref: 'h'}]}, para(1)], {lang: 'en_us'});
  assert.ok(chunks[0].text.startsWith('Introduction.'));
  assert.equal(chunks[0].refs[0], 'h');
});

test('buildChunks splits over-long sentences, and CJK chunks stay under the max_seconds cap', () => {
  const long = Array.from({length: 120}, (_, i) => `clause number ${i}`).join(', ') + '.';
  const chunks = buildChunks([{sents: [{text: long, ref: 'x'}]}], {lang: 'en_us'});
  assert.ok(chunks.length > 1);
  for (const c of chunks) { assert.ok(c.text.length <= HARD_CHARS); assert.ok(c.maxSeconds <= 180); }
  const cjk = '日本語の文章'.repeat(300) + '。';
  const cc = buildChunks([{sents: [{text: cjk, ref: 'y'}]}], {lang: 'cmn'});
  for (const c of cc) { assert.ok(c.estSec <= 100 + 1e-9, `est ${c.estSec}`); assert.ok(c.maxSeconds <= 180); }
  assert.equal(cc.map(c => c.text).join(''), cjk);
});

test('splitLong prefers clause punctuation, then whitespace', () => {
  assert.deepEqual(splitLong('aaaa; bbbb; cccc', 10), ['aaaa;', 'bbbb; cccc']);
  const parts = splitLong('word '.repeat(50).trim(), 30);
  for (const p of parts) assert.ok(p.length <= 30);
  assert.equal(parts.join(' '), 'word '.repeat(50).trim());
});

test('hostMatches supports subdomains and wildcards', () => {
  assert.ok(hostMatches('mail.google.com', 'mail.google.com'));
  assert.ok(hostMatches('a.b.example.com', 'example.com'));
  assert.ok(!hostMatches('notexample.com', 'example.com'));
  assert.ok(hostMatches('outlook.office365.com', 'outlook.*'));
  assert.ok(isListed('app.slack.com', ['x.com', 'app.slack.com']));
  assert.ok(!isListed('en.wikipedia.org', ['mail.google.com']));
});
