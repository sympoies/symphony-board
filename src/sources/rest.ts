export type RestClient = <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>) => Promise<T>;

export function makeRestClient(baseUrl: string, token: string, provider: "github" | "gitlab"): RestClient {
  const base = baseUrl.replace(/\/+$/, "");
  return async function rest<T = any>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      "User-Agent": "symphony-board",
    };
    if (provider === "github") {
      headers.Authorization = `Bearer ${token}`;
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    } else {
      headers["PRIVATE-TOKEN"] = token;
    }
    const res = await fetch(url, { headers });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`REST HTTP ${res.status}: non-JSON response from ${url}`);
    }
    if (!res.ok) throw new Error(`REST HTTP ${res.status}: ${json?.message ?? text}`);
    return json as T;
  };
}

export function defaultRestUrl(kind: string, host: string): string {
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}`;
}
