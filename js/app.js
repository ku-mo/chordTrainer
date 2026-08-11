/**
 * Chord Trainer — controller.
 *
 * Owns all mutable state (current prompt, auto-advance timer, session count)
 * and wires the leaf modules to the DOM. music/audio/settings never import
 * each other; everything meets here.
 */
import { createGenerator } from './music.js';
import { createAudio } from './audio.js';
import { loadSettings, saveSettings, renderSettingsPanel } from './settings.js';

const el = {
  note: document.getElementById('prompt-note'),
  interval: document.getElementById('prompt-interval'),
  target: document.getElementById('prompt-target'),
  prompt: document.getElementById('prompt'),
  nextBtn: document.getElementById('next-btn'),
  count: document.getElementById('session-count'),
  panel: document.getElementById('settings-panel'),
  panelToggle: document.getElementById('settings-toggle'),
  scrim: document.getElementById('scrim'),
};

const generator = createGenerator();
const audio = createAudio();

let settings = loadSettings();
let currentPrompt = null;
let sessionCount = 0;
let timerId = null;
let panelOpen = false;
let panelHandle = null;
let audioUnlocked = false;

/* ------------------------------------------------------------------ prompt */

/** Draw and display the next target. Single entry point for button/keys/timer. */
function advance() {
  let prompt;
  try {
    prompt = generator.next({
      notes: settings.enabledNotes,
      intervals: settings.enabledIntervals,
    });
  } catch (err) {
    // Only reachable if a pool is empty, which settings.js guards against.
    console.error('Could not draw a prompt:', err);
    return;
  }

  currentPrompt = prompt;
  el.note.textContent = prompt.note;
  el.interval.textContent = prompt.interval.label;
  renderTarget();

  sessionCount += 1;
  el.count.textContent = String(sessionCount);

  flash();
  audio.tick();

  // Auto-advance is a chain of timeouts rather than an interval so the clock
  // restarts from each actual prompt change, however it was triggered.
  if (settings.autoAdvance) scheduleNext();
}

/** Show or hide the resolved target note for whatever is on screen. */
function renderTarget() {
  if (settings.showTargetNote && currentPrompt) {
    el.target.textContent = `→ ${currentPrompt.targetNote}`;
    el.target.hidden = false;
  } else {
    el.target.textContent = '';
    el.target.hidden = true;
  }
}

/** Re-trigger the change animation, even when the value is unchanged. */
function flash() {
  el.prompt.classList.remove('is-flash');
  void el.prompt.offsetWidth; // force reflow so the animation restarts
  el.prompt.classList.add('is-flash');
}

/* ----------------------------------------------------------- auto-advance */

function scheduleNext() {
  clearTimer();
  timerId = setTimeout(advance, settings.intervalMs);
}

function clearTimer() {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

/** Bring the running timer in line with the current settings. */
function syncTimer() {
  if (settings.autoAdvance) {
    el.nextBtn.classList.add('is-running');
    scheduleNext();
  } else {
    el.nextBtn.classList.remove('is-running');
    clearTimer();
  }
}

/* ---------------------------------------------------------------- settings */

function applySettings(next) {
  const prev = settings;
  settings = next;
  saveSettings(next);

  audio.setEnabled(next.sound);
  audio.setVolume(next.volume);

  // A pool change invalidates the generator's coverage bags.
  if (
    prev.enabledNotes.join() !== next.enabledNotes.join() ||
    prev.enabledIntervals.join() !== next.enabledIntervals.join()
  ) {
    generator.reset();
  }

  renderTarget();

  if (prev.autoAdvance !== next.autoAdvance || prev.intervalMs !== next.intervalMs) {
    syncTimer();
  }
}

function openPanel() {
  if (panelOpen) return;
  panelOpen = true;
  el.panel.hidden = false;
  el.scrim.hidden = false;
  // Next frame, so the transition has a start state to animate from.
  requestAnimationFrame(() => {
    el.panel.classList.add('is-open');
    el.scrim.classList.add('is-open');
  });
  el.panelToggle.setAttribute('aria-expanded', 'true');

  panelHandle = renderSettingsPanel(el.panel, settings, applySettings);
  const first = el.panel.querySelector('button, input, select');
  if (first) first.focus();
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  el.panel.classList.remove('is-open');
  el.scrim.classList.remove('is-open');
  el.panelToggle.setAttribute('aria-expanded', 'false');

  const finish = () => {
    if (panelOpen) return; // reopened mid-transition
    el.panel.hidden = true;
    el.scrim.hidden = true;
    if (panelHandle) {
      panelHandle.destroy();
      panelHandle = null;
    }
  };
  setTimeout(finish, 250);
  el.panelToggle.focus();
}

/* ---------------------------------------------------------------- wiring */

/** Browsers require a user gesture before audio will start. */
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audio.unlock();
}

el.nextBtn.addEventListener('click', () => {
  unlockAudio();
  advance();
});

el.panelToggle.addEventListener('click', () => {
  unlockAudio();
  panelOpen ? closePanel() : openPanel();
});

el.scrim.addEventListener('click', closePanel);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panelOpen) {
    closePanel();
    return;
  }

  if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return;
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;

  // Don't hijack keys aimed at a control the user is actually operating.
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('#settings-panel')) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  if (target === el.panelToggle) return;

  // The button's own click handler would otherwise fire this a second time.
  event.preventDefault();
  unlockAudio();
  advance();
});

// Practising is a leave-it-open activity; don't burn a timer in a hidden tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimer();
  else if (settings.autoAdvance) scheduleNext();
});

audio.setEnabled(settings.sound);
audio.setVolume(settings.volume);
syncTimer();
