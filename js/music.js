/**
 * music.js — pure practice-prompt logic.
 *
 * No DOM, no globals, no module-level mutable state. Everything stateful lives
 * inside the object returned by {@link createGenerator}, so tests (and multiple
 * callers) never share hidden history.
 */

/**
 * Ordered chromatic roots, flat-preferring spellings.
 * Index 0 is A, so `transpose` is plain modulo-12 arithmetic on this array.
 * @type {string[]}
 */
export const NOTES = ['A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab'];

/**
 * @typedef {Object} Interval
 * @property {string} id         Stable key used for storage and pool filtering.
 * @property {string} label      Display name, e.g. "Minor 6th".
 * @property {number} semitones  Distance above the root.
 * @property {boolean} defaultOn Whether it ships enabled.
 */

/**
 * The full interval set. Major 2nd and Octave ship off by default (see DESIGN §2).
 * @type {Interval[]}
 */
export const INTERVALS = [
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
];

/** id -> interval, built once at module load (read-only lookup). */
const INTERVALS_BY_ID = new Map(INTERVALS.map((iv) => [iv.id, iv]));

/** Note-name index, plus sharp spellings so callers aren't forced into flats. */
const NOTE_INDEX = new Map(NOTES.map((n, i) => [n, i]));
const SHARP_ALIASES = { 'A#': 'Bb', 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab' };

/**
 * Transpose a note up (or down, with negative semitones) and re-spell it using
 * the flat-preferring names in {@link NOTES}. Wraps the octave, so semitone
 * counts above 12 (minor 9th = 13, major 9th = 14) are fine.
 *
 * @param {string} note        A name from NOTES (sharp spellings also accepted).
 * @param {number} semitones   Any integer.
 * @returns {string} The resulting note name, always a member of NOTES.
 * @throws {Error} If the note or semitone count is not recognised.
 */
export function transpose(note, semitones) {
  const canonical = NOTE_INDEX.has(note) ? note : SHARP_ALIASES[note];
  const from = NOTE_INDEX.get(canonical);
  if (from === undefined) throw new Error(`transpose: unknown note "${note}"`);
  if (!Number.isInteger(semitones)) {
    throw new Error(`transpose: semitones must be an integer, got ${semitones}`);
  }
  // Double modulo keeps negative offsets in range.
  return NOTES[(((from + semitones) % 12) + 12) % 12];
}

/**
 * A shuffle bag: hands out every member of the pool once before repeating any,
 * which is what makes coverage even. Refills reshuffle and keep the just-used
 * item off the front so cycle boundaries don't produce back-to-back repeats.
 *
 * The pool can change between draws (the user toggles notes off mid-session),
 * so every draw compares a signature of the pool against the one the current
 * bag was built from and rebuilds on mismatch. That is what guarantees a
 * disabled item is never handed back.
 */
class ShuffleBag {
  /** @param {() => number} rng */
  constructor(rng) {
    this.rng = rng;
    /** @type {string[]} items not yet drawn in this cycle */
    this.items = [];
    /** @type {string|null} pool the current bag was built from */
    this.signature = null;
  }

  clear() {
    this.items = [];
    this.signature = null;
  }

  /** Fisher–Yates over a copy, biased so `avoid` never lands first. */
  shuffled(pool, avoid) {
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (arr.length > 1 && arr[0] === avoid) {
      const swapWith = 1 + Math.floor(this.rng() * (arr.length - 1));
      [arr[0], arr[swapWith]] = [arr[swapWith], arr[0]];
    }
    return arr;
  }

  /**
   * @param {string[]} pool   Current (deduped, validated) pool.
   * @param {string|null} avoid  Item drawn last time.
   * @param {boolean} forbid  If true, never return `avoid` (unless the pool
   *                          has only one member, where a repeat is the only
   *                          legal answer).
   * @returns {string}
   */
  draw(pool, avoid, forbid) {
    const signature = pool.join('\u0000');
    if (signature !== this.signature) {
      // Pool changed (or first draw): the old bag may hold now-disabled items.
      this.signature = signature;
      this.items = [];
    }
    if (this.items.length === 0) this.items = this.shuffled(pool, avoid);

    const mustAvoid = forbid && pool.length > 1;
    let index = 0;
    if (mustAvoid && this.items[0] === avoid) {
      // Pool members are unique, so at most one entry equals `avoid`. Skip past
      // it and leave it in the bag — it still gets drawn later this cycle, so
      // coverage stays even.
      index = this.items.findIndex((item) => item !== avoid);
      if (index === -1) {
        // Only `avoid` is left: start the next cycle early and take from it.
        this.items.push(...this.shuffled(pool, avoid));
        index = this.items.findIndex((item) => item !== avoid);
      }
    }
    return this.items.splice(index, 1)[0];
  }
}

/** Keep declared order, drop duplicates and anything we don't recognise. */
function sanitise(pool, isKnown, what) {
  if (!Array.isArray(pool)) throw new Error(`next: ${what} pool must be an array`);
  const seen = new Set();
  const out = [];
  for (const item of pool) {
    if (!isKnown(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  if (out.length === 0) throw new Error(`next: ${what} pool is empty`);
  return out;
}

/**
 * @typedef {Object} Prompt
 * @property {string} note        Root note, drawn from the enabled note pool.
 * @property {{id: string, label: string, semitones: number}} interval
 * @property {string} targetNote  `note` transposed up by `interval.semitones`.
 * @property {string} text        e.g. "Bb Minor 6th".
 */

/**
 * Create a prompt generator. Holds the shuffle bags and the anti-repeat memory.
 *
 * @param {{rng?: () => number}} [opts] Inject `rng` for deterministic tests.
 * @returns {{
 *   next: (pools: {notes: string[], intervals: string[]}) => Prompt,
 *   reset: () => void
 * }}
 */
export function createGenerator(opts = {}) {
  const rng = opts.rng ?? Math.random;
  const noteBag = new ShuffleBag(rng);
  const intervalBag = new ShuffleBag(rng);

  /** @type {string|null} */ let lastNote = null;
  /** @type {string|null} */ let lastIntervalId = null;

  return {
    /**
     * Draw the next practice prompt.
     * @param {{notes: string[], intervals: string[]}} pools Enabled note names
     *        and enabled interval ids. Unknown entries are ignored.
     * @returns {Prompt}
     * @throws {Error} If either pool is empty (or missing).
     */
    next(pools) {
      if (!pools || typeof pools !== 'object') {
        throw new Error('next: expected { notes, intervals }');
      }
      const notes = sanitise(pools.notes, (n) => NOTE_INDEX.has(n), 'note');
      const intervalIds = sanitise(pools.intervals, (id) => INTERVALS_BY_ID.has(id), 'interval');

      const note = noteBag.draw(notes, lastNote, true);
      // A fresh note already makes the pair fresh; only when the note is forced
      // to repeat (single-note pool) must the interval differ to avoid an
      // identical prompt twice in a row.
      const forbidInterval = note === lastNote;
      const intervalId = intervalBag.draw(intervalIds, lastIntervalId, forbidInterval);
      const interval = INTERVALS_BY_ID.get(intervalId);

      lastNote = note;
      lastIntervalId = intervalId;

      return {
        note,
        interval: { id: interval.id, label: interval.label, semitones: interval.semitones },
        targetNote: transpose(note, interval.semitones),
        text: `${note} ${interval.label}`,
      };
    },

    /** Clear anti-repeat memory and both bags. */
    reset() {
      lastNote = null;
      lastIntervalId = null;
      noteBag.clear();
      intervalBag.clear();
    },
  };
}
