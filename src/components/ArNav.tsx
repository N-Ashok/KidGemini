// Ariantra shared header — same markup/classes as the platform's NavBar/Logo
// (Ariantra-Platform src/lib/ui). Styling comes from the brand kit CSS linked in
// the root layout, so this header is pixel-identical across www / catalog /
// studio / kidgemini. Header-only rebrand: the kid-styled interior is untouched.

const WWW_URL = "https://www.ariantra.com";
const GAMES_URL = "https://games.ariantra.com";
const STUDIO_URL = "https://studio.ariantra.com";

export function ArNav() {
  return (
    <header className="ar-nav">
      <div className="ar-nav-inner">
        <a href="/" aria-label="Ariantra AI Foundry" className="ar-logo">
          <span className="ar-logo-word">Ariantra</span>
          <span className="ar-logo-divider">
            <span className="ar-logo-line" />
            <span className="ar-logo-dot" />
            <span className="ar-logo-line" />
          </span>
          <span className="ar-logo-sub">AI Foundry</span>
        </a>
        <nav className="ar-nav-links">
          <a href={WWW_URL} className="ar-link">Home</a>
          <a href={GAMES_URL} className="ar-link">Games</a>
          <a href="/" className="ar-link on">KidGemini</a>
          <a href={STUDIO_URL} className="ar-link">Studio</a>
        </nav>
      </div>
    </header>
  );
}
