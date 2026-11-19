import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqlReceiptStore, runReceiptedMutation, type ReceiptSql, type DefinitiveOutcome } from "../src/receipts.js";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE operation_receipts (
    receipt_key TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in_flight','succeeded','provider_error','completion_unknown')),
    provider_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const sql = {
    exec<Row>(query: string, ...bindings: (string | number | null)[]) {
      return { toArray: () => db.prepare(query).all(...bindings) as Row[] };
    },
    transaction<T>(work: (tx: ReceiptSql) => T): T {
      db.exec("BEGIN");
      try {
        const value = work(sql);
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as ReceiptSql;
  return { db, store: createSqlReceiptStore(sql), sql };
}

const scope = { callerId: "host-caller", accountId: "stable-connection", environment: "sandbox" as const };

test("atomic reservation blocks concurrent duplicates and survives store recreation", async () => {
  const { db, store, sql } = database();
  try {
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const options = { store, scope, operation: "void", normalizedInput: { transactionId: "123" },
      invoke: async () => { calls++; entered(); await wait; return { status: "succeeded" as const }; } };
    const first = runReceiptedMutation(options);
    await started;
    const second = await runReceiptedMutation({ ...options, store: createSqlReceiptStore(sql) });
    assert.equal(second.replayed, true);
    assert.equal(second.receipt.state, "in_flight");
    assert.equal(calls, 1);
    release();
    assert.equal((await first).receipt.state, "succeeded");
    assert.equal((await runReceiptedMutation(options)).replayed, true);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("unknown completion never retries and stores no payload or error text", async () => {
  const { db, store } = database();
  try {
    let calls = 0;
    const options = { store, scope, operation: "refund", normalizedInput: { transactionId: "123", amount: "1.00" },
      invoke: async () => { calls++; throw new Error("private provider payload alice@example.test"); } };
    assert.equal((await runReceiptedMutation(options)).receipt.state, "completion_unknown");
    assert.equal((await runReceiptedMutation(options)).receipt.state, "completion_unknown");
    assert.equal(calls, 1);
    const persisted = JSON.stringify(db.prepare("SELECT * FROM operation_receipts").all());
    assert.ok(!persisted.includes("alice"));
    assert.ok(!persisted.includes("transactionId"));
    assert.ok(!persisted.includes("1.00"));
  } finally { db.close(); }
});

test("input order normalizes while trusted scope and operation remain separate", async () => {
  const { db, store } = database();
  try {
    let calls = 0;
    const invoke = async () => { calls++; return { status: "succeeded" as const }; };
    const options = { store, scope, operation: "void", normalizedInput: { a: 1, b: 2 }, invoke };
    await runReceiptedMutation(options);
    assert.equal((await runReceiptedMutation({ ...options, normalizedInput: { b: 2, a: 1 } })).replayed, true);
    await runReceiptedMutation({ ...options, scope: { ...scope, callerId: "other-caller" } });
    await runReceiptedMutation({ ...options, scope: { ...scope, accountId: "other-account" } });
    await runReceiptedMutation({ ...options, operation: "refund" });
    await runReceiptedMutation({ ...options, normalizedInput: { a: 2, b: 2 } });
    assert.equal(calls, 5);
  } finally { db.close(); }
});

test("only definitive provider errors persist sanitized codes", async () => {
  const { db, store } = database();
  try {
    const result = await runReceiptedMutation({ store, scope, operation: "void", normalizedInput: {},
      invoke: async () => ({ status: "provider_error", definitive: true, providerCode: "E00027" }) });
    assert.equal(result.receipt.state, "provider_error");
    assert.equal(result.receipt.providerCode, "E00027");
    const unsafe = await runReceiptedMutation({ store, scope, operation: "refund", normalizedInput: {},
      invoke: async () => ({ status: "provider_error", definitive: true, providerCode: "private customer name" }) });
    assert.equal(unsafe.receipt.providerCode, undefined);
    const ambiguous = await runReceiptedMutation({ store, scope, operation: "cancel", normalizedInput: {},
      invoke: async () => ({ status: "provider_error" } as DefinitiveOutcome) });
    assert.equal(ambiguous.receipt.state, "completion_unknown");
    await assert.rejects(store.finish(ambiguous.receipt.key, "succeeded"), /invariant/);
    assert.equal((await runReceiptedMutation({ store, scope, operation: "cancel", normalizedInput: {},
      invoke: async () => ({ status: "succeeded" }) })).receipt.state, "completion_unknown");
  } finally { db.close(); }
});

test("production and invalid input fail before reservation or transmission", async () => {
  const { db, store } = database();
  try {
    let calls = 0;
    const invoke = async () => { calls++; return { status: "succeeded" as const }; };
    const options = { store, scope, operation: "void", normalizedInput: {}, invoke };
    await assert.rejects(runReceiptedMutation({ ...options, scope: { ...scope, environment: "production" } }), /disabled/);
    await assert.rejects(runReceiptedMutation({ ...options, normalizedInput: { invalid: Number.NaN } }), /normalized JSON/);
    await assert.rejects(runReceiptedMutation({ ...options, scope: { ...scope, callerId: "" } }), /trusted identity/);
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM operation_receipts").get()!.n, 0);
  } finally { db.close(); }
});
