import type { PolicyConfig } from "ariadne-core";

export const PRESET_VERSION = "0.2.0";

export interface PresetOutput extends PolicyConfig {
  _preset: string;
  _presetVersion: string;
}

const presets: Record<string, PolicyConfig> = {
  default: {
    policies: {
      deny_new_cycles: true,
      max_public_api_growth: 10,
      max_coupling_increase: 5,
    },
  },
  "monorepo-strict": {
    policies: {
      deny_new_cycles: true,
      max_public_api_growth: 3,
      max_coupling_increase: 2,
    },
  },
  "library-public-api": {
    policies: {
      deny_new_cycles: true,
      max_public_api_growth: 0,
      max_coupling_increase: 3,
    },
  },
};

export function getPolicyPreset(name: string): PresetOutput | null {
  const preset = presets[name];
  if (!preset) return null;
  return { ...preset, _preset: name, _presetVersion: PRESET_VERSION };
}

export function getPresetNames(): string[] {
  return Object.keys(presets);
}
