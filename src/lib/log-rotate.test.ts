import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rotateIfNeeded } from "./log-rotate";

const tmpFiles: string[] = [];

function tmpFile(): string {
  const p = path.join(os.tmpdir(), `kg-logger-test-${Math.random().toString(36).slice(2)}.log`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop()!;
    for (const f of [p, `${p}.1`]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  }
});

describe("rotateIfNeeded — size-based log rotation (2026-07-17)", () => {
  it("does nothing when the file doesn't exist yet", () => {
    const p = tmpFile();
    expect(rotateIfNeeded(p, 10)).toBe(false);
    expect(fs.existsSync(`${p}.1`)).toBe(false);
  });

  it("does nothing when the file is under the size ceiling", () => {
    const p = tmpFile();
    fs.writeFileSync(p, "small");
    expect(rotateIfNeeded(p, 1_000)).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toBe("small");
  });

  it("rotates to .1 once the file is at or over the ceiling, leaving a fresh path for the caller", () => {
    const p = tmpFile();
    fs.writeFileSync(p, "0123456789");
    expect(rotateIfNeeded(p, 10)).toBe(true);
    expect(fs.existsSync(p)).toBe(false); // caller reopens a fresh stream here
    expect(fs.readFileSync(`${p}.1`, "utf8")).toBe("0123456789");
  });

  it("overwrites a prior .1 rather than accumulating generations", () => {
    const p = tmpFile();
    fs.writeFileSync(`${p}.1`, "old generation");
    fs.writeFileSync(p, "0123456789");
    rotateIfNeeded(p, 10);
    expect(fs.readFileSync(`${p}.1`, "utf8")).toBe("0123456789");
  });
});
