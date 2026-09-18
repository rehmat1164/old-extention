export const PROVIDERS = Object.freeze({
  meta: { home: 'https://www.meta.ai/', hosts: ['meta.ai', 'www.meta.ai'] },
  vibes: { home: 'https://vibes.ai/', hosts: ['vibes.ai', 'www.vibes.ai'] },
});

export function providerForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    return Object.keys(PROVIDERS).find(key => PROVIDERS[key].hosts.includes(url.hostname)) || null;
  } catch {
    return null;
  }
}

export function allowedMediaUrl(value, provider) {
  if (typeof value !== 'string' || !PROVIDERS[provider]) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') return providerForUrl(url.pathname) === provider;
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    return providerForUrl(value) === provider || ['fbcdn.net', 'fbsbx.com'].some(host => url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function vibesProjectUrl(value) {
  if (providerForUrl(value) !== 'vibes') return null;
  const url = new URL(value);
  if (!/^\/projects\/[^/]+\/?$/.test(url.pathname)) return null;
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export function publicStatus(session) {
  if (!session) return null;
  return {
    ...session,
    meta: session.meta ? { tabId: session.meta.tabId, url: session.meta.url } : null,
    vibes: session.vibes ? { tabId: session.vibes.tabId, url: session.vibes.url } : null,
    jobs: session.jobs.map(job => ({
      ...job,
      image: job.image ? omitMediaUrl(job.image) : null,
      upload: job.upload ? omitMediaUrl(job.upload) : null,
      variants: job.variants.map(omitMediaUrl),
    })),
    operation: session.operation ? {
      id: session.operation.id, action: session.operation.action,
      tabId: session.operation.tabId, index: session.operation.index,
    } : null,
  };
}

function omitMediaUrl(asset) {
  const { url, dataUrl, sourceKey, ...metadata } = asset;
  return metadata;
}

export function validateVariants(variants) {
  if (!Array.isArray(variants) || !variants.length || variants.some(v => !Number.isInteger(v) || v < 1 || v > 4)
    || new Set(variants).size !== variants.length) {
    throw new Error('Select at least one unique video variant from 1 to 4.');
  }
  return [...variants].sort((a, b) => a - b);
}
