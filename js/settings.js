/**
 * settings.js — localStorage persistence + the settings panel DOM.
 *
 * Standalone by contract: this module imports nothing. The note and interval
 * tables below are a local copy of the ones in DESIGN.md §4.1 (mirrored in
 * js/music.js). The ids and labels must stay byte-identical to that table,
 * because app.js hands `settings.enabledIntervals` straight to music.js.
 *
 * Everything here is failure-tolerant: a blocked or full localStorage
 * (private browsing, quota, disabled storage) degrades to in-memory only and
 * never throws.
 */

/* ------------------------------------------------------------------ *
 * Static tables (local copy of DESIGN.md §4.1 — keep in sync verbatim)
 * ------------------------------------------------------------------ */

/** Ordered chromatic roots, flat-preferring spellings. @type {readonly string[]} */
const NOTES = Object.freeze([
  'A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab',
]);

/**
 * @typedef {{ id: string, label: string, semitones: number, defaultOn: boolean }} IntervalDef
 */

/** @type {readonly IntervalDef[]} */
const INTERVALS = Object.freeze([
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
].map(Object.freeze));

const NOTE_SET = new Set(NOTES);
const INTERVAL_IDS = Object.freeze(INTERVALS.map((iv) => iv.id));
const INTERVAL_ID_SET = new Set(INTERVAL_IDS);

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** localStorage key for the whole settings blob. */
const STORAGE_KEY = 'chordTrainer.settings.v1';

/** Trailing-edge debounce window for writes, in ms. */
const SAVE_DEBOUNCE_MS = 200;

/** Sane band for the auto-advance period. Also the speed slider's range. */
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 20000;
const INTERVAL_STEP_MS = 500;

/** How long the "can't turn that one off" hint stays up. */
const LOCK_FEEDBACK_MS = 1600;

/**
 * @typedef {object} Settings
 * @property {string[]} enabledNotes      Note names from NOTES, at least one.
 * @property {string[]} enabledIntervals  Interval ids from INTERVALS, at least one.
 * @property {boolean}  autoAdvance       Hands-free timer on/off.
 * @property {number}   intervalMs        Auto-advance period, 1000..20000.
 * @property {boolean}  sound             Audible tick on/off.
 * @property {number}   volume            0..1.
 * @property {boolean}  showTargetNote    Reveal the transposed target note.
 */

/**
 * Factory defaults. Frozen — treat as read-only; every accessor hands out copies.
 * @type {Readonly<Settings>}
 */
export const DEFAULTS = Object.freeze({
  enabledNotes: Object.freeze([...NOTES]),
  enabledIntervals: Object.freeze(
    INTERVALS.filter((iv) => iv.defaultOn).map((iv) => iv.id),
  ),
  autoAdvance: false,
  intervalMs: 5000,
  sound: true,
  volume: 0.5,
  showTargetNote: false,
});

/** The only keys ever read from or written to storage. */
const KNOWN_KEYS = Object.freeze(Object.keys(DEFAULTS));

/* ------------------------------------------------------------------ *
 * Storage plumbing (never throws)
 * ------------------------------------------------------------------ */

/**
 * Get a working localStorage, or null. Merely *touching* `localStorage` throws
 * in some locked-down browsers, so even the property access is guarded.
 * @returns {Storage|null}
 */
function getStorage() {
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    // Probe: Safari private mode has the object but throws on setItem.
    const probe = '__chordTrainer_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Validation / coercion
 * ------------------------------------------------------------------ */

/** @returns {boolean} */
function coerceBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Clamp a finite number into [min,max]; non-numbers fall back. */
function coerceNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Filter an unknown value down to a deduped array of allowed strings,
 * ordered canonically. Falls back if nothing survives.
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @param {readonly string[]} order
 * @param {readonly string[]} fallback
 * @returns {string[]}
 */
function coerceStringSet(value, allowed, order, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const picked = new Set(
    value.filter((v) => typeof v === 'string' && allowed.has(v)),
  );
  if (picked.size === 0) return [...fallback];
  return order.filter((k) => picked.has(k));
}

/**
 * Merge an arbitrary blob over DEFAULTS: unknown keys dropped, every known key
 * type- and range-checked, both pools guaranteed non-empty.
 * @param {unknown} raw
 * @returns {Settings}
 */
function sanitize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};

  return {
    enabledNotes: coerceStringSet(
      src.enabledNotes, NOTE_SET, NOTES, DEFAULTS.enabledNotes,
    ),
    enabledIntervals: coerceStringSet(
      src.enabledIntervals, INTERVAL_ID_SET, INTERVAL_IDS, DEFAULTS.enabledIntervals,
    ),
    autoAdvance: coerceBool(src.autoAdvance, DEFAULTS.autoAdvance),
    intervalMs: Math.round(
      coerceNumber(src.intervalMs, DEFAULTS.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    ),
    sound: coerceBool(src.sound, DEFAULTS.sound),
    volume: coerceNumber(src.volume, DEFAULTS.volume, 0, 1),
    showTargetNote: coerceBool(src.showTargetNote, DEFAULTS.showTargetNote),
  };
}

/**
 * Plain, storage-shaped copy containing only known keys.
 * @param {Settings} settings
 * @returns {Settings}
 */
function serializable(settings) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of KNOWN_KEYS) out[key] = settings[key];
  return /** @type {Settings} */ (out);
}

/* ------------------------------------------------------------------ *
 * Public persistence API
 * ------------------------------------------------------------------ */

/**
 * Read settings from localStorage, merged over {@link DEFAULTS}.
 *
 * Corrupt JSON, wrong types, out-of-range numbers, unknown keys, empty pools
 * and an unavailable localStorage all resolve to defaults for the affected
 * field. This function never throws.
 *
 * @returns {Settings} A fresh, mutable, fully-populated settings object.
 */
export function loadSettings() {
  try {
    const store = getStorage();
    if (!store) return sanitize(null);
    const rawText = store.getItem(STORAGE_KEY);
    if (typeof rawText !== 'string' || rawText === '') return sanitize(null);
    return sanitize(JSON.parse(rawText));
  } catch {
    return sanitize(null);
  }
}

/** @type {ReturnType<typeof setTimeout>|null} */
let saveTimer = null;
/** @type {Settings|null} */
let pendingSettings = null;

/** Write whatever is pending, right now. Swallows quota/security errors. */
function flushPendingSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const payload = pendingSettings;
  pendingSettings = null;
  if (payload === null) return;
  try {
    const store = getStorage();
    if (!store) return;
    store.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* full, blocked, or serialization failure — practice continues regardless */
  }
}

/**
 * Persist settings to localStorage on a ~200ms trailing-edge debounce.
 *
 * Rapid changes (dragging a slider, spamming chips) collapse to a single
 * write, and the *last* value always wins — no pending write is dropped.
 * Call {@link saveSettings.flush} to commit immediately.
 *
 * Never throws, even when storage is full, blocked, or absent.
 *
 * @param {Settings} settings
 * @returns {void}
 */
export function saveSettings(settings) {
  try {
    pendingSettings = serializable(sanitize(settings));
  } catch {
    return;
  }
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPendingSave, SAVE_DEBOUNCE_MS);
  // Don't hold a Node process open for a debounce (harmless in browsers).
  if (saveTimer && typeof saveTimer === 'object' && typeof saveTimer.unref === 'function') {
    saveTimer.unref();
  }
}

/**
 * Commit any debounced write immediately. Safe to call at any time.
 * @returns {void}
 */
saveSettings.flush = flushPendingSave;

/**
 * Discard any debounced write without committing it.
 * @returns {void}
 */
saveSettings.cancel = function cancelSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  pendingSettings = null;
};

// A page being hidden or torn down must not eat the last change.
if (typeof globalThis.addEventListener === 'function') {
  try {
    globalThis.addEventListener('pagehide', flushPendingSave);
    globalThis.addEventListener('beforeunload', flushPendingSave);
    if (globalThis.document) {
      globalThis.document.addEventListener('visibilitychange', () => {
        if (globalThis.document.visibilityState === 'hidden') flushPendingSave();
      });
    }
  } catch {
    /* no window/document — nothing to hook */
  }
}

/* ------------------------------------------------------------------ *
 * Settings panel DOM
 * ------------------------------------------------------------------ */

let uidCounter = 0;
/** @returns {string} A DOM-id-safe unique token. */
function uid(prefix) {
  uidCounter += 1;
  return `cts-${prefix}-${uidCounter}`;
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {number} ms @returns {string} e.g. "5.0s" */
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** @param {number} v @returns {string} e.g. "50%" */
function formatPercent(v) {
  return `${Math.round(v * 100)}%`;
}

/**
 * Build the settings panel UI inside `rootEl`.
 *
 * Markup contract (css/styles.css is written against this):
 *   section.settings-section > h2 + [div.chip-grid | div.setting-row ...]
 *   chips:  <button type="button" class="chip is-on" aria-pressed="true">
 *   rows:   <div class="setting-row"> label + input[type=checkbox|range] (+ output.setting-value)
 *
 * `rootEl` is emptied first. Every interaction calls `onChange` with a brand
 * new settings object; the `settings` argument is never mutated.
 *
 * Guard: the last enabled note and the last enabled interval cannot be turned
 * off. Attempting it leaves the chip on, marks it `aria-disabled="true"` with
 * a transient `.is-locked` class, and announces a message in the section's
 * `role="status"` element. No alert(), no silent no-op.
 *
 * @param {HTMLElement} rootEl Container to build into.
 * @param {Settings} settings Current settings (treated as immutable).
 * @param {(next: Settings) => void} [onChange] Called with a new object per change.
 * @returns {{ destroy: () => void, update: (next: Settings) => void }}
 */
export function renderSettingsPanel(rootEl, settings, onChange) {
  if (!rootEl || typeof rootEl.appendChild !== 'function') {
    return { destroy() {}, update() {} };
  }

  const doc = rootEl.ownerDocument || globalThis.document;
  const emit = typeof onChange === 'function' ? onChange : () => {};

  /** Live working copy. Replaced wholesale, never mutated in place. */
  let current = sanitize(settings);

  /** @type {Array<{ target: EventTarget, type: string, handler: EventListener }>} */
  const listeners = [];
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  let destroyed = false;

  /**
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListener} handler
   */
  function on(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push({ target, type, handler });
  }

  /** @param {() => void} fn @param {number} ms */
  function later(fn, ms) {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!destroyed) fn();
    }, ms);
    timers.add(t);
    return t;
  }

  /**
   * Publish a change: build the next object, refresh the controls, and hand a
   * fresh copy to the controller. `settings` itself is never touched.
   * @param {Partial<Settings>} patch
   */
  function commit(patch) {
    const next = sanitize({ ...current, ...patch });
    current = next;
    syncAll(); // hoisted declaration below
    emit({
      ...next,
      enabledNotes: [...next.enabledNotes],
      enabledIntervals: [...next.enabledIntervals],
    });
  }

  /* --- generic toggle-chip group ---------------------------------- */

  /**
   * @param {object} cfg
   * @param {string} cfg.title
   * @param {Array<{ value: string, label: string }>} cfg.items
   * @param {() => string[]} cfg.getEnabled
   * @param {(nextValues: string[]) => void} cfg.setEnabled
   * @param {string} cfg.lockMessage
   */
  function buildChipSection(cfg) {
    const section = el(doc, 'section', 'settings-section');
    const heading = el(doc, 'h2', 'settings-heading', cfg.title);
    heading.id = uid('h');
    section.appendChild(heading);

    const grid = el(doc, 'div', 'chip-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-labelledby', heading.id);
    section.appendChild(grid);

    const status = el(doc, 'p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    section.appendChild(status);

    /** @type {Map<string, HTMLButtonElement>} */
    const chips = new Map();

    for (const item of cfg.items) {
      const chip = /** @type {HTMLButtonElement} */ (el(doc, 'button', 'chip'));
      chip.type = 'button';
      chip.value = item.value;
      chip.textContent = item.label;
      chip.setAttribute('aria-pressed', 'false');
      chip.setAttribute('data-value', item.value);
      grid.appendChild(chip);
      chips.set(item.value, chip);

      on(chip, 'click', () => {
        const enabled = cfg.getEnabled();
        const isOn = enabled.includes(item.value);
        if (isOn && enabled.length <= 1) {
          flagLocked(chip);
          return;
        }
        const nextValues = isOn
          ? enabled.filter((v) => v !== item.value)
          : [...enabled, item.value];
        cfg.setEnabled(nextValues);
      });
    }

    /** @param {HTMLButtonElement} chip */
    function flagLocked(chip) {
      chip.classList.add('is-locked');
      status.textContent = cfg.lockMessage;
      later(() => {
        chip.classList.remove('is-locked');
        if (status.textContent === cfg.lockMessage) status.textContent = '';
      }, LOCK_FEEDBACK_MS);
    }

    function sync() {
      const enabled = new Set(cfg.getEnabled());
      const isLast = enabled.size <= 1;
      for (const [value, chip] of chips) {
        const isOn = enabled.has(value);
        chip.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        chip.classList.toggle('is-on', isOn);
        chip.classList.toggle('is-selected', isOn);
        // Communicated, not enforced: the chip stays focusable and clickable
        // so the user gets the explanation instead of a dead control.
        if (isOn && isLast) chip.setAttribute('aria-disabled', 'true');
        else chip.removeAttribute('aria-disabled');
      }
    }

    return { section, sync };
  }

  /* --- generic rows ----------------------------------------------- */

  /**
   * @param {string} labelText
   * @param {boolean} checked
   * @param {(checked: boolean) => void} handler
   */
  function buildCheckboxRow(labelText, checked, handler) {
    const row = el(doc, 'div', 'setting-row setting-row-check');
    const input = /** @type {HTMLInputElement} */ (el(doc, 'input', 'setting-check'));
    input.type = 'checkbox';
    input.id = uid('c');
    input.checked = checked;
    const label = el(doc, 'label', 'setting-label', labelText);
    label.setAttribute('for', input.id);
    row.appendChild(input);
    row.appendChild(label);
    on(input, 'change', () => handler(input.checked));
    return { row, input };
  }

  /**
   * @param {object} cfg
   * @param {string} cfg.labelText
   * @param {number} cfg.min
   * @param {number} cfg.max
   * @param {number} cfg.step
   * @param {number} cfg.value
   * @param {(v: number) => string} cfg.format
   * @param {(v: number) => void} cfg.handler
   */
  function buildRangeRow(cfg) {
    const row = el(doc, 'div', 'setting-row setting-row-range');
    const input = /** @type {HTMLInputElement} */ (el(doc, 'input', 'setting-range'));
    input.type = 'range';
    input.id = uid('r');
    input.min = String(cfg.min);
    input.max = String(cfg.max);
    input.step = String(cfg.step);
    input.value = String(cfg.value);

    const label = el(doc, 'label', 'setting-label', cfg.labelText);
    label.setAttribute('for', input.id);

    const readout = el(doc, 'output', 'setting-value', cfg.format(cfg.value));
    readout.setAttribute('for', input.id);

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(readout);

    const apply = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      readout.textContent = cfg.format(v);
      cfg.handler(v);
    };
    on(input, 'input', apply);
    on(input, 'change', apply);

    return { row, input, readout };
  }

  /* --- build ------------------------------------------------------- */

  while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);

  const notesGroup = buildChipSection({
    title: 'Notes',
    items: NOTES.map((n) => ({ value: n, label: n })),
    getEnabled: () => current.enabledNotes,
    setEnabled: (values) => commit({ enabledNotes: values }),
    lockMessage: 'Keep at least one note in the pool.',
  });

  const intervalsGroup = buildChipSection({
    title: 'Intervals',
    items: INTERVALS.map((iv) => ({ value: iv.id, label: iv.label })),
    getEnabled: () => current.enabledIntervals,
    setEnabled: (values) => commit({ enabledIntervals: values }),
    lockMessage: 'Keep at least one interval in the pool.',
  });

  const practice = el(doc, 'section', 'settings-section');
  const practiceHeading = el(doc, 'h2', 'settings-heading', 'Practice');
  practiceHeading.id = uid('h');
  practice.appendChild(practiceHeading);

  const autoRow = buildCheckboxRow(
    'Auto-advance',
    current.autoAdvance,
    (checked) => commit({ autoAdvance: checked }),
  );
  practice.appendChild(autoRow.row);

  const speedRow = buildRangeRow({
    labelText: 'Speed',
    min: MIN_INTERVAL_MS / 1000,
    max: MAX_INTERVAL_MS / 1000,
    step: INTERVAL_STEP_MS / 1000,
    value: current.intervalMs / 1000,
    format: (seconds) => formatSeconds(seconds * 1000),
    handler: (seconds) => commit({ intervalMs: Math.round(seconds * 1000) }),
  });
  practice.appendChild(speedRow.row);

  const soundRow = buildCheckboxRow(
    'Sound',
    current.sound,
    (checked) => commit({ sound: checked }),
  );
  practice.appendChild(soundRow.row);

  const volumeRow = buildRangeRow({
    labelText: 'Volume',
    min: 0,
    max: 1,
    step: 0.05,
    value: current.volume,
    format: formatPercent,
    handler: (v) => commit({ volume: v }),
  });
  practice.appendChild(volumeRow.row);

  const targetRow = buildCheckboxRow(
    'Show target note',
    current.showTargetNote,
    (checked) => commit({ showTargetNote: checked }),
  );
  practice.appendChild(targetRow.row);

  rootEl.appendChild(notesGroup.section);
  rootEl.appendChild(intervalsGroup.section);
  rootEl.appendChild(practice);

  /** Push `current` into every control. */
  function syncAll() {
    notesGroup.sync();
    intervalsGroup.sync();
    autoRow.input.checked = current.autoAdvance;
    soundRow.input.checked = current.sound;
    targetRow.input.checked = current.showTargetNote;
    speedRow.input.value = String(current.intervalMs / 1000);
    speedRow.readout.textContent = formatSeconds(current.intervalMs);
    volumeRow.input.value = String(current.volume);
    volumeRow.readout.textContent = formatPercent(current.volume);
  }

  syncAll();

  return {
    /**
     * Adopt externally-changed settings (e.g. a reset) without rebuilding DOM.
     * @param {Settings} next
     */
    update(next) {
      if (destroyed) return;
      current = sanitize(next);
      syncAll();
    },
    /** Remove every listener and empty `rootEl`. Idempotent. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const { target, type, handler } of listeners) {
        try {
          target.removeEventListener(type, handler);
        } catch {
          /* detached node — nothing to do */
        }
      }
      listeners.length = 0;
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    },
  };
}
