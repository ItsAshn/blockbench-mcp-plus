/// <reference types="three" />
/// <reference types="blockbench-types" />
import type { z } from "zod";
import type * as Three from "three";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTool } from "@/lib/factories";
import { runUndoableEdit } from "@/lib/undo";
import { formatUsesBoneRig, getProjectTexture } from "@/lib/util";
import { canCreateOffscreenView, createOffscreenView, deleteOffscreenView, loadViewAngle, renderViewToDataUrl, resolveView } from "@/lib/views";
import { ensurePaintableLayer } from "@/server/tools/paint/runtime";
import { createAnimationFromInput } from "@/server/tools/animation/create";
import { getAnimationClass } from "@/server/tools/animation/shared";
import { workflowToolDocs } from "./docs";
import {
  auditModelParameters,
  buildRigParameters,
  captureViewsParameters,
  generateAnimationParameters,
  paintCubeFacesParameters,
} from "./schemas";
import { boxNetRect, packBoxNets, type IBoxNetRequest, type IUvRect } from "./box-uv-pack";
import { faceRegionFromUv, paintFace, type FaceDirection, type PaintOp } from "./face-paint";
import { buildPreset, detectRoles, type AnimationPreset, type BoneRole, type IBoneInfo } from "./animation-presets";
import { auditModel, type IAuditCube, type IAuditFace, type IAuditSnapshot } from "./model-audit";

declare const THREE: typeof Three;

const DIRECTIONS: readonly FaceDirection[] = ["north", "south", "east", "west", "up", "down"];

/** Expands face selectors ("all", "sides", "front", "back") into concrete directions. */
function expandFaces(selectors: readonly string[] | undefined): FaceDirection[] {
  if (!selectors?.length) return [...DIRECTIONS];
  const out = new Set<FaceDirection>();
  selectors.forEach(selector => {
    if (selector === "all") DIRECTIONS.forEach(direction => out.add(direction));
    else if (selector === "sides") (["north", "south", "east", "west"] as const).forEach(direction => out.add(direction));
    else if (selector === "front") out.add("north");
    else if (selector === "back") out.add("south");
    else out.add(selector as FaceDirection);
  });
  return [...out];
}

function findCube(reference: string): Cube {
  const exact = Cube.all.find(cube => cube.uuid === reference);
  if (exact) return exact;
  const named = Cube.all.filter(cube => cube.name === reference);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`Cube name "${reference}" is ambiguous. Use a UUID from list_outline.`);
  throw new Error(`Cube "${reference}" not found. Use list_outline to inspect cubes.`);
}

function findGroup(reference: string): Group {
  const exact = Group.all.find(group => group.uuid === reference);
  if (exact) return exact;
  const named = Group.all.filter(group => group.name === reference);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`Group name "${reference}" is ambiguous. Use a UUID from list_outline.`);
  throw new Error(`Group "${reference}" not found. Use list_outline to inspect groups.`);
}

/** Every element below `group`, at any depth. */
function descendantElements(group: Group): OutlinerElement[] {
  return group.children.flatMap(child => child instanceof Group ? descendantElements(child) : [child as OutlinerElement]);
}

function groupDepth(group: Group): number {
  let depth = 0;
  let parent: unknown = group.parent;
  while (parent instanceof Group) {
    depth++;
    parent = parent.parent;
  }
  return depth;
}

function cubeSize(from: readonly number[], to: readonly number[]): [number, number, number] {
  return [0, 1, 2].map(i => Math.abs(to[i] - from[i])) as [number, number, number];
}

/** Height of one animation frame; `display_height` can lag behind a just-added texture. */
function frameHeight(texture: Texture): number {
  const frames = Math.max(1, Number((texture as Texture & { frameCount?: number }).frameCount) || 1);
  return texture.height / frames;
}

function textureScale(texture: Texture): [number, number] {
  return [texture.width / texture.getUVWidth(), frameHeight(texture) / texture.getUVHeight()];
}

// ---------------------------------------------------------------------------
// build_rig
// ---------------------------------------------------------------------------

type BuildRigInput = z.infer<typeof buildRigParameters>;

function buildRig(input: BuildRigInput): string {
  if (!Project) throw new Error("Open a project first.");
  const boneRig = formatUsesBoneRig();
  const batchNames = new Set<string>();
  input.bones.forEach(bone => {
    if (batchNames.has(bone.name)) throw new Error(`Bone "${bone.name}" appears twice in this call.`);
    batchNames.add(bone.name);
    if (boneRig && Group.all.some(group => group.name === bone.name)) {
      throw new Error(`A bone named "${bone.name}" already exists; bone-rig formats require unique names.`);
    }
  });
  // Resolve parents before Undo starts: earlier batch bones or existing groups.
  const seen = new Set<string>();
  const parentRefs = input.bones.map(bone => {
    const parent = bone.parent;
    seen.add(bone.name);
    if (!parent) return { kind: "root" as const };
    // A bone named "root" earlier in this call wins over the outliner root keyword.
    if (seen.has(parent) && parent !== bone.name) return { kind: "batch" as const, name: parent };
    if (parent === "root") return { kind: "root" as const };
    if (batchNames.has(parent)) throw new Error(`Bone "${bone.name}" references parent "${parent}" before it is defined; list parents first.`);
    return { kind: "existing" as const, group: findGroup(parent) };
  });
  const texture = input.texture ? getProjectTexture(input.texture) : Texture.getDefault();
  if (input.texture && !texture) throw new Error(`Texture "${input.texture}" not found.`);

  // Plan cube names and UV offsets.
  const plannedCubes = input.bones.flatMap((bone, boneIndex) => (bone.cubes ?? []).map((cube, cubeIndex) => ({
    key: `${boneIndex}:${cubeIndex}`,
    boneIndex,
    spec: cube,
    name: cube.name ?? ((bone.cubes?.length ?? 0) === 1 ? bone.name : `${bone.name}_${cubeIndex + 1}`),
  })));
  const boxUv = Boolean(Project.box_uv);
  const offsets: Record<string, [number, number]> = {};
  let uvSize: [number, number] = [Project.texture_width, Project.texture_height];
  const warnings: string[] = [];
  if (boxUv && input.pack_uv) {
    const reserved: IUvRect[] = [
      ...Cube.all.filter(cube => cube.box_uv).map(cube => boxNetRect(cubeSize(cube.from, cube.to), [cube.uv_offset[0], cube.uv_offset[1]])),
      ...plannedCubes.filter(cube => cube.spec.uv_offset).map(cube => boxNetRect(cubeSize(cube.spec.from, cube.spec.to), cube.spec.uv_offset as [number, number])),
    ];
    const requests: IBoxNetRequest[] = plannedCubes
      .filter(cube => !cube.spec.uv_offset)
      .map(cube => ({ key: cube.key, size: cubeSize(cube.spec.from, cube.spec.to) }));
    const packed = packBoxNets(requests, { reserved, minWidth: Project.texture_width, minHeight: Project.texture_height });
    Object.assign(offsets, packed.offsets);
    uvSize = [packed.width, packed.height];
    if ((uvSize[0] !== Project.texture_width || uvSize[1] !== Project.texture_height) && Texture.all.length) {
      warnings.push(`Project UV size grew from ${Project.texture_width}x${Project.texture_height} to ${uvSize[0]}x${uvSize[1]}. Existing textures now map to a larger UV area; enlarge their canvas (not scale) to keep painted pixels aligned.`);
    }
  }

  const groups: Group[] = [];
  const cubes: Cube[] = [];
  const byName = new Map<string, Group>();
  const result = runUndoableEdit({ groups, elements: cubes, outliner: true, uv_mode: true }, "Agent built rig", () => {
    if (uvSize[0] !== Project!.texture_width || uvSize[1] !== Project!.texture_height) {
      Project!.texture_width = uvSize[0];
      Project!.texture_height = uvSize[1];
    }
    input.bones.forEach((bone, index) => {
      const ref = parentRefs[index];
      const parent = ref.kind === "root" ? "root" : ref.kind === "batch" ? byName.get(ref.name)! : ref.group;
      const group = new Group({ name: bone.name, origin: bone.origin as ArrayVector3, rotation: (bone.rotation ?? [0, 0, 0]) as ArrayVector3 });
      groups.push(group);
      group.init().addTo(parent);
      byName.set(bone.name, group);
    });
    plannedCubes.forEach(planned => {
      const bone = input.bones[planned.boneIndex];
      const { spec } = planned;
      const offset = spec.uv_offset ?? offsets[planned.key];
      const cube = new Cube({
        name: planned.name,
        from: spec.from as ArrayVector3,
        to: spec.to as ArrayVector3,
        origin: (spec.origin ?? bone.origin) as ArrayVector3,
        rotation: (spec.rotation ?? [0, 0, 0]) as ArrayVector3,
        ...(spec.inflate !== undefined && { inflate: spec.inflate }),
        ...(spec.mirror_uv !== undefined && { mirror_uv: spec.mirror_uv }),
        ...(offset && { uv_offset: [offset[0], offset[1]] as ArrayVector2 }),
      });
      cubes.push(cube);
      cube.init().addTo(byName.get(bone.name)!);
      if (texture) cube.applyTexture(texture, true);
    });
    Canvas.updateAll();
    Canvas.updateAllUVs();
    return {
      bones: Object.fromEntries(groups.map(group => [group.name, group.uuid])),
      cubes: cubes.map(cube => ({ name: cube.name, uuid: cube.uuid, ...(cube.box_uv ? { uv_offset: [...cube.uv_offset] } : {}) })),
    };
  });
  return JSON.stringify({
    ...result,
    uv_size: [Project.texture_width, Project.texture_height],
    box_uv: boxUv,
    texture: texture ? texture.name : null,
    next: texture
      ? "Paint with paint_cube_faces."
      : `Create a ${Project.texture_width}x${Project.texture_height} texture (create_texture), then paint with paint_cube_faces.`,
    ...(warnings.length ? { warnings } : {}),
  });
}

// ---------------------------------------------------------------------------
// paint_cube_faces
// ---------------------------------------------------------------------------

type PaintInput = z.infer<typeof paintCubeFacesParameters>;

interface IPaintJob {
  cube: Cube;
  direction: FaceDirection;
  texture: Texture;
  ops: PaintOp[];
}

function planPaintJobs(input: PaintInput): { jobs: IPaintJob[]; skipped: string[] } {
  const forced = input.texture ? getProjectTexture(input.texture) : undefined;
  if (input.texture && !forced) throw new Error(`Texture "${input.texture}" not found.`);
  const jobs: IPaintJob[] = [];
  const skipped: string[] = [];
  input.targets.forEach(target => {
    const cubes = target.cube
      ? [findCube(target.cube)]
      : descendantElements(findGroup(target.group!)).filter((element): element is Cube => element instanceof Cube);
    if (!cubes.length) throw new Error(`Group "${target.group}" contains no cubes.`);
    cubes.forEach(cube => {
      expandFaces(target.faces).forEach(direction => {
        const face = cube.faces[direction];
        if (!face || face.texture === null) {
          skipped.push(`${cube.name}.${direction} (disabled)`);
          return;
        }
        const texture = forced ?? face.getTexture();
        if (!texture) {
          skipped.push(`${cube.name}.${direction} (no texture)`);
          return;
        }
        jobs.push({ cube, direction, texture, ops: target.ops as PaintOp[] });
      });
    });
  });
  return { jobs, skipped };
}

function paintCubeFaces(input: PaintInput): CallToolResult {
  if (!Project) throw new Error("Open a project first.");
  const { jobs, skipped } = planPaintJobs(input);
  if (!jobs.length) throw new Error(`Nothing to paint. Skipped: ${skipped.join(", ") || "no faces selected"}.`);
  const textures = [...new Set(jobs.map(job => job.texture))];
  const sizes: Record<string, Record<string, [number, number]>> = {};
  const hasOps = jobs.some(job => job.ops.length > 0);
  let changed = 0;
  const run = () => {
    textures.forEach(texture => {
      ensurePaintableLayer(texture);
      const { canvas, ctx, offset } = texture.getActiveCanvas() as { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; offset?: number[] };
      const [offsetX, offsetY] = [offset?.[0] ?? 0, offset?.[1] ?? 0];
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const buffer = { width: canvas.width, height: canvas.height, data: image.data };
      const [scaleX, scaleY] = textureScale(texture);
      jobs.filter(job => job.texture === texture).forEach(job => {
        const face = job.cube.faces[job.direction];
        const region = faceRegionFromUv(face.uv, scaleX, scaleY, face.rotation ?? 0);
        region.x0 -= offsetX;
        region.y0 -= offsetY;
        const painted = paintFace(buffer, region, job.direction, job.ops, `${job.cube.uuid}:${job.direction}`);
        changed += painted.changed;
        (sizes[job.cube.name] ??= {})[job.direction] = painted.size;
      });
      if (hasOps) {
        ctx.putImageData(image, 0, 0);
        if (texture.layers_enabled) texture.updateLayerChanges(true);
        texture.updateChangesAfterEdit();
      }
    });
  };
  if (hasOps) runUndoableEdit({ textures, bitmap: true }, "Agent painted cube faces", run);
  else run();
  const summary = {
    painted_faces: hasOps ? jobs.length : 0,
    pixel_writes: changed,
    textures: textures.map(texture => texture.name),
    face_sizes: sizes,
    note: "face_sizes are [width, height] in face-local pixels; (0,0) is each face's top-left as seen on the model.",
    ...(skipped.length ? { skipped } : {}),
  };
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(summary) }];
  if (input.return_texture && textures[0]) {
    const url = textures[0].getDataURL();
    content.push({ type: "image", data: url.replace(/^data:[^;]+;base64,/, ""), mimeType: "image/png" });
  }
  return { content };
}

// ---------------------------------------------------------------------------
// capture_views
// ---------------------------------------------------------------------------

type CaptureInput = z.infer<typeof captureViewsParameters>;

/** Camera directions in editor space. The model faces -Z (north); its right is +X. */
const VIEW_DIRECTIONS: Record<string, { dir: [number, number, number]; label: string }> = {
  front: { dir: [0, 0.15, -1], label: "front (its right = image left)" },
  back: { dir: [0, 0.15, 1], label: "back (its right = image right)" },
  right: { dir: [1, 0.15, 0], label: "its right side (+X)" },
  left: { dir: [-1, 0.15, 0], label: "its left side (-X)" },
  top: { dir: [0, 1, -0.02], label: "top (front = image bottom)" },
  bottom: { dir: [0, -1, -0.02], label: "bottom" },
  front_left: { dir: [-1, 0.6, -1], label: "front-left" },
  front_right: { dir: [1, 0.6, -1], label: "front-right" },
  back_left: { dir: [-1, 0.6, 1], label: "back-left" },
  back_right: { dir: [1, 0.6, 1], label: "back-right" },
};

function modelBounds(target?: string): { center: [number, number, number]; radius: number } {
  const elements = target
    ? (() => {
      const group = Group.all.find(g => g.uuid === target || g.name === target);
      if (group) return descendantElements(group);
      const element = Outliner.elements.find(e => e.uuid === target || e.name === target);
      if (!element) throw new Error(`Target "${target}" not found.`);
      return [element];
    })()
    : Outliner.elements;
  const box = new THREE.Box3();
  elements.forEach(element => {
    const mesh = (element as OutlinerElement & { mesh?: Three.Object3D }).mesh;
    if (!mesh || element.visibility === false) return;
    mesh.updateMatrixWorld(true);
    box.expandByObject(mesh);
  });
  if (box.isEmpty()) throw new Error("Nothing visible to frame.");
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: Math.max(sphere.radius, 1) };
}

/** Mode id that was active, so posing can switch back afterwards. */
function activeModeId(): string | undefined {
  return (Modes as unknown as { selected?: { id?: string } }).selected?.id;
}

function selectMode(id: string | undefined): void {
  if (!id) return;
  (Modes.options as Record<string, { select(): void } | undefined>)[id]?.select();
}

/**
 * Shows the rest pose while measuring: outside Animate mode bones are already
 * at rest; inside it the playhead is moved to a time with no animation selected.
 * @returns A function that restores the previous mode and playhead.
 */
function leaveAnimationPreview(): () => void {
  const mode = activeModeId();
  if (mode !== "animate") return () => undefined;
  const previous = getAnimationClass().selected;
  const time = Timeline.time;
  Modes.options.edit.select();
  return () => {
    selectMode(mode);
    previous?.select();
    Timeline.setTime(time);
    Animator.preview();
  };
}

/**
 * Poses the model at `time` of `animation` in Animate mode.
 * @returns A function that restores the previous mode, animation and playhead.
 */
function poseAnimation(animation: BBAnimation, time: number): () => void {
  const mode = activeModeId();
  const previous = getAnimationClass().selected;
  const previousTime = Timeline.time;
  Modes.options.animate.select();
  animation.select();
  Timeline.setTime(Math.min(time, animation.length || time));
  Animator.preview();
  return () => {
    if (previous && previous !== animation) previous.select();
    Timeline.setTime(previousTime);
    Animator.preview();
    selectMode(mode);
  };
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

async function captureViews(input: CaptureInput): Promise<CallToolResult> {
  if (!Project) throw new Error("Open a project first.");
  if (!canCreateOffscreenView()) throw new Error("The offscreen view limit is reached; delete one with delete_offscreen_view first.");
  const views = input.views ?? ["front", "back", "right", "front_left"];
  const animation = input.animation
    ? getAnimationClass().all.find(entry => entry.uuid === input.animation || entry.name === input.animation || entry.name === `animation.${input.animation}`)
    : undefined;
  if (input.animation && !animation) throw new Error(`Animation "${input.animation}" not found.`);
  // Frame from the rest pose before posing, so every frame of a sequence shares one camera.
  const restoreRest = animation ? leaveAnimationPreview() : undefined;
  let bounds: { center: [number, number, number]; radius: number };
  try {
    bounds = modelBounds(input.target);
  } finally {
    restoreRest?.();
  }
  const { center, radius } = bounds;
  const restorePose = animation ? poseAnimation(animation, input.time ?? 0) : undefined;
  const distance = (radius / Math.sin(((input.fov / 2) * Math.PI) / 180)) * 1.05;
  const id = `capture_views_${Date.now().toString(36)}`;
  createOffscreenView({ id, width: input.tile_size, height: input.tile_size, antialias: true, copyFrom: "none" });
  const tiles: { name: string; url: string }[] = [];
  try {
    const preview = resolveView(id);
    views.forEach(name => {
      const [dx, dy, dz] = VIEW_DIRECTIONS[name].dir;
      const length = Math.hypot(dx, dy, dz);
      const position = [center[0] + (dx / length) * distance, center[1] + (dy / length) * distance, center[2] + (dz / length) * distance];
      loadViewAngle(preview, { position, target: center, projection: "perspective", fov: input.fov });
      tiles.push({ name, url: renderViewToDataUrl(preview) });
    });
  } finally {
    deleteOffscreenView(id);
    restorePose?.();
  }
  const columns = views.length <= 3 ? views.length : views.length === 4 ? 2 : Math.ceil(views.length / 2);
  const rows = Math.ceil(views.length / columns);
  const size = input.tile_size;
  const composite = document.createElement("canvas");
  composite.width = columns * size;
  composite.height = rows * size;
  const ctx = composite.getContext("2d");
  if (!ctx) throw new Error("Cannot create a 2D canvas for the composite.");
  ctx.fillStyle = input.background;
  ctx.fillRect(0, 0, composite.width, composite.height);
  const images = await Promise.all(tiles.map(tile => loadImage(tile.url)));
  images.forEach((image, index) => {
    const x = (index % columns) * size;
    const y = Math.floor(index / columns) * size;
    ctx.drawImage(image, x, y, size, size);
    ctx.strokeStyle = "#45484f";
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    if (!input.labels) return;
    const label = VIEW_DIRECTIONS[tiles[index].name].label;
    ctx.font = `bold ${Math.max(11, Math.round(size / 24))}px sans-serif`;
    const width = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x + 4, y + 4, width + 10, Math.round(size / 24) + 10);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    ctx.fillText(label, x + 9, y + 9);
  });
  const mime = `image/${input.format}`;
  const url = composite.toDataURL(mime, 0.9);
  return {
    content: [
      { type: "image", data: url.replace(/^data:[^;]+;base64,/, ""), mimeType: mime },
      { type: "text", text: JSON.stringify({ views, grid: [columns, rows], center, radius: Math.round(radius * 100) / 100, ...(animation ? { animation: animation.name, time: input.time ?? 0 } : {}) }) },
    ],
  };
}

// ---------------------------------------------------------------------------
// generate_animation
// ---------------------------------------------------------------------------

type GenerateInput = z.infer<typeof generateAnimationParameters>;

function uniqueAnimationName(base: string): string {
  const existing = new Set(getAnimationClass().all.map(animation => animation.name.replace(/^animation\./, "")));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}_${index}`)) index++;
  return `${base}_${index}`;
}

function generateAnimation(input: GenerateInput): string {
  if (!Project || !Format.animation_mode) throw new Error("The current format does not support animations.");
  const bones: IBoneInfo[] = Group.all.map(group => ({ name: group.name, origin: group.origin, depth: groupDepth(group) }));
  const overrides = (input.bones ?? {}) as Partial<Record<BoneRole, string>>;
  Object.values(overrides).forEach(name => {
    if (name && !Group.all.some(group => group.name === name)) throw new Error(`Bone "${name}" not found.`);
  });
  const roles = detectRoles(bones, overrides);
  const preset = buildPreset(input.preset as AnimationPreset, roles, { intensity: input.intensity, speed: input.speed });
  if (input.dry_run) return JSON.stringify({ roles, ...preset });
  const name = uniqueAnimationName(input.name ?? input.preset);
  const created = JSON.parse(createAnimationFromInput({
    name,
    loop: preset.loop,
    animation_length: preset.length,
    bones: preset.bones,
  } as Parameters<typeof createAnimationFromInput>[0])) as Record<string, unknown>;
  return JSON.stringify({ ...created, preset: input.preset, roles });
}

// ---------------------------------------------------------------------------
// audit_model
// ---------------------------------------------------------------------------

type AuditInput = z.infer<typeof auditModelParameters>;

/** Reads a texture's composited pixels once. */
function readPixels(texture: Texture): ImageData | undefined {
  const image = texture.img as HTMLImageElement | undefined;
  if (!image?.naturalWidth) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function opaqueRatio(pixels: ImageData, texture: Texture, face: CubeFace): number {
  const [scaleX, scaleY] = textureScale(texture);
  const region = faceRegionFromUv(face.uv, scaleX, scaleY, 0);
  let total = 0;
  let opaque = 0;
  for (let y = region.y0; y < region.y0 + region.h; y++) {
    for (let x = region.x0; x < region.x0 + region.w; x++) {
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
      total++;
      if (pixels.data[(y * pixels.width + x) * 4 + 3] > 0) opaque++;
    }
  }
  return total ? Math.round((opaque / total) * 100) / 100 : 0;
}

function auditSnapshot(input: AuditInput): IAuditSnapshot {
  const pixelCache = new Map<Texture, ImageData | undefined>();
  const pixelsOf = (texture: Texture) => {
    if (!pixelCache.has(texture)) pixelCache.set(texture, readPixels(texture));
    return pixelCache.get(texture);
  };
  const cubes: IAuditCube[] = Cube.all.map(cube => ({
    uuid: cube.uuid,
    name: cube.name,
    from: [...cube.from],
    to: [...cube.to],
    box_uv: Boolean(cube.box_uv),
    uv_offset: [...cube.uv_offset],
    parent: cube.parent instanceof Group ? cube.parent.uuid : null,
    faces: Object.fromEntries(DIRECTIONS.flatMap(direction => {
      const face = cube.faces[direction];
      if (!face || face.texture === null) return [];
      const texture = face.getTexture();
      const entry: IAuditFace = { uv: [...face.uv], textured: Boolean(texture) };
      if (texture && input.check_pixels) {
        const pixels = pixelsOf(texture);
        if (pixels) entry.opaque_ratio = opaqueRatio(pixels, texture, face);
      }
      return [[direction, entry]];
    })),
  }));
  return {
    format: Format.name ?? Format.id,
    bone_rig: formatUsesBoneRig(),
    per_texture_uv_size: Boolean(Format.per_texture_uv_size),
    uv_width: Project!.texture_width,
    uv_height: Project!.texture_height,
    textures: Texture.all.map(texture => ({ name: texture.name, width: texture.width, height: frameHeight(texture) })),
    cubes,
    groups: Group.all.map(group => ({
      uuid: group.uuid,
      name: group.name,
      origin: [...group.origin],
      parent: group.parent instanceof Group ? group.parent.uuid : null,
      descendant_elements: descendantElements(group).length,
    })),
    meshes: Mesh.all.length,
    animations: Format.animation_mode ? getAnimationClass().all.length : 0,
  };
}

// ---------------------------------------------------------------------------

export function registerWorkflowTools(): void {
  createTool(workflowToolDocs[0].name, {
    ...workflowToolDocs[0],
    parameters: buildRigParameters,
    async execute(input: BuildRigInput) {
      return buildRig(input);
    },
  }, workflowToolDocs[0].status);

  createTool(workflowToolDocs[1].name, {
    ...workflowToolDocs[1],
    parameters: paintCubeFacesParameters,
    async execute(input: PaintInput) {
      return paintCubeFaces(input);
    },
  }, workflowToolDocs[1].status);

  createTool(workflowToolDocs[2].name, {
    ...workflowToolDocs[2],
    parameters: captureViewsParameters,
    async execute(input: CaptureInput) {
      return captureViews(input);
    },
  }, workflowToolDocs[2].status);

  createTool(workflowToolDocs[3].name, {
    ...workflowToolDocs[3],
    parameters: generateAnimationParameters,
    async execute(input: GenerateInput) {
      return generateAnimation(input);
    },
  }, workflowToolDocs[3].status);

  createTool(workflowToolDocs[4].name, {
    ...workflowToolDocs[4],
    parameters: auditModelParameters,
    async execute(input: AuditInput) {
      if (!Project) throw new Error("Open a project first.");
      return JSON.stringify(auditModel(auditSnapshot(input)));
    },
  }, workflowToolDocs[4].status);
}
