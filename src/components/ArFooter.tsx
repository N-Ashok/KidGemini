// Ariantra shared footer — same markup as the platform's Footer.tsx
// (Ariantra-Platform src/lib/ui/Footer.tsx). Styling comes from the brand kit
// CSS. Keep in sync when the platform footer changes (npm run sync:brand only
// refreshes the CSS, not this markup).

const WA_URL =
  "https://wa.me/917204404452?text=Hi%2C%20I%27d%20like%20to%20book%20a%20free%20first%20session%20for%20my%20kid.";
const TEL_URL = "tel:+917204404452";

export function ArFooter() {
  return (
    <footer className="ar-footer">
      <div className="ar-footer-inner">
        <div className="ar-footer-grid">
          <div>
            <div className="ar-footer-logo">
              Ariantra<span>.</span>
            </div>
            <div className="ar-footer-tag">AI Foundry — Game Building for Kids</div>
            <p className="ar-footer-desc">
              We help kids aged 7–16 turn their own ideas into real, playable games — with AI as
              their developer. No coding required, no templates. Just imagination, building, and
              the pride of making something real. Built in India, for curious young creators everywhere.
            </p>
            <div className="ar-footer-social">
              <a href="https://www.youtube.com/@ariantra-ai" target="_blank" rel="noopener noreferrer">▶ YouTube</a>
              <a href="https://www.linkedin.com/company/ariantra/" target="_blank" rel="noopener noreferrer">in LinkedIn</a>
            </div>
          </div>
          <div className="ar-footer-col">
            <h4>Explore</h4>
            <a href="https://games.ariantra.com">All games</a>
            <a href="https://ariantra.com/#videos">Videos</a>
            <a href="/">KidGemini</a>
            <a href="https://studio.ariantra.com">Creator Studio</a>
          </div>
          <div className="ar-footer-col">
            <h4>Contact</h4>
            <a href="mailto:contact@ariantra.com">contact@ariantra.com</a>
            <a href={TEL_URL}>Call us: +91 72044 04452</a>
            <a href={WA_URL} target="_blank" rel="noopener noreferrer">WhatsApp: +91 72044 04452</a>
            <p>400-A, 4th Floor, Yusuf Sarai Commercial Complex, Hauz Khas, New Delhi – 110016, India</p>
          </div>
        </div>
        <div className="ar-footer-bottom">
          <span>© 2026 Ariantra AI Foundry Private Limited. Made with curiosity in India.</span>
          <span>
            <a href="https://ariantra.com/terms.html">Terms &amp; Conditions</a> &nbsp;·&nbsp;
            <a href="https://ariantra.com/privacy.html">Privacy Policy</a> &nbsp;·&nbsp; CIN: U63119DL2026PTC465754
          </span>
        </div>
      </div>
    </footer>
  );
}
