import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/client.js';
import { parseDescribeInput, parseDispatchInput, parseListInput, parseWebhookOrigin, readSubscriptionSchedules } from '../src/executor.js';

test('dispatcher rejects cross-effect operations and unknown envelope fields', () => {
  assert.throws(() => parseDispatchInput({ operation: 'authenticate_test', args: {} }, 'write'));
  assert.throws(() => parseDispatchInput({ operation: 'authenticate_test', args: {}, allowWrites: true }, 'read'));
  assert.throws(() => parseDispatchInput({ operation: 'authenticate_test', args: { apiLoginId: 'secret' } }, 'read'));
  assert.throws(() => parseDispatchInput({ operation: 'not_an_operation', args: {} }, 'read'));
  assert.deepEqual(parseDispatchInput({ operation: 'authenticate_test', args: {} }, 'read'), {
    operation: 'authenticate_test', args: {},
  });
});

test('catalog inputs reject undeclared arguments', () => {
  assert.throws(() => parseListInput({ environment: 'production' }));
  assert.throws(() => parseDescribeInput({ operation: 'authenticate_test', raw: true }));
});

test('webhook configuration accepts only an exact HTTPS origin', () => {
  assert.equal(parseWebhookOrigin(undefined), undefined);
  assert.equal(parseWebhookOrigin('https://hooks.example.com'), 'https://hooks.example.com');
  for (const value of [
    'http://hooks.example.com', 'https://hooks.example.com/', 'https://hooks.example.com/path',
    'https://hooks.example.com?secret=x', 'https://hooks.example.com#x',
    'https://user:password@hooks.example.com', 'https://HOOKS.example.com',
  ]) assert.throws(() => parseWebhookOrigin(value));
});

test('schedule reads preserve order, return gateway codes per ID and omit profiles', async () => {
  const subscription = { status: 'active', amount: '104.99',
    paymentSchedule: { interval: { length: 12, unit: 'months' }, totalOccurrences: 9999 } };
  const input = { subscriptionIds: ['1', '2', '3'] };
  const value = await readSubscriptionSchedules(input, async (id) => {
    if (id === '2') throw new ClientError('provider_rejected', 'Authorize.net rejected this request.', 'E00013');
    if (id === '3') return { subscription: { status: 'active' } };
    return { subscription: { ...subscription, profile: { customerProfileId: 'private' } } };
  });
  assert.deepEqual(value, { complete: false, results: [
    { subscriptionId: '1', ok: true, subscription },
    { subscriptionId: '2', ok: false, error: {
      code: 'provider_rejected', message: 'Authorize.net rejected this request. [E00013]', providerCode: 'E00013',
    } },
    { subscriptionId: '3', ok: false, error: {
      code: 'invalid_response', message: 'Authorize.net did not return a usable subscription schedule.',
    } },
  ] });
});

test('schedule reads reject duplicates and oversized input before any request', async () => {
  let count = 0;
  const read = async () => { count += 1; return {}; };
  await assert.rejects(readSubscriptionSchedules({ subscriptionIds: ['12', '12'] }, read));
  await assert.rejects(readSubscriptionSchedules({ subscriptionIds: Array(21).fill('1') }, read));
  assert.equal(count, 0);
});
