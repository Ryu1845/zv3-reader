// Estimate when each sentence of a chunk starts, from the chunk's 10 ms loudness track.
//
// Expected start times come from character counts (with a bonus per sentence for the pause after it). Pauses
// (>= 120 ms well below the speech level) are then matched to sentence boundaries by a monotonic DP that may leave
// boundaries unmatched; unmatched ones are interpolated between matched neighbours.

const FRAME_SEC = 0.01;
const PAUSE_BONUS_CHARS = 8;
const MIN_PAUSE_FRAMES = 12;
const SKIP_COST = 1.2;     // seconds-equivalent cost of leaving a boundary without a pause

// energy: dB per 10 ms frame (array-like); sents: [[start, end]] char spans; totalSec: exact or estimated duration.
// Returns sentence start times in seconds (first is 0).
export function sentenceStarts(energy, sents, totalSec) {
  const m = sents.length;
  if (m <= 1) return [0];
  const w = sents.map(([s, e]) => (e - s) + PAUSE_BONUS_CHARS);
  const W = w.reduce((a, b) => a + b, 0);
  const cum = [0];
  for (let i = 0; i < m; i++) cum.push(cum[i] + w[i]);
  const expected = j => totalSec * cum[j] / W;           // boundary j = start of sentence j (1..m-1)

  const pauses = findPauses(energy);
  const B = m - 1, P = pauses.length;
  const maxDev = Math.max(2, totalSec * 0.25);
  // dp[j][k]: best cost for the first j boundaries using pauses among the first k.
  const INF = 1e18;
  const dp = Array.from({length: B + 1}, () => new Float64Array(P + 1).fill(INF));
  const how = Array.from({length: B + 1}, () => new Int8Array(P + 1));   // 0 skip pause, 1 skip boundary, 2 match
  for (let k = 0; k <= P; k++) dp[0][k] = 0;
  for (let j = 1; j <= B; j++) {
    const e = expected(j);
    for (let k = 0; k <= P; k++) {
      let best = dp[j - 1][k] + SKIP_COST, h = 1;
      if (k > 0 && dp[j][k - 1] < best) { best = dp[j][k - 1]; h = 0; }
      if (k > 0) {
        const d = Math.abs(pauses[k - 1] - e);
        if (d <= maxDev && dp[j - 1][k - 1] + d < best) { best = dp[j - 1][k - 1] + d; h = 2; }
      }
      dp[j][k] = best; how[j][k] = h;
    }
  }
  const match = new Array(B + 1).fill(null);
  for (let j = B, k = P; j > 0;) {
    const h = how[j][k];
    if (h === 2) { match[j] = pauses[k - 1]; j--; k--; } else if (h === 1) j--; else k--;
  }

  // Anchors: start (0 s at weight 0), matched boundaries, end (totalSec at weight W).
  const anchors = [[0, 0]];
  for (let j = 1; j <= B; j++) if (match[j] != null) anchors.push([cum[j], match[j]]);
  anchors.push([W, Math.max(totalSec, anchors[anchors.length - 1][1])]);
  const starts = [0];
  let ai = 0;
  for (let j = 1; j <= B; j++) {
    if (match[j] != null) { starts.push(match[j]); continue; }
    while (ai + 1 < anchors.length && anchors[ai + 1][0] < cum[j]) ai++;
    const [w0, t0] = anchors[ai], [w1, t1] = anchors[Math.min(ai + 1, anchors.length - 1)];
    starts.push(w1 > w0 ? t0 + (t1 - t0) * (cum[j] - w0) / (w1 - w0) : t0);
  }
  for (let j = 1; j < starts.length; j++) if (starts[j] < starts[j - 1]) starts[j] = starts[j - 1];
  return starts;
}

// Centres (seconds) of silences inside the speech, excluding leading and trailing silence.
export function findPauses(energy) {
  const n = energy.length;
  if (n < MIN_PAUSE_FRAMES * 2) return [];
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.9)];
  const thr = Math.max(-65, loud - 28);
  const out = [];
  let first = 0;
  while (first < n && energy[first] < thr) first++;
  let i = first;
  while (i < n) {
    if (energy[i] >= thr) { i++; continue; }
    let j = i;
    while (j < n && energy[j] < thr) j++;
    if (j < n && j - i >= MIN_PAUSE_FRAMES) out.push(((i + j) / 2) * FRAME_SEC);
    i = j;
  }
  return out;
}

export function sentenceAt(starts, t) {
  let s = 0;
  for (let j = 1; j < starts.length; j++) if (starts[j] <= t + 0.05) s = j; else break;
  return s;
}
