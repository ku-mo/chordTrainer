/**
 * js/audio.js — Web Audio tick + optional reference pitch.
 *
 * Contract: DESIGN.md §4.2.
 *
 * Hard rule for this module: **it must never throw.** Its methods are called
 * straight out of click / keydown handlers in `app.js`; an exception here would
 * take the whole advance() path down with it. So every public method is a
 * try/catch island, and if Web Audio is missing, blocked, or refuses to start,
 * everything silently degrades to a no-op.
 *
 * No imports — this module owns its own note table so it can be built in
 * parallel with `music.js`.
 */

/* -------------------------------------------------------------------------
 * Pitch
 * ---------------------------------------------------------------------- */

/**
 * Chromatic roots in the app's preferred (flat) spellings, ordered from A.
 * The index into this array is the semitone offset above A3.
 * @type {readonly string[]}
 */
const ROOTS = ['A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab'];

/** A3 — the bottom of the reference octave. A4 = 440 Hz, so A3 = 220 Hz. */
const BASE_FREQ = 220;

/**
 * Semitone offset above A3 for every spelling we tolerate: the flat set the app
 * actually uses, plus the enharmonic sharps and the odd B#/Cb/E#/Fb, as defence
 * against whatever string reaches us.
 * @type {Readonly<Record<string, number>>}
 */
const SEMITONE_OFFSETS = (() => {
  /** @type {Record<string, number>} */
  const map = {};
  ROOTS.forEach((name, i) => {
    map[name] = i;
  });
  Object.assign(map, {
    'A#': 1,
    'C#': 4,
    'D#': 6,
    'F#': 10,
    'G#': 11,
    'B#': 3, // === C
    Cb: 2, // === B
    'E#': 8, // === F
    Fb: 7, // === E
  });
  return Object.freeze(map);
})();

/**
 * Normalise a note spelling: trims, strips any octave digits, folds unicode
 * accidentals to ASCII, and fixes casing ("bb" -> "Bb", "f#" -> "F#").
 * @param {unknown} name
 * @returns {string} normalised name, or '' if unusable
 */
function normalizeNoteName(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name
    .trim()
    .replace(/♭/g, 'b') // ♭
    .replace(/♯/g, '#') // ♯
    .replace(/[♮\s]/g, '') // ♮ and whitespace
    .replace(/-?\d+$/, ''); // trailing octave number
  if (!cleaned) return '';
  const letter = cleaned[0].toUpperCase();
  const accidentals = cleaned.slice(1).replace(/B/g, 'b');
  return letter + accidentals;
}

/**
 * Frequency for a note name, voiced in the octave starting at A3 (220 Hz).
 * A/Bb/B land in octave 3 (220–246.94 Hz); C through Ab land in octave 4
 * (261.63–415.30 Hz), which puts A4 = 440 Hz exactly one step above the top.
 * @param {unknown} name e.g. 'Bb', 'F#', 'db'
 * @returns {number|null} frequency in Hz, or null if the name is unknown
 */
function noteToFrequency(name) {
  const key = normalizeNoteName(name);
  const semis = SEMITONE_OFFSETS[key];
  if (typeof semis !== 'number') return null;
  return BASE_FREQ * Math.pow(2, semis / 12);
}

/* -------------------------------------------------------------------------
 * Voicing constants
 * ---------------------------------------------------------------------- */

/** exponentialRampToValueAtTime can never reach 0; ramp here, then hard-zero. */
const SILENCE = 0.0001;

const TICK = Object.freeze({
  startFreq: 1180,
  endFreq: 760,
  duration: 0.04, // ~40ms, per spec
  attack: 0.0015,
  peak: 0.6,
});

const NOTE = Object.freeze({
  duration: 0.6,
  attack: 0.012,
  decay: 0.09,
  sustain: 0.62, // fraction of peak
  release: 0.14,
  peak: 0.34,
  triangleMix: 0.4, // triangle sits under the sine for a little bite
});

/** Gap between the two notes of an interval, in seconds. */
const INTERVAL_GAP = 0.08;

/* -------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------- */

/**
 * @typedef {object} PlayNoteOptions
 * @property {number} [duration] Note length in seconds (default 0.6).
 * @property {number} [velocity] 0..1 scale on top of the master volume.
 * @property {number} [when] AudioContext time to start at; defaults to now.
 */

/**
 * @typedef {object} Audio
 * @property {() => boolean} unlock Resume/create the context from a user gesture. Idempotent.
 * @property {() => void} tick Short percussive click (~40ms) — the "next prompt" cue.
 * @property {(noteName: string, opts?: PlayNoteOptions) => void} playNote Sine+triangle blip, ~600ms.
 * @property {(rootNote: string, semitones: number) => void} playInterval Root then target, sequentially.
 * @property {(value: boolean) => void} setEnabled Mute/unmute all sound-producing methods.
 * @property {() => boolean} isEnabled Whether sound is currently enabled.
 * @property {(value: number) => void} setVolume Master volume, clamped to 0..1.
 */

/**
 * Create an audio engine. Nothing is constructed until the first sound or
 * `unlock()` — building an AudioContext at module load is blocked by browsers
 * and just noises up the console.
 *
 * @param {{ enabled?: boolean, volume?: number }} [opts]
 * @returns {Audio}
 */
export function createAudio(opts = {}) {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {GainNode|null} */
  let master = null;
  /** True once we've tried and failed to build a context; we don't retry. */
  let unavailable = false;

  let enabled = opts.enabled !== false;
  let volume = clamp01(opts.volume, 0.5);

  /**
   * @param {unknown} value
   * @param {number} fallback
   * @returns {number}
   */
  function clamp01(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  /**
   * Lazily build (at most) one AudioContext plus its master gain.
   * @returns {AudioContext|null} null when Web Audio is unavailable
   */
  function ensureContext() {
    if (ctx) return ctx;
    if (unavailable) return null;
    try {
      const Ctor =
        typeof globalThis !== 'undefined'
          ? globalThis.AudioContext || globalThis.webkitAudioContext
          : undefined;
      if (typeof Ctor !== 'function') {
        unavailable = true;
        return null;
      }
      const created = new Ctor();
      const gain = created.createGain();
      gain.gain.value = volume;
      gain.connect(created.destination);
      ctx = created;
      master = gain;
      return ctx;
    } catch {
      unavailable = true;
      ctx = null;
      master = null;
      return null;
    }
  }

  /**
   * Context ready for scheduling: exists, isn't closed, and sound is on.
   * @returns {AudioContext|null}
   */
  function audible() {
    if (!enabled) return null;
    const c = ensureContext();
    if (!c || !master) return null;
    if (c.state === 'closed') return null;
    if (c.state === 'suspended') {
      // Best effort — a gesture-driven unlock() is the real fix, but scheduling
      // against a suspended context is harmless: it plays once it resumes.
      resumeQuietly(c);
    }
    return c;
  }

  /** @param {AudioContext} c */
  function resumeQuietly(c) {
    try {
      const p = c.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /**
   * Detach a node once it has finished so a long practice session doesn't
   * accumulate dead nodes hanging off the master gain.
   * @param {AudioScheduledSourceNode} source
   * @param {AudioNode[]} nodes
   */
  function autoRelease(source, nodes) {
    source.onended = () => {
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
  }

  /**
   * Percussive click: a fast pitch-dropping triangle under a near-instant
   * attack and exponential decay. Gating a raw wave on/off pops; this doesn't.
   * @param {AudioContext} c
   * @param {GainNode} out
   * @param {number} t0
   */
  function scheduleTick(c, out, t0) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const end = t0 + TICK.duration;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(TICK.startFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(TICK.endFreq, end);

    gain.gain.setValueAtTime(SILENCE, t0);
    gain.gain.exponentialRampToValueAtTime(TICK.peak, t0 + TICK.attack);
    gain.gain.exponentialRampToValueAtTime(SILENCE, end);
    gain.gain.setValueAtTime(0, end + 0.001);

    osc.connect(gain);
    gain.connect(out);
    autoRelease(osc, [osc, gain]);
    osc.start(t0);
    osc.stop(end + 0.01);
  }

  /**
   * Sine + triangle blend with an ADSR envelope. Never ramps to exactly 0.
   * @param {AudioContext} c
   * @param {GainNode} out
   * @param {number} freq
   * @param {number} t0
   * @param {number} duration
   * @param {number} velocity
   */
  function scheduleNote(c, out, freq, t0, duration, velocity) {
    const peak = Math.max(SILENCE * 2, NOTE.peak * velocity);
    const sustain = Math.max(SILENCE * 2, peak * NOTE.sustain);
    const attackEnd = t0 + NOTE.attack;
    const decayEnd = attackEnd + NOTE.decay;
    const releaseStart = Math.max(decayEnd, t0 + duration - NOTE.release);
    const end = releaseStart + NOTE.release;

    const env = c.createGain();
    env.gain.setValueAtTime(SILENCE, t0);
    env.gain.exponentialRampToValueAtTime(peak, attackEnd);
    env.gain.exponentialRampToValueAtTime(sustain, decayEnd);
    env.gain.setValueAtTime(sustain, releaseStart);
    env.gain.exponentialRampToValueAtTime(SILENCE, end);
    env.gain.setValueAtTime(0, end + 0.001);
    env.connect(out);

    const sine = c.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(freq, t0);
    sine.connect(env);

    const tri = c.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(freq, t0);
    const triGain = c.createGain();
    triGain.gain.setValueAtTime(NOTE.triangleMix, t0);
    tri.connect(triGain);
    triGain.connect(env);

    const stopAt = end + 0.02;
    sine.start(t0);
    sine.stop(stopAt);
    tri.start(t0);
    tri.stop(stopAt);
    autoRelease(sine, [sine, tri, triGain, env]);
  }

  /**
   * @param {string} noteName
   * @param {PlayNoteOptions} options
   */
  function emitNote(noteName, options) {
    const c = audible();
    if (!c || !master) return;
    const freq = noteToFrequency(noteName);
    if (freq === null) return;
    const duration = numberOr(options.duration, NOTE.duration, 0.05, 10);
    const velocity = clamp01(options.velocity, 1);
    if (velocity === 0) return;
    const base = numberOr(options.when, c.currentTime, 0, Infinity);
    scheduleNote(c, master, freq, Math.max(c.currentTime, base), duration, velocity);
  }

  /**
   * @param {unknown} value
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function numberOr(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  return {
    /**
     * Resume (creating if needed) the AudioContext. Call from the first user
     * gesture; safe to call as often as you like.
     * @returns {boolean} true if a running context is available
     */
    unlock() {
      try {
        const c = ensureContext();
        if (!c) return false;
        if (c.state === 'suspended') resumeQuietly(c);
        return c.state === 'running';
      } catch {
        return false;
      }
    },

    /**
     * Short percussive click (~40ms) signalling a new prompt. Cheap enough to
     * fire back to back at speed; nodes stop and disconnect themselves.
     * @returns {void}
     */
    tick() {
      try {
        const c = audible();
        if (!c || !master) return;
        scheduleTick(c, master, c.currentTime);
      } catch {
        /* silent */
      }
    },

    /**
     * Play a single reference pitch, voiced in the octave from A3 up.
     * @param {string} noteName e.g. 'Bb'
     * @param {PlayNoteOptions} [options]
     * @returns {void}
     */
    playNote(noteName, options = {}) {
      try {
        emitNote(noteName, options || {});
      } catch {
        /* silent */
      }
    },

    /**
     * Play the root, then the note `semitones` above it, sequentially.
     * @param {string} rootNote e.g. 'C'
     * @param {number} semitones 0..14 (unison through major 9th)
     * @returns {void}
     */
    playInterval(rootNote, semitones) {
      try {
        const c = audible();
        if (!c || !master) return;
        const rootFreq = noteToFrequency(rootNote);
        if (rootFreq === null) return;
        const steps = numberOr(semitones, NaN, -24, 24);
        if (!Number.isFinite(steps)) return;

        const t0 = c.currentTime;
        const step = NOTE.duration + INTERVAL_GAP;
        scheduleNote(c, master, rootFreq, t0, NOTE.duration, 1);
        scheduleNote(
          c,
          master,
          rootFreq * Math.pow(2, steps / 12),
          t0 + step,
          NOTE.duration,
          1,
        );
      } catch {
        /* silent */
      }
    },

    /**
     * Enable or mute all sound-producing methods. `unlock`, `setVolume` and
     * `isEnabled` keep working while muted.
     * @param {boolean} value
     * @returns {void}
     */
    setEnabled(value) {
      enabled = !!value;
    },

    /**
     * @returns {boolean} whether sound-producing methods will make sound
     */
    isEnabled() {
      return enabled;
    },

    /**
     * Set master volume. Values outside 0..1 (and non-numbers) are clamped.
     * @param {number} value
     * @returns {void}
     */
    setVolume(value) {
      volume = clamp01(value, volume);
      try {
        if (!ctx || !master) return;
        // Short ramp rather than a jump, to avoid a zipper click mid-note.
        master.gain.setTargetAtTime(volume, ctx.currentTime, 0.015);
      } catch {
        try {
          if (master) master.gain.value = volume;
        } catch {
          /* silent */
        }
      }
    },
  };
}

export default createAudio;
