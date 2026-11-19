export async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function cacheKey(url: string) {
  return `v1:${url}`;
}

export function isRetryable(status: number) {
  return status === 429 || status >= 500;
}

export function retryDelay(attempt: number) {
  return Math.min(1000 * 2 ** attempt, 30000);
}
