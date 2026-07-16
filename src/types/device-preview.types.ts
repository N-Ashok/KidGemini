// Device-preview switcher for the game preview panel (ArtifactFrame):
// "how does my game look on a laptop / tablet / phone?"

/** "fit" = fill the panel (default, exactly the pre-feature behaviour). */
export type PreviewDeviceId = "fit" | "laptop" | "tablet" | "phone";

/** Rotate toggle (tablet/phone only — see `DevicePreset.orientable`).
 *  "portrait" is each preset's own native width/height; "landscape" swaps them. */
export type PreviewOrientation = "portrait" | "landscape";

export interface DevicePreset {
  id: PreviewDeviceId;
  /** Kid-facing button label. */
  label: string;
  /** CSS pixel viewport being simulated (its NATIVE/portrait orientation);
   *  null = fill the panel. */
  width: number | null;
  height: number | null;
  /** Grown-up hover hint, e.g. "1366 × 768". */
  hint: string;
  /** Can this preset be rotated to landscape? Laptop is already landscape and
   *  "fit" has no fixed shape — only tablet/phone are natively-portrait
   *  devices a kid would plausibly rotate. */
  orientable: boolean;
}
