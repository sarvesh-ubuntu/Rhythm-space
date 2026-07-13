/**
 * Rymspace — MusicXML Import / Export
 * musicxml.js
 *
 * Depends on: nothing (standalone; reads window.MusicEngine.KEY_SIGS if available)
 *
 * Usage:
 *   window.MusicXML.exportMusicXML(parts, title)  → XML string
 *   window.MusicXML.importMusicXML(xmlString)      → { title, parts }
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
const DUR_BEATS = {
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

// ─── Export helpers ────────────────────────────────────────────────────────────

/**
 * Flatten the notes[] array of a part into an array of "measure objects" that
 * the exporter can iterate over.  Attribute changes (clef, key, timesig) that
 * occur mid-stream are tracked so the correct <attributes> block is emitted at
 * the start of each measure.
 *
 * Returns: Array<{
 *   number,
 *   clef, key, timeSig,
 *   clefChanged, keyChanged, timeSigChanged,
 *   events: [ note/rest/dynamic/repeat tokens ]
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

  // Pending attribute changes that should appear at the start of the NEXT measure
  let pendingClef    = null;
  let pendingKey     = null;
  let pendingTimeSig = null;

  function pushMeasure() {
    const m = {
      number:        measures.length + 1,
      clef:          pendingClef    ?? curClef,
      key:           pendingKey     ?? curKey,
      timeSig:       pendingTimeSig ?? curTimeSig,
      clefChanged:   pendingClef    !== null,
      keyChanged:    pendingKey     !== null,
      timeSigChanged: pendingTimeSig !== null,
      events: []
    };
    // Commit pending
    if (pendingClef)    curClef    = pendingClef;
    if (pendingKey)     curKey     = pendingKey;
    if (pendingTimeSig) curTimeSig = pendingTimeSig;
    pendingClef = pendingKey = pendingTimeSig = null;
    cap  = _measureBeats(curTimeSig);
    beat = 0;
    measures.push(m);
    return m;
  }

  let cur = pushMeasure();
  // First measure starts without "changed" flags — they're always emitted anyway
  cur.clefChanged = cur.keyChanged = cur.timeSigChanged = false;

  for (const ev of notes) {
    // ── Attribute tokens ──────────────────────────────────────────
    if (ev.type === 'clef')    { pendingClef    = ev.clef;    continue; }
    if (ev.type === 'timesig') { pendingTimeSig = ev.timesig; continue; }
    if (ev.type === 'key')     { pendingKey     = ev.key;     continue; }

    // ── Decorations (carry through to current measure) ────────────
    if (ev.type === 'dynamic' || ev.type === 'text-mark' ||
        ev.type === 'rehearsal' || ev.type === 'pedal' ||
        ev.type === 'segno' || ev.type === 'coda' || ev.type === 'nav') {
      cur.events.push(ev);
      continue;
    }

    // ── Repeat barlines ───────────────────────────────────────────
    if (ev.type === 'repeat') {
      cur.events.push(ev);
      continue;
    }

    if (ev.type !== 'note' && ev.type !== 'rest') continue;

    // ── Sounding events — may need a new measure ──────────────────
    const b = DUR_BEATS[ev.duration] ?? 0;

    if (beat > EPS && beat + b > cap + EPS) {
      // Start a fresh measure (with any pending attribute changes)
      cur = pushMeasure();
    }

    cur.events.push(ev);
    beat += b;

    if (Math.abs(beat - cap) < EPS) {
      // Measure is exactly full; next note starts a new one
      cur = pushMeasure();
    }
  }

  // Drop a trailing empty measure (the "lookahead" measure that was never filled)
  if (cur.events.length === 0 && measures.length > 1) measures.pop();

  // Ensure at least one measure
  if (measures.length === 0) {
    measures.push({
      number: 1, clef: curClef, key: curKey, timeSig: curTimeSig,
      clefChanged: false, keyChanged: false, timeSigChanged: false,
      events: []
    });
  }

  return measures;
}

/** Serialize a single note/rest event to MusicXML lines. */
function _noteToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  const lines = [];
  const isRest   = ev.type === 'rest';
  const dur      = ev.duration || 'quarter';
  const divs     = RYM_TO_MXL_DIVS[dur] ?? 8;
  const mxlType  = RYM_TO_MXL_TYPE[dur] || 'quarter';
  const isDotted = dur.endsWith('-dotted');
  const isTriplet = dur.includes('triplet');

  lines.push(`${I}<note>`);

  if (isRest) {
    lines.push(`${I2}<rest/>`);
  } else {
    const step  = ev.pitch || 'C';
    const oct   = ev.octave ?? 4;
    const alter = ev.accidental === '#' ? 1 : ev.accidental === 'b' ? -1 : null;
    lines.push(`${I2}<pitch>`);
    lines.push(`${I2}  <step>${step}</step>`);
    if (alter !== null) lines.push(`${I2}  <alter>${alter}</alter>`);
    lines.push(`${I2}  <octave>${oct}</octave>`);
    lines.push(`${I2}</pitch>`);
  }

  lines.push(`${I2}<duration>${divs}</duration>`);

  // Tie start declaration (paired with a <tied> notation below)
  if (!isRest && ev.tie) {
    lines.push(`${I2}<tie type="start"/>`);
  }

  lines.push(`${I2}<type>${mxlType}</type>`);
  if (isDotted) lines.push(`${I2}<dot/>`);

  if (isTriplet) {
    lines.push(`${I2}<time-modification>`);
    lines.push(`${I2}  <actual-notes>3</actual-notes>`);
    lines.push(`${I2}  <normal-notes>2</normal-notes>`);
    lines.push(`${I2}</time-modification>`);
  }

  // Accidental glyph
  if (!isRest && ev.accExplicit && ev.accidental) {
    const accType = ev.accidental === '#' ? 'sharp' : ev.accidental === 'b' ? 'flat' : 'natural';
    lines.push(`${I2}<accidental>${accType}</accidental>`);
  }

  // Notations block
  const notLines = [];

  if (!isRest && ev.tie) {
    notLines.push(`${I2}  <tied type="start"/>`);
  }

  if (ev.articulations?.length) {
    const artics = [];
    if (ev.articulations.includes('staccato'))  artics.push('<staccato/>');
    if (ev.articulations.includes('accent'))    artics.push('<accent/>');
    if (ev.articulations.includes('tenuto'))    artics.push('<tenuto/>');
    if (ev.articulations.includes('marcato'))   artics.push('<strong-accent type="up"/>');
    if (artics.length) {
      notLines.push(`${I2}  <articulations>${artics.join('')}</articulations>`);
    }
  }

  if (ev.tremolo) {
    notLines.push(`${I2}  <ornaments><tremolo type="single">${ev.tremolo}</tremolo></ornaments>`);
  }

  if (notLines.length) {
    lines.push(`${I2}<notations>`);
    lines.push(...notLines);
    lines.push(`${I2}</notations>`);
  }

  // Inline dynamic on the note itself
  if (!isRest && ev.dynamic) {
    lines.push(`${I2}<dynamics><${_escXml(ev.dynamic)}/></dynamics>`);
  }

  lines.push(`${I}</note>`);
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

/** Serialize a tempo / expression text direction. */
function _textMarkToXmlLines(ev, indent) {
  const I  = indent;
  const I2 = indent + '  ';
  return [
    `${I}<direction placement="above">`,
    `${I2}<direction-type>`,
    `${I2}  <words font-style="italic">${_escXml(ev.text)}</words>`,
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

    const measures = _buildExportMeasures(p);

    measures.forEach(m => {
      lines.push(`    <measure number="${m.number}">`);

      // Attributes block — always on measure 1, or when something changed
      const needAttrs = m.number === 1 || m.clefChanged || m.keyChanged || m.timeSigChanged;
      if (needAttrs) {
        lines.push('      <attributes>');
        lines.push(`        <divisions>${DIVISIONS}</divisions>`);

        // Key
        if (m.number === 1 || m.keyChanged) {
          const fifths = _keyToFifths(m.key);
          lines.push(`        <key><fifths>${fifths}</fifths></key>`);
        }

        // Time
        if (m.number === 1 || m.timeSigChanged) {
          const [tsNum, tsDen] = (m.timeSig || '4/4').split('/');
          lines.push(`        <time>`);
          lines.push(`          <beats>${tsNum}</beats>`);
          lines.push(`          <beat-type>${tsDen}</beat-type>`);
          lines.push(`        </time>`);
        }

        // Clef
        if (m.number === 1 || m.clefChanged) {
          lines.push(`        <clef>`);
          lines.push(`          <sign>${_clefSign(m.clef)}</sign>`);
          lines.push(`          <line>${_clefLine(m.clef)}</line>`);
          lines.push(`        </clef>`);
        }

        lines.push('      </attributes>');
      }

      // Events
      for (const ev of m.events) {
        if (ev.type === 'note' || ev.type === 'rest') {
          lines.push(..._noteToXmlLines(ev, '      '));
        } else if (ev.type === 'dynamic') {
          lines.push(..._dynamicToXmlLines(ev, '      '));
        } else if (ev.type === 'text-mark') {
          lines.push(..._textMarkToXmlLines(ev, '      '));
        } else if (ev.type === 'repeat') {
          lines.push(..._repeatToXmlLines(ev, '      '));
        }
        // rehearsal, segno, coda, nav, pedal are omitted for brevity
        // and could be added as additional cases here
      }

      lines.push('    </measure>');
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
    const category  = _matchCategory(instrName) || _matchCategory(partName);

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

    const measureEls = [...partEl.querySelectorAll('measure')];

    measureEls.forEach((mEl, mi) => {

      // ── <attributes> ──────────────────────────────────────────────
      const attrEl = mEl.querySelector('attributes');
      if (attrEl) {
        const divEl = attrEl.querySelector('divisions');
        if (divEl) divisions = parseInt(divEl.textContent) || 1;

        const fifthsEl = attrEl.querySelector('key > fifths');
        if (fifthsEl) {
          const newKey = _fifthsToKey(parseInt(fifthsEl.textContent) || 0);
          if (newKey !== key) {
            if (mi > 0) notes.push({ _id: _uid(), type: 'key', key: newKey });
            key = newKey;
          }
        }

        const beatsEl    = attrEl.querySelector('time > beats');
        const beatTypeEl = attrEl.querySelector('time > beat-type');
        if (beatsEl && beatTypeEl) {
          const newTS = `${beatsEl.textContent.trim()}/${beatTypeEl.textContent.trim()}`;
          if (newTS !== timeSig) {
            if (mi > 0) notes.push({ _id: _uid(), type: 'timesig', timesig: newTS });
            timeSig = newTS;
          }
        }

        const clefSignEl = attrEl.querySelector('clef > sign');
        const clefLineEl = attrEl.querySelector('clef > line');
        if (clefSignEl) {
          const newClef = _mxlToRymClef(
            clefSignEl.textContent.toUpperCase(),
            clefLineEl?.textContent?.trim()
          );
          if (newClef !== clef) {
            if (mi > 0) notes.push({ _id: _uid(), type: 'clef', clef: newClef });
            clef = newClef;
          }
        }

        // Capture initial state once
        if (initialClef    === null) initialClef    = clef;
        if (initialKey     === null) initialKey     = key;
        if (initialTimeSig === null) initialTimeSig = timeSig;
      }

      // ── <direction> ───────────────────────────────────────────────
      mEl.querySelectorAll('direction').forEach(dEl => {
        // Dynamics
        const dynEl = dEl.querySelector('dynamics');
        if (dynEl?.firstElementChild) {
          notes.push({ _id: _uid(), type: 'dynamic', dynamic: dynEl.firstElementChild.tagName });
          return;
        }
        // Tempo / expression text
        const wordsEl = dEl.querySelector('words');
        if (wordsEl) {
          const placement = dEl.getAttribute('placement') || 'above';
          const subtype   = placement === 'above' ? 'tempo' : 'expression';
          notes.push({ _id: _uid(), type: 'text-mark', text: wordsEl.textContent.trim(), subtype });
        }
      });

      // ── <barline> (repeats) ───────────────────────────────────────
      mEl.querySelectorAll('barline').forEach(bEl => {
        const repeatEl = bEl.querySelector('repeat');
        if (repeatEl) {
          const dir = repeatEl.getAttribute('direction') === 'forward' ? 'start' : 'end';
          notes.push({ _id: _uid(), type: 'repeat', direction: dir });
        }
      });

      // ── <note> ────────────────────────────────────────────────────
      mEl.querySelectorAll('note').forEach(nEl => {
        const isRest  = !!nEl.querySelector('rest');
        const isChord = !!nEl.querySelector('chord');   // chord note — attach to previous head
        const typeEl  = nEl.querySelector('type');
        const dotEls  = nEl.querySelectorAll('dot');
        const timeMod = nEl.querySelector('time-modification');

        const isTriplet = timeMod
          && parseInt(timeMod.querySelector('actual-notes')?.textContent) === 3
          && parseInt(timeMod.querySelector('normal-notes')?.textContent)  === 2;

        const mxlType = typeEl?.textContent?.trim() || 'quarter';
        let rymDur    = MXL_TYPE_TO_RYM[mxlType] || 'quarter';

        // Apply dot / triplet modifiers
        if (isTriplet && rymDur === 'quarter') {
          rymDur = 'quarter-triplet';
        } else if (dotEls.length > 0) {
          // Only add '-dotted' if we recognise this duration as dot-able
          const dotted = rymDur + '-dotted';
          if (DUR_BEATS[dotted] !== undefined) rymDur = dotted;
        }

        const ev = {
          _id:      _uid(),
          type:     isRest ? 'rest' : 'note',
          duration: rymDur,
        };

        if (!isRest) {
          ev.pitch  = nEl.querySelector('pitch > step')?.textContent?.trim() || 'C';
          ev.octave = parseInt(nEl.querySelector('pitch > octave')?.textContent) || 4;

          const alter = parseFloat(nEl.querySelector('pitch > alter')?.textContent || '0');
          ev.accidental = alter === 1 ? '#' : alter === -1 ? 'b' : null;

          // Show the accidental glyph if MusicXML has an <accidental> element
          if (nEl.querySelector('accidental')) ev.accExplicit = true;

          // Tie
          const tieStartEl = [...nEl.querySelectorAll('tie')].find(t => t.getAttribute('type') === 'start');
          if (tieStartEl) ev.tie = true;

          // Articulations
          const notationsEl = nEl.querySelector('notations');
          if (notationsEl) {
            const arts = [];
            if (notationsEl.querySelector('articulations staccato'))           arts.push('staccato');
            if (notationsEl.querySelector('articulations accent'))             arts.push('accent');
            if (notationsEl.querySelector('articulations tenuto'))             arts.push('tenuto');
            if (notationsEl.querySelector('articulations strong-accent'))      arts.push('marcato');
            if (arts.length) ev.articulations = arts;

            // Tremolo
            const tremEl = notationsEl.querySelector('ornaments tremolo');
            if (tremEl) ev.tremolo = parseInt(tremEl.textContent) || 1;

            // Slurs
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
          }
        }

        // Note-level dynamic (unusual but valid in MusicXML)
        const noteDynEl = nEl.querySelector('dynamics');
        if (noteDynEl?.firstElementChild) {
          ev.dynamic = noteDynEl.firstElementChild.tagName;
        }

        // Chord notes: in Rymspace's model there's no native chord support,
        // so chord notes are imported as independent notes.  This is a known
        // simplification — chords deserving first-class support is a future feature.
        notes.push(ev);
      });
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