import { z } from 'zod';
import { getOperation } from './catalog.js';

const emptyInput = z.strictObject({});
const describeInput = z.strictObject({ operation: z.string().min(1).max(128) });
const dispatchInput = z.strictObject({
  operation: z.string().min(1).max(128),
  args: z.unknown(),
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

export function parseWebhookOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const origin = z.string().url().parse(value);
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new Error('Webhook destination must be a canonical HTTPS origin.');
  }
  return origin;
}
