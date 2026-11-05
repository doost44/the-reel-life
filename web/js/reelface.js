// The reel face: the participant's own face, live. MediaPipe tracks them on the
// face camera every frame (tracker.js), and the face is drawn from their live
// points, so it turns, tilts, blinks and looks where they do. It is never a
// stored model and never moves by itself: if tracking is lost it holds the
// last pose and says so.
//
// It follows the journey (journey.py). Before any face there's only the energy:
// shattered, pixelated particles that burst to life when someone moves in front
// of the camera, follow them, brighten as they come closer, and pulse with each
// word the oracle says (swarm.js). There is never any sign of the tracker. Once
// reels are being watched the face forms out of tiles of reels (formation.py), and
// out of the energy: each tile the eye releases pulls the nearest shards out of the
// cloud and grows on its patch of the face as they fly in. The two aren't layers:
// the shards weave through the head in depth, take on the face's picture where they
// cross it, its edges crumble into the same blocks, and it sheds shards back. The tiles
// take their light and dark from the participant's live face, more as it
// forms, so the likeness sharpens; the eyes and mouth come through live, so
// they're always findable. Where no tile has landed there's no face at all.
//
// Its look (look.py, tuned in the look editor at /look) slides from the
// first reels' values to the full face's as it forms:
//
//   formation   the fragments' faintness and how much of the live face's
//               light and dark they take
//   liquid      the shape melting; the picture dragged along a slow swirl,
//               block by block, the old picture hanging on in trails (datamosh)
//   pixels      chunky pixels, JPEG's squares and banding, stretched rows,
//               colours split
//   light       wet gloss lines, a heat camera's colours, desire's flush
//   breaking    pieces sliding apart, pieces missing, the edges dripping
//
// The tracker's points stop at the edge of the face, so the hair and ears are
// a shape in 3D round it, moved by those same points on every new picture, so
// it turns and tilts with the face: fragments on a second layout (eye:
// formation.py), shown only where a second model finds this person's hair and
// skin on the live picture (segmenter.js), so the outline is always theirs. It
// melts with the face and takes the same damage.
//
// When the face is complete it becomes the person, then everything fractures,
// fast, with a scream (scream.js). After a few dark seconds their face comes
// back, a still, with a code to take it away.

import { MotionSensor } from './presence.js';
import { scream } from './scream.js';
import { HeadSegmenter } from './segmenter.js';
import { FaceVoice, mouthShape } from './speech.js';
import { EnergySwarm, SHARD_VALUES, SHARDS_DRAWN } from './swarm.js';
import { FaceTracker } from './tracker.js';

export const FACE_VIEW = '@face'; // the face camera's picture, from the eye

export const REEL_FACE_DEFAULTS = { background: '#b4b1ab', shade: 40, fill: 60, size: 40, font: 'Consolas', color: '#141414' };

const LOST_AFTER = 500; // ms without a face: tracking lost, hold the last pose
const ATLAS = 1024;     // the size in pixels of each layout (face, head), as the eye plans tiles for them (formation.py)
const HEAD_DROP = 0.12; // with hair showing, how far the face sits below the frame's middle, in face heights, to centre the head
// The head layout (formation.py has the same numbers): the head as seen from the front, running this many
// face heights each way from the face's middle, so fragments keep their shape wherever they land; and a patch
// for each ear (x, y, width, height), below the rest.
const HEAD_REACH = 1.2;
const EAR_PATCHES = [[0.02, 0.87, 0.30, 0.12], [0.68, 0.87, 0.30, 0.12]];
// The head's depth, in face heights: a dome the size of a head, flat behind it out to the layout's edge. It
// only gives the fragments something to turn on: a closed shape here cut hair off at its edge, like a helmet,
// so the outline is left entirely to the model.
const DOME = { up: 0.05, back: -0.3, across: 0.62, tall: 0.9, deep: 0.6 };
const HEAD_SQUARES = 40; // each way in its mesh, so it can turn and melt
const EAR_ROWS = 6, EAR_COLUMNS = 4;
const HEAD_VERTICES = HEAD_SQUARES * HEAD_SQUARES * 6;
const EAR_VERTICES = 2 * EAR_ROWS * EAR_COLUMNS * 6;
// Which way is up on the face: from these points (they don't move when the mouth opens), and how far
// that leans back from true up, on MediaPipe's model face (radians); and which points show which way is across.
const UP_FROM = [10, 2], UP_LEANS = 0.1507;
const ACROSS_PAIRS = [[454, 234], [356, 127], [389, 162], [251, 21]];
const POSE_EASE = 0.6;  // how far each new picture moves the head's pose: a little easing, or the mesh trembles
const EARS_FROM = 0.22; // skin is kept from this far above the chin, in face heights: the ears, not the neck
const ARRIVAL = 2000;   // ms a tile takes to grow in, at the most, whether or not the shards it pulled have reached it
const REPORT_EVERY = 1000; // ms between telling the eye someone is still there
const SHARD_POINTS = 9; // points round a shard's torn edge
const ORACLE_LETTER_MS = 88; // roughly how long the oracle's voice takes over a letter
// Everything that breaks the picture, which clears as the face becomes the person.
const DAMAGE = ['melt', 'flow', 'mosh', 'jpeg', 'stretch', 'bleed', 'gloss', 'heat', 'flush', 'fracture', 'holes', 'drip', 'faint'];
const REBUILD_AFTER = 120; // ms after a burst of tiles (or a scrub) before the face is redrawn, once
const DECODE_AT_ONCE = 24; // tile pictures decoded together while redrawing

// The eyes, brows and mouth (MediaPipe's numbering): kept findable, from the live camera.
const FEATURES = new Set([
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
  70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276,
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
]);
// Where the face is measured from: the top of the forehead, the chin, and its sides.
const TOP = 10, CHIN = 152, SIDES = [234, 454];
// The mouth: the inner lips (the mouth's opening), the lips' middles, and the eyelids.
const UPPER_INNER = [191, 80, 81, 82, 13, 312, 311, 310, 415];
const LOWER_INNER = [95, 88, 178, 87, 14, 317, 402, 318, 324];
const INNER_LIPS = new Set([78, 308, ...UPPER_INNER, ...LOWER_INNER]);
const LIDS = [
  { up: [159, 158, 157, 160, 161], down: [145, 144, 153, 163, 154] },
  { up: [386, 385, 384, 387, 388], down: [374, 373, 380, 390, 381] },
];
const OPEN_JAW = 0.09;   // how far the jaw drops on an open vowel, in face heights
const WIDE_EYES = 0.016; // how much wider the eyes open at full desire

// MediaPipe's face layout: which points make each triangle, and where each
// corner sits on the reel skin. Loaded once, shared by every reel face.
let layout = null;
fetch('/vendor/mediapipe/canonical_face_model.obj')
  .then((response) => response.text())
  .then((text) => { layout = parseLayout(text); })
  .catch((error) => console.error('The face layout could not load:', error));

function parseLayout(text) {
  const places = [];
  const corners = [];
  const uvs = [];
  const model = []; // MediaPipe's model face: where each point sits on an average face (y up)
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') model.push(parts.slice(1, 4).map(Number));
    else if (parts[0] === 'vt') places.push([Number(parts[1]), 1 - Number(parts[2])]);
    else if (parts[0] === 'f') {
      for (const corner of parts.slice(1, 4)) {
        const [point, place] = corner.split('/').map(Number);
        corners.push(point - 1);
        uvs.push(place - 1);
      }
    }
  }
  const atlas = new Float32Array(corners.length * 2);
  uvs.forEach((place, i) => atlas.set(places[place], i * 2));
  return { corners: Uint16Array.from(corners), atlas, jaw: jawWeights(model) };
}

// How much each point of the face moves when the jaw drops: everything below
// the mouth, most in the middle, nothing at the sides of the face.
function jawWeights(model) {
  const mouth = (model[13][1] + model[14][1]) / 2;
  const middle = (model[234][0] + model[454][0]) / 2;
  const half = Math.abs(model[454][0] - model[234][0]) / 2;
  return model.map(([x, y], point) => {
    if (UPPER_INNER.includes(point) || y > mouth + 0.05) return 0;
    const across = Math.max(0, 1 - Math.abs(x - middle) / (half * 0.9));
    return across ** 1.5;
  });
}

// Melt: the shape swims like liquid, slow waves running through it. The face
// and the hair share it, so they melt as one.
const MELT = `
vec2 melted(vec2 p, float melt, float time) {
  p.x += melt * 0.08 * sin(p.y * 6.0 + time * 1.3 + sin(p.x * 4.0 + time * 0.7));
  p.y += melt * 0.06 * cos(p.x * 5.0 - time * 1.1 + sin(p.y * 3.0 - time * 0.5));
  return p;
}`;

// Heat: light and dark mapped to a heat camera's orange, yellow and green.
// Then desire's feverish flush.
const FEVER = `
vec3 feverish(vec3 c, float heat, float flush, float desire) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 hot = l < 0.5 ? mix(vec3(0.35, 0.06, 0.02), vec3(1.0, 0.45, 0.08), l * 2.0)
                     : mix(vec3(1.0, 0.45, 0.08), vec3(0.85, 1.0, 0.45), l * 2.0 - 1.0);
  c = mix(c, hot, heat);
  return mix(c, c * vec3(1.18, 0.86, 0.84), flush * (0.4 + 0.6 * desire));
}`;

// Whether this pixel has crumbled away: the same flickering squares as the shards,
// more of them towards a fragment's edge (inside: how far in it is, from a blurred
// copy of the layout), so the fragments have no clean edge to sit on the energy with.
const CRUMBLE = `
bool crumbled(float inside, float amount, float time) {
  if (amount <= 0.0) return false;
  vec2 cell = floor(gl_FragCoord.xy / 12.0);
  float n = fract(sin(dot(cell, vec2(127.1, 311.7)) + floor(time * 3.0 + fract(cell.x * 0.37) * 3.0)) * 43758.5453);
  return n < amount * (1.0 - smoothstep(0.35, 0.95, inside));
}`;

const HEAD_VERTEX = `#version 300 es
in vec3 position;
in vec2 atlasUv;
in vec3 normal;
in vec2 imageUv;
in float feature;
in vec3 facet;   // the direction this triangle comes away in on its own
in vec4 shard;   // the direction its fragment comes away in, and which fragment (w; -1: none)
in float inner;  // 1 on the inner lips: the inside of the mouth when it opens
uniform mat4 projection;
uniform float time;
uniform float fracture;
uniform float melt;
uniform float ghost;
uniform float shatter;    // the climax: everything flying apart
out vec2 vAtlas;
out vec2 vImage;
out vec3 vNormal;
out float vFeature;
out float vSeed;
out float vInner;
${MELT}
void main() {
  vInner = inner;
  float seed = shard.w;
  float piece = step(0.0, seed);
  float slide = 0.65 + 0.35 * sin(time * 0.45 + seed * 37.0);
  // Fracture pulls whole fragments apart, each sliding its own way; inside one, the
  // triangles only crack (hairline), so a fragment stays one readable piece of reel.
  vec3 p = position + fracture * (slide * piece * shard.xyz * 0.1 + facet * 0.003);
  p += shatter * (piece * shard.xyz * 1.6 + facet * 0.9);
  p.xy = melted(p.xy, melt, time);
  p += ghost * vec3(0.16 * sin(seed * 17.0 + time * 0.2), 0.06 * cos(seed * 11.0), 0.05);
  vAtlas = atlasUv;
  vImage = imageUv;
  vNormal = normal;
  vFeature = feature;
  vSeed = seed;
  gl_Position = projection * vec4(p, 1.0);
}`;

const HEAD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vAtlas;
in vec2 vImage;
in vec3 vNormal;
in float vFeature;
in float vSeed;
in float vInner;
uniform float time;
uniform float desire;      // 0 to nearly 1: how much the face wants
uniform float pulse;       // its heartbeat, 0-1 through each beat
uniform float mouthOpen;   // the words it's saying, 0-1
uniform sampler2D camera;
uniform sampler2D reels;
uniform float faint;       // how see-through the fragments are
uniform float likeness;    // how much of the live face's light and dark the reels take
uniform float faceLight;   // the live face's average brightness, so a dim room still gives a readable face
uniform float shade;
uniform float bleed;       // fragments in mismatched tones
uniform float flush;
uniform float heat;
uniform float holes;
uniform float ghost;
uniform float doubled;
uniform float findable;    // how clearly the eyes and mouth come through
uniform float becoming;    // the climax: how far the face has become the person
uniform float crumble;     // how much its edges break up into blocks, like the shards
layout(location = 0) out vec4 colour;
layout(location = 1) out vec4 marks;  // where the eyes and mouth are, so the damage spares them
float hash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
${CRUMBLE}
${FEVER}
void main() {
  if (crumbled(textureLod(reels, vAtlas, 3.5).a, crumble * (1.0 - becoming), time)) discard;
  bool piece = vSeed >= 0.0;
  if (piece && hash(vSeed + 0.5) < holes) discard;                        // gone
  if (ghost > 0.0 && (!piece || hash(vSeed + 1.5) > doubled)) discard;    // only some pieces are doubled
  vec4 reel = texture(reels, vAtlas);
  float coverage = mix(reel.a, 1.0, becoming) * (1.0 - faint);  // where no fragment has landed, nothing
  if (coverage < 0.01) discard;
  vec3 live = clamp(texture(camera, vImage).rgb * (0.5 / max(faceLight, 0.08)), 0.0, 1.0);  // evened out
  // The reels, toned by the live face: its light and dark, their colour and texture.
  float face = dot(live, vec3(0.299, 0.587, 0.114));
  float tile = dot(reel.rgb, vec3(0.299, 0.587, 0.114));
  vec3 c = mix(reel.rgb, reel.rgb * clamp((face + 0.04) / (tile + 0.04), 0.0, 2.5), likeness);
  c = mix(c, live, findable * vFeature);  // the eyes and mouth come through live: always findable
  vec3 kept = c;
  if (piece) {
    vec3 tone = vec3(hash(vSeed + 2.5), hash(vSeed + 3.5), hash(vSeed + 4.5)) - 0.5;
    c *= 1.0 + bleed * (tone * 0.35 + (hash(vSeed + 5.5) - 0.5) * 0.5);
  }
  c = feverish(c, heat, flush, desire);
  // A pulse through the fragments that quickens and shimmers as desire rises.
  float beat = pulse * (0.05 + 0.15 * desire) * (0.6 + 0.8 * hash(vSeed + 7.5));
  float shimmer = desire * 0.07 * sin(time * (8.0 + 14.0 * desire) + vSeed * 13.0);
  c *= 1.0 + beat + shimmer;
  c = mix(c, kept, 0.75 * findable * vFeature);  // ...through all of that too
  c = mix(c, live, becoming);
  c *= 1.0 - 0.85 * mouthOpen * vInner;  // the mouth open on its words: dark inside
  float light = 0.6 + 0.4 * max(dot(normalize(vNormal), normalize(vec3(-0.35, 0.4, 1.0))), 0.0);
  colour = vec4(clamp(c * mix(1.0, light, shade), 0.0, 1.0), coverage * (ghost > 0.0 ? 0.6 : 1.0));
  marks = vec4(findable * vFeature, 0.0, 0.0, colour.a);
}`;

// The hair and ears: a shape in 3D behind the face, turned by the tracked points.
const HAIR_VERTEX = `#version 300 es
in vec3 corner;      // on the head: face heights from the face's middle, upright and facing forwards
in vec2 layoutUv;    // where its fragments are on the head layout
in float isEar;      // 1 on the ears' patches
uniform mat4 projection;
uniform vec3 headAcross;  // the head's pose: its axes, on the frame
uniform vec3 headUp;
uniform vec3 headForward;
uniform float melt;
uniform float time;
uniform float shatter;
out vec2 vLayout;
out vec2 vPlace;
out float vHeight;
out float vEar;
${MELT}
void main() {
  vec3 p = headAcross * corner.x + headUp * corner.y + headForward * corner.z;
  vPlace = p.xy;
  vHeight = corner.y;
  vLayout = layoutUv;
  vEar = isEar;
  gl_Position = projection * vec4(melted(p.xy, melt, time) * (1.0 + shatter * 1.5), p.z, 1.0);
}`;

const HAIR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLayout;
in vec2 vPlace;
in float vHeight;
in float vEar;
uniform sampler2D camera;
uniform sampler2D reels;
uniform sampler2D shape;   // where the hair (red) and skin (green) are, on the picture it was found in
uniform vec2 flatUp;       // which way is up on the frame, now and in that picture, so the shape tilts with the head
uniform vec2 shapeFlatUp;
uniform vec4 head;         // where the head is on the camera's picture: its middle, then one face height across and down
uniform vec4 shapeHead;    // ...and on the picture the shape was found in, so it follows the head between looks
uniform float earsFrom;    // skin is kept above this height: the ears, not the neck
uniform float shown;
uniform float faint;
uniform float likeness;
uniform float faceLight;
uniform float hairLight;   // the hair's average brightness, so dark hair still shows its light and dark
uniform float becoming;    // the climax: how far it has become the person
uniform float crumble;
uniform float time;
uniform float heat;
uniform float flush;
uniform float desire;
layout(location = 0) out vec4 colour;
layout(location = 1) out vec4 marks;
${CRUMBLE}
${FEVER}
void main() {
  if (crumbled(textureLod(reels, vLayout, 3.5).a, crumble * (1.0 - becoming), time)) discard;
  vec2 upright = vec2(dot(vPlace, vec2(flatUp.y, -flatUp.x)), dot(vPlace, flatUp));
  vec2 onShape = shapeHead.xy - (vec2(shapeFlatUp.y, -shapeFlatUp.x) * upright.x + shapeFlatUp * upright.y) * shapeHead.zw;
  if (any(lessThan(onShape, vec2(0.0))) || any(greaterThan(onShape, vec2(1.0)))) discard;  // off the camera's picture
  vec4 found = texture(shape, onShape);
  float skin = found.g * smoothstep(0.0, 0.06, vHeight - earsFrom);
  float kept = smoothstep(0.3, 0.7, vEar > 0.5 ? skin : max(found.r, skin));  // an ear is only ever skin
  vec4 reel = texture(reels, vLayout);
  float coverage = mix(reel.a, 1.0, becoming) * kept * shown * (1.0 - faint);  // no fragment here, or not hair: nothing
  if (coverage < 0.01) discard;
  // Evened out as the face is, each by its own brightness: hair is usually far darker than skin.
  float light = found.r > 0.5 ? max(hairLight, 0.06) : max(faceLight, 0.08);
  vec3 live = clamp(texture(camera, head.xy - vPlace * head.zw).rgb * (0.5 / light), 0.0, 1.0);
  float hair = dot(live, vec3(0.299, 0.587, 0.114));
  float tile = dot(reel.rgb, vec3(0.299, 0.587, 0.114));
  vec3 c = mix(reel.rgb, reel.rgb * clamp((hair + 0.04) / (tile + 0.04), 0.0, 2.5), likeness);
  colour = vec4(mix(clamp(feverish(c, heat, flush, desire), 0.0, 1.0), clamp(live * 0.6, 0.0, 1.0), becoming), coverage);
  marks = vec4(0.0, 0.0, 0.0, coverage);  // not spared the damage
}`;

// The energy's shards: torn by the same rules as the face's fragments
// (formation.py), so the cloud and the face are visibly the same stuff.
const SHARD_VERTEX = `#version 300 es
in vec2 rim;      // which point of its edge this is, and 1 on the edge, 0 at its middle
in vec4 place;    // where it is, its size and its light
in vec3 shape;    // the way it's turned, how stretched, and its own random number
in vec3 tint;
in float depth;   // how far in front of or behind the middle of the head
uniform mat4 projection;
uniform float time;
uniform float jagged;
out vec2 vLocal;
out vec3 vTint;
out float vLight;
out float vSeed;
float hash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
void main() {
  float seed = shape.z;
  float turn = 6.2832 * (rim.x + 0.7 * (hash(seed * 13.0 + rim.x) - 0.5)) / ${SHARD_POINTS}.0;
  float reach = 1.0 - jagged * 0.55 * hash(seed * 7.0 + rim.x * 3.1);
  if (hash(seed * 3.0 + rim.x * 5.7) < jagged * 0.25) reach *= 1.35;  // a spike
  reach *= 1.0 + 0.15 * sin(time * 2.2 + seed * 40.0 + rim.x * 1.7);   // never quite still
  vec2 q = vec2(cos(turn), sin(turn)) * reach * rim.y;
  vLocal = q;
  q *= vec2(shape.y, 1.0 / shape.y);
  float c = cos(shape.x), s = sin(shape.x);
  vec2 p = place.xy + mat2(c, s, -s, c) * q * place.z;
  vTint = tint;
  vLight = place.w;
  vSeed = seed;
  gl_Position = projection * vec4(p, depth, 1.0);
}`;

const SHARD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vTint;
in float vLight;
in float vSeed;
uniform float time;
uniform float saturation;
out vec4 colour;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  if (vLight < 0.004) discard;
  // A piece of a broken JPEG: smaller squares inside it, flickering.
  vec2 cell = floor(vLocal * (2.0 + floor(vSeed * 4.0)));
  float n = hash(cell + vSeed * 91.0 + floor(time * 6.0 + vSeed * 20.0));
  float light = vLight * (0.35 + 0.65 * n);
  colour = vec4(mix(vec3(light), vTint * light * 1.6, saturation), vLight * (0.4 + 0.6 * n));
}`;

const QUAD_VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

// The picture's damage, from the face drawn on its own (scene) and the last
// frame's result (previous): a liquid datamosh. The picture flows along a
// slowly drifting swirl, block by block, dragging the old picture with it;
// in chunky pixels, JPEG's squares and stretched rows; with wet gloss lines
// rippling over it, and edges that drip.
const DAMAGE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D scene;
uniform sampler2D energy;
uniform sampler2D previous;
uniform sampler2D marks;
uniform float mixing;
uniform vec2 size;
uniform float time;
uniform float flow;
uniform float flowSpeed;
uniform float flowScale;
uniform float block;
uniform float mosh;
uniform float pixelate;
uniform float jpeg;
uniform float stretch;
uniform float bleed;
uniform float gloss;
uniform float drip;
out vec4 colour;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// Which way the picture flows here: a slow swirl that drifts.
vec2 swirl(vec2 p) {
  float scale = mix(0.012, 0.0025, flowScale);
  float t = time * (0.05 + 0.6 * flowSpeed);
  float angle = (noise(p * scale + vec2(t, -0.7 * t)) * 2.0 + noise(p * scale * 2.3 - t)) * 3.14159;
  return vec2(cos(angle), sin(angle));
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// The face and the energy, as one picture: a shard over the face becomes a lit-up piece of the face.
vec4 at(vec2 px) {
  vec4 face = texture(scene, px / size);
  vec4 shard = texture(energy, px / size);
  if (shard.a < 0.004) return face;
  vec3 own = shard.rgb / shard.a;
  vec3 c = mix(own, face.rgb * (0.7 + 0.95 * lum(own)), face.a * mixing);
  float alpha = shard.a + face.a * (1.0 - shard.a);
  return vec4((c * shard.a + face.rgb * face.a * (1.0 - shard.a)) / alpha, alpha);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float spare = 1.0 - texture(marks, px / size).r;  // the eyes and mouth: spared the mosh and smears
  float tick = floor(time * 2.5);  // the glitches jump a few times a second
  // Chunky pixels.
  vec2 from = pixelate > 1.5 ? (floor(px / pixelate) + 0.5) * pixelate : px;
  // Drips: below the face's edges, the picture runs down in streaks.
  float run = drip * size.y * 0.07 * noise(vec2(floor(px.x / 3.0) * 0.21, time * 0.3));
  vec4 above = at(from + vec2(0.0, run));
  // Stretched rows: short runs repeat their first pixel, sideways.
  float row = floor(px.y / (4.0 + 12.0 * hash(vec2(floor(px.y / 48.0), tick))));
  if (hash(vec2(row, tick + 3.0)) < stretch * 0.1 * spare) {
    float span = 40.0 + 160.0 * hash(vec2(row, tick + 7.0));
    from.x = floor((px.x + hash(vec2(row, tick + 9.0)) * span) / span) * span - hash(vec2(row, tick + 9.0)) * span;
  }
  // JPEG: its squares, some flattened to one colour; colour from the square, light from the pixel; banding.
  float square = floor(8.0 * (1.0 + jpeg));
  vec2 cell = floor(from / square);
  vec2 middle = (cell + 0.5) * square;
  vec2 source = hash(cell + tick * 0.013) < jpeg * 0.25 ? middle : from;
  vec4 here = at(source);
  if (here.a < 0.5 && above.a > 0.5) here = vec4(above.rgb, above.a * 0.9);  // a drip
  vec4 squareColour = at(middle);
  // Colour bleed: the channels pulled apart along the flow.
  vec2 pull = swirl(px) * bleed * 8.0;
  vec3 c = vec3(at(source + pull).r, here.g, at(source - pull).b);
  float light = lum(c);
  c = mix(c, light + (squareColour.rgb - lum(squareColour.rgb)), jpeg * 0.7);
  float levels = mix(64.0, 10.0, jpeg);
  c = floor(c * levels + 0.5) / levels;
  // Gloss: wet lines where the light and dark ripple, drifting with the flow.
  float ripple = fract(light * 6.0 + noise(px * 0.01 + time * 0.1) * 0.8);
  float shine = smoothstep(0.86, 1.0, ripple) * gloss * here.a;
  c = mix(c, vec3(1.0), shine * 0.85);
  // The datamosh: each block drifts along the swirl, dragging the old picture with it.
  vec2 blockCell = floor(px / block);
  vec2 motion = swirl((blockCell + 0.5) * block) * flow * size.y * 0.004;  // a few pixels a frame
  vec4 before = texture(previous, (px - motion) / size);
  float held = step(hash(blockCell + floor(time * (1.0 + 3.0 * flowSpeed))), mosh * 0.5);
  vec3 now = mix(c, before.rgb, clamp(held + mosh * 0.35 * flow, 0.0, 1.0) * before.a * spare);
  float trail = max(0.0, before.a * mosh - 0.01);  // fades away, never stuck at a trace
  float alpha = here.a + trail * (1.0 - here.a);
  colour = alpha > 0.0 ? vec4((now * here.a + before.rgb * trail * (1.0 - here.a)) / alpha, alpha) : vec4(0.0);
}`;

const SHOW_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D picture;
uniform vec3 background;
out vec4 colour;
void main() {
  vec4 p = texelFetch(picture, ivec2(gl_FragCoord.xy), 0);
  colour = vec4(mix(background, p.rgb, p.a), 1.0);
}`;

const ATTRIBUTES = ['position', 'atlasUv', 'normal', 'imageUv', 'feature', 'facet', 'shard', 'inner'];
const SIZES = [3, 2, 3, 2, 1, 3, 4, 1];
const HAIR_SIZES = [3, 2, 1];
const HAIR_STRIDE = 6 * 4;

export class ReelFaceView {
  constructor(stage) {
    this.stage = stage;
    this.el = document.createElement('div');
    this.glCanvas = layerCanvas();
    this.overlay = layerCanvas();
    this.el.append(this.glCanvas, this.overlay);
    this.ctx = this.overlay.getContext('2d');
    this.gl = this.glCanvas.getContext('webgl2', { antialias: false });
    this.tracker = new FaceTracker();
    this.info = null;
    this.journeyState = stage.journeySnapshot;
    this.shownFace = 0; // the tracker's count of the face on show
    this.lastDraw = 0;
    this.mesh = null; // the face's buffers, made once the layout has loaded
    // This screen's copy of the face's tiles, drawn onto the face layout as they arrive.
    this.tiles = [];
    this.segmenter = new HeadSegmenter();
    this.motion = new MotionSensor();
    this.swarm = new EnergySwarm();
    this.exploded = false;   // the face has burst back into shards, this visit
    this.reelColours = [];   // colours from the reels so far, for the shards it bursts into
    this.followMotion = 1;   // how far the cloud follows movement: fully, until there's a face to centre on
    this.frameSeconds = 0;
    this.locate = (kind, a, b, c, out) => this.locateGoal(kind, a, b, c, out);
    this.somewhereOnTheFace = () => {
      if (!this.mesh?.shaped) return [(Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.8, 0];
      const spot = [0, 0, 0];
      this.locate(0, Math.floor(Math.random() * (this.mesh.count / 3)), 0, 0, spot);
      return spot;
    };
    this.alive = 0;       // the energy: 0 dormant, 1 awake
    this.energyClock = 0; // its own time, so changing its speed doesn't make it jump
    this.burst = 0;       // the moment it bursts to life, fading
    this.near = 0;        // how close someone is, 0-1
    this.oracleWords = null; // the line the oracle is saying, for the energy to pulse with
    this.oracleLevel = 0;
    this.stageSince = 0;  // when this stage of the journey began, on this page's clock
    this.stillPicture = null; // the face at its peak, kept for the end of the visit
    this.stillCode = null;    // the code to take it away, from the eye
    this.headNow = null;  // where the head is, on the latest picture
    this.shapeShown = 0;  // the segmenter's count of the shape on show
    this.arriving = [];   // the tiles still sliding in, with their pictures
    this.visit = 0;       // counts clears, so a tile decoded across one is dropped
    this.generation = 0;  // counts redraws of the settled face, so only the newest finishes
    this.rebuildTimer = 0;
    // Two layouts: the face, and the head round it. Each has its settled tiles, and those with any still arriving on top.
    this.layers = { face: atlasLayer(), head: atlasLayer() };
    this.reported = { present: false, at: 0 };
    this.voice = new FaceVoice();
    this.desire = 0;
    if (this.gl) this.setUpGl();
    if (stage.reelFaceInfo) this.reelFace(stage.reelFaceInfo);
  }

  update(item) {
    const w = Math.max(2, Math.round(item.w));
    const h = Math.max(2, Math.round(item.h));
    for (const canvas of [this.glCanvas, this.overlay]) {
      if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    }
    this.el.style.background = this.stage.look?.background || item.background;
  }

  reelFace(info) {
    const scrubbed = info.scrub !== this.info?.scrub;
    this.info = info;
    if (!info.on || info.fragments === 0) {
      if (this.tiles.length) this.clearTiles(); // a new visit, a reset: no face
    } else if (scrubbed) {
      this.rebuildSoon();
    }
  }

  journey(snapshot) {
    const before = this.journeyState?.stage ?? 'empty';
    this.journeyState = snapshot;
    if (snapshot.stage !== before || !this.stageSince) this.stageSince = performance.now() - snapshot.stage_time * 1000;
    if (snapshot.stage === 'awake' && before === 'empty') {
      this.burst = 1;
      this.swarm.kick(1.6);
    }
    if (snapshot.stage === 'ended' || snapshot.stage === 'empty') {
      this.stillPicture = null;
      this.stillCode = null;
      if (snapshot.stage !== before) this.renewEnergy();
    }
  }

  // A new line from the oracle: the energy pulses with it.
  oracle(line) {
    this.oracleWords = { shape: mouthShape(line.text ?? ''), at: performance.now() };
  }

  oracleVoice(now) {
    let target = 0;
    if (this.oracleWords) {
      const letters = (now - this.oracleWords.at) / ORACLE_LETTER_MS;
      const { shape } = this.oracleWords;
      if (letters < shape.length) target = shape[Math.max(0, Math.floor(letters))];
      else this.oracleWords = null;
    }
    this.oracleLevel += (target - this.oracleLevel) * 0.3;
    return this.oracleLevel;
  }

  // The code to take the still away: from the eye, once it has the still.
  still(message) {
    this.stillCode = message.qr ?? null;
  }

  // The oracle screams as it fractures: on screens with sound.
  scream(message) {
    if (!this.stage.speechAllowed) return;
    const { becomes_seconds: becomes, fracture_seconds: fracture } = this.journeyState?.climax ?? { becomes_seconds: 3, fracture_seconds: 1.4 };
    setTimeout(() => {
      speechSynthesis?.cancel();
      scream(fracture + 0.1, message.clip);
    }, becomes * 1000);
  }

  // How far through the climax: the face becoming them, then everything breaking.
  climaxNow(now) {
    const state = this.journeyState;
    if (state?.stage !== 'climax') return { becoming: 0, clear: 0, breaking: 0 };
    const { becomes_seconds: seconds, fracture_seconds: fracture, becomes } = state.climax;
    const t = (now - this.stageSince) / 1000;
    const into = Math.min(1, Math.max(0, t / seconds));
    const clear = into * into * (3 - 2 * into);
    return { becoming: clear * becomes, clear, breaking: Math.min(1, Math.max(0, (t - seconds) / fracture)) };
  }

  // The face says a word, for the participant: heard on screens with sound, mouthed and shown on all.
  word(message) {
    this.voice.say(message, this.stage.speechAllowed);
  }

  // One tile of the face, as the eye releases it: it slides and pulses in. A
  // screen opened part-way through gets the face so far as a burst of tiles
  // that are simply there, drawn together once the burst is over (rebuild),
  // never one redraw per tile. A tile keeps only its JPEG; its picture is
  // decoded while it arrives or is redrawn, then let go, so hundreds of
  // tiles cost megabytes, not gigabytes.
  async tile(message) {
    const { image, animate, ...rest } = message;
    const visit = this.visit;
    const blob = await fetch(`data:image/jpeg;base64,${image}`).then((response) => response.blob());
    const tile = { ...rest, blob, picture: animate ? await createImageBitmap(blob) : null, settled: !animate, arrived: performance.now() };
    if (visit !== this.visit) {
      tile.picture?.close(); // the face was cleared while it was decoding
      return;
    }
    const last = this.tiles[this.tiles.length - 1];
    if (!last || last.number < tile.number) {
      this.tiles.push(tile);
    } else {
      this.tiles = this.tiles.filter((other) => other.number !== tile.number);
      this.tiles.push(tile);
      this.tiles.sort((a, b) => a.number - b.number);
    }
    if (animate) {
      this.arriving.push(tile);
      if (tile.layer === 'face') this.loadPieces(tile);
      this.feedFragment(tile);
    } else {
      this.swarm.spend(this.swarm.shareFor(this.sizeOf(tile), 1)); // the cloud as it would be by now
      this.rebuildSoon();
    }
  }

  // A fragment pulls its shards out of the cloud, to places across it, in its reel's colours.
  feedFragment(tile) {
    tile.absorbed = 0;
    tile.feeding = 0;
    const palette = coloursOf(tile.picture);
    if (this.reelColours.length < 400) this.reelColours.push(...palette.slice(0, 4));
    if (!this.mesh?.shaped || !this.headNow) return; // no face to reach yet: it grows by time alone
    const [middleU, middleV] = middleOf(tile);
    const share = this.swarm.shareFor(this.sizeOf(tile), this.lookNow().energy_pull ?? 1);
    const goals = Array.from({ length: share }, () => {
      const edge = tile.outline[Math.floor(Math.random() * tile.outline.length)];
      const out = Math.sqrt(Math.random());
      return this.goalOn(tile.layer, middleU + (edge[0] - middleU) * out, middleV + (edge[1] - middleV) * out);
    });
    const spot = [0, 0, 0];
    this.locate(...this.goalOn(tile.layer, middleU, middleV), spot);
    tile.feeding = this.swarm.pull(tile, spot[0], spot[1], goals, palette);
  }

  // A tile's size, in face heights.
  sizeOf(tile) {
    return tile.rect[2] * (tile.layer === 'face' ? 1 : 2 * HEAD_REACH);
  }

  // What a shard flies to, for this place on a layout: on the face, the triangle there; on the head, a point in 3D.
  goalOn(layer, u, v) {
    if (layer === 'face') {
      let nearest = 0, best = Infinity;
      for (let t = 0; t < this.middles.length / 2; t++) {
        const away = (this.middles[t * 2] - u) ** 2 + (this.middles[t * 2 + 1] - v) ** 2;
        if (away < best) {
          best = away;
          nearest = t;
        }
      }
      return [0, nearest, 0, 0];
    }
    return [1, ...headPoint(u, v)];
  }

  // Where that is on the frame now, as the head moves.
  locateGoal(kind, a, b, c, out) {
    if (kind === 0) {
      const p = this.mesh.positions, at = a * 9;
      out[0] = (p[at] + p[at + 3] + p[at + 6]) / 3;
      out[1] = (p[at + 1] + p[at + 4] + p[at + 7]) / 3;
      out[2] = (p[at + 2] + p[at + 5] + p[at + 8]) / 3;
    } else if (this.headNow) {
      const { across, up, forward } = this.headNow;
      out[0] = across[0] * a + up[0] * b + forward[0] * c;
      out[1] = across[1] * a + up[1] * b + forward[1] * c;
      out[2] = across[2] * a + up[2] * b + forward[2] * c;
    }
  }

  // How far a fragment has grown: with each shard it absorbs, or by time, so it always finishes.
  grown(tile, now) {
    const fed = tile.feeding ? tile.absorbed / tile.feeding : 0;
    const waited = ((now - tile.arrived) / ARRIVAL - 0.7) / 0.3;
    return Math.min(1, Math.max(fed, waited, 0));
  }

  renewEnergy() {
    this.swarm.reset();
    this.exploded = false;
    this.reelColours = [];
  }

  clearTiles() {
    this.visit++;
    this.generation++; // a redraw under way is dropped
    for (const tile of this.tiles) tile.picture?.close();
    this.tiles = [];
    this.arriving = [];
    this.renewEnergy();
    this.segmenter.forget();
    for (const layer of Object.values(this.layers)) {
      layer.settled.getContext('2d').clearRect(0, 0, ATLAS, ATLAS);
      layer.dirty = true;
    }
    this.loadPieces();
  }

  rebuildSoon() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_AFTER);
  }

  // The settled face drawn afresh from every tile that has finished arriving
  // (as far back as the history goes): after a burst of tiles, or a scrub.
  // Drawn off to one side, a few pictures decoded at a time so the page keeps
  // moving, then swapped in whole. A newer redraw drops an older one.
  async rebuild() {
    const generation = ++this.generation;
    const canvases = { face: atlasCanvas(), head: atlasCanvas() };
    const drawn = new Set();
    let waiting = this.visibleTiles().filter((tile) => tile.settled);
    while (waiting.length) {
      for (let i = 0; i < waiting.length; i += DECODE_AT_ONCE) {
        const batch = waiting.slice(i, i + DECODE_AT_ONCE);
        const pictures = await Promise.all(batch.map((tile) => createImageBitmap(tile.blob)));
        if (generation !== this.generation) {
          for (const picture of pictures) picture.close();
          return;
        }
        batch.forEach((tile, k) => {
          drawTile(canvases[tile.layer].getContext('2d'), { ...tile, picture: pictures[k] }, 1);
          pictures[k].close();
          drawn.add(tile);
        });
      }
      // Any that finished arriving meanwhile: newer, so on top.
      waiting = this.visibleTiles().filter((tile) => tile.settled && !drawn.has(tile));
    }
    for (const [name, layer] of Object.entries(this.layers)) {
      layer.settled = canvases[name];
      layer.dirty = true;
    }
    this.loadPieces();
  }

  visibleTiles() {
    const scrub = this.info?.scrub;
    return scrub === null || scrub === undefined ? this.tiles : this.tiles.filter((tile) => this.isVisible(tile));
  }

  isVisible(tile) {
    const scrub = this.info?.scrub;
    return scrub === null || scrub === undefined || tile.reel <= scrub;
  }

  // Each layout as the head wears it now: the settled tiles, and any still arriving on top.
  updateAtlas(now) {
    this.arriving = this.arriving.filter((tile) => {
      if (this.grown(tile, now) < 1) return true;
      const layer = this.layers[tile.layer];
      if (this.isVisible(tile)) drawTile(layer.settled.getContext('2d'), tile, 1);
      layer.dirty = true;
      tile.settled = true;
      tile.picture.close();
      tile.picture = null;
      return false;
    });
    for (const [name, layer] of Object.entries(this.layers)) {
      const arriving = this.arriving.filter((tile) => tile.layer === name && this.isVisible(tile));
      if (!arriving.length && !layer.dirty) continue;
      const ctx = layer.worn.getContext('2d');
      ctx.clearRect(0, 0, ATLAS, ATLAS);
      ctx.drawImage(layer.settled, 0, 0);
      for (const tile of arriving) drawTile(ctx, tile, this.grown(tile, now));
      this.upload(layer.texture, layer.worn, true);
      layer.dirty = false;
    }
  }

  draw(now) {
    if (!this.item || this.el.style.display === 'none') return;
    const info = this.info ?? {};
    const stage = this.journeyState?.stage ?? 'empty';
    const seconds = Math.min(0.1, (now - this.lastDraw) / 1000);
    this.lastDraw = now;
    this.frameSeconds = seconds;
    // Its progress eases towards the eye's, so a new reel makes the look lurch, not jump
    // (quicker when it's moved by hand, so dragging through it in the look editor follows the hand).
    const ease = info.override === null || info.override === undefined ? 1 : 6;
    this.formation = (this.formation ?? 0) + ((info.progress ?? 0) - (this.formation ?? 0)) * Math.min(1, seconds * ease);
    this.desire += ((info.desire ?? 0) - this.desire) * Math.min(1, seconds);

    const picture = this.stage.feeds.get(FACE_VIEW);
    this.tracker.track(picture, now);
    this.motion.look(picture, now);
    const { face } = this.tracker;
    const lost = this.tracker.lostFor(now) > LOST_AFTER;
    this.report(Boolean(face && !lost), this.motion.moving, now);
    this.mouthOpen = lost ? 0 : this.voice.mouth(now);
    this.feelEnergy(stage, face && !lost ? face : null, seconds);
    if (this.gl) {
      // A new face found: its shape, and the very picture it was found in for its skin.
      const fresh = face && this.tracker.found !== this.shownFace;
      if (fresh) {
        this.shownFace = this.tracker.found;
        this.upload(this.cameraTexture, this.tracker.picture, false);
        this.faceLight = this.measureLight(face, this.tracker.picture);
        this.headNow = this.headOf(face);
        // Only once there's a face to put them on: it costs a second model.
        if (stage === 'forming' && this.tiles.length && this.showsHair()) this.segmenter.look(this.tracker.picture, this.headNow, now);
      }
      // Reshaped on every new face, and every frame while it speaks (its mouth moves with the words).
      if (face && (fresh || (this.voice.word && !lost))) this.shape(face);
      this.updateAtlas(now);
      // Detection is not generation: there's no face to draw until reels have made one.
      this.render(now, stage, Boolean(face && this.mesh?.shaped && (stage === 'forming' || stage === 'climax') && this.tiles.length));
      const { clear } = this.climaxNow(now);
      if (stage === 'climax' && clear >= 1 && !this.stillPicture) this.keepStill();
    }

    const { ctx } = this;
    const { width: w, height: h } = this.overlay;
    const item = { ...this.item, color: readable(this.item.color, this.stage.look?.background) };
    ctx.clearRect(0, 0, w, h);
    if (!this.gl) caption(ctx, w, h, 'NO WEBGL ON THIS COMPUTER', item, h / 2);
    else if (info.face_feed === 'none') caption(ctx, w, h, 'NO FACE CAMERA', item, h / 2);
    else if (!this.tracker.ready && this.stage.editing) caption(ctx, w, h, 'STARTING FACE TRACKING…', item, h / 2);
    if (stage === 'still') this.drawStill(ctx, w, h, item, now);
    // The word it's saying, as it says it.
    const said = stage === 'forming' && this.tiles.length ? this.voice.shown(now) : null;
    if (said) {
      ctx.save();
      ctx.globalAlpha = said.alpha;
      caption(ctx, w, h, said.text.toUpperCase(), { ...item, size: Math.round(item.size * (1.8 + 0.8 * said.desire)) }, h * 0.93);
      ctx.restore();
    }
    // Notes for whoever's running it: a visitor sees no sign of how it works.
    if (this.stage.tool && stage === 'forming' && info.waiting_reels > 0) label(ctx, w, h, `FORMING · ${info.waiting_reels} REEL${info.waiting_reels === 1 ? '' : 'S'} TO GO`, item, 'bottom-right');
    if (this.stage.tool && face && lost && stage === 'forming') label(ctx, w, h, 'TRACKING LOST', item, 'bottom');
    if (info.face_feed === 'test') label(ctx, w, h, 'TEST TRACKING · RECORDED CLIP, NOT A LIVE CAMERA', item, 'top');
    if (stage === 'empty' && this.stage.editing) caption(ctx, w, h, 'REEL FACE · NOBODY THERE', item, h / 2);
    if (this.stillWanted) this.takeStill(); // straight after drawing, while the picture is still there
  }

  // How bright the live face is on average (0-1): its box on the camera picture, shrunk to a few pixels.
  measureLight(face, picture) {
    const { points, width, height } = face;
    let [x0, y0, x1, y1] = [1, 1, 0, 0];
    for (const point of [TOP, CHIN, ...SIDES]) {
      x0 = Math.min(x0, points[point * 3]); x1 = Math.max(x1, points[point * 3]);
      y0 = Math.min(y0, points[point * 3 + 1]); y1 = Math.max(y1, points[point * 3 + 1]);
    }
    this.lightCanvas ??= Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
    const ctx = this.lightCanvas.getContext('2d', { willReadFrequently: true });
    const w = Math.max(1, (x1 - x0) * width);
    const h = Math.max(1, (y1 - y0) * height);
    ctx.drawImage(picture, x0 * width, y0 * height, w, h, 0, 0, 8, 8);
    const pixels = ctx.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    const light = sum / (pixels.length / 4) / 255;
    return (this.faceLight ?? light) * 0.8 + light * 0.2; // eased, so it doesn't flicker
  }

  // A still of the face as it's drawn next: the picture and its words, in one canvas.
  requestStill(done) {
    this.stillWanted = done;
  }

  takeStill() {
    const done = this.stillWanted;
    this.stillWanted = null;
    const still = Object.assign(document.createElement('canvas'), { width: this.glCanvas.width, height: this.glCanvas.height });
    const ctx = still.getContext('2d');
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);
    done(still);
  }

  // Tells the eye whether a face is here or anything's moving: when it changes, and every second while it is.
  report(present, moving, now) {
    if (this.stage.editing) return; // the screens decide, not the editor's preview
    const changed = present !== this.reported.present || moving !== this.reported.moving;
    if (changed || ((present || moving) && now - this.reported.at > REPORT_EVERY)) {
      this.stage.send?.({ type: 'face_seen', present, moving });
      this.reported = { present, moving, at: now };
    }
  }

  // What the energy feels: someone there, how close, and where.
  feelEnergy(stage, face, seconds) {
    const awake = !['empty', 'dark', 'still', 'ended'].includes(stage);
    this.alive += ((awake ? 1 : 0) - this.alive) * Math.min(1, seconds * (awake ? 5 : 1));
    this.burst *= Math.max(0, 1 - seconds * 1.6);
    this.energyClock += seconds * (this.stage.look?.values?.energy_flow?.[0] ?? 1);
    // Closer: the face takes up more of the picture, or before there is one, more of the picture moves.
    const size = face ? this.measure(face).tall / face.height : 0;
    const near = Math.max(Math.min(1, Math.max(0, (size - 0.12) / 0.45)), Math.min(1, this.motion.amount * 4));
    this.near += (near - this.near) * Math.min(1, seconds * 2);
  }

  // The face at its peak, for the visitor to take away: kept here to show again, and given to the eye for its code.
  keepStill() {
    const still = Object.assign(document.createElement('canvas'), { width: this.glCanvas.width, height: this.glCanvas.height });
    still.getContext('2d').drawImage(this.glCanvas, 0, 0);
    this.stillPicture = still;
    if (this.stage.editing) return;
    still.toBlob((blob) => {
      if (blob) fetch('/still', { method: 'POST', body: blob }).catch(() => {});
    }, 'image/jpeg', 0.92);
  }

  // Their face back, with the code underneath to take it away.
  drawStill(ctx, w, h, item, now) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, (now - this.stageSince) / 800);
    const code = this.stillCode;
    const pictureHeight = h * (code ? 0.74 : 0.96);
    if (this.stillPicture) {
      const width = pictureHeight * (this.stillPicture.width / this.stillPicture.height);
      ctx.drawImage(this.stillPicture, (w - width) / 2, h * 0.02, width, pictureHeight);
    }
    if (code) {
      const modules = code.length + 8; // with the white margin scanners need
      const unit = Math.floor((h * 0.21) / modules);
      const size = unit * modules;
      const x = Math.round((w - size) / 2), y = Math.round(h * 0.77);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = '#000000';
      code.forEach((row, r) => row.forEach((on, c) => {
        if (on) ctx.fillRect(x + (c + 4) * unit, y + (r + 4) * unit, unit, unit);
      }));
    }
    ctx.restore();
  }

  showsHair() {
    const hair = this.stage.look?.values?.hair;
    return Boolean(hair) && Math.max(...hair) > 0;
  }

  // How the face sits in the frame: half the frame's height in face heights
  // (the face fills this share of the frame's height, whatever its size on the
  // camera), and how far it's lowered to leave room for the hair above it.
  framing() {
    return { reach: 0.5 / ((this.item.fill ?? REEL_FACE_DEFAULTS.fill) / 100), drop: this.showsHair() ? HEAD_DROP : 0 };
  }

  // The face's size and place on the camera's picture, in pixels.
  measure(face) {
    const { points, width, height } = face;
    const at = (i) => [points[i * 3] * width, points[i * 3 + 1] * height, points[i * 3 + 2] * width];
    const top = at(TOP), chin = at(CHIN);
    const middle = [TOP, CHIN, ...SIDES].map(at).reduce((sum, p) => sum.map((v, k) => v + p[k] / 4), [0, 0, 0]);
    const tall = Math.hypot(top[0] - chin[0], top[1] - chin[1], top[2] - chin[2]) || 1;
    return { at, top, chin, middle, tall };
  }

  // Where a point of the face goes: centred, the face one tall, mirrored like a mirror.
  placer(face) {
    const { at, middle, tall } = this.measure(face);
    return (i) => {
      const p = at(i);
      return [-(p[0] - middle[0]) / tall, -(p[1] - middle[1]) / tall, -(p[2] - middle[2]) / tall];
    };
  }

  // Where the head is, from the tracked points: its place on the picture
  // (middle, then one face height across and down, 0-1); its pose, three axes
  // on the frame, which turn the 3D head with the face; which way is up on the
  // frame; and how high the ears start, measured up the head.
  headOf(face) {
    const { middle, tall, width, height } = { ...this.measure(face), width: face.width, height: face.height };
    const place = this.placer(face);
    const across = normalized(ACROSS_PAIRS.reduce((sum, [a, b]) => add(sum, subtract(place(a), place(b))), [0, 0, 0]));
    const measuredUp = subtract(place(UP_FROM[0]), place(UP_FROM[1]));
    const leaning = normalized(subtract(measuredUp, scaled(across, dot(measuredUp, across))));
    const facing = cross(leaning, across);
    const target = {
      across,
      up: add(scaled(leaning, Math.cos(UP_LEANS)), scaled(facing, Math.sin(UP_LEANS))),
      forward: add(scaled(facing, Math.cos(UP_LEANS)), scaled(leaning, -Math.sin(UP_LEANS))),
    };
    // Eased, then squared up again, so the axes stay at right angles.
    const last = this.pose ?? target;
    const eased = (name) => add(scaled(last[name], 1 - POSE_EASE), scaled(target[name], POSE_EASE));
    const up = normalized(eased('up'));
    const easedAcross = eased('across');
    const poseAcross = normalized(subtract(easedAcross, scaled(up, dot(easedAcross, up))));
    this.pose = { across: poseAcross, up, forward: cross(up, poseAcross) };
    const flatLength = Math.hypot(up[0], up[1]) || 1;
    return {
      place: [middle[0] / width, middle[1] / height, tall / width, tall / height],
      ...this.pose,
      flatUp: [up[0] / flatLength, up[1] / flatLength],
      earsFrom: dot(place(CHIN), up) + EARS_FROM,
    };
  }

  // WebGL

  setUpGl() {
    const { gl } = this;
    this.head = program(gl, HEAD_VERTEX, HEAD_FRAGMENT, ATTRIBUTES);
    this.damage = program(gl, QUAD_VERTEX, DAMAGE_FRAGMENT, ['corner']);
    this.show = program(gl, QUAD_VERTEX, SHOW_FRAGMENT, ['corner']);
    this.hair = program(gl, HAIR_VERTEX, HAIR_FRAGMENT, ['corner', 'layoutUv', 'isEar']);
    this.shard = program(gl, SHARD_VERTEX, SHARD_FRAGMENT, ['rim', 'place', 'shape', 'tint', 'depth']);
    // One torn shard: a fan of triangles round its middle, drawn once for each, from the swarm's numbers.
    const fan = [];
    for (let point = 0; point < SHARD_POINTS; point++) fan.push(0, 0, point, 1, (point + 1) % SHARD_POINTS, 1);
    this.shardMesh = gl.createVertexArray();
    gl.bindVertexArray(this.shardMesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.shardBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shardBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, SHARDS_DRAWN * SHARD_VALUES * 4, gl.DYNAMIC_DRAW);
    for (const [index, size, offset] of [[1, 4, 0], [2, 3, 16], [3, 3, 28], [4, 1, 40]]) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, SHARD_VALUES * 4, offset);
      gl.vertexAttribDivisor(index, 1);
    }
    gl.bindVertexArray(null);
    this.cameraTexture = gl.createTexture();
    for (const layer of Object.values(this.layers)) {
      layer.texture = gl.createTexture();
      // No reels yet: a see-through skin.
      gl.bindTexture(gl.TEXTURE_2D, layer.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    }
    this.shapeTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shapeTexture);
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
    this.hairMesh = gl.createVertexArray();
    gl.bindVertexArray(this.hairMesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, headMesh(), gl.STATIC_DRAW);
    let offset = 0;
    HAIR_SIZES.forEach((size, index) => {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, HAIR_STRIDE, offset);
      offset += size * 4;
    });
    gl.bindVertexArray(null);
    this.vao = gl.createVertexArray();
    this.buffers = ATTRIBUTES.map(() => gl.createBuffer());
    // One triangle over the whole canvas, for the picture passes.
    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.targets = null; // the face on its own, and two pictures that take turns (this frame, the last)
  }

  // The parts of the face that never change: where each corner sits on the
  // reel skin, which corners are features, and each triangle's way out.
  makeMesh() {
    const { gl } = this;
    const count = layout.corners.length;
    const feature = new Float32Array(count);
    const facets = new Float32Array(count * 3);
    layout.corners.forEach((point, i) => { feature[i] = FEATURES.has(point) ? 1 : 0; });
    for (let t = 0; t < count / 3; t++) {
      const away = [random(t * 3) - 0.5, random(t * 3 + 1) - 0.5, 0.6 + random(t * 3 + 2)];
      for (let corner = 0; corner < 3; corner++) facets.set(away, (t * 3 + corner) * 3);
    }
    this.mesh = {
      count,
      positions: new Float32Array(count * 3),
      normals: new Float32Array(count * 3),
      images: new Float32Array(count * 2),
      shaped: false,
    };
    gl.bindVertexArray(this.vao);
    this.fill(1, layout.atlas, gl.STATIC_DRAW);
    this.fill(4, feature, gl.STATIC_DRAW);
    this.fill(5, facets, gl.STATIC_DRAW);
    this.fill(7, Float32Array.from(layout.corners, (point) => (INNER_LIPS.has(point) ? 1 : 0)), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.loadPieces();
  }

  // The face, from the participant's live points: centred, the size of the
  // frame, mirrored like a mirror. Turning their head turns it. Two things
  // aren't theirs: once it speaks, its mouth moves with its words (their own
  // mouth's opening is taken out, the jaw dropped for each sound), and as
  // desire rises its eyes open wider.
  shape(face) {
    if (!layout) return;
    if (!this.mesh) this.makeMesh();
    const { points } = face;
    const place = this.placer(face);
    const placed = new Float32Array(points.length);
    for (let point = 0; point < points.length / 3; point++) placed.set(place(point), point * 3);
    if (this.voice.word) {
      const gap = Math.max(0, placed[13 * 3 + 1] - placed[14 * 3 + 1]); // how open their own mouth is
      const drop = this.mouthOpen * OPEN_JAW;
      layout.jaw.forEach((weight, point) => { placed[point * 3 + 1] += (gap - drop) * weight; });
    }
    for (const { up, down } of LIDS) {
      for (const point of up) placed[point * 3 + 1] += this.desire * WIDE_EYES;
      for (const point of down) placed[point * 3 + 1] -= this.desire * WIDE_EYES * 0.6;
    }
    const { positions, normals, images, count } = this.mesh;
    for (let i = 0; i < count; i++) {
      const p = layout.corners[i] * 3;
      positions.set(placed.subarray(p, p + 3), i * 3);
      images[i * 2] = points[p];
      images[i * 2 + 1] = points[p + 1];
    }
    flatNormals(positions, normals);
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    this.fill(0, positions, gl.DYNAMIC_DRAW);
    this.fill(2, normals, gl.DYNAMIC_DRAW);
    this.fill(3, images, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.mesh.shaped = true;
  }

  // Which piece of reel each triangle belongs to (the newest tile over its
  // middle), and the way each piece comes away when the face breaks. A newly
  // arrived tile (added) only claims the triangles under it; anything else
  // works it all out again.
  loadPieces(added = null) {
    const { gl, mesh } = this;
    if (!gl || !mesh) return;
    const triangles = mesh.count / 3;
    if (!this.middles) {
      this.middles = new Float32Array(triangles * 2);
      for (let t = 0; t < triangles; t++) {
        this.middles[t * 2] = (layout.atlas[t * 6] + layout.atlas[t * 6 + 2] + layout.atlas[t * 6 + 4]) / 3;
        this.middles[t * 2 + 1] = (layout.atlas[t * 6 + 1] + layout.atlas[t * 6 + 3] + layout.atlas[t * 6 + 5]) / 3;
      }
    }
    const { middles } = this;
    this.pieces ??= new Float32Array(triangles * 12);
    const data = this.pieces;
    const claim = (t, piece) => {
      const way = [random(piece * 5) - 0.5, random(piece * 5 + 1) - 0.5, 0.8];
      const length = Math.hypot(...way);
      const value = piece < 0 ? [0, 0, 0, -1] : [...way.map((v) => v / length), piece + 1];
      for (let corner = 0; corner < 3; corner++) data.set(value, t * 12 + corner * 4);
    };
    if (added && this.isVisible(added)) {
      for (let t = 0; t < triangles; t++) {
        if (covers(added, middles[t * 2], middles[t * 2 + 1])) claim(t, added.number);
      }
    } else {
      const tiles = this.visibleTiles().filter((tile) => tile.layer === 'face');
      for (let t = 0; t < triangles; t++) {
        let piece = -1;
        for (let i = tiles.length - 1; i >= 0; i--) {
          if (covers(tiles[i], middles[t * 2], middles[t * 2 + 1])) {
            piece = tiles[i].number;
            break;
          }
        }
        claim(t, piece);
      }
    }
    gl.bindVertexArray(this.vao);
    this.fill(6, data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  fill(index, data, usage) {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[index]);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, SIZES[index], gl.FLOAT, false, 0, 0);
  }

  upload(texture, picture, mipmaps) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // rows top down, like the uvs
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // Off-screen pictures the size of the canvas: the face alone (with depth, and its marks: where the
  // eyes and mouth are), and two for the damage.
  makeTargets(width, height) {
    const { gl } = this;
    const picture = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer };
    };
    if (this.targets) {
      for (const target of [this.targets.scene, this.targets.marks, this.targets.energy, ...this.targets.turns]) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
      gl.deleteRenderbuffer(this.targets.depth);
    }
    const marks = picture();
    const scene = picture();
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, marks.texture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    // The energy, on its own picture, tested against the same depth as the face, so it passes in front and behind.
    const energy = picture();
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const turns = [picture(), picture()];
    for (const turn of turns) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, turn.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = { width, height, scene, marks, energy, depth, turns, current: 0 };
  }

  // Every setting of the look, as far as the face has formed (look.py).
  lookNow() {
    const values = this.stage.look?.values ?? {};
    const at = Math.min(1, Math.max(0, this.formation ?? 0));
    const now = {};
    for (const [name, [start, full]] of Object.entries(values)) now[name] = start + (full - start) * at;
    // The climax: the damage clears as the face becomes the person, then everything breaks at once.
    const { clear, breaking } = this.climaxNow(performance.now());
    if (clear > 0) {
      for (const name of DAMAGE) now[name] = (now[name] ?? 0) * (1 - clear);
      now.pixelate = 1 + ((now.pixelate ?? 1) - 1) * (1 - clear);
      now.likeness = 1;
    }
    if (breaking > 0) {
      Object.assign(now, { jpeg: breaking, mosh: 0.95 * breaking, flow: breaking, stretch: breaking, bleed: breaking, pixelate: 1 + 23 * breaking,
        holes: 0.7 * breaking, fracture: breaking, findable: 0 });
    }
    return now;
  }

  // The hair and ears, behind the face: once their shape has been found, on the latest picture.
  drawHair(look, t, projection) {
    const { gl, segmenter } = this;
    const shape = segmenter.mask;
    if (!shape || !this.headNow || !(look.hair > 0.001)) return;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.shapeTexture);
    if (this.shapeShown !== segmenter.found) {
      this.shapeShown = segmenter.found;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // two bytes a pixel: rows aren't padded
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // rows top down, like the camera's picture
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, shape.width, shape.height, 0, gl.RG, gl.UNSIGNED_BYTE, shape.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }
    const { uniforms } = this.hair;
    gl.useProgram(this.hair.program);
    gl.uniform1i(uniforms.shape, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
    gl.uniform1i(uniforms.camera, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.layers.head.texture);
    gl.uniform1i(uniforms.reels, 1);
    gl.uniformMatrix4fv(uniforms.projection, false, projection);
    gl.uniform3f(uniforms.headAcross, ...this.headNow.across);
    gl.uniform3f(uniforms.headUp, ...this.headNow.up);
    gl.uniform3f(uniforms.headForward, ...this.headNow.forward);
    gl.uniform2f(uniforms.flatUp, ...this.headNow.flatUp);
    gl.uniform2f(uniforms.shapeFlatUp, ...shape.head.flatUp);
    gl.uniform4f(uniforms.head, ...this.headNow.place);
    gl.uniform4f(uniforms.shapeHead, ...shape.head.place);
    gl.uniform1f(uniforms.earsFrom, this.headNow.earsFrom);
    gl.uniform1f(uniforms.time, t);
    gl.uniform1f(uniforms.melt, look.melt ?? 0);
    const { becoming, breaking } = this.climaxNow(performance.now());
    gl.uniform1f(uniforms.shown, look.hair * (1 - breaking));
    gl.uniform1f(uniforms.crumble, look.energy_crumble ?? 0);
    gl.uniform1f(uniforms.becoming, becoming);
    gl.uniform1f(uniforms.shatter, breaking);
    gl.uniform1f(uniforms.faint, look.faint ?? 0);
    gl.uniform1f(uniforms.likeness, look.hair_likeness ?? 0);
    gl.uniform1f(uniforms.faceLight, this.faceLight ?? 0.5);
    gl.uniform1f(uniforms.hairLight, segmenter.hairLight ?? 0.5);
    gl.uniform1f(uniforms.heat, look.heat ?? 0);
    gl.uniform1f(uniforms.flush, look.flush ?? 0);
    gl.uniform1f(uniforms.desire, this.desire);
    gl.bindVertexArray(this.hairMesh);
    gl.enable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, HEAD_VERTICES);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, HEAD_VERTICES, EAR_VERTICES); // the ears, over it
    gl.clear(gl.DEPTH_BUFFER_BIT); // and the face goes over all of that
  }

  // The energy's shards, on their own picture: in front of the face or behind it,
  // by their depth (until it breaks, when it's nothing but shards).
  drawShards(look, projection, inDepth) {
    const { gl } = this;
    const { uniforms } = this.shard;
    const shards = this.swarm.shards, count = this.swarm.count;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.energy.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count) return;
    gl.useProgram(this.shard.program);
    gl.uniformMatrix4fv(uniforms.projection, false, projection);
    gl.uniform1f(uniforms.time, this.energyClock);
    gl.uniform1f(uniforms.jagged, look.jagged ?? 0.5);
    gl.uniform1f(uniforms.saturation, look.energy_colour ?? 0.65);
    gl.bindVertexArray(this.shardMesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shardBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, shards, 0, count * SHARD_VALUES);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (inDepth) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, SHARD_POINTS * 3, count);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  // One step for the energy's shards. They go by what's happening: someone there, the words, the face forming.
  moveShards(now, look, hasFace, clear, breaking, frame) {
    if (breaking > 0 && !this.exploded) {
      this.exploded = true;
      this.swarm.explode(this.somewhereOnTheFace, this.reelColours);
    }
    const formed = Math.min(1, (this.formation ?? 0) / 0.6);
    const [across, up] = this.motion.place;
    this.followMotion += ((hasFace ? 0 : 1) - this.followMotion) * Math.min(1, this.frameSeconds * 1.5); // once there's a face, it's centred on that
    this.swarm.update({
      seconds: this.frameSeconds,
      clock: this.energyClock,
      alive: this.alive,
      burst: this.burst,
      near: this.near,
      voice: Math.max(this.oracleVoice(now), this.mouthOpen ?? 0),
      offset: [across * 0.45 * this.followMotion, up * 0.3 * this.followMotion],
      spread: look.energy_spread ?? 1,
      glow: look.energy_glow ?? 1,
      size: (look.energy_size ?? 1) * (0.5 + 1.5 * (look.fragment_size ?? 0.3)),
      fade: 1 - 0.35 * formed,
      clear,
      breaking,
      frame,
      // The face sheds what it took in, more as it forms, in the colours of its reels.
      shedRate: hasFace && !clear ? (20 + 110 * formed) * (look.energy_shed ?? 1) : 0,
      place: this.somewhereOnTheFace,
      palette: this.reelColours,
    }, this.locate);
  }

  render(now, stage, hasFace) {
    const { gl, item } = this;
    const { width, height } = this.glCanvas;
    const background = rgb(this.stage.look?.background || item.background);
    if (stage === 'dark' || stage === 'still' || stage === 'ended') {
      // Dark: nothing at all. Their face comes back over this, in drawStill.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    if (!this.targets || this.targets.width !== width || this.targets.height !== height) this.makeTargets(width, height);
    const t = now / 1000;
    const look = this.lookNow();
    const set = (uniforms, names) => { for (const name of names) gl.uniform1f(uniforms[name], look[snake(name)] ?? 0); };

    // The scene on its own: the energy, and any face.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.scene.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { reach, drop } = this.framing();
    const projection = orthographic(reach * width / height, reach, drop);
    const { becoming, clear, breaking } = this.climaxNow(now);
    // The frame, on the same measure as the shards: they stay inside it.
    this.moveShards(now, look, hasFace, clear, breaking, { wide: reach * width / height, tall: reach, middle: drop });
    if (hasFace) this.drawHead(look, t, projection, item, becoming, breaking, set);
    this.drawShards(look, projection, hasFace && breaking === 0);
    this.drawDamage(t, width, height, background, look, set);
  }

  // The hair and ears, then the face over them, broken apart.
  drawHead(look, t, projection, item, becoming, breaking, set) {
    const { gl } = this;
    this.drawHair(look, t, projection);

    const { uniforms } = this.head;
    gl.useProgram(this.head.program);
    gl.uniformMatrix4fv(uniforms.projection, false, projection);
    gl.uniform1f(uniforms.time, t);
    gl.uniform1f(uniforms.desire, this.desire);
    gl.uniform1f(uniforms.mouthOpen, this.mouthOpen ?? 0);
    // Its heartbeat, quicker as it wants more: a beat and a smaller second beat.
    const beat = (t * (60 + 90 * this.desire) / 60) % 1;
    gl.uniform1f(uniforms.pulse, Math.max(0, 1 - beat * 5) + Math.max(0, 0.6 - Math.abs(beat - 0.3) * 5));
    set(uniforms, ['fracture', 'melt', 'faint', 'likeness', 'findable', 'bleed', 'flush', 'heat', 'holes']);
    gl.uniform1f(uniforms.shade, Math.min(1, (item.shade ?? 40) / 100 + (look.fracture ?? 0) * 0.3));
    const doubled = (look.fracture ?? 0) * 0.3;
    gl.uniform1f(uniforms.doubled, doubled);
    gl.uniform1f(uniforms.faceLight, this.faceLight ?? 0.5);
    gl.uniform1f(uniforms.becoming, becoming);
    gl.uniform1f(uniforms.shatter, breaking);
    gl.uniform1f(uniforms.crumble, look.energy_crumble ?? 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
    gl.uniform1i(uniforms.camera, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.layers.face.texture);
    gl.uniform1i(uniforms.reels, 1);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.uniform1f(uniforms.ghost, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.mesh.count);
    if (doubled > 0.01) {
      // Some pieces again, knocked sideways and see-through: doubled features.
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(uniforms.ghost, 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.mesh.count);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  // The picture's damage, into this frame's picture, from the scene and the last frame's; then onto the screen.
  drawDamage(t, width, height, background, look, set) {
    const { gl } = this;
    const targets = this.targets;
    const last = targets.turns[targets.current];
    const next = targets.turns[1 - targets.current];
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
    gl.useProgram(this.damage.program);
    const damage = this.damage.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.scene.texture);
    gl.uniform1i(damage.scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, last.texture);
    gl.uniform1i(damage.previous, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, targets.marks.texture);
    gl.uniform1i(damage.marks, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, targets.energy.texture);
    gl.uniform1i(damage.energy, 3);
    gl.uniform1f(damage.mixing, look.energy_mix ?? 0.85);
    gl.uniform2f(damage.size, width, height);
    gl.uniform1f(damage.time, t);
    set(damage, ['flow', 'flowSpeed', 'flowScale', 'block', 'mosh', 'pixelate', 'jpeg', 'stretch', 'bleed', 'gloss', 'drip']);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    targets.current = 1 - targets.current;

    // Onto the screen, over the plain background.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.show.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, next.texture);
    gl.uniform1i(this.show.uniforms.picture, 0);
    gl.uniform3f(this.show.uniforms.background, ...background);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

function program(gl, vertexSource, fragmentSource, attributes) {
  const made = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
    gl.attachShader(made, shader);
  }
  attributes.forEach((name, index) => gl.bindAttribLocation(made, index, name));
  gl.linkProgram(made);
  if (!gl.getProgramParameter(made, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(made));
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(made, gl.ACTIVE_UNIFORMS); i++) {
    const { name } = gl.getActiveUniform(made, i);
    uniforms[name] = gl.getUniformLocation(made, name);
  }
  return { program: made, uniforms };
}

// The head and its ears, as triangles, once: each corner's place in 3D, where
// its fragments are on the head layout, and whether it's an ear. The head comes
// first, then the ears, which are drawn over it.
function headMesh() {
  const corners = [];
  const head = (row, column) => {
    const u = column / HEAD_SQUARES, v = row / HEAD_SQUARES;
    return [...domePoint(u, v), u, v, 0];
  };
  for (let row = 0; row < HEAD_SQUARES; row++) {
    for (let column = 0; column < HEAD_SQUARES; column++) {
      const at = (r, c) => head(row + r, column + c);
      corners.push(...at(0, 0), ...at(1, 0), ...at(0, 1), ...at(0, 1), ...at(1, 0), ...at(1, 1));
    }
  }
  // An ear: a flat patch from just behind the side of the face (MediaPipe's model face puts
  // that at 0.43 across), running back and out. The model decides its outline.
  EAR_PATCHES.forEach(([x, y, width, height], ear) => {
    const corner = (down, out) => [...earPoint(ear, down, out), x + out * width, y + down * height, 1];
    for (let row = 0; row < EAR_ROWS; row++) {
      for (let column = 0; column < EAR_COLUMNS; column++) {
        const at = (r, c) => corner((row + r) / EAR_ROWS, (column + c) / EAR_COLUMNS);
        corners.push(...at(0, 0), ...at(1, 0), ...at(0, 1), ...at(0, 1), ...at(1, 0), ...at(1, 1));
      }
    }
  });
  return new Float32Array(corners);
}

// Where a place on the head layout is, in 3D: on the dome, or on an ear.
function domePoint(u, v) {
  const across = (u - 0.5) * 2 * HEAD_REACH, up = (0.5 - v) * 2 * HEAD_REACH;
  const onDome = 1 - (across / DOME.across) ** 2 - ((up - DOME.up) / DOME.tall) ** 2;
  return [across, up, DOME.back + DOME.deep * Math.sqrt(Math.max(0, onDome))];
}

function earPoint(ear, down, out) {
  const side = ear === 0 ? 1 : -1;
  const along = -0.03 + out * 0.33;
  return [side * (0.43 + along * 0.42), 0.22 - down * 0.36, -0.22 - along * 0.91];
}

function headPoint(u, v) {
  const ear = EAR_PATCHES.findIndex(([x, y, width, height]) => u >= x && u <= x + width && v >= y && v <= y + height);
  if (ear < 0) return domePoint(u, v);
  const [x, y, width, height] = EAR_PATCHES[ear];
  return earPoint(ear, (v - y) / height, (u - x) / width);
}

const add = (a, b) => a.map((value, i) => value + b[i]);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const scaled = (a, by) => a.map((value) => value * by);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalized = (a) => scaled(a, 1 / (Math.hypot(...a) || 1));

function atlasCanvas() {
  return Object.assign(document.createElement('canvas'), { width: ATLAS, height: ATLAS });
}

// A layout the tiles land on: those settled, drawn once; with any still arriving on top, what the head wears now.
function atlasLayer() {
  return { settled: atlasCanvas(), worn: atlasCanvas(), dirty: false, texture: null };
}

function layerCanvas() {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  return canvas;
}

function caption(ctx, w, h, text, item, y) {
  ctx.font = `${item.size}px "${item.font}", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = item.color;
  ctx.fillText(text, w / 2, y, w * 0.9);
}

// A small, plain note in a corner of the frame: top (left), bottom (left) or bottom-right.
function label(ctx, w, h, text, item, where) {
  const size = Math.max(12, Math.round(item.size * 0.45));
  ctx.font = `${size}px Consolas, monospace`;
  ctx.textAlign = where === 'bottom-right' ? 'right' : 'left';
  ctx.textBaseline = where === 'top' ? 'top' : 'bottom';
  ctx.fillStyle = item.color;
  ctx.globalAlpha = 0.7;
  ctx.fillText(text, where === 'bottom-right' ? w - size : size, where === 'top' ? size : h - size);
  ctx.globalAlpha = 1;
}

// The middle of a tile's torn outline.
function middleOf(tile) {
  tile.middle ??= tile.outline.reduce(([u, v], [x, y]) => [u + x / tile.outline.length, v + y / tile.outline.length], [0, 0]);
  return tile.middle;
}

// A few of a picture's colours, 0-1, kept from going black: what its shards take on as they fly to it.
let colourReader = null;
function coloursOf(picture) {
  colourReader ??= Object.assign(document.createElement('canvas'), { width: 4, height: 4 }).getContext('2d', { willReadFrequently: true });
  colourReader.drawImage(picture, 0, 0, 4, 4);
  const pixels = colourReader.getImageData(0, 0, 4, 4).data;
  const colours = [];
  for (let i = 0; i < pixels.length; i += 4) colours.push([0, 1, 2].map((k) => Math.max(0.12, pixels[i + k] / 255)));
  return colours;
}

// A tile onto its layout, as far as it has grown (0 to 1), cut to its torn outline: the
// outline spreads out from its middle over its picture, with a bright pulse that fades.
function drawTile(ctx, tile, grown) {
  const spread = Math.sqrt(Math.min(1, Math.max(0, grown)));  // its area grows with each shard
  if (spread <= 0) return;
  const [x, y, size] = tile.rect.map((v) => v * ATLAS);
  const [middleU, middleV] = middleOf(tile);
  ctx.save();
  if (tile.outline?.length > 2) {
    ctx.beginPath();
    for (const [u, v] of tile.outline) ctx.lineTo((middleU + (u - middleU) * spread) * ATLAS, (middleV + (v - middleV) * spread) * ATLAS);
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(tile.picture, x, y, size, size);
  if (spread < 1) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * (1 - spread);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

// Whether a tile covers this point of the face layout: inside its torn
// outline (its bounding box first, to skip most tiles quickly).
function covers(tile, u, v) {
  const points = tile.outline;
  if (!points?.length) {
    const [x, y, size] = tile.rect;
    return u >= x && u < x + size && v >= y && v < y + size;
  }
  tile.box ??= points.reduce(([x0, y0, x1, y1], [x, y]) => [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)], [1, 1, 0, 0]);
  const [x0, y0, x1, y1] = tile.box;
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A uniform's name as the look names it: flowSpeed is flow_speed.
function snake(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// The same "random" number for the same n, every time and on every screen.
function random(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// One normal per triangle, given to all three corners: a faceted face,
// always turned towards the viewer (the mirroring flips the triangles).
function flatNormals(positions, normals) {
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i + 3] - positions[i], ay = positions[i + 4] - positions[i + 1], az = positions[i + 5] - positions[i + 2];
    const bx = positions[i + 6] - positions[i], by = positions[i + 7] - positions[i + 1], bz = positions[i + 8] - positions[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const length = (Math.hypot(nx, ny, nz) || 1) * (nz < 0 ? -1 : 1);
    nx /= length; ny /= length; nz /= length;
    for (let corner = 0; corner < 9; corner += 3) normals.set([nx, ny, nz], i + corner);
  }
}

// Text in its own colour, unless the look's background would swallow it:
// then near-white on a dark background, near-black on a light one.
export function readable(colour, background) {
  if (!background) return colour;
  const light = (hex) => rgb(hex).reduce((sum, value, i) => sum + value * [0.299, 0.587, 0.114][i], 0);
  const behind = light(background);
  if (Math.abs(light(colour) - behind) >= 0.4) return colour;
  return behind < 0.5 ? '#f2f2f2' : '#141414';
}

function rgb(hex) {
  const value = parseInt((hex || '#000000').slice(1), 16);
  return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// A flat (orthographic) view, column by column, as WebGL wants it: x from -wide
// to wide, y from -tall to tall, everything lowered by drop.
function orthographic(wide, tall, drop) {
  return new Float32Array([1 / wide, 0, 0, 0, 0, 1 / tall, 0, 0, 0, 0, -0.5, 0, 0, -drop / tall, 0, 1]);
}
