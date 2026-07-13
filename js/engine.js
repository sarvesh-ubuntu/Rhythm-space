/**
 * rhythm space — Music Engine  |  engine.js  (v5 — VexFlow rendering)
 *
 * ─── v5 MIGRATION NOTES ─────────────────────────────────────────────────
 * The v4 engine drew every glyph (clefs, key sigs, noteheads, beams, ties,
 * slurs...) by hand on the canvas. That's what caused the clef alignment
 * bugs: clef metrics (baseline offsets, C-clef centering, Bravura-load
 * races) were all eyeballed constants instead of real font/engraving math.
 *
 * v5 keeps the MODEL layer 100% unchanged — pitch math, key signatures,
 * duration tables, measure-building, and the accidental-resolution logic
 * are all copy-straight from v4. That logic has nothing to do with
 * canvas drawing and was never the problem.
 *
 * The RENDER layer is a full rewrite on top of VexFlow 4.x, which owns:
 *   - clef / key-sig / time-sig glyph metrics and placement
 *   - notehead, stem, beam, flag, dot, tuplet-bracket rendering
 *   - accidental placement
 *   - ties (StaveTie) and slurs (Curve)
 *   - articulations (staccato/accent/tenuto/fermata) and trill
 *
 * Public API surface consumed by app.js / playback.js / musicxml.js is
 * UNCHANGED: render(), hitTest(), getNoteGeom()/getAllNoteGeoms()/
 * getEventGeoms(), buildMeasures(), beatOf(), isAttr(), KEY_SIGS, etc.
 * app.js should not need any changes for this migration.
 *
 * ─── Requires ────────────────────────────────────────────────────────────
 * VexFlow 4.2.2 must be loaded as a global BEFORE this file — see the
 * <script> tag added to index.html. This file resolves the global
 * defensively (`_vf()`) since the exact global name has moved around
 * between VexFlow major versions (`Vex.Flow` historically; some 4.x/5.x
 * builds expose `VexFlow` instead). If you bump the VexFlow version and
 * things stop rendering, check `_vf()` first and the console warning it
 * prints.
 *
 * ─── Known deferred features (not yet ported from the old hand-drawn
 *      renderer — these are stubbed as plain text annotations for now
 *      rather than silently dropped) ───────────────────────────────────
 *   - Hairpins (cresc./decresc. wedges) — TODO: Vex.Flow.StaveHairpin
 *   - Pedal marks, segno/coda glyphs, D.S./D.C. nav marks, tremolo beams
 *   - Grace notes
 *   - True tuplet grouping/bracketing for triplets — currently rendered
 *     as plain eighth notes with a "3" text annotation (same simplified
 *     behavior the old renderer had; not a regression).
 * These are all reasonably small additions on top of this structure —
 * flag them if you want them next.
 *
 * THIS IS A FIRST PORT, NOT A PIXEL-VERIFIED ONE. I don't have a browser
 * in this environment to visually check canvas + VexFlow output, so please
 * run it and tell me what's actually wrong on screen — that'll be much
 * faster to fix than guessing further in the dark.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
//  VEXFLOW RESOLUTION
// ═══════════════════════════════════════════════════════════════════

let _vfWarned = false;
function _vf() {
  const VF = (window.Vex && window.Vex.Flow) || window.VexFlow || null;
  if (!VF && !_vfWarned) {
    _vfWarned = true;
    console.error(
      'rhythm space: VexFlow global not found. Make sure the VexFlow ' +
      '<script> tag in index.html loads BEFORE engine.js, and that the ' +
      'pinned version still exposes window.Vex.Flow (or window.VexFlow).'
    );
  }
  return VF;
}

function _renderFallbackMessage(canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width = 700; canvas.height = 120;
  ctx.fillStyle = '#8a2020';
  ctx.font = '14px sans-serif';
  ctx.fillText('VexFlow failed to load — check the console and the <script> tag in index.html.', 20, 40);
}

// ═══════════════════════════════════════════════════════════════════
//  CONSTANTS  (kept from v4 for layout spacing consistency)
// ═══════════════════════════════════════════════════════════════════

const LS        = 10;              // matches VexFlow's default stave line spacing
const ROW_ABOVE = 80;   // room for clef glyphs, ledger lines above, text marks
const ROW_BELOW = 80;   // room for dynamics, expression text, ledger lines below
const ROW_H     = 4 * LS + ROW_ABOVE + ROW_BELOW;
const PART_GAP  = 14;

// Height reserved for a TAB staff (6 lines, no ledger-line headroom needed
// the way pitched notation does — fret numbers sit inside the lines).
const TAB_ROW_H = 100;

// Gap between a part's own stacked staves — grand-staff treble/bass, or a
// guitar-family part's notation staff + its TAB staff underneath. Smaller
// than PART_GAP (which separates different instruments/parts) since these
// belong to the same part and should read as one connected system.
const SUB_GAP = 6;

const L_PAD = 14;
const R_PAD = 14;

// Extra safety margin reserved at the right end of every row, on top of
// R_PAD, so the final barline (which VexFlow draws INSIDE the stave's
// nominal width but whose double/repeat styles render a couple of pixels
// wider than a plain barline) never lands exactly on — or past — the
// canvas edge on any browser's sub-pixel rounding behavior.
const ROW_END_SLACK = 10;

// Extra "breathing room" multiplier applied on top of VexFlow's own
// bare-minimum note spacing. Without this, dense passages (runs of eighth
// notes etc.) get packed as tightly as VexFlow will legally allow, which
// reads as visually cramped even though nothing technically overlaps.
// Inflating the measure's *estimated* width by this factor before the row
// bin-packing decision means fewer measures land in each row, so every
// measure — and therefore every note — ends up with more actual on-screen
// space than the bare-minimum pass would have given it.
const NOTE_COMFORT = 1.45;

// Fixed padding added after a measure's last note, before the barline.
// (Was a bare 20px constant inlined at each call site — pulled out here and
// bumped alongside NOTE_COMFORT so end-of-measure breathing room scales
// with the rest of the spacing pass instead of staying pinned to the old
// tighter baseline.)
const MEASURE_END_PAD = 42;

// Absolute minimum width reserved for a measure's note area, independent
// of how many notes are actually in it. This is the piece that was
// missing before: every previous attempt at fixing "sparse content looks
// bad" scaled RELATIVE to the measure's own natural width (a stretch
// ratio, a justify threshold) — which is fine for a measure with real
// notes, but for an EMPTY measure the natural width is itself tiny, so
// any ratio of a tiny number is still tiny. That's what kept reproducing
// the "stub in a sea of blank canvas" look no matter which multiplier got
// tuned. An absolute floor fixes it structurally: a blank or near-blank
// measure always renders at a normal, complete-looking width — roughly
// what a real notation program shows for an empty bar — and a measure
// with actual content grows past this floor once it legitimately needs
// more room (see NOTE_COMFORT below).
const MIN_NOTES_WIDTH = 200;

// A measure holding ONLY non-consuming tokens (typically a repeat
// barline landing where no notes have been typed on that side of it)
// has no notes to space out — giving it the full MIN_NOTES_WIDTH floor
// is what produced the blank-gap-before-a-repeat bug. It only needs
// enough room for its own glyphs/barline.
const EMPTY_MEASURE_WIDTH = 26;

// Every row always stretches to fill the full line width — the staff is
// fixed-width like real paper. Note spacing adjusts proportionally to
// content density; the line itself never shrinks.

// Device pixel ratio — read fresh on every render rather than cached once
// at page load, so moving the window to a different-density monitor,
// zooming, or fresh OS-level scaling changes are always picked up.
// Clamped to 2 to keep canvas memory/render cost bounded on very
// high-density displays.
function _dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

const INK      = '#180e02';
const CURSOR_C = '#962222';
const SELECTION_RING = 'rgba(150,34,34,0.22)';
const SPAN_ANCHOR_C  = 'rgba(139,100,20,0.75)';

let _noteGeoms  = new Map();   // `${partIdx}_${noteId}` -> geom
let _eventGeoms = [];          // flat list, all attr + note/rest events
let _spanAnchor = null;
let _cssW       = 700;

// ═══════════════════════════════════════════════════════════════════
//  DURATION DATA  (unchanged from v4 — pure model logic)
// ═══════════════════════════════════════════════════════════════════

const DUR_KEY_MAP = {
  '1': 'thirty-second',
  '2': 'sixteenth',
  '3': 'eighth',
  '4': 'quarter',
  '5': 'half',
  '6': 'whole',
  '7': 'quarter-triplet'
};

const DUR_LABELS = {
  'whole':            'Whole',
  'half':             'Half',
  'half-dotted':      'Half.',
  'quarter-triplet':  'Triplet',
  'quarter':          'Quarter',
  'quarter-dotted':   'Quarter.',
  'eighth':           'Eighth',
  'eighth-dotted':    'Eighth.',
  'sixteenth':        '16th',
  'thirty-second':    '32nd'
};

const DUR_BEATS = {
  'whole':            4,
  'half':             2,
  'half-dotted':      3,
  'quarter-triplet':  1/3,
  'quarter':          1,
  'quarter-dotted':   1.5,
  'eighth':           0.5,
  'eighth-dotted':    0.75,
  'sixteenth':        0.25,
  'thirty-second':    0.125
};

// v4-duration → VexFlow duration string (base, no dot/triplet suffix)
const DUR_TO_VF = {
  'whole':          'w',
  'half':           'h',
  'half-dotted':    'h',
  'quarter':        'q',
  'quarter-dotted': 'q',
  'quarter-triplet':'8',   // see "deferred features" note above re: triplets
  'eighth':         '8',
  'eighth-dotted':  '8',
  'sixteenth':      '16',
  'thirty-second':  '32'
};

function beatOf(evOrDur) {
  const d = typeof evOrDur === 'string' ? evOrDur : (evOrDur && evOrDur.duration);
  return DUR_BEATS[d] ?? 0;
}

function isBeamable(dur) {
  return dur === 'eighth' || dur === 'sixteenth' || dur === 'thirty-second' || dur === 'eighth-dotted';
}

function isAttr(ev) {
  return ev && (
    ev.type === 'clef' || ev.type === 'timesig' || ev.type === 'key' ||
    // 'repeat' is what app.js actually inserts (not 'repeat-start'/'repeat-end')
    ev.type === 'repeat' || ev.type === 'repeat-start' || ev.type === 'repeat-end' ||
    ev.type === 'dynamic' || ev.type === 'text-mark' ||
    // 'text' is what insertCapo() and some expression marks use
    ev.type === 'text' ||
    // 'pedal' is what insertPedalDown/Up insert (not 'pedal-down'/'pedal-up')
    ev.type === 'pedal' || ev.type === 'pedal-down' || ev.type === 'pedal-up' ||
    ev.type === 'rehearsal' || ev.type === 'segno' || ev.type === 'coda' ||
    // 'nav' is what insertNavMark() inserts (fine, ds-al-coda, etc.)
    ev.type === 'nav' ||
    ev.type === 'ds-al-coda' || ev.type === 'dc-al-capo' ||
    ev.type === 'ds-al-fine' || ev.type === 'dc-al-fine' ||
    ev.type === 'fine' || ev.type === 'capo' || ev.type === 'mute'
  );
}

const DYNAMICS = ['pppp','ppp','pp','p','mp','mf','f','ff','fff','ffff','sfz','sfp','fp','fz','rf','rfz'];

// ═══════════════════════════════════════════════════════════════════
//  TIME SIGNATURE HELPERS  (unchanged from v4)
// ═══════════════════════════════════════════════════════════════════

function parseTS(ts) {
  const parts = String(ts || '4/4').split('/');
  const n = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  return {
    num: Number.isFinite(n) && n > 0 ? n : 4,
    den: Number.isFinite(d) && d > 0 ? d : 4
  };
}

function measureBeats(ts) {
  const { num, den } = parseTS(ts);
  return num * (4 / den);
}

// ═══════════════════════════════════════════════════════════════════
//  PITCH MATH  (unchanged from v4)
// ═══════════════════════════════════════════════════════════════════

const CHROM_VAL = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

const CHROM_TO_NOTE = [
  { pitch:'C', acc:null  }, { pitch:'C', acc:'#' },
  { pitch:'D', acc:null  }, { pitch:'D', acc:'#' },
  { pitch:'E', acc:null  },
  { pitch:'F', acc:null  }, { pitch:'F', acc:'#' },
  { pitch:'G', acc:null  }, { pitch:'G', acc:'#' },
  { pitch:'A', acc:null  }, { pitch:'A', acc:'#' },
  { pitch:'B', acc:null  }
];

function noteToChrom(pitch, acc, octave) {
  const base = CHROM_VAL[pitch] ?? 0;
  const alt  = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return octave * 12 + base + alt;
}

function chromToNote(c) {
  c = Math.max(0, Math.min(c, 8 * 12 + 11));
  const sem = ((c % 12) + 12) % 12;
  const oct = Math.floor(c / 12);
  const v   = CHROM_TO_NOTE[sem];
  return { pitch: v.pitch, acc: v.acc, octave: oct };
}

// ═══════════════════════════════════════════════════════════════════
//  KEY SIGNATURES  (unchanged from v4 — note KEY_SIGS keys are already
//  written in the exact spelling VexFlow's addKeySignature() expects,
//  e.g. 'C', 'G', 'F#', 'Bb', 'Cb' — no translation needed)
// ═══════════════════════════════════════════════════════════════════

const KEY_SIGS = {
  'C':  { type:'none',  count:0 },
  'G':  { type:'sharp', count:1 },
  'D':  { type:'sharp', count:2 },
  'A':  { type:'sharp', count:3 },
  'E':  { type:'sharp', count:4 },
  'B':  { type:'sharp', count:5 },
  'F#': { type:'sharp', count:6 },
  'C#': { type:'sharp', count:7 },
  'F':  { type:'flat',  count:1 },
  'Bb': { type:'flat',  count:2 },
  'Eb': { type:'flat',  count:3 },
  'Ab': { type:'flat',  count:4 },
  'Db': { type:'flat',  count:5 },
  'Gb': { type:'flat',  count:6 },
  'Cb': { type:'flat',  count:7 }
};

const KEY_SHARP_ORDER = ['F','C','G','D','A','E','B'];
const KEY_FLAT_ORDER  = ['B','E','A','D','G','C','F'];

function normalizeAcc(acc) {
  return acc === '#' || acc === 'b' ? acc : null;
}

function keyAccidentals(key) {
  const state = { C:null, D:null, E:null, F:null, G:null, A:null, B:null };
  const def = KEY_SIGS[key];
  if (!def || def.type === 'none') return state;

  const order = def.type === 'sharp' ? KEY_SHARP_ORDER : KEY_FLAT_ORDER;
  const acc = def.type === 'sharp' ? '#' : 'b';
  for (let i = 0; i < def.count; i++) state[order[i]] = acc;
  return state;
}

function defaultAccForKey(key, pitch) {
  return keyAccidentals(key)[pitch] ?? null;
}

function hasExplicitAccidental(ev) {
  if (ev?.accExplicit === true) return true;
  if (ev?.accExplicit == null && normalizeAcc(ev?.accidental ?? ev?.acc) !== null) return true;
  return false;
}

function resolveAccidental(ev, state, key) {
  if (!ev || ev.type !== 'note') return { acc: null, displayAcc: null, explicit: false };

  const pitch = ev.pitch;
  const current = Object.prototype.hasOwnProperty.call(state, pitch)
    ? state[pitch]
    : defaultAccForKey(key, pitch);
  const explicit = hasExplicitAccidental(ev);

  if (explicit) {
    const acc = normalizeAcc(ev.accidental ?? ev.acc);
    const displayAcc = acc === current ? null : (acc || 'n');
    state[pitch] = acc;
    return { acc, displayAcc, explicit: true };
  }

  return { acc: current ?? null, displayAcc: null, explicit: false };
}

function accidentalsForMeasure(measure) {
  const out = new Map();
  let activeKey = measure.key || 'C';
  let state = keyAccidentals(activeKey);
  const events = [...(measure.events || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const ev of events) {
    if (ev.type === 'key') {
      activeKey = ev.key || activeKey;
      state = keyAccidentals(activeKey);
      continue;
    }
    if (ev.type !== 'note') continue;
    out.set(ev.index, resolveAccidental(ev, state, activeKey));
  }

  return out;
}

function accidentalContextAt(notes, cursor, state) {
  const EPS = 1e-9;
  let activeKey = state.initialKey || 'C';
  let activeTS = state.currentTimeSig || '4/4';
  let accState = keyAccidentals(activeKey);
  let used = 0;

  for (let i = 0; i < cursor && i < notes.length; i++) {
    const ev = notes[i];
    if (ev.type === 'key') {
      activeKey = ev.key || activeKey;
      accState = keyAccidentals(activeKey);
      continue;
    }
    if (ev.type === 'timesig') {
      activeTS = ev.timesig || activeTS;
      used = 0;
      accState = keyAccidentals(activeKey);
      continue;
    }
    if (isAttr(ev)) continue;

    const b = beatOf(ev);
    const cap = measureBeats(activeTS);
    if (used > EPS && used + b > cap + EPS) {
      used = 0;
      accState = keyAccidentals(activeKey);
    }

    if (ev.type === 'note') resolveAccidental(ev, accState, activeKey);

    used += b;
    if (Math.abs(used - cap) < EPS) {
      used = 0;
      accState = keyAccidentals(activeKey);
    }
  }

  return { key: activeKey, timeSig: activeTS, state: { ...accState }, used, cap: measureBeats(activeTS) };
}

function accidentalForNoteAt(notes, index, state) {
  if (!notes[index] || notes[index].type !== 'note') return { acc: null, displayAcc: null };
  const ctx = accidentalContextAt(notes, index, state);
  return resolveAccidental(notes[index], { ...ctx.state }, ctx.key);
}

// ═══════════════════════════════════════════════════════════════════
//  MEASURE BUILDING  (unchanged from v4)
// ═══════════════════════════════════════════════════════════════════

function buildMeasures(notes, state) {
  const { currentClef, currentTimeSig, initialKey } = state;
  const measures = [];
  const EPS = 1e-9;

  let active = {
    clef:    currentClef    || 'treble',
    key:     initialKey     || 'C',
    timeSig: currentTimeSig || '4/4'
  };

  let cur  = _newMeasure(active);
  let used = 0;

  for (let i = 0; i < notes.length; i++) {
    const ev = { ...notes[i], index: i };

    // ── Repeat barlines: ALWAYS close/open a real measure boundary,
    // exactly where they were typed — deterministic WYSIWYG placement,
    // never retroactively reattached to a different, already-finalized
    // measure. A repeat barline IS a barline; a measure holding only a
    // repeat token (no notes) is legitimate — see EMPTY_MEASURE_WIDTH in
    // _measureVexInfo, which is what keeps that from looking like a gap.
    if (ev.type === 'repeat') {
      ev.beat     = used;
      ev.consumes = false;
      ev.attr     = true;

      if (ev.direction === 'end') {
        // If the current measure is empty (no notes yet — happens when the user
        // inserts a repeat-end right after a bar that was exactly filled), attach
        // the repeat-end barline to the PREVIOUS measure rather than creating a
        // one-token stub. cur stays alive to hold whatever comes next.
        const freshEmpty = used <= EPS && !cur.events.some(e => e.consumes) && measures.length > 0;
        if (freshEmpty) {
          const prev = measures[measures.length - 1];
          ev.beat = measureBeats(prev.timeSig || cur.timeSig || '4/4');
          prev.events.push(ev);
        } else {
          cur.events.push(ev);
          cur.endClef    = active.clef;
          cur.endKey     = active.key;
          cur.endTimeSig = active.timeSig;
          measures.push(cur);
          cur  = _newMeasure(active);
          used = 0;
        }
      } else { // 'start'
        // Use the same "fresh" test as the generic attr and repeat-end
        // paths: a measure counts as still-open as long as no NOTE has
        // landed in it yet. Checking cur.events.length===0 here instead
        // (literal zero events) was stricter than that, and disagreed
        // with it in exactly one case: when the only thing sitting in an
        // as-yet-unclosed measure is an annotation (dynamic/text/
        // rehearsal/pedal/nav mark) that couldn't be redirected onto a
        // previous measure — e.g. the piece's very first measure, before
        // any previous measure exists to redirect onto. In that case this
        // used to treat the measure as "mid-measure" and force-close it,
        // pushing a measure containing only the annotation (no notes) and
        // opening a fresh one for the repeat barline — a spurious empty
        // measure. Matching the other two checks fixes it: an
        // annotation-only measure is still "fresh" and the repeat-start
        // simply joins it instead of splitting it off.
        const curIsFreshEmpty = used <= EPS && !cur.events.some(e => e.consumes);
        if (!curIsFreshEmpty) {
          // Mid-measure repeat-start: close the current measure first so
          // the repeat barline lands at the START of the next measure.
          cur.endClef    = active.clef;
          cur.endKey     = active.key;
          cur.endTimeSig = active.timeSig;
          measures.push(cur);
          cur  = _newMeasure(active);
          used = 0;
        }
        cur.events.push(ev);
      }
      continue;
    }

    if (isAttr(ev)) {
      ev.beat             = used;
      ev.consumes         = false;
      ev.attr             = true;
      ev.effectiveClef    = active.clef;
      ev.effectiveKey     = active.key;
      ev.effectiveTimeSig = active.timeSig;
      const atMeasureStart = used <= EPS && !cur.events.some(e => e.consumes);
      // Redirect non-consuming tokens to the previous measure when the current
      // measure is still empty — prevents stub measures when a dynamic/nav/text
      // is inserted right after the preceding bar was exactly filled.
      if (atMeasureStart && measures.length > 0) {
        const prev = measures[measures.length - 1];
        ev.beat = measureBeats(prev.timeSig || cur.timeSig || '4/4');
        prev.events.push(ev);
      } else {
        cur.events.push(ev);
      }

      const next = { ...active };
      if (ev.type === 'clef')    next.clef    = ev.clef;
      if (ev.type === 'key')     next.key     = ev.key;
      if (ev.type === 'timesig') next.timeSig = ev.timesig;
      active = next;

      if (atMeasureStart && (ev.type === 'timesig' || ev.type === 'clef' || ev.type === 'key')) {
        cur.clef    = active.clef;
        cur.key     = active.key;
        cur.timeSig = active.timeSig;
      }
      continue;
    }

    const dur = beatOf(ev);
    const cap = measureBeats(active.timeSig);

    if (used > EPS && used + dur > cap + EPS) {
      cur.endClef    = active.clef;
      cur.endKey     = active.key;
      cur.endTimeSig = active.timeSig;
      measures.push(cur);
      cur  = _newMeasure(active);
      used = 0;
    }

    ev.beat     = used;
    ev.beats    = dur;
    ev.consumes = true;
    ev.clef     = active.clef;
    ev.key      = active.key;
    ev.timeSig  = active.timeSig;
    cur.events.push(ev);
    used += dur;

    if (Math.abs(used - cap) < EPS) {
      cur.endClef    = active.clef;
      cur.endKey     = active.key;
      cur.endTimeSig = active.timeSig;
      measures.push(cur);
      cur  = _newMeasure(active);
      used = 0;
    }
  }

  cur.endClef    = active.clef;
  cur.endKey     = active.key;
  cur.endTimeSig = active.timeSig;
  // Only append the trailing measure if it has content, OR it's the
  // only measure (empty score still needs one bar to show the clef/time-sig).
  if (cur.events.length > 0 || measures.length === 0) {
    measures.push(cur);
  }

  measures.forEach((m, idx) => {
    const prev = measures[idx - 1];
    m.showClef = !prev || (prev.endClef    || prev.clef)    !== m.clef;
    m.showKey  = !prev || (prev.endKey     || prev.key)     !== m.key;
    m.showTime = !prev || (prev.endTimeSig || prev.timeSig) !== m.timeSig;
    m.number   = idx + 1;
  });

  return measures;
}

function _newMeasure(attrs) {
  return {
    clef:    attrs.clef,
    key:     attrs.key,
    timeSig: attrs.timeSig,
    endClef: attrs.clef,
    endKey: attrs.key,
    endTimeSig: attrs.timeSig,
    events:  [],
    showClef: false, showKey: false, showTime: false,
    x: 0, width: 0
  };
}

function measureSpaceAt(notes, cursor, state) {
  const EPS = 1e-9;
  let activeTS = state.currentTimeSig || '4/4';
  let used     = 0;

  for (let i = 0; i < cursor && i < notes.length; i++) {
    const ev = notes[i];
    if (ev.type === 'timesig') { activeTS = ev.timesig; used = 0; continue; }
    if (isAttr(ev)) continue;
    const b   = beatOf(ev);
    const cap = measureBeats(activeTS);
    if (used > EPS && used + b > cap + EPS) used = 0;
    used += b;
    if (Math.abs(used - cap) < EPS) used = 0;
  }

  return { used, cap: measureBeats(activeTS) };
}

// ═══════════════════════════════════════════════════════════════════
//  MULTI-PART GEOMETRY  (unchanged formulas from v4, still used to
//  place VexFlow staves — this is layout, not glyph drawing)
// ═══════════════════════════════════════════════════════════════════

function systemHeight(numParts) {
  if (numParts <= 1) return ROW_H;
  return numParts * ROW_H + (numParts - 1) * PART_GAP;
}

function partStaffTop(rowIdx, partIdx, numParts) {
  const sysTop = rowIdx * systemHeight(numParts);
  return sysTop + ROW_ABOVE + partIdx * (ROW_H + PART_GAP);
}

// ═══════════════════════════════════════════════════════════════════
//  MULTI-STAFF PARTS  (v6 — grand staff piano, TAB staff for guitar family)
//
//  Most parts are still one staff. Two categories now render as TWO
//  stacked staves that belong to the SAME part:
//    - struck-strings (Piano): treble + bass, joined by a brace — a real
//      grand staff, split automatically by register (middle C and above
//      → treble, below → bass) since there's no per-note hand-assignment
//      UI in this app. Rhythmic gaps on the "other" staff are filled with
//      synthetic filler rests (flagged `_synthetic`) purely so both staves'
//      voices stay metrically complete for VexFlow's formatter — synthetic
//      rests are skipped for geometry/hit-testing/cursor purposes.
//    - plucked-strings (Guitar family): the normal notation staff, plus a
//      real 6-line TAB staff underneath built from the fret positions
//      app.js's chooseTabForNote() already computes per note. This
//      replaces the old inline fret-number text drawn under the notes on
//      the main staff.
//  Layout below generalizes the old fixed "one ROW_H per part" system
//  into per-part stacks of substaff heights.
// ═══════════════════════════════════════════════════════════════════

function _partSubstaffKinds(category) {
  if (category === 'struck-strings')  return ['notation', 'notation-bass'];
  if (category === 'plucked-strings') return ['notation', 'tab'];
  return ['notation'];
}

function _substaffHeight(kind) {
  return kind === 'tab' ? TAB_ROW_H : ROW_H;
}

function _systemHeightFor(partHeights) {
  let h = 0;
  partHeights.forEach((subs, i) => {
    subs.forEach((sh, j) => { h += sh; if (j < subs.length - 1) h += SUB_GAP; });
    if (i < partHeights.length - 1) h += PART_GAP;
  });
  return h;
}

function _partTopFor(rowIdx, partIdx, partHeights) {
  const sysH = _systemHeightFor(partHeights);
  let top = rowIdx * sysH;
  for (let i = 0; i < partIdx; i++) {
    partHeights[i].forEach((sh, j) => { top += sh; if (j < partHeights[i].length - 1) top += SUB_GAP; });
    top += PART_GAP;
  }
  return top + ROW_ABOVE;
}

function _subStaffTop(partTop, partHeights, partIdx, subIdx) {
  let top = partTop;
  for (let j = 0; j < subIdx; j++) top += partHeights[partIdx][j] + SUB_GAP;
  return top;
}

// Split one measure's events into a treble stream and a bass stream for
// grand-staff piano. A note's register (average chroma of its pitch(es))
// decides which staff it belongs to; the other staff gets a same-duration
// filler rest so both voices stay rhythmically complete. Marks/dynamics/
// text are kept on the treble stream only, so they aren't drawn twice.
// NOTE: accidental in-effect tracking (accidentalsForMeasure) runs
// separately per resulting stream, so a courtesy/duplicate accidental is
// resolved against only that hand's own accidentals within the measure,
// not the combined treble+bass accidental state a single hand-written
// grand staff would use. Cross-hand accidental carry-over is a known,
// rare edge case left as a follow-up rather than blocking this feature.
function _splitGrandStaffEvents(measure) {
  const C4 = 48; // noteToChrom('C', null, 4)
  const trebleEvents = [];
  const bassEvents    = [];

  measure.events.forEach(ev => {
    if (ev.type === 'note') {
      const pitches = Array.isArray(ev.pitches) && ev.pitches.length
        ? ev.pitches
        : [{ pitch: ev.pitch, accidental: ev.accidental ?? ev.acc ?? null, octave: ev.octave }];
      const avgChrom = pitches.reduce((s, pi) =>
        s + noteToChrom(pi.pitch, pi.accidental ?? pi.acc ?? null, pi.octave), 0) / pitches.length;
      const toTreble = avgChrom >= C4;
      trebleEvents.push(toTreble ? ev : { ...ev, type: 'rest', _synthetic: true });
      bassEvents.push(!toTreble ? ev : { ...ev, type: 'rest', _synthetic: true });
    } else if (ev.type === 'rest') {
      trebleEvents.push(ev);
      bassEvents.push({ ...ev, _synthetic: true });
    } else {
      // Non-consuming marks (dynamics, text, rehearsal, repeats, etc.) —
      // keep on the treble stream only.
      trebleEvents.push(ev);
    }
  });

  return {
    treble: { ...measure, clef: 'treble', events: trebleEvents },
    bass:   { ...measure, clef: 'bass',   events: bassEvents }
  };
}

// Build VexFlow TabNote/GhostNote tickables for one measure of a
// plucked-strings part, from the `ev.tab.positions` data app.js's
// chooseTabForNote() already attaches to each note event.
function _buildTabNotesForMeasure(VF, measure) {
  const notes = measure.events
    .filter(ev => ev.type === 'note' || ev.type === 'rest')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(ev => {
      const isDotted = ev.duration && ev.duration.endsWith('-dotted');
      const baseDur  = DUR_TO_VF[ev.duration] || 'q';
      let tn;
      if (ev.type === 'rest' || !ev.tab || !ev.tab.positions || !ev.tab.positions.length) {
        // Ghost note: occupies the same rhythmic space but draws nothing —
        // TAB notation conventionally doesn't show a floating rest glyph.
        tn = new VF.GhostNote({ duration: baseDur });
      } else {
        const positions = ev.tab.positions.map(pos => ({ str: pos.stringIdx + 1, fret: String(pos.fret) }));
        tn = new VF.TabNote({ positions, duration: baseDur });
        if (ev.tab.review) {
          try { tn.setStyle({ fillStyle: '#8a2020', strokeStyle: '#8a2020' }); } catch (_) {}
        }
      }
      if (isDotted && tn.addDotToAll) tn.addDotToAll();
      return tn;
    });
  return notes;
}

// ═══════════════════════════════════════════════════════════════════
//  VEXFLOW CLEF NAME MAPPING
// ═══════════════════════════════════════════════════════════════════

function _vfClef(clef) {
  // Our clef names already match VexFlow's ('treble','bass','alto','tenor').
  return clef || 'treble';
}

// Rests were previously always given key 'b/4' regardless of clef — correct
// for treble (the middle line), but wrong for every other clef, since VexFlow
// positions a rest literally at the key you give it rather than re-deriving
// "the middle line" per clef. On an alto/tenor/bass-clef part this put every
// rest floating at treble's middle-line height instead of that clef's own
// middle line, which is what read as rests being inconsistently placed
// relative to the staff and to the notes around them. Each clef's actual
// middle line (the conventional "floating rest" position most notation
// software uses) is used instead.
function _restKeyForClef(clef) {
  switch (clef) {
    case 'bass':  return 'd/3';
    case 'alto':  return 'c/4';
    case 'tenor': return 'a/3';
    default:      return 'b/4';   // treble
  }
}

// ═══════════════════════════════════════════════════════════════════
//  BUILDING VEXFLOW NOTES FOR ONE MEASURE
// ═══════════════════════════════════════════════════════════════════

/**
 * Build VexFlow StaveNote/tickable objects for one measure of one part.
 * Returns { notes, noteMeta, ties } where noteMeta[i] = { ev, vexNote }
 * pairs with the ORIGINAL score event for geometry/hit-testing bookkeeping,
 * plus VexFlow tie objects for same-measure (and, via tieCarry,
 * cross-measure) ties.
 *
 * @param {object} [tieCarry] Optional per-part mutable state
 *   ({ pending }) used to thread an open tie across a measure boundary.
 *   Pass the SAME object across sequential calls for a given part, in
 *   increasing measure order; this function reads the incoming open tie
 *   and writes back whatever's still open when it returns. Omit for
 *   one-off / probe calls (e.g. width pre-calculation) that shouldn't
 *   affect real tie state.
 */
function _buildMeasureNotes(VF, measure, partIdx, tieCarry) {
  const notes    = [];
  const noteMeta = [];
  const ties     = [];
  const accidentalInfo = accidentalsForMeasure(measure);
  const clef = measure.clef || 'treble';

  const sortedEvents = measure.events
    .filter(ev => ev.type === 'note' || ev.type === 'rest')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // Track an open tie (same pitch, ev.tie === true) to connect within the
  // measure. tieCarry (when passed) lets a tie begun on the last note of
  // the PREVIOUS measure connect into this one's first note — ties
  // routinely cross barlines in real notation, and the old single-measure
  // scope silently dropped any tie that did.
  let pendingTieFrom = (tieCarry && tieCarry.pending) || null; // { ev, vexNote }

  for (const ev of sortedEvents) {
    const isDotted  = ev.duration && ev.duration.endsWith('-dotted');
    const isTriplet = ev.duration === 'quarter-triplet';
    const baseDur   = DUR_TO_VF[ev.duration] || 'q';

    let vexNote;

    if (ev.type === 'rest') {
      vexNote = new VF.StaveNote({ clef, keys: [_restKeyForClef(clef)], duration: baseDur + 'r' });
      pendingTieFrom = null;
    } else {
      const chordPitches = Array.isArray(ev.pitches) && ev.pitches.length
        ? ev.pitches
        : [{ pitch:ev.pitch, accidental:ev.accidental || ev.acc || null, octave:ev.octave }];
      const keys = chordPitches.map(pi => {
        const resolved = normalizeAcc(pi.accidental || pi.acc);
        const accSuffix = resolved === '#' ? '#' : resolved === 'b' ? 'b' : '';
        return `${pi.pitch.toLowerCase()}${accSuffix}/${pi.octave}`;
      });

      vexNote = new VF.StaveNote({ clef, keys, duration: baseDur });

      const accInfo = accidentalInfo.get(ev.index) || {};
      const displayAcc = accInfo.displayAcc ?? null;
      if (displayAcc) {
        vexNote.addModifier(new VF.Accidental(displayAcc), 0);
      }

      // Articulations
      const arts = ev.articulations || [];
      if (ev.staccato || arts.includes('staccato')) {
        vexNote.addModifier(new VF.Articulation('a.').setPosition(VF.Modifier.Position.ABOVE), 0);
      }
      if (arts.includes('accent')) {
        vexNote.addModifier(new VF.Articulation('a>').setPosition(VF.Modifier.Position.ABOVE), 0);
      }
      if (arts.includes('tenuto')) {
        vexNote.addModifier(new VF.Articulation('a-').setPosition(VF.Modifier.Position.ABOVE), 0);
      }
      if (arts.includes('fermata')) {
        vexNote.addModifier(new VF.Articulation('a@a').setPosition(VF.Modifier.Position.ABOVE), 0);
      }
      if (arts.includes('trill')) {
        vexNote.addModifier(new VF.Ornament('tr'), 0);
      }
      // Tremolo — stored on the event by app.js's setTremolo() but never
      // turned into a VexFlow modifier, so the tremolo buttons in the
      // Marks / Inst. Marks menus visibly did nothing (playback.js still
      // sounded it, which made this one especially confusing to spot).
      if (ev.tremolo) {
        try {
          vexNote.addModifier(new VF.Tremolo(ev.tremolo), 0);
        } catch (err) {
          console.warn('rhythm space: tremolo draw failed for a note', err);
        }
      }
      if (isTriplet) {
        vexNote.addModifier(new VF.Annotation('3').setFont('EB Garamond', 11, ''), 0);
      }
      // Ties (same-pitch, ev.tie === true → tie to the NEXT note)
      if (pendingTieFrom) {
        const prevEv = pendingTieFrom.ev;
        if (prevEv.pitch === ev.pitch && prevEv.octave === ev.octave) {
          try {
            ties.push(new VF.StaveTie({
              first_note: pendingTieFrom.vexNote,
              last_note: vexNote,
              first_indices: [0],
              last_indices: [0]
            }));
          } catch (err) {
            console.warn('rhythm space: tie draw failed (likely cross-row)', err);
          }
        }
        pendingTieFrom = null;
      }
      if (ev.tie) pendingTieFrom = { ev, vexNote };
    }

    if (isDotted && vexNote.addDotToAll) vexNote.addDotToAll();

    notes.push(vexNote);
    noteMeta.push({ ev, vexNote });
  }

  // Hand off any still-open tie to whatever measure gets built next for
  // this part (see call sites in render() — real builds share one
  // tieCarry object per part; the width-probe pass in _measureVexInfo
  // intentionally omits tieCarry so it can't pollute real tie state).
  if (tieCarry) tieCarry.pending = pendingTieFrom;

  return { notes, noteMeta, ties };
}

/**
 * Compute the minimum width VexFlow needs to lay out this measure's notes,
 * PLUS the extra width its clef/key/time-sig glyphs need (if shown at the
 * start of this measure). This replaces v4's hand-guessed clefWidth() /
 * keySigWidth() / timeSigWidth() heuristics with VexFlow's own metrics.
 */
function _measureVexInfo(VF, measure, isFirst) {
  const needClef = measure.showClef || isFirst;
  const needKey  = (measure.showKey || isFirst) && measure.key !== 'C';
  const needTime = measure.showTime || isFirst;

  // Temp stave purely to measure how much room the clef/key/time glyphs need.
  const probe = new VF.Stave(0, 0, 400);
  if (needClef) probe.addClef(_vfClef(measure.clef));
  if (needKey)  probe.addKeySignature(measure.key);
  if (needTime) probe.addTimeSignature(measure.timeSig);
  const glyphWidth = Math.max(0, probe.getNoteStartX() - probe.getX());

  // Probe pass: no tieCarry — must never mutate real cross-measure tie state.
  const built = _buildMeasureNotes(VF, measure, -1);

  // A measure with zero consuming notes (typically a repeat barline
  // landing where nothing's been typed on that side of it yet) has
  // nothing to space out — see EMPTY_MEASURE_WIDTH's doc comment above.
  let notesMinWidth = built.notes.length ? MIN_NOTES_WIDTH : EMPTY_MEASURE_WIDTH;
  if (built.notes.length) {
    try {
      const voice = new VF.Voice({ num_beats: measureBeats(measure.timeSig) || 4, beat_value: 4 })
        .setMode(VF.Voice.Mode.SOFT);
      voice.addTickables(built.notes);
      const formatter = new VF.Formatter().joinVoices([voice]);
      // NOTE_COMFORT inflates VexFlow's bare-minimum figure so the row
      // bin-packer (and the proportional width split in the render pass)
      // both work off a roomier number than the tightest-legal spacing.
      // MIN_NOTES_WIDTH is the floor either way — a measure with a
      // handful of notes shouldn't compute smaller than an empty one.
      notesMinWidth = Math.max(MIN_NOTES_WIDTH, formatter.preCalculateMinTotalWidth([voice]) * NOTE_COMFORT);
    } catch (err) {
      console.warn('rhythm space: width pre-calc failed for a measure, using fallback width', err);
      notesMinWidth = Math.max(MIN_NOTES_WIDTH, built.notes.length * 34 * NOTE_COMFORT);
    }
  }

  // Width this measure needs when it opens a continuation row —
  // real notation always shows a courtesy clef (+ key sig if not C major).
  const probeFirst = new VF.Stave(0, 0, 400);
  probeFirst.addClef(_vfClef(measure.clef));
  if (measure.key && measure.key !== 'C') probeFirst.addKeySignature(measure.key);
  const glyphWidthIfFirst = Math.max(glyphWidth, probeFirst.getNoteStartX() - probeFirst.getX());

  return {
    needClef, needKey, needTime,
    glyphWidth, glyphWidthIfFirst,
    notesMinWidth,
    totalMinWidth: glyphWidth + notesMinWidth + MEASURE_END_PAD
  };
}

// ═══════════════════════════════════════════════════════════════════
//  GEOM BOOKKEEPING
// ═══════════════════════════════════════════════════════════════════

function _rememberEventGeom(partIdx, ev, x, y, sTop) {
  _eventGeoms.push({
    partIdx,
    index: ev.index,
    type: ev.type,
    consumes: !!ev.consumes,
    noteId: ev._id ?? null,
    x, y, sTop,
    beat: ev.beat ?? 0
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DYNAMICS — determining which notes should actually SHOW a mark
// ═══════════════════════════════════════════════════════════════════

/**
 * Real engraving prints a dynamic once, at the point it changes, and
 * treats it as remaining in effect until the next change — never
 * re-printed under every note that happens to carry it. `note.dynamic`
 * (playback data — set per note, e.g. by a MusicXML <dynamics> element)
 * should only produce a VISIBLE mark where it actually represents a
 * change from whatever dynamic was last in effect, whether that context
 * came from a standalone `type:'dynamic'` token or a previous note's tag.
 *
 * Runs once per part across the FULL note stream (not per-measure) since
 * "the dynamic currently in effect" carries across measure/row boundaries
 * just like a key signature does.
 *
 * @param {Array} notes  A part's raw notes[] array (same array/order
 *   buildMeasures() consumes, so returned indices line up with the
 *   `.index` buildMeasures() assigns to every event).
 * @returns {Set<number>} indices of events that should render a mark.
 */
function _computeVisibleDynamics(notes) {
  const visible = new Set();
  let active = null;
  for (let i = 0; i < notes.length; i++) {
    const ev = notes[i];
    if (ev.type === 'dynamic') {
      // Standalone tokens are inserted one at a time and always shown.
      active = ev.dynamic;
      continue;
    }
    if (ev.type === 'note' && ev.dynamic) {
      if (ev.dynamic !== active) {
        visible.add(i);
        active = ev.dynamic;
      }
    }
  }
  return visible;
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN RENDER
// ═══════════════════════════════════════════════════════════════════

function render(canvas, parts, global) {
  if (!canvas || !parts || !parts.length) return;
  const VF = _vf();
  if (!VF) { _renderFallbackMessage(canvas); return; }

  _noteGeoms  = new Map();
  _eventGeoms = [];
  _spanAnchor = global.spanAnchor ?? (
    global.spanAnchorId != null ? { partIdx: global.activePart ?? 0, noteId: global.spanAnchorId } : null
  );

  const paper = canvas.parentElement;
  // getBoundingClientRect() gives the actual rendered CSS-pixel width of
  // the paper element right now — robust across browsers/zoom levels,
  // unlike clientWidth (which rounds to integer pixels inconsistently
  // across engines) combined with a guessed padding offset. .paper has no
  // internal padding of its own, so its full width is available to the
  // canvas. Floor (not round) so the logical layout width we compute
  // content against is never larger than what's actually on screen.
  const paperW = paper ? paper.getBoundingClientRect().width : 700;
  _cssW = Math.max(480, Math.floor(paperW));

  const numParts = parts.length;
  const partMeasures = parts.map(p => buildMeasures(p.notes, p.state));
  const numMeasures  = Math.max(0, ...partMeasures.map(m => m.length));

  // Per-part substaff layout (see "MULTI-STAFF PARTS" section above) —
  // most parts are a single staff; struck-strings (Piano) gets a grand
  // staff (treble+bass), plucked-strings (Guitar family) gets a TAB staff.
  const partCategories = parts.map(p => (p.state && p.state.category) || 'struck-strings');
  const partKinds   = partCategories.map(_partSubstaffKinds);
  const partHeights = partKinds.map(kinds => kinds.map(_substaffHeight));

  // Per-part mutable state threaded across sequential _buildMeasureNotes
  // calls (in increasing measure order) so ties and dynamics both behave
  // correctly across measure/row boundaries instead of resetting per
  // measure. Keyed per sub-staff (e.g. 'main'/'treble' vs 'bass') since a
  // grand-staff part now threads two independent tie states. See
  // _buildMeasureNotes' tieCarry doc comment and _computeVisibleDynamics
  // above.
  const partTieState   = Array.from({ length: numParts }, () => ({}));
  const partVisibleDyn = parts.map(p => _computeVisibleDynamics(p.notes || []));

  // ── Pass 1: per-part-per-measure VexFlow info + max width per measure ──
  const perPartInfo   = [];
  const measureWidths = new Array(numMeasures).fill(0);

  for (let pi = 0; pi < numParts; pi++) {
    perPartInfo[pi] = [];
    for (let mi = 0; mi < numMeasures; mi++) {
      const measure = partMeasures[pi][mi];
      if (!measure) { perPartInfo[pi][mi] = null; continue; }
      const info = _measureVexInfo(VF, measure, mi === 0);
      perPartInfo[pi][mi] = info;
      measureWidths[mi] = Math.max(measureWidths[mi], info.totalMinWidth);
    }
  }

  // ── Pass 2: group measures into rows by dynamic bin-packing ──────────
  //    Accumulate measures in a row until their total minimum width
  //    exceeds the available line width. This ensures the staff wraps
  //    automatically and never runs off the screen.
  const rowGutter = numParts > 1 ? 20 : 0;
  const rowX0 = L_PAD + rowGutter;
  const rowX1 = _cssW - R_PAD - ROW_END_SLACK;
  const rowUsable = Math.max(200, rowX1 - rowX0);

  const rows = [];
  let currentRow = [];
  let currentWidth = 0;

  for (let mi = 0; mi < numMeasures; mi++) {
    const minW = measureWidths[mi];
    if (currentRow.length > 0 && currentWidth + minW > rowUsable) {
      rows.push(currentRow);
      currentRow = [];
      currentWidth = 0;
    }
    currentRow.push(mi);
    currentWidth += minW;
  }
  if (currentRow.length > 0) rows.push(currentRow);
  if (!rows.length) return;

  const sysH = _systemHeightFor(partHeights);
  const cssH = sysH * rows.length + 100; // generous bottom pad for markings + last-row content

  canvas.style.width  = _cssW + 'px';
  canvas.style.height = cssH  + 'px';
  // Keep VexFlow's canvas dimensions in the same CSS-pixel coordinate
  // system used for layout. Feeding it DPR-inflated dimensions and then
  // manually scaling the context distorts font-backed notation glyphs in
  // some browsers, making clefs, time signatures, noteheads, and marks
  // look horizontally compressed.
  canvas.width  = _cssW;
  canvas.height = cssH;

  const renderer = new VF.Renderer(canvas, VF.Renderer.Backends.CANVAS);
  renderer.resize(_cssW, cssH);
  const ctx = renderer.getContext();
  if (ctx.clear) ctx.clear();
  _setInk(ctx, INK);

  // ── Pass 3: render each row ──────────────────────────────────────────
  rows.forEach((rowMeasureIdxs, ri) => {
    const isLastRow = ri === rows.length - 1;
    const rowX0 = L_PAD + rowGutter;
    const rowX1 = _cssW - R_PAD - ROW_END_SLACK;
    const rowUsable = Math.max(200, rowX1 - rowX0);
    // Calculate the maximum glyph width for each measure in the row across all parts
    const glyphWidths = rowMeasureIdxs.map((mi, k) => {
      let maxG = 0;
      for (let pi = 0; pi < numParts; pi++) {
        if (perPartInfo[pi][mi]) {
          const info = perPartInfo[pi][mi];
          // k===0: row-start always needs courtesy-clef space
          const gw = k === 0 ? (info.glyphWidthIfFirst || info.glyphWidth) : info.glyphWidth;
          maxG = Math.max(maxG, gw || 0);
        }
      }
      return maxG;
    });

    const notesMinWidths = rowMeasureIdxs.map(mi => {
      let maxN = 0;
      for (let pi = 0; pi < numParts; pi++) {
        if (perPartInfo[pi][mi]) {
          maxN = Math.max(maxN, perPartInfo[pi][mi].notesMinWidth || MIN_NOTES_WIDTH);
        }
      }
      return maxN;
    });

    const totalGlyphsWidth = glyphWidths.reduce((s, g) => s + g, 0);
    const K = rowMeasureIdxs.length;
    const totalPadding = K * MEASURE_END_PAD;
    const naturalNotesWidth = notesMinWidths.reduce((s, n) => s + n, 0);
    const naturalRowWidth = totalGlyphsWidth + naturalNotesWidth + totalPadding;

    // Always fill the full line — fixed-width staff, variable note spacing.
    const targetRowWidth = rowUsable;
    const availableForNotes = Math.max(40, targetRowWidth - totalGlyphsWidth - totalPadding);
    const totalNotesMin = naturalNotesWidth;

    // ── Proportional width allocation ──────────────────────────────────
    // Distribute the remaining horizontal space to each measure 
    // proportionally based on how much notesMinWidth it requires. 
    // This perfectly spaces measures based on their note content, 
    // allowing dense measures to take more space than sparse ones.

    const widths = rowMeasureIdxs.map((mi, k) => {
      const noteShare = totalNotesMin > 0 ? (notesMinWidths[k] / totalNotesMin) * availableForNotes : (availableForNotes / K);
      return glyphWidths[k] + noteShare + MEASURE_END_PAD;
    });

    const xs = [];
    { let x = rowX0; rowMeasureIdxs.forEach((mi, k) => { xs.push(x); x += widths[k]; }); }

    const rowFirstStave = new Array(numParts).fill(null);

    // Draws one VexFlow stave + voice for a single (measure, staff) pair.
    // Shared by the main/treble staff and, for grand-staff piano, the bass
    // staff too — they're otherwise identical drawing work.
    function _drawNotationStaff(pi, measureForStaff, clefOverride, tieStateKey, stopTop, x, w, isRowFirst, info, hasRepeatStart, hasRepeatEnd) {
      const stave = new VF.Stave(x, stopTop, w);
      if (info.needClef || isRowFirst) stave.addClef(_vfClef(clefOverride || measureForStaff.clef));
      if (info.needKey  || (isRowFirst && measureForStaff.key && measureForStaff.key !== 'C')) stave.addKeySignature(measureForStaff.key);
      if (info.needTime) stave.addTimeSignature(measureForStaff.timeSig);
      if (hasRepeatStart) { try { stave.setBegBarType(VF.Barline.type.REPEAT_BEGIN); } catch(_) {} }
      if (hasRepeatEnd)   { try { stave.setEndBarType(VF.Barline.type.REPEAT_END);   } catch(_) {} }
      if (isLastMeasureInRow && !hasRepeatEnd) {
        try { stave.setEndBarType(ri === rows.length - 1 ? VF.Barline.type.END : VF.Barline.type.SINGLE); } catch(_) {}
      }
      stave.setContext(ctx).draw();

      if (!partTieState[pi][tieStateKey]) partTieState[pi][tieStateKey] = { pending: null };
      const built = _buildMeasureNotes(VF, measureForStaff, pi, partTieState[pi][tieStateKey]);
      const noteAnchors = [];
      if (built.notes.length) {
        const voice = new VF.Voice({ num_beats: measureBeats(measureForStaff.timeSig) || 4, beat_value: 4 })
          .setMode(VF.Voice.Mode.SOFT);
        voice.addTickables(built.notes);

        const formatWidth = Math.max(20, w - (stave.getNoteStartX() - stave.getX()) - 10);
        new VF.Formatter().joinVoices([voice]).format([voice], formatWidth);

        const beamableNotes = built.notes.filter(n => typeof n.isRest !== 'function' || !n.isRest());
        let beams = [];
        try { beams = VF.Beam.generateBeams(beamableNotes, { beam_rests: false }); }
        catch (err) { console.warn('rhythm space: beam generation failed for a measure', err); }

        voice.draw(ctx, stave);
        beams.forEach(b => b.setContext(ctx).draw());
        built.ties.forEach(t => t.setContext(ctx).draw());

        built.noteMeta.forEach(({ ev, vexNote }) => {
          // Synthetic filler rests (the "other hand" of a grand-staff split)
          // exist only to keep the voice metrically complete — they aren't
          // real events, so skip geometry/hit-testing/cursor bookkeeping.
          if (ev._synthetic) return;
          const gx = vexNote.getAbsoluteX();
          const gy = stopTop + 2 * LS;
          _rememberEventGeom(pi, ev, gx, gy, stopTop);
          noteAnchors.push({ ev, x: gx, y: gy, vexNote });
          if (ev.type === 'note' && ev._id != null) {
            let stemUp = true;
            try { stemUp = vexNote.getStemDirection ? vexNote.getStemDirection() === 1 : true; } catch (_) {}
            _noteGeoms.set(`${pi}_${ev._id}`, {
              partIdx: pi, index: ev.index, x: gx, y: gy, sTop: stopTop, stemUp, noteId: ev._id, vexNote
            });
            _drawNoteMarkers(ctx, vexNote, gx, gy, ev, pi, global);
          }
        });
      }

      _drawMeasureMarks(ctx, measureForStaff, noteAnchors, stave, x, w, pi, stopTop, partVisibleDyn[pi]);
      return stave;
    }

    let isLastMeasureInRow = false; // set per-iteration below (closure var for _drawNotationStaff)

    for (let pi = 0; pi < numParts; pi++) {
      const kinds    = partKinds[pi];
      const isGrand  = kinds[1] === 'notation-bass';
      const isTabbed = kinds[1] === 'tab';
      const partTop   = _partTopFor(ri, pi, partHeights);
      const secondTop = (isGrand || isTabbed) ? _subStaffTop(partTop, partHeights, pi, 1) : null;

      let lastMainStave = null, lastSecondStave = null;

      rowMeasureIdxs.forEach((mi, k) => {
        const measure = partMeasures[pi][mi];
        const info    = perPartInfo[pi][mi];
        if (!measure) return;

        const hasRepeatStart = measure.events.some(ev => ev.type === 'repeat' && ev.direction === 'start');
        const hasRepeatEnd   = measure.events.some(ev => ev.type === 'repeat' && ev.direction === 'end');
        const isRowFirst = k === 0;
        isLastMeasureInRow = k === rowMeasureIdxs.length - 1;

        const split = isGrand ? _splitGrandStaffEvents(measure) : null;
        const mainMeasure = isGrand ? split.treble : measure;

        const stave = _drawNotationStaff(
          pi, mainMeasure, isGrand ? 'treble' : null, isGrand ? 'treble' : 'main',
          partTop, xs[k], widths[k], isRowFirst, info, hasRepeatStart, hasRepeatEnd
        );
        if (!rowFirstStave[pi]) rowFirstStave[pi] = stave;
        lastMainStave = stave;

        if (isGrand) {
          const bStave = _drawNotationStaff(
            pi, split.bass, 'bass', 'bass',
            secondTop, xs[k], widths[k], isRowFirst, info, hasRepeatStart, hasRepeatEnd
          );
          lastSecondStave = bStave;
          if (isRowFirst) {
            try {
              const brace = new VF.StaveConnector(stave, bStave);
              brace.setType(VF.StaveConnector.type.BRACE);
              brace.setContext(ctx).draw();
            } catch (_) {}
          }
        } else if (isTabbed) {
          const tStave = new VF.TabStave(xs[k], secondTop, widths[k]);
          if (isRowFirst) tStave.addClef('tab');
          tStave.setContext(ctx).draw();
          lastSecondStave = tStave;

          const tabNotes = _buildTabNotesForMeasure(VF, measure);
          if (tabNotes.length) {
            try {
              const tVoice = new VF.Voice({ num_beats: measureBeats(measure.timeSig) || 4, beat_value: 4 })
                .setMode(VF.Voice.Mode.SOFT);
              tVoice.addTickables(tabNotes);
              const tFormatWidth = Math.max(20, widths[k] - (tStave.getNoteStartX() - tStave.getX()) - 10);
              new VF.Formatter().joinVoices([tVoice]).format([tVoice], tFormatWidth);
              tVoice.draw(ctx, tStave);
            } catch (err) {
              console.warn('rhythm space: TAB staff draw failed for a measure', err);
            }
          }
        }

        // Connect the part's own two staves down the left edge of every
        // measure column (a plain bracket for guitar+TAB; the brace above
        // already implies the piano connection at row-start).
        if ((isGrand || isTabbed) && isRowFirst && lastSecondStave) {
          try {
            const conn = new VF.StaveConnector(stave, lastSecondStave);
            conn.setType(VF.StaveConnector.type.SINGLE_LEFT);
            conn.setContext(ctx).draw();
          } catch (_) {}
        }
      });
    }

    // ── Braces / system barlines for multi-part rows ───────────────────
    if (numParts > 1) {
      for (let pi = 0; pi < numParts - 1; pi++) {
        if (!rowFirstStave[pi] || !rowFirstStave[pi + 1]) continue;
        const conn = new VF.StaveConnector(rowFirstStave[pi], rowFirstStave[pi + 1]);
        conn.setType(pi === 0 ? VF.StaveConnector.type.BRACE : VF.StaveConnector.type.SINGLE_LEFT);
        conn.setContext(ctx).draw();
      }
      if (rowFirstStave[0] && rowFirstStave[numParts - 1]) {
        const barConn = new VF.StaveConnector(rowFirstStave[0], rowFirstStave[numParts - 1]);
        barConn.setType(VF.StaveConnector.type.SINGLE_LEFT);
        barConn.setContext(ctx).draw();
      }
    }

    // Part name labels (first row only)
    if (ri === 0 && numParts > 1) {
      for (let pi = 0; pi < numParts; pi++) {
        const sTop = _partTopFor(ri, pi, partHeights);
        _setFillInk(ctx, INK);
        if (ctx.setFont) ctx.setFont("italic 12px 'EB Garamond', serif");
        else ctx.font = "italic 12px 'EB Garamond', serif";
        ctx.fillText(parts[pi].name || `Part ${pi + 1}`, L_PAD, sTop + 2 * LS);
      }
    }
  });

  // ── Slurs (post-pass, uses _noteGeoms so they can span rows) ─────────
  for (let pi = 0; pi < numParts; pi++) {
    _drawPartSlurs(VF, ctx, parts[pi].slurs || [], pi);
  }

  // ── Cursor ─────────────────────────────────────────────────────────
  if (global.blinkOn) {
    _drawCursor(ctx, global);
  }
}

// ── Ink-color helpers: VexFlow's RenderContext historically exposed
//    setFillStyle()/setStrokeStyle(), but 4.x's CanvasContext mirrors the
//    real CanvasRenderingContext2D properties more closely. Try both so a
//    version bump doesn't silently no-op the ink color. ──────────────────
function _setInk(ctx, color) {
  _setFillInk(ctx, color);
  if (ctx.setStrokeStyle) ctx.setStrokeStyle(color);
  else ctx.strokeStyle = color;
}
function _setFillInk(ctx, color) {
  if (ctx.setFillStyle) ctx.setFillStyle(color);
  else ctx.fillStyle = color;
}

function _drawFallbackText(ctx, text, x, sTop) {
  if (!text) return;
  _setFillInk(ctx, INK);
  if (ctx.setFont) ctx.setFont("italic 12px 'EB Garamond', serif");
  else ctx.font = "italic 12px 'EB Garamond', serif";
  ctx.fillText(text, x, sTop + 4 * LS + 14);
}

const DRAWABLE_MARK_TYPES = new Set([
  'dynamic', 'text-mark', 'text', 'rehearsal', 'segno', 'coda', 'nav', 'pedal'
]);

function _isDrawableMark(ev) {
  return ev && DRAWABLE_MARK_TYPES.has(ev.type);
}

function _markZone(ev) {
  if (!ev) return 'below';
  if (ev.type === 'dynamic' || ev.type === 'pedal') return 'below';
  if (ev.type === 'text-mark') return ev.subtype === 'tempo' ? 'above' : 'below';
  if (ev.type === 'text') return /^capo\b/i.test(ev.text || '') ? 'above' : 'below';
  return 'above';
}

function _markLabel(ev) {
  if (!ev) return '';
  if (ev.type === 'dynamic') return ev.dynamic || '';
  if (ev.type === 'text-mark' || ev.type === 'text') return ev.text || '';
  if (ev.type === 'rehearsal') return ev.label || '';
  if (ev.type === 'segno') return '\uD834\uDD0B';
  if (ev.type === 'coda') return '\uD834\uDD0C';
  if (ev.type === 'pedal') return ev.pedal === 'down' ? 'Ped.' : '\u204E';
  if (ev.type === 'nav') {
    const NAV_LABELS = {
      'fine':       'Fine',
      'ds-al-coda': 'D.S. al Coda',
      'dc-al-capo': 'D.C. al Capo',
      'ds-al-fine': 'D.S. al Fine',
      'dc-al-fine': 'D.C. al Fine'
    };
    return NAV_LABELS[ev.nav] || ev.nav || '';
  }
  return '';
}

function _markFont(ev) {
  if (ev.type === 'dynamic') return "italic bold 16px 'EB Garamond', serif";
  if (ev.type === 'rehearsal') return "bold 13px 'EB Garamond', serif";
  if (ev.type === 'segno' || ev.type === 'coda') return '20px serif';
  if (ev.type === 'pedal') return "italic 13px 'EB Garamond', serif";
  if (ev.type === 'text' && /^capo\b/i.test(ev.text || '')) return "600 13px 'EB Garamond', serif";
  return "italic 12px 'EB Garamond', serif";
}

function _setFont(ctx, spec) {
  if (ctx.setFont) ctx.setFont(spec); else ctx.font = spec;
}

function _textWidth(ctx, text, fallback = 30) {
  try {
    const m = ctx.measureText ? ctx.measureText(text) : null;
    return Math.max(1, m?.width || fallback);
  } catch (_) {
    return fallback;
  }
}

function _anchorXForMark(ev, anchors, stave, measureX, measureW) {
  if (anchors.length) {
    const anchored = anchors.find(a => a.ev._id != null && ev.anchorId === a.ev._id);
    if (anchored) return anchored.x;

    const beat = ev.beat ?? 0;
    const atOrAfter = anchors.find(a => (a.ev.beat ?? 0) >= beat - 1e-9);
    if (atOrAfter) return atOrAfter.x;

    const last = anchors[anchors.length - 1];
    if (last) return last.x + 24;
  }

  const cap = Math.max(1, measureBeats(ev.effectiveTimeSig || ev.timeSig || '4/4') || 4);
  const noteStart = stave.getNoteStartX ? stave.getNoteStartX() : measureX + 40;
  const usable = Math.max(20, measureW - (noteStart - measureX) - MEASURE_END_PAD);
  return noteStart + Math.max(0, Math.min(1, (ev.beat ?? 0) / cap)) * usable;
}

function _collectMeasureMarks(measure, anchors, visibleDynIndices) {
  const marks = [];
  measure.events.forEach(ev => {
    if (!ev.consumes && _isDrawableMark(ev)) marks.push(ev);
    if (ev.consumes && ev.type === 'note' && ev.dynamic &&
        visibleDynIndices && visibleDynIndices.has(ev.index)) {
      marks.push({
        _id: `${ev._id || ev.index}_dynamic`,
        type: 'dynamic',
        dynamic: ev.dynamic,
        beat: ev.beat,
        index: ev.index,
        anchorId: ev._id,
        effectiveTimeSig: ev.timeSig
      });
    }
  });
  return marks.sort((a, b) => (a.beat ?? 0) - (b.beat ?? 0) || (a.index ?? 0) - (b.index ?? 0));
}

function _layoutMeasureMarks(ctx, marks, anchors, stave, measureX, measureW) {
  const lanes = { above: [], below: [] };
  return marks.map(ev => {
    _setFont(ctx, _markFont(ev));
    const label = _markLabel(ev);
    const rawW = _textWidth(ctx, label, ev.type === 'dynamic' ? 24 : 42);
    const w = ev.type === 'rehearsal' ? rawW + 10 : rawW;
    const zone = _markZone(ev);
    const anchorX = _anchorXForMark(ev, anchors, stave, measureX, measureW);
    const centered = ev.type === 'dynamic' || ev.type === 'segno' || ev.type === 'coda';
    const x = Math.max(measureX + 3, Math.min(measureX + measureW - w - 3, centered ? anchorX - w / 2 : anchorX));
    const gap = 8;
    let lane = lanes[zone].findIndex(endX => x >= endX + gap);
    if (lane === -1) {
      lane = lanes[zone].length;
      lanes[zone].push(-Infinity);
    }
    lanes[zone][lane] = x + w;
    return { ev, x, zone, lane };
  });
}

function _drawMeasureMarks(ctx, measure, anchors, stave, measureX, measureW, partIdx, sTop, visibleDynIndices) {
  const marks = _collectMeasureMarks(measure, anchors, visibleDynIndices);
  if (!marks.length) return;

  const laidOut = _layoutMeasureMarks(ctx, marks, anchors, stave, measureX, measureW);
  laidOut.forEach(mark => {
    const y = mark.zone === 'above'
      ? sTop - 14 - mark.lane * 18
      : sTop + 4 * LS + 24 + mark.lane * 18;
    _rememberEventGeom(partIdx, mark.ev, mark.x, y, sTop);
    _drawAttrEvent(ctx, mark.ev, mark.x, y, sTop, mark.lane);
  });
}

/**
 * Draw a normalized score mark. `x` and `y` are pre-laid-out by
 * _drawMeasureMarks; this function only paints the mark's visual shape.
 */
function _drawAttrEvent(ctx, ev, x, y, sTop, lane = 0) {
  const staffBottom = sTop + 4 * LS;

  function stroke(color) {
    if (ctx.setStrokeStyle) ctx.setStrokeStyle(color); else ctx.strokeStyle = color;
  }
  function lineW(w) {
    if (ctx.setLineWidth) ctx.setLineWidth(w); else ctx.lineWidth = w;
  }

  switch (ev.type) {

    case 'dynamic': {
      const dyn = ev.dynamic || '';
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, '#1e1206');
      ctx.fillText(dyn, x, y);
      break;
    }

    case 'text-mark': {
      const text = ev.text || '';
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, INK);
      ctx.fillText(text, x, y);
      break;
    }

    case 'text': {
      // Covers capo (type:'text', subtype:'expression') and other raw text tokens
      const text = ev.text || '';
      const isCapo = /^capo\b/i.test(text);
      if (isCapo) {
        _setFont(ctx, _markFont(ev));
        _setFillInk(ctx, INK);
        ctx.fillText(text, x, y);
        const tw = _textWidth(ctx, text, 40);
        stroke(INK);
        lineW(1.2);
        ctx.beginPath();
        ctx.moveTo(x, y + 3);   ctx.lineTo(x + tw, y + 3);    // top rule
        ctx.moveTo(x, y + 3);   ctx.lineTo(x, y + 8);          // left tick
        ctx.moveTo(x + tw, y + 3); ctx.lineTo(x + tw, y + 8);  // right tick
        ctx.stroke();
      } else {
        _setFont(ctx, _markFont(ev));
        _setFillInk(ctx, INK);
        ctx.fillText(text, x, y);
      }
      break;
    }

    case 'rehearsal': {
      const lbl = ev.label || '';
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, INK);
      const tw = _textWidth(ctx, lbl, 10);
      const pad = 4, h = 18;
      const rx = x, ry = y - 14;
      stroke(INK); lineW(1.5);
      ctx.beginPath(); ctx.rect(rx, ry, tw + pad * 2, h); ctx.stroke();
      ctx.fillText(lbl, x + pad, ry + 13);
      break;
    }

    case 'segno':
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, INK);
      ctx.fillText('\uD834\uDD0B', x, y);
      break;

    case 'coda':
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, INK);
      ctx.fillText('\uD834\uDD0C', x, y);
      break;

    case 'nav': {
      const label = _markLabel(ev);
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, INK);
      ctx.fillText(label, x, y);
      break;
    }

    case 'pedal': {
      _setFont(ctx, _markFont(ev));
      _setFillInk(ctx, '#3a2810');
      ctx.fillText(_markLabel(ev), x, y + (lane > 0 ? 2 : 14));
      break;
    }

    // 'repeat', 'clef', 'key', 'timesig' handled elsewhere (barline types / stave glyphs)
    default: break;
  }
}

function _drawNoteMarkers(ctx, vexNote, x, y, ev, partIdx, global) {
  const cursor = global.cursor;
  const bbox = vexNote.getBoundingBox ? vexNote.getBoundingBox() : null;
  const cy = bbox ? bbox.y + bbox.h / 2 : y;

  if (ev.index === cursor - 1) {
    if (ctx.setStrokeStyle) ctx.setStrokeStyle(SELECTION_RING); else ctx.strokeStyle = SELECTION_RING;
    if (ctx.setLineWidth) ctx.setLineWidth(2.2); else ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(x, cy, 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (_spanAnchor && _spanAnchor.partIdx === partIdx && ev._id === _spanAnchor.noteId) {
    if (ctx.setStrokeStyle) ctx.setStrokeStyle(SPAN_ANCHOR_C); else ctx.strokeStyle = SPAN_ANCHOR_C;
    if (ctx.setLineWidth) ctx.setLineWidth(2.5); else ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, cy, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Fret positions (ev.tab) now render on the part's own TAB staff (see
  // _buildTabNotesForMeasure / the TabStave draw in render()) instead of as
  // small inline text under the note on the main staff.
}

// ═══════════════════════════════════════════════════════════════════
//  SLURS
// ═══════════════════════════════════════════════════════════════════

function _drawPartSlurs(VF, ctx, slurs, partIdx) {
  for (const slur of slurs) {
    const g0 = _noteGeoms.get(`${partIdx}_${slur.fromId}`);
    const g1 = _noteGeoms.get(`${partIdx}_${slur.toId}`);
    if (!g0 || !g1 || !g0.vexNote || !g1.vexNote) continue;
    try {
      const curve = new VF.Curve(g0.vexNote, g1.vexNote, {});
      curve.setContext(ctx).draw();
    } catch (err) {
      console.warn('rhythm space: slur draw failed (likely cross-row — needs Curve position options)', err);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CURSOR
// ═══════════════════════════════════════════════════════════════════

function _drawCursor(ctx, global) {
  const ap = global.activePart ?? 0;
  const cursor = global.cursor;

  // Only note/rest ("consuming") events are valid cursor targets. Marks
  // and annotations (dynamics, text, rehearsal marks, staccato, etc.) also
  // live in _eventGeoms so they're hit-testable, but their x/y sit off in
  // their own lane above or below the staff — not on the note baseline.
  // Including them here let the cursor snap onto a mark's coordinates
  // whenever a mark was the next event after the cursor position, which is
  // what produced the tall, floating, misaligned cursor: its x/sTop came
  // from a mark's geometry instead of a note's.
  const candidates = _eventGeoms
    .filter(g => g.partIdx === ap && g.consumes)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let target = candidates.find(g => g.index >= cursor);
  let cx, sTop;
  if (target) {
    cx = target.x; sTop = target.sTop;
  } else if (candidates.length) {
    const last = candidates[candidates.length - 1];
    cx = last.x + 24; sTop = last.sTop;
  } else {
    return;
  }

  if (ctx.setStrokeStyle) ctx.setStrokeStyle(CURSOR_C); else ctx.strokeStyle = CURSOR_C;
  if (ctx.setLineWidth) ctx.setLineWidth(1.8); else ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(cx, sTop - 12);
  ctx.lineTo(cx, sTop + 4 * LS + 12);
  ctx.stroke();
}

// ═══════════════════════════════════════════════════════════════════
//  HIT TESTING
// ═══════════════════════════════════════════════════════════════════

function hitTest(partIdx, x, y, opts = {}) {
  const notesOnly = !!opts.notesOnly;
  const candidates = _eventGeoms.filter(g =>
    g.partIdx === partIdx && (notesOnly ? g.type === 'note' : g.consumes)
  );

  let best = null;
  let bestScore = Infinity;
  for (const g of candidates) {
    const dy = Math.abs(y - (g.y ?? g.sTop + 2 * LS));
    const dx = Math.abs(x - g.x);
    if (notesOnly && (dx > 30 || dy > 34)) continue;
    const score = dx + Math.max(0, dy - 10) * 1.8;
    if (score < bestScore) {
      best = g;
      bestScore = score;
    }
  }

  if (!best) return null;
  return {
    ...best,
    cursorIndex: best.index + (x > best.x + 6 ? 1 : 0)
  };
}

// ═══════════════════════════════════════════════════════════════════
//  EXPORTS  (same shape as v4 — app.js / musicxml.js need no changes)
// ═══════════════════════════════════════════════════════════════════

window.MusicEngine = {
  DUR_KEY_MAP, DUR_LABELS, DUR_BEATS, DYNAMICS,
  noteToChrom, chromToNote,
  beatOf, measureBeats, isBeamable, isAttr,
  buildMeasures, measureSpaceAt,
  keyAccidentals, defaultAccForKey, normalizeAcc,
  resolveAccidental, accidentalContextAt, accidentalForNoteAt,
  render,
  KEY_SIGS,
  systemHeight, partStaffTop,
  getNoteGeom:    (partIdx, noteId) => _noteGeoms.get(`${partIdx}_${noteId}`),
  getAllNoteGeoms: ()                => _noteGeoms,
  getEventGeoms:   partIdx           => _eventGeoms.filter(g => partIdx == null || g.partIdx === partIdx),
  hitTest
};