import { describe, expect, it } from 'vitest';
import { HttpUrlResearchProvider } from './http-url-provider.js';
import { UnconfiguredResearchProvider } from './unconfigured.js';
import { TEST_LANDING_URL } from '../testing/research.js';

describe('research providers', () => {
  it('unconfigured provider fails honestly without citations', async () => {
    const provider = new UnconfiguredResearchProvider();
    const result = await provider.research({
      workspaceId: 'seedbed',
      userId: '11111111-1111-4111-8111-111111111111',
      goalId: '11111111-1111-4111-8111-111111111113',
      threadId: '11111111-1111-4111-8111-111111111114',
      landingPageUrl: TEST_LANDING_URL,
    });
    expect(provider.configured).toBe(false);
    expect(result).toMatchObject({ ok: false, code: 'research_unconfigured' });
  });

  it('refuses private URLs before fetch', async () => {
    let fetched = 0;
    const provider = new HttpUrlResearchProvider({
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl: async () => {
        fetched += 1;
        return new Response('nope');
      },
    });
    const result = await provider.research({
      workspaceId: 'seedbed',
      userId: '11111111-1111-4111-8111-111111111111',
      goalId: '11111111-1111-4111-8111-111111111113',
      threadId: '11111111-1111-4111-8111-111111111114',
      landingPageUrl: 'http://127.0.0.1/',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ssrf_blocked');
    expect(fetched).toBe(0);
  });

  it('does not follow redirects and treats body as untrusted sourced excerpt', async () => {
    const provider = new HttpUrlResearchProvider({
      timeoutMs: 1000,
      maxBytes: 4096,
      resolveAddresses: async () => ['8.8.8.8'],
      fetchImpl: async () =>
        new Response('<html><title>Trail shoe</title><body>Buy the trail shoe</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const ok = await provider.research({
      workspaceId: 'seedbed',
      userId: '11111111-1111-4111-8111-111111111111',
      goalId: '11111111-1111-4111-8111-111111111113',
      threadId: '11111111-1111-4111-8111-111111111114',
      landingPageUrl: TEST_LANDING_URL,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.sources[0]?.kind).toBe('http_url');
      expect(ok.findings[0]?.sourceIds).toEqual(['page-1']);
      expect(ok.findings[0]?.text).toMatch(/Trail shoe/);
    }

    const redirects = new HttpUrlResearchProvider({
      timeoutMs: 1000,
      maxBytes: 4096,
      resolveAddresses: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    });
    const bounced = await redirects.research({
      workspaceId: 'seedbed',
      userId: '11111111-1111-4111-8111-111111111111',
      goalId: '11111111-1111-4111-8111-111111111113',
      threadId: '11111111-1111-4111-8111-111111111114',
      landingPageUrl: TEST_LANDING_URL,
    });
    expect(bounced.ok).toBe(false);
    if (!bounced.ok) expect(bounced.code).toBe('ssrf_blocked');
  });

  it('drops script and style bodies even when end tags include whitespace', async () => {
    const html = [
      '<html><title>Trail shoe</title><body>',
      '<script>SECRET_SCRIPT_PAYLOAD</script >',
      '<script type="text/javascript">ALSO_SECRET</script\t>',
      '<style>SECRET_CSS{color:red}</style >',
      '<scripter>visible widget</scripter>',
      '<p>Buy the trail shoe</p>',
      '<script>UNCLOSED_SECRET',
      '</body></html>',
    ].join('');
    const provider = new HttpUrlResearchProvider({
      timeoutMs: 1000,
      maxBytes: 8192,
      resolveAddresses: async () => ['8.8.8.8'],
      fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const ok = await provider.research({
      workspaceId: 'seedbed',
      userId: '11111111-1111-4111-8111-111111111111',
      goalId: '11111111-1111-4111-8111-111111111113',
      threadId: '11111111-1111-4111-8111-111111111114',
      landingPageUrl: TEST_LANDING_URL,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const blob = `${ok.findings[0]?.text ?? ''} ${ok.sources[0]?.excerpt ?? ''}`;
    expect(blob).toMatch(/Trail shoe/);
    expect(blob).toMatch(/Buy the trail shoe/);
    expect(blob).toMatch(/visible widget/);
    expect(blob).not.toMatch(/SECRET_SCRIPT_PAYLOAD/);
    expect(blob).not.toMatch(/ALSO_SECRET/);
    expect(blob).not.toMatch(/SECRET_CSS/);
    expect(blob).not.toMatch(/UNCLOSED_SECRET/);
  });
});
