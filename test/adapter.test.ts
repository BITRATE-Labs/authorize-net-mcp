import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, ClientError } from '../src/client.js';
import { getOperation, operations } from '../src/catalog.js';

// Dummy credentials establish wire behavior only. No provider connection is made.
const auth = { name: 'fixture-login', transactionKey: 'fixture-key' };
const ok = (extra: Record<string, unknown> = {}) => ({ messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'secret-free-text' }] }, ...extra });
function mockClient(responses: unknown[] = [ok()], options: { allowWrites?: boolean; webhookOrigin?: string; signal?: AbortSignal } = {}) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  };
  return { client: createClient({ environment: 'sandbox', apiLoginId: auth.name, transactionKey: auth.transactionKey, fetch, ...options }), calls };
}
function errorCode(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ClientError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes('fixture-key'));
    assert.ok(!error.message.includes('secret-free-text'));
    return true;
  };
}

test('authentication uses the exact sandbox JSON endpoint and ordered sealed envelope', async () => {
  const { client, calls } = mockClient();
  await client.authenticate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://apitest.authorize.net/xml/v1/request.api');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.equal(calls[0]!.init.body, JSON.stringify({ authenticateTestRequest: { merchantAuthentication: auth } }));
});

test('exact transaction read preserves string IDs and omits incidental PII and instrument data', async () => {
  const transId = '99999999999999999999';
  const { client, calls } = mockClient([ok({ transaction: {
    transId, transactionStatus: 'settledSuccessfully', settleAmount: '10.01', customer: { email: 'private@example.test' },
    payment: { creditCard: { cardNumber: 'XXXX1111' } }, billTo: { firstName: 'private' }, authCode: 'private',
  } })]);
  const result = await client.execute(getOperation('get_transaction'), { transId });
  assert.deepEqual(calls[0]!.body, { getTransactionDetailsRequest: { merchantAuthentication: auth, transId } });
  assert.deepEqual(result.transaction, { transId, transactionStatus: 'settledSuccessfully', settleAmount: '10.01' });
  assert.deepEqual(result.currency, { code: null, source: 'Not supplied by this reporting response' });
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('Webhooks reads use exact Basic auth and strip notification payloads', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const { client, calls } = mockClient([{ notificationId: id, deliveryStatus: 'Delivered', payload: { email: 'private' } }]);
  const result = await client.execute(getOperation('webhook_get_notification'), { notificationId: id });
  assert.equal(calls[0]!.url, `https://apitest.authorize.net/rest/v1/notifications/${id}`);
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), `Basic ${btoa('fixture-login:fixture-key')}`);
  assert.equal(calls[0]!.body, undefined);
  assert.deepEqual(result, { notificationId: id, deliveryStatus: 'Delivered' });
});

test('Webhooks array responses remain readable after projection', async () => {
  const { client } = mockClient([[{ name: 'net.authorize.payment.authcapture.created', description: 'private' }]]);
  const result = await client.execute(getOperation('webhook_list_event_types'), {});
  assert.deepEqual(result, { items: [{ name: 'net.authorize.payment.authcapture.created' }] });
});

test('all mounted operations reject unknown arguments before network dispatch', async () => {
  for (const op of operations.filter(op => op.status === 'available')) {
    const { client, calls } = mockClient([], { allowWrites: true });
    await assert.rejects(client.execute(op, { arbitraryUrl: 'https://attacker.invalid', merchantAuthentication: auth }), errorCode('invalid_input'));
    assert.equal(calls.length, 0, op.id);
  }
});

test('write capability is required independently of sandbox environment', async () => {
  const { client, calls } = mockClient();
  await assert.rejects(client.execute(getOperation('charge_profile'), { amount: '10.00', customerProfileId: '12', customerPaymentProfileId: '34' }), errorCode('write_disabled'));
  assert.equal(calls.length, 0);
});

test('saved profile charge has a precise amount and correct transaction envelope', async () => {
  const { client, calls } = mockClient([ok({ transactionResponse: { responseCode: '1', transId: '77', authCode: 'private' } })], { allowWrites: true });
  const result = await client.execute(getOperation('charge_profile'), { amount: '10.01', customerProfileId: '12', customerPaymentProfileId: '34' });
  assert.deepEqual(calls[0]!.body, { createTransactionRequest: { merchantAuthentication: auth, transactionRequest: {
    transactionType: 'authCaptureTransaction', amount: '10.01', profile: { customerProfileId: '12', paymentProfile: { paymentProfileId: '34' } },
  } } });
  assert.deepEqual(result, { transactionResponse: { responseCode: '1', transId: '77' } });
});

test('held and declined transaction outcomes are preserved even when gateway result is Error', async () => {
  for (const responseCode of ['2', '4']) {
    const { client } = mockClient([{ messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'secret-free-text' }] }, transactionResponse: { responseCode, transId: '77' } }], { allowWrites: true });
    assert.deepEqual(await client.execute(getOperation('charge_profile'), { amount: '1.00', customerProfileId: '12', customerPaymentProfileId: '34' }), { transactionResponse: { responseCode, transId: '77' } });
  }
});

test('capture re-reads eligibility and refuses a drifted state before transmission', async () => {
  const { client, calls } = mockClient([ok({ transaction: { transId: '77', transactionStatus: 'voided', authAmount: '10.00' } })], { allowWrites: true });
  await assert.rejects(client.execute(getOperation('capture_previous'), { transactionId: '77', amount: '10.00' }), errorCode('invalid_input'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.body?.getTransactionDetailsRequest);
});

test('settlement filtering excludes midnight end boundary and reports missing timestamp evidence', async () => {
  const { client } = mockClient([ok({ batchList: [
    { batchId: '1', settlementTimeUTC: '2026-11-18T00:00:00Z' },
    { batchId: '2', settlementTimeUTC: '2026-11-19T00:00:00Z' }, { batchId: '3' },
  ] })]);
  const result = await client.execute(getOperation('list_settled_batches'), { firstSettlementDate: '2026-11-18T00:00:00Z', lastSettlementDate: '2026-11-19T00:00:00Z' });
  assert.deepEqual(result.batchList, [{ batchId: '1', settlementTimeUTC: '2026-11-18T00:00:00Z' }]);
  assert.equal((result.coverage as { timestampMissingCount: number }).timestampMissingCount, 1);
});

test('paging rejects an unbounded page before a provider call', async () => {
  const { client, calls } = mockClient();
  await assert.rejects(client.execute(getOperation('list_batch_transactions'), { batchId: '12', paging: { limit: 1001, offset: 1 } }), errorCode('invalid_input'));
  assert.equal(calls.length, 0);
});

test('transport failure and malformed write result require reconciliation and never retry', async () => {
  for (const response of [new Error('fixture-key secret-free-text'), new Response('<unexpected>', { status: 200 }), new Response('bad', { status: 503 })]) {
    const { client, calls } = mockClient([response], { allowWrites: true });
    await assert.rejects(client.execute(getOperation('charge_profile'), { amount: '1.00', customerProfileId: '12', customerPaymentProfileId: '34' }), errorCode('completion_unknown'));
    assert.equal(calls.length, 1);
  }
});

test('credential and business rejection expose only sanitized codes', async () => {
  for (const [code, expected] of [['E00007', 'credentials_rejected'], ['E00027', 'provider_rejected']]) {
    const { client } = mockClient([{ messages: { resultCode: 'Error', message: [{ code, text: 'fixture-key secret-free-text' }] } }]);
    await assert.rejects(client.authenticate(), errorCode(expected!));
  }
});

test('aborted invocation is never dispatched', async () => {
  const { client, calls } = mockClient([], { signal: AbortSignal.abort() });
  await assert.rejects(client.authenticate(), errorCode('provider_unavailable'));
  assert.equal(calls.length, 0);
});

test('webhook creation requires a previously approved exact destination origin', async () => {
  const { client, calls } = mockClient([], { allowWrites: true, webhookOrigin: 'https://merchant.example' });
  await assert.rejects(client.execute(getOperation('webhook_create'), { url: 'https://attacker.invalid/hook', status: 'inactive', eventTypes: ['net.authorize.payment.authcapture.created'] }), errorCode('invalid_input'));
  assert.equal(calls.length, 0);
});



test('read failures and oversized provider responses remain bounded and sanitized', async () => {
  for (const [response, expected] of [
    [new Error('fixture-key secret-free-text'), 'provider_unavailable'],
    [new Response('<unexpected>', { status: 200 }), 'invalid_response'],
    [new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'invalid_response'],
  ] as const) {
    const { client, calls } = mockClient([response]);
    await assert.rejects(client.authenticate(), errorCode(expected));
    assert.equal(calls.length, 1);
  }
});

test('parallel reads retain their own provider references', async () => {
  const calls: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const envelope = JSON.parse(String(init?.body)) as { getTransactionDetailsRequest: { transId: string } };
    calls.push(envelope);
    return Response.json(ok({ transaction: { transId: envelope.getTransactionDetailsRequest.transId } }));
  };
  const client = createClient({ environment: 'sandbox', apiLoginId: auth.name, transactionKey: auth.transactionKey, fetch });
  const results = await Promise.all(['11', '22'].map(transId => client.execute(getOperation('get_transaction'), { transId })));
  assert.deepEqual(results.map(result => result.transaction), [{ transId: '11' }, { transId: '22' }]);
  assert.equal(calls.length, 2);
});


test('gateway and ARB response envelopes are unwrapped before projection', async () => {
  const transaction = mockClient([{ getTransactionDetailsResponse: ok({ transaction: { transId: '77', settleAmount: '1.20' } }) }]);
  assert.deepEqual((await transaction.client.execute(getOperation('get_transaction'), { transId: '77' })).transaction, { transId: '77', settleAmount: '1.20' });
  const subscription = mockClient([{ ARBGetSubscriptionResponse: ok({ subscription: { status: 'active', amount: '12.50' } }) }]);
  assert.deepEqual(await subscription.client.execute(getOperation('get_subscription'), { subscriptionId: '12' }), { subscription: { status: 'active', amount: '12.50' } });
});

test('raw response numeric IDs and decimal amounts preserve original JSON lexemes', async () => {
  const raw = '{"messages":{"resultCode":"Ok"},"transaction":{"transId":99999999999999999999,"settleAmount":123456789012345.67,"authAmount":1.00}}';
  const { client } = mockClient([new Response(raw, { headers: { 'Content-Type': 'application/json' } })]);
  assert.deepEqual((await client.execute(getOperation('get_transaction'), { transId: '99999999999999999999' })).transaction, {
    transId: '99999999999999999999', settleAmount: '123456789012345.67', authAmount: '1.00',
  });
});

test('test-mode rejection is distinguished from invalid merchant credentials', async () => {
  const { client } = mockClient([{ messages: { resultCode: 'Error', message: [{ code: 'E00009', text: 'secret-free-text' }] } }]);
  await assert.rejects(client.authenticate(), errorCode('provider_rejected'));
});

test('processing errors and acknowledgments without a transaction outcome remain uncertain', async () => {
  for (const response of [
    { messages: { resultCode: 'Error', message: [{ code: 'E00001', text: 'secret-free-text' }] } },
    ok(), ok({ transactionResponse: { responseCode: '1', transId: '0' } }),
  ]) {
    const { client, calls } = mockClient([response], { allowWrites: true });
    await assert.rejects(client.execute(getOperation('charge_profile'), { amount: '1.00', customerProfileId: '12', customerPaymentProfileId: '34' }), errorCode('completion_unknown'));
    assert.equal(calls.length, 1);
  }
});

test('redirects are returned without following or resubmitting a write', async () => {
  const { client, calls } = mockClient([new Response(null, { status: 307, headers: { Location: 'https://attacker.invalid' } })], { allowWrites: true });
  await assert.rejects(client.execute(getOperation('charge_profile'), { amount: '1.00', customerProfileId: '12', customerPaymentProfileId: '34' }), errorCode('completion_unknown'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.redirect, 'manual');
});
