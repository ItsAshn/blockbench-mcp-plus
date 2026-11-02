import { z } from "zod";
import { vec3 } from "@/lib/zodObjects";
import { ANIMATION_PRESETS, BONE_ROLES } from "./animation-presets";

/**
 * Fresh color schema per field: repeated schema instances are emitted as bare
 * `$ref`s that some clients cannot resolve (see `vec3` in lib/zodObjects).
 */
const color = (description = "Color as #rrggbb, #rrggbbaa, #rgb, or [r, g, b(, a)] with 0-255 values.") =>
  z.union([z.string(), z.array(z.number()).min(3).max(4)]).describe(description);

const coord = (description: string) => z.number().describe(`${description} Face-local pixels; negative values count from the far edge (-1 = last).`);

const paintOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fill"), color: color() }).describe("Fill the whole face."),
  z.object({
    type: z.literal("base"),
    color: color(),
    shade: z.number().min(0).max(2).optional().describe("Directional shading strength (top lit, bottom dark, bottom-edge occlusion). Default 1; 0 disables."),
    noise: z.number().min(0).max(0.5).optional().describe("Per-pixel brightness jitter. Default 0.04."),
  }).describe("Base coat: fill plus face-direction shading and subtle noise, so faces never look flat."),
  z.object({
    type: z.literal("rect"),
    x: coord("Left edge."),
    y: coord("Top edge."),
    w: z.number().int().positive().optional().describe("Width; defaults to the remaining face width."),
    h: z.number().int().positive().optional().describe("Height; defaults to the remaining face height."),
    color: color(),
  }),
  z.object({
    type: z.literal("pixels"),
    points: z.array(z.array(z.number()).length(2)).min(1).describe("Face-local [x, y] points; negative values count from the far edge."),
    color: color(),
  }),
  z.object({
    type: z.literal("pattern"),
    rows: z.array(z.string()).min(1).describe("ASCII pixel art, one string per row. Each character maps through palette; '.' and space leave pixels untouched."),
    palette: z.record(color()).describe("Character -> color, e.g. {\"e\": \"#222\", \"w\": \"#fff\"}."),
    x: z.number().optional().describe("Offset added after alignment."),
    y: z.number().optional().describe("Offset added after alignment."),
    align: z.enum(["top-left", "top-center", "center", "bottom-center"]).optional().describe("Anchor of the pattern on the face. Default top-left."),
  }).describe("Stamp pixel art (faces, emblems, buckles) without computing coordinates."),
  z.object({
    type: z.literal("gradient"),
    from: color("Start color (top or left)."),
    to: color("End color (bottom or right)."),
    direction: z.enum(["vertical", "horizontal"]).optional(),
  }),
  z.object({
    type: z.literal("border"),
    color: color(),
    sides: z.array(z.enum(["top", "bottom", "left", "right"])).optional().describe("Default: all four."),
    width: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("noise"),
    amount: z.number().min(0).max(1).describe("Brightness jitter, e.g. 0.06."),
    seed: z.number().int().optional(),
  }),
  z.object({ type: z.literal("shade"), factor: z.number().min(0).max(4).describe("Brightness multiplier for painted pixels.") }),
  z.object({ type: z.literal("erase") }).describe("Clear the face to transparent."),
]);

const faceSelector = z.enum(["north", "south", "east", "west", "up", "down", "all", "sides", "front", "back"]);

export const paintCubeFacesParameters = z.object({
  texture: z.string().optional().describe("Texture UUID or name. Defaults to the texture each face resolves to."),
  targets: z.array(z.object({
    cube: z.string().optional().describe("Cube UUID or name."),
    group: z.string().optional().describe("Group UUID or name: paints every cube inside it."),
    faces: z.array(faceSelector).optional().describe("Faces to paint. 'sides' = north/south/east/west, 'front' = north, 'back' = south. Default: all."),
    ops: z.array(paintOp).describe("Operations applied in order to each selected face. Empty to only report face sizes."),
  }).refine(target => Boolean(target.cube) !== Boolean(target.group), { message: "Give exactly one of cube or group." }))
    .min(1),
  return_texture: z.boolean().default(false).describe("Return the painted texture image."),
});

const cubeSpec = z.object({
  name: z.string().optional(),
  from: vec3("Minimum corner."),
  to: vec3("Maximum corner."),
  origin: vec3("Cube pivot. Defaults to the bone origin.").optional(),
  rotation: vec3("Cube rotation in degrees.").optional(),
  inflate: z.number().optional(),
  mirror_uv: z.boolean().optional(),
  uv_offset: z.array(z.number()).length(2).optional().describe("Explicit box UV offset; skips auto packing for this cube."),
});

export const buildRigParameters = z.object({
  bones: z.array(z.object({
    name: z.string().min(1),
    parent: z.string().optional().describe("Parent bone: a bone earlier in this list (a bone named \"root\" here counts as a bone), an existing group name/UUID, or omitted/\"root\" for the outliner root."),
    origin: vec3("Bone pivot."),
    rotation: vec3("Bone rotation in degrees.").optional(),
    cubes: z.array(cubeSpec).optional(),
  })).min(1).describe("Bones in parent-before-child order, each with its cubes."),
  texture: z.string().optional().describe("Texture to apply to every new cube. Defaults to the project's default texture, if any."),
  pack_uv: z.boolean().default(true).describe("Box UV projects: assign non-overlapping uv_offsets to new cubes, avoiding existing nets, and grow the project UV size if needed."),
});

export const captureViewsParameters = z.object({
  views: z.array(z.enum(["front", "back", "left", "right", "top", "bottom", "front_left", "front_right", "back_left", "back_right"]))
    .min(1).max(8).optional()
    .describe("Angles named from the model's point of view (it faces north/-Z; its right is +X). Default: front, back, right, front_left."),
  tile_size: z.number().int().min(64).max(1024).default(320).describe("Pixel size of each square tile."),
  fov: z.number().min(5).max(90).default(30).describe("Perspective field of view; small values look near-orthographic."),
  target: z.string().optional().describe("Group or element to frame. Default: the whole model."),
  labels: z.boolean().default(true),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  animation: z.string().optional().describe("Animation name or UUID to pose the model with. Framing stays on the rest pose, so frames line up for GIFs."),
  time: z.number().min(0).optional().describe("Animation time in seconds (with animation). Default 0."),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2b2d33").describe("Composite background color."),
});

export const generateAnimationParameters = z.object({
  preset: z.enum(ANIMATION_PRESETS as unknown as [string, ...string[]]),
  name: z.string().optional().describe("Animation name. Default: the preset name."),
  bones: z.record(z.string()).optional().describe(`Role -> bone name overrides. Roles: ${BONE_ROLES.join(", ")}. Unset roles are detected from bone names (and X position for limbs).`),
  intensity: z.number().min(0.1).max(3).default(1).describe("Amplitude multiplier."),
  speed: z.number().min(0.1).max(5).default(1).describe("Playback speed multiplier."),
  dry_run: z.boolean().default(false).describe("Only report detected roles and keyframes."),
});

export const auditModelParameters = z.object({
  check_pixels: z.boolean().default(true).describe("Read texture pixels to find unpainted faces."),
});
