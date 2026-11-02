/**
 * Face-relative texture painting. Pure: operates on a plain RGBA buffer so it
 * runs in unit tests and never touches Blockbench globals.
 *
 * Coordinates are face-local pixels with (0, 0) at the face's top-left corner
 * as the face is displayed on the model, so a caller can paint "eyes at row 4"
 * without knowing where the face sits on the texture, whether its UV is
 * mirrored, or how it is rotated. Negative coordinates count from the far edge
 * (-1 is the last row or column).
 */

export type Rgba = [number, number, number, number];
export type ColorInput = string | readonly number[];
export type FaceDirection = "north" | "south" | "east" | "west" | "up" | "down";

/** Mutable RGBA pixel buffer (row-major, 4 bytes per pixel). */
export interface IPixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Where a face lives on the texture, in bitmap pixels. `x0`/`y0`/`w`/`h`
 * describe the unrotated rectangle; `flipX`/`flipY` record reversed UV
 * endpoints (mirrored UV); `rotation` is the face's UV rotation in degrees.
 */
export interface IFaceRegion {
  x0: number;
  y0: number;
  w: number;
  h: number;
  flipX: boolean;
  flipY: boolean;
  rotation: 0 | 90 | 180 | 270;
}

export type PaintOp =
  | { type: "fill"; color: ColorInput }
  | { type: "base"; color: ColorInput; shade?: number; noise?: number }
  | { type: "rect"; x: number; y: number; w?: number; h?: number; color: ColorInput }
  | { type: "pixels"; points: readonly (readonly number[])[]; color: ColorInput }
  | { type: "pattern"; rows: readonly string[]; palette: Record<string, ColorInput>; x?: number; y?: number; align?: PatternAlign }
  | { type: "gradient"; from: ColorInput; to: ColorInput; direction?: "vertical" | "horizontal" }
  | { type: "border"; color: ColorInput; sides?: readonly BorderSide[]; width?: number }
  | { type: "noise"; amount: number; seed?: number }
  | { type: "shade"; factor: number }
  | { type: "erase" };

export type PatternAlign = "top-left" | "top-center" | "center" | "bottom-center";
export type BorderSide = "top" | "bottom" | "left" | "right";

/** Brightness multipliers for `base` shading: light from above, slightly front-biased. */
export const DIRECTION_SHADE: Record<FaceDirection, number> = {
  up: 1.1, down: 0.75, north: 1, south: 0.9, east: 0.93, west: 0.93,
};

/**
 * Parses `#rrggbb`, `#rrggbbaa`, `#rgb`, `[r, g, b]` or `[r, g, b, a]` (0-255).
 * @throws On any other shape.
 */
export function parseColor(input: ColorInput): Rgba {
  if (Array.isArray(input) || typeof input !== "string") {
    const values = [...(input as readonly number[])];
    if ((values.length !== 3 && values.length !== 4) || values.some(v => !Number.isFinite(v))) {
      throw new Error(`Invalid color ${JSON.stringify(input)}; use [r, g, b] or [r, g, b, a] with 0-255 values.`);
    }
    const [r, g, b, a = 255] = values.map(v => Math.max(0, Math.min(255, Math.round(v))));
    return [r, g, b, a];
  }
  const hex = input.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map(ch => ch + ch).join("") : hex;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
    throw new Error(`Invalid color "${input}"; use #rrggbb, #rrggbbaa, #rgb or an [r, g, b, a] array.`);
  }
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), full.length === 8 ? n(6) : 255];
}

/**
 * Converts a face's UV rectangle (logical UV units, endpoints possibly
 * reversed) into a pixel region using the texture's pixels-per-UV-unit scale.
 */
export function faceRegionFromUv(
  uv: readonly number[],
  scaleX: number,
  scaleY: number,
  rotation: number,
): IFaceRegion {
  const [x1, y1, x2, y2] = uv;
  const left = Math.min(x1, x2) * scaleX;
  const top = Math.min(y1, y2) * scaleY;
  const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return {
    x0: Math.round(left),
    y0: Math.round(top),
    w: Math.round(Math.abs(x2 - x1) * scaleX),
    h: Math.round(Math.abs(y2 - y1) * scaleY),
    flipX: x2 < x1,
    flipY: y2 < y1,
    rotation: normalized as IFaceRegion["rotation"],
  };
}

/** Face size as displayed: rotation by 90 or 270 degrees swaps width and height. */
export function localSize(region: IFaceRegion): [number, number] {
  return region.rotation % 180 === 0 ? [region.w, region.h] : [region.h, region.w];
}

/**
 * Maps a displayed face pixel to a texture pixel. Rotation follows Blockbench's
 * convention of rotating the UV image clockwise on the face.
 */
export function localToTexture(region: IFaceRegion, fx: number, fy: number): [number, number] {
  const { w, h } = region;
  let ux: number;
  let uy: number;
  switch (region.rotation) {
    case 90: ux = fy; uy = h - 1 - fx; break;
    case 180: ux = w - 1 - fx; uy = h - 1 - fy; break;
    case 270: ux = w - 1 - fy; uy = fx; break;
    default: ux = fx; uy = fy;
  }
  const tx = region.flipX ? w - 1 - ux : ux;
  const ty = region.flipY ? h - 1 - uy : uy;
  return [region.x0 + tx, region.y0 + ty];
}

/** Deterministic PRNG (mulberry32) so repeated paints give identical noise. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string, used to seed per-face noise. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Resolves a possibly negative coordinate against a face dimension. */
function resolve(value: number, size: number): number {
  return Math.round(value < 0 ? size + value : value);
}

/** Paints face-local pixels, clipping to the face and the buffer. */
class FacePainter {
  readonly lw: number;
  readonly lh: number;
  changed = 0;

  constructor(private readonly buffer: IPixelBuffer, private readonly region: IFaceRegion) {
    [this.lw, this.lh] = localSize(region);
  }

  private index(fx: number, fy: number): number {
    if (fx < 0 || fy < 0 || fx >= this.lw || fy >= this.lh) return -1;
    const [tx, ty] = localToTexture(this.region, fx, fy);
    if (tx < 0 || ty < 0 || tx >= this.buffer.width || ty >= this.buffer.height) return -1;
    return (ty * this.buffer.width + tx) * 4;
  }

  get(fx: number, fy: number): Rgba | undefined {
    const i = this.index(fx, fy);
    if (i < 0) return undefined;
    const d = this.buffer.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  /** Source-over blend; fully opaque colors replace. */
  set(fx: number, fy: number, color: Rgba): void {
    const i = this.index(fx, fy);
    if (i < 0) return;
    const d = this.buffer.data;
    const a = color[3] / 255;
    if (a >= 1) {
      d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = 255;
    } else {
      const da = d[i + 3] / 255;
      const outA = a + da * (1 - a);
      if (outA <= 0) return;
      for (let c = 0; c < 3; c++) d[i + c] = (color[c] * a + d[i + c] * da * (1 - a)) / outA;
      d[i + 3] = outA * 255;
    }
    this.changed++;
  }

  clear(fx: number, fy: number): void {
    const i = this.index(fx, fy);
    if (i < 0) return;
    this.buffer.data.fill(0, i, i + 4);
    this.changed++;
  }

  /** Multiplies RGB of painted (non-transparent) pixels by `factor(fx, fy)`. */
  scale(factor: (fx: number, fy: number) => number): void {
    for (let fy = 0; fy < this.lh; fy++) {
      for (let fx = 0; fx < this.lw; fx++) {
        const i = this.index(fx, fy);
        if (i < 0 || this.buffer.data[i + 3] === 0) continue;
        const k = factor(fx, fy);
        for (let c = 0; c < 3; c++) this.buffer.data[i + c] = this.buffer.data[i + c] * k;
        this.changed++;
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, color: Rgba): void {
    for (let fy = y; fy < y + h; fy++) for (let fx = x; fx < x + w; fx++) this.set(fx, fy, color);
  }
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [0, 1, 2, 3].map(i => a[i] + (b[i] - a[i]) * t) as Rgba;
}

function patternOrigin(op: Extract<PaintOp, { type: "pattern" }>, lw: number, lh: number): [number, number] {
  const pw = Math.max(0, ...op.rows.map(row => [...row].length));
  const ph = op.rows.length;
  const align = op.align ?? "top-left";
  const ax = align === "top-left" ? 0 : Math.floor((lw - pw) / 2);
  const ay = align === "center" ? Math.floor((lh - ph) / 2) : align === "bottom-center" ? lh - ph : 0;
  return [ax + (op.x === undefined ? 0 : resolve(op.x, lw)), ay + (op.y === undefined ? 0 : resolve(op.y, lh))];
}

/** Characters that leave a pattern pixel untouched. */
const PATTERN_SKIP = new Set([".", " "]);

/**
 * Applies `ops` in order to one face.
 *
 * @param seedKey - Stable key (e.g. cube UUID + direction) seeding noise.
 * @returns Face-local size and the number of pixel writes.
 * @throws On invalid colors or unknown pattern characters.
 */
export function paintFace(
  buffer: IPixelBuffer,
  region: IFaceRegion,
  direction: FaceDirection,
  ops: readonly PaintOp[],
  seedKey = "",
): { size: [number, number]; changed: number } {
  const painter = new FacePainter(buffer, region);
  const { lw, lh } = painter;
  ops.forEach((op, opIndex) => {
    switch (op.type) {
      case "fill":
        painter.rect(0, 0, lw, lh, parseColor(op.color));
        break;
      case "erase":
        for (let fy = 0; fy < lh; fy++) for (let fx = 0; fx < lw; fx++) painter.clear(fx, fy);
        break;
      case "base": {
        painter.rect(0, 0, lw, lh, parseColor(op.color));
        const strength = op.shade ?? 1;
        const side = direction !== "up" && direction !== "down";
        const directional = 1 + (DIRECTION_SHADE[direction] - 1) * strength;
        const random = seededRandom(hashString(`${seedKey}:${opIndex}`));
        const noise = op.noise ?? 0.04;
        painter.scale((_, fy) => {
          let k = directional * (1 + (random() * 2 - 1) * noise);
          // Ambient occlusion at the bottom edge and a faint highlight at the top of side faces.
          if (side && lh > 2 && fy === lh - 1) k *= 1 - 0.12 * strength;
          if (side && lh > 3 && fy === 0) k *= 1 + 0.04 * strength;
          return k;
        });
        break;
      }
      case "rect": {
        const x = resolve(op.x, lw);
        const y = resolve(op.y, lh);
        painter.rect(x, y, op.w ?? lw - x, op.h ?? lh - y, parseColor(op.color));
        break;
      }
      case "pixels": {
        const color = parseColor(op.color);
        op.points.forEach(point => painter.set(resolve(point[0], lw), resolve(point[1], lh), color));
        break;
      }
      case "pattern": {
        const palette = Object.fromEntries(Object.entries(op.palette).map(([key, value]) => [key, parseColor(value)]));
        const [ox, oy] = patternOrigin(op, lw, lh);
        op.rows.forEach((row, ry) => {
          [...row].forEach((ch, rx) => {
            if (PATTERN_SKIP.has(ch)) return;
            const color = palette[ch];
            if (!color) throw new Error(`Pattern character "${ch}" has no palette entry. Use "." or space for untouched pixels.`);
            painter.set(ox + rx, oy + ry, color);
          });
        });
        break;
      }
      case "gradient": {
        const from = parseColor(op.from);
        const to = parseColor(op.to);
        const vertical = (op.direction ?? "vertical") === "vertical";
        const span = Math.max(1, (vertical ? lh : lw) - 1);
        for (let fy = 0; fy < lh; fy++) {
          for (let fx = 0; fx < lw; fx++) painter.set(fx, fy, mix(from, to, (vertical ? fy : fx) / span));
        }
        break;
      }
      case "border": {
        const color = parseColor(op.color);
        const width = Math.max(1, Math.round(op.width ?? 1));
        const sides = new Set(op.sides ?? ["top", "bottom", "left", "right"]);
        if (sides.has("top")) painter.rect(0, 0, lw, width, color);
        if (sides.has("bottom")) painter.rect(0, lh - width, lw, width, color);
        if (sides.has("left")) painter.rect(0, 0, width, lh, color);
        if (sides.has("right")) painter.rect(lw - width, 0, width, lh, color);
        break;
      }
      case "noise": {
        const random = seededRandom(op.seed ?? hashString(`${seedKey}:${opIndex}`));
        painter.scale(() => 1 + (random() * 2 - 1) * op.amount);
        break;
      }
      case "shade":
        painter.scale(() => op.factor);
        break;
    }
  });
  return { size: [lw, lh], changed: painter.changed };
}
