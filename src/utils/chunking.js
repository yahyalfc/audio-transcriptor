// ─────────────────────────────────────────────────────────────────────────────
// utils/chunking.js: decides where to cut the audio into chunks.
//
// Pure logic: it only does arithmetic on numbers, no files and no ffmpeg,
// so it is easy to read and to test on its own.
//
//   planChunks(374, silences, { target_sec: 30, max_sec: 60, min_sec: 10 })
//   → [{ index: 0, start_sec: 0, end_sec: 29.7 }, { index: 1, start_sec: 29.7, ... }, ...]
//
// Used by: workers/job-processing.worker.js (service worker 1)
// ─────────────────────────────────────────────────────────────────────────────

// How a cut is chosen:
//   - Each chunk should be about `target_sec` long, never longer than `max_sec`,
//     and (except the last one) not shorter than `min_sec`.
//   - Among the pauses that would give a chunk length between min and max,
//     cut in the middle of the pause closest to the target length.
//   - No pause in that range (e.g. music, or someone talking non-stop):
//     cut at max_sec anyway, so no chunk is ever too long.
export function planChunks(duration, silences, { target_sec, max_sec, min_sec }) {
  const chunks = [];
  let start = 0;

  // Keep cutting while what's left is longer than one chunk may be.
  while (duration - start > max_sec) {
    // Middle points of the pauses that fall inside the allowed range for this chunk.
    const candidates = silences
      .map((s) => (s.start + s.end) / 2)
      .filter((mid) => mid >= start + min_sec && mid <= start + max_sec);

    // The pause closest to the target length, or the fallback hard cut at max_sec.
    let cut = start + max_sec;
    if (candidates.length) {
      const target = start + target_sec;
      cut = candidates.reduce((best, mid) => (Math.abs(mid - target) < Math.abs(best - target) ? mid : best));
    }

    chunks.push({ index: chunks.length, start_sec: round(start), end_sec: round(cut) });
    start = cut;
  }

  // Whatever is left becomes the last chunk.
  chunks.push({ index: chunks.length, start_sec: round(start), end_sec: round(duration) });
  return chunks;
}

// Round to milliseconds, so the numbers stored in Redis stay readable.
function round(sec) {
  return Math.round(sec * 1000) / 1000;
}
