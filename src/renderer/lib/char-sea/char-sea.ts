import glassTextureUrl from '../../../assets/design/glass-thick.png';
import {
  CHAR_SEA_STEP_RATE,
  CHAR_SEA_WATER_CELL,
  CharSeaGlyphs,
  CharSeaRain,
  CharSeaWater,
  charSeaCellsCovered,
  layoutCharSea,
  type CharSeaLayout,
} from './char-sea-model';
import { CHAR_SEA_LANGUAGES, type CharSeaScript } from './char-sea-text';

/**
 * 字海 — the sea of characters under the shelf and the full-window waits
 * (docs/design-system/components.md, "全屏加载与字海").
 *
 * At rest it is a sheet of manuscript paper: a faint dot in each cell and
 * nothing computed or drawn. Where a wave passes, each dot surfaces into its
 * character; the glyph drifts with the slope and swells on the crest as a
 * whole. What sits on the page (the shelf's cards) is drawn here as the app's
 * resting glass line, so the water can reach it: a crest thickens and deepens
 * the glass in the line and bleeds a little inward, a trough thins it. The
 * line itself never moves.
 *
 * While something loads, rain runs down the sheet's columns, and in the middle
 * the water itself rises into the word "Loading" in an old serif, so the
 * sheet's own characters surface along its strokes as they do on a crest. The
 * word is held by a spring and the rain falls on its own: a ring the hand makes
 * knocks both about and they come back by themselves. Meanwhile the characters
 * under the rain and in the word keep changing, and every cell's own character
 * drifts slowly through the passage's letters (CharSeaGlyphs). When the wait
 * ends the rain fades and the word is let go: one ring leaves from its outline
 * and spreads under the next page. A page that waits on the author instead (the first-run choice) has
 * only the rain: it falls round the page with no word in the middle. Before
 * that page a first run raises the app's name the same way, and lets it go
 * when the card comes. Glass set down on the sea (that card, the sample book
 * landing on the shelf) arrives with no resting line: the water shows its rim,
 * then the line settles in; a line that goes eases out the same way.
 */

/** A piece of glass on the page, in CSS px of the window. */
export interface CharSeaShape {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /**
   * Strength of the resting line: the app's resting glass is 0.85; 0 shows
   * only what the water brings; below 0 no line at all, only the veil (the
   * sea under it at 12%).
   */
  rest: number;
  /** Whether the pointer is on it (bleed in, unevenness drifting). */
  hover: boolean;
  /**
   * Glass set down on the sea (the first-run card, the sample book landing):
   * its resting line starts from nothing, so the water shows its rim first.
   */
  arrive?: boolean;
  /** Where the glass texture starts in the shape, as `.glass:nth-of-type` places it. */
  textureX: number;
  textureY: number;
}

export interface CharSea {
  /** A press: one clean ring from (x, y). */
  drop(x: number, y: number, amplitude?: number): void;
  /** The pointer moved: a light wake, stronger the faster it goes. */
  wake(x: number, y: number): void;
  /**
   * The page it lay under is gone (a wait opened the workspace): no more
   * drops or hands, the resting dots fade, and the rings already out run
   * their course. Calls back once the water is still; `setActive(false)`
   * then puts it away. Becoming active again (or `live()`) calls it off.
   */
  ebb(onStill: () => void): void;
  live(): void;
  /**
   * Something is loading: the rain falls and the word rises; false lets both
   * go. `word` names it (the first run raises the app's name); a word already
   * standing gives way to it, and it rises in its place.
   */
  loading(on: boolean, word?: string): void;
  /** Only the rain, no word; it keeps falling while either holds it. */
  rain(on: boolean): void;
  setShapes(shapes: readonly CharSeaShape[]): void;
  setScript(script: CharSeaScript): void;
  /** Off: no frame is computed or drawn until it is on again. */
  setActive(active: boolean): void;
  /** Re-read colours from the CSS tokens after the theme changes. */
  refreshTheme(): void;
  /** The window changed size: the water is laid again (still) and redrawn. */
  resize(): void;
  destroy(): void;
}

const MAX_SHAPES = 16;
// A cap on drawn pixels, so a large window on a dense display stays light.
const PIXEL_BUDGET = 6_000_000;
const DROP_RADIUS = 2.2;
// The loading word: an old serif (the system's Times New Roman, or its metric
// twin Tinos), about 30% of the window's height and at most 70% of its width.
// It rises to WORD_HEIGHT over WORD_RISE seconds and breathes ±WORD_SWELL every
// WORD_BREATH seconds.
const LOADING_WORD = 'Loading';
const LOADING_FONT = (size: number) => `700 ${size}px "Times New Roman", Tinos, Times, serif`;
const WORD_HEIGHT = 0.45;
const WORD_RISE = 0.7;
const WORD_BREATH = 2.6;
const WORD_SWELL = 0.12;
// Let go, the word's silhouette is raised this many times over and leaves as one
// ring from its outline (CharSeaWater.hold), reaching the sidebars and the bottom bar.
const WORD_BURST = 4;
// Strength and size of the glass line, as materials.css draws it at rest.
const GLASS_EDGE = 0.594; // --glass-edge 33% × 1.8
const GLASS_TILE = 150;
// A resting line that comes or goes eases to its strength at this rate a
// second: two thirds of the way in a third of a second, settled in about one.
const REST_EASE = 3;

/**
 * What a page other than the app's own may ask of the sea: the drifting.cc
 * landing page (scripts/design-assets/landing) raises its name instead of
 * "Loading", higher up, over a denser sheet on a narrow window, with the
 * risen characters a little heavier so the capitals read. The app passes none
 * of these and gets the sea described above.
 */
export interface CharSeaOptions {
  /** The word the water raises while something loads. */
  word?: string;
  /** Where the word's middle sits, as a share of the window's height. */
  wordCentreY?: number;
  /** How much of the window's width the word may span. */
  wordSpan?: (width: number) => number;
  /** How many times denser than the app's the cells are packed. */
  density?: (width: number) => number;
  /** 0–1: how much heavier, darker and nearer the accent the risen word's own characters are. */
  wordInk?: number;
}

const VERTEX = '#version 300 es\nin vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uH;uniform sampler2D uAtlas;uniform sampler2D uMap;uniform sampler2D uGlassTex;
uniform sampler2D uRain;uniform sampler2D uWordSim;uniform float uWordH;uniform float uWordInk;
uniform vec2 uRes;uniform float uDpr;uniform vec2 uWin;uniform vec2 uSim;
uniform vec2 uCells;uniform vec2 uCell;uniform vec2 uOrigin;uniform float uAN;uniform vec2 uSlot;
uniform float uRest;uniform float uPeak;uniform float uMul;
uniform vec3 uGround;uniform vec3 uInk;uniform vec3 uTint;uniform vec3 uGlass;uniform vec3 uBleed;
uniform vec4 uShape[${MAX_SHAPES}];uniform vec4 uShapeP[${MAX_SHAPES}];uniform vec4 uShapeT[${MAX_SHAPES}];uniform int uShapes;
out vec4 o;
float hAt(vec2 p){return texture(uH,p/uWin).r;}
float wAt(vec2 p){return texture(uWordSim,p/uWin).r;}
float sdBox(vec2 p,vec4 R,float r){vec2 hs=R.zw*.5;vec2 d=abs(p-R.xy-hs)-hs+r;return length(max(d,0.))+min(max(d.x,d.y),0.)-r;}
void main(){
  vec2 px=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uDpr;
  vec2 st=uWin/uSim;
  vec3 col=uGround;
  // under what sits on the page the field shows at 12%
  float m=1.;
  for(int i=0;i<${MAX_SHAPES};i++){if(i>=uShapes)break;
    m=min(m,mix(1.,.12,1.-smoothstep(0.,10.,sdBox(px,uShape[i],uShapeP[i].x))));}
  vec2 cf=(px-uOrigin)/uCell;vec2 ci=floor(cf);vec2 f=cf-ci;
  if(ci.x>=0.&&ci.y>=0.&&ci.x<uCells.x&&ci.y<uCells.y){
    vec2 cc=uOrigin+(ci+.5)*uCell;float hc=hAt(cc);vec2 sx=vec2(st.x,0.);vec2 sy=vec2(0.,st.y);
    // the loading word's own standing slope moves no glyph: its characters sit square in their cells
    vec2 g=vec2(hAt(cc+sx)-hAt(cc-sx),hAt(cc+sy)-hAt(cc-sy))-uWordH*vec2(wAt(cc+sx)-wAt(cc-sx),wAt(cc+sy)-wAt(cc-sy));
    // the rain: a trail surfaces a cell to 70%, a head tints it, and both bend further with the water
    vec2 rd=texture(uRain,(ci+.5)/uCells).rg;
    float lim=(.3+.4*rd.x)*uCell.y;vec2 off=clamp(g*26.*(1.+1.5*rd.x),-lim,lim);float cr=clamp(hc*3.,-1.,1.);float sc=1.+.2*cr;
    vec2 fl=.5+((f-.5)*uCell-off)/(uCell*sc);
    float s=max(smoothstep(.04,.26,abs(hc)),.7*rd.x);
    float dt=1.-smoothstep(.35,.95,length((f-.5)*uCell-off));
    float gi=floor(texture(uMap,(ci+.5)/uCells).r*255.+.5);
    vec2 auv=(vec2(mod(gi,uAN),floor(gi/uAN))+clamp(fl,0.,1.))*uSlot;
    float inSlot=step(0.,fl.x)*step(fl.x,1.)*step(0.,fl.y)*step(fl.y,1.);
    float gl=texture(uAtlas,auv).a*inSlot;
    // a page may ask for the risen word's own characters heavier, darker and nearer the accent; the app's uWordInk is 0
    float wk=uWordInk>0.?uWordInk*smoothstep(.25,.75,wAt(cc))*clamp(uWordH*2.2,0.,1.):0.;
    if(wk>0.){vec2 bo=vec2(uSlot.x*.055,0.);gl=mix(gl,max(gl,max(texture(uAtlas,auv+bo).a,texture(uAtlas,auv-bo).a)*inSlot),wk);}
    float a=min(1.,mix(dt*uRest,gl*uPeak*(.6+.4*max(cr,rd.y))*(1.+.5*wk),s))*m;
    vec3 c=mix(uInk,uTint,min(1.,.45*s*max(cr,0.)+.55*rd.y+.35*wk));
    col=uMul>.5?col*mix(vec3(1.),c,a):mix(col,c,a);
  }
  // the glass lines stay where they are; only the glass in them follows the water
  if(uShapes>0){
    float up=clamp(hAt(px)*4.,-.8,1.);
    float ra=0.;float ba=0.;
    for(int i=0;i<${MAX_SHAPES};i++){if(i>=uShapes)break;
      vec4 R=uShape[i];vec4 P=uShapeP[i];if(P.y<0.)continue;
      float sd=sdBox(px,R,P.x);if(sd>2.||sd<-24.)continue;
      float cut=texture(uGlassTex,(px-R.xy-uShapeT[i].xy-vec2(P.w))/${GLASS_TILE}.).a;
      float base=max(P.y,P.z);
      float G=base>.01?base*(1.+.75*up):.9*max(up,0.);
      float hw=max(.12,.5+.45*up);
      float ring=1.-smoothstep(hw-.3,hw+.3,abs(sd+.5));
      float bleed=sd<0.?exp(sd/4.)*(.5*P.z+.3*max(up,0.)):0.;
      ra=max(ra,ring*clamp(${GLASS_EDGE}*G,0.,1.)*cut);ba=max(ba,bleed*${GLASS_EDGE}*cut);
    }
    col=mix(col,uBleed,clamp(ba,0.,.6));
    col=mix(col,uGlass,clamp(ra,0.,.9));
  }
  o=vec4(col,1.);
}`;

let supported: boolean | null = null;

/** Whether this webview can draw the sea (WebGL2 with float textures). Probed once. */
export function charSeaSupported(): boolean {
  if (supported !== null) return supported;
  try {
    const probe = document.createElement('canvas').getContext('webgl2');
    supported = !!probe;
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    supported = false;
  }
  return supported;
}

interface Theme {
  ground: number[];
  ink: number[];
  tint: number[];
  glass: number[];
  bleed: number[];
  multiply: boolean;
  rest: number;
  peak: number;
}

function hslTriplet(value: string): number[] {
  const [h, s, l] = value.trim().split(/\s+/).map((part) => parseFloat(part));
  const sat = (Number.isFinite(s) ? s : 0) / 100;
  const light = (Number.isFinite(l) ? l : 50) / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + (Number.isFinite(h) ? h : 0) / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

function cssColour(value: string, fallback: number[]): number[] {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16) / 255);
  const rgb = /rgba?\(([^)]+)\)/i.exec(text);
  if (rgb) return rgb[1].split(/[\s,/]+/).slice(0, 3).map((part) => parseFloat(part) / 255);
  return fallback;
}

/** Colours from the tokens (index.css, materials.css), as the app's sand and glass use them. */
function readTheme(): Theme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const dark = root.dataset.colorScheme === 'dark' || root.classList.contains('dark');
  const glass = cssColour(style.getPropertyValue('--glass-clear'), dark ? [0.42, 0.43, 0.4] : [0.71, 0.71, 0.68]);
  const lift = (parseFloat(style.getPropertyValue('--glass-bleed-lift')) || 0) / 100;
  return {
    ground: hslTriplet(style.getPropertyValue('--paper-deep')),
    ink: hslTriplet(style.getPropertyValue('--ink-2')),
    tint: hslTriplet(style.getPropertyValue('--accent')),
    glass,
    bleed: glass.map((v) => v + (1 - v) * lift),
    // Light themes lay ink on by multiplying; dark ones lay it on lifted.
    multiply: !dark,
    rest: dark ? 0.09 : 0.075,
    peak: dark ? 0.58 : 0.62,
  };
}

/** The loading word's size and the height of its middle in a window, CSS px. */
function placeWord(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: CharSeaOptions,
  word = options.word ?? LOADING_WORD,
) {
  const span = options.wordSpan?.(width) ?? 0.7;
  let size = height * 0.3;
  context.font = LOADING_FONT(size);
  const wide = context.measureText(word).width;
  if (wide > width * span) size *= (width * span) / wide;
  return { word, size, centreY: height * (options.wordCentreY ?? 0.5) };
}

/** Where the loading word's ink stands in a window, CSS px, so a page can lay its own text round it. */
export function charSeaWordBox(width: number, height: number, options: CharSeaOptions = {}) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return null;
  const { word, size, centreY } = placeWord(context, width, height, options);
  context.font = LOADING_FONT(size);
  const metrics = context.measureText(word);
  const half = (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) / 2;
  return { top: centreY - half, bottom: centreY + half, size };
}

/** A page's sheet: the language's cells, packed `density` times tighter. */
function seaLanguage(script: CharSeaScript, width: number, options: CharSeaOptions) {
  const language = CHAR_SEA_LANGUAGES[script];
  const density = options.density?.(width) ?? 1;
  return density === 1 ? language : { ...language, cellWidth: language.cellWidth / density, cellHeight: language.cellHeight / density };
}

/** The loading word as each water cell's share of its ink, centred across the window. */
function loadingWordShape(
  water: CharSeaWater,
  width: number,
  height: number,
  options: CharSeaOptions,
  text: string,
): Float32Array {
  const shape = new Float32Array(water.cols * water.rows);
  const samples = 4;
  const raster = document.createElement('canvas');
  raster.width = water.cols * samples;
  raster.height = water.rows * samples;
  const context = raster.getContext('2d', { willReadFrequently: true });
  if (!context) return shape;
  const { word, size, centreY } = placeWord(context, width, height, options, text);
  const scale = samples / CHAR_SEA_WATER_CELL;
  context.font = LOADING_FONT(size * scale);
  const metrics = context.measureText(word);
  context.fillStyle = '#fff';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.fillText(word, (width / 2) * scale,
    centreY * scale + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
  const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
  for (let row = 0; row < water.rows; row += 1) {
    for (let col = 0; col < water.cols; col += 1) {
      let sum = 0;
      for (let j = 0; j < samples; j += 1) {
        for (let k = 0; k < samples; k += 1) sum += pixels[((row * samples + j) * raster.width + col * samples + k) * 4 + 3];
      }
      shape[row * water.cols + col] = sum / (samples * samples * 255);
    }
  }
  return shape;
}

export function createCharSea(canvas: HTMLCanvasElement, options: CharSeaOptions = {}): CharSea | null {
  const context = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!context) return null;
  const gl: WebGL2RenderingContext = context;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${gl.getShaderInfoLog(shader) ?? 'no log'}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  try {
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'char sea link');
  } catch (error) {
    console.warn('[char-sea] disabled:', error);
    return null;
  }
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const U = {
    h: uniform('uH'), atlas: uniform('uAtlas'), map: uniform('uMap'), glassTex: uniform('uGlassTex'),
    res: uniform('uRes'), dpr: uniform('uDpr'), win: uniform('uWin'), sim: uniform('uSim'),
    cells: uniform('uCells'), cell: uniform('uCell'), origin: uniform('uOrigin'), an: uniform('uAN'), slot: uniform('uSlot'),
    rest: uniform('uRest'), peak: uniform('uPeak'), mul: uniform('uMul'),
    ground: uniform('uGround'), ink: uniform('uInk'), tint: uniform('uTint'), glass: uniform('uGlass'), bleed: uniform('uBleed'),
    shape: uniform('uShape'), shapeP: uniform('uShapeP'), shapeT: uniform('uShapeT'), shapes: uniform('uShapes'),
    rain: uniform('uRain'), wordSim: uniform('uWordSim'), wordH: uniform('uWordH'), wordInk: uniform('uWordInk'),
  };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const texture = (unit: number, filter: number, wrap: number) => {
    const handle = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return handle;
  };
  const heightTexture = texture(0, gl.LINEAR, gl.CLAMP_TO_EDGE);
  const atlasTexture = texture(1, gl.LINEAR, gl.CLAMP_TO_EDGE);
  const mapTexture = texture(2, gl.NEAREST, gl.CLAMP_TO_EDGE);
  const glassTexture = texture(3, gl.LINEAR, gl.REPEAT);
  // Until the texture loads the line is drawn even.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  const rainTexture = texture(4, gl.NEAREST, gl.CLAMP_TO_EDGE);
  const wordTexture = texture(5, gl.LINEAR, gl.CLAMP_TO_EDGE);

  let alive = true;
  let active = false;
  let running = false;
  let raf = 0;
  let last = 0;
  let accumulated = 0;
  let quietFrames = 0;
  let theme = readTheme();
  let script: CharSeaScript = 'zh';
  let width = 0;
  let height = 0;
  let water: CharSeaWater | null = null;
  let layout: CharSeaLayout | null = null;
  let atlasColumns = 1;
  let slotU = 1;
  let slotV = 1;
  let rain: CharSeaRain | null = null;
  let rainDirty = false;
  // The rain is asked for on its own (`rain(true)`), not only by a wait.
  let rainHeld = false;
  let glyphs: CharSeaGlyphs | null = null;
  let glyphsDirty = false;
  let wordText = options.word ?? LOADING_WORD;
  let wordShape: Float32Array | null = null;
  let wordCells: Uint8Array | null = null;
  // held: the spring holds the word up; time: since it began to rise; height:
  // its height now; shown: the height the shader takes as the word's own
  // (its slope moves no glyph), which eases away once it is let go.
  const word = { held: false, time: 0, height: 0, shown: 0 };
  // Ebbing: input is off and the resting dots fade (restScale → 0) while the
  // rings already out run their course.
  let ebbing = false;
  let onEbbStill: (() => void) | null = null;
  let restScale = 1;
  let lastMove: { x: number; y: number; at: number } | null = null;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let shapes: CharSeaShape[] = [];
  const hoverAmount = new Map<number, number>();
  const flowOffset = new Map<number, number>();
  // Each shape's resting line as drawn, easing toward its `rest`.
  const restShown = new Map<number, number>();
  const shapeRect = new Float32Array(MAX_SHAPES * 4);
  const shapeParams = new Float32Array(MAX_SHAPES * 4);
  const shapeTexture = new Float32Array(MAX_SHAPES * 4);

  const glassImage = new Image();
  glassImage.onload = () => {
    if (!alive) return;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, glassTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glassImage);
    draw();
  };
  glassImage.src = glassTextureUrl;

  function buildAtlas(): void {
    if (!layout) return;
    const language = CHAR_SEA_LANGUAGES[script];
    const slotHeight = 32;
    const slotWidth = Math.round((slotHeight * language.cellWidth) / language.cellHeight);
    atlasColumns = Math.ceil(Math.sqrt(layout.glyphs.length));
    const atlas = document.createElement('canvas');
    atlas.width = atlasColumns * slotWidth;
    atlas.height = Math.ceil(layout.glyphs.length / atlasColumns) * slotHeight;
    slotU = slotWidth / atlas.width;
    slotV = slotHeight / atlas.height;
    const context = atlas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `400 ${Math.round(slotHeight * language.size)}px ${language.font}`;
    layout.glyphs.forEach((glyph, n) => {
      context.fillText(glyph, (n % atlasColumns) * slotWidth + slotWidth / 2,
        Math.floor(n / atlasColumns) * slotHeight + slotHeight / 2 + slotHeight * 0.03);
    });
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  function lay(): void {
    if (!layout) return;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mapTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, layout.cols, layout.rows, 0, gl.RED, gl.UNSIGNED_BYTE, layout.map);
    glyphs = new CharSeaGlyphs(layout);
    if (wordShape && water) wordCells = charSeaCellsCovered(layout, wordShape, water.cols, water.rows);
    // A new sheet has new columns: the rain starts over on them.
    const raining = rain?.raining ?? false;
    rain = new CharSeaRain(layout.cols, layout.rows);
    if (raining) rain.start();
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, rainTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, layout.cols, layout.rows, 0, gl.RG, gl.UNSIGNED_BYTE, rain.cells);
    buildAtlas();
    const face = CHAR_SEA_LANGUAGES[script].loadFace;
    const wanted = script;
    document.fonts?.load(`400 24px ${face}`, layout.glyphs.join('')).then(() => {
      if (alive && script === wanted) { buildAtlas(); draw(); }
    }, () => undefined);
  }

  function measure(): void {
    const nextWidth = Math.max(1, canvas.clientWidth || window.innerWidth);
    const nextHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
    if (nextWidth === width && nextHeight === height && water) return;
    width = nextWidth;
    height = nextHeight;
    water = new CharSeaWater(width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, water.cols, water.rows, 0, gl.RED, gl.FLOAT, water.heights);
    shapeWord();
    if (word.held && wordShape) water.hold(wordShape);
    layout = layoutCharSea(width, height, seaLanguage(script, width, options));
    lay();
  }

  // The word's ink on this water, for the spring, the shader and the cells
  // whose characters change in it (found again when the sheet is laid, `lay`).
  function shapeWord(): void {
    if (!water) return;
    wordShape = loadingWordShape(water, width, height, options, wordText);
    if (layout) wordCells = charSeaCellsCovered(layout, wordShape, water.cols, water.rows);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, wordTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, water.cols, water.rows, 0, gl.RED, gl.UNSIGNED_BYTE,
      Uint8Array.from(wordShape, (share) => Math.round(share * 255)));
  }

  function draw(): void {
    if (!alive || !active || !water || !layout) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(PIXEL_BUDGET / (width * height)));
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, water.cols, water.rows, gl.RED, gl.FLOAT, water.heights);
    if (glyphsDirty && glyphs) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, mapTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, layout.cols, layout.rows, gl.RED, gl.UNSIGNED_BYTE, glyphs.live);
      glyphsDirty = false;
    }
    if (rainDirty && rain) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, rainTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rain.cols, rain.rows, gl.RG, gl.UNSIGNED_BYTE, rain.cells);
      rainDirty = false;
    }
    gl.uniform1i(U.h, 0);
    gl.uniform1i(U.atlas, 1);
    gl.uniform1i(U.map, 2);
    gl.uniform1i(U.glassTex, 3);
    gl.uniform1i(U.rain, 4);
    gl.uniform1i(U.wordSim, 5);
    gl.uniform1f(U.wordH, word.shown);
    gl.uniform1f(U.wordInk, options.wordInk ?? 0);
    gl.uniform2f(U.res, pixelWidth, pixelHeight);
    gl.uniform1f(U.dpr, pixelWidth / width);
    gl.uniform2f(U.win, width, height);
    gl.uniform2f(U.sim, water.cols, water.rows);
    gl.uniform2f(U.cells, layout.cols, layout.rows);
    gl.uniform2f(U.cell, layout.cellWidth, layout.cellHeight);
    gl.uniform2f(U.origin, layout.originX, layout.originY);
    gl.uniform1f(U.an, atlasColumns);
    gl.uniform2f(U.slot, slotU, slotV);
    gl.uniform1f(U.rest, theme.rest * restScale);
    gl.uniform1f(U.peak, theme.peak);
    gl.uniform1f(U.mul, theme.multiply ? 1 : 0);
    gl.uniform3fv(U.ground, theme.ground);
    gl.uniform3fv(U.ink, theme.ink);
    gl.uniform3fv(U.tint, theme.tint);
    gl.uniform3fv(U.glass, theme.glass);
    gl.uniform3fv(U.bleed, theme.bleed);
    const count = Math.min(MAX_SHAPES, shapes.length);
    for (let i = 0; i < count; i += 1) {
      const shape = shapes[i];
      shapeRect.set([shape.x, shape.y, shape.width, shape.height], i * 4);
      shapeParams.set([shape.radius, restShown.get(shape.id) ?? shape.rest, hoverAmount.get(shape.id) ?? 0, flowOffset.get(shape.id) ?? 0], i * 4);
      shapeTexture.set([shape.textureX, shape.textureY, 0, 0], i * 4);
    }
    gl.uniform4fv(U.shape, shapeRect);
    gl.uniform4fv(U.shapeP, shapeParams);
    gl.uniform4fv(U.shapeT, shapeTexture);
    gl.uniform1i(U.shapes, count);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Glass eases toward its state: the bleed comes in over about 0.24s, a
  // hovered rim's unevenness drifts 10px a second (one 150px lap in 15s), and a
  // resting line that comes or goes settles in about a second (REST_EASE).
  function easeGlass(dt: number): boolean {
    let moving = false;
    const k = 1 - Math.exp(-dt * 12);
    const kRest = 1 - Math.exp(-dt * REST_EASE);
    for (const shape of shapes) {
      const target = shape.hover ? 1 : 0;
      const amount = hoverAmount.get(shape.id) ?? 0;
      const next = amount + (target - amount) * k;
      hoverAmount.set(shape.id, next);
      if (next > 0.001) flowOffset.set(shape.id, (flowOffset.get(shape.id) ?? 0) + dt * 10 * next);
      if (target > 0 || Math.abs(target - next) > 0.01) moving = true;
      const rest = restShown.get(shape.id) ?? shape.rest;
      if (rest !== shape.rest) {
        const eased = rest + (shape.rest - rest) * kRest;
        restShown.set(shape.id, Math.abs(shape.rest - eased) < 0.005 ? shape.rest : eased);
        moving = true;
      }
    }
    return moving;
  }

  // A shape seen for the first time draws its line at once, unless it arrives,
  // when the line starts from nothing; shapes gone are forgotten.
  function noteRests(): boolean {
    const present = new Set<number>();
    let easing = false;
    for (const shape of shapes) {
      present.add(shape.id);
      if (still) restShown.set(shape.id, shape.rest);
      else if (!restShown.has(shape.id)) restShown.set(shape.id, shape.arrive ? 0 : shape.rest);
      if (restShown.get(shape.id) !== shape.rest) easing = true;
    }
    for (const id of restShown.keys()) if (!present.has(id)) restShown.delete(id);
    return easing;
  }

  // The word rises and breathes while held, and its own height eases away once
  // let go; the rain falls and breaks where the water knocks it. Returns
  // whether either is still moving.
  function moveLoading(dt: number): boolean {
    if (!water || !layout) return false;
    if (word.held) {
      word.time += dt;
      const rise = 1 - (1 - Math.min(1, word.time / WORD_RISE)) ** 3;
      word.height = WORD_HEIGHT * rise * (1 + WORD_SWELL * Math.sin((2 * Math.PI * word.time) / WORD_BREATH));
      word.shown = word.height;
      water.setHoldHeight(word.height);
    } else if (word.shown) {
      word.shown *= Math.exp(-dt / 0.15);
      if (word.shown < 0.002) word.shown = 0;
    }
    let raining = false;
    if (rain) {
      const sheet = layout;
      const sea = water;
      raining = rain.tick(dt, (col, row) =>
        sea.offRest(sheet.originX + (col + 0.5) * sheet.cellWidth, sheet.originY + row * sheet.cellHeight));
      rainDirty = true;
    }
    let changing = false;
    if (glyphs) {
      const swap = glyphs.tick(dt, rain?.cells ?? null, word.shown > 0.05 ? wordCells : null);
      changing = swap.changing;
      if (swap.changed) glyphsDirty = true;
    }
    return word.held || word.shown > 0 || raining || changing;
  }

  function letLoadingGo(): void {
    if (!rainHeld) rain?.stop();
    if (word.held) water?.hold(null, WORD_BURST);
    word.held = false;
  }

  function frame(now: number): void {
    raf = 0;
    if (!alive || !active || !water) {
      running = false;
      return;
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const loadingMoving = moveLoading(dt);
    const glassMoving = easeGlass(dt);
    // The resting dots come and go over about 0.3s.
    const restTarget = ebbing ? 0 : 1;
    restScale += (restTarget - restScale) * (1 - Math.exp(-dt * 10));
    if (Math.abs(restTarget - restScale) < 0.005) restScale = restTarget;
    const restMoving = restScale !== restTarget;
    accumulated += dt;
    const steps = Math.min(6, Math.floor(accumulated * CHAR_SEA_STEP_RATE));
    accumulated -= steps / CHAR_SEA_STEP_RATE;
    let peak = 0;
    for (let s = 0; s < steps; s += 1) peak = Math.max(peak, water.step());
    draw();
    // Still water and still glass: one last frame, then nothing until something touches it.
    // Above 100Hz a frame can fall between two steps; it neither moves the water nor settles it.
    if (glassMoving || restMoving || loadingMoving) quietFrames = 0;
    else if (steps) quietFrames = peak < 0.004 ? quietFrames + 1 : 0;
    if (quietFrames > 20) {
      water.clear();
      draw();
      running = false;
      last = 0;
      accumulated = 0;
      if (ebbing && onEbbStill) {
        const done = onEbbStill;
        onEbbStill = null;
        done();
      }
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function kick(): void {
    if (!alive || !active || running) return;
    running = true;
    quietFrames = 0;
    raf = requestAnimationFrame(frame);
  }

  measure();

  return {
    drop(x, y, amplitude = 1.2) {
      if (still || !water || ebbing) return;
      water.splash(x, y, amplitude, DROP_RADIUS);
      kick();
    },
    wake(x, y) {
      if (still || !water || ebbing) return;
      const now = performance.now();
      if (lastMove && now - lastMove.at < 100) {
        const dx = x - lastMove.x;
        const dy = y - lastMove.y;
        const distance = Math.hypot(dx, dy);
        const speed = (distance / Math.max(1, now - lastMove.at)) * 1000;
        const amplitude = Math.min(0.09, speed * 0.00006);
        if (amplitude > 0.006) {
          const steps = Math.max(1, Math.ceil(distance / CHAR_SEA_WATER_CELL));
          for (let i = 1; i <= steps; i += 1) {
            water.splash(lastMove.x + (dx * i) / steps, lastMove.y + (dy * i) / steps, amplitude / Math.sqrt(steps), 1.3);
          }
          kick();
        }
      }
      lastMove = { x, y, at: now };
    },
    ebb(onStill) {
      // The wait that just ended has let its rain and word go; they run out under the workspace.
      ebbing = true;
      onEbbStill = onStill;
      if (still) restScale = 0;
      kick();
    },
    live() {
      ebbing = false;
      onEbbStill = null;
      if (still) restScale = 1;
      kick();
    },
    loading(on, named) {
      if (!on) {
        letLoadingGo();
        kick();
        return;
      }
      if (still || !water) return;
      const next = named ?? options.word ?? LOADING_WORD;
      if (next !== wordText) {
        wordText = next;
        shapeWord();
        // The word standing lets go as the spring takes the new one, which rises in its place.
        if (word.held && wordShape) {
          water.hold(wordShape);
          word.time = 0;
        }
      }
      if (!wordShape) return;
      rain?.start();
      if (!word.held) {
        word.held = true;
        word.time = 0;
        water.hold(wordShape);
      }
      kick();
    },
    rain(on) {
      rainHeld = on;
      if (!on) {
        if (!word.held) rain?.stop();
        kick();
        return;
      }
      if (still) return;
      rain?.start();
      kick();
    },
    setShapes(next) {
      shapes = next.slice(0, MAX_SHAPES);
      const easing = noteRests();
      if (running) return;
      if (easing || shapes.some((shape) => shape.hover || (hoverAmount.get(shape.id) ?? 0) > 0.001)) kick();
      else draw();
    },
    setScript(next) {
      if (next === script) return;
      script = next;
      layout = layoutCharSea(width, height, seaLanguage(script, width, options));
      lay();
      draw();
    },
    setActive(next) {
      if (next === active) return;
      active = next;
      if (active) {
        ebbing = false;
        onEbbStill = null;
        restScale = 1;
        last = 0;
        measure();
        if (rainHeld && !still) rain?.start();
        draw();
        kick();
      } else {
        letLoadingGo();
        word.shown = 0;
        // put away with nothing lit: the next wait's rain starts on a dry sheet
        if (rain) rain = new CharSeaRain(rain.cols, rain.rows);
        rainDirty = true;
        if (layout) glyphs = new CharSeaGlyphs(layout);
        glyphsDirty = true;
        water?.clear();
      }
    },
    refreshTheme() {
      theme = readTheme();
      draw();
    },
    resize() {
      measure();
      draw();
    },
    // Frees what it made but keeps the canvas's context: a remount (React's
    // development double mount included) makes the sea again on the same one.
    destroy() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      [heightTexture, atlasTexture, mapTexture, glassTexture, rainTexture, wordTexture].forEach((handle) => gl.deleteTexture(handle));
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    },
  };
}
