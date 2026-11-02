/**
 * Model audit over a plain snapshot of the project. Pure, so every check is
 * unit-testable; the tool layer builds the snapshot from Blockbench globals.
 */
import { boxNetRect, rectsOverlap, type IUvRect } from "./box-uv-pack";
import { declaredSide } from "./animation-presets";

export type AuditSeverity = "error" | "warning" | "info";

export interface IAuditFace {
  uv: readonly number[];
  /** Whether a texture resolves for this face. */
  textured: boolean;
  /** Share of the face's pixels with alpha > 0, when a texture bitmap was readable. */
  opaque_ratio?: number;
}

export interface IAuditCube {
  uuid: string;
  name: string;
  from: readonly number[];
  to: readonly number[];
  box_uv: boolean;
  uv_offset: readonly number[];
  parent: string | null;
  faces: Partial<Record<string, IAuditFace>>;
}

export interface IAuditGroup {
  uuid: string;
  name: string;
  origin: readonly number[];
  parent: string | null;
  /** Number of elements anywhere below this group. */
  descendant_elements: number;
}

export interface IAuditTexture {
  name: string;
  width: number;
  height: number;
}

export interface IAuditSnapshot {
  format: string;
  bone_rig: boolean;
  per_texture_uv_size: boolean;
  uv_width: number;
  uv_height: number;
  textures: IAuditTexture[];
  cubes: IAuditCube[];
  groups: IAuditGroup[];
  meshes: number;
  animations: number;
}

export interface IAuditIssue {
  severity: AuditSeverity;
  code: string;
  message: string;
  elements?: string[];
}

export interface IAuditReport {
  verdict: "ok" | "has_warnings" | "has_errors";
  counts: Record<AuditSeverity, number>;
  stats: Record<string, number | string>;
  issues: IAuditIssue[];
}

/** Elements listed per issue before the list is truncated. */
const MAX_LISTED = 12;

function list(names: string[]): string[] {
  return names.length > MAX_LISTED ? [...names.slice(0, MAX_LISTED), `…and ${names.length - MAX_LISTED} more`] : names;
}

function cubeSize(cube: IAuditCube): [number, number, number] {
  return [0, 1, 2].map(i => Math.abs(cube.to[i] - cube.from[i])) as [number, number, number];
}

/** Box UV net rectangle of a cube, in project UV units. */
export function cubeNet(cube: IAuditCube): IUvRect {
  return boxNetRect(cubeSize(cube), [cube.uv_offset[0] ?? 0, cube.uv_offset[1] ?? 0]);
}

/**
 * Runs every check and returns issues ordered by severity.
 * Side checks use Blockbench editor space, where the model faces -Z and its
 * own right side is +X.
 */
export function auditModel(snapshot: IAuditSnapshot): IAuditReport {
  const issues: IAuditIssue[] = [];
  const push = (severity: AuditSeverity, code: string, message: string, elements?: string[]) =>
    issues.push({ severity, code, message, ...(elements?.length ? { elements: list(elements) } : {}) });
  const { uv_width: uvW, uv_height: uvH } = snapshot;

  // --- Texture / UV size consistency (project-wide UV formats only) ---
  if (!snapshot.per_texture_uv_size && snapshot.textures.length) {
    snapshot.textures.forEach(texture => {
      const textureAspect = texture.width / texture.height;
      const uvAspect = uvW / uvH;
      if (Math.abs(textureAspect - uvAspect) > 1e-6) {
        push("warning", "texture_aspect_mismatch",
          `Texture "${texture.name}" is ${texture.width}x${texture.height} but the project UV size is ${uvW}x${uvH}; the texture will stretch. Match the aspect ratio or change the project UV size.`);
      } else if (texture.width > uvW && texture.width % uvW === 0) {
        push("info", "texture_hd",
          `Texture "${texture.name}" is ${texture.width / uvW}x the project UV size (${uvW}x${uvH}); each UV unit spans ${texture.width / uvW} pixels. If the texture was painted at 1 pixel per UV unit, set the project UV size to ${texture.width}x${texture.height}.`);
      }
    });
  }

  // --- Box UV nets: bounds and overlaps ---
  const boxCubes = snapshot.cubes.filter(cube => cube.box_uv);
  const outside = boxCubes.filter(cube => {
    const net = cubeNet(cube);
    return net.x < 0 || net.y < 0 || net.x + net.w > uvW || net.y + net.h > uvH;
  });
  if (outside.length) {
    push("error", "uv_out_of_bounds",
      `${outside.length} box UV net(s) extend past the ${uvW}x${uvH} UV canvas, so those faces sample nothing or wrap. Enlarge the project UV size or repack (build_rig auto-packs).`,
      outside.map(cube => cube.name));
  }
  const overlapping = new Set<string>();
  const shared = new Set<string>();
  for (let i = 0; i < boxCubes.length; i++) {
    for (let j = i + 1; j < boxCubes.length; j++) {
      const a = cubeNet(boxCubes[i]);
      const b = cubeNet(boxCubes[j]);
      if (!rectsOverlap(a, b)) continue;
      const identical = a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
      (identical ? shared : overlapping).add(boxCubes[i].name).add(boxCubes[j].name);
    }
  }
  if (overlapping.size) {
    push("warning", "uv_overlap",
      `Box UV nets of ${overlapping.size} cubes partially overlap, so painting one cube bleeds into another.`, [...overlapping]);
  }
  if (shared.size) {
    push("info", "uv_shared", `${shared.size} cubes share identical box UV nets (fine for intentional mirrored limbs).`, [...shared]);
  }

  // --- Per-face UV bounds for non-box cubes ---
  const faceOutside = snapshot.cubes.filter(cube => !cube.box_uv && Object.values(cube.faces).some(face =>
    face && face.textured && face.uv.some((value, index) => value < 0 || value > (index % 2 === 0 ? uvW : uvH))));
  if (faceOutside.length && !snapshot.per_texture_uv_size) {
    push("warning", "face_uv_out_of_bounds", `${faceOutside.length} cube(s) have face UVs outside the UV canvas.`, faceOutside.map(cube => cube.name));
  }

  // --- Texturing coverage ---
  if (snapshot.textures.length) {
    const untextured = snapshot.cubes.filter(cube => Object.values(cube.faces).every(face => !face?.textured));
    if (untextured.length) push("warning", "untextured_cubes", `${untextured.length} cube(s) have no texture on any face.`, untextured.map(cube => cube.name));
    const blank: string[] = [];
    const sparse: string[] = [];
    snapshot.cubes.forEach(cube => {
      Object.entries(cube.faces).forEach(([direction, face]) => {
        if (!face?.textured || face.opaque_ratio === undefined) return;
        // Faces mapped to at most one UV unit are deliberate slivers (hidden plane
        // sides pointed at a transparent pixel, edges of 0-thickness planes).
        const area = Math.abs((face.uv[2] - face.uv[0]) * (face.uv[3] - face.uv[1]));
        if (area <= 1) return;
        if (face.opaque_ratio === 0) blank.push(`${cube.name}.${direction}`);
        else if (face.opaque_ratio < 0.5) sparse.push(`${cube.name}.${direction}`);
      });
    });
    if (blank.length) push("warning", "unpainted_faces", `${blank.length} textured face(s) are fully transparent (unpainted).`, blank);
    if (sparse.length) push("info", "sparse_faces", `${sparse.length} face(s) are less than half painted.`, sparse);
  }

  // --- Hierarchy ---
  if (snapshot.bone_rig) {
    const rootCubes = snapshot.cubes.filter(cube => cube.parent === null);
    if (rootCubes.length) {
      push("warning", "cubes_outside_bones",
        `${rootCubes.length} cube(s) sit at the outliner root; ${snapshot.format} exports cubes inside bones, so they cannot be animated.`, rootCubes.map(cube => cube.name));
    }
    const seen = new Map<string, number>();
    snapshot.groups.forEach(group => seen.set(group.name, (seen.get(group.name) ?? 0) + 1));
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    if (duplicates.length) push("error", "duplicate_bone_names", "Bone names must be unique in bone-rig formats; only one of each duplicate survives export.", duplicates);
  }
  const empty = snapshot.groups.filter(group => group.descendant_elements === 0);
  if (empty.length) push("info", "empty_groups", `${empty.length} group(s) contain no elements (fine for pivots/locators).`, empty.map(group => group.name));
  const flat = snapshot.cubes.filter(cube => cubeSize(cube).filter(size => size === 0).length >= 1);
  if (flat.length) push("info", "flat_cubes", `${flat.length} cube(s) have a zero dimension (planes).`, flat.map(cube => cube.name));

  // --- Left/right naming vs position (model's right = +X in the editor) ---
  const mismatched: string[] = [];
  const check = (name: string, x: number) => {
    const side = declaredSide(name);
    if (side === "right" && x < -0.5) mismatched.push(`${name} (x=${x})`);
    if (side === "left" && x > 0.5) mismatched.push(`${name} (x=${x})`);
  };
  snapshot.groups.forEach(group => check(group.name, group.origin[0] ?? 0));
  snapshot.cubes.forEach(cube => check(cube.name, Math.round(((cube.from[0] + cube.to[0]) / 2) * 100) / 100));
  if (mismatched.length) {
    push("warning", "side_naming",
      "Names contradict position. In Blockbench editor space the model faces -Z (north), so its own right side is +X and its left is -X.", mismatched);
  }

  const order: Record<AuditSeverity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = {
    error: issues.filter(issue => issue.severity === "error").length,
    warning: issues.filter(issue => issue.severity === "warning").length,
    info: issues.filter(issue => issue.severity === "info").length,
  };
  return {
    verdict: counts.error ? "has_errors" : counts.warning ? "has_warnings" : "ok",
    counts,
    stats: {
      format: snapshot.format,
      uv_size: `${uvW}x${uvH}`,
      cubes: snapshot.cubes.length,
      meshes: snapshot.meshes,
      groups: snapshot.groups.length,
      textures: snapshot.textures.length,
      animations: snapshot.animations,
    },
    issues,
  };
}
