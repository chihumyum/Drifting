import glassTextureUrl from '../../../assets/design/glass-thick.png';
import {
  CHAR_SEA_STEP_RATE,
  CHAR_SEA_WATER_CELL,
  CharSeaWater,
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
   * sea under it at 12%), for panels the sea passes under.
   */
  rest: number;
  /** Whether the pointer is on it (bleed in, unevenness drifting). */
  hover: boolean;
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
  /** Drops falling at one place every `period` ms (the first after `delay`); null stops them. */
  pulse(origin: { x: number; y: number } | null, period?: number, delay?: number): void;
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
const PULSE_AMPLITUDE = 1.05;
const DROP_RADIUS = 2.2;
// Strength and size of the glass line, as materials.css draws it at rest.
const GLASS_EDGE = 0.594; // --glass-edge 33% × 1.8
const GLASS_TILE = 150;

const VERTEX = '#version 300 es\nin vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uH;uniform sampler2D uAtlas;uniform sampler2D uMap;uniform sampler2D uGlassTex;
uniform vec2 uRes;uniform float uDpr;uniform vec2 uWin;uniform vec2 uSim;
uniform vec2 uCells;uniform vec2 uCell;uniform vec2 uOrigin;uniform float uAN;uniform vec2 uSlot;
uniform float uRest;uniform float uPeak;uniform float uMul;
uniform vec3 uGround;uniform vec3 uInk;uniform vec3 uTint;uniform vec3 uGlass;uniform vec3 uBleed;
uniform vec4 uShape[${MAX_SHAPES}];uniform vec4 uShapeP[${MAX_SHAPES}];uniform vec4 uShapeT[${MAX_SHAPES}];uniform int uShapes;
out vec4 o;
float hAt(vec2 p){return texture(uH,p/uWin).r;}
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
    vec2 cc=uOrigin+(ci+.5)*uCell;float hc=hAt(cc);
    vec2 g=vec2(hAt(cc+vec2(st.x,0.))-hAt(cc-vec2(st.x,0.)),hAt(cc+vec2(0.,st.y))-hAt(cc-vec2(0.,st.y)));
    vec2 off=clamp(g*26.,-3.,3.);float cr=clamp(hc*3.,-1.,1.);float sc=1.+.2*cr;
    vec2 fl=.5+((f-.5)*uCell-off)/(uCell*sc);
    float s=smoothstep(.04,.26,abs(hc));
    float dt=1.-smoothstep(.35,.95,length((f-.5)*uCell-off));
    float gi=floor(texture(uMap,(ci+.5)/uCells).r*255.+.5);
    vec2 auv=(vec2(mod(gi,uAN),floor(gi/uAN))+clamp(fl,0.,1.))*uSlot;
    float gl=texture(uAtlas,auv).a*step(0.,fl.x)*step(fl.x,1.)*step(0.,fl.y)*step(fl.y,1.);
    float a=mix(dt*uRest,gl*uPeak*(.6+.4*cr),s)*m;
    vec3 c=mix(uInk,uTint,.45*s*max(cr,0.));
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

export function createCharSea(canvas: HTMLCanvasElement): CharSea | null {
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
  let pulse: { x: number; y: number; period: number; next: number } | null = null;
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
    layout = layoutCharSea(width, height, CHAR_SEA_LANGUAGES[script]);
    lay();
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
    gl.uniform1i(U.h, 0);
    gl.uniform1i(U.atlas, 1);
    gl.uniform1i(U.map, 2);
    gl.uniform1i(U.glassTex, 3);
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
      shapeParams.set([shape.radius, shape.rest, hoverAmount.get(shape.id) ?? 0, flowOffset.get(shape.id) ?? 0], i * 4);
      shapeTexture.set([shape.textureX, shape.textureY, 0, 0], i * 4);
    }
    gl.uniform4fv(U.shape, shapeRect);
    gl.uniform4fv(U.shapeP, shapeParams);
    gl.uniform4fv(U.shapeT, shapeTexture);
    gl.uniform1i(U.shapes, count);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Glass eases toward its state: the bleed comes in over about 0.24s and a
  // hovered rim's unevenness drifts 10px a second (one 150px lap in 15s).
  function easeGlass(dt: number): boolean {
    let moving = false;
    const k = 1 - Math.exp(-dt * 12);
    for (const shape of shapes) {
      const target = shape.hover ? 1 : 0;
      const amount = hoverAmount.get(shape.id) ?? 0;
      const next = amount + (target - amount) * k;
      hoverAmount.set(shape.id, next);
      if (next > 0.001) flowOffset.set(shape.id, (flowOffset.get(shape.id) ?? 0) + dt * 10 * next);
      if (target > 0 || Math.abs(target - next) > 0.01) moving = true;
    }
    return moving;
  }

  function frame(now: number): void {
    raf = 0;
    if (!alive || !active || !water) {
      running = false;
      return;
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    if (pulse && now >= pulse.next) {
      water.splash(pulse.x, pulse.y, PULSE_AMPLITUDE, DROP_RADIUS);
      pulse.next = now + pulse.period;
    }
    const glassMoving = easeGlass(dt);
    // The resting dots come and go over about 0.3s.
    const restTarget = ebbing ? 0 : 1;
    restScale += (restTarget - restScale) * (1 - Math.exp(-dt * 10));
    if (Math.abs(restTarget - restScale) < 0.005) restScale = restTarget;
    const restMoving = restScale !== restTarget;
    accumulated += dt;
    const steps = Math.min(6, Math.floor(accumulated * CHAR_SEA_STEP_RATE));
    accumulated -= steps / CHAR_SEA_STEP_RATE;
    let peak = steps ? 0 : 1;
    for (let s = 0; s < steps; s += 1) peak = Math.max(peak, water.step());
    draw();
    // Still water and still glass: one last frame, then nothing until something touches it.
    quietFrames = peak < 0.004 && !glassMoving && !restMoving && !pulse ? quietFrames + 1 : 0;
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
      // Drops still due from the wait that just ended fall; the wait's end stops them.
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
    pulse(origin, period = 1100, delay = 0) {
      if (!origin || still) {
        pulse = null;
        return;
      }
      pulse = { x: origin.x, y: origin.y, period, next: performance.now() + delay };
      kick();
    },
    setShapes(next) {
      shapes = next.slice(0, MAX_SHAPES);
      if (running) return;
      if (shapes.some((shape) => shape.hover || (hoverAmount.get(shape.id) ?? 0) > 0.001)) kick();
      else draw();
    },
    setScript(next) {
      if (next === script) return;
      script = next;
      layout = layoutCharSea(width, height, CHAR_SEA_LANGUAGES[script]);
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
        draw();
        kick();
      } else {
        pulse = null;
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
      [heightTexture, atlasTexture, mapTexture, glassTexture].forEach((handle) => gl.deleteTexture(handle));
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    },
  };
}
