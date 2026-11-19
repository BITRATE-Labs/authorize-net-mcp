import { z } from 'zod';
import { canonicalMoney, gateway, unavailable, type Operation, type BuildContext } from '../operation.js';

const reference = z.string().regex(/^[1-9][0-9]{0,31}$/);
const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/)
  .refine(value => /[1-9]/.test(value), 'Amount must be positive')
  .transform(canonicalMoney);
const transactionInput = z.strictObject({ transactionId: reference });
const amountInput = z.strictObject({ transactionId: reference, amount });
const profileInput = z.strictObject({
  amount,
  customerProfileId: reference,
  customerPaymentProfileId: reference,
});
const continuationInput = z.strictObject({
  transactionId: reference,
  payerId: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
});
// Never project free text, account numbers, auth codes, or secureAcceptance URLs.
const transactionOutput = {
  transactionResponse: {
    responseCode: true, rawResponseCode: true, transId: true, refTransID: true,
    splitTenderId: true, requestedAmount: true, approvedAmount: true,
    errors: [{ errorCode: true }],
  },
} as const;
const request = 'createTransactionRequest';
const tx = (transactionType: string, fields: Record<string, unknown>) => ({
  transactionRequest: { transactionType, ...fields },
});

async function requireState(ctx: BuildContext, transactionId: string, statuses: readonly string[]) {
  const original = await ctx.readTransaction(transactionId);
  if (String(original.transId) !== transactionId || !statuses.includes(String(original.transactionStatus))) {
    throw new Error('Transaction identity or eligibility changed; inspect the exact transaction again.');
  }
  return original;
}


function cardNumber(original: Record<string, unknown>): string {
  const payment = original.payment as { creditCard?: { cardNumber?: unknown } } | undefined;
  const masked = payment?.creditCard?.cardNumber;
  if (typeof masked !== 'string' || !/^[Xx*]+[0-9]{4}$/.test(masked)) {
    throw new Error('Trusted masked card evidence is unavailable; use the instrument-specific workflow.');
  }
  return masked.slice(-4);
}

async function requirePaypal(ctx: BuildContext, transactionId: string, payerId?: string) {
  const details = await ctx.readPaypal(transactionId);
  if (details.transId !== transactionId || String(details.accountType).toLowerCase() !== 'paypal' || String(details.responseCode) !== '1') {
    throw new Error('Trusted PayPal transaction identity is unavailable.');
  }
  if (payerId !== undefined) {
    // The XSD uses PayerID; official JSON examples also use payerID.
    const acceptance = details.secureAcceptance as { PayerID?: unknown; payerID?: unknown } | undefined;
    if ((acceptance?.PayerID ?? acceptance?.payerID) !== payerId) {
      throw new Error('PayPal buyer approval does not match this continuation.');
    }
  }
}

function cents(value: unknown): bigint {
  // Reporting JSON represents amounts as numbers; reject anything beyond exact decimal cents.
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/.test(text)) {
    throw new Error('Exact original amount evidence is unavailable.');
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

async function settled(ctx: BuildContext, transactionId: string, requestedAmount: string) {
  const original = await requireState(ctx, transactionId, ['settledSuccessfully']);
  if (original.transactionType !== 'authCaptureTransaction' && original.transactionType !== 'priorAuthCaptureTransaction' && original.transactionType !== 'captureOnlyTransaction') {
    throw new Error('Only original settled payments can be refunded.');
  }
  if (cents(requestedAmount) > cents(original.settleAmount)) {
    throw new Error('Refund exceeds the original settled amount.');
  }
  return original;
}

const profileOperations = [
  ['authorize_profile', 'Authorize a saved customer payment profile', 'authOnlyTransaction'],
  ['charge_profile', 'Authorize and capture a saved customer payment profile', 'authCaptureTransaction'],
].map(([id, title, transactionType]) => gateway({
  id: id!, title: title!, kind: 'write', request, input: profileInput,
  build: args => tx(transactionType!, {
    amount: args.amount,
    profile: {
      customerProfileId: args.customerProfileId,
      paymentProfile: { paymentProfileId: args.customerPaymentProfileId },
    },
  }),
  output: transactionOutput,
}));

const direct: Operation[] = [
  ...profileOperations,
  gateway({
    id: 'capture_previous', title: 'Capture an existing card authorization', kind: 'write', request,
    input: amountInput,
    build: async (args, ctx) => {
      const original = await requireState(ctx, args.transactionId, ['authorizedPendingCapture']);
      cardNumber(original);
      if (cents(args.amount) > cents(original.authAmount)) throw new Error('Capture exceeds the authorized amount.');
      return tx('priorAuthCaptureTransaction', { amount: args.amount, refTransId: args.transactionId });
    }, output: transactionOutput,
  }),
  gateway({
    id: 'void_transaction', title: 'Void an unsettled card transaction', kind: 'write', request,
    input: transactionInput,
    build: async (args, ctx) => {
      cardNumber(await requireState(ctx, args.transactionId, ['authorizedPendingCapture', 'capturedPendingSettlement', 'refundPendingSettlement']));
      return tx('voidTransaction', { refTransId: args.transactionId });
    }, output: transactionOutput,
  }),
  gateway({
    id: 'refund_transaction', title: 'Refund a settled card transaction in full or part', kind: 'write', request,
    input: amountInput,
    build: async (args, ctx) => {
      const original = await settled(ctx, args.transactionId, args.amount);
      const lastFour = cardNumber(original);
      return tx('refundTransaction', {
        amount: args.amount,
        payment: { creditCard: { cardNumber: lastFour, expirationDate: 'XXXX' } },
        refTransId: args.transactionId,
      });
    }, output: transactionOutput,
  }),
  gateway({
    id: 'paypal_get_details', title: 'Get PayPal checkout status without buyer personal data', kind: 'read', request,
    input: transactionInput,
    build: args => tx('getDetailsTransaction', { refTransId: args.transactionId }),
    output: { transactionResponse: { ...transactionOutput.transactionResponse, secureAcceptance: { PayerID: true, payerID: true } } },
  }),
  ...([
    ['paypal_authorize_continue', 'Complete PayPal authorization after external buyer approval', 'authOnlyContinueTransaction'],
    ['paypal_capture_continue', 'Complete PayPal authorize and capture after external buyer approval', 'authCaptureContinueTransaction'],
  ] as const).map(([id, title, transactionType]) => gateway({
    id, title, kind: 'write', request, input: continuationInput,
    build: async (args, ctx) => {
      await requirePaypal(ctx, args.transactionId, args.payerId);
      const original = await ctx.readTransaction(args.transactionId);
      const expectedType = transactionType === 'authOnlyContinueTransaction' ? 'authOnlyTransaction' : 'authCaptureTransaction';
      if (original.transId !== args.transactionId || original.transactionType !== expectedType) {
        throw new Error('PayPal continuation does not match the original checkout action.');
      }
      return tx(transactionType, {
        payment: { payPal: { payerID: args.payerId } },
        refTransId: args.transactionId,
      });
    }, output: transactionOutput,
  })),
  gateway({
    id: 'paypal_capture_previous', title: 'Capture a previously completed PayPal authorization', kind: 'write', request,
    input: amountInput,
    build: async (args, ctx) => {
      await requirePaypal(ctx, args.transactionId);
      const original = await requireState(ctx, args.transactionId, ['authorizedPendingCapture']);
      if (cents(args.amount) > cents(original.authAmount)) throw new Error('Capture exceeds the authorized amount.');
      return tx('priorAuthCaptureTransaction', { amount: args.amount, refTransId: args.transactionId });
    }, output: transactionOutput,
  }),
  gateway({
    id: 'paypal_void', title: 'Void an approved uncaptured PayPal authorization', kind: 'write', request,
    input: transactionInput,
    build: async (args, ctx) => {
      await requirePaypal(ctx, args.transactionId);
      await requireState(ctx, args.transactionId, ['authorizedPendingCapture']);
      return tx('voidTransaction', { refTransId: args.transactionId });
    }, output: transactionOutput,
  }),
  gateway({
    id: 'paypal_refund', title: 'Refund a settled PayPal transaction in full or part', kind: 'write', request,
    input: amountInput,
    build: async (args, ctx) => {
      await requirePaypal(ctx, args.transactionId);
      await settled(ctx, args.transactionId, args.amount);
      return tx('refundTransaction', { amount: args.amount, refTransId: args.transactionId });
    }, output: transactionOutput,
  }),
  ...(['completed', 'voided'] as const).map(status => gateway({
    id: status === 'completed' ? 'complete_split_tender' : 'void_split_tender',
    title: status === 'completed' ? 'Complete a split tender order' : 'Void an entire split tender order',
    kind: 'write', request: 'updateSplitTenderGroupRequest',
    input: z.strictObject({ splitTenderId: reference }),
    build: args => ({ splitTenderId: args.splitTenderId, splitTenderStatus: status }),
    output: {},
  })),
  ...(['approve', 'decline'] as const).map(action => gateway({
    id: `${action}_held_transaction`,
    title: action === 'approve' ? 'Approve a fraud-held transaction and resume processing' : 'Decline a fraud-held transaction',
    kind: 'write', request: 'updateHeldTransactionRequest', input: transactionInput,
    build: async (args, ctx) => {
      await requireState(ctx, args.transactionId, ['FDSPendingReview', 'FDSAuthorizedPendingReview']);
      return { heldTransactionRequest: { action, refTransId: args.transactionId } };
    }, output: { transactionResponse: { responseCode: true, transId: true, errors: [{ errorCode: true }] } },
  })),
];

const browserRequired = [
  ['authorize_card', 'Authorize a newly collected card', 'authOnlyTransaction', 'Accept.js or hosted card collection with a protected one-time payment credential resolver.'],
  ['charge_card', 'Authorize and capture a newly collected card', 'authCaptureTransaction', 'Accept.js or Accept Hosted payment collection.'],
  ['capture_external', 'Capture funds authorized through another channel', 'captureOnlyTransaction', 'Merchant secure instrument collection and the external authorization code.'],
  ['debit_echeck', 'Debit a bank account', 'authCaptureTransaction', 'An enabled eCheck.Net account, ACH authorization, and merchant secure bank collection.'],
  ['credit_echeck', 'Credit a bank account', 'refundTransaction', 'An enabled eCheck.Net account, permitted credit authority, and merchant secure bank collection.'],
  ['charge_apple_pay', 'Charge an Apple Pay payment', 'authCaptureTransaction', 'Apple Pay merchant registration, supported processor, and merchant browser or app payment-token exchange.'],
  ['charge_google_pay', 'Charge a Google Pay payment', 'authCaptureTransaction', 'Google Pay merchant integration, supported processor, and merchant browser or app payment-token exchange.'],
  ['charge_mobile', 'Charge a mobile in-app payment', 'authCaptureTransaction', 'Approved mobile SDK or secure payment container integration with protected payment data.'],
  ['paypal_authorize_start', 'Start PayPal authorization and external buyer approval', 'authOnlyTransaction', 'Enabled PayPal Express Checkout, verified merchant return URLs, and a protected browser handoff for secureAcceptanceUrl.'],
  ['paypal_capture_start', 'Start PayPal authorization and capture with external buyer approval', 'authCaptureTransaction', 'Enabled PayPal Express Checkout, verified merchant return URLs, and a protected browser handoff for secureAcceptanceUrl.'],
] as const;

export const transactions: readonly Operation[] = [
  ...direct,
  ...browserRequired.map(([id, title, transactionType, prerequisite]) => unavailable({
    id, title, request,
    reason: `${prerequisite} Wire transactionType: ${transactionType}. PAN, CVV, bank details, wallet payloads, and one-time payment credentials are never accepted through MCP arguments.`,
  })),
];
