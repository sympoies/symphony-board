// Loading the contract (LAYER 3) for the UI to render. The UI is a pure
// CONSUMER: it reads the versioned JSON envelope and stays liberal in what it
// accepts (it does not re-validate — producers validate strictly; see
// docs/CONTRACT.md). Types come from @symphony-board/contract.

import type { ContractEnvelope } from "@symphony-board/contract";
import type { TimeRange } from "./model.ts";

// The major this UI understands. The contract versions independently; if a
// future emit bumps the MAJOR, the UI should branch (or warn) rather than
// silently mis-render. Minor/patch are backward compatible by contract rule.
export const SUPPORTED_MAJOR = 2;

export function majorOf(version: string): number {
  return Number(version.split(".")[0] ?? "0");
}

// Fetch the contract emitted alongside the app (the loop daemon writes
// data/contract.json; deploy it next to index.html). Relative URL so it works
// under any base path.
export async function fetchContract(url = "./contract.json"): Promise<ContractEnvelope> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
  return (await res.json()) as ContractEnvelope;
}

export async function fetchRangeContract(range: TimeRange): Promise<ContractEnvelope> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  return fetchContract(`./api/range?${params.toString()}`);
}

// Parse a contract the user dropped in via the file picker.
export function parseContract(text: string): ContractEnvelope {
  const env = JSON.parse(text) as ContractEnvelope;
  if (!env || !Array.isArray(env.items) || typeof env.contract_version !== "string") {
    throw new Error("not a symphony-board contract (missing contract_version / items)");
  }
  return env;
}
