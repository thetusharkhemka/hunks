export async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

export function cacheKey(url: string) {
  return `v1:${url}`;
}

export function retryDelay(attempt: number) {
  return Math.min(1000 * 2 ** attempt, 30000);
}
