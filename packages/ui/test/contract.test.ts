import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_MAJOR,
  majorOf,
  parseContract,
  fetchContract,
  resolveEndpoint,
  endpointRequiresServerUrl,
  fetchSyncControl,
  fetchCurrentSyncRun,
  startSyncRun,
  fetchConfigControl,
  saveConfigDocument,
  fetchSecrets,
  saveSecretValue,
  SYNC_CONTROL_HEADER,
} from "../src/contract.ts";

test("majorOf reads the leading integer of a version string (never NaN)", () => {
  assert.equal(SUPPORTED_MAJOR, 3);
  assert.equal(majorOf("1.2.3"), 1);
  assert.equal(majorOf("3.0.0"), 3);
  assert.equal(majorOf("10.4.1"), 10);
  assert.equal(majorOf(""), 0, "empty -> 0, not NaN");
});

test("parseContract accepts a well-formed envelope and rejects malformed input", () => {
  const ok = parseContract(JSON.stringify({ contract_version: "1.0.0", items: [] }));
  assert.equal(ok.contract_version, "1.0.0");
  assert.deepEqual(ok.items, []);

  assert.throws(() => parseContract("not json"), SyntaxError, "invalid JSON bubbles up");
  assert.throws(() => parseContract("[]"), /missing contract_version \/ items/, "array is not an envelope");
  assert.throws(() => parseContract(JSON.stringify({ items: [] })), /missing contract_version/, "no version");
  assert.throws(() => parseContract(JSON.stringify({ contract_version: "1.0.0" })), /missing contract_version \/ items/, "no items");
});

test("resolveEndpoint keeps web defaults relative and joins desktop server URLs", () => {
  assert.equal(resolveEndpoint("./contract.json", null), "./contract.json");
  assert.equal(resolveEndpoint("./api/range?from=2026-06-01&to=2026-06-09", null), "./api/range?from=2026-06-01&to=2026-06-09");
  assert.equal(resolveEndpoint("./contract.json", "http://localhost:8080/"), "http://localhost:8080/contract.json");
  assert.equal(
    resolveEndpoint("./api/range?from=2026-06-01&to=2026-06-09", "https://board.example.com/app/"),
    "https://board.example.com/app/api/range?from=2026-06-01&to=2026-06-09",
  );
  assert.equal(resolveEndpoint("https://x.example/contract.json", "http://localhost:8080/"), "https://x.example/contract.json");
});

test("Android client refuses the bundled relative contract until a server URL is configured", async () => {
  assert.equal(endpointRequiresServerUrl("./contract.json", null, "android"), true);
  assert.equal(endpointRequiresServerUrl("./api/range?from=2026-06-01&to=2026-06-09", null, "android"), true);
  assert.equal(endpointRequiresServerUrl("./contract.json", "https://board.example.com/", "android"), false);
  assert.equal(endpointRequiresServerUrl("https://board.example.com/contract.json", null, "android"), false);
  assert.equal(endpointRequiresServerUrl("./contract.json", null, null), false);

  await assert.rejects(
    () => fetchContract("./contract.json", null, "android"),
    /Android client requires a server URL/,
  );
});

test("fetchContract parses the JSON on a 2xx and throws with the status on a non-ok response", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ contract_version: "1.0.0", items: [] }),
    })) as unknown as typeof fetch;
    const env = await fetchContract("./x.json", null);
    assert.equal(env.contract_version, "1.0.0");

    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    await assert.rejects(() => fetchContract("./missing.json", null), /could not load .* HTTP 404/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- contract-load resilience: bounded per-attempt timeout + backoff retry ---
// A remote board can be briefly unreachable or slow; the load must not hang
// forever on a single stalled request, nor turn one transient blip into a board
// that never recovers without an app restart. Transient failures (network throw,
// abort/timeout, 5xx) retry with backoff; a definitive answer (4xx, or a 200
// whose body is not a contract) surfaces immediately without spinning.

test("fetchContract retries a transient failure and then succeeds", async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error("connection reset");
      return { ok: true, status: 200, json: async () => ({ contract_version: "3.0.0", items: [] }) };
    }) as unknown as typeof fetch;
    const env = await fetchContract("./x.json", null, null, { retries: 3, retryBaseDelayMs: 0, sleep: async () => {} });
    assert.equal(env.contract_version, "3.0.0");
    assert.equal(calls, 3, "two failures then a success");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchContract gives up after exhausting its retries", async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchContract("./x.json", null, null, { retries: 2, retryBaseDelayMs: 0, sleep: async () => {} }),
      /offline/,
    );
    assert.equal(calls, 3, "one initial attempt plus two retries");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchContract retries a 5xx but never a 4xx", async () => {
  const realFetch = globalThis.fetch;
  try {
    // 503 is transient: retried, then a success is returned.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ contract_version: "3.0.0", items: [] }) };
    }) as unknown as typeof fetch;
    const env = await fetchContract("./x.json", null, null, { retries: 3, retryBaseDelayMs: 0, sleep: async () => {} });
    assert.equal(env.contract_version, "3.0.0");
    assert.equal(calls, 2, "the 503 is retried once");

    // 404 ("no contract emitted yet") is definitive: it is not retried.
    let calls4xx = 0;
    globalThis.fetch = (async () => {
      calls4xx++;
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchContract("./missing.json", null, null, { retries: 3, retryBaseDelayMs: 0, sleep: async () => {} }),
      /HTTP 404/,
    );
    assert.equal(calls4xx, 1, "a 4xx is not retried");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchContract does not retry a 200 whose body is not a contract", async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ nope: true }) };
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchContract("./bad.json", null, null, { retries: 3, retryBaseDelayMs: 0, sleep: async () => {} }),
      /not a symphony-board contract/,
    );
    assert.equal(calls, 1, "a definitive bad body is not retried");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchContract aborts a stalled request via the per-attempt timeout", async () => {
  const realFetch = globalThis.fetch;
  try {
    let aborted = false;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error("no signal provided"));
          return;
        }
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason ?? new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    await assert.rejects(() =>
      fetchContract("./hang.json", null, null, { retries: 0, requestTimeoutMs: 10, sleep: async () => {} }),
    );
    assert.equal(aborted, true, "the per-attempt timeout aborts the underlying request");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchContract bounds each attempt with an abort signal and a connect timeout", async () => {
  const realFetch = globalThis.fetch;
  try {
    let seenInit: (RequestInit & { connectTimeout?: number }) | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit & { connectTimeout?: number }) => {
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ contract_version: "3.0.0", items: [] }) };
    }) as unknown as typeof fetch;
    await fetchContract("./x.json", null, null, { requestTimeoutMs: 5000, connectTimeoutMs: 1000 });
    assert.ok(seenInit?.signal instanceof AbortSignal, "an abort signal bounds the attempt");
    assert.equal(seenInit?.connectTimeout, 1000, "the desktop connect timeout is plumbed through");
    assert.equal(seenInit?.cache, "no-store", "the contract is still fetched no-store");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchContract accepts a JSON string body and rejects a non-contract body", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.stringify({ contract_version: "1.0.0", items: [] }),
    })) as unknown as typeof fetch;
    assert.equal((await fetchContract("./string-body.json", null)).contract_version, "1.0.0");

    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => "not a contract" })) as unknown as typeof fetch;
    await assert.rejects(() => fetchContract("./bad.json", null), /Unexpected token|not a symphony-board contract/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchSyncControl returns the info on 2xx and null on any failure", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, sources: [], current: null, last: null }) })) as unknown as typeof fetch;
    const info = await fetchSyncControl(null);
    assert.equal(info?.enabled, true);

    // a missing control surface (404) reads as "unavailable", not an error
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal(await fetchSyncControl(null), null);

    // a network failure also reads as unavailable
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await fetchSyncControl(null), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchCurrentSyncRun unwraps the current run", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ current: { run_id: "r1", status: "running" } }) })) as unknown as typeof fetch;
    assert.equal((await fetchCurrentSyncRun(null))?.run_id, "r1");

    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ current: null }) })) as unknown as typeof fetch;
    assert.equal(await fetchCurrentSyncRun(null), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("startSyncRun sends the same-origin header and adopts the 409 active run", async () => {
  const realFetch = globalThis.fetch;
  try {
    let seenHeader: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenHeader = (init.headers as Record<string, string>)[SYNC_CONTROL_HEADER];
      return { ok: true, status: 202, json: async () => ({ current: { run_id: "r2", status: "running" } }) };
    }) as unknown as typeof fetch;
    const ok = await startSyncRun({ mode: "incremental", dry_run: false, source_id: null }, null);
    assert.equal(ok.ok, true);
    assert.equal(ok.run?.run_id, "r2");
    assert.equal(seenHeader, "1", "the mutating POST carries the same-origin guard header");

    // 409: a run is already active; the active run rides back in `current`.
    globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: "run_active", current: { run_id: "r3", status: "running" } }) })) as unknown as typeof fetch;
    const busy = await startSyncRun({ mode: "full", dry_run: false, source_id: null }, null);
    assert.equal(busy.ok, false);
    assert.equal(busy.status, 409);
    assert.equal(busy.run?.run_id, "r3", "the 409 response adopts the active run for polling");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchConfigControl returns the probe on 2xx and null on any failure", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, config: { db_path: "x", sources: [] }, error: null }) })) as unknown as typeof fetch;
    const info = await fetchConfigControl(null);
    assert.equal(info?.enabled, true);
    assert.equal(info?.config?.db_path, "x");

    // disabled deployments still answer the probe; the editor hides on enabled:false
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ enabled: false, config: null, error: null }) })) as unknown as typeof fetch;
    assert.equal((await fetchConfigControl(null))?.enabled, false);

    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal(await fetchConfigControl(null), null);

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await fetchConfigControl(null), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("saveConfigDocument sends the guard header and decodes field-level validation errors", async () => {
  const realFetch = globalThis.fetch;
  try {
    let seenHeader: string | undefined;
    let seenMethod: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenHeader = (init.headers as Record<string, string>)[SYNC_CONTROL_HEADER];
      seenMethod = init.method;
      return { ok: true, status: 200, json: async () => ({ ok: true, config: { db_path: "x", sources: [] } }) };
    }) as unknown as typeof fetch;
    const ok = await saveConfigDocument({ db_path: "x", sources: [] }, null);
    assert.equal(ok.ok, true);
    assert.equal(seenMethod, "PUT");
    assert.equal(seenHeader, "1", "the mutating PUT carries the same-origin guard header");

    // 400 invalid_config: the daemon's messages ride back verbatim
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_config", errors: ["config is missing db_path", 'config: source missing "source_id"'] }),
    })) as unknown as typeof fetch;
    const invalid = await saveConfigDocument({ db_path: "", sources: [] }, null);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.length, 2);
    assert.equal(invalid.error, null, "validation failures are not a transport error");

    // any other failure surfaces as a single error message
    globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({ error: "control_disabled" }) })) as unknown as typeof fetch;
    const refused = await saveConfigDocument({ db_path: "x", sources: [] }, null);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.errors, []);
    assert.equal(refused.error, "control_disabled");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchSecrets probes booleans-only and saveSecretValue never echoes the value", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, writable: true, secrets: { GITHUB_TOKEN: true } }) })) as unknown as typeof fetch;
    const info = await fetchSecrets(null);
    assert.equal(info?.writable, true);
    assert.equal(info?.secrets.GITHUB_TOKEN, true);

    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal(await fetchSecrets(null), null);

    let seenBody: string | undefined;
    let seenHeader: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenBody = init.body as string;
      seenHeader = (init.headers as Record<string, string>)[SYNC_CONTROL_HEADER];
      return { ok: true, status: 200, json: async () => ({ ok: true, env: "GITHUB_TOKEN", set: true }) };
    }) as unknown as typeof fetch;
    const set = await saveSecretValue("GITHUB_TOKEN", "ghp_x", null);
    assert.equal(set.ok, true);
    assert.equal(seenHeader, "1");
    assert.deepEqual(JSON.parse(seenBody!), { env: "GITHUB_TOKEN", value: "ghp_x" });

    globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({ error: "secrets_unavailable", message: "no writable secrets file" }) })) as unknown as typeof fetch;
    const refused = await saveSecretValue("GITHUB_TOKEN", "x", null);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "no writable secrets file");
  } finally {
    globalThis.fetch = realFetch;
  }
});
