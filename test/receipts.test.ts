import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAppHandler, hostContext, isolatedCacheSession, type HostContext } from "apps/host";
import app from "../index.js";
import { createSqlReceiptStore, runReceiptedMutation, type ReceiptSql, type DefinitiveOutcome } from "../src/receipts.js";

const path = "migrations/0001_operation_receipts.sql";
const migration = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const sql = {
    exec<Row>(query: string, ...bindings: (string | number | null)[]) {
      return { toArray: () => db.prepare(query).all(...bindings) as Row[] };
    },
    transaction<T>(work: (tx: ReceiptSql) => T): T { return transaction(() => work(sql)); },
  } as unknown as ReceiptSql;
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const storage = {
    sql: { exec(query: string, ...bindings: (string | number | null)[]) {
      return { columnNames: [], rowsRead: 0, rowsWritten: 0, toArray: () => db.prepare(query).all(...bindings) as Record<string, string | number | null>[] };
    } },
    transactionSync: transaction,
  } satisfies NonNullable<HostContext["storage"]>;
  return { db, store: createSqlReceiptStore(sql), sql, storage };
}

const scope = { callerId: "host-caller", accountId: "stable-connection", environment: "sandbox" as const };

test("Executor pauses production writes for exact approval and lets sandbox writes run", async (context) => {
  const { db, storage } = database();
  context.after(() => db.close());
  const hosts: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    hosts.push(new URL(input instanceof Request ? input.url : input).hostname);
    return Response.json({ messages: { resultCode: "Ok" }, customerProfileId: "42" });
  });
  const { cache } = isolatedCacheSession(async () => ({
    ok: true, value: { entry: { value: "generation", version: "v1", freshUntil: Date.now() + 60_000, staleUntil: Date.now() + 60_000 }, lease: null },
  }));
  const input = { operation: "create_customer_profile", args: { profile: { merchantCustomerId: "fixture" } } };
  const handler = createAppHandler(app);
  const requirements = await handler(new Request("https://executor.invalid/", {
    method: "POST", body: JSON.stringify({ operation: "requirements" }),
  }), hostContext({ app: {} }));
  assert.equal(requirements.status, 200);
  const { value } = await requirements.json();
  const provider = value.accounts.user.merchant.definition;
  const call = (method: "sandbox" | "production", approval?: { tool: string; input: typeof input }) =>
    handler(new Request("https://executor.invalid/", {
      method: "POST", body: JSON.stringify({ operation: "call", kind: "mutation", tool: "write", input }),
    }), { ...hostContext({
      app: {}, user: { merchant: {
        id: "acc_fixture", method, generation: 1, fields: { apiLoginId: "fixture", transactionKey: "fixture-key" },
        provider,
      } },
    }, approval), storage, cache, files: [{ path, content: migration }] });

  const pending = await call("production");
  assert.equal(pending.status, 409, await pending.text());
  const mismatched = await call("production", {
    tool: "write", input: { ...input, args: { profile: { merchantCustomerId: "different" } } },
  });
  assert.equal(mismatched.status, 422, await mismatched.text());
  assert.deepEqual(hosts, []);
  const sandbox = await call("sandbox");
  assert.equal(sandbox.status, 200, await sandbox.text());
  const approved = await call("production", { tool: "write", input });
  assert.equal(approved.status, 200, await approved.text());
  assert.deepEqual(hosts, ["apitest.authorize.net", "api.authorize.net"]);
  assert.deepEqual(db.prepare("SELECT state FROM operation_receipts").all().map((row) => row.state), ["succeeded", "succeeded"]);
});

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
    const production = { ...options, scope: { ...scope, environment: "production" as const } };
    assert.equal((await runReceiptedMutation(production)).replayed, false);
    assert.equal((await runReceiptedMutation(production)).replayed, true);
    await runReceiptedMutation({ ...options, operation: "refund" });
    await runReceiptedMutation({ ...options, normalizedInput: { a: 2, b: 2 } });
    assert.equal(calls, 6);
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

test("invalid input fails before reservation or transmission", async () => {
  const { db, store } = database();
  try {
    let calls = 0;
    const invoke = async () => { calls++; return { status: "succeeded" as const }; };
    const options = { store, scope, operation: "void", normalizedInput: {}, invoke };
    await assert.rejects(runReceiptedMutation({ ...options, normalizedInput: { invalid: Number.NaN } }), /normalized JSON/);
    await assert.rejects(runReceiptedMutation({ ...options, scope: { ...scope, callerId: "" } }), /trusted identity/);
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM operation_receipts").get()!.n, 0);
  } finally { db.close(); }
});
