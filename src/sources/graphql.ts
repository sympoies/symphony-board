// Tiny GraphQL-over-HTTP client shared by the provider sources. Both GitHub and
// GitLab accept `Authorization: Bearer <PAT>` on their GraphQL endpoints, so one
// helper serves both; only the URL and token differ.

export type GqlClient = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export function makeGqlClient(url: string, token: string): GqlClient {
  return async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "symphony-board",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`GraphQL HTTP ${res.status}: non-JSON response from ${url}`);
    }
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${json?.message ?? text}`);
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e: { message: string }) => e.message).join("; ")}`);
    }
    return json.data as T;
  };
}
