// Bakes a self-contained Three.js into a generated game's HTML — but ONLY
// when the model signalled it wants 3D (THREE_MARKER), because published
// games become permanent standalone static files (CloudFront/S3): injecting
// the ~500KB bundle into every 2D canvas game too would be dead weight on
// every future play, forever. Server-only (reads the vendored bundle off
// disk); the actual bundling happens ahead of time in scripts/vendor-three.mjs.

import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The system prompt (src/lib/gemini.ts) tells Gemini to emit this as the
 *  very first thing in <body> when it chooses to build with Three.js. */
export const THREE_MARKER = "<!--USES_THREE-->";

const BUNDLE_PATH = join(process.cwd(), "src/lib/vendor/three-bundle.generated.js");

let cachedBundleSource: string | null = null;
function threeBundleSource(): string {
  if (cachedBundleSource === null) {
    cachedBundleSource = readFileSync(BUNDLE_PATH, "utf8");
  }
  return cachedBundleSource;
}

/** Inserts the import map as early as possible (mirrors game-console.ts's
 *  placement rule) so the game's own `<script type="module">` can resolve
 *  `import * as THREE from "three"` when it runs. */
export function injectThreeJsIfNeeded(html: string): string {
  if (!html.includes(THREE_MARKER)) return html;

  const withoutMarker = html.split(THREE_MARKER).join("");
  const base64 = Buffer.from(threeBundleSource(), "utf8").toString("base64");
  const importMap = `<script type="importmap">${JSON.stringify({
    imports: { three: `data:text/javascript;base64,${base64}` },
  })}</script>`;

  const headMatch = withoutMarker.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return withoutMarker.slice(0, idx) + importMap + withoutMarker.slice(idx);
  }

  const htmlMatch = withoutMarker.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return withoutMarker.slice(0, idx) + importMap + withoutMarker.slice(idx);
  }

  return importMap + withoutMarker;
}
