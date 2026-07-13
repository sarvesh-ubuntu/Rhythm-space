/**
 * Rymspace — Playback Engine  v9
 * Procedural additive synthesis. No samples, pure math.
 *
 * ─── v9 Improvements (acoustic realism pass) ────────────────────────────────
 *
 *  1. ENHANCED REVERB — pre-delay + early reflections + multi-band diffuse tail.
 *     v8 used a single monolithic exponential-noise impulse: no pre-delay, no
 *     room geometry, every frequency dying at the same rate.  v9 adds:
 *       • 12 ms pre-delay (time for direct sound to reach first wall)
 *       • 8 discrete early-reflection taps (8–57 ms) with per-tap gain and
 *         ±8 % timing jitter per stereo channel — simulates a real room's
 *         irregular wall distances
 *       • Three-band late-diffuse tail: highs decay 38 % faster than lows
 *         (air absorption + surface scatter), giving a natural darkening
 *         of the reverb tail at higher frequencies
 *       • Slight L/R asymmetry throughout — the two channels carry
 *         subtly different early-reflection patterns for stereo width
 *
 *  2. PIANO MULTI-STRING UNISON CHORUS.
 *     A concert grand has 2–3 steel strings per note.  Even a perfectly tuned
 *     instrument has 1–4 cents of inter-string variation.  v9 spawns 3 oscillator
 *     voices per piano partial at −1.6 / 0 / +1.4 cents with 0/1/2 ms staggered
 *     attack offsets (hammer contacts strings in sequence).  Combined gainScale
 *     sums to 1.0 so the attack peak matches v8; over sustain, the 0.35–0.40 Hz
 *     beating creates the characteristic piano shimmer that no single oscillator
 *     can reproduce.
 *
 *  3. ORGAN PIPE CHORUS — 2-voice flue-pipe detuning.
 *     Real pipe organs have slight rank-tuning variance even within a single stop.
 *     v9 adds a second voice detuned +1.2 cents, creating a gentle live-air warmth.
 *
 *  4. PINK NOISE FOR BOW FRICTION.
 *     Bow-hair friction has approximately −3 dB/octave spectral tilt (pink noise).
 *     v9 generates a dedicated pink noise buffer via the Voss–McCartney algorithm.
 *     Violin, viola, cello, and bass draw from this instead of white noise —
 *     the result is a warmer, less "hissy" bow texture.
 *
 *  5. HAMMER / PLUCK / MALLET ATTACK TRANSIENT.
 *     Piano, guitar, banjo, harp, marimba, xylophone, celesta, vibraphone, and
 *     pizzicato strings gain a 3–5 ms high-pass filtered noise burst at note
 *     onset.  Below 10 ms it is felt more than heard, but its absence is clearly
 *     audible — it is the physical impulse of the striking medium (hammer / nail /
 *     mallet) on the vibrating body.  Level scales with velocity.
 *
 *  6. STEREO PANNING — category-based placement.
 *     Struck strings (piano-like): log-scale pitch panning (A0 → L 0.80,
 *       C8 → R 0.80) matching real grand-piano listening perspective.
 *     Bowed strings: approximate orchestra seating by register (higher
 *       lines left, lower lines right, ±3% per-note jitter) — since a part's
 *       name no longer tells the engine "violin" vs "cello" (see v10 note
 *       below), the pitch actually played is used instead, which happens to
 *       be the right signal for seating anyway.
 *     All others: subtle ±8% random spread so simultaneous notes don't
 *       collapse to a single mono point.
 *     Uses StereoPannerNode; gracefully no-ops on browsers without it.
 *
 * ─── v10 — physics categories (post-v9) ─────────────────────────────────
 *   RCP is now keyed by ~10 acoustic archetypes ("categories": bowed-strings,
 *   plucked-strings, struck-strings, sustained-keys, open-winds, reed-winds,
 *   brass, membrane-percussion, tuned-bars, metal-percussion, custom) rather
 *   than ~25 hardcoded instrument names. A part's user-facing name (e.g.
 *   "2nd Violin") is purely cosmetic; app.js assigns each part a category
 *   that selects the physics model here. Written register substitutes for
 *   what used to come from picking a specific instrument name. See the RCP
 *   declaration below for the full rationale and the legacy-name fallback
 *   table that keeps older saved scores sounding right.
 *
 *  7. VIBRATO NATURALNESS — sub-LFO rate jitter.
 *     A secondary 0.28–0.38 Hz LFO modulates the vibrato rate by ±7 %, giving
 *     the organic per-cycle variation of a live player vs. a perfect oscillator.
 *
 *  8. BOWED-STRING CONVEX ATTACK.
 *     Real bow-hair builds friction progressively — the onset envelope is
 *     exponential-approach, not linear.  Bowed strings (non-slurred onsets) now
 *     use setTargetAtTime for the attack phase, matching the physical build-up of
 *     bow grip on the string.
 *
 *  9. NEW INSTRUMENTS:
 *       Bassoon    — conical bore, double reed; dark and buzzy, fundamental-led.
 *       Saxophone  — conical bore, single reed; bright "honk", strong 2nd partial.
 *       Marimba    — wooden bars, arch-cut resonators; 4× tuned overtone, warm.
 *       Xylophone  — harder bars, no resonators; brighter, faster decay.
 *       Celesta    — steel bars over wooden resonators; silvery bell-like decay.
 *       Timpani    — copper kettle drum; more pitched than snare, strong low mode.
 *       Vibraphone — aluminium bars, tubular resonators; warm metal, slow decay.
 *       Glockenspiel — small steel bars; bright, bell-like, very short sustain.
 *
 * ─── All v8 features retained ───────────────────────────────────────────────
 *   Slur / legato portamento (bowed strings + trombone only); pizzicato / arco;
 *   con sord. mute; sustain pedal; tremolo & trill expansion; dynamic timbral
 *   brightness for brass; spectral decay for plucked / struck strings; capo
 *   transposition; tie merging; Schuck–Young inharmonicity for all strings;
 *   triple filter chain (up to filter + filter2 + filter3 + spectral shelf +
 *   mute filter); bow-contact filter sweep; Bessel-mode drum partials;
 *   staccato / accent / tenuto / fermata articulations; full score data model
 *   (part.slurs[], note.articulations, inline pedal/text/dynamic tokens).
 */

'use strict';

window.RymPlayback = (() => {

  // ─────────────────────────────────────────────────────────────────
  //  Module state
  // ─────────────────────────────────────────────────────────────────

  let _ctx         = null;
  let _masterGain  = null;
  let _dryGain     = null;
  let _wetGain     = null;
  let _reverb      = null;
  let _noiseBuffer = null;   // white noise — drums, breath, winds
  let _pinkBuffer  = null;   // pink noise  — bow friction (v9)
  let _scheduled   = [];
  let _isPlaying   = false;
  let _tickTimer   = null;
  let _stopTimer   = null;

  // ─────────────────────────────────────────────────────────────────
  //  Audio context & signal chain
  // ─────────────────────────────────────────────────────────────────

  function getCtx() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _buildGraph(_ctx);
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  function _buildGraph(ctx) {
    _masterGain = ctx.createGain();
    _masterGain.gain.value = 0.80;

    _dryGain = ctx.createGain();
    _wetGain = ctx.createGain();
    _dryGain.gain.value = 0.74;
    _wetGain.gain.value = 0.26;

    _reverb = _buildReverb(ctx, 1.6);

    _masterGain.connect(_dryGain);
    _masterGain.connect(_reverb);
    _reverb.connect(_wetGain);
    _dryGain.connect(ctx.destination);
    _wetGain.connect(ctx.destination);

    // ── White noise buffer ─────────────────────────────────────────
    _noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    {
      const d = _noiseBuffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }

    // ── Pink noise buffer (Voss–McCartney algorithm) ───────────────
    // Bow-hair friction has ~−3 dB/octave tilt.  Six-stage IIR filter
    // approximates the 1/f power spectrum of pink noise.
    _pinkBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    {
      const d = _pinkBuffer.getChannelData(0);
      let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759;
        b2 = 0.96900*b2 + w*0.1538520; b3 = 0.86650*b3 + w*0.3104856;
        b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
        d[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
  }

  /**
   * _buildReverb — pre-delay + early reflections + multi-band diffuse tail
   *
   * Section 1: pre-delay silence (12 ms) — direct-sound travel time.
   * Section 2: 8 early-reflection taps (8–57 ms) with per-tap L/R timing
   *   jitter (±8 %) that varies between calls, simulating irregular wall
   *   distances in a non-rectangular room.
   * Section 3: three-band late diffuse tail (low / mid / high) with
   *   independent exponential decay rates — physically correct because
   *   high-frequency energy is absorbed faster by air and surfaces.
   */
  function _buildReverb(ctx, decaySec) {
    const conv  = ctx.createConvolver();
    const rate  = ctx.sampleRate;
    const len   = Math.floor(rate * (decaySec + 0.9));
    const ir    = ctx.createBuffer(2, len, rate);

    const preDelay = Math.floor(rate * 0.012); // 12 ms

    // Early reflection taps: { ms, gain }
    const erTaps = [
      {ms:  8, g:0.62}, {ms: 14, g:0.54}, {ms: 22, g:0.45},
      {ms: 28, g:0.38}, {ms: 35, g:0.31}, {ms: 43, g:0.25},
      {ms: 48, g:0.18}, {ms: 57, g:0.12}
    ];

    for (let ch = 0; ch < 2; ch++) {
      const d    = ir.getChannelData(ch);
      const side = ch === 0 ? -1 : 1; // subtle L/R asymmetry for width

      // Early reflections
      for (const tap of erTaps) {
        const jitter = 1 + (Math.random() * 0.16 - 0.08);
        const smp    = Math.floor(preDelay + rate * tap.ms * jitter / 1000);
        if (smp + 2 < len) {
          const g = tap.g * (0.7 + Math.random() * 0.3) * (1 + side * 0.04);
          d[smp]     += g;
          d[smp + 1] += g * 0.40;
          d[smp + 2] += g * 0.18;
        }
      }

      // Multi-band late diffuse tail starting at ~60 ms
      const tailStart = preDelay + Math.floor(rate * 0.060);
      const tLow  = decaySec * 1.30 * 0.45; // time constant, low band
      const tMid  = decaySec * 1.00 * 0.45;
      const tHigh = decaySec * 0.62 * 0.45;

      for (let i = tailStart; i < len; i++) {
        const t   = (i - tailStart) / rate;
        const rnd = Math.random() * 2 - 1;
        d[i] += rnd * (
          Math.exp(-t / tLow)  * 0.40 +
          Math.exp(-t / tMid)  * 0.35 +
          Math.exp(-t / tHigh) * 0.25
        ) * 0.16 * (1 + side * (Math.random() * 0.04 - 0.02));
      }
    }

    conv.buffer = ir;
    return conv;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Pitch
  // ─────────────────────────────────────────────────────────────────

  function noteFreq(pitch, acc, octave) {
    const CHROM = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
    const base  = CHROM[pitch] ?? 0;
    const alt   = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
    const midi  = octave * 12 + base + alt + 12;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Guitar (app.js's 'plucked-strings' / "Guitar Family" category) is a
  // transposing instrument by long-standing notation convention: treble-clef
  // guitar music is written a full octave higher than it actually sounds
  // (an implicit 8vb), which is why guitar parts don't drown in ledger
  // lines the way a literal-pitch treble clef would need for that range.
  // Piano, violin, flute, etc. all sound exactly as written in treble clef —
  // guitar alone doesn't, and playback previously treated it the same as
  // every other treble-clef instrument. This affects only the audio; the
  // score keeps showing exactly what's written, as it should.
  function soundingFreq(pitch, acc, octave, category) {
    const f = noteFreq(pitch, acc, octave);
    return category === 'plucked-strings' ? f * 0.5 : f;
  }

  window.noteFreq = noteFreq;

  // ─────────────────────────────────────────────────────────────────
  //  Dynamics → velocity
  // ─────────────────────────────────────────────────────────────────

  const DYN_VEL = {
    pppp:0.07, ppp:0.11, pp:0.17,  p:0.27,
    mp:0.42,   mf:0.55,  f:0.68,   ff:0.80,
    fff:0.90,  ffff:0.95, sfz:0.95, sfp:0.85,
    fp:0.80,   fz:0.82,  rf:0.75,  rfz:0.82
  };
  const dynVel = d => DYN_VEL[d] ?? 0.55;

  // ─────────────────────────────────────────────────────────────────
  //  Physics-model categories  (v10 — replaces per-instrument-name recipes)
  //
  //  RCP used to be keyed by ~25 hardcoded instrument names (Violin, Viola,
  //  Cello... Marimba, Xylophone...). Most of those were near-duplicates of
  //  each other differing only in a handful of numbers (inharmonicity,
  //  filter2 center freq) — the actual acoustic *behavior* clustered into
  //  about 10 real archetypes. RCP is now keyed by those archetypes
  //  ("categories") instead. A part's displayed name (whatever the user
  //  calls it — "2nd Violin", "Cello II") is purely cosmetic; app.js
  //  assigns it a `category` that selects which physics model here plays
  //  it. Register (the clef/octave the part is actually written in) does
  //  the differentiation that used to come from picking "Violin" vs
  //  "Cello" — the model plays whatever pitch it's given.
  //
  //  A small LEGACY_INSTRUMENT_TO_CATEGORY table below keeps old saved
  //  scores / imported MusicXML (which may still carry an old instrument
  //  name) sounding right without a forced migration step.
  //
  //  partials        — additive sine harmonics: r = freq ratio, g = gain
  //  inharmonicity   — Schuck–Young B factor: f_n ≈ n·f₀·√(1 + B·n²)
  //  filter          — primary resonance (type / freq / Q)
  //  filter2/3       — secondary/tertiary resonance (body / reed / bell)
  //  spectralDecay   — { freq, db }: highshelf sweeps 0 → −db over rawDur
  //  brightnessByVel — filter cutoff scales with loudness (brass)
  //  env             — ADSR: a/d in seconds, s = sustain 0–1, r secs
  //  staccato        — { factor, r }: duration multiplier + short release
  //  vibrato         — { rate Hz, depth ratio, delay onset secs }
  //  noise           — 0–1 bow/breath/drum noise level
  //  noiseFreqMult   — bandpass centres near n-th harmonic of played pitch
  //  usePinkNoise    — use −3 dB/oct pink buffer (bow friction)
  //  bowedString     — enables bow-contact filter sweep + portamento scope
  //  unisonVoices    — array of { detuneCents, atkOffset, gainScale }
  //                    spawns multiple oscillator sets for multi-string/pipe
  //  attackTransient — { gain, decay }: highpass noise click (hammer/pluck)
  //  legato          — category capable of legato articulation
  //  gain            — master level for this category
  // ─────────────────────────────────────────────────────────────────

  const RCP = {

    // ── Struck strings ───────────────────────────────────────────────

    'struck-strings': {
      // 10 harmonics; string inharmonicity (B ≈ 0.00018) causes upper partials
      // to sit slightly sharp of integer multiples — the defining "chorus" of
      // a real piano chord.  Soundboard resonance at 250 Hz (bridge coupling).
      // v9: 3-voice unison detuning — see header §2.
      partials: [
        {r:1,  g:1.000}, {r:2,  g:0.620}, {r:3,  g:0.380},
        {r:4,  g:0.220}, {r:5,  g:0.130}, {r:6,  g:0.080},
        {r:7,  g:0.050}, {r:8,  g:0.030}, {r:9,  g:0.018}, {r:10, g:0.010}
      ],
      inharmonicity:  0.00018,
      filter:         { type:'lowpass', freq:7000, Q:0.65 },
      filter2:        { type:'peaking', freq:250,  Q:2.5, gain:3.2 },
      spectralDecay:  { freq:2500, db:16 },
      env:            { a:0.006, d:0.20, s:0.40, r:0.32 },
      // Struck once, then only ever loses energy — no continuous input
      // to hold a level flat. See `sustains` comment in _scheduleNote.
      sustains:       false,
      staccato:       { factor:0.22, r:0.06 },
      unisonVoices: [
        { detuneCents:-1.6, atkOffset:0.000, gainScale:0.34 },
        { detuneCents: 0.0, atkOffset:0.001, gainScale:0.34 },
        { detuneCents:+1.4, atkOffset:0.002, gainScale:0.32 }
      ],
      // Felt hammer on strings: a duller, broadband thud, not a bright
      // click — bandpass centred low, wide Q, and a touch longer than a
      // pick's scrape (see plucked-strings below for the contrast).
      attackTransient: { gain:0.16, decay:0.006, filterType:'bandpass', freq:1600, q:0.8 },
      gain: 0.26
    },

    // ── Sustained keys ────────────────────────────────────────────────

    'sustained-keys': {
      // Drawbar organ: sub-octave + rich harmonics, zero decay, square gate.
      // v9: 2-voice pipe chorus (+1.2 cents) — flue-pipe tuning variance.
      partials: [
        {r:0.5, g:0.55}, {r:1, g:1.00}, {r:2, g:0.80},
        {r:3,   g:0.55}, {r:4, g:0.38}, {r:5, g:0.26},
        {r:6,   g:0.16}, {r:8, g:0.09}
      ],
      filter:   { type:'lowpass', freq:5200, Q:0.40 },
      env:      { a:0.012, d:0.0, s:1.00, r:0.014 },
      // Continuous wind pressure — genuinely holds flat for as long as the
      // key/note is held. See `sustains` comment in _scheduleNote.
      sustains: true,
      staccato: { factor:0.50, r:0.014 },
      unisonVoices: [
        { detuneCents: 0.0, atkOffset:0.000, gainScale:0.52 },
        { detuneCents:+1.2, atkOffset:0.003, gainScale:0.48 }
      ],
      gain: 0.19
    },

    // ── Plucked strings ──────────────────────────────────────────────
    // Consolidates the old Guitar/Banjo/Ukulele/Harp recipes — all share
    // the same pluck-transient + body-resonance + spectral-decay shape,
    // differing mainly in body resonance frequency and inharmonicity.
    // This lands roughly between Guitar and Harp: bright pluck attack,
    // moderate sustain, mid-body resonance.

    'plucked-strings': {
      partials: [
        {r:1, g:1.000}, {r:2, g:0.560}, {r:3, g:0.280},
        {r:4, g:0.140}, {r:5, g:0.070}, {r:6, g:0.040},
        {r:7, g:0.025}, {r:8, g:0.015}
      ],
      inharmonicity:  0.00016,
      filter:         { type:'lowpass', freq:5200, Q:1.0 },
      filter2:        { type:'peaking', freq:210,  Q:3.6, gain:3.4 },
      spectralDecay:  { freq:3200, db:13 },
      env:            { a:0.005, d:0.26, s:0.26, r:0.15 },
      // Plucked once, then only ever loses energy — no bow, no continuous
      // input to hold a level flat. See `sustains` comment in _scheduleNote.
      sustains:       false,
      staccato:       { factor:0.28, r:0.06 },
      // Fingernail/pick edge against the string: bright, thin, shorter than
      // piano's felt-hammer thud — sharper highpass, higher corner, less Q.
      attackTransient:{ gain:0.15, decay:0.0035, filterType:'highpass', freq:5000, q:0.5 },
      gain: 0.30
    },

    // ── Bowed strings ────────────────────────────────────────────────
    // Consolidates Violin/Viola/Cello/Bass — they already shared almost
    // identical structure (2nd-partial-forward body, pink-noise bow
    // friction, convex bow-grip attack). What used to differentiate them
    // was mostly inharmonicity and body-resonance frequency, which register
    // (the octave a part is actually written in) substitutes for well
    // enough that a single archetype covers the family.

    'bowed-strings': {
      partials: [
        {r:1, g:0.84}, {r:2, g:1.00}, {r:3, g:0.70},
        {r:4, g:0.50}, {r:5, g:0.32}, {r:6, g:0.19},
        {r:7, g:0.10}, {r:8, g:0.055},{r:9, g:0.03}
      ],
      inharmonicity: 0.00016,
      filter:   { type:'lowpass', freq:6400, Q:0.60 },
      filter2:  { type:'peaking', freq:480,  Q:4.4, gain:3.3 },
      filter3:  { type:'peaking', freq:2600, Q:1.8, gain:2.9 },
      env:      { a:0.075, d:0.05, s:0.84, r:0.14 },
      // Continuous bow contact — genuinely holds flat for as long as the
      // bow keeps drawing. See `sustains` comment in _scheduleNote.
      sustains: true,
      staccato: { factor:0.31, r:0.05 },
      vibrato:  { rate:5.4, depth:0.0084, delay:0.25 },
      noise:         0.021,
      noiseFreqMult: 3.0,
      usePinkNoise:  true,
      bowedString:   true,
      legato:        true,
      gain: 0.21
    },

    // ── Open-bore winds ───────────────────────────────────────────────

    'open-winds': {
      // Cylindrical open bore: all harmonics present but upper partials very weak.
      // filter2: "tonus" jet resonance at 1.8 kHz — the airy brightness of the embouchure hole.
      // Breath noise sustaining (< 0.10), pitch-tracked near 2nd harmonic.
      partials: [
        {r:1, g:1.00}, {r:2, g:0.26}, {r:3, g:0.10},
        {r:4, g:0.04}, {r:5, g:0.015}
      ],
      filter:        { type:'lowpass', freq:5400, Q:0.32 },
      filter2:       { type:'peaking', freq:1800, Q:2.8, gain:4.0 },
      env:           { a:0.08, d:0.04, s:0.88, r:0.09 },
      // Continuous breath pressure — genuinely holds flat for as long as
      // the note is blown. See `sustains` comment in _scheduleNote.
      sustains:      true,
      staccato:      { factor:0.28, r:0.04 },
      noise:         0.036,
      noiseFreqMult: 2.0,
      vibrato:       { rate:5.6, depth:0.0112, delay:0.18 },
      legato:        true,
      gain: 0.32
    },

    // ── Reed winds ───────────────────────────────────────────────────
    // Consolidates Clarinet/Oboe/Bassoon/Saxophone — single- and
    // double-reed instruments differ in odd-vs-even harmonic emphasis
    // and reed-formant frequency, but share a reed-resonance filter2 and
    // a similar breath-noise/legato character. This lands between
    // Clarinet's odd-harmonic bias and Oboe/Sax's brighter even harmonics.

    'reed-winds': {
      partials: [
        {r:1, g:0.86}, {r:2, g:0.60}, {r:3, g:0.62},
        {r:4, g:0.34}, {r:5, g:0.34}, {r:6, g:0.16},
        {r:7, g:0.16}, {r:8, g:0.07}
      ],
      filter:        { type:'lowpass', freq:4300, Q:0.85 },
      filter2:       { type:'peaking', freq:650,  Q:4.2, gain:3.8 },
      env:           { a:0.045, d:0.05, s:0.86, r:0.09 },
      // Continuous breath pressure — genuinely holds flat for as long as
      // the note is blown. See `sustains` comment in _scheduleNote.
      sustains:      true,
      staccato:      { factor:0.28, r:0.045 },
      vibrato:       { rate:5.3, depth:0.0078, delay:0.26 },
      noise:         0.014,
      noiseFreqMult: 3.2,
      legato:        true,
      gain: 0.25
    },

    // ── Brass ─────────────────────────────────────────────────────────
    // Consolidates Trumpet/Horn/Trombone/Tuba — shared brightnessByVel
    // dynamic brightening and a similar partial-series shape (fundamental
    // and 2nd/3rd partials close in level, tapering from there).
    // Note: Trombone's alwaysPortamento (constant slide glide between
    // every note) was instrument-specific to the slide mechanism and
    // doesn't generalize to the category — dropped as part of the
    // fixed-sound-per-category simplification. Slurred notes still glide
    // normally via the shared portamento-on-slur logic.

    brass: {
      partials: [
        {r:1, g:0.74}, {r:2, g:0.94}, {r:3, g:0.80},
        {r:4, g:0.58}, {r:5, g:0.42}, {r:6, g:0.28},
        {r:7, g:0.16}, {r:8, g:0.09}, {r:9, g:0.045}
      ],
      filter:          { type:'lowpass', freq:4600, Q:1.15 },
      filter2:         { type:'peaking', freq:700,  Q:3.2, gain:4.1 },
      brightnessByVel: 0.32,
      env:             { a:0.045, d:0.055, s:0.82, r:0.11 },
      // Continuous breath pressure through the mouthpiece — genuinely holds
      // flat for as long as the note is blown. See `sustains` comment in
      // _scheduleNote.
      sustains:        true,
      staccato:        { factor:0.30, r:0.05 },
      vibrato:         { rate:5.6, depth:0.0060, delay:0.36 },
      noise:           0.007,
      noiseFreqMult:   3.6,
      legato:          true,
      gain: 0.23
    },

    // ── Tuned bars ────────────────────────────────────────────────────
    // Consolidates Marimba/Xylophone/Vibraphone — wooden/metal bars with
    // the same tuned-overtone modal ratios (~4× and ~9.88× the
    // fundamental, not natural integer partials). Lands between Marimba's
    // warmth and Xylophone's brightness.

    'tuned-bars': {
      partials: [
        {r:1.000, g:1.000}, {r:4.000, g:0.330}, {r:9.880, g:0.100},
        {r:2.000, g:0.050}, {r:3.000, g:0.022}
      ],
      inharmonicity:   0.00009,
      filter:          { type:'lowpass', freq:6200, Q:0.85 },
      filter2:         { type:'peaking', freq:220,  Q:3.0, gain:3.2 },
      spectralDecay:   { freq:2000, db:19 },
      env:             { a:0.004, d:0.12, s:0.10, r:0.35 },
      // Struck once, then only ever loses energy. See `sustains` comment
      // in _scheduleNote.
      sustains:        false,
      staccato:        { factor:0.30, r:0.07 },
      attackTransient: { gain:0.16, decay:0.0035 },
      gain: 0.29
    },

    // ── Metal percussion ──────────────────────────────────────────────
    // Consolidates Celesta/Glockenspiel — small steel bars/plates with
    // inharmonic bell-like modes (2.756×, 5.404×, 8.933× the fundamental).

    'metal-percussion': {
      partials: [
        {r:1.000, g:1.000}, {r:2.756, g:0.420}, {r:5.404, g:0.160},
        {r:2.000, g:0.080}, {r:8.933, g:0.065}, {r:3.000, g:0.030}
      ],
      inharmonicity:   0.00028,
      filter:          { type:'lowpass', freq:10000, Q:0.60 },
      filter2:         { type:'peaking', freq:700,   Q:3.0, gain:3.0 },
      spectralDecay:   { freq:4500, db:16 },
      env:             { a:0.004, d:0.14, s:0.18, r:0.55 },
      // Struck once, then only ever loses energy — the long r:0.55 here is
      // a real bell/chime ring-out, not a held level. See `sustains`
      // comment in _scheduleNote.
      sustains:        false,
      staccato:        { factor:0.32, r:0.09 },
      attackTransient: { gain:0.12, decay:0.0025 },
      gain: 0.24
    },

    // ── Membrane percussion ───────────────────────────────────────────
    // Consolidates Timpani/Drums — circular-membrane Bessel-mode partials
    // and a percussive noise burst. Timpani's more-pitched character (the
    // kettle bowl suppresses higher Bessel modes) and a standard drum's
    // sharper noise burst are blended into one archetype; a part's written
    // pitch still drives the partial frequencies, so a tuned membrane part
    // still reads as tuned.

    'membrane-percussion': {
      partials: [
        {r:1.000, g:1.00}, {r:1.55,  g:0.34},
        {r:2.10,  g:0.22}, {r:2.50,  g:0.15},
        {r:2.90,  g:0.09}, {r:3.20,  g:0.05}
      ],
      filter:   { type:'bandpass', freq:160, Q:1.8 },
      filter2:  { type:'peaking',  freq:85,  Q:4.0, gain:4.5 },
      env:      { a:0.004, d:0.18, s:0.06, r:0.30 },
      staccato: { factor:0.48, r:0.08 },
      noise:    0.45,
      gain: 0.38
    },

    // ── Custom ─────────────────────────────────────────────────────────
    // Plain, characterless tone for parts that don't fit any acoustic
    // archetype — same shape as the ultimate _defaultRcp fallback below,
    // just addressable as an explicit category choice.

    custom: {
      partials: [{r:1, g:1.00}, {r:2, g:0.40}, {r:3, g:0.18}],
      filter:   { type:'lowpass', freq:4100, Q:0.70 },
      env:      { a:0.02, d:0.10, s:0.70, r:0.14 },
      staccato: { factor:0.33, r:0.05 },
      gain: 0.30
    }

  };

  // ── Legacy instrument-name → category map ──────────────────────────
  // Keeps old saved scores / imported MusicXML that still carry a pre-v10
  // instrument name (e.g. from part.instrument rather than part.category)
  // sounding right without forcing a migration. app.js also uses an
  // equivalent table when loading old files, so this is mostly a defensive
  // second line of defense inside the synth itself.
  const LEGACY_INSTRUMENT_TO_CATEGORY = {
    Piano:'struck-strings',
    Guitar:'plucked-strings', Banjo:'plucked-strings', Ukulele:'plucked-strings', Harp:'plucked-strings',
    Violin:'bowed-strings', Viola:'bowed-strings', Cello:'bowed-strings', Bass:'bowed-strings', Contrabass:'bowed-strings',
    Organ:'sustained-keys',
    Flute:'open-winds',
    Clarinet:'reed-winds', Oboe:'reed-winds', Bassoon:'reed-winds', Saxophone:'reed-winds',
    'Alto Sax':'reed-winds', 'Tenor Sax':'reed-winds',
    Trumpet:'brass', Horn:'brass', Trombone:'brass', Tuba:'brass',
    Marimba:'tuned-bars', Xylophone:'tuned-bars', Vibraphone:'tuned-bars',
    Celesta:'metal-percussion', Glockenspiel:'metal-percussion',
    Timpani:'membrane-percussion', Drums:'membrane-percussion',
    Custom:'custom'
  };

  const _defaultRcp = {
    partials: [{r:1, g:1.00}, {r:2, g:0.40}, {r:3, g:0.18}],
    filter:   { type:'lowpass', freq:4100, Q:0.70 },
    env:      { a:0.02, d:0.10, s:0.70, r:0.14 },
    staccato: { factor:0.33, r:0.05 },
    gain: 0.30
  };

  // ─────────────────────────────────────────────────────────────────
  //  Core synthesis  —  schedule one note at an absolute AudioContext time
  // ─────────────────────────────────────────────────────────────────

  function _scheduleNote(ctx, inst, freq, t0, durSec, vel, isStacc, isAccent, isTenuto, isSlurred, prevFreq, isFermata, pedalOn, pizzMode, mutedMode) {
    if (!_masterGain || freq < 18 || freq > 18500) return;

    // ── Recipe selection with pizz / mute overrides ──────────────────
    // `inst` is normally already a category id (resolved in _flattenPart),
    // but this also accepts a raw legacy instrument name defensively.
    let rec = RCP[inst] || RCP[LEGACY_INSTRUMENT_TO_CATEGORY[inst]] || _defaultRcp;

    const isBowed = rec.bowedString && rec.noise && rec.noise < 0.10;
    if (pizzMode && isBowed) {
      rec = {
        ...rec,
        env:             { a:0.005, d:rec.env.d * 1.4, s:0.05, r:0.30 },
        staccato:        { factor:0.40, r:0.08 },
        spectralDecay:   rec.spectralDecay || { freq:3000, db:12 },
        noise:           null,
        vibrato:         null,
        bowedString:     false,
        legato:          false,
        unisonVoices:    null,
        attackTransient: { gain:0.08, decay:0.003 }
      };
    }

    // ── Duration & envelope fitting ──────────────────────────────────
    const fermataMult = isFermata ? 1.8 : 1.0;
    const soundFactor = isStacc  ? (rec.staccato ? rec.staccato.factor : 0.30)
                      : isTenuto ? 0.97 : 1.0;
    const rawDur = Math.max(durSec * soundFactor * fermataMult, 0.020);

    // Decay happens WHILE the note is still sounding, before release, so it
    // only needs to fit in whatever time is left after the attack — not an
    // arbitrary fixed fraction of the note's duration. The old maxDec =
    // rawDur*0.40 ceiling was tight enough that on an ordinary quarter note
    // (rawDur=0.5s → maxDec=0.20) it silently clamped guitar's 0.26s decay
    // down to piano's 0.20s, making them numerically identical — one of the
    // reasons every instrument's envelope converged to the same shape
    // regardless of its recipe.
    const maxAtt = rawDur * 0.30;
    const maxDec = Math.max(0, rawDur - maxAtt);

    const att     = Math.min(rec.env.a, maxAtt);
    const dec     = Math.min(rec.env.d, maxDec);
    const sus     = rec.env.s;

    // Release: a real instrument keeps sounding AFTER a note's written
    // duration ends — a pedaled piano note rings on, a plucked string keeps
    // decaying into the next note. Previously this was clamped to
    // rawDur*0.50 and made to finish BY t0+rawDur, which forced every
    // instrument's release — one of its biggest identity cues — down to
    // whatever fraction of the note's own length it could steal, erasing
    // the gap between e.g. piano's long pedal-ish tail and guitar's quicker
    // one. Release now scales with the instrument's own recipe and rings
    // out past note-off; oscillator/noise stop times below are extended to
    // match so the tail isn't cut off mid-ramp.
    const baseRel = isStacc && rec.staccato ? rec.staccato.r : rec.env.r;
    // 0.9s ceiling on the un-pedaled tail: generous enough that no current
    // recipe's natural release is anywhere near it (bells/chimes, the
    // longest at 0.55s, still ring fully) — it exists only to stop a badly
    // tuned or future recipe from re-creating the wash a 0.65s piano tail
    // (×3, once the unison voices are counted) caused here.
    const rel     = pedalOn ? Math.min(2.2, Math.max(baseRel, rawDur * 0.90)) : Math.min(baseRel, 0.9);

    const accentScale = isAccent  ? 1.28 : 1.0;
    const muteScale   = mutedMode ? 0.65 : 1.0;
    const peak   = Math.min(1.0, vel * rec.gain * accentScale * muteScale);
    const susLvl = peak * sus;

    // ── Master envelope ──────────────────────────────────────────────
    const env = ctx.createGain();

    // A slur is a request for CONNECTED articulation. Two physically
    // separate things ride on that:
    //   (1) continuous pitch-glide (portamento) — only real on instruments
    //       with continuously variable pitch (bow, slide, breath). This
    //       stays gated to rec.bowedString / rec.alwaysPortamento below,
    //       untouched.
    //   (2) soft, non-percussive onset — no re-strike transient, no bright
    //       attack sweep, note eases in rather than jumping from 0. This is
    //       achievable on essentially any pitched instrument (a slurred
    //       piano phrase, a hammer-on on guitar, a mallet roll are all
    //       "connected" in this sense even though none of them bend pitch)
    //       and was previously gated behind rec.legato — a flag only four
    //       categories had — so slurring a piano, guitar, organ, or mallet
    //       part did audibly nothing. Broadened to any instrument that
    //       isn't dominated by a percussive noise burst (drums/timpani,
    //       where "connected articulation" isn't a meaningful concept).
    const isLegatoCapable = !(rec.noise && rec.noise >= 0.10);
    const legatoNote = isSlurred && isLegatoCapable;

    if (legatoNote) {
      // Slur: start from sustain-ish level and ease up — softer onset than
      // a fresh attack, whether or not this instrument can also glide pitch.
      const slurStart = peak * sus;
      env.gain.setValueAtTime(slurStart, t0);
      env.gain.linearRampToValueAtTime(peak * 0.96, t0 + att * 0.4);
      if (dec > 0.001 && sus < 0.999) {
        env.gain.setTargetAtTime(susLvl, t0 + att * 0.4, dec / 3.5);
      }

    } else if (isTenuto) {
      // Tenuto: lean into the bow/breath — swell to 105% then settle.
      env.gain.setValueAtTime(0.0, t0);
      env.gain.linearRampToValueAtTime(peak * 1.05, t0 + att * 1.4);
      env.gain.setTargetAtTime(susLvl, t0 + att * 1.4, dec / 3.0);

    } else if (rec.bowedString) {
      // v9: Convex bow-grip onset — exponential-approach models bow hair
      // progressively finding and maintaining friction on the string.
      // At t0+att: gain ≈ peak × (1 − e⁻⁴) ≈ 0.982 × peak.
      env.gain.setValueAtTime(0.0, t0);
      env.gain.setTargetAtTime(peak, t0, att / 4.0);
      if (dec > 0.001 && sus < 0.999) {
        env.gain.setTargetAtTime(susLvl, t0 + att, dec / 3.5);
      }

    } else {
      // Standard linear attack (struck / plucked / blown instruments).
      env.gain.setValueAtTime(0.0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + att);
      if (dec > 0.001 && sus < 0.999) {
        env.gain.setTargetAtTime(susLvl, t0 + att, dec / 3.5);
      }
    }

    // What happens between the initial decay settling and the release is
    // where an instrument's energy source actually matters:
    //   sustains: true  (bow, breath, organ wind) — continuous energy really
    //     can hold a flat level for as long as the technique continues, so
    //     the gain is pinned at susLvl from note-off and only starts
    //     falling once release begins.
    //   sustains: false/unset (struck/plucked/mallet/bell/drum) — there's
    //     exactly one energy injection (the strike/pluck) and nothing after
    //     it, so the tone can only ever keep losing energy. Pinning it flat
    //     at susLvl (the old, shared behavior for every instrument) was
    //     wrong for these: on anything longer than a short note it produced
    //     attack → quick decay → a dead flat plateau for the rest of the
    //     note, i.e. exactly the sustained, unchanging tone that requires
    //     continuous input a plucked/struck string doesn't have. Instead,
    //     right after the initial decay settles, the curve is re-targeted
    //     toward silence with a slower time constant so it keeps gently and
    //     continuously fading for as long as the note lasts, flowing
    //     straight into the release tail with no seam and no flat hold.
    // exponentialRampToValueAtTime is undefined when starting from exactly 0
    // (Web Audio spec: value must be positive).  Instruments like Drums have
    // s:0.0 → susLvl=0; clamping to 0.0001 keeps the ramp numerically valid
    // while remaining perceptually silent (~−80 dBFS).
    const noteOff = t0 + rawDur;
    if (rec.sustains) {
      const holdTarget = noteOff > t0 + att + dec + 0.005;
      if (holdTarget) env.gain.setValueAtTime(Math.max(susLvl, 0.0001), noteOff);
      env.gain.exponentialRampToValueAtTime(0.0001, noteOff + rel + 0.001);
    } else {
      const decaySettled = t0 + att + dec;
      const fadeSpan = Math.max(0.05, (noteOff + rel) - decaySettled);
      env.gain.setTargetAtTime(0.0001, decaySettled, fadeSpan / 4.2);
    }
    const tailEnd = noteOff + rel + 0.02;

    // ── Primary filter (body resonance) ─────────────────────────────
    const filt = ctx.createBiquadFilter();
    filt.type            = rec.filter.type;
    filt.Q.value         = rec.filter.Q;
    filt.frequency.value = rec.filter.freq;

    const filterTarget = rec.brightnessByVel
      ? rec.filter.freq * (1.0 + (peak - 0.5) * rec.brightnessByVel)
      : rec.filter.freq;

    // Attack filter sweep: bright onset → settled body tone
    if (rec.filter.type === 'lowpass') {
      if (legatoNote) {
        filt.frequency.setValueAtTime(filterTarget, t0);
      } else {
        const brightMult = rec.bowedString ? 2.8 : 2.2;
        const brightFreq = Math.min(filterTarget * brightMult, 16000);
        filt.frequency.setValueAtTime(brightFreq, t0);
        filt.frequency.exponentialRampToValueAtTime(filterTarget, t0 + att + dec);
      }
    }
    if (rec.filter.type === 'bandpass' && !isSlurred) {
      filt.frequency.setValueAtTime(rec.filter.freq * 1.18, t0);
      filt.frequency.exponentialRampToValueAtTime(rec.filter.freq, t0 + att + dec);
    }

    env.connect(filt);
    let chainOut = filt;

    // ── Spectral decay shelf ─────────────────────────────────────────
    // Highshelf sweeps flat → −N dB over rawDur (highs die faster on struck strings)
    if (rec.spectralDecay) {
      const shelf = ctx.createBiquadFilter();
      shelf.type             = 'highshelf';
      shelf.frequency.value  = rec.spectralDecay.freq;
      shelf.gain.setValueAtTime(0, t0);
      shelf.gain.linearRampToValueAtTime(-rec.spectralDecay.db, t0 + rawDur);
      filt.connect(shelf);
      chainOut = shelf;
      _scheduled.push(shelf);
    }

    // ── Secondary resonance filter ───────────────────────────────────
    if (rec.filter2) {
      const f2 = ctx.createBiquadFilter();
      f2.type            = rec.filter2.type;
      f2.frequency.value = rec.filter2.freq;
      f2.Q.value         = rec.filter2.Q;
      if (rec.filter2.gain !== undefined) f2.gain.value = rec.filter2.gain;
      chainOut.connect(f2);
      chainOut = f2;
      _scheduled.push(f2);
    }

    // ── Tertiary resonance filter ────────────────────────────────────
    if (rec.filter3) {
      const f3 = ctx.createBiquadFilter();
      f3.type            = rec.filter3.type;
      f3.frequency.value = rec.filter3.freq;
      f3.Q.value         = rec.filter3.Q;
      if (rec.filter3.gain !== undefined) f3.gain.value = rec.filter3.gain;
      chainOut.connect(f3);
      chainOut = f3;
      _scheduled.push(f3);
    }

    // ── Con sord. / mute lowpass ─────────────────────────────────────
    if (mutedMode) {
      const mf = ctx.createBiquadFilter();
      mf.type            = 'lowpass';
      mf.frequency.value = 1800;
      mf.Q.value         = 0.55;
      chainOut.connect(mf);
      chainOut = mf;
      _scheduled.push(mf);
    }

    // ── Stereo panning (v9) ──────────────────────────────────────────
    // Piano: log-scale pitch pan. Strings: orchestra seating. Others: subtle spread.
    if (ctx.createStereoPanner) {
      let panValue = 0;
      if (inst === 'struck-strings') {
        // Map freq → pan: ln(freq/27.5) / ln(4186/27.5) × 1.6 − 0.8
        panValue = Math.log(freq / 27.5) / Math.log(4186 / 27.5) * 1.6 - 0.80;
        panValue = Math.max(-0.80, Math.min(0.80, panValue));
      } else if (inst === 'bowed-strings') {
        // We no longer know if a part is "violin" or "cello" by name — but
        // pitch is actually the right signal anyway. Approximate orchestral
        // seating (higher lines left, lower lines right) by register,
        // spanning roughly cello-low to violin-high.
        const t = Math.log(Math.max(55, Math.min(2000, freq)) / 55) / Math.log(2000 / 55);
        panValue = 0.22 - t * 0.44 + (Math.random() * 0.06 - 0.03);
      } else {
        panValue = (Math.random() * 0.16 - 0.08);
      }
      if (Math.abs(panValue) > 0.005) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = panValue;
        chainOut.connect(pan);
        pan.connect(_masterGain);
        _scheduled.push(pan);
      } else {
        chainOut.connect(_masterGain);
      }
    } else {
      chainOut.connect(_masterGain);
    }

    // ── Vibrato LFO ──────────────────────────────────────────────────
    // v9: secondary 0.28–0.38 Hz LFO modulates vibrato rate by ±7 %,
    // adding the organic per-cycle variation of a live player.
    let vibratoDepth = null;
    if (rec.vibrato && rawDur > 0.15) {
      const lfo    = ctx.createOscillator();
      vibratoDepth = ctx.createGain();
      lfo.type     = 'sine';
      lfo.frequency.value = rec.vibrato.rate;

      // Rate jitter sub-LFO
      const jLFO  = ctx.createOscillator();
      const jGain = ctx.createGain();
      jLFO.type   = 'sine';
      jLFO.frequency.value = 0.28 + Math.random() * 0.10;
      jGain.gain.value     = rec.vibrato.rate * 0.07;
      jLFO.connect(jGain);
      jGain.connect(lfo.frequency);

      vibratoDepth.gain.setValueAtTime(0, t0);
      vibratoDepth.gain.setTargetAtTime(
        freq * rec.vibrato.depth,
        t0 + rec.vibrato.delay,
        0.055
      );
      if (rawDur > rec.vibrato.delay + 0.06) {
        vibratoDepth.gain.setValueAtTime(freq * rec.vibrato.depth, t0 + rawDur - 0.05);
        vibratoDepth.gain.linearRampToValueAtTime(0, t0 + rawDur + 0.01);
      }

      lfo.connect(vibratoDepth);
      lfo.start(t0);   lfo.stop(tailEnd);
      jLFO.start(t0);  jLFO.stop(tailEnd);
      _scheduled.push(lfo, vibratoDepth, jLFO, jGain);
    }

    // ── Portamento (bowed strings + trombone) ────────────────────────
    const usePortamento = prevFreq && prevFreq > 0 && (
      (rec.bowedString && isSlurred) || rec.alwaysPortamento
    );
    const glideTime = usePortamento
      ? rec.alwaysPortamento
        ? Math.min(0.055, att * 0.9)
        : Math.min(0.018 + Math.abs(Math.log2(freq / prevFreq)) * 0.010, att * 0.35)
      : 0;

    // ── Additive harmonic partials ────────────────────────────────────
    // v9: instruments with unisonVoices spawn one oscillator set per voice.
    // Gain scales sum to 1.0 so attack peak equals single-voice output;
    // the slight detuning creates natural beating over sustained notes.
    // Instruments without unisonVoices use a single voice at gainScale 1.0.
    const voices = rec.unisonVoices
      || [{ detuneCents:0, atkOffset:0, gainScale:1.0 }];

    for (const p of rec.partials) {
      const B       = rec.inharmonicity || 0;
      const stretch = B > 0 ? Math.sqrt(1 + B * p.r * p.r) : 1;
      const pf      = freq * p.r * stretch;
      if (pf > 18000 || pf < 15) continue;

      for (const voice of voices) {
        const detuneRatio = Math.pow(2, (voice.detuneCents || 0) / 1200);
        const pfV = pf * detuneRatio;
        const t0V = t0 + (voice.atkOffset || 0);

        const osc = ctx.createOscillator();
        const pGn = ctx.createGain();
        osc.type  = 'sine';

        if (usePortamento && prevFreq > 0) {
          const pfPrev = prevFreq * p.r * stretch * detuneRatio;
          if (pfPrev > 15 && pfPrev < 18000) {
            osc.frequency.setValueAtTime(pfPrev, t0V);
            osc.frequency.exponentialRampToValueAtTime(pfV, t0V + glideTime);
          } else {
            osc.frequency.setValueAtTime(pfV, t0V);
          }
        } else {
          osc.frequency.setValueAtTime(pfV, t0V);
        }

        // Vibrato routes to ALL partials, scaled by partial ratio so that
        // partial N deviates N× as many Hz as partial 1 (physically correct).
        if (vibratoDepth) {
          const vScale = ctx.createGain();
          vScale.gain.value = p.r * stretch;
          vibratoDepth.connect(vScale);
          vScale.connect(osc.frequency);
          _scheduled.push(vScale);
        }

        pGn.gain.setValueAtTime(p.g * (voice.gainScale || 1.0), t0V);
        osc.connect(pGn);
        pGn.connect(env);

        osc.start(t0V);
        osc.stop(tailEnd);
        _scheduled.push(osc, pGn);
      }
    }

    // ── Noise component (bow / breath / drum) ────────────────────────
    // noise < 0.10 → sustaining (bow friction, breath): lives through the note.
    // noise ≥ 0.10 → percussive burst (drums, timpani): fast decay.
    // v9: bowed strings draw from the pink noise buffer (−3 dB/oct tilt).
    if (rec.noise && _noiseBuffer) {
      const noiseSrc = (rec.usePinkNoise && _pinkBuffer) ? _pinkBuffer : _noiseBuffer;
      const ns    = ctx.createBufferSource();
      const nGain = ctx.createGain();
      const nFilt = ctx.createBiquadFilter();

      ns.buffer  = noiseSrc;
      ns.loop    = true;
      nFilt.type = 'bandpass';
      nFilt.frequency.value = rec.noiseFreqMult
        ? Math.min(freq * rec.noiseFreqMult, 8000)
        : rec.filter.freq;
      nFilt.Q.value = 1.9;

      if (rec.noise < 0.10) {
        // Sustaining bow/breath noise — continuous through held note, then
        // rides the same note-off-anchored release as the main envelope.
        nGain.gain.setValueAtTime(0.0, t0);
        nGain.gain.linearRampToValueAtTime(rec.noise * peak, t0 + att);
        const noiseRelStart = Math.max(t0 + att, noteOff - 0.01);
        nGain.gain.setValueAtTime(rec.noise * peak * 0.80, noiseRelStart);
        nGain.gain.exponentialRampToValueAtTime(0.0001, noteOff + rel + 0.04);
      } else {
        // Percussive burst — always fast, unrelated to the sustain release.
        nGain.gain.setValueAtTime(0.0, t0);
        nGain.gain.linearRampToValueAtTime(rec.noise * peak, t0 + att);
        nGain.gain.exponentialRampToValueAtTime(0.0001, noteOff);
      }

      ns.connect(nFilt);
      nFilt.connect(nGain);
      nGain.connect(_masterGain);
      ns.start(t0);
      ns.stop(tailEnd);
      _scheduled.push(ns, nGain, nFilt);
    }

    // ── Attack transient (v9) ─────────────────────────────────────────
    // A 3–5 ms highpass-filtered noise burst models the physical impact impulse
    // (hammer / mallet / nail / plectrum on string or bar).  Bypasses the filter
    // chain — it's a broadband click, not shaped by the instrument body.
    // Skipped on legato notes: the hammer/pluck/mallet click is precisely
    // what makes an onset read as a fresh, separate strike — suppressing it
    // on a slurred note is a big part of what makes it sound connected
    // rather than re-articulated.
    if (rec.attackTransient && _noiseBuffer && !legatoNote) {
      const at  = ctx.createBufferSource();
      const atG = ctx.createGain();
      const atF = ctx.createBiquadFilter();
      const atr = rec.attackTransient;

      at.buffer         = _noiseBuffer;
      at.loop           = false;
      // Previously hardcoded to highpass/3500/0.7 for every instrument, so
      // a piano hammer strike and a guitar pick pluck — acoustically very
      // different transients (broadband felt thud vs. bright thin scrape)
      // — produced the literal same click, just at different volume/length.
      // That one shared sound is a big part of why struck and plucked
      // strings ended up indistinguishable. Each recipe now sets its own
      // filter character; unspecified falls back to the old default so
      // every other category is unaffected.
      atF.type          = atr.filterType || 'highpass';
      atF.frequency.value = atr.freq != null ? atr.freq : 3500;
      atF.Q.value       = atr.q != null ? atr.q : 0.7;

      atG.gain.setValueAtTime(atr.gain * peak, t0);
      atG.gain.exponentialRampToValueAtTime(0.0001, t0 + atr.decay);

      at.connect(atF);
      atF.connect(atG);
      atG.connect(_masterGain);
      at.start(t0);
      at.stop(t0 + atr.decay + 0.005);
      _scheduled.push(at, atG, atF);
    }

    _scheduled.push(env, filt);
  }

  // ─────────────────────────────────────────────────────────────────
  //  Score traversal  —  flatten one part into timestamped note events
  //
  //  Reads all app.js markings (unchanged from v8):
  //    part.slurs[]   { fromId, toId }
  //    note.articulations[]  'staccato','accent','tenuto','fermata','trill'
  //    note.staccato / note.tie / note.tremolo / note.dynamic
  //    inline: pedal, text (Capo N), text-mark (pizz./arco/con sord./senza sord.)
  //    inline: dynamic
  // ─────────────────────────────────────────────────────────────────

  function _flattenPart(part) {
    const E = window.MusicEngine;
    if (!E) return [];

    const inst = part.category
      || (part.state && part.state.category)
      || part.instrument
      || (part.state && part.state.instrument)
      || 'struck-strings';

    // ── Pre-process slurs ────────────────────────────────────────────
    const slurredIds = new Set();
    if (part.slurs && part.slurs.length) {
      const notes = (part.notes || []).filter(n => n.type === 'note');
      for (const { fromId, toId } of part.slurs) {
        const i0 = notes.findIndex(n => n._id === fromId);
        const i1 = notes.findIndex(n => n._id === toId);
        if (i0 === -1 || i1 === -1) continue;
        for (let i = i0 + 1; i <= i1; i++) slurredIds.add(notes[i]._id);
      }
    }

    const evts     = [];
    let beat       = 0;
    let dynCur     = 'mf';
    let pedalOn    = false;
    let capoFret   = 0;
    let pizzMode   = false;
    let mutedMode  = false;

    // ── Expand repeat barlines ─────────────────────────────────────────
    // 'repeat' tokens are classified as attr/non-consuming by E.isAttr()
    // (they don't occupy beat time), which is correct for notation layout
    // but means the note-flattening loop below would otherwise just skip
    // straight over them like any other silent marking — the section
    // never actually gets replayed. This walks the raw event list once
    // and produces a *playback order* (a list of indices into part.notes)
    // that repeats the span between a repeat-start (or the top of the
    // piece / previous repeat-end, if no explicit start was placed) and
    // each repeat-end. Nested/overlapping repeats aren't supported —
    // matches how they're authored in the editor (sequential, WYSIWYG
    // barlines) — but simple sequential repeats now actually repeat.
    function _expandRepeats(notes) {
      const order = [];
      let spanStart = 0;
      for (let i = 0; i < notes.length; i++) {
        const ev = notes[i];
        if (ev.type === 'repeat' && ev.direction === 'start') {
          spanStart = i + 1;
          continue;
        }
        if (ev.type === 'repeat' && ev.direction === 'end') {
          for (let k = spanStart; k < i; k++) order.push(k);
          spanStart = i + 1;
          continue;
        }
        order.push(i);
      }
      return order;
    }

    const partNotes  = part.notes || [];
    const playOrder  = _expandRepeats(partNotes);

    for (const _idx of playOrder) {
      const ev = partNotes[_idx];

      if (E.isAttr(ev) || ev.type === 'pedal' || ev.type === 'text'
          || ev.type === 'text-mark' || ev.type === 'dynamic') {

        if (ev.type === 'dynamic' && ev.dynamic) dynCur = ev.dynamic;
        if (ev.type === 'pedal')  pedalOn = (ev.pedal === 'down');

        if (ev.type === 'text' && ev.subtype === 'expression') {
          const m = ev.text && ev.text.match(/^Capo\s+(\d+)$/i);
          if (m) capoFret = parseInt(m[1]);
        }

        if (ev.type === 'text-mark') {
          const txt = (ev.text || '').toLowerCase().trim();
          if (txt === 'pizz.')        pizzMode  = true;
          if (txt === 'arco')         pizzMode  = false;
          if (txt === 'con sord.')    mutedMode = true;
          if (txt === 'senza sord.')  mutedMode = false;
        }

        continue;
      }

      const beats = E.beatOf(ev);

      if (ev.type === 'note') {
        const acc     = ev.accidental ?? ev.acc ?? null;
        const noteVel = dynVel(ev.dynamic || dynCur);
        const arts    = ev.articulations || [];

        const pitchList = Array.isArray(ev.pitches) && ev.pitches.length
          ? ev.pitches
          : [{ pitch:ev.pitch, accidental:acc, octave:ev.octave }];
        const freqs = pitchList.map(pi => {
          let f = soundingFreq(pi.pitch, pi.accidental ?? pi.acc ?? null, pi.octave, inst);
          if (capoFret > 0) f *= Math.pow(2, capoFret / 12);
          return f;
        });

        const isTied    = !!(ev.tie);
        const isSlurred = slurredIds.has(ev._id);
        const isStacc   = !!(ev.staccato || arts.includes('staccato'));
        const isAccent  = arts.includes('accent');
        const isTenuto  = arts.includes('tenuto');
        const isFermata = arts.includes('fermata');
        const isTrill   = arts.includes('trill');
        const tremolo   = ev.tremolo || 0;

        // Tie: extend previous note's duration instead of re-articulating
        if (isTied && evts.length > 0 && freqs.length === 1) {
          const freq = freqs[0];
          let merged = false;
          for (let i = evts.length - 1; i >= 0; i--) {
            if (Math.abs(evts[i].freq - freq) < 0.5) {
              evts[i].durBeats += beats;
              merged = true;
              break;
            }
          }
          if (merged) { beat += beats; continue; }
        }

        freqs.forEach(freq => {
          evts.push({
            inst, freq,
            startBeat: beat,
            durBeats:  beats,
            vel:       noteVel / Math.sqrt(freqs.length),
            isStacc, isAccent, isTenuto, isFermata, isTrill, tremolo,
            isSlurred, pedalOn, pizzMode, mutedMode,
            noteId: ev._id
          });
        });
      }

      beat += beats;
    }

    // Back-fill prevFreq for portamento (bowed strings + trombone)
    for (let i = 1; i < evts.length; i++) {
      // Match _scheduleNote's own lookup: evts[i].inst may be a legacy
      // display name ("Violin", "Trombone", ...) rather than a category
      // id, and RCP is keyed by category id. Looking it up directly
      // (without the legacy fallback) silently returned undefined for
      // legacy-named parts, so isSlurred notes on those parts never got
      // prevFreq set and lost their portamento glide — one more way
      // slurs stopped audibly doing anything.
      const r = RCP[evts[i].inst] || RCP[LEGACY_INSTRUMENT_TO_CATEGORY[evts[i].inst]];
      if (evts[i].isSlurred || (r && r.alwaysPortamento)) {
        evts[i].prevFreq = evts[i - 1].freq;
      }
    }

    // ── Expand tremolo / trill ────────────────────────────────────────
    //   tremolo 1 → 8th subdivisions (2/beat)
    //   tremolo 2 → 16th            (4/beat)
    //   tremolo 3 → 32nd            (8/beat)
    //   trill     → ~16 alternations/beat
    const expanded = [];
    for (const e of evts) {
      if (!e.tremolo && !e.isTrill) { expanded.push(e); continue; }

      const subdivPerBeat = e.tremolo === 1 ? 2 :
                            e.tremolo === 2 ? 4 :
                            e.tremolo === 3 ? 8 : 9;

      const totalDur = e.durBeats;
      let count, subDur;

      if (e.isTrill) {
        count  = Math.max(4, Math.round(totalDur * 16));
        subDur = totalDur / count;
      } else {
        subDur = 1 / subdivPerBeat;
        count  = Math.max(2, Math.round(totalDur / subDur));
        subDur = totalDur / count;
      }

      for (let i = 0; i < count; i++) {
        const trillFreq = (e.isTrill && i % 2 === 1)
          ? e.freq * Math.pow(2, 2/12)   // whole step up
          : e.freq;

        expanded.push({
          ...e,
          freq:      trillFreq,
          startBeat: e.startBeat + i * subDur,
          durBeats:  subDur,
          isStacc:   true,
          isTrill:   false,
          tremolo:   0
        });
      }
    }

    return expanded;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────────────

  /**
   * stop() — fades master gain in 40 ms then cleans up all nodes.
   */
  function stop() {
    _isPlaying = false;
    clearInterval(_tickTimer);
    clearTimeout(_stopTimer);

    if (_masterGain && _ctx) {
      const now = _ctx.currentTime;
      _masterGain.gain.cancelScheduledValues(now);
      _masterGain.gain.setValueAtTime(0.80, now);
      _masterGain.gain.linearRampToValueAtTime(0.0, now + 0.04);
    }

    const toClean = _scheduled.splice(0);
    setTimeout(() => {
      toClean.forEach(n => {
        try { n.stop(_ctx ? _ctx.currentTime : 0); } catch (_) {}
        try { n.disconnect();                       } catch (_) {}
      });
      if (_masterGain && _ctx) {
        _masterGain.gain.setValueAtTime(0.80, _ctx.currentTime);
      }
    }, 80);
  }

  /**
   * previewNote(pitch, acc, octave, instrument, duration)
   * Plays a single short preview note immediately (editor note click).
   */
  function previewNote(pitch, acc, octave, instrument, _duration) {
    const ctx = getCtx();
    const t   = ctx.currentTime + 0.02;
    _scheduleNote(ctx, instrument, soundingFreq(pitch, acc, octave, instrument),
      t, 0.55, 0.55,
      false, false, false, false, 0, false, false, false, false);
  }

  /**
   * play(parts, options)
   *
   * parts   — raw parts array from app.js state
   *           Each part: { instrument, notes:[], slurs:[], timeSig, ... }
   *
   * options — { bpm: number, onTick: fn(beat), onEnd: fn() }
   *           Also accepts a plain number (bpm) or function (onTick)
   *           for backward compatibility.
   */
  function play(parts, options) {
    if (_isPlaying) stop();

    const ctx    = getCtx();
    const bpm    = (typeof options === 'number' ? options : options?.bpm) || 120;
    const onTick = typeof options === 'function' ? options : options?.onTick;
    const onEnd  = options?.onEnd;
    const spb    = 60 / bpm;
    const t0     = ctx.currentTime + 0.10;

    _isPlaying = true;
    _scheduled = [];

    _masterGain.gain.cancelScheduledValues(t0);
    _masterGain.gain.setValueAtTime(0.80, t0);

    let totalBeats = 0;

    for (const part of parts) {
      const evts = _flattenPart(part);
      for (const ev of evts) {
        _scheduleNote(
          ctx,
          ev.inst,
          ev.freq,
          t0 + ev.startBeat * spb,
          ev.durBeats * spb,
          ev.vel,
          ev.isStacc,
          ev.isAccent,
          ev.isTenuto,
          ev.isSlurred,
          ev.prevFreq   || 0,
          ev.isFermata  || false,
          ev.pedalOn    || false,
          ev.pizzMode   || false,
          ev.mutedMode  || false
        );
        const end = ev.startBeat + ev.durBeats;
        if (end > totalBeats) totalBeats = end;
      }
    }

    if (onTick) {
      _tickTimer = setInterval(() => {
        if (!_isPlaying) return;
        onTick(Math.max(0, (ctx.currentTime - t0) / spb));
      }, 80);
    }

    const totalMs = (totalBeats * spb + 2.5) * 1000;
    _stopTimer = setTimeout(() => {
      _isPlaying = false;
      clearInterval(_tickTimer);
      if (onEnd) onEnd();
    }, totalMs);
  }

  // ─────────────────────────────────────────────────────────────────
  //  Exports
  // ─────────────────────────────────────────────────────────────────

  return {
    getCtx,
    play,
    stop,
    previewNote,
    isPlaying: () => _isPlaying,
    noteFreq
  };

})();