// Isolated synthetic API. This module is loaded only by the benchmark process.
export const fixture = Array.from({ length: 5 }, (_, i) => ({
  number: 105 - i, title: ['Export fails', 'Slow search', 'Missing label', 'Stale cache', 'Broken link'][i],
  state: 'open', html_url: `https://github.com/example/project/issues/${105 - i}`,
  body: ('Synthetic reproduction details and diagnostic context for a reported application issue.\n').repeat(40),
  user: { login: 'fixture-user', avatar_url: 'https://example.invalid/avatar' },
  labels: [{ name: 'bug' }], comments: 12, created_at: '2026-01-01T00:00:00Z',
}));
process.env.GITHUB_TOKEN = 'fixture-token';
globalThis.fetch = async (endpoint, options = {}) => {
  const url = new URL(endpoint);
  if (url.origin !== 'https://api.github.com' || url.pathname !== '/repos/example/project/issues' ||
    (options.method ?? 'GET') !== 'GET') throw new Error('Unexpected benchmark API operation');
  if (url.searchParams.get('per_page') !== '5') throw new Error('Benchmark requires five results');
  return Response.json(fixture);
};
