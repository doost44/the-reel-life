// The reel face's look: every setting the look editor (/look) tunes. The
// Chrome version's copy of eye/look.py: change both together.
//
// Each setting has two values, one for the first reels and one for the full
// face, and the face slides from one to the other as it forms.

// name, label, lowest, highest, step, first reels, full face, what it does
const SETTINGS = [
  ['Energy', [
    ['energy_size', 'Shard size', 0.2, 3, 0.01, 1, 1, 'How big the shards are (they also follow Fragment size)'],
    ['energy_pull', 'Pull', 0.1, 3, 0.01, 1, 1, 'How much of the cloud each fragment pulls in: more uses it up sooner'],
    ['energy_mix', 'Mixing', 0, 1, 0.01, 0.85, 0.85, "How far a shard crossing the face takes on the face's own picture"],
    ['energy_crumble', 'Crumbling', 0, 1, 0.01, 0.8, 0.5, "How much the face's edges break up into blocks like the shards"],
    ['energy_shed', 'Shedding', 0, 3, 0.01, 1, 1, 'How fast the face sheds shards back into the cloud'],
    ['energy_flow', 'Flow', 0, 3, 0.01, 1, 1, 'How fast it flows'],
    ['energy_spread', 'Spread', 0.3, 2, 0.01, 1, 1, 'How far it reaches round the person'],
    ['energy_colour', 'Colour', 0, 1, 0.01, 0.65, 0.65, 'From white and grey (0) to full colour (1)'],
    ['energy_glow', 'Brightness', 0, 2, 0.01, 1, 1, 'How bright it burns (it also brightens as people come closer)'],
  ]],
  ['Formation', [
    ['fragments', 'Fragments per reel', 1, 40, 1, 3, 14, 'How many pieces each reel breaks into'],
    ['fragment_size', 'Fragment size', 0.03, 0.6, 0.01, 0.32, 0.08, 'How big each piece is, as a share of the face'],
    ['jagged', 'Torn edges', 0, 1, 0.01, 0.35, 0.8, "How ragged each piece's outline is"],
    ['faint', 'Faintness', 0, 1, 0.01, 0.55, 0.0, 'How see-through the pieces are'],
    ['likeness', 'Likeness', 0, 1, 0.01, 0.45, 0.9, "How much of the live face's light and dark the reels take"],
    ['findable', 'Eyes and mouth', 0, 1, 0.01, 0.85, 0.7, 'How clearly the eyes and mouth come through, live and spared the damage'],
  ]],
  ['Liquid', [
    ['melt', 'Melt', 0, 1, 0.01, 0.05, 0.45, "The face's shape flowing like liquid"],
    ['flow', 'Flow', 0, 1, 0.01, 0.1, 0.7, 'How far the picture is dragged along, block by block (datamosh)'],
    ['flow_speed', 'Flow speed', 0, 1, 0.01, 0.3, 0.6, 'How fast the flow drifts'],
    ['flow_scale', 'Swirl size', 0, 1, 0.01, 0.5, 0.35, 'Big slow swirls (1) or small busy ones (0)'],
    ['block', 'Block size (px)', 2, 48, 1, 8, 16, "The datamosh's squares"],
    ['mosh', 'Trails', 0, 0.98, 0.01, 0.3, 0.88, 'How long the old picture hangs on and smears'],
  ]],
  ['Pixels', [
    ['pixelate', 'Pixel size (px)', 1, 24, 1, 1, 4, 'Everything in chunky pixels'],
    ['jpeg', 'JPEG damage', 0, 1, 0.01, 0.1, 0.8, "JPEG's squares and banding; each new reel saved worse"],
    ['stretch', 'Stretched rows', 0, 1, 0.01, 0.0, 0.35, 'Short runs of pixels smeared sideways'],
    ['bleed', 'Colour bleed', 0, 1, 0.01, 0.0, 0.5, 'Colours split and run'],
  ]],
  ['Light and colour', [
    ['gloss', 'Gloss lines', 0, 1, 0.01, 0.15, 0.6, 'Bright lines where the surface ripples, like wet wax'],
    ['heat', 'Heat colour', 0, 1, 0.01, 0.0, 0.35, 'Towards orange, yellow and green, like a heat camera'],
    ['flush', 'Flush', 0, 1, 0.01, 0.1, 0.5, 'The fever of wanting more (grows with desire too)'],
  ]],
  ['Breaking', [
    ['fracture', 'Fracture', 0, 1, 0.01, 0.0, 0.4, 'Pieces pulled apart and sliding'],
    ['holes', 'Holes', 0, 1, 0.01, 0.0, 0.15, 'Pieces missing'],
    ['drip', 'Dripping edges', 0, 1, 0.01, 0.1, 0.6, 'The outline breaking into blobs and drips'],
  ]],
  ['Hair and ears', [
    ['hair', 'Show hair and ears', 0, 1, 0.01, 0.9, 1.0, 'How much of the hair and ears comes through; 0 at both ends switches them off'],
    ['hair_fragments', 'Fragments per reel', 0, 40, 1, 10, 10, 'How many pieces of each reel land on the head round the face, for the hair and ears'],
    ['hair_size', 'Fragment size', 0.03, 0.6, 0.01, 0.4, 0.18, 'How big each piece is, as a share of the face'],
    ['hair_likeness', 'Likeness', 0, 1, 0.01, 0.35, 0.7, "How much of the real hair's light and dark the reels take"],
  ]],
];

// The effects, and their value when switched off (the look editor's solo).
const OFF = {
  melt: 0, flow: 0, mosh: 0, pixelate: 1, jpeg: 0, stretch: 0, bleed: 0,
  gloss: 0, heat: 0, flush: 0, fracture: 0, holes: 0, drip: 0,
};

export function defaultLook() {
  const values = {};
  for (const [, group] of SETTINGS) for (const [name, , , , , start, full] of group) values[name] = [start, full];
  return { values, background: '', presets: {} };
}

// A look with every setting there (an older one may miss newer settings).
export function completeLook(look) {
  const full = defaultLook();
  if (!look || typeof look !== 'object' || Array.isArray(look)) return full;
  const values = { ...full.values };
  for (const [name, value] of Object.entries(look.values ?? {})) if (name in full.values) values[name] = value;
  return { ...full, ...look, values };
}

// A setting's value this far into the face forming.
export function lookValue(look, name, progress) {
  const [start, end] = look.values[name];
  return start + (end - start) * Math.min(1, Math.max(0, progress));
}

// The settings, as the look editor shows them.
export function describedLook() {
  return SETTINGS.map(([group, settings]) => ({
    group,
    settings: settings.map(([name, label, min, max, step, start, full, help]) => ({
      name, label, min, max, step, default: [start, full], off: OFF[name] ?? null, help,
    })),
  }));
}
