/**
 * Box UV net packing. Pure: no Blockbench globals, so it is unit-testable and
 * importable by the docs generator.
 *
 * A box UV net for a cube of size [w, h, d] occupies a (2d + 2w) x (d + h)
 * rectangle starting at the cube's `uv_offset`, matching Blockbench's
 * `Cube#updateUV` box layout: top row holds up/down (each w x d, starting at
 * x = d), bottom row holds east, north, west, south (heights h).
 */

/** Integer rectangle in UV units. */
export interface IUvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One net to place. `size` is the cube size [w, h, d] in UV units. */
export interface IBoxNetRequest {
  key: string;
  size: readonly [number, number, number];
}

/** Packing outcome: an offset per request key and the UV canvas size that holds every net. */
export interface IBoxPackResult {
  offsets: Record<string, [number, number]>;
  width: number;
  height: number;
}

/** Options for {@link packBoxNets}. */
export interface IBoxPackOptions {
  /** Rectangles already in use (e.g. nets of existing cubes); new nets avoid them. */
  reserved?: readonly IUvRect[];
  /** Smallest UV width/height to return; packing never shrinks the project below this. */
  minWidth?: number;
  minHeight?: number;
  /** Largest UV side length to try. */
  maxSize?: number;
}

/**
 * Blockbench floors each cube dimension (with a small epsilon) when laying out
 * a box UV net unless the format allows float sizes; a zero-thickness cube still
 * gets a one-unit band so faces stay addressable.
 */
export function boxNetDimension(value: number): number {
  return Math.max(0, Math.floor(Math.abs(value) + 1e-7));
}

/** Width and height of the box UV net for a cube of `size` [w, h, d]. */
export function boxNetSize(size: readonly [number, number, number]): [number, number] {
  const [w, h, d] = size.map(boxNetDimension);
  return [Math.max(1, 2 * (w + d)), Math.max(1, d + h)];
}

/** The rectangle a cube's box UV net covers at `offset`. */
export function boxNetRect(size: readonly [number, number, number], offset: readonly [number, number]): IUvRect {
  const [w, h] = boxNetSize(size);
  return { x: offset[0], y: offset[1], w, h };
}

/** Whether two rectangles share any area. Touching edges do not overlap. */
export function rectsOverlap(a: IUvRect, b: IUvRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function nextPow2(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/** Occupancy grid with first-fit placement scanning rows top to bottom, left to right. */
class Occupancy {
  private rows: Uint8Array[] = [];

  constructor(private readonly width: number) {}

  private row(y: number): Uint8Array {
    while (this.rows.length <= y) this.rows.push(new Uint8Array(this.width));
    return this.rows[y];
  }

  mark(rect: IUvRect): void {
    for (let y = Math.max(0, rect.y); y < rect.y + rect.h; y++) {
      const row = this.row(y);
      for (let x = Math.max(0, rect.x); x < Math.min(this.width, rect.x + rect.w); x++) row[x] = 1;
    }
  }

  private free(x: number, y: number, w: number, h: number): boolean {
    for (let yy = y; yy < y + h; yy++) {
      const row = this.rows[yy];
      if (!row) continue;
      for (let xx = x; xx < x + w; xx++) if (row[xx]) return false;
    }
    return true;
  }

  /** Finds the first free spot for a w x h rectangle; the grid grows downward as needed. */
  place(w: number, h: number): [number, number] {
    if (w > this.width) throw new Error(`Net width ${w} exceeds packing width ${this.width}.`);
    for (let y = 0; ; y++) {
      for (let x = 0; x + w <= this.width; x++) {
        if (this.free(x, y, w, h)) {
          this.mark({ x, y, w, h });
          return [x, y];
        }
      }
    }
  }
}

/**
 * Packs box UV nets into the smallest power-of-two UV canvas, avoiding
 * reserved rectangles. Larger nets are placed first. Among candidate widths the
 * smallest area wins; ties prefer the squarer canvas.
 *
 * @throws When a single net is wider than `maxSize`.
 */
export function packBoxNets(requests: readonly IBoxNetRequest[], options: IBoxPackOptions = {}): IBoxPackResult {
  const reserved = options.reserved ?? [];
  const maxSize = options.maxSize ?? 4096;
  const nets = requests.map(request => ({ key: request.key, dims: boxNetSize(request.size) }));
  const widest = Math.max(1, ...nets.map(net => net.dims[0]), ...reserved.map(rect => rect.x + rect.w));
  const reservedBottom = Math.max(0, ...reserved.map(rect => rect.y + rect.h));
  const order = [...nets].sort((a, b) => b.dims[1] - a.dims[1] || b.dims[0] - a.dims[0]);
  const startWidth = Math.max(16, options.minWidth ?? 0, nextPow2(widest));
  if (startWidth > maxSize) throw new Error(`A box UV net needs ${widest} UV units of width; the maximum is ${maxSize}.`);

  let best: IBoxPackResult | undefined;
  for (let width = startWidth; width <= maxSize; width *= 2) {
    const grid = new Occupancy(width);
    reserved.forEach(rect => grid.mark(rect));
    const offsets: Record<string, [number, number]> = {};
    let bottom = reservedBottom;
    order.forEach(net => {
      const [x, y] = grid.place(net.dims[0], net.dims[1]);
      offsets[net.key] = [x, y];
      bottom = Math.max(bottom, y + net.dims[1]);
    });
    const height = Math.max(16, options.minHeight ?? 0, nextPow2(bottom));
    const candidate = { offsets, width, height };
    if (!best) {
      best = candidate;
      continue;
    }
    const area = width * height;
    const bestArea = best.width * best.height;
    const squareness = Math.abs(Math.log2(width / height));
    const bestSquareness = Math.abs(Math.log2(best.width / best.height));
    if (area < bestArea || (area === bestArea && squareness < bestSquareness)) best = candidate;
    // Wider canvases only add area once everything fits in one row band.
    if (height <= width) break;
  }
  if (!best) throw new Error("Box UV packing produced no layout.");
  return best;
}
