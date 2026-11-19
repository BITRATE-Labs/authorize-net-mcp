import assert from 'node:assert/strict';
import test from 'node:test';
import { reporting } from '../src/operations/reporting.js';
import type { BuildContext } from '../src/operation.js';

function operation(id: string) {
  const found = reporting.find((entry) => entry.id === id);
  assert.ok(found?.status === 'available', `Missing available operation ${id}`);
  return found;
}
const context: BuildContext = {
  readTransaction: async () => ({}), readPaypal: async () => ({}), readSubscription: async () => ({}),
  readCustomerProfile: async () => ({}), readWebhook: async () => ({}),
};

test('reporting inputs close nested fields and build independent expected held-list request', async () => {
  const held = operation('list_unsettled_transactions');
  assert.throws(() => held.parse({ status: 'pendingApproval', merchantAuthentication: {} }));
  assert.throws(() => held.parse({ paging: { limit: 1001 } }));
  assert.throws(() => held.parse({ sorting: { orderBy: 'submitTimeUTC', injected: true } }));
  assert.deepEqual(await held.build(held.parse({ status: 'pendingApproval' }), context), {
    family: 'gateway', name: 'getUnsettledTransactionListRequest',
    body: { status: 'pendingApproval', sorting: { orderBy: 'submitTimeUTC', orderDescending: true }, paging: { limit: 100, offset: 1 } },
  });
});

test('settlement intervals filter midnight expansion using exact timestamps', () => {
  const op = operation('list_settled_batches');
  const args = op.parse({ firstSettlementDate: '2026-11-01T00:00:00Z', lastSettlementDate: '2026-11-02T00:00:00Z' });
  assert.throws(() => op.parse({ firstSettlementDate: '2026-11-02T00:00:00Z', lastSettlementDate: '2026-11-01T00:00:00Z' }));
  assert.throws(() => op.parse({ firstSettlementDate: '2026-09-01T00:00:00Z', lastSettlementDate: '2026-11-01T00:00:00Z' }));
  const result = op.project({ batchList: [
    { batchId: '1', settlementTimeUTC: '2026-11-01T00:00:00' },
    { batchId: '2', settlementTimeUTC: '2026-11-02T00:00:00Z' },
    { batchId: '3' },
    { batchId: '4', settlementTimeUTC: 'invalid' },
  ] }, args);
  assert.deepEqual(result.batchList, [{ batchId: '1', settlementTimeUTC: '2026-11-01T00:00:00' }]);
  assert.equal((result.coverage as Record<string, unknown>).timestampMissingCount, 2);
});

test('merchant and transaction projections omit credentials, instruments and incidental PII', () => {
  const merchant = operation('get_merchant_details');
  assert.deepEqual(merchant.project({ isTestMode: true, publicClientKey: 'secret', merchantName: 'private', businessInformation: { email: 'private' } }, merchant.parse({})), { isTestMode: true });
  const tx = operation('get_transaction');
  const result = tx.project({ transaction: { transId: '123', authAmount: '1.2300', payment: { creditCard: { cardNumber: 'XXXX1111' } }, customer: { email: 'private' }, authCode: 'private', responseReasonDescription: 'private' } }, tx.parse({ transId: '123' }));
  assert.deepEqual(result.transaction, { transId: '123', authAmount: '1.2300' });
  assert.deepEqual(result.currency, { code: null, source: 'Not supplied by this reporting response' });
});

test('Account Updater normalizes documented singleton and repeated changes without instruments', () => {
  const op = operation('get_account_updater_details');
  const safe = { customerProfileID: '2', customerPaymentProfileID: '3', updateTimeUTC: '2026-11-01T00:00:00Z', auReasonCode: 'ACL' };
  const result = op.project({ auDetails: { auDelete: { ...safe, customerProfileID: 2, firstName: 'private', creditCard: { cardNumber: 'XXXX1111' } }, auUpdate: [{ ...safe, oldCreditCard: { cardNumber: 'XXXX1111' } }] } }, op.parse({ month: '2026-11' }));
  assert.deepEqual(result.auDetails, { auDelete: [safe], auUpdate: [safe] });
  assert.throws(() => op.parse({ month: '2026-13' }));
});

test('all 28 owned request envelopes have one disposition and hosted tokens remain unavailable', () => {
  assert.equal(reporting.length, 28);
  assert.equal(new Set(reporting.map((entry) => entry.request)).size, 28);
  for (const request of ['getHostedPaymentPageRequest', 'getHostedProfilePageRequest', 'getCustomerPaymentProfileNonceRequest', 'decryptPaymentDataRequest']) {
    assert.equal(reporting.find((entry) => entry.request === request)?.status, 'unavailable');
  }
});
