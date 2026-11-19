import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { operations, describeOperation, getOperation } from '../src/catalog.js';
import type { BuildContext } from '../src/operation.js';

const inventory = JSON.parse(readFileSync(new URL('./fixtures/provider-inventory.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '')) as {
  sha256: string; requests: string[]; webhooks: { id: string; method: string; path: string }[];
};
const webhookId = '11111111-1111-4111-8111-111111111111';
const context: BuildContext = {
  webhookOrigin: 'https://merchant.example',
  readTransaction: async () => ({}), readPaypal: async () => ({}),
  readSubscription: async () => ({}), readCustomerProfile: async () => ({}),
  readWebhook: async () => ({ webhookId, url: 'https://merchant.example/hook', status: 'inactive' }),
};

test('catalog accounts for the pinned 53 official gateway request envelopes', () => {
  assert.equal(inventory.requests.length, 53);
  assert.equal(inventory.sha256, 'c9c76cdbeba1f030bb453cdeec963457b9f85c6799db9b3888b0ade1a635a1fa');
  const actual = [...new Set(operations.map(op => op.request).filter(name => name.endsWith('Request')))].sort();
  assert.deepEqual(actual, inventory.requests);
  assert.equal(new Set(operations.map(op => op.id)).size, operations.length);
  for (const op of operations) {
    assert.equal(describeOperation(op.id).status, op.status);
    if (op.status === 'unavailable') assert.ok(op.reason.length > 30, op.id);
  }
  assert.throws(() => getOperation('unregistered_operation'));
});

test('all nine Webhooks REST routes match the independent documented method and path inventory', async () => {
  assert.equal(inventory.webhooks.length, 9);
  const args: Record<string, unknown> = {
    webhookId, notificationId: webhookId, expectedUrl: 'https://merchant.example/hook',
    url: 'https://merchant.example/hook', eventTypes: ['net.authorize.payment.authcapture.created'],
    status: 'inactive', from_date: '2026-11-01', to_date: '2026-11-19',
  };
  for (const entry of inventory.webhooks) {
    const op = getOperation(entry.id);
    assert.equal(op.status, 'available');
    if (op.status !== 'available') continue;
    const description = describeOperation(op.id);
    assert.ok('input' in description);
    const schema = description.input as { properties: Record<string, unknown> };
    const input = Object.fromEntries(Object.entries(args).filter(([key]) => key in schema.properties));
    const wire = await op.build(op.parse(input), context);
    assert.equal(wire.family, 'rest');
    if (wire.family !== 'rest') continue;
    assert.equal(wire.method, entry.method, entry.id);
    assert.equal(wire.path.split('?')[0], entry.path.replace('{id}', webhookId), entry.id);
    assert.equal(op.kind, entry.method === 'GET' ? 'read' : 'write', entry.id);
  }
});
