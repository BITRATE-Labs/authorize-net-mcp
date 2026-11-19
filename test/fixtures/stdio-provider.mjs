import assert from 'node:assert/strict';

const ok = { resultCode: 'Ok', message: [{ code: 'I00001' }] };

globalThis.fetch = async (url, options) => {
  const host = process.env.AUTHORIZE_NET_ENVIRONMENT === 'production' ? 'api.authorize.net' : 'apitest.authorize.net';
  assert.equal(url, `https://${host}/xml/v1/request.api`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  const request = JSON.parse(options.body);
  const [name] = Object.keys(request);
  const args = request[name];
  assert.deepEqual(args.merchantAuthentication, { name: 'fixture-login', transactionKey: 'fixture-key' });

  if (name === 'getCustomerProfileRequest' || name === 'deleteCustomerProfileRequest') {
    assert.equal(args.customerProfileId, '1');
    return Response.json({ messages: ok, profile: { customerProfileId: args.customerProfileId } });
  }
  if (name === 'getTransactionDetailsRequest') {
    return Response.json({ messages: ok, transaction: {
      transId: args.transId, transactionStatus: 'settledSuccessfully', settleAmount: '5.99',
      billTo: { email: 'hidden@example.invalid' },
    } });
  }
  assert.equal(name, 'ARBGetSubscriptionRequest');
  if (args.subscriptionId === '2') return Response.json({
    messages: { resultCode: 'Error', message: [{ code: 'E00035', text: 'hidden provider message' }] },
  });
  return Response.json({ messages: ok, subscription: {
    status: 'active', amount: '56.99',
    paymentSchedule: { interval: { unit: 'months', length: 12 }, startDate: '2026-11-19T00:00:00' },
  } });
};
