import { z } from 'zod';
import { PreflightError, rest, type Operation } from '../operation.js';

const id = z.string().uuid();
const eventType = z.string().regex(/^net\.authorize\.[A-Za-z.]+$/).max(160);
const eventTypes = z.array(eventType).min(1).max(100).refine((items) => new Set(items).size === items.length, 'Duplicate event types');
const status = z.enum(['active', 'inactive']);
const url = z.string().url().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && !/\s/.test(value);
  } catch {
    return false;
  }
}, 'Use an HTTPS destination without credentials, query, or fragment').transform((value) => new URL(value).href);
const name = z.string().min(1).max(255);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const webhookOutput = {
  webhookId: true, eventTypes: [true], status: true,
  url: (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    try {
      const destination = new URL(value);
      if (destination.protocol !== 'https:') return undefined;
      destination.username = '';
      destination.password = '';
      destination.search = '';
      destination.hash = '';
      return destination.href;
    } catch {
      return undefined;
    }
  },
} as const;
const notificationOutput = { notificationId: true, deliveryStatus: true, eventType: true, eventDate: true, webhookId: true } as const;

function checkDestination(destination: string, approvedOrigin?: string): void {
  if (!approvedOrigin) throw new PreflightError('No webhook destination origin is configured on this merchant connection. Configure its approved HTTPS origin before submitting a webhook write.');
  if (new URL(destination).origin !== approvedOrigin) throw new PreflightError('Webhook destination does not match the connection-approved HTTPS origin. No webhook write was submitted.');
}

async function currentWebhook(
  args: { webhookId: string; expectedUrl: string },
  ctx: { webhookOrigin?: string; readWebhook(id: string): Promise<Record<string, unknown>> },
): Promise<Record<string, unknown>> {
  checkDestination(args.expectedUrl, ctx.webhookOrigin);
  const current = await ctx.readWebhook(args.webhookId);
  if (current.webhookId !== args.webhookId) throw new PreflightError('Webhook identity changed; inspect the exact webhook again. No webhook write was submitted.');
  if (current.url !== args.expectedUrl) throw new PreflightError('Webhook destination changed; prepare a new approval. No webhook write was submitted.');
  return current;
}

export const webhooks: readonly Operation[] = [
  rest({
    id: 'webhook_list_event_types', title: 'List webhook event types', kind: 'read', method: 'GET', route: '/rest/v1/eventtypes',
    input: z.strictObject({}), build: () => ({ path: '/rest/v1/eventtypes' }), output: { items: [{ name: true }] },
  }),
  rest({
    id: 'webhook_list', title: 'List webhooks', kind: 'read', method: 'GET', route: '/rest/v1/webhooks',
    input: z.strictObject({}), build: () => ({ path: '/rest/v1/webhooks' }), output: { items: [webhookOutput] },
  }),
  rest({
    id: 'webhook_get', title: 'Get webhook', kind: 'read', method: 'GET', route: '/rest/v1/webhooks/{id}',
    input: z.strictObject({ webhookId: id }),
    build: (args) => ({ path: `/rest/v1/webhooks/${args.webhookId}` }), output: webhookOutput,
  }),
  rest({
    id: 'webhook_create', title: 'Create webhook', kind: 'write', method: 'POST', route: '/rest/v1/webhooks',
    input: z.strictObject({ name: name.optional(), url, eventTypes, status }),
    build: (args, ctx) => {
      checkDestination(args.url, ctx.webhookOrigin);
      return { path: '/rest/v1/webhooks', body: args };
    }, output: webhookOutput,
  }),
  rest({
    id: 'webhook_update', title: 'Update webhook', kind: 'write', method: 'PUT', route: '/rest/v1/webhooks/{id}',
    input: z.strictObject({ webhookId: id, expectedUrl: url, name: name.optional(), url: url.optional(), eventTypes: eventTypes.optional(), status: status.optional() })
      .refine((args) => args.name !== undefined || args.url !== undefined || args.eventTypes !== undefined || args.status !== undefined, 'Specify at least one change'),
    build: async (args, ctx) => {
      await currentWebhook(args, ctx);
      if (args.url !== undefined) checkDestination(args.url, ctx.webhookOrigin);
      const { webhookId, expectedUrl: _expectedUrl, ...body } = args;
      return { path: `/rest/v1/webhooks/${webhookId}`, body };
    }, output: webhookOutput,
  }),
  rest({
    id: 'webhook_delete', title: 'Delete webhook', kind: 'write', method: 'DELETE', route: '/rest/v1/webhooks/{id}',
    input: z.strictObject({ webhookId: id, expectedUrl: url }),
    build: async (args, ctx) => {
      await currentWebhook(args, ctx);
      return { path: `/rest/v1/webhooks/${args.webhookId}` };
    }, output: {},
  }),
  rest({
    id: 'webhook_ping', title: 'Send webhook test notification', kind: 'write', method: 'POST', route: '/rest/v1/webhooks/{id}/pings',
    input: z.strictObject({ webhookId: id, expectedUrl: url }),
    build: async (args, ctx) => {
      const current = await currentWebhook(args, ctx);
      if (current.status !== 'inactive') throw new PreflightError('Test notifications require an inactive webhook. No webhook write was submitted.');
      return { path: `/rest/v1/webhooks/${args.webhookId}/pings` };
    }, output: {},
  }),
  rest({
    id: 'webhook_list_notifications', title: 'List webhook notification history', kind: 'read', method: 'GET', route: '/rest/v1/notifications',
    input: z.strictObject({ from_date: date, to_date: date, offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(100), deliveryStatus: z.enum(['Delivered', 'Failed']).optional() })
      .refine((args) => args.from_date <= args.to_date && Date.parse(args.to_date) - Date.parse(args.from_date) <= 31 * 86400000, 'Use an ordered date range of at most 31 days'),
    build: (args) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) if (value !== undefined) query.set(key, String(value));
      return { path: `/rest/v1/notifications?${query.toString()}` };
    }, output: { notifications: [notificationOutput] },
  }),
  rest({
    id: 'webhook_get_notification', title: 'Get webhook notification history', kind: 'read', method: 'GET', route: '/rest/v1/notifications/{id}',
    input: z.strictObject({ notificationId: id }),
    build: (args) => ({ path: `/rest/v1/notifications/${args.notificationId}` }),
    output: { ...notificationOutput, retryLog: { logs: [{ statusCode: true, retryStage: true, retryCountInStage: true, retryDate: true }] } },
  }),
];
