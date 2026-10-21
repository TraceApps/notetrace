// These functions are serialized into the generated worker. Keep them free
// of imports and captured variables, and account for a server mount prefix.
export function appNavigationMatch({ request, url }) {
  return request.mode === 'navigate'
    && !/\/(?:api|uploads)(?:\/|$)/.test(url.pathname)
    && !/\/share-target(?:\/|$)/.test(url.pathname)
    && !/\/n\/[^/]+\/?$/.test(url.pathname);
}

export async function cacheNavigationResponse({ request, response }) {
  if (response.status !== 200 || response.redirected || response.type === 'opaqueredirect') return null;
  if (!response.headers.get('content-type')?.includes('text/html')) return null;
  if (response.url && new URL(response.url).origin !== new URL(request.url).origin) return null;
  return response;
}
