import { describe, it, expect } from 'vitest';
import { MIXPANEL_SNIPPET, MIXPANEL_TOKEN, TRACKED_HOSTNAME_RE } from './mixpanel-snippet';

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

  it('M.4 IP-based geolocation (city/region/country) is enabled', () => {
    expect(MIXPANEL_SNIPPET).toMatch(/ip:\s*true/);
  });

  it('M.5 never identifies users (no emails/usernames into Mixpanel)', () => {
    expect(MIXPANEL_SNIPPET).not.toMatch(/mixpanel\.identify\(/);
    expect(MIXPANEL_SNIPPET).not.toMatch(/people\.set\(/);
  });

  /** Regression: BUG_LOG #8 — every dev/manual-QA hit against localhost or a
   *  raw EC2 hostname was counted as a real Mixpanel unique user because
   *  mixpanel.init() fired unconditionally. */
  it('M.6 TRACKED_HOSTNAME_RE matches only real ariantra.com hosts', () => {
    expect(TRACKED_HOSTNAME_RE.test('ariantra.com')).toBe(true);
    expect(TRACKED_HOSTNAME_RE.test('studio.ariantra.com')).toBe(true);
    expect(TRACKED_HOSTNAME_RE.test('subway-surfer.ariantra.com')).toBe(true);
    expect(TRACKED_HOSTNAME_RE.test('kidgemini.ariantra.com')).toBe(true);
    expect(TRACKED_HOSTNAME_RE.test('localhost')).toBe(false);
    expect(TRACKED_HOSTNAME_RE.test('127.0.0.1')).toBe(false);
    expect(TRACKED_HOSTNAME_RE.test('notariantra.com')).toBe(false);
    expect(TRACKED_HOSTNAME_RE.test('ec2-3-110-44-237.ap-south-1.compute.amazonaws.com')).toBe(false);
  });

  it('M.7 mixpanel.init is gated behind the tracked-host check', () => {
    expect(MIXPANEL_SNIPPET).toContain(`if (${TRACKED_HOSTNAME_RE}.test(window.location.hostname))`);
    // the init call must appear AFTER the gate, not before it
    const gateIndex = MIXPANEL_SNIPPET.indexOf('window.location.hostname');
    const initIndex = MIXPANEL_SNIPPET.indexOf('mixpanel.init(');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(initIndex).toBeGreaterThan(gateIndex);
  });
});
