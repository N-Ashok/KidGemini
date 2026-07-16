// Device-preview presets + scale math for ArtifactFrame's laptop/tablet/phone
// switcher. Pure logic (no React, no DOM) so it's unit-testable in node.
//
// Viewports are common CSS-pixel sizes (MacBook Air-class laptop, iPad-class
// tablet, iPhone-class phone). The simulated device is CENTERED in the panel
// and scaled DOWN to fit via CSS transform — never up (blurry canvas).
import type { DevicePreset, PreviewDeviceId, PreviewOrientation } from "@/types/device-preview.types";

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: "fit", label: "Fit", width: null, height: null, hint: "Fill the panel", orientable: false },
  { id: "laptop", label: "Laptop", width: 1366, height: 768, hint: "1366 × 768", orientable: false },
  { id: "tablet", label: "Tablet", width: 820, height: 1180, hint: "820 × 1180", orientable: true },
  { id: "phone", label: "Phone", width: 390, height: 844, hint: "390 × 844", orientable: true },
];

export function deviceById(id: PreviewDeviceId): DevicePreset {
  // The list is a closed union — this can't miss.
  return DEVICE_PRESETS.find((d) => d.id === id)!;
}

/**
 * Resolve a preset's effective width/height for the requested orientation.
 * Portrait (the default) is always a passthrough of the preset's own native
 * dimensions. Landscape swaps width/height, but ONLY for `orientable`
 * presets — laptop (already landscape) and fit (no fixed shape) ignore a
 * landscape request and return their native dims unchanged.
 */
export function orientedSize(
  preset: DevicePreset,
  orientation: PreviewOrientation,
): { width: number | null; height: number | null } {
  if (!preset.orientable || orientation === "portrait") {
    return { width: preset.width, height: preset.height };
  }
  return { width: preset.height, height: preset.width };
}

/**
 * Scale factor that fits a device viewport inside the panel.
 * - Never upscales (cap at 1).
 * - A zero/unmeasured container (first paint, ResizeObserver not fired yet)
 *   returns 1 rather than collapsing the frame with scale(0).
 */
export function fitScale(
  containerWidth: number,
  containerHeight: number,
  deviceWidth: number,
  deviceHeight: number,
): number {
  if (containerWidth <= 0 || containerHeight <= 0) return 1;
  return Math.min(1, containerWidth / deviceWidth, containerHeight / deviceHeight);
}
