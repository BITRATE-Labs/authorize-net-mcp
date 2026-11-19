import type { Sql } from "apps";

export type ReceiptState = "in_flight" | "succeeded" | "provider_error" | "completion_unknown";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Receipt = { key: string; fingerprint: string; state: ReceiptState; providerCode?: string; createdAt: number; updatedAt: number };

export interface ReceiptStore {
  // Claim and lookup must be atomic across concurrent calls.
  claim(receipt: Receipt): Promise<{ claimed: boolean; receipt: Receipt }>;
  finish(key: string, state: Exclude<ReceiptState, "in_flight">, providerCode?: string): Promise<Receipt>;
}

export type ReceiptSql = Pick<Sql, "exec" | "transaction">;
type Row = { receipt_key: string; fingerprint: string; state: ReceiptState; provider_code: string | null; created_at: number; updated_at: number };

function fromRow(row: Row | undefined): Receipt {
  if (!row) throw new Error("Receipt storage invariant failed");
  return { key: row.receipt_key, fingerprint: row.fingerprint, state: row.state,
    ...(row.provider_code === null ? {} : { providerCode: row.provider_code }),
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createSqlReceiptStore(sql: ReceiptSql): ReceiptStore {
  return {
    async claim(receipt) {
      return sql.transaction((tx) => {
        const inserted = tx.exec<Row>(
          "INSERT INTO operation_receipts (receipt_key, fingerprint, state, provider_code, created_at, updated_at) VALUES (?, ?, 'in_flight', NULL, ?, ?) ON CONFLICT(receipt_key) DO NOTHING RETURNING *",
          receipt.key, receipt.fingerprint, receipt.createdAt, receipt.updatedAt,
        ).toArray();
        const row = inserted[0] ?? tx.exec<Row>("SELECT * FROM operation_receipts WHERE receipt_key = ?", receipt.key).toArray()[0];
        return { claimed: inserted.length > 0, receipt: fromRow(row) };
      });
    },
    async finish(key, state, providerCode) {
      return fromRow(sql.exec<Row>(
        "UPDATE operation_receipts SET state = ?, provider_code = ?, updated_at = ? WHERE receipt_key = ? AND state = 'in_flight' RETURNING *",
        state, safeProviderCode(providerCode) ?? null, Date.now(), key,
      ).toArray()[0]);
    },
  };
}

function canonical(value: Json): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key]!)).join(",") + "}";
  }
  throw new Error("Receipt fingerprint requires normalized JSON input");
}

async function digest(value: Json): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeProviderCode(code: unknown): string | undefined {
  return typeof code === "string" && /^(?:[EI]\d{5}|\d{1,8})$/.test(code) ? code : undefined;
}

export type DefinitiveOutcome = { status: "succeeded" } | { status: "provider_error"; definitive: true; providerCode?: string };

export async function runReceiptedMutation(options: {
  store: ReceiptStore;
  // Trusted host identity and immutable connection ID, never tool input.
  scope: { callerId: string; accountId: string; environment: "sandbox" | "production" };
  operation: string;
  // Validate and normalize the operation schema before entry.
  normalizedInput: Json;
  invoke(): Promise<DefinitiveOutcome>;
}): Promise<{ receipt: Receipt; replayed: boolean }> {
  const { store, scope, operation } = options;
  if (scope.environment !== "sandbox") throw new Error("Production mutations are disabled");
  if ([scope.callerId, scope.accountId, operation].some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Receipt requires trusted identity and operation");
  }
  const binding = [scope.callerId, scope.accountId, scope.environment, operation];
  const fingerprint = await digest([...binding, options.normalizedInput]);
  // Repeated input never becomes a new write through a new caller-chosen ID.
  const key = fingerprint;
  const now = Date.now();
  const claim = await store.claim({ key, fingerprint, state: "in_flight", createdAt: now, updatedAt: now });
  if (claim.receipt.fingerprint !== fingerprint) throw new Error("Request ID is already bound to different input");
  if (!claim.claimed) return { receipt: claim.receipt, replayed: true };

  let state: Exclude<ReceiptState, "in_flight"> = "completion_unknown";
  let code: string | undefined;
  try {
    const outcome = await options.invoke();
    if (outcome.status === "succeeded") state = "succeeded";
    else if (outcome.status === "provider_error" && outcome.definitive === true) {
      state = "provider_error";
      code = safeProviderCode(outcome.providerCode);
    }
  } catch {
    // Transport errors cannot establish that the provider did nothing.
  }
  return { receipt: await store.finish(key, state, code), replayed: false };
}
