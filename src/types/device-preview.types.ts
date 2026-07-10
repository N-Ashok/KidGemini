// Device-preview switcher for the game preview panel (ArtifactFrame):
// "how does my game look on a laptop / tablet / phone?"

/** "fit" = fill the panel (default, exactly the pre-feature behaviour). */
export type PreviewDeviceId = "fit" | "laptop" | "tablet" | "phone";

export interface DevicePreset {
  id: PreviewDeviceId;
  /** Kid-facing button label. */
  label: string;
  /** CSS pixel viewport being simulated; null = fill the panel. */
  width: number | null;
  height: number | null;
  /** Grown-up hover hint, e.g. "1366 × 768". */
  hint: string;
}
