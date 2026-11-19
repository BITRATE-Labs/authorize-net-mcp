import { z } from 'zod';
import { gateway, unavailable, type Operation } from '../operation.js';

const id = z.string().regex(/^\d{1,20}$/);
const utc = z.string().datetime();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const paging = z.strictObject({
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(1).max(100000).default(1),
}).default({ limit: 100, offset: 1 });
const sorting = z.strictObject({
  orderBy: z.enum(['id', 'submitTimeUTC']).default('submitTimeUTC'),
  orderDescending: z.boolean().default(true),
}).default({ orderBy: 'submitTimeUTC', orderDescending: true });
const subscription = { id: true, payNum: true } as const;
const profile = { customerProfileId: true, customerPaymentProfileId: true } as const;
const transaction = {
  transId: true, submitTimeUTC: true, transactionStatus: true, settleAmount: true,
  subscription, profile, hasReturnedItems: true,
} as const;
const statistics = {
  accountType: true, chargeAmount: true, chargeCount: true, refundAmount: true,
  refundCount: true, voidCount: true, declineCount: true, errorCount: true,
  returnedItemAmount: true, returnedItemCount: true, chargebackAmount: true,
  chargebackCount: true, correctionNoticeCount: true, chargeChargeBackAmount: true,
  chargeChargeBackCount: true, refundChargeBackAmount: true, refundChargeBackCount: true,
  chargeReturnedItemsAmount: true, chargeReturnedItemsCount: true,
  refundReturnedItemsAmount: true, refundReturnedItemsCount: true,
} as const;
const batch = {
  batchId: true, settlementTimeUTC: true, settlementState: true,
  paymentMethod: true, statistics: [statistics],
} as const;
const listOutput = { transactions: [transaction], totalNumInResultSet: true } as const;
const auDetail = z.object({
  customerProfileID: z.union([id, z.number().int().safe().nonnegative()]).transform(String),
  customerPaymentProfileID: z.union([id, z.number().int().safe().nonnegative()]).transform(String),
  updateTimeUTC: z.string().max(100),
  auReasonCode: z.string().max(20),
});
const auRecords = z.union([z.array(auDetail).max(1000), auDetail]).nullish()
  .transform((value) => Array.isArray(value) ? value : value == null ? [] : [value]);
const auDetails = z.union([
  z.object({ auDelete: auRecords, auUpdate: auRecords }),
  z.tuple([]).transform(() => ({ auDelete: [], auUpdate: [] })),
]).nullish().transform((value) => value ?? { auDelete: [], auUpdate: [] });

function settlementInstant(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  // Authorize.net labels this field UTC but can omit the zone suffix.
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value}Z` : value;
  return z.string().datetime().safeParse(normalized).success ? Date.parse(normalized) : NaN;
}
function pageCoverage(result: Record<string, unknown>, args: { paging: { limit: number; offset: number } }): Record<string, unknown> {
  return {
    ...result,
    coverage: { limit: args.paging.limit, offset: args.paging.offset, scope: 'One provider page; other pages and later refunds are not included' },
    currency: { code: null, source: 'Not supplied by this reporting response' },
  };
}

export const reporting: readonly Operation[] = [
  gateway({
    id: 'authenticate_test', title: 'Test merchant credentials', kind: 'read', request: 'authenticateTestRequest',
    input: z.strictObject({}), build: () => ({}), output: {},
  }),
  gateway({
    id: 'get_merchant_details', title: 'Get merchant capabilities', kind: 'read', request: 'getMerchantDetailsRequest',
    input: z.strictObject({}), build: () => ({}),
    output: { isTestMode: true, gatewayId: true, processors: [{ name: true, id: true, cardTypes: [true] }], marketTypes: [true], productCodes: [true], paymentMethods: [true], currencies: [true], merchantTimeZone: true },
  }),
  gateway({
    id: 'list_settled_batches', title: 'List settled batches in a UTC interval', kind: 'read', request: 'getSettledBatchListRequest',
    input: z.strictObject({ firstSettlementDate: utc, lastSettlementDate: utc, includeStatistics: z.boolean().default(false) })
      .refine((args) => Date.parse(args.firstSettlementDate) < Date.parse(args.lastSettlementDate) && Date.parse(args.lastSettlementDate) - Date.parse(args.firstSettlementDate) <= 31 * 86400000, 'Use an increasing UTC interval of at most 31 days'),
    build: (args) => ({ includeStatistics: args.includeStatistics, firstSettlementDate: args.firstSettlementDate, lastSettlementDate: args.lastSettlementDate }),
    output: { batchList: [batch] },
    transform: (result, args) => {
      const returned = Array.isArray(result.batchList) ? result.batchList as Record<string, unknown>[] : [];
      const first = Date.parse(args.firstSettlementDate);
      const last = Date.parse(args.lastSettlementDate);
      return {
        ...result,
        batchList: returned.filter((item) => settlementInstant(item.settlementTimeUTC) >= first && settlementInstant(item.settlementTimeUTC) < last),
        coverage: { firstSettlementDate: args.firstSettlementDate, lastSettlementDate: args.lastSettlementDate, endExclusive: true, timestampMissingCount: returned.filter((item) => !Number.isFinite(settlementInstant(item.settlementTimeUTC))).length },
        currency: { code: null, source: 'Not supplied by this reporting response' },
      };
    },
  }),
  gateway({
    id: 'list_batch_transactions', title: 'List transactions in one settled batch', kind: 'read', request: 'getTransactionListRequest',
    input: z.strictObject({ batchId: id, sorting, paging }),
    build: (args) => ({ batchId: args.batchId, sorting: args.sorting, paging: args.paging }),
    output: listOutput, transform: pageCoverage,
  }),
  gateway({
    id: 'list_unsettled_transactions', title: 'List unsettled or held transactions', kind: 'read', request: 'getUnsettledTransactionListRequest',
    input: z.strictObject({ status: z.enum(['any', 'pendingApproval']).default('any'), sorting, paging }),
    build: (args) => ({ status: args.status, sorting: args.sorting, paging: args.paging }),
    output: listOutput, transform: pageCoverage,
  }),
  gateway({
    id: 'list_customer_transactions', title: 'List transactions for a saved customer', kind: 'read', request: 'getTransactionListForCustomerRequest',
    input: z.strictObject({ customerProfileId: id, customerPaymentProfileId: id.optional(), sorting, paging }),
    build: (args) => ({ customerProfileId: args.customerProfileId, customerPaymentProfileId: args.customerPaymentProfileId, sorting: args.sorting, paging: args.paging }),
    output: listOutput, transform: pageCoverage,
  }),
  gateway({
    id: 'get_transaction', title: 'Get exact transaction status and amounts', kind: 'read', request: 'getTransactionDetailsRequest',
    input: z.strictObject({ transId: id }), build: (args) => ({ transId: args.transId }),
    output: { transaction: { ...transaction, refTransId: true, splitTenderId: true, transactionType: true, responseCode: true, responseReasonCode: true, batch, requestedAmount: true, authAmount: true, originalAuthAmount: true, recurringBilling: true, FDSFilterAction: true, returnedItems: [{ id: true, dateUTC: true, code: true }], profile } },
    transform: (result) => ({ ...result, currency: { code: null, source: 'Not supplied by this reporting response' }, coverage: 'Exact transaction; does not establish every linked refund or remaining refundable balance' }),
  }),
  gateway({
    id: 'get_batch_statistics', title: 'Get exact settled batch statistics', kind: 'read', request: 'getBatchStatisticsRequest',
    input: z.strictObject({ batchId: id }), build: (args) => ({ batchId: args.batchId }), output: { batch },
    transform: (result) => ({ ...result, currency: { code: null, source: 'Not supplied by this reporting response' } }),
  }),
  gateway({
    id: 'get_account_updater_summary', title: 'Get monthly Account Updater summary', kind: 'read', request: 'getAUJobSummaryRequest',
    input: z.strictObject({ month }), build: (args) => ({ month: args.month }),
    output: { auSummary: [{ auReasonCode: true, profileCount: true }] },
  }),
  gateway({
    id: 'get_account_updater_details', title: 'Get one page of Account Updater changes', kind: 'read', request: 'getAUJobDetailsRequest',
    input: z.strictObject({ month, modifiedTypeFilter: z.enum(['all', 'updates', 'deletes']).default('all'), paging }),
    build: (args) => ({ month: args.month, modifiedTypeFilter: args.modifiedTypeFilter, paging: args.paging }),
    output: { totalNumInResultSet: true, auDetails: (value) => auDetails.parse(value) },
    transform: (result, args) => ({ auDetails: { auDelete: [], auUpdate: [] }, ...result, coverage: { month: args.month, modifiedTypeFilter: args.modifiedTypeFilter, limit: args.paging.limit, offset: args.paging.offset, scope: 'One page; Account Updater enrollment is required' } }),
  }),
  ...[
    ['get_hosted_payment_page', 'Prepare hosted payment', 'getHostedPaymentPageRequest', 'Requires a protected browser handoff that stores the short-lived form token outside MCP output and posts it to Authorize.net. No verified handoff is configured.'],
    ['get_hosted_profile_page', 'Prepare hosted customer profile collection', 'getHostedProfilePageRequest', 'Requires a protected browser handoff for the hosted profile token. No verified handoff is configured.'],
    ['update_merchant_details', 'Update merchant settings', 'updateMerchantDetailsRequest', 'The public example uses OAuth. Merchant-key authorization has not been established; changing test mode is consequential.'],
    ['is_alive', 'Check legacy gateway liveness', 'isAliveRequest', 'Schema-present operation without a verified current public merchant-key contract. Use authenticateTest for connection health.'],
    ['get_transaction_summary', 'Get schema-only transaction summary', 'getTransactionSummaryRequest', 'Schema-present operation without a verified current public merchant-key contract. Use documented transaction reporting.'],
    ['send_customer_transaction_receipt', 'Send a customer receipt', 'sendCustomerTransactionReceiptRequest', 'Sends email. The current public merchant-key request contract and safe recipient approval path have not been verified.'],
    ['get_customer_payment_profile_nonce', 'Request a payment profile nonce', 'getCustomerPaymentProfileNonceRequest', 'Requires a connected token and returns payment credentials. A protected browser integration and its separate authorization are required.'],
    ['get_ad_details', 'Get schema-only AD details', 'getADDetailsRequest', 'Requires a verified current public contract and account prerequisites; schema presence alone does not establish merchant-key availability.'],
    ['create_customer_profile_transaction', 'Create legacy customer profile transaction', 'createCustomerProfileTransactionRequest', 'Legacy request is superseded by createTransactionRequest with a saved profile. Use the typed profile payment operations.'],
    ['decrypt_payment_data', 'Decrypt device payment data', 'decryptPaymentDataRequest', 'Requires a separate secure payment program. Decrypted payment data must not enter MCP arguments or output.'],
    ['secure_payment_container', 'Create secure device payment container', 'securePaymentContainerRequest', 'Requires the corresponding device or secure payment program and a protected payment-data workflow.'],
    ['mobile_device_registration', 'Register a mobile device', 'mobileDeviceRegistrationRequest', 'Requires the separate mobile device credential model and a verified supported device workflow.'],
    ['mobile_device_login_pin', 'Start mobile PIN login', 'mobileDeviceLoginPinRequest', 'Requires the separate mobile device credential model and a human-facing authentication workflow.'],
    ['mobile_device_login_verify_pin', 'Verify a mobile login PIN', 'mobileDeviceLoginVerifyPinRequest', 'Requires the separate mobile device credential model. Authentication factors must not pass through MCP.'],
    ['mobile_device_login_verify_challenge', 'Verify a mobile login challenge', 'mobileDeviceLoginVerifyChallengeRequest', 'Requires the separate mobile device credential model. Authentication factors must not pass through MCP.'],
    ['mobile_device_mfa_login', 'Perform mobile MFA login', 'mobileDeviceMfaLoginRequest', 'Requires the separate mobile device credential model. Authentication factors must not pass through MCP.'],
    ['logout', 'End a device session', 'logoutRequest', 'Requires a separately established device session; not the merchant-key connection model.'],
    ['save_device_sn', 'Save a device serial number', 'saveDeviceSNRequest', 'Requires the corresponding supported device program and credential model.'],
  ].map(([operationId, title, request, reason]) => unavailable({ id: operationId!, title: title!, request: request!, reason: reason!, kind: ['isAliveRequest', 'getTransactionSummaryRequest', 'getADDetailsRequest'].includes(request!) ? 'read' : 'write' })),
];
