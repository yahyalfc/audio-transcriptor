// ─────────────────────────────────────────────────────────────────────────────
// utils/transcript.js: chunk transcripts → one transcription.
//
//   offsetTimestamps  shifts one chunk's times onto the whole file's timeline
//   mergeTranscripts  combines all of a job's chunks into the final transcription
//
// ── The time offset ──
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

// ── mergeTranscripts ────────────────────────────────────────────────────────
// Combine a job's chunk transcripts (already offset, in chunk order) into the one
// transcription that /status returns:
//
//   { language, duration, text, segments: [{ id, start, end, text }] }
//
// - language: the language most chunks detected (each chunk detects its own)
// - duration: the length of the whole audio in seconds
// - segments: every chunk's segments one after the other, numbered 0, 1, 2, ...
//             (word timings stay in the per-chunk files, to keep /status small)
// - text:     all segment texts joined, the transcript as one readable string
export function mergeTranscripts(transcripts, duration) {
  const segments = transcripts
    .flatMap((transcript) => transcript.segments)
    .map((segment, id) => ({ id, start: segment.start, end: segment.end, text: segment.text }));

  return {
    language: mostCommon(transcripts.map((transcript) => transcript.language)),
    duration,
    text: segments.map((segment) => segment.text).join(' '),
    segments,
  };
}

// The value that appears most often in a list, e.g. ['en', 'en', 'fr'] → 'en'.
function mostCommon(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.keys(counts).reduce((best, value) => (counts[value] > counts[best] ? value : best));
}
