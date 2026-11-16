import { describe, expect, it } from 'vitest';
import {
  askFromArgs,
  isMoneyAmount,
  maskCardNumbersDeep,
  maskCardRuns,
  maskMoneyFact,
  maskPaymentLabel,
} from './action-class.js';

const CARD = '4111 1111 1111 1234';

describe('maskPaymentLabel', () => {
  it('masks digit runs in every payment label field (label, brand, type, name), never the full number', () => {
    for (const field of ['label', 'brand', 'type', 'name']) {
      const out = maskPaymentLabel({ [field]: `Visa ${CARD}` })!;
      expect(out, field).toContain('•••• 1234');
      expect(out, field).not.toContain('4111');
      expect(out.replace(/[^0-9]/g, '').length, field).toBeLessThanOrEqual(4);
    }
    // a shorter account-like run in a label is shortened too
    expect(maskPaymentLabel({ name: 'Savings 12345678' })).toBe('Savings ••78');
  });
  it('last4 shows at most the last four digits, whatever the agent put there', () => {
    expect(maskPaymentLabel({ brand: 'Visa', last4: '4111111111111234' })).toBe('Visa •••• 1234');
    expect(maskPaymentLabel({ brand: 'Visa', last4: '1234' })).toBe('Visa •••• 1234');
  });
  it('a bare number or a number field is masked', () => {
    expect(maskPaymentLabel(CARD)).toBe('•••• 1234');
    expect(maskPaymentLabel({ number: CARD })).toBe('•••• 1234');
  });
});

describe('askFromArgs: arguments the summary does not read', () => {
  it('names them as "more details not shown"', () => {
    const ask = askFromArgs('money', {
      merchant: 'Tindahan',
      total: 120,
      currency: 'PHP',
      payment: { brand: 'Visa', last4: '1234' },
      items: ['rice'],
      deliveryNote: 'leave at the gate',
      tipPercent: 20,
    });
    expect(ask.unshown).toEqual(['deliveryNote', 'tipPercent']);
  });
  it("a fact read from inside an object leaves that object's other fields named, never hidden as read", () => {
    // an agent hides a bcc next to the recipient the card shows
    const mail = askFromArgs('outbound-message', {
      envelope: { to: 'boss@family.example', bcc: 'attacker@evil.example' },
      text: 'Payroll attached',
    });
    expect(mail.fields.find((f) => f.key === 'recipients')?.value).toBe('boss@family.example');
    expect(mail.unshown).toEqual(['envelope › bcc']);
    // a money call hides a second payee in the same object as the merchant and total
    const pay = askFromArgs('money', {
      payment: { merchant: 'Jollibee', total: 150, splits: [{ to: 'acct-999', amount: 9000 }] },
    });
    expect(pay.fields.find((f) => f.key === 'merchant')?.value).toBe('Jollibee');
    expect(pay.unshown).toEqual(['payment › splits']);
    // a payment object shows only its label and last digits: anything else in it is named
    const card = askFromArgs('money', {
      merchant: 'Tindahan',
      total: 120,
      payment: { brand: 'Visa', last4: '1234', splits: [{ to: 'acct-999', amount: 9000 }] },
    });
    expect(card.fields.find((f) => f.key === 'paymentMethod')?.value).toBe('Visa •••• 1234');
    expect(card.unshown).toEqual(['payment › splits']);
    // a key named like the internal path of a read field is still its own argument
    const odd = askFromArgs('outbound-message', {
      envelope: { to: 'a@x.example' },
      '["envelope","to"]': 'b@x.example',
      text: 'hi',
    });
    expect(odd.unshown).toEqual(['["envelope","to"]']);
  });
  it('nothing extra: no warning', () => {
    const ask = askFromArgs('outbound-message', { to: 'ana@example.test', text: 'hi' });
    expect(ask.unshown).toBeUndefined();
  });
  it('a key name that carries a number is masked, and a long list is capped', () => {
    const many: Record<string, number> = { merchant: 1 } as never;
    for (let n = 0; n < 30; n++) many[`extra${n}`] = n;
    many[`card${CARD.replace(/ /g, '')}`] = 1;
    const ask = askFromArgs('money', many);
    expect(ask.unshown!.length).toBe(21);
    expect(ask.unshown!.at(-1)).toBe('+11');
    const withCard = askFromArgs('money', { [`card${CARD.replace(/ /g, '')}`]: 1 });
    expect(withCard.unshown![0]).toBe('card•••• 1234');
  });
});

describe('maskCardNumbersDeep (money approvals)', () => {
  it('masks payment instruments by key and card numbers anywhere, never amounts, IBANs or account numbers', () => {
    const out = maskCardNumbersDeep({
      amount: '250000000000',
      total: 4111111111111111, // an amount key is never masked, even when it looks like a card
      currency: 'IDR',
      to: 'DE89370400440532013000',
      account: '000123456789012',
      card: '5500-0000-0000-0004',
      payment: { number: '123456789012', cvc: '123', brand: 'Visa' },
      cvv: 987,
      note: 'pay with 4111.1111.1111.1111 please',
      items: [{ sku: 'kettle', price: '100000000000.00' }],
    });
    expect(out).toEqual({
      amount: '250000000000',
      total: 4111111111111111,
      currency: 'IDR',
      to: 'DE89370400440532013000',
      account: '000123456789012',
      card: '•••• 0004',
      payment: { number: '•••• 9012', cvc: '•••', brand: 'Visa' },
      cvv: '•••',
      note: 'pay with •••• 1111 please',
      items: [{ sku: 'kettle', price: '100000000000.00' }],
    });
  });
  it('maskCardRuns masks only Luhn-valid 13-19 digit runs', () => {
    expect(maskCardRuns('4242 4242 4242 4242')).toBe('•••• 4242');
    expect(maskCardRuns('4242 4242 4242 4241')).toBe('4242 4242 4242 4241');
    expect(maskCardRuns('1,000,000,000.00 IDR')).toBe('1,000,000,000.00 IDR');
  });
});

describe('money card masking: amounts by value, recipients by key', () => {
  it('isMoneyAmount reads amounts with separators and an optional currency, and nothing else', () => {
    for (const v of [
      '49.00 USD',
      '₱1,299.50',
      'PHP 1,299',
      '-12.5',
      '250000000000 sats',
      '1000000000000000000 wei',
      '1.000.000,00 €',
      '1,00,000 INR',
      'US$ 10',
      12.5,
      4111111111111111,
    ])
      expect(isMoneyAmount(v), String(v)).toBe(true);
    for (const v of [
      '4111 1111 1111 1111',
      '4111.1111.1111.1111',
      '4111-1111-1111-1111',
      'card 4111111111111111',
      'Visa 4111111111111111',
      '49.00 USD, card 4111111111111111',
      'ten dollars',
      '',
      '1,2,3',
    ])
      expect(isMoneyAmount(v), String(v)).toBe(false);
  });
  it('the total fact stays as given only when it is an amount; otherwise card numbers in it are masked', () => {
    expect(maskMoneyFact('total', '250000000000 sats')).toBe('250000000000 sats');
    expect(maskMoneyFact('total', '4111 1111 1111 1111 USD')).toBe('•••• 1111 USD');
    expect(maskMoneyFact('total', 'card 4111111111111111')).toBe('card •••• 1111');
  });
  it('who gets the money is never masked by key, even a Luhn-valid account; payment instruments are', () => {
    expect(maskMoneyFact('merchant', '0012345678901237')).toBe('0012345678901237');
    expect(maskMoneyFact('paymentMethod', '4111111111111111')).toBe('•••• 1111');
    const out = maskCardNumbersDeep({
      to: '0012345678901237',
      iban: 'GB33BUKB20201555555555',
      payee: { name: 'Shop One', accountNumber: '5300012345678909' },
      beneficiaryAccount: 5300012345678909,
      amount: 'card 4111111111111111',
      card: '4111111111111111',
      payment: { iban: '0012345678901237' },
    });
    expect(out).toEqual({
      to: '0012345678901237',
      iban: 'GB33BUKB20201555555555',
      payee: { name: 'Shop One', accountNumber: '5300012345678909' },
      beneficiaryAccount: 5300012345678909,
      // an amount key whose value is no amount is masked like any other field
      amount: 'card •••• 1111',
      card: '•••• 1111',
      // inside a payment object the account is the payer's instrument: masked
      payment: { iban: '•••• 1237' },
    });
  });
});
