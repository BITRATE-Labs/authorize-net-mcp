import assert from 'node:assert/strict';
import test from 'node:test';
import { webhooks } from '../src/operations/webhooks.js';
import type { BuildContext } from '../src/operation.js';

const webhookId = '72a55c78-66e6-4b1e-a4d6-3f925c00561f';
const expectedUrl = 'https://merchant.example/webhooks';
const context: BuildContext = {
  webhookOrigin: 'https://merchant.example',
  readWebhook: async () => ({ webhookId, url: expectedUrl, status: 'inactive' }),
  readTransaction: async () => ({}),
  readPaypal: async () => ({}),
  readSubscription: async () => ({}),
  readCustomerProfile: async () => ({}),
};
function operation(id: string) {
  const found = webhooks.find((entry) => entry.id === id);
  assert.ok(found, `Missing operation ${id}`);
  assert.ok(found.status === 'available');
  return found;
}

test('webhook operations have closed inputs and fixed paths', async () => {
  assert.equal(webhooks.length, 9);
  assert.equal(operation('webhook_get').input.safeParse({ webhookId, path: '/other' }).success, false);
  assert.equal(operation('webhook_get').input.safeParse({ webhookId: '../notifications' }).success, false);
  const get = operation('webhook_get');
  assert.deepEqual(await get.build(get.parse({ webhookId }), context), { family: 'rest', method: 'GET', path: `/rest/v1/webhooks/${webhookId}` });
});

test('notification queries require valid bounded dates and pages', () => {
  const input = operation('webhook_list_notifications').input;
  assert.equal(input.safeParse({ from_date: '2026-02-30', to_date: '2026-03-01' }).success, false);
  assert.equal(input.safeParse({ from_date: '2026-01-01', to_date: '2026-03-01' }).success, false);
  assert.equal(input.safeParse({ from_date: '2026-11-01', to_date: '2026-11-02', limit: 101 }).success, false);
});

test('webhook writes bind to approved destination and current state', async () => {
  const create = operation('webhook_create');
  assert.equal(create.input.safeParse({ url: 'bad', eventTypes: ['net.authorize.payment.void.created'], status: 'inactive' }).success, false);
  assert.equal(create.input.safeParse({ url: `${expectedUrl}?secret=1`, eventTypes: ['net.authorize.payment.void.created'], status: 'inactive' }).success, false);
  const createArgs = create.input.parse({ url: 'https://other.example/hook', eventTypes: ['net.authorize.payment.void.created'], status: 'inactive' });
  await assert.rejects(() => create.build(createArgs, context), /connection-approved/);
  const ping = operation('webhook_ping');
  const args = ping.input.parse({ webhookId, expectedUrl });
  await assert.rejects(async () => ping.build(args, { ...context, readWebhook: async () => ({ webhookId: 'other', url: expectedUrl, status: 'inactive' }) }), /identity changed/);
  await assert.rejects(async () => ping.build(args, { ...context, readWebhook: async () => ({ webhookId, url: 'https://merchant.example/changed', status: 'inactive' }) }), /destination changed/);
  await assert.rejects(async () => ping.build(args, { ...context, readWebhook: async () => ({ webhookId, url: expectedUrl, status: 'active' }) }), /inactive/);
  assert.deepEqual(await ping.build(args, context), { family: 'rest', method: 'POST', path: `/rest/v1/webhooks/${webhookId}/pings` });
  const update = operation('webhook_update');
  assert.deepEqual(await update.build(update.parse({ webhookId, expectedUrl, status: 'active' }), context), {
    family: 'rest', method: 'PUT', path: `/rest/v1/webhooks/${webhookId}`, body: { status: 'active' },
  });
});

test('response projections omit notification payloads and sanitize destination URLs', () => {
  const output = operation('webhook_get_notification').project({
    notificationId: webhookId,
    payload: { accountNumber: 'secret' },
    retryLog: { logs: [{ statusCode: 404, message: 'sensitive destination' }] },
  }, {});
  assert.deepEqual(output, { notificationId: webhookId, retryLog: { logs: [{ statusCode: 404 }] } });
  assert.deepEqual(operation('webhook_get').project({
    webhookId, name: 'private free text', url: 'https://username:password@merchant.example/webhooks?secret=1#fragment',
  }, {}), { webhookId, url: expectedUrl });
});
