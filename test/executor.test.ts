import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDescribeInput, parseDispatchInput, parseListInput, parseWebhookOrigin } from '../src/executor.js';

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
