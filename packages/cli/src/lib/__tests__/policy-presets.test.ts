import { describe, it, expect } from "vitest";
import { getPolicyPreset, getPresetNames, PRESET_VERSION } from "../policy-presets";

describe("policy-presets", () => {
  it("should return null for unknown preset", () => {
    expect(getPolicyPreset("nonexistent")).toBeNull();
  });

  it("should return default preset with deny_new_cycles true", () => {
    const preset = getPolicyPreset("default");
    expect(preset).not.toBeNull();
    expect(preset!.policies.deny_new_cycles).toBe(true);
  });

  it("should include preset name and version in output", () => {
    const preset = getPolicyPreset("default")!;
    expect(preset._preset).toBe("default");
    expect(preset._presetVersion).toBe(PRESET_VERSION);
  });

  it("should have monorepo-strict tighter than default", () => {
    const def = getPolicyPreset("default")!;
    const strict = getPolicyPreset("monorepo-strict")!;
    expect(strict.policies.max_public_api_growth!).toBeLessThan(def.policies.max_public_api_growth!);
    expect(strict.policies.max_coupling_increase!).toBeLessThan(def.policies.max_coupling_increase!);
  });

  it("should have library-public-api with zero growth", () => {
    const lib = getPolicyPreset("library-public-api");
    expect(lib).not.toBeNull();
    expect(lib!.policies.max_public_api_growth).toBe(0);
  });

  it("should list all preset names", () => {
    const names = getPresetNames();
    expect(names).toContain("default");
    expect(names).toContain("monorepo-strict");
    expect(names).toContain("library-public-api");
    expect(names).toHaveLength(3);
  });
});
