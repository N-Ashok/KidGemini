import { describe, it, expect } from "vitest";
import { gameSupportsSave } from "./game-save-active";

describe("gameSupportsSave", () => {
  it("true when the marker is present anywhere in the document", () => {
    expect(gameSupportsSave("<html><body><!--SUPPORTS_SAVE--><canvas></canvas></body></html>")).toBe(true);
  });

  it("false for a game with no marker", () => {
    expect(gameSupportsSave("<html><body><canvas></canvas></body></html>")).toBe(false);
  });

  it("false for an empty string", () => {
    expect(gameSupportsSave("")).toBe(false);
  });
});
