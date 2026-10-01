// ─────────────────────────────────────────────────────────────────────────────
// utils/transcript.js: the time offset adjustment for a chunk's transcript.
//
// The Blackbox only ever sees one chunk, so its timestamps start at 0 for every
// chunk. To put them on the whole file's timeline, add the chunk's start_sec:
//
//   chunk 001 = 14.793 s → 74.793 s of the file
//   Blackbox says a word starts at 5.0 s → in the whole file it starts at 19.793 s
//
// Chunk 000 has start_sec 0, so its times stay the same.
// This works because worker 1 cuts the chunks back to back: each chunk's
// start_sec is the sum of the lengths of the chunks before it.
//
// Plain arithmetic, no I/O. Used by: workers/chunk-processing.worker.js
// ─────────────────────────────────────────────────────────────────────────────

// Return a copy of the Blackbox result with every segment and word time shifted
// by offset_sec. The result also records the offset it was given.
export function offsetTimestamps(result, offset_sec) {
  // Words WhisperX couldn't align have no times (null); they stay null.
  // Rounded to ms, so float noise like 19.793000000000003 doesn't appear.
  const shift = (t) => (t == null ? t : Math.round((t + offset_sec) * 1000) / 1000);

  return {
    ...result,
    offset_sec,
    segments: result.segments.map((segment) => ({
      ...segment,
      start: shift(segment.start),
      end: shift(segment.end),
      words: segment.words.map((word) => ({ ...word, start: shift(word.start), end: shift(word.end) })),
    })),
  };
}
