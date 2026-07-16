// Device-preview presets + fit-to-panel scale math (used by ArtifactFrame's
// laptop/tablet/phone switcher). The scale must NEVER upscale (blurry games)
// and must never return a non-finite/zero value the CSS transform would
// collapse on.
import { describe, it, expect } from "vitest";
import { DEVICE_PRESETS, deviceById, fitScale, orientedSize } from "./device-preview";

describe("DEVICE_PRESETS", () => {
  it("offers exactly fit, laptop, tablet and phone — fit first (the default)", () => {
    expect(DEVICE_PRESETS.map((d) => d.id)).toEqual(["fit", "laptop", "tablet", "phone"]);
  });

  it("fit has no fixed viewport; the real devices all do", () => {
    const fit = deviceById("fit");
    expect(fit.width).toBeNull();
    expect(fit.height).toBeNull();
    for (const id of ["laptop", "tablet", "phone"] as const) {
      const d = deviceById(id);
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
    }
  });

  it("phone/tablet default to portrait and are orientable; laptop is fixed landscape, fit has no shape", () => {
    const phone = deviceById("phone");
    const tablet = deviceById("tablet");
    const laptop = deviceById("laptop");
    const fit = deviceById("fit");
    expect(phone.height!).toBeGreaterThan(phone.width!);
    expect(tablet.height!).toBeGreaterThan(tablet.width!);
    expect(laptop.width!).toBeGreaterThan(laptop.height!);
    expect(phone.orientable).toBe(true);
    expect(tablet.orientable).toBe(true);
    expect(laptop.orientable).toBe(false);
    expect(fit.orientable).toBe(false);
  });

  it("every preset has a kid-facing label and a dimension hint", () => {
    for (const d of DEVICE_PRESETS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("fitScale", () => {
  it("scales a laptop viewport down to fit a 420px-wide panel", () => {
    // 1366×768 into 420×600 → limited by width: 420/1366
    const s = fitScale(420, 600, 1366, 768);
    expect(s).toBeCloseTo(420 / 1366, 5);
    expect(1366 * s).toBeLessThanOrEqual(420);
    expect(768 * s).toBeLessThanOrEqual(600);
  });

  it("is limited by the tighter axis", () => {
    // 390×844 phone into a wide short panel → height is the constraint
    const s = fitScale(1200, 400, 390, 844);
    expect(s).toBeCloseTo(400 / 844, 5);
  });

  it("never upscales past 1 (a phone inside a huge panel renders 1:1)", () => {
    expect(fitScale(2000, 2000, 390, 844)).toBe(1);
  });

  it("returns 1 for a zero/unmeasured container instead of collapsing the frame", () => {
    // First paint: ResizeObserver hasn't reported yet — don't scale(0).
    expect(fitScale(0, 0, 1366, 768)).toBe(1);
    expect(fitScale(-5, 100, 1366, 768)).toBe(1);
  });
});

describe("orientedSize", () => {
  it("portrait is a passthrough of the preset's own native dims", () => {
    expect(orientedSize(deviceById("phone"), "portrait")).toEqual({ width: 390, height: 844 });
    expect(orientedSize(deviceById("tablet"), "portrait")).toEqual({ width: 820, height: 1180 });
  });

  it("landscape swaps width/height for an orientable preset", () => {
    expect(orientedSize(deviceById("phone"), "landscape")).toEqual({ width: 844, height: 390 });
    expect(orientedSize(deviceById("tablet"), "landscape")).toEqual({ width: 1180, height: 820 });
  });

  it("non-orientable presets ignore a landscape request", () => {
    expect(orientedSize(deviceById("laptop"), "landscape")).toEqual({ width: 1366, height: 768 });
    expect(orientedSize(deviceById("fit"), "landscape")).toEqual({ width: null, height: null });
  });
});
