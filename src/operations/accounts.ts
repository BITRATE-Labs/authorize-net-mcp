import { z } from 'zod';
import { canonicalMoney, gateway, unavailable, type Operation } from '../operation.js';

const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const text = (max: number) => z.string().max(max);
const money = z.string().regex(/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,4})?$/).transform(canonicalMoney);
const amount = money.refine((value) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole! + fraction.padEnd(4, '0')) >= 100n;
}, 'Amount must be at least 0.01');
const customerKey = z.strictObject({ customerProfileId: id });
const paymentKey = z.strictObject({ customerProfileId: id, customerPaymentProfileId: id });
const shippingKey = z.strictObject({ customerProfileId: id, customerAddressId: id });
const subscriptionKey = z.strictObject({ subscriptionId: id });
const paging = z.strictObject({ limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().min(1).max(100000).default(1) });
const customerFields = {
  merchantCustomerId: text(20).optional(), description: text(255).optional(), email: z.email().max(255).optional(),
};
const customer = z.strictObject(customerFields).refine((v) => Object.values(v).some(Boolean), 'Provide a customer identifier, description or email');
const addressFields = {
  firstName: text(50).optional(), lastName: text(50).optional(), company: text(50).optional(),
  address: text(60).optional(), city: text(40).optional(), state: text(40).optional(), zip: text(20).optional(),
  country: text(60).optional(), phoneNumber: text(25).optional(), faxNumber: text(25).optional(), email: z.email().max(255).optional(),
};
const address = z.strictObject(addressFields).refine((v) => Object.values(v).some(Boolean), 'Provide shipping address information');
const profile = z.strictObject({ customerProfileId: id, customerPaymentProfileId: id, customerAddressId: id.optional() });
const order = z.strictObject({ invoiceNumber: text(20).optional(), description: text(255).optional() });
const interval = z.discriminatedUnion('unit', [
  z.strictObject({ length: z.number().int().min(7).max(365), unit: z.literal('days') }),
  z.strictObject({ length: z.number().int().min(1).max(12), unit: z.literal('months') }),
]);
const schedule = z.strictObject({
  interval, startDate: z.iso.date(), totalOccurrences: z.number().int().min(1).max(9999),
  trialOccurrences: z.number().int().min(1).max(99).optional(),
}).refine((v) => v.trialOccurrences === undefined || v.trialOccurrences < v.totalOccurrences, 'Trial occurrences must be less than total occurrences');
const subscription = z.strictObject({
  name: text(50).optional(), paymentSchedule: schedule, amount, trialAmount: money.optional(), order: order.optional(), profile,
}).refine((v) => (v.trialAmount !== undefined) === (v.paymentSchedule.trialOccurrences !== undefined), 'Trial amount and trial occurrences must be supplied together');
const scheduleOutput = { interval: { length: true, unit: true }, startDate: true, totalOccurrences: true, trialOccurrences: true } as const;
const paymentOutput = { customerProfileId: true, customerPaymentProfileId: true, defaultPaymentProfile: true, subscriptionIds: [true] } as const;
const profileOutput = { customerProfileId: true, paymentProfiles: [paymentOutput], shipToList: [{ customerAddressId: true }], profileType: true } as const;
const subscriptionOutput = {
  paymentSchedule: scheduleOutput, amount: true, trialAmount: true, status: true,
  profile: { customerProfileId: true, paymentProfile: paymentOutput, shippingProfile: { customerAddressId: true } },
  arbTransactions: { arbTransaction: [{ transId: true, submitTimeUTC: true, payNum: true, attemptNum: true }] },
} as const;

export const accounts: readonly Operation[] = [
  gateway({
    id: 'create_subscription', title: 'Create recurring charges using a saved payment profile. ARB and customer agreement required; creation does not prove payment.',
    kind: 'write', request: 'ARBCreateSubscriptionRequest', input: z.strictObject({ subscription }),
    build: (a) => ({ subscription: {
      name: a.subscription.name, paymentSchedule: { interval: { length: a.subscription.paymentSchedule.interval.length, unit: a.subscription.paymentSchedule.interval.unit }, startDate: a.subscription.paymentSchedule.startDate, totalOccurrences: a.subscription.paymentSchedule.totalOccurrences, trialOccurrences: a.subscription.paymentSchedule.trialOccurrences },
      amount: a.subscription.amount, trialAmount: a.subscription.trialAmount, order: a.subscription.order, profile: a.subscription.profile,
    } }), output: { subscriptionId: true, profile: { customerProfileId: true, customerPaymentProfileId: true, customerAddressId: true } },
  }),
  gateway({ id: 'get_subscription', title: 'Read an ARB subscription and optional installment references', kind: 'read', request: 'ARBGetSubscriptionRequest',
    input: z.strictObject({ subscriptionId: id, includeTransactions: z.boolean().default(false) }), build: (a) => ({ subscriptionId: a.subscriptionId, includeTransactions: a.includeTransactions }), output: { subscription: subscriptionOutput } }),
  gateway({ id: 'get_subscription_status', title: 'Read an ARB subscription status', kind: 'read', request: 'ARBGetSubscriptionStatusRequest',
    input: subscriptionKey, build: (a) => ({ subscriptionId: a.subscriptionId }), output: { status: true } }),
  gateway({ id: 'list_subscriptions', title: 'Read one bounded ARB subscription page', kind: 'read', request: 'ARBGetSubscriptionListRequest',
    input: z.strictObject({ searchType: z.enum(['cardExpiringThisMonth', 'subscriptionActive', 'subscriptionExpiringThisMonth', 'subscriptionInactive']),
      sorting: z.strictObject({ orderBy: z.enum(['id', 'name', 'status', 'createTimeStampUTC', 'lastName', 'firstName', 'accountNumber', 'amount', 'pastOccurrences']), orderDescending: z.boolean() }).optional(), paging }),
    build: (a) => ({ searchType: a.searchType, sorting: a.sorting, paging: a.paging }),
    output: { totalNumInResultSet: true, subscriptionDetails: [{ id: true, status: true, createTimeStampUTC: true, totalOccurrences: true, pastOccurrences: true, paymentMethod: true, amount: true, currencyCode: true, customerProfileId: true, customerPaymentProfileId: true, customerShippingProfileId: true }] } }),
  gateway({ id: 'update_subscription', title: 'Change future recurring charge amount, name, order or saved profile. Requires customer agreement; does not refund earlier charges.', kind: 'write', request: 'ARBUpdateSubscriptionRequest',
    input: z.strictObject({ subscriptionId: id, subscription: z.strictObject({ name: text(50).optional(), amount: amount.optional(), order: order.optional(), profile: profile.optional() }).refine((v) => Object.keys(v).length > 0, 'Provide a change') }),
    build: async (a, ctx) => {
      const current = await ctx.readSubscription(a.subscriptionId);
      if (!['active', 'suspended'].includes(String(current.status))) throw new Error('Subscription is not active or suspended');
      return { subscriptionId: a.subscriptionId, subscription: { name: a.subscription.name, amount: a.subscription.amount, order: a.subscription.order, profile: a.subscription.profile } };
    }, output: {} }),
  unavailable({ id: 'update_subscription_schedule', title: 'Change a recurring billing schedule', request: 'ARBUpdateSubscriptionRequest',
    reason: 'Interval changes are prohibited. Start date, total occurrences and trial edits require verified successful-installment and trial-state evidence after approval. The current adapter cannot establish that evidence safely.' }),
  gateway({ id: 'cancel_subscription', title: 'Cancel future ARB charges for this exact subscription. Earlier transactions are not refunded.', kind: 'write', request: 'ARBCancelSubscriptionRequest',
    input: subscriptionKey, build: async (a, ctx) => { await ctx.readSubscription(a.subscriptionId); return { subscriptionId: a.subscriptionId }; }, output: {} }),
  gateway({ id: 'create_customer_profile', title: 'Create an empty customer profile. New instruments must be collected through a secure hosted profile workflow.', kind: 'write', request: 'createCustomerProfileRequest',
    input: z.strictObject({ profile: customer, profileType: z.enum(['regular', 'guest']).default('regular') }),
    build: (a) => ({ profile: { ...a.profile, profileType: a.profileType }, validationMode: 'none' }), output: { customerProfileId: true, customerPaymentProfileIdList: [true], customerShippingAddressIdList: [true] } }),
  gateway({ id: 'get_customer_profile', title: 'Read customer profile references; address and instrument details are omitted', kind: 'read', request: 'getCustomerProfileRequest',
    input: customerKey, build: (a) => ({ customerProfileId: a.customerProfileId, unmaskExpirationDate: false, includeIssuerInfo: false }), output: { profile: profileOutput, subscriptionIds: [true] } }),
  gateway({ id: 'list_customer_profile_ids', title: 'Read customer profile IDs. Provider does not offer pagination for this request.', kind: 'read', request: 'getCustomerProfileIdsRequest', input: z.strictObject({}), build: () => ({}), output: { ids: [true] } }),
  gateway({ id: 'update_customer_profile', title: 'Replace customer metadata. Omitted metadata fields may be cleared; provide all values to retain.', kind: 'write', request: 'updateCustomerProfileRequest',
    input: z.strictObject({ customerProfileId: id, profile: customer, profileType: z.enum(['regular', 'guest']).optional() }),
    build: (a) => ({ profile: { ...a.profile, customerProfileId: a.customerProfileId, profileType: a.profileType } }), output: {} }),
  gateway({ id: 'delete_customer_profile', title: 'Permanently delete a customer profile and its saved payment and shipping profiles. Subscription cancellation is separate.', kind: 'write', request: 'deleteCustomerProfileRequest',
    input: customerKey, build: async (a, ctx) => { await ctx.readCustomerProfile(a.customerProfileId); return { customerProfileId: a.customerProfileId }; }, output: {} }),
  gateway({ id: 'create_customer_profile_from_transaction', title: 'Save a payment profile from an existing transaction. Requires customer consent to store the payment method.', kind: 'write', request: 'createCustomerProfileFromTransactionRequest',
    input: z.strictObject({ transId: id, customer: customer.optional(), customerProfileId: id.optional(), defaultPaymentProfile: z.boolean().optional(), defaultShippingAddress: z.boolean().optional(), profileType: z.enum(['regular', 'guest']).optional() }).refine((a) => !(a.customer && a.customerProfileId), 'Use new customer metadata or an existing profile ID'),
    build: (a) => ({ transId: a.transId, customer: a.customer, customerProfileId: a.customerProfileId, defaultPaymentProfile: a.defaultPaymentProfile, defaultShippingAddress: a.defaultShippingAddress, profileType: a.profileType }),
    output: { customerProfileId: true, customerPaymentProfileIdList: [true], customerShippingAddressIdList: [true] } }),
  unavailable({ id: 'create_customer_payment_profile', title: 'Collect a new saved payment method', request: 'createCustomerPaymentProfileRequest',
    reason: 'Requires a secure hosted profile or merchant browser integration. Raw card, bank, wallet and one-time token values cannot be entered through MCP.' }),
  gateway({ id: 'get_customer_payment_profile', title: 'Read saved payment profile references without instrument or billing address details', kind: 'read', request: 'getCustomerPaymentProfileRequest', input: paymentKey,
    build: (a) => ({ customerProfileId: a.customerProfileId, customerPaymentProfileId: a.customerPaymentProfileId, unmaskExpirationDate: false, includeIssuerInfo: false }), output: { paymentProfile: paymentOutput } }),
  gateway({ id: 'list_customer_payment_profiles', title: 'Read one bounded page of expiring payment profile references', kind: 'read', request: 'getCustomerPaymentProfileListRequest',
    input: z.strictObject({ month: z.string().regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])$/), paging, orderDescending: z.boolean().default(false) }),
    build: (a) => ({ searchType: 'cardsExpiringInMonth', month: a.month, sorting: { orderBy: 'id', orderDescending: a.orderDescending }, paging: a.paging }),
    output: { totalNumInResultSet: true, paymentProfiles: [paymentOutput] } }),
  gateway({ id: 'validate_customer_payment_profile', title: 'Validate a saved payment profile. liveMode can create a real authorization, requires approval.', kind: 'write', request: 'validateCustomerPaymentProfileRequest',
    input: z.strictObject({ customerProfileId: id, customerPaymentProfileId: id, customerShippingAddressId: id.optional(), validationMode: z.enum(['testMode', 'liveMode']) }),
    build: (a) => ({ customerProfileId: a.customerProfileId, customerPaymentProfileId: a.customerPaymentProfileId, customerShippingAddressId: a.customerShippingAddressId, validationMode: a.validationMode }), output: {} }),
  unavailable({ id: 'update_customer_payment_profile', title: 'Update a saved payment method or billing details', request: 'updateCustomerPaymentProfileRequest',
    reason: 'Use the secure hosted profile workflow. Partial updates can clear existing values; preserving masked instruments and collecting replacements requires a trusted browser integration.' }),
  gateway({ id: 'delete_customer_payment_profile', title: 'Permanently delete this saved payment profile. Subscription cancellation is separate.', kind: 'write', request: 'deleteCustomerPaymentProfileRequest', input: paymentKey,
    build: (a) => ({ customerProfileId: a.customerProfileId, customerPaymentProfileId: a.customerPaymentProfileId }), output: {} }),
  gateway({ id: 'create_customer_shipping_address', title: 'Create a customer shipping address', kind: 'write', request: 'createCustomerShippingAddressRequest',
    input: z.strictObject({ customerProfileId: id, address, defaultShippingAddress: z.boolean().optional() }),
    build: (a) => ({ customerProfileId: a.customerProfileId, address: a.address, defaultShippingAddress: a.defaultShippingAddress }), output: { customerAddressId: true } }),
  gateway({ id: 'get_customer_shipping_address', title: 'Read a shipping address reference. Personal address details are omitted.', kind: 'read', request: 'getCustomerShippingAddressRequest', input: shippingKey,
    build: (a) => ({ customerProfileId: a.customerProfileId, customerAddressId: a.customerAddressId }), output: { address: { customerAddressId: true } } }),
  gateway({ id: 'update_customer_shipping_address', title: 'Replace a shipping address. Omitted address fields may be cleared; provide all values to retain.', kind: 'write', request: 'updateCustomerShippingAddressRequest',
    input: z.strictObject({ customerProfileId: id, customerAddressId: id, address, defaultShippingAddress: z.boolean().optional() }),
    build: (a) => ({ customerProfileId: a.customerProfileId, address: { ...a.address, customerAddressId: a.customerAddressId }, defaultShippingAddress: a.defaultShippingAddress }), output: {} }),
  gateway({ id: 'delete_customer_shipping_address', title: 'Permanently delete this saved shipping address', kind: 'write', request: 'deleteCustomerShippingAddressRequest', input: shippingKey,
    build: (a) => ({ customerProfileId: a.customerProfileId, customerAddressId: a.customerAddressId }), output: {} }),
];
