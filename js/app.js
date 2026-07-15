/**
 * rhythm space — App Controller
 * Clean rewrite: proper state, event delegation, no inline handlers.
 */
'use strict';

const E = window.MusicEngine;
const CLOUD_SHEET_ID_KEY = 'rymspace.currentSheetId.v1';

// ── Constants ────────────────────────────────────────────────────

// ── Categories ───────────────────────────────────────────────────
// v10: parts no longer pick an "instrument" from a fixed list of ~25.
// Instead a part has a free-text `name` (purely cosmetic — "2nd Violin",
// "Cello II", whatever the user wants to call it) and a `category`, which
// selects which physics model in playback.js's RCP plays it. CATEGORIES
// holds the display metadata (default clef, whether it takes a capo/pedal)
// that used to live per-instrument in INSTRUMENTS.
const CATEGORIES = {
  'bowed-strings':       { label:'Violin Family',        clef:'treble', pedal:false, capo:false, bowing:true,  grace:true  },
  'plucked-strings':     { label:'Guitar Family',        clef:'treble', pedal:false, capo:true,  bowing:false, grace:true  },
  'struck-strings':      { label:'Piano',                clef:'treble', pedal:true,  capo:false, bowing:false, grace:true  },
  'sustained-keys':      { label:'Organ',                clef:'treble', pedal:true,  capo:false, bowing:false, grace:false },
  'open-winds':          { label:'Flute',                clef:'treble', pedal:false, capo:false, bowing:false, grace:true  },
  'reed-winds':          { label:'Clarinet & Sax',       clef:'treble', pedal:false, capo:false, bowing:false, grace:true  },
  brass:                 { label:'Brass',                clef:'treble', pedal:false, capo:false, bowing:false, grace:true  },
  'membrane-percussion': { label:'Drums',                clef:'bass',   pedal:false, capo:false, bowing:false, grace:false },
  'tuned-bars':          { label:'Xylophone & Marimba',  clef:'treble', pedal:false, capo:false, bowing:false, grace:false },
  'metal-percussion':    { label:'Bells & Chimes',       clef:'treble', pedal:false, capo:false, bowing:false, grace:false },
  custom:                { label:'Custom',               clef:'treble', pedal:false, capo:false, bowing:false, grace:true  }
};

// Placeholder category glyphs — simple two-letter badges standing in for
// real icons until proper artwork exists. To swap in real icons later,
// only categoryIconMarkup() needs to change; every caller just treats its
// return value as opaque markup.
const CATEGORY_ICON_LABEL = {
  'bowed-strings':       'VF',
  'plucked-strings':     'GF',
  'struck-strings':      'PN',
  'sustained-keys':      'OR',
  'open-winds':          'FL',
  'reed-winds':          'CS',
  brass:                 'BR',
  'membrane-percussion': 'DR',
  'tuned-bars':          'XM',
  'metal-percussion':    'BC',
  custom:                'CU'
};

function categoryIconMarkup(category) {
  const code = CATEGORY_ICON_LABEL[category] || '?';
  return `<span class="cat-badge">${code}</span>`;
}

// Suggested default part name per category, used only to pre-fill the
// Add Part modal's name field — the user can always rename freely.
const CATEGORY_DEFAULT_NAME = {
  'bowed-strings':'Violin', 'plucked-strings':'Guitar', 'struck-strings':'Piano',
  'sustained-keys':'Organ', 'open-winds':'Flute', 'reed-winds':'Clarinet',
  brass:'Trumpet', 'membrane-percussion':'Drums', 'tuned-bars':'Marimba',
  'metal-percussion':'Celesta', custom:'Custom'
};

const STRING_TUNINGS = {
  guitar: {
    label: 'Guitar standard',
    strings: [
      { name:'e', pitch:'E', accidental:null, octave:4 },
      { name:'B', pitch:'B', accidental:null, octave:3 },
      { name:'G', pitch:'G', accidental:null, octave:3 },
      { name:'D', pitch:'D', accidental:null, octave:3 },
      { name:'A', pitch:'A', accidental:null, octave:2 },
      { name:'E', pitch:'E', accidental:null, octave:2 }
    ]
  },
  dropD: {
    label: 'Drop D',
    strings: [
      { name:'e', pitch:'E', accidental:null, octave:4 },
      { name:'B', pitch:'B', accidental:null, octave:3 },
      { name:'G', pitch:'G', accidental:null, octave:3 },
      { name:'D', pitch:'D', accidental:null, octave:3 },
      { name:'A', pitch:'A', accidental:null, octave:2 },
      { name:'D', pitch:'D', accidental:null, octave:2 }
    ]
  },
  ukulele: {
    label: 'Ukulele standard',
    strings: [
      { name:'A', pitch:'A', accidental:null, octave:4 },
      { name:'E', pitch:'E', accidental:null, octave:4 },
      { name:'C', pitch:'C', accidental:null, octave:4 },
      { name:'G', pitch:'G', accidental:null, octave:4 }
    ]
  }
};

const DEFAULT_TUNING_ID = 'guitar';
const MAX_TAB_FRET = 24;
const REVIEW_TAB_SPAN = 7;

// Migrates pre-v10 saved scores / MusicXML imports, which stored a fixed
// instrument name (part.instrument) instead of a category, into the new
// model. Also used as the display name for legacy parts that don't yet
// have a user-chosen name.
const LEGACY_INSTRUMENT_TO_CATEGORY = {
  Piano:'struck-strings',
  Guitar:'plucked-strings', Banjo:'plucked-strings', Ukulele:'plucked-strings', Harp:'plucked-strings',
  Violin:'bowed-strings', Viola:'bowed-strings', Cello:'bowed-strings', Bass:'bowed-strings',
  Organ:'sustained-keys',
  Flute:'open-winds',
  Clarinet:'reed-winds', Oboe:'reed-winds', Bassoon:'reed-winds', Saxophone:'reed-winds',
  Trumpet:'brass', Horn:'brass', Trombone:'brass', Tuba:'brass',
  Marimba:'tuned-bars', Xylophone:'tuned-bars', Vibraphone:'tuned-bars',
  Celesta:'metal-percussion', Glockenspiel:'metal-percussion',
  Timpani:'membrane-percussion', Drums:'membrane-percussion',
  Custom:'custom'
};

/** Migrate a raw loaded part object (old `.instrument` or new `.category`) in place. */
function migratePart(p) {
  if (!p.category) {
    p.category = LEGACY_INSTRUMENT_TO_CATEGORY[p.instrument] || 'struck-strings';
    if (!p.name && p.instrument) p.name = p.instrument;
  }
  if (!CATEGORIES[p.category]) p.category = 'struck-strings';
  if (!p.clef) p.clef = CATEGORIES[p.category].clef;
  if (p.category === 'plucked-strings') {
    if (!p.tuningId || !STRING_TUNINGS[p.tuningId]) p.tuningId = DEFAULT_TUNING_ID;
    if (!Number.isFinite(p.capoFret)) p.capoFret = 0;
  }
  (p.notes || []).forEach(ev => {
    if (ev && ev.type === 'note' && !Array.isArray(ev.pitches)) {
      ev.pitches = [{ pitch:ev.pitch, accidental:ev.accidental || null, octave:ev.octave }];
    }
  });
  delete p.instrument;
  return p;
}

// Ordered shortest→longest (matches standard notation apps: 1=32nd … 6=whole, 7=triplet).
// Dotted variants are NOT stored here — the `dotted` flag in state handles them.
// This prevents curDur() from ever producing invalid strings like 'quarter-dotted-dotted'.
const DURATIONS = ['thirty-second','sixteenth','eighth','quarter','half','whole','quarter-triplet'];

const KEY_NAMES = ['C','G','D','A','E','B','F#','C#','F','Bb','Eb','Ab','Db','Gb','Cb'];
const KEY_LABELS = ['C','G (1♯)','D (2♯)','A (3♯)','E (4♯)','B (5♯)','F♯ (6♯)','C♯ (7♯)',
                    'F (1♭)','B♭ (2♭)','E♭ (3♭)','A♭ (4♭)','D♭ (5♭)','G♭ (6♭)','C♭ (7♭)'];
const INST_MARK_GROUPS = {
  _guitar: {
    title:'Guitar/Plucked Marks',
    sections:[
      { label:'Technique', marks:[
        {t:'harm.',  sub:'expression', label:'Harmonic'},
        {t:'nat.',   sub:'expression', label:'Natural harmonic'},
        {t:'p.m.',   sub:'expression', label:'Palm mute'},
        {t:'T',      sub:'expression', label:'Tap'},
        {t:'gliss.', sub:'expression', label:'Glissando'},
        {t:'div.',   sub:'expression', label:'Divisi'}
      ]},
      { label:'Bowing / Direction', marks:[
        {art:'staccato', label:'Staccato'},
        {art:'accent',   label:'Accent'}
      ]}
    ]
  },
  _bowed: {
    title:'Bowed String Marks',
    sections:[
      { label:'Bow Direction', marks:[
        {t:'↓', sub:'expression', label:'Down bow'},
        {t:'∏', sub:'expression', label:'Up bow'},
        {t:'col legno', sub:'expression', label:'Col legno'},
        {t:'sul pont.', sub:'expression', label:'Sul ponticello'},
        {t:'sul tasto', sub:'expression', label:'Sul tasto'},
        {t:'harm.',     sub:'expression', label:'Harmonic'},
        {t:'pizz.',     sub:'expression', label:'Pizzicato'},
        {t:'arco',      sub:'expression', label:'Arco'},
        {t:'spicc.',    sub:'expression', label:'Spiccato'}
      ]}
    ]
  },
  _drums: {
    title:'Drum/Percussion Marks',
    sections:[
      { label:'Notation', marks:[
        {t:'o',     sub:'expression', label:'Open'},
        {t:'+',     sub:'expression', label:'Closed'},
        {t:'x',     sub:'expression', label:'Cross-stick'},
        {t:'⊕',     sub:'expression', label:'Half-open'},
        {t:'choke', sub:'expression', label:'Choke cymbal'},
        {t:'bell',  sub:'expression', label:'Bell'},
        {t:'mt.',   sub:'expression', label:'Muted'}
      ]},
      { label:'Roll', marks:[
        {art:'tremolo1', label:'Single-stroke roll'},
        {art:'tremolo2', label:'Double-stroke roll'},
        {art:'tremolo3', label:'Triple roll'}
      ]}
    ]
  },
  _mallets: {
    title:'Mallet Percussion Marks',
    sections:[
      { label:'Roll', marks:[
        {art:'tremolo1', label:'Single-stroke roll'},
        {art:'tremolo2', label:'Double-stroke roll'},
        {art:'tremolo3', label:'Triple roll'}
      ]}
    ]
  },
  _wind: {
    title:'Wind Instrument Marks',
    sections:[
      { label:'Technique', marks:[
        {t:'fl. tg.',  sub:'expression', label:'Flutter tongue'},
        {t:'mult.',    sub:'expression', label:'Multiphonic'},
        {t:'growl',    sub:'expression', label:'Growl'},
        {t:'slap',     sub:'expression', label:'Slap tongue'},
        {t:'key cl.',  sub:'expression', label:'Key click'},
        {t:'overblow', sub:'expression', label:'Overblown'}
      ]},
      { label:'Mute', marks:[
        {t:'Harmon',   sub:'expression', label:'Harmon mute'},
        {t:'Cup',      sub:'expression', label:'Cup mute'},
        {t:'Straight', sub:'expression', label:'Straight mute'},
        {t:'Plunger',  sub:'expression', label:'Plunger mute'},
        {t:'open',     sub:'expression', label:'Open'}
      ]}
    ]
  }
};

// ── State ────────────────────────────────────────────────────────

let parts       = [];
let activePart  = 0;
let history     = [];
let future      = [];
let durIdx      = 3;   // index into DURATIONS, default = 'quarter' (index 3 in new array)
let dotted      = false;
let octave      = 4;
let currentDyn   = 'mf';
let staccatoMode = false;   // toggle: every inserted note gets staccato automatically
let slurMode    = false;
let spanAnchor  = null;
let openMenu    = null;
let pendingAcc  = null;   // '#' | 'b' | 'n' — set by # / = / b keys before a note letter
let chordEntryActive = false;

// ── Autosave (local, per-browser) ───────────────────────────────────
// Web-only safety net: browser tabs close/crash/refresh far more casually
// than a desktop app window, so we debounce-persist the working score to
// localStorage on every mutation. This is separate from, and doesn't
// replace, the explicit file Save/Load — it's just insurance so a stray
// Cmd+W doesn't lose unsaved work. Best-effort: silently no-ops if
// localStorage is unavailable (private browsing, storage full, etc).
const AUTOSAVE_KEY = 'rymspace.autosave.v1';
const AUTOSAVE_DEBOUNCE_MS = 600;
let _autosaveTimer = null;

function scheduleAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    try {
      const titleEl = document.getElementById('comp-title');
      const data = {
        v: 2,
        title: titleEl ? titleEl.value : '',
        parts,
        savedAt: Date.now()
      };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
    } catch (_) {
      // Best-effort only — never let a storage failure interrupt editing.
    }
  }, AUTOSAVE_DEBOUNCE_MS);
}

/** Restore the last autosaved session, if any. Returns true if it did. */
function tryRestoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.parts) || !data.parts.length) return false;

    // Don't bother "restoring" a trivially blank score — not worth surfacing.
    const isTrivial = data.parts.length === 1 && (data.parts[0].notes || []).length === 0;
    if (isTrivial) return false;

    parts = data.parts.map(migratePart);
    activePart = 0;
    _partId = Math.max(0, ...parts.map(p => p.id || 0));
    const titleEl = document.getElementById('comp-title');
    if (titleEl) titleEl.value = data.title || '';
    toast('Restored your last unsaved session');
    return true;
  } catch (_) {
    return false;
  }
}

// ── Enharmonic half-step helper ───────────────────────────────────

/**
 * What clef/key/time signature is actually in effect at a part's current
 * cursor — the most recent clef/key/timesig token before the cursor,
 * falling back to the part's baseline if none has been inserted yet.
 * This is what a "Here" change is relative to, and what newly-typed
 * notes and the status bar should reflect — NOT the part's baseline
 * (p.clef/p.key/p.timeSig), which only describes measure 1's starting
 * state and doesn't move as you type past a local change.
 */
function effectiveStateAtCursor(p) {
  let clef = p.clef || 'treble';
  let key  = p.key  || 'C';
  let timeSig = p.timeSig || '4/4';
  const notes = p.notes || [];
  const upTo = Math.min(p.cursor ?? notes.length, notes.length);
  for (let i = 0; i < upTo; i++) {
    const ev = notes[i];
    if (ev.type === 'clef')    clef    = ev.clef;
    if (ev.type === 'key')     key     = ev.key;
    if (ev.type === 'timesig') timeSig = ev.timesig;
  }
  return { clef, key, timeSig };
}

/**
 * Return preferred accidental type for the key sig in effect at the
 * active part's CURSOR (not the part's baseline key — see
 * effectiveStateAtCursor). 'sharp' | 'flat' | 'none'
 */
function keySigType() {
  const key = effectiveStateAtCursor(ap()).key;
  const def = E.KEY_SIGS[key];
  return (def && def.type !== 'none') ? def.type : 'none';
}

/**
 * Move pitch by one chromatic half-step, spelling enharmonics according to
 * the key signature (sharps in sharp keys, flats in flat keys, sharps up /
 * flats down in C major).
 */
function chromStepNote(pitch, acc, octave, direction) {
  const type    = keySigType();
  const useFlats = type === 'flat' || (type === 'none' && direction < 0);

  const c       = E.noteToChrom(pitch, acc, octave) + direction;
  const clamped = Math.max(0, Math.min(8 * 12 + 11, c));
  const sem     = ((clamped % 12) + 12) % 12;
  const oct     = Math.floor(clamped / 12);

  // Semitones that have two enharmonic spellings
  const ENHARMONICS = {
    1:  [{ p:'C', a:'#' }, { p:'D', a:'b' }],
    3:  [{ p:'D', a:'#' }, { p:'E', a:'b' }],
    6:  [{ p:'F', a:'#' }, { p:'G', a:'b' }],
    8:  [{ p:'G', a:'#' }, { p:'A', a:'b' }],
    10: [{ p:'A', a:'#' }, { p:'B', a:'b' }],
  };
  if (ENHARMONICS[sem]) {
    const [sharp, flat] = ENHARMONICS[sem];
    const chosen = useFlats ? flat : sharp;
    return { pitch: chosen.p, accidental: chosen.a, octave: oct };
  }
  const NATURALS = { 0:'C', 2:'D', 4:'E', 5:'F', 7:'G', 9:'A', 11:'B' };
  return { pitch: NATURALS[sem], accidental: null, octave: oct };
}

function ap()     { return parts[activePart]; }
function curDur() { return dotted ? DURATIONS[durIdx]+'-dotted' : DURATIONS[durIdx]; }

function partState(p) {
  return {
    clef:          p.clef          || 'treble',
    key:           p.key           || 'C',
    currentTimeSig: p.timeSig      || '4/4',
    category:      p.category      || 'struck-strings'
  };
}

function globalRenderState() {
  return {
    parts:      parts.map(p => ({ notes: p.notes, ...partState(p) })),
    activePart,
    slurAnchor: spanAnchor
  };
}

// ── Part management ───────────────────────────────────────────────

function makePart(id, name, category, clef) {
  const cat = CATEGORIES[category] ? category : 'struck-strings';
  return {
    id, name,
    category: cat,
    clef:     clef || CATEGORIES[cat].clef,
    key:      'C',
    timeSig:  '4/4',
    cursor:   0,
    notes:    [],
    slurs:    [],
    hairpins: [],
    accidentals: {},
    tuningId: cat === 'plucked-strings' ? DEFAULT_TUNING_ID : null,
    capoFret: 0
  };
}

let _partId = 0;

function addPart(name, category, clef) {
  saveState();
  const nm = name && name.trim() ? name.trim() : (CATEGORY_DEFAULT_NAME[category] || 'Part') + ' ' + (parts.length + 1);
  parts.push(makePart(++_partId, nm, category, clef));
  setActivePart(parts.length - 1);
  rebuildPartsPanel();
  render();
}

function removePart(idx) {
  if (parts.length <= 1) { toast('Cannot remove the last part'); return; }
  saveState();
  parts.splice(idx, 1);
  if (activePart >= parts.length) activePart = parts.length - 1;
  rebuildPartsPanel();
  render();
}

function setActivePart(idx) {
  activePart = Math.max(0, Math.min(parts.length - 1, idx));
  syncStatus();
  syncControls();
  rebuildPartsPanel();
  render();
}

function renamePart(idx, name) {
  parts[idx].name = name;
  rebuildPartsPanel();
}

function rebuildPartsPanel() {
  const list = document.getElementById('parts-list');
  if (!list) return;
  list.innerHTML = '';
  parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'part-row' + (i === activePart ? ' active' : '');
    row.innerHTML = `
      <input class="part-name" value="${escHtml(p.name)}" spellcheck="false">
      <span class="part-inst">${escHtml((CATEGORIES[p.category] || {}).label || p.category)}</span>
      <button class="part-del" title="Remove part">×</button>`;
    row.querySelector('.part-name').addEventListener('change', e => renamePart(i, e.target.value));
    row.querySelector('.part-del').addEventListener('click', e => { e.stopPropagation(); removePart(i); });
    row.addEventListener('click', e => { if (e.target.classList.contains('part-name') || e.target.classList.contains('part-del')) return; setActivePart(i); });
    list.appendChild(row);
  });
  document.getElementById('part-count').textContent = parts.length;
}

// ── Undo / Redo ────────────────────────────────────────────────────

function snapshot() {
  return JSON.parse(JSON.stringify({ parts, activePart }));
}

function saveState() {
  history.push(snapshot());
  if (history.length > 80) history.shift();
  future = [];
}

function undo() {
  if (!history.length) return;
  future.push(snapshot());
  const s = history.pop();
  parts = s.parts; activePart = s.activePart;
  afterMutation();
}

function redo() {
  if (!future.length) return;
  history.push(snapshot());
  const s = future.pop();
  parts = s.parts; activePart = s.activePart;
  afterMutation();
}

function afterMutation() {
  rebuildPartsPanel();
  syncStatus();
  syncControls();
  render();
  scheduleAutosave();
}

// ── Note operations ───────────────────────────────────────────────

function insertNote(pitch) {
  const p  = ap();
  const dur = curDur();
  const accResult = inputAccidentalForPitch(p, pitch);
  const acc = accResult.acc;
  set('si-note', '');

  const chordTarget = chordEntryActive ? p.notes[p.cursor - 1] : null;
  if (chordTarget && chordTarget.type === 'note') {
    saveState();
    const base = notePitchList(chordTarget)[0];
    const useOctave = inferOctaveForPitch(p, pitch, acc, base ? base.octave : octave);
    chordTarget.pitches = notePitchList(chordTarget).slice();
    chordTarget.pitches.push({ pitch, accidental:acc, octave:useOctave, accExplicit:accResult.explicit });
    chordTarget.pitches.sort((a, b) => pitchChrom(a) - pitchChrom(b));
    syncPrimaryPitch(chordTarget);
    refreshTabForEvent(p, chordTarget);
    chordEntryActive = false;
    afterMutation();
    return;
  }

  saveState();
  const useOctave = inferOctaveForPitch(p, pitch, acc, octave);
  if (useOctave !== octave) setOctave(useOctave);

  const ev = {
    _id: Date.now() + Math.random(),
    type: 'note',
    pitch,
    octave: useOctave,
    duration: dur,
    accidental: acc,
    accExplicit: accResult.explicit,
    pitches: [{ pitch, accidental:acc, octave:useOctave, accExplicit:accResult.explicit }]
  };
  if (staccatoMode) {
    ev.articulations = ev.articulations || [];
    if (!ev.articulations.includes('staccato')) ev.articulations.push('staccato');
    ev.staccato = true;
  }
  refreshTabForEvent(p, ev);
  p.notes.splice(p.cursor, 0, ev);
  p.cursor++;
  chordEntryActive = false;

  afterMutation();
}
function insertRest() {
  saveState();
  const p = ap();
  p.notes.splice(p.cursor, 0, { _id: Date.now()+Math.random(), type:'rest', duration:curDur() });
  p.cursor++;
  afterMutation();
}

function deleteBack() {
  const p = ap();
  if (p.cursor <= 0) return;
  saveState();
  p.notes.splice(p.cursor - 1, 1);
  p.cursor--;
  afterMutation();
}

function moveCursor(delta) {
  const p = ap();
  p.cursor = Math.max(0, Math.min(p.notes.length, p.cursor + delta));
  syncStatus();
  render();
}

function raisePitch() {
  const p = ap();
  const note = p.notes[p.cursor - 1];
  if (!note || note.type !== 'note') return;
  saveState();
  const n = chromStepNote(note.pitch, note.accidental, note.octave, +1);
  note.pitch = n.pitch; note.accidental = n.accidental; note.octave = n.octave;
  note.accExplicit = (n.accidental != null);
  if (Array.isArray(note.pitches) && note.pitches[0]) {
    note.pitches[0] = { pitch:n.pitch, accidental:n.accidental, octave:n.octave, accExplicit:note.accExplicit };
  }
  refreshTabForEvent(p, note);
  afterMutation();
}

function lowerPitch() {
  const p = ap();
  const note = p.notes[p.cursor - 1];
  if (!note || note.type !== 'note') return;
  saveState();
  const n = chromStepNote(note.pitch, note.accidental, note.octave, -1);
  note.pitch = n.pitch; note.accidental = n.accidental; note.octave = n.octave;
  note.accExplicit = (n.accidental != null);
  if (Array.isArray(note.pitches) && note.pitches[0]) {
    note.pitches[0] = { pitch:n.pitch, accidental:n.accidental, octave:n.octave, accExplicit:note.accExplicit };
  }
  refreshTabForEvent(p, note);
  afterMutation();
}

function setOctave(n) {
  octave = n;
  syncStatus();
}

function setDuration(d) {
  if (d.endsWith('-dotted')) {
    const base = d.replace('-dotted', '');
    const j = DURATIONS.indexOf(base);
    if (j !== -1) { durIdx = j; dotted = true; }
  } else {
    const i = DURATIONS.indexOf(d);
    if (i !== -1) { durIdx = i; dotted = false; }
  }
  syncStatus();
}

function cycleDuration(dir = 1) {
  durIdx = (durIdx + dir + DURATIONS.length) % DURATIONS.length;
  dotted = false;
  syncStatus();
}

function toggleDotted() {
  const d = DURATIONS[durIdx];
  // thirty-second and triplet can't be dotted
  if (d === 'thirty-second' || d.includes('triplet')) return;
  dotted = !dotted;
  syncStatus();
}

function inputAccidentalForPitch(p, pitch) {
  // If user pre-typed an accidental prefix (#/b/=), honour it unconditionally.
  if (pendingAcc !== null) {
    const acc = (pendingAcc === 'n') ? null : pendingAcc;   // 'n' = natural → null acc
    pendingAcc = null;
    set('si-note', '');
    // Mark the note as explicitly accidentalled so the renderer shows the symbol.
    return { acc, explicit: true };
  }

  // Otherwise apply the key signature actually in effect at the cursor —
  // NOT the part's baseline key, which may be stale after a local "Here"
  // key change earlier in the piece.
  const key = effectiveStateAtCursor(p).key;
  const defAcc = E.defaultAccForKey(key, pitch);
  // Non-explicit: accidental is implied by key sig, no courtesy symbol needed.
  return { acc: defAcc, explicit: false };
}

function notePitchList(ev) {
  if (!ev || ev.type !== 'note') return [];
  if (Array.isArray(ev.pitches) && ev.pitches.length) return ev.pitches;
  return [{ pitch:ev.pitch, accidental:ev.accidental || null, octave:ev.octave }];
}

function pitchChrom(pitchInfo) {
  return E.noteToChrom(pitchInfo.pitch, pitchInfo.accidental ?? pitchInfo.acc ?? null, pitchInfo.octave);
}

function syncPrimaryPitch(ev) {
  const first = notePitchList(ev)[0];
  if (!first) return;
  ev.pitch = first.pitch;
  ev.accidental = first.accidental ?? first.acc ?? null;
  ev.octave = first.octave;
  ev.accExplicit = !!first.accExplicit;
}

function inferOctaveForPitch(p, pitch, acc, anchorOctave = octave) {
  const prior = (p.notes || []).slice(0, p.cursor).filter(n => n.type === 'note');
  if (!prior.length) return anchorOctave;

  const prev = notePitchList(prior[prior.length - 1])[0];
  const prevChrom = pitchChrom(prev);
  const prev2 = prior.length > 1 ? notePitchList(prior[prior.length - 2])[0] : null;
  const expected = prev2
    ? prevChrom + Math.max(-12, Math.min(12, prevChrom - pitchChrom(prev2)))
    : prevChrom;

  let bestOct = anchorOctave;
  let bestScore = Infinity;
  for (let o = Math.max(0, anchorOctave - 2); o <= Math.min(8, anchorOctave + 2); o++) {
    const c = E.noteToChrom(pitch, acc, o);
    const closeScore = Math.abs(c - prevChrom);
    const contourScore = Math.abs(c - expected) * 0.45;
    const jumpPenalty = Math.max(0, Math.abs(c - prevChrom) - 7) * 0.8;
    const score = closeScore + contourScore + jumpPenalty;
    if (score < bestScore) { bestScore = score; bestOct = o; }
  }
  return bestOct;
}

function tuningForPart(p) {
  return STRING_TUNINGS[p.tuningId] || STRING_TUNINGS[DEFAULT_TUNING_ID];
}

function tabCandidatesForPitch(p, pitchInfo) {
  const capo = Math.max(0, Math.min(20, parseInt(p.capoFret || 0, 10) || 0));
  const target = pitchChrom(pitchInfo);
  const strings = tuningForPart(p).strings;
  const exact = strings.map((s, stringIdx) => {
    const open = E.noteToChrom(s.pitch, s.accidental, s.octave) + capo;
    const fret = target - open;
    return fret >= 0 && fret <= MAX_TAB_FRET ? { stringIdx, stringName:s.name, fret } : null;
  }).filter(Boolean);
  if (exact.length) return exact;

  let fallback = null;
  strings.forEach((s, stringIdx) => {
    const open = E.noteToChrom(s.pitch, s.accidental, s.octave) + capo;
    const rawFret = target - open;
    const fret = Math.max(0, Math.min(MAX_TAB_FRET, rawFret));
    const distance = Math.abs(rawFret - fret);
    const choice = { stringIdx, stringName:s.name, fret, forced:true, distance };
    if (!fallback || choice.distance < fallback.distance) fallback = choice;
  });
  return fallback ? [fallback] : [];
}

function chooseTabForNote(p, pitches) {
  if (p.category !== 'plucked-strings') return null;
  const choices = pitches.map(pi => tabCandidatesForPitch(p, pi));
  if (choices.some(list => !list.length)) return { review:true, reason:'out-of-range', positions:[] };

  let best = null;
  function walk(i, used, positions) {
    if (i === choices.length) {
      const frets = positions.map(pos => pos.fret);
      const span = frets.length ? Math.max(...frets) - Math.min(...frets) : 0;
      const maxFret = frets.length ? Math.max(...frets) : 0;
      const score = span * 7 + maxFret + positions.reduce((sum, pos) => sum + pos.stringIdx * 0.25, 0);
      if (!best || score < best.score) best = { score, positions:positions.slice(), span };
      return;
    }
    for (const c of choices[i]) {
      if (used.has(c.stringIdx)) continue;
      used.add(c.stringIdx);
      positions.push({ ...c, pitch:pitches[i] });
      walk(i + 1, used, positions);
      positions.pop();
      used.delete(c.stringIdx);
    }
  }
  walk(0, new Set(), []);
  if (!best) {
    const positions = choices.map(list => list[0]).filter(Boolean);
    return { review:true, reason:'not-enough-strings', positions };
  }
  const forced = best.positions.some(pos => pos.forced);
  const review = forced || best.span > REVIEW_TAB_SPAN;
  return {
    review,
    reason: forced ? 'out-of-range' : best.span > REVIEW_TAB_SPAN ? 'wide-stretch' : '',
    positions: best.positions
  };
}

function refreshTabForEvent(p, ev) {
  if (!ev || ev.type !== 'note') return;
  ev.pitches = notePitchList(ev);
  ev.tab = chooseTabForNote(p, ev.pitches);
}

// ── Articulations ─────────────────────────────────────────────────

function toggleArticulation(art) {
  const p = ap();
  const note = p.notes[p.cursor - 1];
  if (!note || note.type !== 'note') { toast('Select a note first'); return; }
  saveState();
  if (!note.articulations) note.articulations = [];
  const i = note.articulations.indexOf(art);
  if (i === -1) note.articulations.push(art);
  else note.articulations.splice(i, 1);
  afterMutation();
}

function setTremolo(count) {
  const p = ap();
  const note = p.notes[p.cursor - 1];
  if (!note || note.type !== 'note') { toast('Select a note first'); return; }
  saveState();
  note.tremolo = (note.tremolo === count) ? undefined : count;
  afterMutation();
}

function toggleTie() {
  const p = ap();
  const note = p.notes[p.cursor - 1];
  if (!note || note.type !== 'note') { toast('Select a note first'); return; }
  saveState();
  note.tie = !note.tie;
  afterMutation();
}

function toggleSlurMode() {
  slurMode = !slurMode;
  spanAnchor = null;
  document.getElementById('btn-slur').classList.toggle('active', slurMode);
  if (!slurMode) toast('Slur mode off');
  else toast('Slur: click first note, then last note');
}

function handleSlurNoteClick(pIdx, noteId) {
  if (!slurMode) return;
  const p = parts[pIdx];
  if (!spanAnchor) {
    spanAnchor = { partIdx: pIdx, noteId };
    toast('Slur start set — click end note');
  } else {
    if (spanAnchor.partIdx !== pIdx) { toast('Slur must be within the same part'); return; }
    saveState();
    const i0 = p.notes.findIndex(n => n._id === spanAnchor.noteId);
    const i1 = p.notes.findIndex(n => n._id === noteId);
    
    if (i0 === -1 || i1 === -1 || i0 === i1) { 
      toast('Invalid slur range'); 
    } else {
      // Order independence: ensures fromId is always the chronologically earlier note
      const fromId = i0 < i1 ? spanAnchor.noteId : noteId;
      const toId   = i0 < i1 ? noteId : spanAnchor.noteId;
      
      if (!p.slurs) p.slurs = [];
      p.slurs.push({ fromId, toId });
      toast('Slur added');
    }
    spanAnchor = null;
    slurMode = false;
    document.getElementById('btn-slur').classList.remove('active');
    afterMutation();
  }
}

// ── Token insertions ──────────────────────────────────────────────

function insertToken(obj) {
  saveState();
  const p = ap();
  p.notes.splice(p.cursor, 0, { _id: Date.now()+Math.random(), ...obj });
  p.cursor++;
  afterMutation();
}

// NOTE: these insert a LOCAL change token at the cursor only. They must
// NOT touch ap().clef/timeSig/key — those are the part's BASELINE (its
// state at the very start of the piece), owned by the header controls
// and Score → Global. Mutating the baseline here was what made every
// "Here" insert (Score panel, K/T/L hotkeys, and their modals — they all
// funnel through these three functions) behave like "Global" instead.
function insertClef(clef)     { insertToken({ type:'clef', clef }); }
function insertTimeSig(ts)    { insertToken({ type:'timesig', timesig:ts }); }
function insertKey(key)       { insertToken({ type:'key', key }); }
function insertRepeatStart()  { insertToken({ type:'repeat', direction:'start' }); }
function insertRepeatEnd()    { insertToken({ type:'repeat', direction:'end' }); }
function insertDynamic(dyn)   { insertToken({ type:'dynamic', dynamic:dyn }); }
function insertTextMark(text, subtype) { insertToken({ type:'text-mark', text, subtype: subtype||'expression' }); }
function insertPedalDown()    { insertToken({ type:'pedal', pedal:'down' }); }
function insertPedalUp()      { insertToken({ type:'pedal', pedal:'up' }); }
function insertRehearsal(lbl) { insertToken({ type:'rehearsal', label:lbl }); }
function insertSegno()        { insertToken({ type:'segno' }); }
function insertCoda()         { insertToken({ type:'coda' }); }
function insertNavMark(nav)   { insertToken({ type:'nav', nav }); }
function insertCapo(fret)     { insertToken({ type:'text', text:`Capo ${fret}`, subtype:'expression' }); }
function insertMute(on)       { insertToken({ type:'text-mark', text: on ? 'con sord.' : 'senza sord.', subtype:'expression' }); }

function applyTabSetup(tuningId, capoFret) {
  const p = ap();
  if (p.category !== 'plucked-strings') {
    toast('TAB setup applies to Guitar Family parts');
    return;
  }
  saveState();
  p.tuningId = STRING_TUNINGS[tuningId] ? tuningId : DEFAULT_TUNING_ID;
  p.capoFret = Math.max(0, Math.min(20, parseInt(capoFret, 10) || 0));
  (p.notes || []).forEach(ev => refreshTabForEvent(p, ev));
  afterMutation();
}

function applyGlobalClef(clef)   { saveState(); parts.forEach(p => { p.clef = clef; }); afterMutation(); }
function applyGlobalTimeSig(ts)  { saveState(); parts.forEach(p => { p.timeSig = ts; }); afterMutation(); }
function applyGlobalKey(key)     { saveState(); parts.forEach(p => { p.key = key; }); afterMutation(); }

// ── Dynamics ────────────────────────────────────────────────────────
// Every entry path (swatch click, Alt+1–8, and the modal) inserts a
// single dynamic marking token at the cursor via quickDynamic() below —
// there is no separate "pen mode" that silently tags future notes
// anymore. That's both correct engraving (a dynamic is shown once, at
// the point it changes) and correct playback (playback.js's _flattenPart
// already tracks "current dynamic in effect" from standalone tokens).

function toggleStaccatoMode() {
  staccatoMode = !staccatoMode;
  const btn = document.getElementById('btn-staccato-mode');
  if (btn) btn.classList.toggle('active', staccatoMode);
  toast(staccatoMode ? 'Staccato mode ON — all notes will be staccato' : 'Staccato mode OFF');
  syncStatus();
}

function selectDynamic(dyn) {
  currentDyn = dyn;
  document.querySelectorAll('.dyn-btn').forEach(b => b.classList.toggle('active', b.dataset.dyn === dyn));
}

function quickDynamic(dyn) {
  selectDynamic(dyn);
  insertDynamic(dyn);
}

// ── Playback ──────────────────────────────────────────────────────

function togglePlayback() {
  if (window.RymPlayback.isPlaying()) {
    window.RymPlayback.stop();
    document.getElementById('pb-play').textContent = '▶';
  } else {
    const bpm = parseInt(document.getElementById('pb-bpm').value) || 120;
    window.RymPlayback.play(parts, {
      bpm,
      onTick: (beat) => {
        document.getElementById('pb-time').textContent = fmtTime(beat);
      },
      onEnd: () => {
        document.getElementById('pb-play').textContent = '▶';
      }
    });
    document.getElementById('pb-play').textContent = '■';
  }
}

function fmtTime(beats) {
  const bpm  = parseInt(document.getElementById('pb-bpm').value) || 120;
  const secs = Math.floor(beats * 60 / bpm);
  return `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;
}

// ── Native Save / Load / Export ───────────────────────────────────

let currentFileHandle = null; // Keeps track of the open file for quick "Save" (Ctrl+S)

function getCloudSheetId() {
  try { return localStorage.getItem(CLOUD_SHEET_ID_KEY) || ''; } catch (_) { return ''; }
}

function setCloudSheetId(id) {
  try {
    if (id) localStorage.setItem(CLOUD_SHEET_ID_KEY, id);
    else localStorage.removeItem(CLOUD_SHEET_ID_KEY);
  } catch (_) {}
}

async function handleSave() {
  const data = { v: 2, title: document.getElementById('comp-title').value, parts };

  if (window.RymSheets) {
    try {
      const user = window.RymAuth && window.RymAuth.getCurrentUser();
      if (user) {
        const saved = await window.RymSheets.saveSheet({
          id: getCloudSheetId() || undefined,
          title: data.title || 'Untitled composition',
          data
        });
        setCloudSheetId(saved.id);
        toast('Saved to cloud');
        return;
      }
    } catch (err) {
      console.warn('Cloud save failed', err);
      toast('Cloud save failed; exporting backup');
    }
  }

  handleExport();
}

async function handleLoad() {
  try {
    if (window.showOpenFilePicker) {
      const [fileHandle] = await window.showOpenFilePicker({
        types: [{ description: 'rhythm space Score', accept: { 'application/json': ['.rym.json', '.json'] } }]
      });
      currentFileHandle = fileHandle;
      const file = await fileHandle.getFile();
      const raw = await file.text();
      loadScoreData(raw);
    } else {
      // Fallback: Invisible file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = e => {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = e => loadScoreData(e.target.result);
        reader.readAsText(file);
      };
      input.click();
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Load failed');
  }
}

function loadScoreData(raw, options = {}) {
  try {
    const data = JSON.parse(raw);
    parts = (data.parts || parts).map(migratePart);
    document.getElementById('comp-title').value = data.title || '';
    setCloudSheetId(options.cloudSheetId || '');
    currentFileHandle = null;
    activePart = 0;
    saveState(); // Push to undo history
    afterMutation();
    toast('Score Loaded');
  } catch (e) {
    toast('Invalid composition file');
  }
}

function handleExport() {
  // Always forces a "Download" instead of overwriting the current handle
  const data = { v:2, title: document.getElementById('comp-title').value, parts };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById('comp-title').value || 'composition') + '.rym.json';
  a.click();
  toast('Exported');
}
async function handleExportXML() {
  if (!window.MusicXML) {
    toast('MusicXML module not loaded');
    return;
  }
 
  const title = document.getElementById('comp-title').value || 'composition';
  let xml;
  try {
    xml = window.MusicXML.exportMusicXML(parts, title);
  } catch (err) {
    toast('Export failed: ' + err.message);
    return;
  }
 
  const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
 
  // Try File System Access API first (Chrome / Edge)
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: title + '.musicxml',
        types: [{
          description: 'MusicXML Score',
          accept: {
            'application/vnd.recordare.musicxml+xml': ['.musicxml', '.xml']
          }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(xml);
      await writable.close();
      toast('Exported as MusicXML');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Fall through to anchor-download fallback
    }
  }
 
  // Fallback: invisible <a> download
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = title + '.musicxml';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported as MusicXML');
}
 
function loadXmlString(raw) {
  try {
    const result = window.MusicXML.importMusicXML(raw);

    if (!result.parts || result.parts.length === 0) {
      toast('No parts found in MusicXML file');
      return;
    }

    saveState();   // push current score onto undo stack so it's recoverable
    parts = result.parts.map(migratePart);
    activePart = 0;
    setCloudSheetId('');
    currentFileHandle = null;

    if (result.title) {
      document.getElementById('comp-title').value = result.title;
    }

    afterMutation();
    toast(`Imported "${result.title || 'Score'}" — ${result.parts.length} part(s)`);
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
}

/** Import a .musicxml / .xml file and replace the current score. */
async function handleImportXML() {
  if (!window.MusicXML) {
    toast('MusicXML module not loaded');
    return;
  }
  // Try File System Access API first
  if (window.showOpenFilePicker) {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        types: [{
          description: 'MusicXML Score',
          accept: {
            'application/vnd.recordare.musicxml+xml': ['.musicxml', '.xml'],
            'text/xml': ['.xml']
          }
        }],
        multiple: false
      });
      const file = await fileHandle.getFile();
      loadXmlString(await file.text());
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Fall through to <input> fallback
    }
  }
 
  // Fallback: invisible <input type="file">
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.musicxml,.xml';
  input.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadXmlString(await file.text());
  };
  input.click();
}

/** Upload image/PDF, run OMR via Hugging Face/Cloudflare Worker proxy, and import. */
async function handleScanOMR() {
  if (!window.MusicXML) {
    toast('MusicXML module not loaded');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png, image/jpeg, application/pdf';
  
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    let scanToast = toast('Uploading sheet music...', { duration: 0 });

    try {
      const formData = new FormData();
      formData.append('file', file);

      const userId = window.RymAuth && window.RymAuth.getCurrentUser()?.uid;
      const headers = {};
      if (userId) {
        headers['X-Rym-User-Id'] = userId;
      }

      // Step 1: Start prediction to get task_id
      const res = await fetch('/api/sheets/omr/predict', {
        method: 'POST',
        headers: headers,
        body: formData
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Server returned ${res.status}`);
      }
      
      const { task_id } = await res.json();
      if (!task_id) throw new Error('No task ID returned');

      // Step 2: Poll for status
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/sheets/omr/status/${task_id}`, { headers });
          if (!statusRes.ok) throw new Error(`Status check failed (${statusRes.status})`);
          
          const statusData = await statusRes.json();
          
          if (statusData.status === 'done') {
            clearInterval(pollInterval);
            scanToast.remove();
            loadXmlString(statusData.result);
            toast('Sheet music successfully scanned and imported!');
          } else if (statusData.status === 'error') {
            clearInterval(pollInterval);
            scanToast.remove();
            toast(`OMR Error: ${statusData.error}`);
          } else {
            // Update toast message with current progress
            scanToast.innerText = `OMR: ${statusData.status}`;
          }
        } catch (err) {
          clearInterval(pollInterval);
          scanToast.remove();
          toast(`Polling error: ${err.message}`);
        }
      }, 3000);
      
    } catch (err) {
      console.error(err);
      if (scanToast) scanToast.remove();
      toast(`Scanning failed: ${err.message}`);
    }
  };

  input.click();
}

function clearAll() {
  if (!confirm('Start a new composition? Unsaved work will be lost.')) return;
  saveState();
  parts = [makePart(++_partId, 'Piano 1', 'struck-strings')];
  activePart = 0;
  document.getElementById('comp-title').value = '';
  setCloudSheetId('');
  currentFileHandle = null;
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) {}
  afterMutation();
}

// ── Render ────────────────────────────────────────────────────────

let _blinkOn = true;
let _blinkTimer = null;

function render() {
  const canvas = document.getElementById('staff-canvas');

  // Engine expects each part to have a `.state` sub-object for buildMeasures
  const renderParts = parts.map(p => ({
    notes:    p.notes    || [],
    slurs:    p.slurs    || [],
    hairpins: p.hairpins || [],
    state: {
      currentTimeSig: p.timeSig    || '4/4',
      currentClef:    p.clef       || 'treble',
      initialKey:     p.key        || 'C',
      category:       p.category   || 'struck-strings',
      tuningId:       p.tuningId   || DEFAULT_TUNING_ID,
      capoFret:       p.capoFret   || 0
    }
  }));

  const ap = parts[activePart] || parts[0];
  E.render(canvas, renderParts, {
    activePart,
    cursor:     ap ? ap.cursor : 0,
    spanAnchor,
    blinkOn:    _blinkOn
  });
}

function startBlink() {
  clearInterval(_blinkTimer);
  _blinkOn = true;
  render();
  _blinkTimer = setInterval(() => { _blinkOn = !_blinkOn; render(); }, 530);
}

startBlink();

// ── Webfont (Bravura) loading ───────────────────────────────────────
// Canvas text doesn't block on webfont downloads the way normal DOM text
// does, so the very first render() almost always happens before Bravura has
// finished fetching. We explicitly kick off the load and re-render once
// document.fonts.ready resolves so clef glyphs swap in without needing a
// user-triggered redraw. (See engine.js _isBravuraLoaded for the matching fix
// on the read side — it now checks document.fonts.check() live instead of
// caching a one-time glyph-width guess.)
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.load("400 64px 'Bravura'").catch(() => {});
  document.fonts.ready.then(() => { try { render(); } catch (_) {} });
}

// ── Status / Controls sync ────────────────────────────────────────

function syncStatus() {
  const p = ap();
  const eff = effectiveStateAtCursor(p);
  set('sv-octave',  octave);
  set('sv-dur',     E.DUR_LABELS[curDur()] || curDur());
  set('sv-inst',    p.name || 'Part');
  set('sv-clef',    eff.clef);
  set('sv-timesig', eff.timeSig);
  set('sv-key',     eff.key);
  set('sv-count',   p.notes.length);
  set('sv-parts',   parts.length);
  const staccEl = document.getElementById('sv-staccato');
  if (staccEl) staccEl.textContent = staccatoMode ? '· ON' : 'OFF';
  const staccWrap = document.getElementById('si-staccato');
  if (staccWrap) staccWrap.style.color = staccatoMode ? 'var(--accent)' : '';
}

/** Populate a .cat-grid container with one .cat-opt button per category. */
function renderCategoryGrid(container, selectedId, onSelect) {
  if (!container) return;
  container.innerHTML = Object.keys(CATEGORIES).map(id => `
    <button type="button" class="cat-opt${id === selectedId ? ' active' : ''}" data-cat="${id}">
      <span class="cat-icon-wrap">${categoryIconMarkup(id)}</span>
      <span>${escHtml(CATEGORIES[id].label)}</span>
    </button>`).join('');
  container.querySelectorAll('.cat-opt').forEach(btn => {
    btn.addEventListener('click', () => onSelect(btn.dataset.cat));
  });
}

function setHeaderCategoryButton(category) {
  const iconEl  = document.getElementById('cat-btn-icon');
  const labelEl = document.getElementById('cat-btn-label');
  if (iconEl)  iconEl.innerHTML = categoryIconMarkup(category);
  if (labelEl) labelEl.textContent = (CATEGORIES[category] || {}).label || category;
}

function syncControls() {
  const p = ap();
  setHeaderCategoryButton(p.category || 'struck-strings');
  const clefSel = document.getElementById('sel-clef');
  if (clefSel) clefSel.value = p.clef || 'treble';
  const tsSel = document.getElementById('sel-timesig');
  if (tsSel) tsSel.value = p.timeSig || '4/4';
  const tuningSel = document.getElementById('score-tuning');
  if (tuningSel) tuningSel.value = p.tuningId || DEFAULT_TUNING_ID;
  const capoInput = document.getElementById('score-capo');
  if (capoInput) capoInput.value = p.capoFret || 0;
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Menus ─────────────────────────────────────────────────────────

function showMenu(id, anchor) {
  closeMenu();
  const menu = document.getElementById(id);
  if (!menu) return;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
  }
  menu.classList.add('open');
  openMenu = id;
}

function closeMenu() {
  if (openMenu) {
    const m = document.getElementById(openMenu);
    if (m) m.classList.remove('open');
    openMenu = null;
  }
}

function toggleMenu(id, anchor) {
  if (openMenu === id) closeMenu();
  else showMenu(id, anchor);
}

// ── Modals ────────────────────────────────────────────────────────

function openModal(id) {
  closeMenu();
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));
}

// Key change modal
function openKeyModal()    { openModal('modal-key'); }
function confirmKeyModal() {
  insertKey(document.getElementById('modal-key-sel').value);
  closeModal('modal-key');
}

// Time sig modal
function openTimeSigModal()    { openModal('modal-timesig'); }
function confirmTimeSigModal() {
  const v = document.getElementById('modal-ts-input').value.trim();
  if (v) insertTimeSig(v);
  closeModal('modal-timesig');
}

// Clef modal
function openClefModal()    { openModal('modal-clef'); }
function confirmClefModal() {
  insertClef(document.getElementById('modal-clef-sel').value);
  closeModal('modal-clef');
}

// Dynamic modal
function openDynamicModal()    { openModal('modal-dynamic'); }
function confirmDynamicModal() {
  quickDynamic(document.getElementById('modal-dyn-sel').value);
  closeModal('modal-dynamic');
}

// Rehearsal
function openRehearsalModal()    { openModal('modal-rehearsal'); document.getElementById('modal-rehearsal-input').focus(); }
function confirmRehearsalModal() {
  const v = document.getElementById('modal-rehearsal-input').value.trim();
  if (v) { insertRehearsal(v); document.getElementById('modal-rehearsal-input').value = ''; }
  closeModal('modal-rehearsal');
}

// Tempo
function openTempoModal()    { openModal('modal-tempo'); document.getElementById('modal-tempo-input').focus(); }
function confirmTempoModal() {
  const v = document.getElementById('modal-tempo-input').value.trim();
  if (v) { insertTextMark(v, 'tempo'); document.getElementById('modal-tempo-input').value = ''; }
  closeModal('modal-tempo');
}

// Expression
function openExpressionModal()    { openModal('modal-expression'); document.getElementById('modal-expr-input').focus(); }
function confirmExpressionModal() {
  const v = document.getElementById('modal-expr-input').value.trim();
  if (v) { insertTextMark(v, 'expression'); document.getElementById('modal-expr-input').value = ''; }
  closeModal('modal-expression');
}

// Capo
function openCapoModal()    { openModal('modal-capo'); }
function confirmCapoModal() {
  const v = parseInt(document.getElementById('modal-capo-input').value);
  if (!isNaN(v)) {
    insertCapo(v);
    if (ap().category === 'plucked-strings') {
      ap().capoFret = Math.max(0, Math.min(20, v));
      (ap().notes || []).forEach(ev => refreshTabForEvent(ap(), ev));
    }
  }
  closeModal('modal-capo');
}

// Add Part
let _addPartCategory = 'struck-strings';

function refreshAddPartCategoryGrid() {
  renderCategoryGrid(document.getElementById('addpart-cat-grid'), _addPartCategory, (cat) => {
    _addPartCategory = cat;
    const nameInput = document.getElementById('modal-addpart-name');
    const clefSel   = document.getElementById('modal-addpart-clef');
    // Only overwrite the name if it's still a default suggestion (i.e. the
    // user hasn't typed their own) — avoid clobbering a custom name.
    const wasDefault = Object.values(CATEGORY_DEFAULT_NAME).includes(nameInput.value);
    if (wasDefault) nameInput.value = CATEGORY_DEFAULT_NAME[cat] || '';
    if (clefSel && CATEGORIES[cat]) clefSel.value = CATEGORIES[cat].clef;
    refreshAddPartCategoryGrid(); // re-render so the newly picked option shows .active
  });
}

function openAddPartModal() {
  const nameInput = document.getElementById('modal-addpart-name');
  const clefSel   = document.getElementById('modal-addpart-clef');
  if (nameInput) nameInput.value = CATEGORY_DEFAULT_NAME[_addPartCategory] || '';
  if (clefSel && CATEGORIES[_addPartCategory]) clefSel.value = CATEGORIES[_addPartCategory].clef;
  refreshAddPartCategoryGrid();
  openModal('modal-addpart');
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}
function confirmAddPartModal() {
  const name = document.getElementById('modal-addpart-name').value;
  const clef = document.getElementById('modal-addpart-clef').value;
  addPart(name, _addPartCategory, clef);
  closeModal('modal-addpart');
  closeMenu();
}

// Inst Marks
function openInstMarksModal() {
  const p = ap();
  const group = instMarkGroup(p.category);
  const def   = group ? INST_MARK_GROUPS[group] : null;
  document.getElementById('instmarks-title').textContent = def ? def.title : 'Instrument Marks';
  const body = document.getElementById('instmarks-body');
  if (!def) {
    const label = (CATEGORIES[p.category] || {}).label || p.category;
    body.innerHTML = `<p style="color:var(--ink-muted);font-size:13px;margin:8px 0;">No instrument-specific marks for <em>${escHtml(label)}</em>.<br>Use the Marks menu for universal articulations.</p>`;
  } else {
    body.innerHTML = def.sections.map(s => `
      <div class="menu-section">
        <div class="menu-label">${s.label}</div>
        <div class="tool-grid">${s.marks.map(m => {
          if (m.art === 'tremolo1') return `<button class="mark-btn" data-tremolo="1">${m.label}</button>`;
          if (m.art === 'tremolo2') return `<button class="mark-btn" data-tremolo="2">${m.label}</button>`;
          if (m.art === 'tremolo3') return `<button class="mark-btn" data-tremolo="3">${m.label}</button>`;
          if (m.art) return `<button class="mark-btn" data-art="${m.art}">${m.label}</button>`;
          return `<button class="mark-btn" data-text="${escHtml(m.t)}" data-sub="${m.sub}">${m.label}</button>`;
        }).join('')}</div>
      </div>`).join('');
    body.querySelectorAll('.mark-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tremolo) setTremolo(+btn.dataset.tremolo);
        else if (btn.dataset.art) toggleArticulation(btn.dataset.art);
        else insertTextMark(btn.dataset.text, btn.dataset.sub);
        closeModal('modal-instmarks');
      });
    });
  }
  openModal('modal-instmarks');
}

const CATEGORY_MARK_GROUP = {
  'plucked-strings':     '_guitar',
  'bowed-strings':       '_bowed',
  'membrane-percussion': '_drums',
  'tuned-bars':          '_mallets',
  'metal-percussion':    '_mallets',
  'open-winds':          '_wind',
  'reed-winds':          '_wind',
  brass:                 '_wind'
  // struck-strings, sustained-keys, custom: no group — Marks menu covers them
};

function instMarkGroup(category) {
  return CATEGORY_MARK_GROUP[category] || null;
}

// Hotkeys modal
function openHotkeysModal() { openModal('modal-hotkeys'); }

// ── Toast ─────────────────────────────────────────────────────────

let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Keyboard input ────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  // Don't steal from inputs / modals
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (document.querySelector('.modal-overlay.open')) {
    if (e.key === 'Escape') { closeAllModals(); e.preventDefault(); }
    return;
  }
  if (e.key === 'Escape') { closeMenu(); pendingAcc = null; set('si-note', ''); return; }

  const ctrl  = e.metaKey || e.ctrlKey;
  const shift = e.shiftKey;
  const alt   = e.altKey;
  const k     = e.key;

  // Ctrl/Cmd shortcuts
  if (ctrl) {
    if (k==='z' && !shift) { undo(); e.preventDefault(); return; }
    if ((k==='z' && shift) || k==='y') { redo(); e.preventDefault(); return; }
    if (k==='s') { handleSave(); e.preventDefault(); return; }
    // Ctrl+↑↓ = octave up/down (MuseScore-compatible)
    if (k === 'ArrowUp')   { setOctave(Math.min(8, octave + 1)); e.preventDefault(); return; }
    if (k === 'ArrowDown') { setOctave(Math.max(0, octave - 1)); e.preventDefault(); return; }
    return;
  }

  // Shift+Arrow = octave transpose (more intuitive)
  if (shift && k === 'ArrowUp')   { setOctave(Math.min(8, octave + 1)); e.preventDefault(); return; }
  if (shift && k === 'ArrowDown') { setOctave(Math.max(0, octave - 1)); e.preventDefault(); return; }

  // Alt shortcuts
  if (alt) {
    const altMap = {
      // Alt+1–8: the eight dynamics you actually reach for
      // (pppp / ppp / ffff removed — still in the Dynamics menu)
      '1':'pp','2':'p','3':'mp','4':'mf',
      '5':'f','6':'ff','7':'fff','8':'sfz',
      'p':'pedal-down','o':'pedal-up',
      'u':'mute-on','n':'mute-off',
      'e':'expr','g':'segno','c':'coda','f':'fine'
    };
    const v = altMap[k];
    if (!v) { e.preventDefault(); return; }
    if (['ppp','pp','p','mp','mf','f','ff','fff','sfz','ffff'].includes(v)) quickDynamic(v);
    else if (v === 'pedal-down') insertPedalDown();
    else if (v === 'pedal-up')  insertPedalUp();
    else if (v === 'mute-on')   insertMute(true);
    else if (v === 'mute-off')  insertMute(false);
    else if (v === 'expr')      openExpressionModal();
    else if (v === 'segno')     insertSegno();
    else if (v === 'coda')      insertCoda();
    else if (v === 'fine')      insertNavMark('fine');
    e.preventDefault(); return;
  }

  if (shift) {
    if (k==='D') { toggleDotted(); e.preventDefault(); return; }
    if (k==='>') { toggleStaccatoMode(); e.preventDefault(); return; }   // Shift+. = staccato mode
    if (k==='N') { cycleDuration(-1); e.preventDefault(); return; }
    if (k==='F5') { e.preventDefault(); return; }
  }

  // Clear pending accidental if next key is not a note letter or duration key
  if (pendingAcc !== null && !['a','A','b','B','c','C','d','D','e','E','f','F','g','G',
                                '1','2','3','4','5','6','7'].includes(k)) {
    pendingAcc = null;
    set('si-note', '');
  }

  // Single-fire actions: don't let holding a key down auto-repeat these.
  // e.repeat is true on every synthetic keydown the OS generates while a
  // key is held (as opposed to the one real press) — without this guard,
  // holding "A" for even a fraction of a second longer than intended
  // spams a run of A notes, which reads as "way too many notes" appearing
  // from what felt like a normal keypress.
  const NOTE_KEYS = ['a','A','b','B','c','C','d','D','e','E','f','F','g','G',' '];
  if (e.repeat && NOTE_KEYS.includes(k) && !shift) {
    e.preventDefault();
    return;
  }

  // Single keys
  switch (k) {
    // ── Note letters ────────────────────────────────────────────
    case 'a': case 'A': insertNote('A'); break;
    case 'b': case 'B': insertNote('B'); break;
    case 'c': case 'C': insertNote('C'); break;
    case 'd': case 'D': if (!shift) insertNote('D'); break;
    case 'e': case 'E': insertNote('E'); break;
    case 'f': case 'F': insertNote('F'); break;
    case 'g': case 'G': insertNote('G'); break;
    case '+':
      if (ap().cursor > 0 && ap().notes[ap().cursor - 1]?.type === 'note') {
        chordEntryActive = true;
        set('si-note', '+ chord');
      }
      break;
    case ' ':  insertRest(); break;
    case 'Backspace': case 'Delete': deleteBack(); break;

    // ── Navigation ──────────────────────────────────────────────
    case 'ArrowLeft':  moveCursor(-1); break;
    case 'ArrowRight': moveCursor(1); break;
    // ↑/↓ = chromatic half-step (enharmonically aware)
    case 'ArrowUp':   raisePitch(); break;
    case 'ArrowDown': lowerPitch(); break;

    // ── Duration (1–7, MuseScore-style: 1=32nd … 6=whole, 7=triplet) ──
    // Pressing the number directly sets the duration — no Shift needed.
    case '1': setDuration('thirty-second'); break;
    case '2': setDuration('sixteenth'); break;
    case '3': setDuration('eighth'); break;
    case '4': setDuration('quarter'); break;
    case '5': setDuration('half'); break;
    case '6': setDuration('whole'); break;
    case '7': setDuration('quarter-triplet'); break;
    // Octave: use Shift+↑↓ or Ctrl+↑↓ (0, 8, 9 are unbound)

    // ── Duration cycle ──────────────────────────────────────────
    case 'n': case 'N': if (!shift) cycleDuration(1); break;

    // ── Accidental prefixes ─────────────────────────────────────
    // Type BEFORE a note letter to force that accidental.
    //   #  → sharp prefix    (e.g.: # then E → E♯)
    //   -  → flat prefix     (e.g.: - then E → E♭)   ← frees 'b' for the note B
    //   =  → natural prefix  (e.g.: = then E → E♮)
    case '#': pendingAcc = '#'; set('si-note', '♯ …'); e.preventDefault(); return;
    case '-': pendingAcc = 'b'; set('si-note', '♭ …'); e.preventDefault(); return;
    case '=': pendingAcc = 'n'; set('si-note', '♮ …'); e.preventDefault(); return;

    // ── Articulations ───────────────────────────────────────────
    case '.':  toggleArticulation('staccato'); break;
    case ',':  toggleArticulation('accent'); break;
    case ';':  toggleArticulation('tenuto'); break;   // - is now flat prefix
    case '\\': toggleArticulation('fermata'); break;
    case "'":  toggleArticulation('trill'); break;
    case '`':  toggleTie(); break;

    // ── Spans ───────────────────────────────────────────────────
    case 's': case 'S': toggleSlurMode(); break;

    // ── Score inserts ───────────────────────────────────────────
    case 'k': case 'K': openKeyModal(); break;
    case 't': case 'T': openTimeSigModal(); break;
    case 'l': case 'L': openClefModal(); break;
    case 'm': case 'M': openDynamicModal(); break;
    case 'r': case 'R': openRehearsalModal(); break;
    case '[': insertRepeatStart(); break;
    case ']': insertRepeatEnd(); break;

    // ── Parts ───────────────────────────────────────────────────
    case 'Tab': setActivePart((activePart + 1) % parts.length); break;

    // ── Playback ────────────────────────────────────────────────
    case 'F5': togglePlayback(); break;

    default: return;
  }

  e.preventDefault();
});

// ── Canvas click ──────────────────────────────────────────────────

document.getElementById('staff-canvas').addEventListener('click', e => {
  const canvas = e.currentTarget;
  
  // 1. Extract exact logical coordinates relative to the canvas element container
  const logicalX = e.offsetX;
  const logicalY = e.offsetY;

  // 2. Calculate scaled physical coordinates (for backing-store match if engine uses it)
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const physicalX = logicalX * scaleX;
  const physicalY = logicalY * scaleY;

  let hit = null;
  let hitPartIdx = -1;

  // Slur endpoints must be actual notes — engine.js's slur renderer only
  // has geometry for note events (rests/attrs have no vexNote to anchor
  // a Curve to), so a rest-click while in slur mode used to silently
  // record an anchor that could never actually draw a slur. Restricting
  // the hit test itself means slur mode just finds the nearest real note
  // instead.
  const hitOpts = slurMode ? { notesOnly: true } : undefined;

  // Smart Coordinate Verification Strategy:
  // First, see if checking logical layout pixels registers a hit across parts
  for (let pi = 0; pi < parts.length; pi++) {
    const checkHit = E.hitTest(pi, logicalX, logicalY, hitOpts);
    if (checkHit) {
      hit = checkHit;
      hitPartIdx = pi;
      break;
    }
  }

  // Fallback: If nothing hits, evaluate physical pixels (adjusted for device pixels)
  if (!hit) {
    for (let pi = 0; pi < parts.length; pi++) {
      const checkHit = E.hitTest(pi, physicalX, physicalY, hitOpts);
      if (checkHit) {
        hit = checkHit;
        hitPartIdx = pi;
        break;
      }
    }
  }

  if (hit) {
    if (slurMode) { 
      handleSlurNoteClick(hitPartIdx, hit.noteId); 
      return; 
    }
    setActivePart(hitPartIdx);
    parts[hitPartIdx].cursor = hit.cursorIndex;
    syncStatus();
    render();
  }
});

// ── Resize ────────────────────────────────────────────────────────
// Debounced via requestAnimationFrame so rapid-fire resize events (window
// drag, dev-tools panel toggling, some browsers' zoom handling) don't
// trigger a re-layout/re-render per pixel — only once per animation frame,
// using the LATEST size. ResizeObserver on the canvas's actual container
// (the paper element, which is what engine.js measures) is the primary
// signal since it also catches container-only size changes that don't
// change the window (e.g. a side panel opening). window resize/orientation
// listeners are kept as a defensive fallback for browser/webview
// environments where ResizeObserver support or firing is unreliable.
// Plain, instant re-render for content-driven layout shifts — e.g. the
// canvas growing/shrinking as notes are added. #paper's ResizeObserver
// fires on nearly every keystroke because of this, so this path must NOT
// fade: that's what was making the score visibly dim out while typing
// (the .is-resizing class never got a clean gap to fully return to
// opacity 1 between keystrokes, so it read as a permanent gray wash).
let _contentRAF = null;
function _scheduleContentRender() {
  if (_contentRAF != null) return;
  _contentRAF = requestAnimationFrame(() => {
    _contentRAF = null;
    render();
  });
}

// Fade-transition re-render reserved for genuine window-level resizes
// (dragging the window, browser zoom, orientation change) — see the
// .is-resizing rule in style.css. Kept on a separate path from the
// content-driven one above specifically so normal note entry never
// triggers the dim/fade.
let _windowResizeRAF = null;
let _resizeFadeTimer = null;
function _scheduleWindowResizeRender() {
  if (_windowResizeRAF != null) return;
  const canvas = document.getElementById('staff-canvas');
  if (canvas) canvas.classList.add('is-resizing');
  clearTimeout(_resizeFadeTimer);
  _windowResizeRAF = requestAnimationFrame(() => {
    _windowResizeRAF = null;
    render();
    _resizeFadeTimer = setTimeout(() => {
      if (canvas) canvas.classList.remove('is-resizing');
    }, 60);
  });
}

const resizeObs = new ResizeObserver(() => _scheduleContentRender());
resizeObs.observe(document.getElementById('paper'));
window.addEventListener('resize', _scheduleWindowResizeRender);
window.addEventListener('orientationchange', _scheduleWindowResizeRender);

// One extra render shortly after full page load: on some browsers,
// webfonts (Bravura) or Google Fonts finishing their swap can nudge
// layout by a pixel or two right after first paint, after the very first
// render() call already ran. document.fonts.ready (in the block below)
// covers font-driven relayout; this covers any other late layout shift.
window.addEventListener('load', () => _scheduleContentRender());

// ── Header toolbar wiring ─────────────────────────────────────────

wire('btn-category', e => {
  renderCategoryGrid(document.getElementById('category-grid'), ap().category, (cat) => {
    saveState();
    ap().category = cat;
    if (cat === 'plucked-strings') {
      if (!ap().tuningId || !STRING_TUNINGS[ap().tuningId]) ap().tuningId = DEFAULT_TUNING_ID;
      if (!Number.isFinite(ap().capoFret)) ap().capoFret = 0;
      (ap().notes || []).forEach(ev => refreshTabForEvent(ap(), ev));
    }
    setHeaderCategoryButton(cat);
    closeMenu();
    afterMutation();
  });
  toggleMenu('category-menu', e.currentTarget);
});

document.getElementById('sel-clef').addEventListener('change', e => {
  saveState(); ap().clef = e.target.value; afterMutation();
});

document.getElementById('sel-timesig').addEventListener('change', e => {
  saveState(); ap().timeSig = e.target.value; afterMutation();
});

// ── Cmdbar button wiring ──────────────────────────────────────────

function wire(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}
wire('btn-import-xml', () => handleImportXML());
wire('btn-scan-omr', () => handleScanOMR());
wire('btn-export-xml', () => handleExportXML());
wire('btn-add-part',  () => openAddPartModal());
wire('btn-parts',     e  => toggleMenu('parts-menu', e.currentTarget));
wire('btn-dynamics',  e  => toggleMenu('dynamics-menu', e.currentTarget));
wire('btn-staccato-mode', () => toggleStaccatoMode());
wire('btn-marks',     e  => toggleMenu('marks-menu', e.currentTarget));
wire('btn-insert',    e  => toggleMenu('insert-menu', e.currentTarget));
wire('btn-score',     e  => toggleMenu('score-menu', e.currentTarget));
wire('btn-instmarks', () => openInstMarksModal());
wire('pb-play',       () => togglePlayback());
wire('btn-undo',      () => undo());
wire('btn-redo',      () => redo());
wire('btn-new',       () => clearAll());
wire('btn-save',      () => handleSave());
wire('btn-load',      () => handleLoad());
wire('btn-export',    () => handleExport());
wire('btn-hotkeys',   () => openHotkeysModal());

// Score menu apply buttons
wire('score-global-time', () => { applyGlobalTimeSig(document.getElementById('score-ts').value || '4/4'); closeMenu(); });
wire('score-here-time',   () => { insertTimeSig(document.getElementById('score-ts').value || '4/4'); closeMenu(); });
wire('score-global-key',  () => { applyGlobalKey(document.getElementById('score-key').value); closeMenu(); });
wire('score-here-key',    () => { insertKey(document.getElementById('score-key').value); closeMenu(); });
wire('score-global-clef', () => { applyGlobalClef(document.getElementById('score-clef').value); closeMenu(); });
wire('score-here-clef',   () => { insertClef(document.getElementById('score-clef').value); closeMenu(); });
wire('score-apply-tab',   () => {
  applyTabSetup(document.getElementById('score-tuning').value, document.getElementById('score-capo').value);
  closeMenu();
});

// Modal confirm buttons
wire('confirm-key',       () => confirmKeyModal());
wire('confirm-timesig',   () => confirmTimeSigModal());
wire('confirm-clef',      () => confirmClefModal());
wire('confirm-dynamic',   () => confirmDynamicModal());
wire('confirm-rehearsal', () => confirmRehearsalModal());
wire('confirm-tempo',     () => confirmTempoModal());
wire('confirm-expr',      () => confirmExpressionModal());
wire('confirm-capo',      () => confirmCapoModal());
wire('confirm-addpart',   () => confirmAddPartModal());

// Cancel buttons close their respective modals
document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});

// Close menus when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.tool-menu') && !e.target.closest('[data-menu]')) {
    closeMenu();
  }
}, true);

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeAllModals();
  });
});

// Enter key in modal inputs
document.getElementById('modal-ts-input').addEventListener('keydown', e => { if (e.key==='Enter') confirmTimeSigModal(); });
document.getElementById('modal-rehearsal-input').addEventListener('keydown', e => { if (e.key==='Enter') confirmRehearsalModal(); });
document.getElementById('modal-tempo-input').addEventListener('keydown', e => { if (e.key==='Enter') confirmTempoModal(); });
document.getElementById('modal-expr-input').addEventListener('keydown', e => { if (e.key==='Enter') confirmExpressionModal(); });
document.getElementById('modal-capo-input').addEventListener('keydown', e => { if (e.key==='Enter') confirmCapoModal(); });

// Dynamic buttons in dynamics-menu — insert immediately, like every
// other Marks-menu button, rather than only arming a future note.
document.querySelectorAll('.dyn-btn[data-dyn]').forEach(btn => {
  btn.addEventListener('click', () => { quickDynamic(btn.dataset.dyn); closeMenu(); });
});

// Mark buttons in marks-menu
document.querySelectorAll('[data-art]').forEach(btn => {
  btn.addEventListener('click', () => { toggleArticulation(btn.dataset.art); closeMenu(); });
});
document.querySelectorAll('[data-insert]').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.insert;
    if (v==='tie') toggleTie();
    else if (v==='slur') { toggleSlurMode(); closeMenu(); }
    else if (v==='pedal-down') insertPedalDown();
    else if (v==='pedal-up') insertPedalUp();
    else if (v==='mute-on') insertMute(true);
    else if (v==='mute-off') insertMute(false);
    else if (v==='capo') openCapoModal();
    else if (v==='expr') openExpressionModal();
    else if (v==='repeat-start') insertRepeatStart();
    else if (v==='repeat-end') insertRepeatEnd();
    else if (v==='segno') insertSegno();
    else if (v==='coda') insertCoda();
    else if (v==='rehearsal') openRehearsalModal();
    else if (v==='tempo-text') openTempoModal();
    else if (v==='rit') insertTextMark('rit.','tempo');
    else if (v==='accel') insertTextMark('accel.','tempo');
    else if (v==='a-tempo') insertTextMark('a tempo','tempo');
    else if (v==='ds-al-coda') insertNavMark('ds-al-coda');
    else if (v==='dc-al-capo') insertNavMark('dc-al-capo');
    else if (v==='ds-al-fine') insertNavMark('ds-al-fine');
    else if (v==='dc-al-fine') insertNavMark('dc-al-fine');
    else if (v==='fine') insertNavMark('fine');
    else if (v==='largo') insertTextMark('Largo','tempo');
    else if (v==='adagio') insertTextMark('Adagio','tempo');
    else if (v==='andante') insertTextMark('Andante','tempo');
    else if (v==='moderato') insertTextMark('Moderato','tempo');
    else if (v==='allegro') insertTextMark('Allegro','tempo');
    else if (v==='presto') insertTextMark('Presto','tempo');
    else if (v==='tremolo1') setTremolo(1);
    else if (v==='tremolo2') setTremolo(2);
    else if (v==='tremolo3') setTremolo(3);
    else if (v==='triplet') setDuration('quarter-triplet');
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────────

// ── Auth chip ────────────────────────────────────────────────────
// The auth guard at the top of index.html already redirected to
// login.html if nobody's signed in, so by this point RymAuth.getCurrentUser()
// is expected to be non-null.
(function initAuthChip() {
  const user = window.RymAuth && window.RymAuth.getCurrentUser();
  const nameEl = document.getElementById('header-user-name');
  if (nameEl) nameEl.textContent = user ? user.displayName : '';
  const signOutBtn = document.getElementById('btn-signout');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      window.RymAuth.signOut();
      window.location.href = 'login.html';
    });
  }
})();

const initParams = new URLSearchParams(window.location.search);
const shouldStartFresh = initParams.get('new') === '1';

if (shouldStartFresh) {
  setCloudSheetId('');
  currentFileHandle = null;
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) {}
  parts = [makePart(++_partId, 'Piano 1', 'struck-strings')];
}

if (!shouldStartFresh && !tryRestoreAutosave()) {
  parts = [makePart(++_partId, 'Piano 1', 'struck-strings')];
}

if (window.RymSheets) {
  const sheetId = initParams.get('sheet');
  if (sheetId) {
    window.RymSheets.loadSheet(sheetId)
      .then(sheet => {
        if (!sheet) return;
        loadScoreData(JSON.stringify(sheet.data), { cloudSheetId: sheet.id });
      })
      .catch(err => console.warn('Failed to load cloud sheet', err));
  }
}
rebuildPartsPanel();
syncStatus();
syncControls();
render();
// Allow quick-adding parts via the keyboard
document.getElementById('modal-addpart-name').addEventListener('keydown', e => { 
  if (e.key === 'Enter') confirmAddPartModal(); 
});
