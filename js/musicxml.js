/**
 * Rymspace — MusicXML Import / Export
 * musicxml.js
 *
 * Depends on: nothing (standalone; reads window.MusicEngine.KEY_SIGS if available)
 *
 * Usage:
 *   window.MusicXML.exportMusicXML(parts, title)  → XML string
 *   window.MusicXML.importMusicXML(xmlString)      → { title, parts }
 *
 * ─── FIDELITY PASS (this revision) ──────────────────────────────────────
 * Audited against every mark the editor can actually produce (app.js's
 * insertToken()/insertNote()/toggleArticulation() call sites) and fixed
 * everything that was silently dropped or mis-encoded on export/import:
 *
 *   - Chords (ev.pitches[]) — previously only the primary pitch was ever
 *     exported; extra chord pitches vanished entirely. Now exported as
 *     proper <chord/> note groups and re-merged on import.
 *   - Slurs (part.slurs[]) — previously not exported AT ALL (import could
 *     read them, but there was nothing to read from this app's own
 *     output). Now exported with proper start/stop numbering.
 *   - Fermata and trill — articulations list included them, but export
 *     silently skipped both. Now emitted as <fermata/> / <trill-mark/>.
 *   - Rehearsal marks, segno, coda, pedal, D.S./D.C./Fine nav marks — the
 *     old code had a comment admitting these were "omitted for brevity"
 *     from export, and none of them were parsed on import either. All six
 *     now round-trip using their proper dedicated MusicXML elements.
 *   - Capo markings (type:'text') — export only ever checked for
 *     type:'text-mark', so Capo tokens (a different type) were dropped.
 *   - Tempo vs. expression text-marks — export hardcoded placement="above"
 *     for every text-mark regardless of subtype, while import classifies
 *     subtype FROM placement. Net effect: every expression mark (pizz.,
 *     con sord., dolce, ...) flipped into a tempo mark on any export→
 *     import round trip. Fixed so export's placement matches its own
 *     subtype, which is what import expects.
 *   - Note-level <dynamics> was previously a direct child of <note>, which
 *     isn't valid MusicXML — it belongs inside <notations>. Fixed.
 *   - Ties previously only ever emitted <tie type="start"/>, never the
 *     matching <tie type="stop"/> on the following note — technically
 *     invalid MusicXML. Now paired correctly (see _computeTieLinks).
 *   - Mid-measure key/clef/time-signature changes ("Score → Here", or the
 *     K/T/L hotkeys used mid-bar) used to be silently deferred to the
 *     next measure boundary on export, disagreeing with the on-screen
 *     renderer (which applies them immediately). Now emits an inline
 *     <attributes> block at the exact point of change, matching the
 *     screen.
 *   - Repeat barlines used to be written into the XML without actually
 *     splitting the <measure> element there — an invalid combination
 *     (barlines are measure boundaries in MusicXML). Measures now split
 *     exactly where a repeat token sits, mirroring engine.js's own
 *     "repeat barlines are always real measure boundaries" rule.
 *   - Accidental *display* (the <accidental> courtesy-symbol element,
 *     independent of the actual sounding pitch) previously just echoed
 *     whatever the note's own accExplicit flag happened to be, which
 *     only reflects whether the user typed a #/-/= prefix — not whether
 *     the symbol is actually needed in context. Now uses the same
 *     measure-carried-accidental convention real engraving (and this
 *     app's own renderer) uses, so the exported symbol placement matches
 *     the screen exactly.
 *
 * Not covered by this pass (documented, not silently skipped):
 *   - Grand-staff (piano) and TAB-staff export as literal multi-staff
 *     MusicXML <staves>. Both are purely on-screen rendering splits of a
 *     single note stream — no pitch/rhythm/mark data is lost by exporting
 *     a piano or guitar part as one staff, it just isn't split into two
 *     visually. Real multi-staff export is a separate, structural feature
 *     (staff-details, <staff> tags per note, <staff-tuning>) rather than
 *     a "mark," and is left as a follow-up.
 *   - Hairpins/grace notes — not implemented anywhere in the data model
 *     or renderer yet, so there is nothing to export.
 */
'use strict';

// ─── Duration tables ───────────────────────────────────────────────────────────

// MusicXML <divisions> per quarter note.  All durations expressed in these units.
const DIVISIONS = 8;

// Rymspace duration → MusicXML <type> string
const RYM_TO_MXL_TYPE = {
  'whole':           'whole',
  'half':            'half',
  'half-dotted':     'half',
  'quarter':         'quarter',
  'quarter-dotted':  'quarter',
  'quarter-triplet': 'quarter',
  'eighth':          'eighth',
  'eighth-dotted':   'eighth',
  'sixteenth':       '16th',
  'thirty-second':   '32nd',
};

// Rymspace duration → MusicXML <duration> value (in DIVISIONS units)
const RYM_TO_MXL_DIVS = {
  'whole':           32,
  'half':            16,
  'half-dotted':     24,   // half × 1.5
  'quarter':          8,
  'quarter-dotted':  12,   // quarter × 1.5
  'quarter-triplet':  Math.round(8 * 2 / 3),   // ≈ 5 divisions; time-modification added
  'eighth':           4,
  'eighth-dotted':    6,   // eighth × 1.5
  'sixteenth':        2,
  'thirty-second':    1,
};

// MusicXML <type> string → Rymspace duration (base, before dotted/triplet modifier)
const MXL_TYPE_TO_RYM = {
  'whole':   'whole',
  'half':    'half',
  'quarter': 'quarter',
  'eighth':  'eighth',
  '16th':    'sixteenth',
  '32nd':    'thirty-second',
  '64th':    'thirty-second',   // closest approximation
};

// Rymspace duration string → quarter-beats (duplicated locally to keep this file standalone)
// Named distinctly from engine.js's own DUR_BEATS: both files load as plain
// (non-module) <script> tags in editor.html, and top-level const/let in
// classic scripts all share ONE lexical scope across the document. Two
// files each declaring `const DUR_BEATS` collided as a SyntaxError at parse
// time, which silently aborted this whole file before it ever reached
// `window.MusicXML = {...}` at the bottom — that's what made Import/Export
// XML look "not loaded" with nothing but a console error to show for it.
const MXL_DUR_BEATS = {
  'whole':           4,
  'half':            2,
  'half-dotted':     3,
  'quarter-triplet': 1 / 3,
  'quarter':         1,
  'quarter-dotted':  1.5,
  'eighth':          0.5,
  'eighth-dotted':   0.75,
  'sixteenth':       0.25,
  'thirty-second':   0.125,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function _uid() { return Date.now() + Math.random(); }

function _escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _measureBeats(ts) {
  const p = String(ts || '4/4').split('/');
  const n = parseInt(p[0]) || 4;
  const d = parseInt(p[1]) || 4;
  return n * (4 / d);
}

function _clefSign(clef) {
  if (clef === 'bass')  return 'F';
  if (clef === 'alto')  return 'C';
  if (clef === 'tenor') return 'C';
  return 'G';   // treble
}

function _clefLine(clef) {
  if (clef === 'treble') return 2;
  if (clef === 'bass')   return 4;
  if (clef === 'alto')   return 3;
  if (clef === 'tenor')  return 4;
  return 2;
}

function _fifthsToKey(fifths) {
  const map = {
    '0': 'C', '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B', '6': 'F#', '7': 'C#',
    '-1': 'F', '-2': 'Bb', '-3': 'Eb', '-4': 'Ab', '-5': 'Db', '-6': 'Gb', '-7': 'Cb'
  };
  return map[String(fifths)] || 'C';
}

function _keyToFifths(key) {
  // Prefer MusicEngine if loaded; fall back to embedded table
  const ks = (window.MusicEngine?.KEY_SIGS || {})[key];
  if (ks) {
    return ks.type === 'sharp' ? ks.count : ks.type === 'flat' ? -ks.count : 0;
  }
  const table = {
    'C':0,'G':1,'D':2,'A':3,'E':4,'B':5,'F#':6,'C#':7,
    'F':-1,'Bb':-2,'Eb':-3,'Ab':-4,'Db':-5,'Gb':-6,'Cb':-7
  };
  return table[key] ?? 0;
}

function _mxlToRymClef(sign, line) {
  if (sign === 'F') return 'bass';
  if (sign === 'C') return (line === '3') ? 'alto' : 'tenor';
  return 'treble';
}

/**
 * Map a GM MIDI program number (1-based, as written in MusicXML) to a
 * Rymspace category.  MIDI program numbers are a reliable, unambiguous
 * signal for instrument family that Audiveris always emits correctly
 * even when the instrument-name text defaults to "Piano" for everything.
 *
 * Reference: General MIDI Level 1 Sound Set (groups of 8 per family).
 */
function _categoryFromMidiProgram(prog) {
  const p = parseInt(prog, 10);
  if (!p || isNaN(p)) return null;
  if (p >= 1   && p <= 8)   return 'struck-strings';    // Piano family
  if (p >= 9   && p <= 16)  return 'metal-percussion';  // Chromatic perc (bells, vibraphone…)
  if (p >= 17  && p <= 24)  return 'sustained-keys';    // Organ family
  if (p >= 25  && p <= 32)  return 'plucked-strings';   // Guitar family
  if (p >= 33  && p <= 40)  return 'plucked-strings';   // Bass (fretted) — close enough for now
  if (p >= 41  && p <= 48)  return 'bowed-strings';     // Strings (violin, viola, cello…)
  if (p >= 49  && p <= 52)  return 'bowed-strings';     // Ensemble strings
  if (p >= 53  && p <= 55)  return 'bowed-strings';     // Choir / voice (no better fit)
  if (p >= 56  && p <= 64)  return 'brass';             // Brass family
  if (p >= 65  && p <= 72)  return 'reed-winds';        // Reed family (sax, oboe, bassoon…)
  if (p >= 73  && p <= 80)  return 'open-winds';        // Pipe family (flute, recorder…)
  if (p >= 81  && p <= 88)  return 'sustained-keys';    // Synth lead
  if (p >= 89  && p <= 96)  return 'sustained-keys';    // Synth pad
  if (p >= 97  && p <= 104) return 'sustained-keys';    // Synth effects
  if (p >= 105 && p <= 112) return 'plucked-strings';   // Ethnic (sitar, banjo, shamisen…)
  if (p >= 113 && p <= 120) return 'tuned-bars';        // Percussive (woodblock, agogo…)
  if (p >= 121 && p <= 128) return 'membrane-percussion'; // Sound effects / drums
  return null;
}

/**
 * Match a free-text instrument name (from a MusicXML <instrument-name> or
 * <part-name>) to one of Rymspace's v10 physics categories.
 *
 * v10 note: Rymspace no longer has a fixed list of ~25 instruments — a part
 * has a free-text display name plus one of ~10 "category" ids that select
 * the playback physics model. Imported MusicXML still uses real instrument
 * names, so this does two passes: first an exact/legacy-name match (for
 * files that came from Rymspace itself, or use standard instrument names),
 * then a looser keyword match against the category families themselves —
 * which is actually *more* forgiving than the old exact-name match, since
 * "Violin II", "2nd Violins", "Solo Viola" etc. all just need to contain a
 * recognizable string family keyword.
 */
function _matchCategory(name) {
  const lower = (name || '').toLowerCase();

  // Pass 1: legacy exact instrument names (covers Rymspace's own pre-v10
  // exports, and many standard MusicXML instrument-name conventions).
  const LEGACY = {
    piano:'struck-strings',
    guitar:'plucked-strings', banjo:'plucked-strings', ukulele:'plucked-strings', harp:'plucked-strings',
    violin:'bowed-strings', viola:'bowed-strings', cello:'bowed-strings', bass:'bowed-strings', contrabass:'bowed-strings',
    organ:'sustained-keys',
    flute:'open-winds', piccolo:'open-winds',
    clarinet:'reed-winds', oboe:'reed-winds', bassoon:'reed-winds', saxophone:'reed-winds', sax:'reed-winds',
    trumpet:'brass', horn:'brass', trombone:'brass', tuba:'brass', cornet:'brass', euphonium:'brass',
    marimba:'tuned-bars', xylophone:'tuned-bars', vibraphone:'tuned-bars',
    celesta:'metal-percussion', glockenspiel:'metal-percussion', 'bell':'metal-percussion',
    timpani:'membrane-percussion', drum:'membrane-percussion', drums:'membrane-percussion', percussion:'membrane-percussion'
  };
  for (const key in LEGACY) {
    if (lower.includes(key)) return LEGACY[key];
  }

  // Pass 2: broader family keywords, for names that don't match a specific
  // instrument but do name a family ("strings", "brass section", "winds").
  if (lower.includes('string')) return 'bowed-strings';
  if (lower.includes('brass'))  return 'brass';
  if (lower.includes('wind') || lower.includes('reed')) return 'reed-winds';
  if (lower.includes('key') || lower.includes('synth'))  return 'sustained-keys';

  return 'struck-strings';
}

// ─── Accidental-display bookkeeping ────────────────────────────────────────────
// A note's ACTUAL sounding pitch (used for <alter>) always comes straight
// from the event's own stored accidental — that's the single source of
// truth this app's own renderer (engine.js's VexFlow key-building) and
// playback both use. Whether to also print an <accidental> SYMBOL is a
// separate, purely-visual question, decided the way real engraving (and
// this app's own on-screen renderer, engine.js's resolveAccidental) does:
// show it only when it differs from whatever's currently "in force" for
// that letter within the measure, and carry the new value forward.

// Same cross-file top-level-const collision as MXL_DUR_BEATS above —
// engine.js declares its own KEY_SHARP_ORDER/KEY_FLAT_ORDER, and classic
// <script> tags share one lexical scope, so these need the MXL_ prefix too.
const MXL_KEY_SHARP_ORDER = ['F','C','G','D','A','E','B'];
const MXL_KEY_FLAT_ORDER  = ['B','E','A','D','G','C','F'];

function _keyAccidentalDefaults(key) {
  const state = { C:null, D:null, E:null, F:null, G:null, A:null, B:null };
  const fifths = _keyToFifths(key);
  if (!fifths) return state;
  const order = fifths > 0 ? MXL_KEY_SHARP_ORDER : MXL_KEY_FLAT_ORDER;
  const acc = fifths > 0 ? '#' : 'b';
  for (let i = 0; i < Math.abs(fifths); i++) state[order[i]] = acc;
  return state;
}

function _normAcc(a) { return a === '#' || a === 'b' ? a : null; }

function _newAccidentalCtx(key) {
  return { state: _keyAccidentalDefaults(key) };
}

/** Returns true if an <accidental> symbol should be printed for this
 *  pitch right now, and updates the running per-letter state either way. */
function _accidentalNeedsDisplay(ctx, pitchInfo) {
  const letter   = pitchInfo.pitch;
  const sounding = _normAcc(pitchInfo.accidental ?? pitchInfo.acc ?? null);
  const inForce  = Object.prototype.hasOwnProperty.call(ctx.state, letter) ? ctx.state[letter] : null;
  const needed   = sounding !== (inForce ?? null);
  ctx.state[letter] = sounding;
  return needed;
}

// ─── Chord pitch ordering (standalone chroma calc — mirrors engine.js's
//     noteToChrom without depending on it being loaded) ────────────────────────

const _CHROM_VAL = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

function _chromOf(pi) {
  const alt = pi.accidental === '#' ? 1 : pi.accidental === 'b' ? -1 : 0;
  return (pi.octave ?? 4) * 12 + (_CHROM_VAL[pi.pitch] ?? 0) + alt;
}

// ─── Nav-mark label table (shared by export + import) ──────────────────────────

const NAV_LABELS = {
  'fine':       'Fine',
  'ds-al-coda': 'D.S. al Coda',
  'dc-al-capo': 'D.C. al Capo',
  'ds-al-fine': 'D.S. al Fine',
  'dc-al-fine': 'D.C. al Fine'
};
const NAV_LABELS_REV = Object.fromEntries(Object.entries(NAV_LABELS).map(([k, v]) => [v, k]));

// <sound> attributes give a nav mark real jump semantics for any
// MusicXML-compliant reader, on top of the plain display text.
const NAV_SOUND_ATTR = {
  'fine':       'fine="yes"',
  'dc-al-capo': 'dacapo="yes"',
  'dc-al-fine': 'dacapo="yes"',
  'ds-al-coda': 'dalsegno="segno1"',
  'ds-al-fine': 'dalsegno="segno1"',
};

// ─── Export helpers ────────────────────────────────────────────────────────────

/**
 * Flatten the notes[] array of a part into an array of "measure objects" that
 * the exporter can iterate over.  Attribute changes (clef/key/timesig) are
 * applied immediately at the point they occur (matching the on-screen
 * renderer) and left as inline markers in the event stream so a fresh
 * <attributes> block can be emitted mid-measure if needed. Repeat barlines
 * always force a real measure boundary, exactly where they were typed —
 * mirroring engine.js's buildMeasures, and required for a repeat barline
 * to be valid MusicXML (barlines ARE measure boundaries there).
 *
 * Returns: Array<{
 *   number,
 *   startClef, startKey, startTimeSig,   // state in effect at measure start
 *   events: [ note/rest/mark/attr-change tokens ]
 * }>
 */
function _buildExportMeasures(part) {
  const EPS = 1e-9;
  const notes = part.notes || [];

  const measures = [];
  let beat       = 0;
  let curClef    = part.clef    || 'treble';
  let curKey     = part.key     || 'C';
  let curTimeSig = part.timeSig || '4/4';
  let cap        = _measureBeats(curTimeSig);

  function pushMeasure() {
    const m = {
      number: measures.length + 1,
      startClef: curClef, startKey: curKey, startTimeSig: curTimeSig,
      events: []
    };
    cap  = _measureBeats(curTimeSig);
    beat = 0;
    measures.push(m);
    return m;
  }

  function curHasNotes(m) {
    return m.events.some(e => e.type === 'note' || e.type === 'rest');
  }

  let cur = pushMeasure();

  for (const ev of notes) {
    // ── Attribute changes — applied immediately, marker left inline ──
    if (ev.type === 'clef')    { curClef    = ev.clef;    cur.events.push({ ...ev, _attrChange: true }); continue; }
    if (ev.type === 'key')     { curKey     = ev.key;     cur.events.push({ ...ev, _attrChange: true }); continue; }
    if (ev.type === 'timesig') { curTimeSig = ev.timesig; cap = _measureBeats(curTimeSig); cur.events.push({ ...ev, _attrChange: true }); continue; }

    // ── Repeat barlines — always a real measure boundary ─────────────
    if (ev.type === 'repeat') {
      if (ev.direction === 'end') {
        const freshEmpty = beat <= EPS && !curHasNotes(cur) && measures.length > 0;
        if (freshEmpty) {
          measures[measures.length - 1].events.push(ev);
        } else {
          cur.events.push(ev);
          cur = pushMeasure();
        }
      } else { // 'start'
        const curIsFreshEmpty = beat <= EPS && !curHasNotes(cur);
        if (!curIsFreshEmpty) cur = pushMeasure();
        cur.events.push(ev);
      }
      continue;
    }

    // ── Decorations (dynamics/text/rehearsal/pedal/segno/coda/nav) ───
    if (ev.type === 'dynamic' || ev.type === 'text-mark' || ev.type === 'text' ||
        ev.type === 'rehearsal' || ev.type === 'pedal' ||
        ev.type === 'segno' || ev.type === 'coda' || ev.type === 'nav') {
      cur.events.push(ev);
      continue;
    }

    if (ev.type !== 'note' && ev.type !== 'rest') continue;

    // ── Sounding events — may need a new measure ──────────────────
    const b = MXL_DUR_BEATS[ev.duration] ?? 0;

    if (beat > EPS && beat + b > cap + EPS) {
      cur = pushMeasure();
    }

    cur.events.push(ev);
    beat += b;

    if (Math.abs(beat - cap) < EPS) {
      cur = pushMeasure();
    }
  }

  if (cur.events.length === 0 && measures.length > 1) measures.pop();
  if (measures.length === 0) {
    measures.push({ number: 1, startClef: curClef, startKey: curKey, startTimeSig: curTimeSig, events: [] });
  }

  return measures;
}

/**
 * Assign MusicXML slur start/stop numbers to every note event referenced
 * by part.slurs[], reusing numbers once a slur closes (standard practice —
 * MusicXML numbers distinguish only CONCURRENTLY open slurs).
 * Returns Map<noteId, {starts:number[], stops:number[]}>.
 */
function _computeSlurLayout(part) {
  const layout = new Map();
  const slursRaw = part.slurs || [];
  if (!slursRaw.length) return layout;

  const notesOnly = (part.notes || []).filter(n => n.type === 'note');
  const idxOf = id => notesOnly.findIndex(n => n._id === id);

  const slurs = slursRaw
    .map(s => ({ fromId: s.fromId, toId: s.toId, startIdx: idxOf(s.fromId), endIdx: idxOf(s.toId) }))
    .filter(s => s.startIdx !== -1 && s.endIdx !== -1 && s.startIdx < s.endIdx);
  if (!slurs.length) return layout;

  slurs.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);

  const events = [];
  slurs.forEach((s, i) => {
    events.push({ pos: s.startIdx, isStart: true,  i });
    events.push({ pos: s.endIdx,   isStart: false, i });
  });
  // At equal positions, close finishing slurs before opening new ones so a
  // number frees up in time to be reused at the same index if needed.
  events.sort((a, b) => a.pos - b.pos || (a.isStart === b.isStart ? 0 : a.isStart ? 1 : -1));

  const freeNums = [1, 2, 3, 4, 5, 6];
  const numOf = new Map();

  function ensure(id) {
    if (!layout.has(id)) layout.set(id, { starts: [], stops: [] });
    return layout.get(id);
  }

  events.forEach(e => {
    const s = slurs[e.i];
    if (e.isStart) {
      const num = freeNums.length ? freeNums.shift() : 1;
      numOf.set(e.i, num);
      ensure(s.fromId).starts.push(num);
    } else {
      const num = numOf.get(e.i) || 1;
      ensure(s.toId).stops.push(num);
      if (freeNums.indexOf(num) === -1) { freeNums.push(num); freeNums.sort((a, b) => a - b); }
    }
  });

  return layout;
}

/**
 * Pre-compute valid tie start/stop pairs across a part's whole note stream.
 * Convention (matches engine.js's on-screen renderer): ev.tie === true means
 * this note ties FORWARD into the very next note/rest event, and the tie
 * only actually connects if that next event is a NOTE of the same
 * pitch+octave — an intervening rest, or a pitch mismatch, silently breaks
 * it, exactly as the renderer already treats it.
 * Returns { starts:Set<noteId>, stops:Set<noteId> }.
 */
function _computeTieLinks(part) {
  const starts = new Set();
  const stops  = new Set();
  const stream = (part.notes || []).filter(ev => ev.type === 'note' || ev.type === 'rest');

  for (let i = 0; i < stream.length; i++) {
    const ev = stream[i];
    if (ev.type !== 'note' || !ev.tie) continue;
    const next = stream[i + 1];
    if (!next || next.type !== 'note') continue;
    const p0 = (Array.isArray(ev.pitches)   && ev.pitches[0])   || { pitch: ev.pitch,   octave: ev.octave };
    const n0 = (Array.isArray(next.pitches) && next.pitches[0]) || { pitch: next.pitch, octave: next.octave };
    if (p0.pitch === n0.pitch && p0.octave === n0.octave) {
      starts.add(ev._id);
      stops.add(next._id);
    }
  }

  return { starts, stops };
}

function _pitchToXmlLines(pi, indent) {
  const alter = pi.accidental === '#' ? 1 : pi.accidental === 'b' ? -1 : null;
  const lines = [`${indent}<pitch>`, `${indent}  <step>${pi.pitch}</step>`];
  if (alter !== null) lines.push(`${indent}  <alter>${alter}</alter>`);
  lines.push(`${indent}  <octave>${pi.octave}</octave>`);
  lines.push(`${indent}</pitch>`);
  return lines;
}

/**
 * Serialize a single note/rest event to MusicXML lines — including every
 * pitch of a chord (as <chord/>-linked <note> siblings), ties, slurs,
 * articulations, fermata, trill, tremolo, and the note-level dynamic.
 * Only the FIRST (primary) pitch of a chord carries notations —
 * articulations/fermata/ornaments/slurs/dynamics — matching both standard
 * engraving practice and this app's own renderer, which only ever draws
 * those on a chord's first notehead.
 */
function _noteEventToXmlLines(ev, indent, slurLayout, tieLinks, accCtx) {
  const I  = indent;
  const I2 = indent + '  ';
  const lines = [];
  const isRest    = ev.type === 'rest';
  const dur       = ev.duration || 'quarter';
  const divs      = RYM_TO_MXL_DIVS[dur] ?? 8;
  const mxlType   = RYM_TO_MXL_TYPE[dur] || 'quarter';
  const isDotted  = dur.endsWith('-dotted');
  const isTriplet = dur.includes('triplet');

  function durLines(target) {
    target.push(`${I2}<duration>${divs}</duration>`);
  }
  function typeLines(target) {
    target.push(`${I2}<type>${mxlType}</type>`);
    if (isDotted) target.push(`${I2}<dot/>`);
    if (isTriplet) {
      target.push(`${I2}<time-modification>`);
      target.push(`${I2}  <actual-notes>3</actual-notes>`);
      target.push(`${I2}  <normal-notes>2</normal-notes>`);
      target.push(`${I2}</time-modification>`);
    }
  }

  if (isRest) {
    lines.push(`${I}<note>`);
    lines.push(`${I2}<rest/>`);
    durLines(lines);
    typeLines(lines);
    lines.push(`${I}</note>`);
    return lines;
  }

  const pitches = Array.isArray(ev.pitches) && ev.pitches.length
    ? ev.pitches
    : [{ pitch: ev.pitch || 'C', accidental: ev.accidental ?? ev.acc ?? null, octave: ev.octave ?? 4 }];

  const slur     = slurLayout.get(ev._id) || { starts: [], stops: [] };
  const tieStart = tieLinks.starts.has(ev._id);
  const tieStop  = tieLinks.stops.has(ev._id);

  pitches.forEach((pi, pIdx) => {
    const isPrimary = pIdx === 0;
    lines.push(`${I}<note>`);
    if (!isPrimary) lines.push(`${I2}<chord/>`);
    lines.push(..._pitchToXmlLines(pi, I2));
    durLines(lines);

    // Tie applies to the whole chord (this app tracks tie as a single
    // per-event flag, not per pitch) — every pitch gets the same state.
    if (tieStop)  lines.push(`${I2}<tie type="stop"/>`);
    if (tieStart) lines.push(`${I2}<tie type="start"/>`);

    typeLines(lines);

    const show = _accidentalNeedsDisplay(accCtx, pi);
    if (show) {
      const accType = pi.accidental === '#' ? 'sharp' : pi.accidental === 'b' ? 'flat' : 'natural';
      lines.push(`${I2}<accidental>${accType}</accidental>`);
    }

    const notLines = [];
    if (isPrimary) {
      if (tieStop)  notLines.push(`${I2}  <tied type="stop"/>`);
      if (tieStart) notLines.push(`${I2}  <tied type="start"/>`);

      slur.stops.forEach(n  => notLines.push(`${I2}  <slur type="stop" number="${n}"/>`));
      slur.starts.forEach(n => notLines.push(`${I2}  <slur type="start" number="${n}"/>`));

      const arts = ev.articulations || [];
      const artLines = [];
      if (ev.staccato || arts.includes('staccato')) artLines.push('<staccato/>');
      if (arts.includes('accent'))  artLines.push('<accent/>');
      if (arts.includes('tenuto'))  artLines.push('<tenuto/>');
      if (arts.includes('marcato')) artLines.push('<strong-accent type="up"/>');
      if (artLines.length) notLines.push(`${I2}  <articulations>${artLines.join('')}</articulations>`);

      if (arts.includes('fermata')) notLines.push(`${I2}  <fermata type="upright"/>`);

      const ornLines = [];
      if (arts.includes('trill')) ornLines.push('<trill-mark/>');
      if (ev.tremolo) ornLines.push(`<tremolo type="single">${ev.tremolo}</tremolo>`);
      if (ornLines.length) notLines.push(`${I2}  <ornaments>${ornLines.join('')}</ornaments>`);

      if (ev.dynamic) notLines.push(`${I2}  <dynamics><${_escXml(ev.dynamic)}/></dynamics>`);
    }

    if (notLines.length) {
      lines.push(`${I2}<notations>`);
      lines.push(...notLines);
      lines.push(`${I2}</notations>`);
    }

    lines.push(`${I}</note>`);
  });

  return lines;
}

/** Serialize a <direction> dynamic marking. */
function _dynamicToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  return [
    `${I}<direction placement="below">`,
    `${I2}<direction-type>`,
    `${I2}  <dynamics><${_escXml(ev.dynamic)}/></dynamics>`,
    `${I2}</direction-type>`,
    `${I}</direction>`,
  ];
}

/** Serialize a tempo / expression text direction.
 *  Placement encodes subtype so import (which classifies subtype FROM
 *  placement) round-trips correctly — "above" ⇄ tempo, "below" ⇄
 *  expression. Previously this always wrote "above", which silently
 *  turned every expression mark (pizz., con sord., dolce, ...) into a
 *  tempo marking on any export→import cycle. */
function _textMarkToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  const placement = ev.subtype === 'tempo' ? 'above' : 'below';
  return [
    `${I}<direction placement="${placement}">`,
    `${I2}<direction-type>`,
    `${I2}  <words font-style="italic">${_escXml(ev.text)}</words>`,
    `${I2}</direction-type>`,
    `${I}</direction>`,
  ];
}

/** Serialize a plain text token — currently only produced by
 *  insertCapo() (type:'text'). Previously not exported at all because
 *  export only checked for type:'text-mark'. */
function _plainTextToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  return [
    `${I}<direction placement="above">`,
    `${I2}<direction-type>`,
    `${I2}  <words>${_escXml(ev.text || '')}</words>`,
    `${I2}</direction-type>`,
    `${I}</direction>`,
  ];
}

function _rehearsalToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  return [
    `${I}<direction placement="above">`,
    `${I2}<direction-type>`,
    `${I2}  <rehearsal>${_escXml(ev.label || '')}</rehearsal>`,
    `${I2}</direction-type>`,
    `${I}</direction>`,
  ];
}

function _segnoToXmlLines(indent) {
  const I  = indent;
  const I2 = indent + '  ';
  return [
    `${I}<direction placement="above">`,
    `${I2}<direction-type><segno/></direction-type>`,
    `${I2}<sound segno="segno1"/>`,
    `${I}</direction>`,
  ];
}

function _codaToXmlLines(indent) {
  const I  = indent;
  const I2 = indent + '  ';
  return [
    `${I}<direction placement="above">`,
    `${I2}<direction-type><coda/></direction-type>`,
    `${I2}<sound coda="coda1"/>`,
    `${I}</direction>`,
  ];
}

function _navToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  const label     = NAV_LABELS[ev.nav] || ev.nav || '';
  const soundAttr = NAV_SOUND_ATTR[ev.nav];
  const out = [
    `${I}<direction placement="above">`,
    `${I2}<direction-type>`,
    `${I2}  <words>${_escXml(label)}</words>`,
    `${I2}</direction-type>`,
  ];
  if (soundAttr) out.push(`${I2}<sound ${soundAttr}/>`);
  out.push(`${I}</direction>`);
  return out;
}

function _pedalToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  const type = ev.pedal === 'down' ? 'start' : 'stop';
  return [
    `${I}<direction placement="below">`,
    `${I2}<direction-type>`,
    `${I2}  <pedal type="${type}" line="yes"/>`,
    `${I2}</direction-type>`,
    `${I}</direction>`,
  ];
}

/** Serialize a repeat barline. */
function _repeatToXmlLines(ev, indent) {
  const I  = indent;
  const isStart = ev.direction === 'start';
  return [
    `${I}<barline location="${isStart ? 'left' : 'right'}">`,
    `${I}  <bar-style>light-heavy</bar-style>`,
    `${I}  <repeat direction="${isStart ? 'forward' : 'backward'}"/>`,
    `${I}</barline>`,
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a Rymspace parts array to a MusicXML string.
 *
 * @param {Array}  parts  - The Rymspace `parts` array from app.js
 * @param {string} title  - Composition title
 * @returns {string}       MusicXML document
 */
function exportMusicXML(parts, title) {
  const lines = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC');
  lines.push('  "-//Recordare//DTD MusicXML 4.0 Partwise//EN"');
  lines.push('  "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');

  // ── Work / Identification ──────────────────────────────────────────
  lines.push('  <work>');
  lines.push(`    <work-title>${_escXml(title || 'Untitled')}</work-title>`);
  lines.push('  </work>');
  lines.push('  <identification>');
  lines.push('    <encoding>');
  lines.push('      <software>Rymspace</software>');
  lines.push('    </encoding>');
  lines.push('  </identification>');

  // ── Part list ──────────────────────────────────────────────────────
  lines.push('  <part-list>');
  parts.forEach((p, i) => {
    const pid = `P${i + 1}`;
    lines.push(`    <score-part id="${pid}">`);
    lines.push(`      <part-name>${_escXml(p.name)}</part-name>`);
    lines.push(`      <score-instrument id="${pid}-I1">`);
    lines.push(`        <instrument-name>${_escXml(p.name)}</instrument-name>`);
    lines.push(`      </score-instrument>`);
    lines.push(`    </score-part>`);
  });
  lines.push('  </part-list>');

  // ── Parts ──────────────────────────────────────────────────────────
  parts.forEach((p, i) => {
    const pid = `P${i + 1}`;
    lines.push(`  <part id="${pid}">`);

    const measures   = _buildExportMeasures(p);
    const slurLayout = _computeSlurLayout(p);
    const tieLinks   = _computeTieLinks(p);

    let prevClef = null, prevKey = null, prevTimeSig = null;

    measures.forEach(m => {
      lines.push(`    <measure number="${m.number}">`);

      const needAttrs = m.number === 1 ||
        m.startClef !== prevClef || m.startKey !== prevKey || m.startTimeSig !== prevTimeSig;

      if (needAttrs) {
        lines.push('      <attributes>');
        lines.push(`        <divisions>${DIVISIONS}</divisions>`);
        if (m.number === 1 || m.startKey !== prevKey) {
          lines.push(`        <key><fifths>${_keyToFifths(m.startKey)}</fifths></key>`);
        }
        if (m.number === 1 || m.startTimeSig !== prevTimeSig) {
          const [tsNum, tsDen] = (m.startTimeSig || '4/4').split('/');
          lines.push(`        <time>`);
          lines.push(`          <beats>${tsNum}</beats>`);
          lines.push(`          <beat-type>${tsDen}</beat-type>`);
          lines.push(`        </time>`);
        }
        if (m.number === 1 || m.startClef !== prevClef) {
          lines.push(`        <clef>`);
          lines.push(`          <sign>${_clefSign(m.startClef)}</sign>`);
          lines.push(`          <line>${_clefLine(m.startClef)}</line>`);
          lines.push(`        </clef>`);
        }
        lines.push('      </attributes>');
      }

      // Fresh per-measure accidental-carry state, reseeded on any
      // mid-measure key change too (see the _attrChange branch below).
      let accCtx = _newAccidentalCtx(m.startKey);
      let runClef = m.startClef, runKey = m.startKey, runTimeSig = m.startTimeSig;

      m.events.forEach(ev => {
        if (ev._attrChange) {
          lines.push('      <attributes>');
          lines.push(`        <divisions>${DIVISIONS}</divisions>`);
          if (ev.type === 'key') {
            lines.push(`        <key><fifths>${_keyToFifths(ev.key)}</fifths></key>`);
            accCtx = _newAccidentalCtx(ev.key);
            runKey = ev.key;
          } else if (ev.type === 'timesig') {
            const [tsNum, tsDen] = (ev.timesig || '4/4').split('/');
            lines.push(`        <time><beats>${tsNum}</beats><beat-type>${tsDen}</beat-type></time>`);
            runTimeSig = ev.timesig;
          } else if (ev.type === 'clef') {
            lines.push(`        <clef><sign>${_clefSign(ev.clef)}</sign><line>${_clefLine(ev.clef)}</line></clef>`);
            runClef = ev.clef;
          }
          lines.push('      </attributes>');
          return;
        }

        if (ev.type === 'note' || ev.type === 'rest') {
          lines.push(..._noteEventToXmlLines(ev, '      ', slurLayout, tieLinks, accCtx));
        } else if (ev.type === 'dynamic') {
          lines.push(..._dynamicToXmlLines(ev, '      '));
        } else if (ev.type === 'text-mark') {
          lines.push(..._textMarkToXmlLines(ev, '      '));
        } else if (ev.type === 'text') {
          lines.push(..._plainTextToXmlLines(ev, '      '));
        } else if (ev.type === 'rehearsal') {
          lines.push(..._rehearsalToXmlLines(ev, '      '));
        } else if (ev.type === 'segno') {
          lines.push(..._segnoToXmlLines('      '));
        } else if (ev.type === 'coda') {
          lines.push(..._codaToXmlLines('      '));
        } else if (ev.type === 'nav') {
          lines.push(..._navToXmlLines(ev, '      '));
        } else if (ev.type === 'pedal') {
          lines.push(..._pedalToXmlLines(ev, '      '));
        } else if (ev.type === 'repeat') {
          lines.push(..._repeatToXmlLines(ev, '      '));
        }
      });

      lines.push('    </measure>');
      prevClef = runClef; prevKey = runKey; prevTimeSig = runTimeSig;
    });

    lines.push('  </part>');
  });

  lines.push('</score-partwise>');
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a MusicXML string and return a Rymspace score object.
 *
 * @param {string} xmlString  Raw MusicXML text
 * @returns {{ title: string, parts: Array }}
 * @throws {Error} on parse failure or unsupported format
 */
function importMusicXML(xmlString) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlString, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('MusicXML parse error: ' + parseError.textContent.slice(0, 200));

  if (!doc.querySelector('score-partwise')) {
    throw new Error('Only score-partwise MusicXML is supported. (Score-timewise requires pre-conversion.)');
  }

  // ── Title ──────────────────────────────────────────────────────────
  const title = doc.querySelector('work-title, movement-title')?.textContent?.trim() || '';

  // ── Part metadata ──────────────────────────────────────────────────
  const scorePartEls = [...doc.querySelectorAll('part-list > score-part')];
  const partEls      = [...doc.querySelectorAll('score-partwise > part')];

  const parts = partEls.map((partEl, i) => {
    const pid       = partEl.getAttribute('id') || `P${i + 1}`;
    const scorePart = scorePartEls.find(sp => sp.getAttribute('id') === pid) || scorePartEls[i];
    const partName  = scorePart?.querySelector('part-name')?.textContent?.trim() || `Part ${i + 1}`;
    const instrEl   = scorePart?.querySelector('instrument-name');
    const instrName = instrEl?.textContent?.trim() || partName || 'Piano';

    // MIDI program number is the most reliable instrument-family signal:
    // Audiveris always emits the correct GM program even when it leaves
    // the instrument-name text as "Piano" for everything.  Try it first;
    // fall back to the text-match helper only when absent.
    const midiProgEl = scorePart?.querySelector('midi-instrument > midi-program');
    const category   =
      _categoryFromMidiProgram(midiProgEl?.textContent) ||
      _matchCategory(instrName) ||
      _matchCategory(partName);

    const notes    = [];   // flat Rymspace event array
    const slurs    = [];   // { fromId, toId }
    const openSlurs = {};  // slur-number → startNoteId, for tracking open slurs across notes

    // Running state — updated by <attributes> inside each measure
    let divisions = 1;
    let clef      = 'treble';
    let key       = 'C';
    let timeSig   = '4/4';

    // Tracks the clef/key/timeSig at entry of part so we can return it
    let initialClef    = null;
    let initialKey     = null;
    let initialTimeSig = null;

    // Chord grouping: a <chord/> note extends the immediately preceding
    // note event with an extra pitch instead of starting a new one.
    let pendingChordHead = null;

    const measureEls = [...partEl.querySelectorAll('measure')];

    measureEls.forEach((mEl) => {

      // A single pass over this measure's DIRECT CHILDREN, in document
      // order, dispatching by tag name — NOT separate querySelectorAll
      // sweeps per tag (attributes/direction/barline/note). Four separate
      // sweeps is what the previous version of this file did, and it's a
      // real correctness bug: it collapses every mark in a measure to
      // "before all its notes" regardless of where they actually sit
      // relative to each other, so e.g. a tempo change written AFTER the
      // first note of a measure would silently jump to the front of the
      // measure on import. A single in-order pass is what makes an
      // export → import → export round trip reproduce the identical file,
      // including relative placement of marks between notes.
      [...mEl.children].forEach(child => {
        const tag = child.tagName;

        // ── <attributes> ────────────────────────────────────────────
        // A measure can legally contain more than one of these (a
        // mid-measure clef/key/time change) — each one encountered here
        // is applied in place, matching the on-screen renderer.
        if (tag === 'attributes') {
          const divEl = child.querySelector('divisions');
          if (divEl) divisions = parseInt(divEl.textContent) || 1;

          const fifthsEl = child.querySelector('key > fifths');
          if (fifthsEl) {
            const newKey = _fifthsToKey(parseInt(fifthsEl.textContent) || 0);
            if (initialKey === null) { key = newKey; initialKey = newKey; }
            else if (newKey !== key) { notes.push({ _id: _uid(), type: 'key', key: newKey }); key = newKey; }
          }

          const beatsEl    = child.querySelector('time > beats');
          const beatTypeEl = child.querySelector('time > beat-type');
          if (beatsEl && beatTypeEl) {
            const newTS = `${beatsEl.textContent.trim()}/${beatTypeEl.textContent.trim()}`;
            if (initialTimeSig === null) { timeSig = newTS; initialTimeSig = newTS; }
            else if (newTS !== timeSig) { notes.push({ _id: _uid(), type: 'timesig', timesig: newTS }); timeSig = newTS; }
          }

          const clefSignEl = child.querySelector('clef > sign');
          const clefLineEl = child.querySelector('clef > line');
          if (clefSignEl) {
            const newClef = _mxlToRymClef(clefSignEl.textContent.toUpperCase(), clefLineEl?.textContent?.trim());
            if (initialClef === null) { clef = newClef; initialClef = newClef; }
            else if (newClef !== clef) { notes.push({ _id: _uid(), type: 'clef', clef: newClef }); clef = newClef; }
          }
          return;
        }

        // ── <direction> ─────────────────────────────────────────────
        if (tag === 'direction') {
          // Dynamics (standalone — a swatch inserted between notes)
          const dynEl = child.querySelector('dynamics');
          if (dynEl?.firstElementChild) {
            notes.push({ _id: _uid(), type: 'dynamic', dynamic: dynEl.firstElementChild.tagName });
            return;
          }

          // Rehearsal marks — dedicated element, not text.
          const rehearsalEl = child.querySelector('direction-type > rehearsal');
          if (rehearsalEl) {
            notes.push({ _id: _uid(), type: 'rehearsal', label: rehearsalEl.textContent.trim() });
            return;
          }

          // Segno / Coda — dedicated elements.
          if (child.querySelector('direction-type > segno')) {
            notes.push({ _id: _uid(), type: 'segno' });
            return;
          }
          if (child.querySelector('direction-type > coda')) {
            notes.push({ _id: _uid(), type: 'coda' });
            return;
          }

          // Pedal — dedicated element.
          const pedalEl = child.querySelector('direction-type > pedal');
          if (pedalEl) {
            const pType = pedalEl.getAttribute('type');
            notes.push({ _id: _uid(), type: 'pedal', pedal: (pType === 'stop') ? 'up' : 'down' });
            return;
          }

          // Words: could be a nav mark (Fine / D.S. al Coda / …), a Capo
          // marking, a tempo text, or a general expression text — checked
          // in that order, since nav-mark and Capo text are both
          // recognized by exact shape; anything else falls back to the
          // placement-based tempo/expression split (see
          // _textMarkToXmlLines for the matching export-side convention).
          const wordsEl = child.querySelector('direction-type > words');
          if (wordsEl) {
            const text = wordsEl.textContent.trim();

            if (NAV_LABELS_REV[text]) {
              notes.push({ _id: _uid(), type: 'nav', nav: NAV_LABELS_REV[text] });
              return;
            }
            if (/^Capo\s+\d+$/i.test(text)) {
              notes.push({ _id: _uid(), type: 'text', text, subtype: 'expression' });
              return;
            }

            const placement = child.getAttribute('placement') || 'above';
            const subtype   = placement === 'above' ? 'tempo' : 'expression';
            notes.push({ _id: _uid(), type: 'text-mark', text, subtype });
          }
          return;
        }

        // ── <barline> (repeats) ─────────────────────────────────────
        if (tag === 'barline') {
          const repeatEl = child.querySelector('repeat');
          if (repeatEl) {
            const dir = repeatEl.getAttribute('direction') === 'forward' ? 'start' : 'end';
            notes.push({ _id: _uid(), type: 'repeat', direction: dir });
          }
          return;
        }

        // ── <note> ───────────────────────────────────────────────────
        if (tag === 'note') {
          const nEl     = child;
          const isRest  = !!nEl.querySelector('rest');
          const isChord = !!nEl.querySelector('chord');
          const typeEl  = nEl.querySelector('type');
          const dotEls  = nEl.querySelectorAll('dot');
          const timeMod = nEl.querySelector('time-modification');

          // A <chord/> note is an EXTRA pitch on the previous note event,
          // not a new rhythmic event — merge it in and stop.
          if (isChord && !isRest && pendingChordHead) {
            const pitch  = nEl.querySelector('pitch > step')?.textContent?.trim() || 'C';
            const octave = parseInt(nEl.querySelector('pitch > octave')?.textContent) || 4;
            const alter  = parseFloat(nEl.querySelector('pitch > alter')?.textContent || '0');
            const accidental  = alter === 1 ? '#' : alter === -1 ? 'b' : null;
            const accExplicit = !!nEl.querySelector('accidental');
            pendingChordHead.pitches.push({ pitch, accidental, octave, accExplicit });
            return;
          }

          const isTriplet = timeMod
            && parseInt(timeMod.querySelector('actual-notes')?.textContent) === 3
            && parseInt(timeMod.querySelector('normal-notes')?.textContent)  === 2;

          const mxlType = typeEl?.textContent?.trim() || 'quarter';
          let rymDur    = MXL_TYPE_TO_RYM[mxlType] || 'quarter';

          if (isTriplet && rymDur === 'quarter') {
            rymDur = 'quarter-triplet';
          } else if (dotEls.length > 0) {
            const dotted = rymDur + '-dotted';
            if (MXL_DUR_BEATS[dotted] !== undefined) rymDur = dotted;
          }

          const ev = {
            _id:      _uid(),
            type:     isRest ? 'rest' : 'note',
            duration: rymDur,
          };

          if (!isRest) {
            const pitch  = nEl.querySelector('pitch > step')?.textContent?.trim() || 'C';
            const octave = parseInt(nEl.querySelector('pitch > octave')?.textContent) || 4;
            const alter  = parseFloat(nEl.querySelector('pitch > alter')?.textContent || '0');
            const accidental  = alter === 1 ? '#' : alter === -1 ? 'b' : null;
            const accExplicit = !!nEl.querySelector('accidental');

            ev.pitch  = pitch;
            ev.octave = octave;
            ev.accidental = accidental;
            if (accExplicit) ev.accExplicit = true;
            ev.pitches = [{ pitch, accidental, octave, accExplicit }];

            // Tie: only a <tie type="start"/> sets our tie flag — matching
            // the export convention (ev.tie === true → ties FORWARD into
            // the next matching note). A stop-only tie (the second half
            // of a pair) needs no flag on this side; it's implied by the
            // previous note's start.
            const tieStartEl = [...nEl.querySelectorAll('tie')].find(t => t.getAttribute('type') === 'start');
            if (tieStartEl) ev.tie = true;

            const notationsEl = nEl.querySelector('notations');
            if (notationsEl) {
              const arts = [];
              if (notationsEl.querySelector('articulations staccato'))           arts.push('staccato');
              if (notationsEl.querySelector('articulations accent'))             arts.push('accent');
              if (notationsEl.querySelector('articulations tenuto'))             arts.push('tenuto');
              if (notationsEl.querySelector('articulations strong-accent'))      arts.push('marcato');
              if (notationsEl.querySelector('fermata'))                         arts.push('fermata');
              if (notationsEl.querySelector('ornaments trill-mark'))            arts.push('trill');
              if (arts.length) ev.articulations = arts;

              const tremEl = notationsEl.querySelector('ornaments tremolo');
              if (tremEl) ev.tremolo = parseInt(tremEl.textContent) || 1;

              notationsEl.querySelectorAll('slur').forEach(slurEl => {
                const slurType = slurEl.getAttribute('type');
                const slurNum  = slurEl.getAttribute('number') || '1';
                if (slurType === 'start') {
                  openSlurs[slurNum] = ev._id;
                } else if (slurType === 'stop' && openSlurs[slurNum]) {
                  slurs.push({ fromId: openSlurs[slurNum], toId: ev._id });
                  delete openSlurs[slurNum];
                }
              });

              const notedDynEl = notationsEl.querySelector('dynamics');
              if (notedDynEl?.firstElementChild) ev.dynamic = notedDynEl.firstElementChild.tagName;
            }

            // Fallback for a stray note-level <dynamics> not nested
            // inside <notations> (invalid per-schema, but tolerate other
            // tools' output defensively).
            if (!ev.dynamic) {
              const looseDynEl = nEl.querySelector('dynamics');
              if (looseDynEl?.firstElementChild) ev.dynamic = looseDynEl.firstElementChild.tagName;
            }
          }

          notes.push(ev);
          pendingChordHead = isRest ? null : ev;
        }
      });
    });

    // Normalize chord pitch order (ascending) and keep the primary
    // pitch/octave/accidental fields in sync with pitches[0] — matches
    // the invariant the editor itself maintains (app.js's chordAddPitch()
    // keeps pitches[] sorted ascending after every chord edit).
    notes.forEach(ev => {
      if (ev.type !== 'note' || !Array.isArray(ev.pitches) || !ev.pitches.length) return;
      if (ev.pitches.length > 1) ev.pitches.sort((a, b) => _chromOf(a) - _chromOf(b));
      const p0 = ev.pitches[0];
      ev.pitch = p0.pitch; ev.octave = p0.octave; ev.accidental = p0.accidental;
      ev.accExplicit = !!p0.accExplicit;
    });

    return {
      id:          i + 1,
      name:        partName,
      category,
      clef:        initialClef    ?? clef,
      key:         initialKey     ?? key,
      timeSig:     initialTimeSig ?? timeSig,
      cursor:      notes.length,
      notes,
      slurs,
      hairpins:    [],
      accidentals: {},
    };
  });

  return { title, parts };
}

// ─── Public API ────────────────────────────────────────────────────────────────

window.MusicXML = { exportMusicXML, importMusicXML };