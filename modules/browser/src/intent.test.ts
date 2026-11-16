import { describe, expect, it } from 'vitest';
import { browserAsk, browserClass, detectPage, type PageField } from './intent.js';

const field = (o: Partial<PageField>): PageField => ({
  name: '',
  id: '',
  type: 'text',
  autocomplete: '',
  placeholder: '',
  label: '',
  tag: 'input',
  value: '',
  ...o,
});

describe('browser always-ask detector (7.1)', () => {
  it('a checkout page (address or card fields) is money; the card masks the number and names the merchant', () => {
    const page = {
      url: 'https://shop.example.test/checkout',
      total: '₱1,250.00',
      fields: [
        field({ name: 'cardnumber', autocomplete: 'cc-number', value: '4242 4242 4242 4242' }),
        field({ name: 'exp', autocomplete: 'cc-exp', value: '12/30' }),
      ],
    };
    expect(detectPage(page)).toBe('money');
    expect(detectPage({ ...page, url: 'https://shop.example.test/step-2' })).toBe('money'); // fields alone
    expect(detectPage({ url: 'https://shop.example.test/pay', total: '', fields: [] })).toBe('money');
    const ask = browserAsk('money', page, { intent: 'none', detected: 'money' });
    expect(ask).toEqual({
      class: 'money',
      fields: [
        { key: 'items', value: null },
        { key: 'merchant', value: 'shop.example.test' },
        { key: 'total', value: '₱1,250.00' },
        { key: 'paymentMethod', value: '•••• 4242' },
      ],
      undeclared: true,
    });
    expect(JSON.stringify(ask)).not.toContain('4242 4242');
    // declared: no warning
    expect(browserAsk('money', page, { intent: 'money', detected: 'money' }).undeclared).toBeUndefined();
  });

  it('a compose form is an outbound message; the card shows recipients, subject and the full text', () => {
    const page = {
      url: 'https://mail.example.test/u/0/',
      total: '',
      fields: [
        field({ name: 'to', label: 'To', value: 'ana@example.test' }),
        field({ name: 'subject', value: 'Dinner' }),
        field({ tag: 'textarea', name: 'body', value: 'See you at 6.' }),
      ],
    };
    expect(detectPage(page)).toBe('outbound-message');
    expect(
      browserAsk('outbound-message', page, { intent: 'outbound-message', detected: 'outbound-message' }),
    ).toEqual({
      class: 'outbound-message',
      fields: [
        { key: 'recipients', value: 'ana@example.test' },
        { key: 'channel', value: 'mail.example.test' },
        { key: 'subject', value: 'Dinner' },
        { key: 'text', value: 'See you at 6.' },
      ],
    });
  });

  it('a compose form with a Cc line is a message, not money; its card shows recipients and the text', () => {
    const page = {
      url: 'https://mail.example.test/mail/u/0/#inbox?compose=new',
      total: '',
      fields: [
        field({ name: 'to', label: 'To', value: 'ana@example.test', form: 0 }),
        field({ name: 'cc', label: 'Cc', value: 'bo@example.test', form: 0 }),
        field({ name: 'subject', value: 'Dinner', form: 0 }),
        field({ tag: 'div', label: 'Message Body', value: 'See you at 6.', form: 0 }),
      ],
      target: { label: 'Send', attrs: '', form: 0 },
    };
    expect(detectPage(page)).toBe('outbound-message');
    const ask = browserAsk('outbound-message', page, {
      intent: 'outbound-message',
      detected: 'outbound-message',
    });
    expect(ask.undeclared).toBeUndefined();
    expect(ask.fields).toEqual([
      { key: 'recipients', value: 'ana@example.test, bo@example.test' },
      { key: 'channel', value: 'mail.example.test' },
      { key: 'subject', value: 'Dinner' },
      { key: 'text', value: 'See you at 6.' },
    ]);
  });

  it('address words alone do not mark whole sites: an inbox, an order history, a cart, a blog post', () => {
    const plain = (url: string, target = { label: 'Open', attrs: '', form: -1 }) => ({
      url,
      total: '',
      fields: [field({ name: 'q', placeholder: 'Search mail' })],
      target,
    });
    expect(detectPage(plain('https://mail.example.test/mail/u/0/#inbox'))).toBeUndefined();
    expect(detectPage(plain('https://shop.example.test/order-history'))).toBeUndefined();
    expect(detectPage(plain('https://shop.example.test/cart'))).toBeUndefined();
    expect(detectPage(plain('https://blog.example.test/post/42'))).toBeUndefined();
    // a long link text that merely contains "buy" is not a button that buys
    expect(
      detectPage(
        plain('https://news.example.test/', {
          label: 'Ten things to buy before the holidays this year',
          attrs: '',
          form: -1,
        }),
      ),
    ).toBeUndefined();
    // a search form elsewhere on a compose page does not make its search box a message
    const page = {
      url: 'https://mail.example.test/inbox',
      total: '',
      fields: [
        field({ name: 'q', placeholder: 'Search', form: 0 }),
        field({ name: 'to', value: 'ana@example.test', form: 1 }),
        field({ tag: 'textarea', name: 'body', value: 'hi', form: 1 }),
      ],
      target: { label: '', attrs: 'q Search', form: 0 },
    };
    expect(detectPage(page)).toBeUndefined();
    expect(detectPage({ ...page, target: { label: 'Send', attrs: '', form: 1 } })).toBe('outbound-message');
  });

  it('checkouts without card fields or money words in the address are still money', () => {
    // a saved-card checkout: no card fields, an address of neutral words, a "Place your order" button
    const spc = {
      url: 'https://www.shop.example.test/gp/buy/spc/handlers/display.html',
      total: '',
      fields: [],
    };
    expect(detectPage(spc)).toBe('money'); // "buy" in the address
    const neutral = { url: 'https://shop.example.test/step/3', total: '', fields: [] };
    expect(detectPage(neutral)).toBeUndefined();
    for (const label of [
      'Place your order',
      'Buy now',
      'Pay ₱1,250',
      'Start subscription',
      'Confirm purchase',
    ])
      expect(detectPage({ ...neutral, target: { label, attrs: '', form: -1 } })).toBe('money');
    // a card form in a child frame (an embedded payment field), never its value
    expect(
      detectPage({
        ...neutral,
        fields: [field({ name: 'cardnumber', autocomplete: 'cc-number', frame: true, form: -1 })],
      }),
    ).toBe('money');
    // typing into a card field is money by the field itself
    expect(detectPage({ ...neutral, target: { label: '', attrs: 'cc-number', form: -1 } })).toBe('money');
  });

  it('a page that both takes money and sends a message gets a money card with the message facts too', () => {
    const page = {
      url: 'https://gifts.example.test/checkout',
      total: '₱500.00',
      fields: [
        field({ name: 'recipient', value: 'ana@example.test' }),
        field({ tag: 'textarea', name: 'message', value: 'Happy birthday!' }),
      ],
    };
    const ask = browserAsk('money', page, { intent: 'money', detected: 'money' });
    expect(ask.fields.map((f) => f.key)).toEqual([
      'items',
      'merchant',
      'total',
      'paymentMethod',
      'recipients',
      'subject',
      'text',
    ]);
    expect(ask.fields.find((f) => f.key === 'recipients')?.value).toBe('ana@example.test');
    expect(ask.fields.find((f) => f.key === 'text')?.value).toBe('Happy birthday!');
  });

  it('an ordinary page is neither; a declared intent still asks; money wins', () => {
    const page = {
      url: 'https://news.example.test/today',
      total: '',
      fields: [field({ name: 'q', placeholder: 'Search' })],
    };
    expect(detectPage(page)).toBeUndefined();
    expect(browserClass('none', undefined)).toBeUndefined();
    expect(browserClass('money', undefined)).toBe('money');
    expect(browserClass('outbound-message', 'money')).toBe('money');
    expect(browserClass('none', 'outbound-message')).toBe('outbound-message');
  });
  it('a hidden or later-step card field is not a payment page, unless it holds a value the clicked form submits', () => {
    const add = { label: 'Add to cart', attrs: 'add', form: 0 };
    const hiddenCard = field({
      name: 'cardnumber',
      autocomplete: 'cc-number',
      type: 'hidden',
      hidden: true,
      form: 0,
    });
    const page = { url: 'https://shop.example.test/p/kettle', total: '', target: add };
    expect(detectPage({ ...page, fields: [hiddenCard] })).toBeUndefined();
    expect(detectPage({ ...page, fields: [{ ...hiddenCard, frame: true, form: -1 }] })).toBeUndefined();
    // shown: a payment page
    expect(detectPage({ ...page, fields: [{ ...hiddenCard, hidden: false }] })).toBe('money');
    // hidden but filled, in the form the click submits: the click would send a card number
    expect(detectPage({ ...page, fields: [{ ...hiddenCard, value: '4111111111111111' }] })).toBe('money');
    expect(
      detectPage({ ...page, fields: [{ ...hiddenCard, value: '4111111111111111', form: 1 }] }),
    ).toBeUndefined();
    // a place-order or pay control is money whatever the fields
    expect(detectPage({ ...page, fields: [], target: { label: 'Place order', attrs: '', form: 1 } })).toBe(
      'money',
    );
  });
});
