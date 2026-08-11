# Chord Trainer — Design Doc

## 1. Purpose

A zero-friction drill app for **muscle memory practice**. Press a button (or hit
a key, or let a timer run) and the app calls out a random target:

```
Bb   Minor 6th
C    Major 3rd
Gb   Perfect 5th
```

You play it on your instrument. Next prompt. Repeat until it's in your hands.

The core value is *speed and rhythm of repetition*, not music theory tuition.
Every design decision below defers to: **how fast can the user get the next
prompt, hands-free, without breaking flow?**

## 2. Scope

### v1 (this prototype)

- Random note from the 12 chromatic roots.
- Random interval from the 12 intervals in the practice set.
- Big, readable, across-the-room display.
- Advance via: on-screen button, `Space` / `Enter`, or an auto-advance timer.
- Auto-advance ("hands-free mode") with adjustable BPM-style interval.
- Optional audible tick on each new prompt so you don't have to look up.
- Toggle individual notes and intervals in/out of the pool.
- Settings persist across reloads.
- Session counter (how many prompts you've drilled).

### Explicit non-goals for v1

- No pitch detection / listening to the user.
- No scoring, streaks, or gamification.
- No accounts, no backend, no build step.
- No staff notation or fretboard/keyboard diagrams.

### Flagged decision

The interval list in the request omits **major 2nd** and **octave**. That looks
deliberate (minor 9th ≈ major 2nd + octave is already covered), so the 12
requested intervals are the **default enabled set**. Major 2nd and octave ship
as extra toggles that are **off by default** — no change to default behavior,
but available if wanted. Everything else matches the request exactly.

## 3. Architecture

Vanilla HTML + CSS + ES modules. No framework, no bundler, no `npm install`.
Open `index.html` or serve the folder — it runs. This is deliberate: the app is
small, and a build step is friction between the user and practice.

```
chordTrainer/
├── DESIGN.md
├── index.html          # shell + static DOM skeleton
├── css/
│   └── styles.css      # all styling, dark-first, responsive
├── js/
│   ├── music.js        # pure logic: pools, weighted random, no-repeat
│   ├── audio.js        # Web Audio tick + optional reference pitch
│   ├── settings.js     # localStorage persistence + settings panel DOM
│   └── app.js          # controller: wires modules to the DOM
└── tests/
    └── music.test.js   # node:test unit tests for music.js
```

Data flows one way. `app.js` owns all state transitions; the other modules are
leaves that never import each other.

```
        ┌──────────┐
        │  app.js  │  owns: current prompt, timer, session count
        └────┬─────┘
     ┌───────┼────────┬──────────┐
     ▼       ▼        ▼          ▼
  music   audio   settings     DOM
  (pure)  (sfx)   (storage)
```

## 4. Module contracts

These are the seams between parallel work. Each module must export exactly
this surface — `app.js` is written against it.

### 4.1 `js/music.js` — pure, no DOM, no globals

```js
// Ordered chromatic roots, using the exact spellings the user asked for.
export const NOTES = ['A','Bb','B','C','Db','D','Eb','E','F','Gb','G','Ab'];

// Each interval: id (stable key for storage), label (display), semitones.
export const INTERVALS = [
  { id: 'm2',  label: 'Minor 2nd',   semitones: 1,  defaultOn: true  },
  { id: 'M2',  label: 'Major 2nd',   semitones: 2,  defaultOn: false },
  { id: 'm3',  label: 'Minor 3rd',   semitones: 3,  defaultOn: true  },
  { id: 'M3',  label: 'Major 3rd',   semitones: 4,  defaultOn: true  },
  { id: 'P4',  label: 'Perfect 4th', semitones: 5,  defaultOn: true  },
  { id: 'TT',  label: 'Tritone',     semitones: 6,  defaultOn: true  },
  { id: 'P5',  label: 'Perfect 5th', semitones: 7,  defaultOn: true  },
  { id: 'm6',  label: 'Minor 6th',   semitones: 8,  defaultOn: true  },
  { id: 'M6',  label: 'Major 6th',   semitones: 9,  defaultOn: true  },
  { id: 'm7',  label: 'Minor 7th',   semitones: 10, defaultOn: true  },
  { id: 'M7',  label: 'Major 7th',   semitones: 11, defaultOn: true  },
  { id: 'P8',  label: 'Octave',      semitones: 12, defaultOn: false },
  { id: 'm9',  label: 'Minor 9th',   semitones: 13, defaultOn: true  },
  { id: 'M9',  label: 'Major 9th',   semitones: 14, defaultOn: true  },
];

// Factory. Holds the anti-repeat memory; no module-level mutable state.
// opts: { rng?: () => number }  — inject for deterministic tests.
export function createGenerator(opts = {});

// generator.next({ notes: string[], intervals: string[] }) -> Prompt
//   notes:     enabled note names, e.g. ['A','Bb',...]
//   intervals: enabled interval ids, e.g. ['m2','P5',...]
// Returns: { note, interval: {id,label,semitones}, targetNote, text }
//   targetNote  = note transposed up by semitones, spelled from NOTES
//   text        = `${note} ${interval.label}`  e.g. "Bb Minor 6th"
// Throws Error if either pool is empty.

// generator.reset()  -> clears anti-repeat memory
```

**Selection rules** (this is the part that matters for practice quality):

1. **No immediate repeat** of the same `note+interval` pair, and no immediate
   repeat of the same note, whenever the pool is large enough to avoid it.
   Repeats feel like the app is broken and waste reps.
2. **Bag shuffle over notes**: draw notes from a shuffled bag of the enabled
   set, refilling when empty. Guarantees even coverage — pure `Math.random()`
   leaves some notes undrilled for long stretches, which defeats the purpose.
   Intervals use the same bag approach, drawn independently.
3. Bag refills reshuffle, and avoid putting the just-used item first.
4. Degrades gracefully: pool of 1 note is legal and just repeats that note.

`transpose(note, semitones)` is exported too, spelling results with the same
flat-preferring names in `NOTES`.

### 4.2 `js/audio.js` — Web Audio, lazily initialized

```js
export function createAudio();
// .unlock()                      resume AudioContext (call on first user gesture)
// .tick()                        short percussive click, ~40ms — the "next prompt" cue
// .playNote(noteName, opts)      sine+triangle blip of the root, ~600ms
// .playInterval(root, semitones) root then target, sequential, for ear reference
// .setEnabled(bool) / .isEnabled()
// .setVolume(0..1)
```

Must never throw if Web Audio is unavailable or blocked — degrade to silent
no-ops. Creates at most one `AudioContext`, on first use. A4 = 440 Hz, root
notes voiced in the octave from A3 up.

### 4.3 `js/settings.js` — persistence + settings panel

```js
export const DEFAULTS = { enabledNotes, enabledIntervals, autoAdvance:false,
                          intervalMs:5000, sound:true, volume:0.5,
                          showTargetNote:false };

export function loadSettings();          // merged over DEFAULTS, corrupt-safe
export function saveSettings(settings);  // debounced write to localStorage
export function renderSettingsPanel(rootEl, settings, onChange);
//   Builds note toggles, interval toggles, auto-advance + speed, sound + volume.
//   Calls onChange(nextSettings) on every change. Never mutates the arg.
//   Returns { destroy() }.
```

Storage key: `chordTrainer.settings.v1`. Unknown/removed keys are dropped on
load; a corrupt blob falls back to defaults rather than throwing. Guards
against the last note or last interval being un-toggled (pool must stay ≥1).

### 4.4 `js/app.js` — controller (written by the lead, not fanned out)

Owns: current prompt, auto-advance timer, session count, keyboard handling.
Wires the three modules to the DOM. Single `advance()` entry point used by the
button, the keys, and the timer alike.

## 5. UI

Single screen. The prompt is the page.

```
┌──────────────────────────────────────────┐
│  Chord Trainer                     ⚙     │
│                                          │
│                                          │
│              Bb                          │   ← ~18vw, dominant
│         Minor 6th                        │   ← ~7vw, accent color
│                                          │
│              (→ Gb)                      │   ← optional target note
│                                          │
│         ┌────────────────┐               │
│         │      NEXT      │               │   ← big tap target
│         └────────────────┘               │
│      space / enter · 24 drilled          │
└──────────────────────────────────────────┘
```

- **Dark by default.** Practice happens in dim rooms; a white screen at 18vw is
  hostile. Respects `prefers-color-scheme`.
- **Readability at distance** is the top constraint — the note must be legible
  from across a room with an instrument in hand. Viewport-relative type.
- **Thumb-reachable NEXT** on mobile: the button sits in the lower third.
- Settings live behind a gear in a slide-over panel, closed by default. Nothing
  competes with the prompt.
- Prompt changes get a short fade/scale-in (~150ms) so a repeat still reads as
  a new event. Honors `prefers-reduced-motion`.
- Fully keyboard operable; visible focus rings; ARIA live region on the prompt
  so screen readers announce each new target.

## 6. Testing

`tests/music.test.js` using `node:test`. No dependencies. Run it as bare
`node --test` from the project root — Node 26 treats a positional as a glob, so
`node --test tests/` fails on the directory path.
Covers: pool shapes, `text` formatting, transposition wrap-around, no-immediate
repeat, bag coverage over many draws, single-item pools, empty-pool throw, and
determinism under an injected seeded RNG.

Manual smoke: open the page, press Space 20×, toggle everything, reload and
confirm settings stuck.

## 7. Build plan (parallel)

| Track | Owner | Files | Depends on |
|---|---|---|---|
| A | agent | `js/music.js`, `tests/music.test.js` | §4.1 |
| B | agent | `css/styles.css` | §5 + DOM contract |
| C | agent | `js/audio.js` | §4.2 |
| D | agent | `js/settings.js` | §4.3 |
| E | lead  | `index.html`, `js/app.js` | integrates A–D |

Tracks A–D touch disjoint files and share no imports, so they run concurrently.
The lead writes the DOM skeleton and controller, then integrates and smoke-tests.

### DOM contract (fixed, so CSS and JS agree)

```html
<body>
  <header class="app-header">
    <h1 class="app-title">Chord Trainer</h1>
    <button id="settings-toggle" class="icon-btn" aria-expanded="false">⚙</button>
  </header>

  <main class="stage">
    <div id="prompt" class="prompt" aria-live="polite">
      <div id="prompt-note"     class="prompt-note">—</div>
      <div id="prompt-interval" class="prompt-interval">press next</div>
      <div id="prompt-target"   class="prompt-target" hidden></div>
    </div>
    <button id="next-btn" class="next-btn">Next</button>
    <p class="hint">
      <kbd>space</kbd> · <span id="session-count">0</span> drilled
    </p>
  </main>

  <aside id="settings-panel" class="settings-panel" hidden></aside>
  <div id="scrim" class="scrim" hidden></div>
</body>
```

State classes toggled by `app.js`: `.is-open` on the panel/scrim,
`.is-flash` on `#prompt` for the change animation, `.is-running` on
`#next-btn` when auto-advance is active.
