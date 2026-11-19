import test from 'node:test';
import assert from 'node:assert/strict';
import { transactions } from '../src/operations/transactions.js';
import type { BuildContext } from '../src/operation.js';

function operation(id: string) {
  const found = transactions.find(operation => operation.id === id);
  assert.ok(found, `Missing operation ${id}`);
  assert.equal(found.status, 'available');
  if (found.status !== 'available') throw new Error('Operation unavailable');
  return {
    input: { parse: (input: unknown) => found.input.parse(input) as Record<string, unknown> },
    build: async (input: unknown, ctx: BuildContext) => {
      const wire = await found.build(input, ctx);
      assert.equal(wire.family, 'gateway');
      if (wire.family !== 'gateway') throw new Error('Unexpected transport');
      return wire.body;
    },
  };
}
const context = (record: Record<string, unknown>, paypal: Record<string, unknown> = {}): BuildContext => ({
  readTransaction: async () => record,
  readPaypal: async () => paypal,
  readSubscription: async () => { throw new Error('Unexpected subscription read'); },
  readCustomerProfile: async () => { throw new Error('Unexpected customer read'); },
  readWebhook: async () => { throw new Error('Unexpected webhook read'); },
});

test('saved profile charge uses exact provider field names and rejects raw instrument arguments', async () => {
  const op = operation('charge_profile');
  const args = op.input.parse({ amount: '15.25', customerProfileId: '12', customerPaymentProfileId: '34' });
  assert.deepEqual(await op.build!(args, context({})), {
    transactionRequest: {
      transactionType: 'authCaptureTransaction', amount: '15.25',
      profile: { customerProfileId: '12', paymentProfile: { paymentProfileId: '34' } },
    },
  });
  assert.throws(() => op.input.parse({ ...args, cardNumber: '4111111111111111' }));
  assert.throws(() => op.input.parse({ ...args, amount: 15.25 }));
  assert.throws(() => op.input.parse({ ...args, amount: '0.00' }));
});

test('card refund derives last four only from an exact trusted settled transaction', async () => {
  const op = operation('refund_transaction');
  const args = op.input.parse({ transactionId: '123', amount: '4.25' });
  const original = { transId: '123', transactionType: 'authCaptureTransaction', transactionStatus: 'settledSuccessfully', settleAmount: '10.00', payment: { creditCard: { cardNumber: 'XXXX0015' } } };
  assert.deepEqual(await op.build!(args, context(original)), {
    transactionRequest: { transactionType: 'refundTransaction', amount: '4.25', payment: { creditCard: { cardNumber: '0015', expirationDate: 'XXXX' } }, refTransId: '123' },
  });
  await assert.rejects(() => op.build!(args, context({ ...original, transId: '999' })));
  await assert.rejects(() => op.build!(args, context({ ...original, transactionStatus: 'capturedPendingSettlement' })));
  await assert.rejects(() => op.build!({ ...args, amount: '10.01' }, context(original)));
  await assert.rejects(() => op.build!(args, context({ ...original, payment: { creditCard: { cardNumber: '4111111111111111' } } })));
});

test('prior capture revalidates authorization and compares precise cents', async () => {
  const op = operation('capture_previous');
  const args = op.input.parse({ transactionId: '123', amount: '0.30' });
  const original = { transId: '123', transactionStatus: 'authorizedPendingCapture', authAmount: '0.30', payment: { creditCard: { cardNumber: 'XXXX0015' } } };
  assert.deepEqual(await op.build!(args, context(original)), { transactionRequest: { transactionType: 'priorAuthCaptureTransaction', amount: '0.30', refTransId: '123' } });
  await assert.rejects(() => op.build!({ ...args, amount: '0.31' }, context(original)));
});

test('PayPal continuation uses original gateway transaction reference and payerID', async () => {
  const op = operation('paypal_authorize_continue');
  const args = op.input.parse({ transactionId: '123', payerId: 'BUYER123' });
  assert.deepEqual(await op.build!(args, context({ transId: '123', transactionType: 'authOnlyTransaction' }, { transId: '123', accountType: 'PayPal', responseCode: '1', secureAcceptance: { PayerID: 'BUYER123' } })), { transactionRequest: { transactionType: 'authOnlyContinueTransaction', payment: { payPal: { payerID: 'BUYER123' } }, refTransId: '123' } });
  assert.throws(() => op.input.parse({ ...args, token: 'EC-example' }));
});

test('split tender and fraud commands cannot override their fixed action', async () => {
  const complete = operation('complete_split_tender');
  assert.deepEqual(await complete.build!(complete.input.parse({ splitTenderId: '42' }), context({})), { splitTenderId: '42', splitTenderStatus: 'completed' });
  assert.throws(() => complete.input.parse({ splitTenderId: '42', splitTenderStatus: 'voided' }));
  const approve = operation('approve_held_transaction');
  assert.deepEqual(await approve.build!(approve.input.parse({ transactionId: '123' }), context({ transId: '123', transactionStatus: 'FDSPendingReview' })), { heldTransactionRequest: { action: 'approve', refTransId: '123' } });
  await assert.rejects(() => approve.build!({ transactionId: '123' }, context({ transId: '123', transactionStatus: 'settledSuccessfully' })));
});


test('transaction projections omit instrument data, buyer details and approval bearer URLs', () => {
  const op = transactions.find(operation => operation.id === 'paypal_get_details');
  assert.ok(op?.status === 'available');
  assert.deepEqual(op.project({ transactionResponse: {
    transId: '123', responseCode: '1', accountNumber: 'XXXX0015', authCode: 'SECRET',
    shipTo: { firstName: 'Private' },
    secureAcceptance: { payerID: 'BUYER123', SecureAcceptanceUrl: 'https://www.paypal.com/?token=secret' },
  } }, {}), { transactionResponse: { transId: '123', responseCode: '1', secureAcceptance: { payerID: 'BUYER123' } } });
});



test('PayPal continuations reject amount overrides and require matching trusted buyer and original action', async () => {
  for (const [id, originalType, wireType] of [
    ['paypal_authorize_continue', 'authOnlyTransaction', 'authOnlyContinueTransaction'],
    ['paypal_capture_continue', 'authCaptureTransaction', 'authCaptureContinueTransaction'],
  ]) {
    const op = operation(id!);
    const args = op.input.parse({ transactionId: '123', payerId: 'BUYER123' });
    assert.throws(() => op.input.parse({ ...args, amount: '99.00' }));
    const original = { transId: '123', transactionType: originalType };
    const paypal = { transId: '123', accountType: 'PayPal', responseCode: '1', secureAcceptance: { payerID: 'BUYER123' } };
    assert.deepEqual(await op.build(args, context(original, paypal)), {
      transactionRequest: { transactionType: wireType, payment: { payPal: { payerID: 'BUYER123' } }, refTransId: '123' },
    });
    for (const evidence of [
      { ...paypal, transId: '999' }, { ...paypal, accountType: 'Visa' },
      { ...paypal, responseCode: '5' }, { ...paypal, secureAcceptance: { PayerID: 'OTHER' } },
    ]) await assert.rejects(() => op.build(args, context(original, evidence)));
    await assert.rejects(() => op.build(args, context({ ...original, transactionType: 'voidTransaction' }, paypal)));
  }
});

test('PayPal capture, void and refund require provider instrument proof and exact method identity', async () => {
  const paypal = { transId: '123', accountType: 'PayPal', responseCode: '1' };
  const authorized = { transId: '123', transactionStatus: 'authorizedPendingCapture', authAmount: '10.00' };
  const settled = { transId: '123', transactionType: 'authCaptureTransaction', transactionStatus: 'settledSuccessfully', settleAmount: '10.00' };
  for (const [id, original, wireType] of [
    ['paypal_capture_previous', authorized, 'priorAuthCaptureTransaction'],
    ['paypal_void', authorized, 'voidTransaction'],
    ['paypal_refund', settled, 'refundTransaction'],
  ] as const) {
    const op = operation(id);
    const args = op.input.parse({ transactionId: '123', ...(id === 'paypal_void' ? {} : { amount: '4.25' }) });
    assert.deepEqual(await op.build(args, context(original, paypal)), {
      transactionRequest: { transactionType: wireType, ...(id === 'paypal_void' ? {} : { amount: '4.25' }), refTransId: '123' },
    });
    await assert.rejects(() => op.build(args, context(original, { ...paypal, accountType: 'Visa' })));
    await assert.rejects(() => op.build(args, context(original, { ...paypal, transId: '999' })));
  }
});

test('generic card capture and void cannot bypass PayPal proof', async () => {
  const original = { transId: '123', transactionStatus: 'authorizedPendingCapture', authAmount: '10.00' };
  for (const id of ['capture_previous', 'void_transaction']) {
    const op = operation(id);
    const args = op.input.parse({ transactionId: '123', ...(id === 'void_transaction' ? {} : { amount: '4.25' }) });
    await assert.rejects(() => op.build(args, context(original)));
    assert.ok(await op.build(args, context({ ...original, payment: { creditCard: { cardNumber: 'XXXX0015' } } })));
  }
});
