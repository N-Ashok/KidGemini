// "Game Stuff" — the kid-facing asset gallery (PRD-3D-GAMES-AND-ASSETS §9b).
// Rendered straight from the in-repo manifest: zero backend, zero new data.
// The 3D turntables load the engine FROM THE ASSET HOST ITSELF, so this page
// permanently dogfoods the immutability contract — if the gallery renders,
// the host works (it joins UAT as the human-visible smoke check).

import type { Metadata } from "next";
import { galleryCards, cardEmoji } from "@/lib/assets/gallery";
import manifest from "@/lib/assets/manifest.json";

// games-lab.ariantra.com is the canonical host (2026-07-17, later same day)
// — supersedes ari.ariantra.com.
const PAGE_URL = "https://games-lab.ariantra.com/assets";

export const metadata: Metadata = {
  title: "Game Stuff — 3D models & sounds for your games | Ari",
  description:
    "Peek inside Ari's toy box: real 3D models and game sounds you can use in the games you make. Every card shows the magic words to say in chat.",
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: "Game Stuff — the Ari toy box",
    description: "Real 3D models and sounds for the games kids build with Ari.",
    url: PAGE_URL,
    type: "website",
  },
};

export default function AssetsPage() {
  const { models, sounds } = galleryCards();
  const engine = manifest.assets.find((a) => a.type === "engine");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Ari Game Stuff",
    description: "3D models and sounds available in Ari games",
    itemListElement: [...models, ...sounds].map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.displayName,
    })),
  };

  // One shared WebGL renderer drives every card (browsers cap live GL
  // contexts): render each model, blit to the card's 2D canvas. Engine and
  // models come from assets.ariantra.com — the contract dogfood.
  const turntableScript = `
(function () {
  var cards = Array.prototype.slice.call(document.querySelectorAll("[data-model-card]"));
  if (!cards.length) return;
  function note(card, msg) {
    var n = card.querySelector("[data-note]");
    if (n) n.textContent = msg;
  }
  var probe = null;
  try { probe = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl"); } catch (e) {}
  if (!probe) { cards.forEach(function (c) { note(c, "This gallery needs 3D — try another browser or device"); }); return; }
  import(${JSON.stringify(engine?.url ?? "")}).then(function (T) {
    var loader = new T.GLTFLoader();
    loader.setMeshoptDecoder(T.MeshoptDecoder);
    // alpha: the blit must keep the card's own background (no black boxes).
    var renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    var items = [];
    cards.forEach(function (card) {
      var canvas = card.querySelector("canvas");
      var url = card.getAttribute("data-model-url");
      if (!canvas || !url) return;
      loader.loadAsync(url).then(function (gltf) {
        var scene = new T.Scene();
        var obj = gltf.scene;
        var box = new T.Box3().setFromObject(obj);
        var center = box.getCenter(new T.Vector3());
        var size = box.getSize(new T.Vector3());
        var maxDim = Math.max(size.x, size.y, size.z) || 1;
        var group = new T.Group();
        obj.position.sub(center);
        group.add(obj);
        group.scale.setScalar(1.6 / maxDim);
        scene.add(group);
        scene.add(new T.AmbientLight(0xffffff, 0.8));
        var sun = new T.DirectionalLight(0xffffff, 1.4);
        sun.position.set(2, 4, 3);
        scene.add(sun);
        var cam = new T.PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 20);
        cam.position.set(0, 0.6, 2.4);
        cam.lookAt(0, 0, 0);
        var mixer = null;
        if (gltf.animations && gltf.animations.length) {
          mixer = new T.AnimationMixer(obj);
          // Play the LIVELIEST clip, not clip[0]: files often list a subtle
          // Idle (or Death!) first, which reads as a statue on the turntable.
          var lively = /gallop|run|swim|fly|walk|jump|attack/i;
          var clip = gltf.animations.filter(function (a) { return lively.test(a.name); })[0] || gltf.animations[0];
          mixer.clipAction(clip).play();
        }
        items.push({ card: card, group: group, scene: scene, cam: cam, mixer: mixer, ctx: canvas.getContext("2d"), w: canvas.width, h: canvas.height, shown: false });
      }).catch(function () {
        note(card, "This toy couldn't load — check back soon!");
      });
    });
    var clock = new T.Clock();
    function tick() {
      var delta = clock.getDelta();
      items.forEach(function (it) {
        it.group.rotation.y += 0.012;
        if (it.mixer) it.mixer.update(delta);
        renderer.setSize(it.w, it.h, false);
        renderer.render(it.scene, it.cam);
        it.ctx.clearRect(0, 0, it.w, it.h);
        it.ctx.drawImage(renderer.domElement, 0, 0, it.w, it.h);
        if (!it.shown) { it.shown = true; it.card.classList.add("model-loaded"); }
      });
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }).catch(function () {
    cards.forEach(function (c) { note(c, "The toy box is taking a nap — try again in a minute!"); });
  });
})();`;

  // §9c: read-aloud on request (never auto — the Idea Button coach UAT
  // established auto voice-over reads as intrusive).
  const speakScript = `
document.addEventListener("click", function (e) {
  var btn = e.target && e.target.closest && e.target.closest("[data-say]");
  if (!btn || !window.speechSynthesis) return;
  var u = new SpeechSynthesisUtterance(btn.getAttribute("data-say"));
  u.rate = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
});`;

  return (
    <main className="mx-auto max-w-5xl px-4 pb-16 pt-8 font-body text-ink-900">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <h1 className="font-display text-3xl font-bold">Game Stuff 🧰</h1>
      <p className="mt-2 max-w-2xl text-ink-700">
        Real 3D models and sounds that can go in YOUR games! Every card shows
        the magic words — say them in the chat and watch what happens. ✨
      </p>

      {models.length === 0 && sounds.length === 0 ? (
        <div className="mt-12 rounded-kid border border-brand-100 bg-brand-50 p-10 text-center">
          <div className="text-5xl">📦</div>
          <h2 className="mt-3 font-display text-xl font-bold">The toy box is being filled!</h2>
          <p className="mt-2 text-ink-700">New 3D models and sounds are on their way — check back soon.</p>
        </div>
      ) : null}

      {models.length > 0 && (
        <section aria-labelledby="models-heading">
          <h2 id="models-heading" className="mt-10 font-display text-2xl font-bold">3D models</h2>
          <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((c) => (
              <article key={c.name} data-model-card data-model-url={c.url} className="group relative overflow-hidden rounded-kid border border-brand-100 bg-white shadow-sm">
                <div className="relative flex h-48 items-center justify-center bg-brand-50">
                  {/* Emoji placeholder shows until the turntable's first frame lands (no blank cards). */}
                  <div aria-hidden className="absolute text-6xl transition-opacity group-[.model-loaded]:opacity-0">{cardEmoji(c.name)}</div>
                  <canvas width={320} height={192} className="relative h-full w-full opacity-0 transition-opacity group-[.model-loaded]:opacity-100" aria-label={`Spinning 3D ${c.displayName}`} />
                </div>
                <div className="p-4">
                  <h3 className="font-display text-lg font-bold">{c.displayName}</h3>
                  <p data-note className="mt-1 text-sm text-ink-700">
                    Say <b className="text-brand-700">“{c.trigger}”</b> to use this!
                  </p>
                  <button
                    type="button"
                    data-say={`Say: ${c.trigger}`}
                    className="mt-3 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
                    aria-label={`Read the magic words for ${c.displayName} out loud`}
                  >
                    🔊 Read it to me
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {sounds.length > 0 && (
        <section aria-labelledby="sounds-heading">
          <h2 id="sounds-heading" className="mt-12 font-display text-2xl font-bold">Sounds &amp; music</h2>
          <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {sounds.map((c) => (
              <article key={c.name} className="rounded-kid border border-brand-100 bg-white p-4 shadow-sm">
                <h3 className="font-display text-lg font-bold">{c.type === "music" ? "🎵" : "🔔"} {c.displayName}</h3>
                <audio controls preload="none" src={c.url} className="mt-3 w-full" />
                <p className="mt-2 text-sm text-ink-700">
                  Say <b className="text-brand-700">“{c.trigger}”</b> to use this!
                </p>
                <button
                  type="button"
                  data-say={`Say: ${c.trigger}`}
                  className="mt-3 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
                  aria-label={`Read the magic words for ${c.displayName} out loud`}
                >
                  🔊 Read it to me
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <script dangerouslySetInnerHTML={{ __html: turntableScript }} />
      <script dangerouslySetInnerHTML={{ __html: speakScript }} />
    </main>
  );
}
