import test from 'node:test';
import assert from 'node:assert/strict';

import { NOTES, INTERVALS, createGenerator, transpose } from '../js/music.js';

/* ------------------------------------------------------------------ *
 * Deterministic PRNG (mulberry32). Assertions never touch Math.random.
 * ------------------------------------------------------------------ */
function seeded(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_INTERVAL_IDS = INTERVALS.map((iv) => iv.id);
const DEFAULT_INTERVAL_IDS = INTERVALS.filter((iv) => iv.defaultOn).map((iv) => iv.id);

/** Draw `count` prompts from a fixed pool. */
function draw(gen, count, pools) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(gen.next(pools));
  return out;
}

/* ------------------------------------------------------------------ *
 * Pool shapes / exported surface
 * ------------------------------------------------------------------ */

test('NOTES is the 12 chromatic roots in the specified flat spelling', () => {
  assert.deepEqual(NOTES, ['A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab']);
  assert.equal(NOTES.length, 12);
  assert.equal(new Set(NOTES).size, 12);
});

test('INTERVALS has the 14 specified entries with exact ids, labels and semitones', () => {
  assert.deepEqual(INTERVALS, [
    { id: 'm2', label: 'Minor 2nd', semitones: 1, defaultOn: true },
    { id: 'M2', label: 'Major 2nd', semitones: 2, defaultOn: false },
    { id: 'm3', label: 'Minor 3rd', semitones: 3, defaultOn: true },
    { id: 'M3', label: 'Major 3rd', semitones: 4, defaultOn: true },
    { id: 'P4', label: 'Perfect 4th', semitones: 5, defaultOn: true },
    { id: 'TT', label: 'Tritone', semitones: 6, defaultOn: true },
    { id: 'P5', label: 'Perfect 5th', semitones: 7, defaultOn: true },
    { id: 'm6', label: 'Minor 6th', semitones: 8, defaultOn: true },
    { id: 'M6', label: 'Major 6th', semitones: 9, defaultOn: true },
    { id: 'm7', label: 'Minor 7th', semitones: 10, defaultOn: true },
    { id: 'M7', label: 'Major 7th', semitones: 11, defaultOn: true },
    { id: 'P8', label: 'Octave', semitones: 12, defaultOn: false },
    { id: 'm9', label: 'Minor 9th', semitones: 13, defaultOn: true },
    { id: 'M9', label: 'Major 9th', semitones: 14, defaultOn: true },
  ]);
  assert.equal(new Set(ALL_INTERVAL_IDS).size, 14);
  assert.deepEqual(DEFAULT_INTERVAL_IDS.length, 12);
  assert.deepEqual(
    INTERVALS.filter((iv) => !iv.defaultOn).map((iv) => iv.id),
    ['M2', 'P8'],
  );
});

test('module exports the documented functions', () => {
  assert.equal(typeof createGenerator, 'function');
  assert.equal(typeof transpose, 'function');
  const gen = createGenerator();
  assert.equal(typeof gen.next, 'function');
  assert.equal(typeof gen.reset, 'function');
});

/* ------------------------------------------------------------------ *
 * transpose
 * ------------------------------------------------------------------ */

test('transpose walks the chromatic scale', () => {
  assert.equal(transpose('A', 0), 'A');
  assert.equal(transpose('A', 1), 'Bb');
  assert.equal(transpose('A', 3), 'C');
  assert.equal(transpose('C', 4), 'E');
  assert.equal(transpose('C', 7), 'G');
  assert.equal(transpose('Bb', 8), 'Gb');
});

test('transpose wraps around the octave', () => {
  assert.equal(transpose('G', 5), 'C');
  assert.equal(transpose('Ab', 1), 'A');
  assert.equal(transpose('Ab', 5), 'Db');
  assert.equal(transpose('B', 11), 'Bb');
  for (const note of NOTES) assert.equal(transpose(note, 12), note);
});

test('transpose handles semitone counts above 12 (9ths)', () => {
  assert.equal(transpose('C', 13), 'Db'); // minor 9th
  assert.equal(transpose('C', 14), 'D'); // major 9th
  assert.equal(transpose('Bb', 13), 'B');
  assert.equal(transpose('Ab', 14), 'Bb');
  assert.equal(transpose('A', 25), 'Bb'); // two octaves + m2
});

test('transpose handles negative semitones', () => {
  assert.equal(transpose('A', -1), 'Ab');
  assert.equal(transpose('C', -3), 'A');
  assert.equal(transpose('A', -13), 'Ab');
});

test('transpose always spells results with names from NOTES', () => {
  for (const note of NOTES) {
    for (let s = 0; s <= 24; s++) assert.ok(NOTES.includes(transpose(note, s)));
  }
});

test('transpose rejects unknown notes and non-integer offsets', () => {
  assert.throws(() => transpose('H', 1), /unknown note/);
  assert.throws(() => transpose('', 1), /unknown note/);
  assert.throws(() => transpose('C', 1.5), /integer/);
});

/* ------------------------------------------------------------------ *
 * Prompt shape and text formatting
 * ------------------------------------------------------------------ */

test('next() returns the documented prompt shape', () => {
  const gen = createGenerator({ rng: seeded(1) });
  const p = gen.next({ notes: NOTES, intervals: DEFAULT_INTERVAL_IDS });
  assert.deepEqual(Object.keys(p).sort(), ['interval', 'note', 'targetNote', 'text']);
  assert.deepEqual(Object.keys(p.interval).sort(), ['id', 'label', 'semitones']);
  assert.ok(NOTES.includes(p.note));
  assert.ok(NOTES.includes(p.targetNote));
  assert.ok(DEFAULT_INTERVAL_IDS.includes(p.interval.id));
});

test('text is exactly "<note> <interval label>"', () => {
  const gen = createGenerator({ rng: seeded(7) });
  assert.equal(gen.next({ notes: ['Bb'], intervals: ['m6'] }).text, 'Bb Minor 6th');
  assert.equal(gen.next({ notes: ['C'], intervals: ['M3'] }).text, 'C Major 3rd');
  assert.equal(gen.next({ notes: ['Gb'], intervals: ['P5'] }).text, 'Gb Perfect 5th');
  assert.equal(gen.next({ notes: ['Ab'], intervals: ['TT'] }).text, 'Ab Tritone');
});

test('targetNote is the root transposed by the interval, for every combination', () => {
  const gen = createGenerator({ rng: seeded(3) });
  for (const note of NOTES) {
    for (const iv of INTERVALS) {
      const p = gen.next({ notes: [note], intervals: [iv.id] });
      assert.equal(p.note, note);
      assert.equal(p.interval.semitones, iv.semitones);
      assert.equal(p.targetNote, transpose(note, iv.semitones));
      assert.equal(p.text, `${note} ${iv.label}`);
    }
  }
});

test('prompts only ever use members of the passed pools', () => {
  const gen = createGenerator({ rng: seeded(99) });
  const notes = ['C', 'D', 'E'];
  const intervals = ['m3', 'P5'];
  for (const p of draw(gen, 200, { notes, intervals })) {
    assert.ok(notes.includes(p.note));
    assert.ok(intervals.includes(p.interval.id));
  }
});

/* ------------------------------------------------------------------ *
 * Selection rules
 * ------------------------------------------------------------------ */

test('never repeats the same note twice in a row', () => {
  for (const seed of [1, 2, 42, 12345]) {
    const gen = createGenerator({ rng: seeded(seed) });
    let prev = null;
    for (const p of draw(gen, 1000, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS })) {
      assert.notEqual(p.note, prev, `repeated note ${p.note} (seed ${seed})`);
      prev = p.note;
    }
  }
});

test('never repeats the same note+interval pair twice in a row', () => {
  const pools = [
    { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS },
    { notes: ['C', 'G'], intervals: ['P5', 'm3'] },
    { notes: ['C'], intervals: ['P5', 'm3', 'M7'] },
    { notes: ['C', 'G'], intervals: ['P5'] },
  ];
  for (const pool of pools) {
    const gen = createGenerator({ rng: seeded(2024) });
    let prev = null;
    for (const p of draw(gen, 500, pool)) {
      assert.notEqual(p.text, prev, `repeated pair "${p.text}"`);
      prev = p.text;
    }
  }
});

test('bag shuffle covers every note exactly once per cycle', () => {
  const gen = createGenerator({ rng: seeded(8) });
  for (let cycle = 0; cycle < 20; cycle++) {
    const seen = draw(gen, 12, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS }).map((p) => p.note);
    assert.deepEqual([...new Set(seen)].sort(), [...NOTES].sort(), `cycle ${cycle}`);
  }
});

test('bag shuffle gives even coverage of notes and intervals over many draws', () => {
  const reps = 40;
  const gen = createGenerator({ rng: seeded(555) });
  const noteCounts = new Map(NOTES.map((n) => [n, 0]));
  const intervalCounts = new Map(DEFAULT_INTERVAL_IDS.map((id) => [id, 0]));
  const total = NOTES.length * DEFAULT_INTERVAL_IDS.length * reps;
  for (const p of draw(gen, total, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS })) {
    noteCounts.set(p.note, noteCounts.get(p.note) + 1);
    intervalCounts.set(p.interval.id, intervalCounts.get(p.interval.id) + 1);
  }
  const expectNotes = total / NOTES.length;
  for (const [note, count] of noteCounts) {
    assert.ok(Math.abs(count - expectNotes) <= 1, `${note} drawn ${count}, expected ~${expectNotes}`);
  }
  const expectIntervals = total / DEFAULT_INTERVAL_IDS.length;
  for (const [id, count] of intervalCounts) {
    assert.ok(
      Math.abs(count - expectIntervals) <= 1,
      `${id} drawn ${count}, expected ~${expectIntervals}`,
    );
  }
});

test('a bag refill does not put the just-used item first', () => {
  // Two notes: an unguarded refill would repeat at every cycle boundary.
  for (const seed of [4, 5, 6, 7]) {
    const gen = createGenerator({ rng: seeded(seed) });
    let prev = null;
    for (const p of draw(gen, 200, { notes: ['C', 'G'], intervals: DEFAULT_INTERVAL_IDS })) {
      assert.notEqual(p.note, prev);
      prev = p.note;
    }
  }
});

/* ------------------------------------------------------------------ *
 * Degenerate pools
 * ------------------------------------------------------------------ */

test('a single-note pool just repeats that note, varying the interval', () => {
  const gen = createGenerator({ rng: seeded(11) });
  const prompts = draw(gen, 100, { notes: ['Eb'], intervals: DEFAULT_INTERVAL_IDS });
  let prev = null;
  for (const p of prompts) {
    assert.equal(p.note, 'Eb');
    assert.notEqual(p.interval.id, prev, 'single-note pool must still vary the interval');
    prev = p.interval.id;
  }
  assert.equal(new Set(prompts.map((p) => p.interval.id)).size, DEFAULT_INTERVAL_IDS.length);
});

test('a single-interval pool just repeats that interval, varying the note', () => {
  const gen = createGenerator({ rng: seeded(12) });
  const prompts = draw(gen, 100, { notes: NOTES, intervals: ['P5'] });
  let prev = null;
  for (const p of prompts) {
    assert.equal(p.interval.id, 'P5');
    assert.notEqual(p.note, prev);
    prev = p.note;
  }
});

test('single note and single interval degrade gracefully instead of throwing', () => {
  const gen = createGenerator({ rng: seeded(13) });
  for (const p of draw(gen, 25, { notes: ['F'], intervals: ['m7'] })) {
    assert.equal(p.text, 'F Minor 7th');
    assert.equal(p.targetNote, 'Eb');
  }
});

test('duplicate pool entries are tolerated and not over-weighted', () => {
  const gen = createGenerator({ rng: seeded(14) });
  const prompts = draw(gen, 60, { notes: ['C', 'C', 'G'], intervals: ['P5', 'P5'] });
  let prev = null;
  for (const p of prompts) {
    assert.ok(['C', 'G'].includes(p.note));
    assert.notEqual(p.note, prev);
    prev = p.note;
  }
});

/* ------------------------------------------------------------------ *
 * Empty pools
 * ------------------------------------------------------------------ */

test('empty pools throw', () => {
  const gen = createGenerator({ rng: seeded(15) });
  assert.throws(() => gen.next({ notes: [], intervals: DEFAULT_INTERVAL_IDS }), /note pool is empty/);
  assert.throws(() => gen.next({ notes: NOTES, intervals: [] }), /interval pool is empty/);
  assert.throws(() => gen.next({ notes: [], intervals: [] }), /empty/);
  assert.throws(() => gen.next({ notes: ['bogus'], intervals: ['P5'] }), /note pool is empty/);
  assert.throws(() => gen.next({ notes: NOTES, intervals: ['nope'] }), /interval pool is empty/);
});

test('missing or malformed arguments throw', () => {
  const gen = createGenerator({ rng: seeded(16) });
  assert.throws(() => gen.next(), /expected/);
  assert.throws(() => gen.next({}), /must be an array/);
  assert.throws(() => gen.next({ notes: 'C', intervals: ['P5'] }), /must be an array/);
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

test('the same seed produces the same sequence', () => {
  const pools = { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS };
  const a = draw(createGenerator({ rng: seeded(2718) }), 200, pools).map((p) => p.text);
  const b = draw(createGenerator({ rng: seeded(2718) }), 200, pools).map((p) => p.text);
  assert.deepEqual(a, b);
});

test('different seeds produce different sequences', () => {
  const pools = { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS };
  const a = draw(createGenerator({ rng: seeded(1) }), 50, pools).map((p) => p.text);
  const b = draw(createGenerator({ rng: seeded(2) }), 50, pools).map((p) => p.text);
  assert.notDeepEqual(a, b);
});

test('generators default to Math.random and still obey the rules', () => {
  const gen = createGenerator();
  let prev = null;
  for (const p of draw(gen, 100, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS })) {
    assert.ok(NOTES.includes(p.note));
    assert.notEqual(p.note, prev);
    prev = p.note;
  }
});

test('reset() clears the anti-repeat memory and restarts the bags', () => {
  const gen = createGenerator({ rng: seeded(31) });
  draw(gen, 5, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS });
  gen.reset();
  const seen = draw(gen, 12, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS }).map((p) => p.note);
  assert.deepEqual([...new Set(seen)].sort(), [...NOTES].sort());
});

/* ------------------------------------------------------------------ *
 * Pool changes between draws (user toggles notes off mid-session)
 * ------------------------------------------------------------------ */

test('shrinking the pool mid-session never yields a disabled note', () => {
  const gen = createGenerator({ rng: seeded(77) });
  draw(gen, 7, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS });

  const shrunk = ['C', 'D', 'E'];
  for (const p of draw(gen, 200, { notes: shrunk, intervals: DEFAULT_INTERVAL_IDS })) {
    assert.ok(shrunk.includes(p.note), `leaked disabled note ${p.note}`);
  }
});

test('shrinking the interval pool mid-session never yields a disabled interval', () => {
  const gen = createGenerator({ rng: seeded(78) });
  draw(gen, 9, { notes: NOTES, intervals: ALL_INTERVAL_IDS });

  const shrunk = ['m3', 'P5'];
  for (const p of draw(gen, 200, { notes: NOTES, intervals: shrunk })) {
    assert.ok(shrunk.includes(p.interval.id), `leaked disabled interval ${p.interval.id}`);
  }
});

test('shrinking to a single note keeps working and keeps pairs fresh', () => {
  const gen = createGenerator({ rng: seeded(79) });
  draw(gen, 6, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS });
  let prev = null;
  for (const p of draw(gen, 50, { notes: ['B'], intervals: DEFAULT_INTERVAL_IDS })) {
    assert.equal(p.note, 'B');
    assert.notEqual(p.text, prev);
    prev = p.text;
  }
});

test('growing the pool back brings the new notes into rotation', () => {
  const gen = createGenerator({ rng: seeded(80) });
  draw(gen, 30, { notes: ['C', 'G'], intervals: DEFAULT_INTERVAL_IDS });
  const seen = new Set(
    draw(gen, 24, { notes: NOTES, intervals: DEFAULT_INTERVAL_IDS }).map((p) => p.note),
  );
  assert.equal(seen.size, 12, 'all 12 notes should appear within two full cycles');
});

test('a pool that changes on every single draw stays legal', () => {
  const gen = createGenerator({ rng: seeded(81) });
  const rotations = [
    ['C', 'D', 'E'],
    ['F', 'G'],
    NOTES,
    ['Bb'],
    ['A', 'Ab', 'Gb', 'E'],
  ];
  let prev = null;
  for (let i = 0; i < 300; i++) {
    const notes = rotations[i % rotations.length];
    const p = gen.next({ notes, intervals: DEFAULT_INTERVAL_IDS });
    assert.ok(notes.includes(p.note), `leaked ${p.note} from pool [${notes}]`);
    if (prev !== null && notes.length > 1) assert.notEqual(p.note, prev);
    prev = p.note;
  }
});

test('toggling a note off while it is the last-used note does not repeat it', () => {
  const gen = createGenerator({ rng: seeded(82) });
  const first = gen.next({ notes: ['C', 'G'], intervals: ['P5'] });
  const remaining = ['C', 'G'].filter((n) => n !== first.note);
  const p = gen.next({ notes: remaining, intervals: ['P5'] });
  assert.equal(p.note, remaining[0]);
  assert.notEqual(p.note, first.note);
});
