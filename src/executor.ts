import { z } from 'zod';
import { getOperation } from './catalog.js';
import { ClientError } from './client.js';

const emptyInput = z.strictObject({});
const describeInput = z.strictObject({ operation: z.string().min(1).max(128) });
const dispatchInput = z.strictObject({
  operation: z.string().min(1).max(128),
  args: z.unknown(),
});
const scheduleInput = z.strictObject({
  subscriptionIds: z.array(z.string().regex(/^[1-9][0-9]{0,19}$/)).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Subscription IDs must be unique'),
});
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const subscriptionSchedule = z.object({
  subscription: z.object({
    status: z.string().regex(/^[a-zA-Z_]{1,32}$/),
    amount: decimal,
    trialAmount: decimal.optional(),
    paymentSchedule: z.object({
      interval: z.object({
        length: z.number().int().min(1).max(365),
        unit: z.enum(['days', 'months']),
      }),
      startDate: z.iso.date().optional(),
      totalOccurrences: z.number().int().nonnegative().optional(),
      trialOccurrences: z.number().int().nonnegative().optional(),
    }),
  }),
});

export function parseListInput(input: unknown) {
  return emptyInput.parse(input);
}

export function parseDescribeInput(input: unknown) {
  return describeInput.parse(input);
}

export function parseDispatchInput(input: unknown, kind: 'read' | 'write') {
  const envelope = dispatchInput.parse(input);
  const operation = getOperation(envelope.operation);
  if (operation.kind !== kind) throw new Error('Operation is not available through this dispatcher.');
  if (operation.status !== 'available') throw new Error('Operation prerequisites are not available.');
  return { ...envelope, args: operation.parse(envelope.args) };
}

export async function readSubscriptionSchedules(
  input: unknown,
  read: (subscriptionId: string) => Promise<Record<string, unknown>>,
) {
  const { subscriptionIds } = scheduleInput.parse(input);
  const results = [];
  async function readOne(subscriptionId: string) {
    try {
      const parsed = subscriptionSchedule.safeParse(await read(subscriptionId));
      if (!parsed.success) {
        throw new ClientError('invalid_response', 'Authorize.net did not return a usable subscription schedule.');
      }
      return { subscriptionId, ok: true as const, subscription: parsed.data.subscription };
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      return {
        subscriptionId, ok: false as const,
        error: { code: error.code, message: error.message, ...(error.providerCode ? { providerCode: error.providerCode } : {}) },
      };
    }
  }
  for (let offset = 0; offset < subscriptionIds.length; offset += 4) {
    results.push(...await Promise.all(subscriptionIds.slice(offset, offset + 4).map(readOne)));
  }
  return { complete: results.every((row) => row.ok), results };
}

export function parseWebhookOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const origin = z.string().url().parse(value);
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new Error('Webhook destination must be a canonical HTTPS origin.');
  }
  return origin;
}
