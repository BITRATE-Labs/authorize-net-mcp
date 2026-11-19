import test from 'node:test';
import assert from 'node:assert/strict';
import { accounts } from '../src/operations/accounts.js';
import type { BuildContext } from '../src/operation.js';

function operation(id: string) {
  const found = accounts.find((entry) => entry.id === id);
  assert.ok(found);
  if (found.status !== 'available') throw new Error('Expected executable operation');
  return found;
}
const context: BuildContext = {
  readSubscription: async () => ({ status: 'active' }),
  readCustomerProfile: async () => ({ customerProfileId: '12' }),
  readTransaction: async () => { throw new Error('Unexpected transaction preflight'); },
  readPaypal: async () => { throw new Error('Unexpected PayPal preflight'); },
  readWebhook: async () => { throw new Error('Unexpected webhook preflight'); },
};
const create = {
  subscription: {
    paymentSchedule: { interval: { length: 1, unit: 'months' }, startDate: '2027-01-01', totalOccurrences: 12 },
    amount: '15.25', profile: { customerProfileId: '12', customerPaymentProfileId: '34' },
  },
};

test('ARB page coverage treats zero totals on later pages as unknown', () => {
  const op = operation('list_subscriptions');
  const args = (offset: number) => op.parse({ searchType: 'subscriptionActive', paging: { limit: 2, offset } });
  const first = op.project({ totalNumInResultSet: 5, subscriptionDetails: [{ id: '1' }, { id: '2' }] }, args(1));
  assert.deepEqual(first.coverage, { limit: 2, offset: 1, returnedCount: 2, totalMatching: 5, nextOffset: 2, nextOffsetBasis: 'provider_total' });
  const second = op.project({ totalNumInResultSet: 0, subscriptionDetails: [{ id: '3' }, { id: '4' }] }, args(2));
  assert.equal(second.totalNumInResultSet, 0);
  assert.deepEqual(second.coverage, { limit: 2, offset: 2, returnedCount: 2, totalMatching: null, nextOffset: 3, nextOffsetBasis: 'page_size' });
  const last = op.project({ totalNumInResultSet: 0, subscriptionDetails: [{ id: '5' }] }, args(3));
  assert.deepEqual(last.coverage, { limit: 2, offset: 3, returnedCount: 1, totalMatching: null, nextOffset: null, nextOffsetBasis: 'page_size' });
  assert.deepEqual(op.project({ totalNumInResultSet: 0 }, args(1)).coverage,
    { limit: 2, offset: 1, returnedCount: 0, totalMatching: 0, nextOffset: null, nextOffsetBasis: 'provider_total' });
});

test('ARB creation uses ordered saved-profile request and exact decimal amounts', async () => {
  const op = operation('create_subscription');
  const request = await op.build(op.parse(create), context);
  assert.equal(request.family, 'gateway');
  if (request.family !== 'gateway') throw new Error('Wrong transport');
  assert.equal(JSON.stringify(request.body), '{"subscription":{"paymentSchedule":{"interval":{"length":1,"unit":"months"},"startDate":"2027-01-01","totalOccurrences":12},"amount":"15.25","profile":{"customerProfileId":"12","customerPaymentProfileId":"34"}}}');
  for (const amount of ['0.0001', '0', '-1', '1e2', '1.00001', 15.25]) {
    assert.throws(() => op.parse({ subscription: { ...create.subscription, amount } }));
  }
  for (const amount of ['0.01', '0.0100', '1', '15.2525']) {
    assert.doesNotThrow(() => op.parse({ subscription: { ...create.subscription, amount } }));
  }
  assert.throws(() => op.parse({ subscription: { ...create.subscription, payment: { creditCard: { cardNumber: '4111111111111111' } } } }));
  assert.throws(() => op.parse({ subscription: { ...create.subscription, profile: { ...create.subscription.profile, nonce: 'opaque' } } }));
});

test('ARB schedule rejects invalid dates, intervals and unpaired or excessive trials', () => {
  const op = operation('create_subscription');
  const paymentSchedule = create.subscription.paymentSchedule;
  for (const interval of [{ length: 6, unit: 'days' }, { length: 366, unit: 'days' }, { length: 13, unit: 'months' }]) {
    assert.throws(() => op.parse({ subscription: { ...create.subscription, paymentSchedule: { ...paymentSchedule, interval } } }));
  }
  assert.throws(() => op.parse({ subscription: { ...create.subscription, paymentSchedule: { ...paymentSchedule, startDate: '2027-02-30' } } }));
  assert.throws(() => op.parse({ subscription: { ...create.subscription, trialAmount: '0' } }));
  assert.throws(() => op.parse({ subscription: { ...create.subscription, paymentSchedule: { ...paymentSchedule, trialOccurrences: 2 } } }));
  assert.throws(() => op.parse({ subscription: { ...create.subscription, trialAmount: '0', paymentSchedule: { ...paymentSchedule, trialOccurrences: 12 } } }));
});

test('ARB updates reject schedule editing and re-read current status', async () => {
  const op = operation('update_subscription');
  const args = { subscriptionId: '56', subscription: { amount: '20.0001' } };
  await op.build(op.parse(args), context);
  await assert.rejects(() => op.build(op.parse(args), { ...context, readSubscription: async () => ({ status: 'canceled' }) }));
  assert.throws(() => op.parse({ ...args, subscription: {} }));
  assert.throws(() => op.parse({ ...args, subscription: { paymentSchedule: { startDate: '2027-01-02' } } }));
});

test('CIM and ARB project provider JSON arrays and omit personal or payment fields', () => {
  assert.deepEqual(operation('list_customer_profile_ids').project({ ids: ['12', '34'] }, {}), { ids: ['12', '34'] });
  assert.deepEqual(operation('get_customer_profile').project({ profile: { customerProfileId: '12', email: 'private@example.com', paymentProfiles: [{ customerPaymentProfileId: '34', payment: { creditCard: { cardNumber: 'XXXX1111' } }, billTo: { address: 'Private' } }] } }, {}), {
    profile: { customerProfileId: '12', paymentProfiles: [{ customerPaymentProfileId: '34' }] },
  });
  const list = operation('list_subscriptions');
  const listArgs = list.parse({ searchType: 'subscriptionActive', paging: {} });
  assert.deepEqual(list.project({ totalNumInResultSet: 1, subscriptionDetails: [{ id: '56', status: 'active', firstName: 'Private', amount: '15.25' }] }, listArgs), {
    totalNumInResultSet: 1, subscriptionDetails: [{ id: '56', status: 'active', amount: '15.25' }],
    coverage: { limit: 100, offset: 1, returnedCount: 1, totalMatching: 1, nextOffset: null, nextOffsetBasis: 'provider_total' },
  });
  assert.deepEqual(operation('list_customer_payment_profiles').project({ totalNumInResultSet: 1, paymentProfiles: [{ customerPaymentProfileId: '34', billTo: { address: 'Private' } }] }, {}), {
    totalNumInResultSet: 1, paymentProfiles: [{ customerPaymentProfileId: '34' }],
  });
});

test('CIM validation is a write, has no card-code argument, and lists are bounded', () => {
  const validation = operation('validate_customer_payment_profile');
  assert.equal(validation.kind, 'write');
  const args = { customerProfileId: '12', customerPaymentProfileId: '34', validationMode: 'liveMode' };
  assert.throws(() => validation.parse({ ...args, cardCode: '123' }));
  const list = operation('list_customer_payment_profiles');
  assert.throws(() => list.parse({ month: '2027-13', paging: {} }));
  assert.throws(() => list.parse({ month: '2027-01', paging: { limit: 101 } }));
  assert.throws(() => list.parse({ month: '2027-01', paging: { offset: 0 } }));
  assert.equal(accounts.filter((entry) => entry.request === 'createCustomerPaymentProfileRequest')[0]?.status, 'unavailable');
  assert.equal(accounts.filter((entry) => entry.request === 'updateCustomerPaymentProfileRequest')[0]?.status, 'unavailable');
});
