function validatePayment(order, transaction) {
  return (
    transaction.status === 'success' &&
    transaction.reference === order.reference &&
    Number(transaction.amount) === order.amount_kobo &&
    transaction.currency === order.currency &&
    Number.isSafeInteger(Number(transaction.id)) &&
    Number(transaction.id) > 0
  );
}

const order = {
  reference: 'AT-TEST-REFERENCE',
  amount_kobo: 3590,
  currency: 'GHS'
};

const tests = [
  {
    name: 'Correct payment details',
    transaction: {
      status: 'success',
      reference: 'AT-TEST-REFERENCE',
      amount: 3590,
      currency: 'GHS',
      id: 123456
    },
    expected: true
  },
  {
    name: 'Incorrect payment amount',
    transaction: {
      status: 'success',
      reference: 'AT-TEST-REFERENCE',
      amount: 1000,
      currency: 'GHS',
      id: 123457
    },
    expected: false
  },
  {
    name: 'Incorrect currency',
    transaction: {
      status: 'success',
      reference: 'AT-TEST-REFERENCE',
      amount: 3590,
      currency: 'USD',
      id: 123458
    },
    expected: false
  },
  {
    name: 'Incorrect reference',
    transaction: {
      status: 'success',
      reference: 'AT-WRONG-REFERENCE',
      amount: 3590,
      currency: 'GHS',
      id: 123459
    },
    expected: false
  }
];

for (const test of tests) {
  const actual = validatePayment(order, test.transaction);
  const passed = actual === test.expected;

  console.log(
    `${passed ? 'PASS' : 'FAIL'}: ${test.name}`
  );
}