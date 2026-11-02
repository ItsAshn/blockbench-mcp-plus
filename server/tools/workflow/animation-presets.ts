/**
 * Procedural base animation cycles for bipeds and simple creatures. Pure: it
 * maps bone names to roles and returns keyframes in Blockbench editor
 * coordinates; the caller writes them through the create_animation pipeline.
 *
 * Sign conventions (Blockbench editor space, model facing -Z / north):
 * - A positive X rotation swings the tip of a down-pointing bone (arm, leg)
 *   forward (-Z) and tips an up-pointing bone (torso, head) backward.
 * - The model's own right is +X. A positive Z rotation moves a down-pointing
 *   bone's tip toward +X, so "outward" is +Z for right limbs and -Z for left.
 */

export type BoneRole =
  | "root" | "body" | "head" | "tail"
  | "arm_left" | "arm_right" | "leg_left" | "leg_right"
  | "leg_front_left" | "leg_front_right" | "leg_back_left" | "leg_back_right"
  | "wing_left" | "wing_right";

export const BONE_ROLES: readonly BoneRole[] = [
  "root", "body", "head", "tail", "arm_left", "arm_right", "leg_left", "leg_right",
  "leg_front_left", "leg_front_right", "leg_back_left", "leg_back_right", "wing_left", "wing_right",
];

const QUAD_LEGS = ["leg_front_left", "leg_front_right", "leg_back_left", "leg_back_right"] as const;

export type AnimationPreset = "idle" | "walk" | "run" | "attack" | "hurt" | "death" | "jump";

export const ANIMATION_PRESETS: readonly AnimationPreset[] = ["idle", "walk", "run", "attack", "hurt", "death", "jump"];

/** A bone as seen by role detection. */
export interface IBoneInfo {
  name: string;
  origin: readonly number[];
  /** Number of ancestor groups; shallower bones win ties. */
  depth: number;
}

export interface IPresetKeyframe {
  time: number;
  rotation?: [number, number, number];
  position?: [number, number, number];
}

export interface IPresetAnimation {
  length: number;
  loop: boolean;
  bones: Record<string, IPresetKeyframe[]>;
}

export interface IPresetOptions {
  /** Amplitude multiplier; 1 is a moderate, readable motion. */
  intensity?: number;
  /** Playback speed multiplier; 2 halves the cycle length. */
  speed?: number;
}

/** Splits a bone name into lowercase tokens on separators and camelCase boundaries. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .split(/[\s_\-.:]+/)
    .map(token => token.toLowerCase())
    .filter(Boolean);
}

const KIND_TOKENS: Record<string, readonly string[]> = {
  root: ["root"],
  body: ["body", "torso", "chest", "waist", "spine", "hips", "pelvis"],
  head: ["head"],
  tail: ["tail"],
  arm: ["arm", "arms", "upperarm"],
  leg: ["leg", "legs", "thigh", "upperleg", "foreleg", "hindleg"],
  wing: ["wing", "wings"],
};

/** Tokens that mark a lower limb segment, which a base cycle should not drive as the whole limb. */
const LOWER_SEGMENT = new Set(["lower", "fore", "forearm", "shin", "calf", "hand", "foot", "end", "tip"]);

/** Whether a leg name declares front or back (fore/hind), if any. */
export function declaredEnd(name: string): "front" | "back" | undefined {
  const tokens = nameTokens(name);
  if (tokens.some(token => token === "front" || token === "foreleg" || token === "f")) return "front";
  if (tokens.some(token => ["back", "hind", "rear", "hindleg", "b"].includes(token))) return "back";
  return undefined;
}

/** Which side a name declares, if any. */
export function declaredSide(name: string): "left" | "right" | undefined {
  const tokens = nameTokens(name);
  if (tokens.some(token => token === "left" || token === "l")) return "left";
  if (tokens.some(token => token === "right" || token === "r")) return "right";
  const lower = name.toLowerCase();
  if (lower.startsWith("left")) return "left";
  if (lower.startsWith("right")) return "right";
  return undefined;
}

function kindOf(name: string): string | undefined {
  const tokens = nameTokens(name);
  if (tokens.some(token => LOWER_SEGMENT.has(token))) return undefined;
  return Object.keys(KIND_TOKENS).find(kind => tokens.some(token => KIND_TOKENS[kind].includes(token)));
}

/**
 * Assigns bones to roles by name, falling back to the X position for limbs
 * whose name has no side (model's right is +X). With four or more legs (or
 * legs named front/back, fore/hind) legs get quadruped roles; the front pair
 * is the one further toward -Z when names do not say. Explicit `overrides` win.
 */
export function detectRoles(bones: readonly IBoneInfo[], overrides: Partial<Record<BoneRole, string>> = {}): Partial<Record<BoneRole, string>> {
  const roles: Partial<Record<BoneRole, string>> = {};
  const candidates: Partial<Record<BoneRole, IBoneInfo[]>> = {};
  const legs = bones.filter(bone => kindOf(bone.name) === "leg");
  const minLegDepth = Math.min(...legs.map(bone => bone.depth));
  const topLegs = legs.filter(bone => bone.depth === minLegDepth);
  const quadruped = topLegs.length >= 4 || topLegs.some(bone => declaredEnd(bone.name));
  const meanZ = topLegs.reduce((sum, bone) => sum + (bone.origin[2] ?? 0), 0) / Math.max(1, topLegs.length);
  bones.forEach(bone => {
    const kind = kindOf(bone.name);
    if (!kind) return;
    let role: BoneRole;
    if (kind === "leg" && quadruped) {
      const side = declaredSide(bone.name) ?? ((bone.origin[0] ?? 0) >= 0 ? "right" : "left");
      const end = declaredEnd(bone.name) ?? ((bone.origin[2] ?? 0) <= meanZ ? "front" : "back");
      role = `leg_${end}_${side}` as BoneRole;
    } else if (kind === "arm" || kind === "leg" || kind === "wing") {
      const side = declaredSide(bone.name) ?? ((bone.origin[0] ?? 0) >= 0 ? "right" : "left");
      role = `${kind}_${side}` as BoneRole;
    } else {
      role = kind as BoneRole;
    }
    (candidates[role] ??= []).push(bone);
  });
  BONE_ROLES.forEach(role => {
    const list = candidates[role];
    if (list?.length) roles[role] = [...list].sort((a, b) => a.depth - b.depth)[0].name;
  });
  Object.entries(overrides).forEach(([role, name]) => {
    if (name) roles[role as BoneRole] = name;
  });
  return roles;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Builds keyframes from parallel time fractions and values. */
function track(
  length: number,
  channel: "rotation" | "position",
  frames: readonly (readonly [number, readonly number[]])[],
): IPresetKeyframe[] {
  return frames.map(([fraction, value]) => ({
    time: round(fraction * length),
    [channel]: value.map(round) as [number, number, number],
  }));
}

/**
 * Generates a preset cycle for the detected roles. Roles without a bone are
 * skipped; the result lists only bones that received keyframes.
 *
 * @throws When the preset needs a bone the rig does not have (e.g. walk without legs).
 */
export function buildPreset(
  preset: AnimationPreset,
  roles: Partial<Record<BoneRole, string>>,
  options: IPresetOptions = {},
): IPresetAnimation {
  const k = options.intensity ?? 1;
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const bones: Record<string, IPresetKeyframe[]> = {};
  const add = (role: BoneRole, keys: IPresetKeyframe[]) => {
    const name = roles[role];
    if (!name) return;
    const existing = bones[name] ?? [];
    keys.forEach(key => {
      const same = existing.find(frame => frame.time === key.time);
      if (same) Object.assign(same, key);
      else existing.push(key);
    });
    bones[name] = existing.sort((a, b) => a.time - b.time);
  };
  const rot = (role: BoneRole, length: number, frames: readonly (readonly [number, readonly number[]])[]) =>
    add(role, track(length, "rotation", frames));
  const pos = (role: BoneRole, length: number, frames: readonly (readonly [number, readonly number[]])[]) =>
    add(role, track(length, "position", frames));
  const requireRoles = (needed: BoneRole[]) => {
    const missing = needed.filter(role => !roles[role]);
    if (missing.length) throw new Error(`Preset "${preset}" needs bones for ${missing.join(", ")}. Pass them in "bones" (role -> bone name).`);
  };
  const bobTarget: BoneRole = roles.body ? "body" : "root";
  const fallTarget: BoneRole = roles.root ? "root" : "body";

  switch (preset) {
    case "idle": {
      const L = 2 / speed;
      pos(bobTarget, L, [[0, [0, 0, 0]], [0.5, [0, 0.25 * k, 0]], [1, [0, 0, 0]]]);
      rot("head", L, [[0, [0, 0, 0]], [0.5, [-2 * k, 0, 0]], [1, [0, 0, 0]]]);
      rot("arm_right", L, [[0, [0, 0, 0]], [0.5, [0, 0, 3 * k]], [1, [0, 0, 0]]]);
      rot("arm_left", L, [[0, [0, 0, 0]], [0.5, [0, 0, -3 * k]], [1, [0, 0, 0]]]);
      rot("tail", L, [[0, [0, -8 * k, 0]], [0.5, [0, 8 * k, 0]], [1, [0, -8 * k, 0]]]);
      rot("wing_right", L, [[0, [0, 0, 0]], [0.5, [0, 0, 5 * k]], [1, [0, 0, 0]]]);
      rot("wing_left", L, [[0, [0, 0, 0]], [0.5, [0, 0, -5 * k]], [1, [0, 0, 0]]]);
      return { length: round(L), loop: true, bones };
    }
    case "walk":
    case "run": {
      const running = preset === "run";
      if (QUAD_LEGS.every(role => roles[role])) {
        // Walk: diagonal pairs (trot). Run: front pair and back pair alternate (bound).
        const L = (running ? 0.5 : 0.9) / speed;
        const swing = (running ? 40 : 22) * k;
        const bob = (running ? 1 : 0.4) * k;
        const phaseA = [[0, [swing, 0, 0]], [0.5, [-swing, 0, 0]], [1, [swing, 0, 0]]] as const;
        const phaseB = [[0, [-swing, 0, 0]], [0.5, [swing, 0, 0]], [1, [-swing, 0, 0]]] as const;
        const inPhaseWithFrontLeft: BoneRole = running ? "leg_front_right" : "leg_back_right";
        rot("leg_front_left", L, phaseA);
        rot(inPhaseWithFrontLeft, L, phaseA);
        QUAD_LEGS.filter(role => role !== "leg_front_left" && role !== inPhaseWithFrontLeft).forEach(role => rot(role, L, phaseB));
        pos(bobTarget, L, [[0, [0, 0, 0]], [0.25, [0, bob, 0]], [0.5, [0, 0, 0]], [0.75, [0, bob, 0]], [1, [0, 0, 0]]]);
        if (running && roles.body) rot("body", L, [[0, [3 * k, 0, 0]], [0.5, [-3 * k, 0, 0]], [1, [3 * k, 0, 0]]]);
        rot("head", L, [[0, [2 * k, 0, 0]], [0.5, [-2 * k, 0, 0]], [1, [2 * k, 0, 0]]]);
        rot("tail", L, [[0, [0, -12 * k, 0]], [0.5, [0, 12 * k, 0]], [1, [0, -12 * k, 0]]]);
        return { length: round(L), loop: true, bones };
      }
      requireRoles(["leg_left", "leg_right"]);
      const L = (running ? 0.6 : 1) / speed;
      const leg = (running ? 45 : 25) * k;
      const arm = (running ? 40 : 20) * k;
      const bob = (running ? 1 : 0.5) * k;
      rot("leg_left", L, [[0, [leg, 0, 0]], [0.5, [-leg, 0, 0]], [1, [leg, 0, 0]]]);
      rot("leg_right", L, [[0, [-leg, 0, 0]], [0.5, [leg, 0, 0]], [1, [-leg, 0, 0]]]);
      rot("arm_left", L, [[0, [-arm, 0, 0]], [0.5, [arm, 0, 0]], [1, [-arm, 0, 0]]]);
      rot("arm_right", L, [[0, [arm, 0, 0]], [0.5, [-arm, 0, 0]], [1, [arm, 0, 0]]]);
      pos(bobTarget, L, [[0, [0, 0, 0]], [0.25, [0, bob, 0]], [0.5, [0, 0, 0]], [0.75, [0, bob, 0]], [1, [0, 0, 0]]]);
      if (running) {
        const lean = -8 * k;
        if (roles.body) rot("body", L, [[0, [lean, 0, 0]], [0.5, [lean, 0, 0]], [1, [lean, 0, 0]]]);
        rot("head", L, [[0, [-lean * 0.75, 0, 0]], [1, [-lean * 0.75, 0, 0]]]);
      }
      rot("tail", L, [[0, [0, -10 * k, 0]], [0.5, [0, 10 * k, 0]], [1, [0, -10 * k, 0]]]);
      return { length: round(L), loop: true, bones };
    }
    case "attack": {
      if (!roles.arm_right && !roles.arm_left) {
        // Creatures without arms lunge and snap the head.
        requireRoles(["head"]);
        const L = 0.6 / speed;
        rot("head", L, [[0, [0, 0, 0]], [0.3, [12 * k, 0, 0]], [0.5, [-22 * k, 0, 0]], [1, [0, 0, 0]]]);
        pos(roles.body ? "body" : "root", L, [[0, [0, 0, 0]], [0.3, [0, 0, 1.5 * k]], [0.5, [0, 0, -3 * k]], [1, [0, 0, 0]]]);
        rot("leg_front_left", L, [[0, [0, 0, 0]], [0.5, [20 * k, 0, 0]], [1, [0, 0, 0]]]);
        rot("leg_front_right", L, [[0, [0, 0, 0]], [0.5, [20 * k, 0, 0]], [1, [0, 0, 0]]]);
        return { length: round(L), loop: false, bones };
      }
      const main: BoneRole = roles.arm_right ? "arm_right" : "arm_left";
      const off: BoneRole = main === "arm_right" ? "arm_left" : "arm_right";
      requireRoles([main]);
      const L = 0.6 / speed;
      // Raise the arm forward and overhead, chop down past horizontal, recover.
      rot(main, L, [[0, [0, 0, 0]], [0.35, [150 * k, 0, 0]], [0.6, [30 * k, 0, 0]], [1, [0, 0, 0]]]);
      rot(off, L, [[0, [0, 0, 0]], [0.35, [-15 * k, 0, 0]], [0.6, [20 * k, 0, 0]], [1, [0, 0, 0]]]);
      const twist = main === "arm_right" ? 1 : -1;
      rot(roles.body ? "body" : "root", L, [[0, [0, 0, 0]], [0.35, [4 * k, 15 * k * twist, 0]], [0.6, [-6 * k, -15 * k * twist, 0]], [1, [0, 0, 0]]]);
      return { length: round(L), loop: false, bones };
    }
    case "hurt": {
      const L = 0.4 / speed;
      rot(roles.body ? "body" : "root", L, [[0, [0, 0, 0]], [0.25, [12 * k, 0, 0]], [1, [0, 0, 0]]]);
      rot("head", L, [[0, [0, 0, 0]], [0.25, [15 * k, 0, 0]], [1, [0, 0, 0]]]);
      rot("arm_right", L, [[0, [0, 0, 0]], [0.25, [0, 0, 15 * k]], [1, [0, 0, 0]]]);
      rot("arm_left", L, [[0, [0, 0, 0]], [0.25, [0, 0, -15 * k]], [1, [0, 0, 0]]]);
      return { length: round(L), loop: false, bones };
    }
    case "death": {
      requireRoles([fallTarget]);
      const L = 1.2 / speed;
      // Fall onto the back (top of the model toward +Z), then settle.
      rot(fallTarget, L, [[0, [0, 0, 0]], [0.6, [95, 0, 0]], [0.75, [85, 0, 0]], [1, [90, 0, 0]]]);
      rot("head", L, [[0, [0, 0, 0]], [0.6, [20 * k, 0, 0]], [1, [10 * k, 0, 0]]]);
      rot("arm_right", L, [[0, [0, 0, 0]], [0.6, [0, 0, 40 * k]], [1, [0, 0, 30 * k]]]);
      rot("arm_left", L, [[0, [0, 0, 0]], [0.6, [0, 0, -40 * k]], [1, [0, 0, -30 * k]]]);
      return { length: round(L), loop: false, bones };
    }
    case "jump": {
      const lift: BoneRole = roles.root ? "root" : "body";
      requireRoles([lift]);
      const L = 0.8 / speed;
      pos(lift, L, [[0, [0, 0, 0]], [0.2, [0, -1 * k, 0]], [0.5, [0, 6 * k, 0]], [0.85, [0, 0, 0]], [1, [0, 0, 0]]]);
      rot("arm_right", L, [[0, [0, 0, 0]], [0.2, [-25 * k, 0, 0]], [0.5, [110 * k, 0, 10 * k]], [1, [0, 0, 0]]]);
      rot("arm_left", L, [[0, [0, 0, 0]], [0.2, [-25 * k, 0, 0]], [0.5, [110 * k, 0, -10 * k]], [1, [0, 0, 0]]]);
      rot("leg_right", L, [[0, [0, 0, 0]], [0.5, [20 * k, 0, 0]], [0.85, [0, 0, 0]], [1, [0, 0, 0]]]);
      rot("leg_left", L, [[0, [0, 0, 0]], [0.5, [15 * k, 0, 0]], [0.85, [0, 0, 0]], [1, [0, 0, 0]]]);
      return { length: round(L), loop: false, bones };
    }
  }
}
