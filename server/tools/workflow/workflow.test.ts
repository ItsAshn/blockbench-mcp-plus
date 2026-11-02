import { describe, expect, test } from "bun:test";
import { boxNetRect, boxNetSize, packBoxNets, rectsOverlap } from "./box-uv-pack";
import { faceRegionFromUv, localSize, localToTexture, paintFace, parseColor, type IPixelBuffer } from "./face-paint";
import { buildPreset, declaredSide, detectRoles, nameTokens } from "./animation-presets";
import { auditModel, type IAuditSnapshot } from "./model-audit";
import { buildRigParameters, paintCubeFacesParameters } from "./schemas";

describe("box UV packing", () => {
  test("net size matches Blockbench's box layout", () => {
    expect(boxNetSize([8, 8, 8])).toEqual([32, 16]);
    expect(boxNetSize([3, 7, 3])).toEqual([12, 10]);
    expect(boxNetSize([1, 2, 9])).toEqual([20, 11]);
  });

  test("packs without overlaps and inside the returned canvas", () => {
    const sizes: [number, number, number][] = [[10, 9, 9], [8, 8, 5], [3, 8, 3], [3, 8, 3], [3, 7, 3], [3, 7, 3], [9, 2, 6], [6, 7, 3], [1, 3, 1], [4, 1, 3], [1, 2, 9]];
    const result = packBoxNets(sizes.map((size, index) => ({ key: String(index), size })));
    const rects = sizes.map((size, index) => boxNetRect(size, result.offsets[String(index)]));
    rects.forEach((rect, i) => {
      expect(rect.x + rect.w).toBeLessThanOrEqual(result.width);
      expect(rect.y + rect.h).toBeLessThanOrEqual(result.height);
      rects.slice(i + 1).forEach(other => expect(rectsOverlap(rect, other)).toBe(false));
    });
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
  });

  test("avoids reserved rectangles and respects minimum size", () => {
    const reserved = [{ x: 0, y: 0, w: 32, h: 16 }];
    const result = packBoxNets([{ key: "a", size: [8, 8, 8] }], { reserved, minWidth: 64, minHeight: 64 });
    expect(rectsOverlap(boxNetRect([8, 8, 8], result.offsets.a), reserved[0])).toBe(false);
    expect(result.width).toBeGreaterThanOrEqual(64);
  });
});

function blank(width: number, height: number): IPixelBuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function pixel(buffer: IPixelBuffer, x: number, y: number): number[] {
  const i = (y * buffer.width + x) * 4;
  return [...buffer.data.slice(i, i + 4)];
}

describe("face painting", () => {
  test("parses colors", () => {
    expect(parseColor("#ff0080")).toEqual([255, 0, 128, 255]);
    expect(parseColor("#f08")).toEqual([255, 0, 136, 255]);
    expect(parseColor([1, 2, 3])).toEqual([1, 2, 3, 255]);
    expect(() => parseColor("red")).toThrow();
  });

  test("maps mirrored and rotated faces", () => {
    const mirrored = faceRegionFromUv([10, 2, 6, 5], 1, 1, 0);
    expect(mirrored).toMatchObject({ x0: 6, y0: 2, w: 4, h: 3, flipX: true, flipY: false });
    expect(localToTexture(mirrored, 0, 0)).toEqual([9, 2]);
    const rotated = faceRegionFromUv([0, 0, 4, 2], 1, 1, 90);
    expect(localSize(rotated)).toEqual([2, 4]);
    // Every displayed pixel lands on a distinct texture pixel inside the rect.
    const seen = new Set<string>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) seen.add(localToTexture(rotated, x, y).join(","));
    expect(seen.size).toBe(8);
  });

  test("scales logical UV to bitmap pixels", () => {
    expect(faceRegionFromUv([2, 2, 4, 4], 4, 4, 0)).toMatchObject({ x0: 8, y0: 8, w: 8, h: 8 });
  });

  test("applies ops in face-local space with negative coordinates", () => {
    const buffer = blank(16, 16);
    const region = faceRegionFromUv([4, 4, 12, 10], 1, 1, 0);
    const { size } = paintFace(buffer, region, "north", [
      { type: "fill", color: "#102030" },
      { type: "rect", x: 0, y: -1, h: 1, color: "#ffffff" },
      { type: "pattern", rows: ["e.e"], palette: { e: "#000000" }, align: "top-center", y: 2 },
    ]);
    expect(size).toEqual([8, 6]);
    expect(pixel(buffer, 4, 4)).toEqual([16, 32, 48, 255]);
    expect(pixel(buffer, 7, 9)).toEqual([255, 255, 255, 255]);
    expect(pixel(buffer, 6, 6)).toEqual([0, 0, 0, 255]);
    expect(pixel(buffer, 7, 6)).toEqual([16, 32, 48, 255]);
    expect(pixel(buffer, 8, 6)).toEqual([0, 0, 0, 255]);
    expect(pixel(buffer, 3, 4)).toEqual([0, 0, 0, 0]);
  });

  test("base shading darkens down faces and is deterministic", () => {
    const a = blank(8, 8);
    const b = blank(8, 8);
    const region = faceRegionFromUv([0, 0, 4, 4], 1, 1, 0);
    paintFace(a, region, "down", [{ type: "base", color: "#808080", noise: 0 }], "k");
    expect(pixel(a, 1, 1)[0]).toBeLessThan(128);
    paintFace(a, faceRegionFromUv([4, 4, 8, 8], 1, 1, 0), "north", [{ type: "base", color: "#808080" }], "k");
    paintFace(b, faceRegionFromUv([4, 4, 8, 8], 1, 1, 0), "north", [{ type: "base", color: "#808080" }], "k");
    expect(pixel(a, 5, 5)).toEqual(pixel(b, 5, 5));
  });

  test("unknown pattern characters fail loudly", () => {
    expect(() => paintFace(blank(4, 4), faceRegionFromUv([0, 0, 4, 4], 1, 1, 0), "north", [{ type: "pattern", rows: ["x"], palette: {} }])).toThrow(/palette/);
  });
});

describe("animation presets", () => {
  test("tokenizes and reads sides", () => {
    expect(nameTokens("leftArmUpper")).toEqual(["left", "arm", "upper"]);
    expect(declaredSide("arm_r")).toBe("right");
    expect(declaredSide("LeftLeg")).toBe("left");
    expect(declaredSide("head")).toBeUndefined();
  });

  test("detects roles by name, depth and X position", () => {
    const roles = detectRoles([
      { name: "root", origin: [0, 0, 0], depth: 0 },
      { name: "body", origin: [0, 12, 0], depth: 1 },
      { name: "head", origin: [0, 24, 0], depth: 2 },
      { name: "arm_l", origin: [-5, 22, 0], depth: 2 },
      { name: "lower_arm_l", origin: [-5, 16, 0], depth: 3 },
      { name: "arm2", origin: [5, 22, 0], depth: 2 },
      { name: "leg_left", origin: [-2, 12, 0], depth: 1 },
      { name: "leg_right", origin: [2, 12, 0], depth: 1 },
    ], { tail: "body" });
    expect(roles).toMatchObject({ root: "root", body: "body", head: "head", arm_left: "arm_l", arm_right: "arm2", leg_left: "leg_left", leg_right: "leg_right", tail: "body" });
  });

  test("walk legs swing in opposite phase and loop closes", () => {
    const walk = buildPreset("walk", { leg_left: "ll", leg_right: "lr", arm_left: "al", arm_right: "ar", body: "b" });
    expect(walk.loop).toBe(true);
    const ll = walk.bones.ll;
    expect(ll[0].rotation?.[0]).toBe(-(walk.bones.lr[0].rotation?.[0] ?? 0));
    expect(ll.at(-1)?.rotation).toEqual(ll[0].rotation);
    expect(ll.at(-1)?.time).toBe(walk.length);
  });

  test("presets requiring missing bones explain what to pass", () => {
    expect(() => buildPreset("walk", { body: "b" })).toThrow(/leg_left/);
  });

  test("attack raises the main arm forward overhead", () => {
    const attack = buildPreset("attack", { arm_right: "ar", body: "b" });
    const peak = Math.max(...attack.bones.ar.map(frame => frame.rotation?.[0] ?? 0));
    expect(peak).toBeGreaterThan(90);
    expect(attack.loop).toBe(false);
  });
});

function snapshot(overrides: Partial<IAuditSnapshot> = {}): IAuditSnapshot {
  return {
    format: "Bedrock Entity", bone_rig: true, per_texture_uv_size: false, uv_width: 64, uv_height: 64,
    textures: [{ name: "t", width: 64, height: 64 }], cubes: [], groups: [], meshes: 0, animations: 0, ...overrides,
  };
}

describe("model audit", () => {
  const face = { uv: [0, 0, 1, 1], textured: true, opaque_ratio: 1 };
  const cube = (name: string, offset: [number, number], x = 0, parent: string | null = "g") => ({
    uuid: name, name, from: [x, 0, 0], to: [x + 8, 8, 8], box_uv: true, uv_offset: offset, parent, faces: { north: face },
  });

  test("clean model passes", () => {
    const report = auditModel(snapshot({ cubes: [cube("a", [0, 0])], groups: [{ uuid: "g", name: "body", origin: [0, 0, 0], parent: null, descendant_elements: 1 }] }));
    expect(report.verdict).toBe("ok");
  });

  test("flags the 16x16 UV canvas with a larger painted texture", () => {
    const report = auditModel(snapshot({ uv_width: 16, uv_height: 16, cubes: [cube("head", [0, 0]), cube("body", [32, 0])] }));
    expect(report.verdict).toBe("has_errors");
    expect(report.issues.map(issue => issue.code)).toContain("uv_out_of_bounds");
    expect(report.issues.map(issue => issue.code)).toContain("texture_hd");
  });

  test("flags overlaps, root cubes, duplicate bones and side naming", () => {
    const report = auditModel(snapshot({
      cubes: [cube("a", [0, 0]), cube("b", [4, 4]), cube("arm_r", [0, 32], -8, null)],
      groups: [
        { uuid: "g", name: "dup", origin: [0, 0, 0], parent: null, descendant_elements: 2 },
        { uuid: "h", name: "dup", origin: [0, 0, 0], parent: null, descendant_elements: 0 },
        { uuid: "i", name: "leg_left", origin: [3, 0, 0], parent: null, descendant_elements: 0 },
      ],
    }));
    const codes = report.issues.map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["uv_overlap", "cubes_outside_bones", "duplicate_bone_names", "side_naming", "empty_groups"]));
  });

  test("flags unpainted faces but not deliberate 1x1 slivers", () => {
    const report = auditModel(snapshot({ cubes: [{ ...cube("a", [0, 0]), faces: { north: { ...face, uv: [0, 0, 4, 4], opaque_ratio: 0 }, up: { ...face, uv: [63, 63, 64, 64], opaque_ratio: 0 } } }] }));
    const issue = report.issues.find(entry => entry.code === "unpainted_faces");
    expect(issue?.elements).toEqual(["a.north"]);
  });
});

describe("schemas", () => {
  test("paint targets need exactly one of cube or group", () => {
    expect(paintCubeFacesParameters.safeParse({ targets: [{ ops: [] }] }).success).toBe(false);
    expect(paintCubeFacesParameters.safeParse({ targets: [{ cube: "a", group: "b", ops: [] }] }).success).toBe(false);
    expect(paintCubeFacesParameters.safeParse({ targets: [{ cube: "a", ops: [{ type: "base", color: "#fff" }] }] }).success).toBe(true);
  });

  test("build_rig defaults to packing", () => {
    const parsed = buildRigParameters.parse({ bones: [{ name: "body", origin: [0, 0, 0] }] });
    expect(parsed.pack_uv).toBe(true);
  });
});

describe("quadruped presets", () => {
  const bones = [
    { name: "body", origin: [0, 10, 0], depth: 0 },
    { name: "head", origin: [0, 12, -8], depth: 1 },
    { name: "leg_fl", origin: [-3, 6, -5], depth: 1 },
    { name: "leg_fr", origin: [3, 6, -5], depth: 1 },
    { name: "leg_bl", origin: [-3, 6, 5], depth: 1 },
    { name: "leg_br", origin: [3, 6, 5], depth: 1 },
  ];

  test("detects four legs by position", () => {
    const roles = detectRoles(bones);
    expect(roles).toMatchObject({ leg_front_left: "leg_fl", leg_front_right: "leg_fr", leg_back_left: "leg_bl", leg_back_right: "leg_br" });
  });

  test("detects fore/hind names", () => {
    const roles = detectRoles([
      { name: "foreleg_left", origin: [-3, 6, 0], depth: 1 },
      { name: "hindleg_left", origin: [-3, 6, 0], depth: 1 },
    ]);
    expect(roles).toMatchObject({ leg_front_left: "foreleg_left", leg_back_left: "hindleg_left" });
  });

  test("walk trots diagonal pairs, run bounds front and back pairs", () => {
    const roles = detectRoles(bones);
    const first = (anim: ReturnType<typeof buildPreset>, bone: string) => anim.bones[bone][0].rotation?.[0];
    const walk = buildPreset("walk", roles);
    expect(first(walk, "leg_fl")).toBe(first(walk, "leg_br"));
    expect(first(walk, "leg_fl")).toBe(-(first(walk, "leg_fr") ?? 0));
    const run = buildPreset("run", roles);
    expect(first(run, "leg_fl")).toBe(first(run, "leg_fr"));
    expect(first(run, "leg_bl")).toBe(-(first(run, "leg_fl") ?? 0));
  });

  test("armless attack snaps the head", () => {
    const attack = buildPreset("attack", detectRoles(bones));
    expect(attack.bones.head.length).toBeGreaterThan(2);
  });
});
