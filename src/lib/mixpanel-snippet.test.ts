import { describe, it, expect } from 'vitest';
import { MIXPANEL_SNIPPET, MIXPANEL_TOKEN } from './mixpanel-snippet';

/** Analytics must never leak sensitive data (user requirement 2026-07-06):
 *  masked replay text, no input capture, no element text, no IP storage. */
describe('mixpanel snippet — privacy hardening', () => {
  it('M.1 initializes the right project with autocapture + full session recording', () => {
    expect(MIXPANEL_SNIPPET).toContain(MIXPANEL_TOKEN);
    expect(MIXPANEL_SNIPPET).toContain('record_sessions_percent: 100');
  });

  it('M.2 session recordings mask ALL text and block media/embedded games', () => {
    expect(MIXPANEL_SNIPPET).toMatch(/record_mask_text_selector:\s*'\*'/);
    expect(MIXPANEL_SNIPPET).toMatch(/record_block_selector:\s*'img, video, iframe'/);
  });

  it('M.3 autocapture never captures typed input or element text', () => {
    expect(MIXPANEL_SNIPPET).toContain('input: false');
    expect(MIXPANEL_SNIPPET).toContain('capture_text_content: false');
  });

  it('M.4 IP addresses are not stored (no precise geolocation)', () => {
    expect(MIXPANEL_SNIPPET).toMatch(/ip:\s*false/);
  });

  it('M.5 never identifies users (no emails/usernames into Mixpanel)', () => {
    expect(MIXPANEL_SNIPPET).not.toMatch(/mixpanel\.identify\(/);
    expect(MIXPANEL_SNIPPET).not.toMatch(/people\.set\(/);
  });
});
