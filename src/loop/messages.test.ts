import { describe, expect, it } from 'vitest';
import { initialMessages, refreshSystem } from './messages.js';
import { testRunRequest } from '../testing/fixtures.js';

const URL_LINE = 'Operator-supplied landing page URL for this goal';

describe('system message operator input', () => {
  it('tells the model the authenticated landing URL on a follow-up send_message', () => {
    const request = testRunRequest({ userSuppliedInput: { landingPageUrl: 'https://Example.com/pricing#top' } });
    const [system, user] = initialMessages(undefined, request);
    expect(system?.content).toContain(`${URL_LINE} (use exactly this for research.gather and ads.create_campaign): https://example.com/pricing`);
    expect(user?.content).toBe('hello');
  });

  it('omits the line when Hub sent no operator URL', () => {
    const [system] = initialMessages(undefined, testRunRequest());
    expect(system?.content).not.toContain(URL_LINE);
  });

  it('keeps the line when the system message is refreshed between turns', () => {
    const request = testRunRequest({ userSuppliedInput: { landingPageUrl: 'https://example.com/' } });
    const refreshed = refreshSystem([{ role: 'system', content: 'old' }, { role: 'user', content: 'hi' }], undefined, request);
    expect(refreshed[0]?.content).toContain(`${URL_LINE}`);
    expect(refreshed).toHaveLength(2);
  });
});
