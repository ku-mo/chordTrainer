# Chord Trainer

A random note + interval drill for muscle memory practice. Hit the button, get a
target, play it, repeat.

```
Bb  Minor 6th
C   Major 3rd
Gb  Perfect 5th
```

## Run it

No build, no dependencies. It does need to be served over HTTP (the app uses ES
modules, which browsers refuse to load from `file://`):

```sh
cd chordTrainer
python3 -m http.server 8000
# open http://localhost:8000
```

## Using it

| Action | How |
|---|---|
| Next prompt | Click **Next**, or press <kbd>space</kbd> / <kbd>enter</kbd> |
| Open settings | Gear icon, top right |
| Close settings | <kbd>esc</kbd>, or click outside the panel |

**Hands-free practice** is the point of the thing. In settings, turn on
**Auto-advance** and set a speed (1–20s). A prompt appears on the beat with an
audible tick, so you can keep your eyes on the instrument rather than the
screen. The timer pauses when the tab is hidden.

### Settings

- **Notes** — toggle any of the 12 chromatic roots in or out of the pool.
- **Intervals** — the 12 practice intervals, plus **Major 2nd** and **Octave**
  as extras (off by default).
- **Speed** — seconds between auto-advance prompts.
- **Sound / Volume** — the tick that marks each new prompt.
- **Show target note** — reveals the note the interval lands on (`A Tritone → Eb`).
  Off by default; turn it on to check yourself, off to make yourself work.

Everything persists in `localStorage`, so your pool survives a reload.

### Why it doesn't just use `Math.random()`

Prompts are drawn from a shuffle bag rather than picked at random, so every
enabled note comes up once per cycle. Pure random leaves some roots undrilled
for long stretches — exactly the ones you most need the reps on. The same note
also never appears twice in a row.

## Layout

```
index.html          shell + DOM skeleton
css/styles.css      all styling, dark-first
js/music.js         pools, shuffle-bag selection, transposition (pure)
js/audio.js         Web Audio tick and reference pitches
js/settings.js      localStorage persistence + settings panel
js/app.js           controller
tests/music.test.js unit tests for the selection logic
DESIGN.md           design doc and module contracts
```

## Tests

```sh
node --test          # 34 tests, no dependencies
```

Run it bare from the project root — `node --test tests/` fails on Node 26,
which treats the positional as a glob and chokes on a bare directory.
