import type { IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import {
  auditModelParameters,
  buildRigParameters,
  captureViewsParameters,
  generateAnimationParameters,
  paintCubeFacesParameters,
} from "./schemas";

/**
 * Workflow tools: higher-level operations that replace long chains of
 * low-level calls (and the coordinate math agents get wrong).
 *
 * Registration reads these by index: `[0]` build_rig, `[1]` paint_cube_faces,
 * `[2]` capture_views, `[3]` generate_animation, `[4]` audit_model.
 */
export const workflowToolDocs: IToolSpec[] = [
  {
    name: "build_rig",
    condition: { project: true, features: ["edit_mode"] },
    description:
      "Creates a whole bone hierarchy with its cubes in one undoable edit. Bones may reference earlier bones in the same call as parents. " +
      "On box UV projects it packs every new cube's UV net without overlaps (avoiding existing nets) and grows the project UV size when needed, " +
      "so a texture painted at one pixel per UV unit maps correctly. Returns bone/cube UUIDs, uv_offsets and the UV size to create the texture at.",
    annotations: { title: "Build Rig", destructiveHint: false },
    parameters: buildRigParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "paint_cube_faces",
    condition: { project: true },
    description:
      "Paints cube faces in face-local pixel coordinates: (0,0) is the face's top-left as seen on the model, regardless of where the face sits on the texture, " +
      "box UV mirroring or UV rotation. Ops: base (fill + directional shading + noise), fill, rect, pixels, pattern (ASCII pixel art with a palette), gradient, border, noise, shade, erase. " +
      "Target cubes or whole groups; faces accept 'all', 'sides', 'front' (north) and 'back' (south). One undo step. Returns each face's pixel size.",
    annotations: { title: "Paint Cube Faces", destructiveHint: false },
    parameters: paintCubeFacesParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "capture_views",
    condition: { project: true },
    description:
      "Renders several labelled angles of the model (or one group) into a single composite image using a temporary offscreen view, auto-framed from the model bounds. " +
      "The user's viewport is not moved. View names follow the model: front shows its face (north/-Z), right shows its own right side (+X). Pass animation and time to render a pose (framing stays on the rest pose so sequences line up for GIFs).",
    annotations: { title: "Capture Views", readOnlyHint: true },
    parameters: captureViewsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "generate_animation",
    condition: { project: true, features: ["animation_mode"] },
    description:
      "Generates a base animation cycle (idle, walk, run, attack, hurt, death, jump) for the current rig. Bone roles (root, body, head, arms, legs, tail, wings) " +
      "are detected from bone names, with X position deciding the side of unnamed limbs (model's right = +X); override any role via bones. " +
      "Writes through create_animation, so the result is one undoable animation that manage_keyframes can refine.",
    annotations: { title: "Generate Animation", destructiveHint: false },
    parameters: generateAnimationParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "audit_model",
    condition: { project: true },
    description:
      "Checks the project for problems: box UV nets outside the UV canvas or overlapping, texture/UV size mismatches, unpainted or untextured faces, " +
      "cubes outside bones in bone-rig formats, duplicate bone names, empty groups and left/right names that contradict X position. Returns a verdict and issues by severity.",
    annotations: { title: "Audit Model", readOnlyHint: true },
    parameters: auditModelParameters,
    status: STATUS_EXPERIMENTAL,
  },
];
