// Render test (ReactDOMServer, createElement — the node-env vitest config
// doesn't transform JSX in tests): the celebration card the publish done
// screen shows for a first publish (PRD-SPARKS closure §4).
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SparksCelebrationCard from "./SparksCelebrationCard";

describe("SparksCelebrationCard", () => {
  it("celebrates the ledger amount, Indian-formatted, with the wallet pointer", () => {
    const html = renderToStaticMarkup(createElement(SparksCelebrationCard, { amount: 10000 }));
    expect(html).toContain("+10,000 ⚡ for publishing!");
    expect(html).toContain("Wallet");
  });

  it("never shows minus signs, balances, or rupees (kid surface — up-numbers only)", () => {
    const html = renderToStaticMarkup(createElement(SparksCelebrationCard, { amount: 500 }));
    const text = html.replace(/<[^>]+>/g, " "); // visible copy only — class names carry dashes
    expect(text).not.toMatch(/₹|-\d|balance/i);
  });
});
