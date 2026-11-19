import {
  defineApp, defineProvider, json, mutation, object, plain, query, record, router, secrets, string, type QueryContext,
} from 'apps';
import { z } from 'zod';
import { ClientError, createClient } from './src/client.js';
import { describeOperation, getOperation, listOperations } from './src/catalog.js';
import { parseDescribeInput, parseDispatchInput, parseListInput, parseWebhookOrigin, readSubscriptionSchedules } from './src/tools.js';
import { createSqlReceiptStore, runReceiptedMutation } from './src/receipts.js';

const fields = object({
  apiLoginId: string({ minLength: 1, title: 'API Login ID' }),
  transactionKey: string({ minLength: 1, title: 'Transaction Key' }),
  webhookDestinationOrigin: plain(string({ title: 'Webhook destination origin', description: 'Optional merchant-controlled canonical HTTPS origin, for example https://hooks.example.com' }).optional()),
});

export const merchant = defineProvider({
  name: 'Authorize.net',
  hosts: ['apitest.authorize.net', 'api.authorize.net'],
  auth: {
    sandbox: secrets({ label: 'Sandbox', fields }),
    production: secrets({ label: 'Production', fields }),
  },
  async health({ account, fetch, signal }) {
    if (account.method !== 'sandbox' && account.method !== 'production') {
      throw new Error('Unsupported merchant connection method.');
    }
    parseWebhookOrigin(account.fields.webhookDestinationOrigin);
    await createClient({
      environment: account.method,
      apiLoginId: account.fields.apiLoginId,
      transactionKey: account.fields.transactionKey,
      fetch,
      signal,
    }).authenticate();
  },
});

const requirements = { user: { accounts: { merchant } } };

function merchantReader(ctx: QueryContext<typeof requirements>) {
  const account = ctx.user.accounts.merchant;
  if (account.method !== 'sandbox' && account.method !== 'production') {
    throw new Error('Unsupported merchant connection method.');
  }
  const client = createClient({
    environment: account.method,
    apiLoginId: account.fields.apiLoginId,
    transactionKey: account.fields.transactionKey,
    fetch: ctx.fetch,
    signal: ctx.signal,
  });
  return { environment: account.method, client };
}

export default defineApp(requirements, async (evaluation) => {
  const original = evaluation.user?.accounts.merchant;
  if (!original) return { tools: router({}) };
  const environment = original.method;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error('Unsupported merchant connection method.');
  }
  const generationOptions = {
    key: 'write-approval-generation', schema: string(), freshFor: '1 day', staleFor: '0 seconds',
    load: async () => crypto.randomUUID(),
  } as const;
  const generation = await evaluation.cache.forAccount(original).get(generationOptions);
  return {
  tools: router({
    list_operations: query({
      description: 'List Authorize.net merchant operations, availability and prerequisites. Input: {}.',
      input: record(json()), output: json(),
    }, async (_ctx, input) => {
      parseListInput(input);
      return listOperations();
    }),
    describe_operation: query({
      description: 'Describe the closed input contract, effects and prerequisites. Input: {operation: string}.',
      input: record(json()), output: json(),
    }, async (_ctx, input) => z.json().parse(describeOperation(parseDescribeInput(input).operation))),
    read: query({
      description: 'Run a known read with the caller-owned connection. Input: {operation: string, args: object}. Describe the operation first. Rejects writes and unknown fields.',
      input: record(json()), output: json(),
    }, async (ctx, input) => {
      const { operation, args } = parseDispatchInput(input, 'read');
      const { environment, client } = merchantReader(ctx);
      const result = await client.execute(getOperation(operation), args);
      return z.json().parse({ environment, operation, result });
    }),
    get_subscription_schedules: query({
      description: 'Read exact Authorize.net ARB amounts and billing schedules for 1–20 distinct subscription IDs. Input: {subscriptionIds: string[]}. Returns per-ID failures and a completeness flag. Makes one gateway read per ID.',
      input: record(json()), output: json(),
    }, async (ctx, input) => {
      const { environment, client } = merchantReader(ctx);
      const operation = getOperation('get_subscription');
      const schedules = await readSubscriptionSchedules(input, (subscriptionId) =>
        client.execute(operation, { subscriptionId, includeTransactions: false }),
      );
      return z.json().parse({ environment, ...schedules });
    }),
    write: mutation({
      description: `Run a ${environment} write once per normalized request and caller-owned connection. Input: {operation: string, args: object}. Describe the operation first. ${environment === 'production' ? 'Requires human approval.' : 'Uses harness permissions.'}`,
      input: record(json()), output: json(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      approval: ({ toolInput }) => {
        parseDispatchInput(toolInput, 'write');
        return environment === 'production' ? 'user-approval' : 'approved';
      },
    }, async (ctx, input) => {
      const { operation, args } = parseDispatchInput(input, 'write');
      const account = ctx.user.accounts.merchant;
      const currentGeneration = await ctx.cache.forAccount(account).get(generationOptions);
      if (account.method !== environment || account.id !== original.id || currentGeneration !== generation) {
        throw new Error('Merchant connection changed. Start a new write request.');
      }
      let result: Record<string, unknown> | undefined;
      const receipt = await runReceiptedMutation({
        store: createSqlReceiptStore(ctx.sql),
        scope: { callerId: account.id, accountId: account.id, environment },
        operation, normalizedInput: z.json().parse(args),
        invoke: async () => {
          try {
            result = await createClient({
              environment, apiLoginId: account.fields.apiLoginId,
              transactionKey: account.fields.transactionKey, fetch: ctx.fetch,
              signal: ctx.signal, allowWrites: true,
              webhookOrigin: parseWebhookOrigin(account.fields.webhookDestinationOrigin),
            }).execute(getOperation(operation), args);
            return { status: 'succeeded' };
          } catch (error) {
            if (error instanceof ClientError && error.code === 'provider_rejected') {
              return { status: 'provider_error', definitive: true, providerCode: error.providerCode };
            }
            throw error;
          }
        },
      });
      return z.json().parse({ environment, operation, ...receipt, ...(result ? { result } : {}) });
    }),
  }, {
    title: 'Authorize.net MCP',
    description: 'Key-based Authorize.net merchant operations with fixed hosts and caller-owned connections.',
  }),
  };
});
