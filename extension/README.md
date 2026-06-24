# KidGemini Guard (Chrome extension)

Watches the **real** `gemini.google.com`, hides each model response until it's vetted, and
logs alerts for parents — so you reuse Google's free Gemini infra and just add a kid-safety
layer on top.

> ⚠️ **This is a personal/household tool, not an enforceable product gate.** A content-script
> guard can be disabled or removed by the user, Gemini's DOM changes often (you may need to
> update the selector), and using consumer Gemini for a child may conflict with Google's
> Terms / age rules (use Family Link). For an *enforceable* gate, use the server-side app.

## How it works

1. A content script observes each Gemini response (`MutationObserver`).
2. While it streams, the response is **blurred** with a "🛡️ Checking…" overlay.
3. When streaming settles, the text is classified:
   - **Layer 0 — local rules** (`safety-rules.js`): instant, offline, ₹0.
   - **Layer 2 — LLM check** (optional): POSTed to the app's `/api/safety`, which reuses the
     same Flash-Lite classifier + parent dashboard.
4. **Safe →** revealed. **Unsafe →** replaced with a kind redirect, and a parent alert is logged.

The local rules always run; the LLM layer is best-effort and **fails open** if the app server
is off (so the tool still works offline). Flip this in `content.js` if you want fail-closed.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** → select this `extension/` folder.
4. Open the extension popup to set:
   - **Protection** on/off, **Strictness**.
   - **Safety API URL** — leave as `http://localhost:3000/api/safety` and run the app
     (`npm run dev`) for the LLM layer, or blank it for local-rules-only.
5. Open `gemini.google.com` and chat. Reload the tab after changing settings.

## Files
- `manifest.json` — MV3 config + permissions.
- `content.js` — observe → blur → buffer → classify → reveal/block.
- `safety-rules.js` — deterministic local rules (Layer 0).
- `background.js` — proxies LLM checks (bypasses page CORS) + stores alerts.
- `popup.*` — parent controls + recent alerts.
- `overlay.css` — blur/overlay/redirect styles.

## Maintenance
If responses stop being guarded after a Gemini update, update **response selector** in the
popup (Advanced) to match the new markup.
