import { expect, test } from 'bun:test';
import { effectReceiptFields, finiteEffectReceiptFields } from '../../extension/background/host-effect-verdict.js';

test('receipt projection preserves false values and arbitrary string kinds without unrelated fields', () => {
  const source = Object.freeze({ performed: false, outcomeKnown: true, retryable: false,
    outcomeKind: 'future-host-verdict', error: 'private error', code: 'private-code', payload: 'secret' });
  expect(effectReceiptFields(source)).toEqual({ performed: false, outcomeKnown: true,
    outcomeKind: 'future-host-verdict', retryable: false });
  expect(effectReceiptFields({ outcomeKind: '' })).toEqual({ outcomeKind: '' });
});

test('receipt projection omits absent and wrongly typed fields without inventing a verdict', () => {
  for (const value of [undefined, null, false, 0, 'failure', {},
    { performed: 1, outcomeKnown: 'false', retryable: null, outcomeKind: 1 }]) {
    expect(effectReceiptFields(value)).toEqual({});
  }
  expect(effectReceiptFields({ performed: true })).toEqual({ performed: true });
});

test('Error receipt properties retain their typed values without cause or message disclosure', () => {
  const error = Object.assign(new Error('sensitive'), { performed: true, outcomeKnown: false,
    retryable: true, outcomeKind: 'transport-lost', cause: new Error('nested') });
  expect(effectReceiptFields(error)).toEqual({ performed: true, outcomeKnown: false,
    outcomeKind: 'transport-lost', retryable: true });
});

test('finite dweb projection retains established kinds without broadening kernel projection policy', () => {
  for (const outcomeKind of ['pre-effect-failure', 'effect-completed', 'host-lost', 'transport-lost']) {
    expect(finiteEffectReceiptFields({ outcomeKind, performed: false })).toEqual({ performed: false, outcomeKind });
  }
  const future = { outcomeKind: 'future-host-verdict', outcomeKnown: false, retryable: false };
  expect(finiteEffectReceiptFields(future)).toEqual({ outcomeKnown: false, retryable: false });
  expect(effectReceiptFields(future)).toEqual(future);
});
