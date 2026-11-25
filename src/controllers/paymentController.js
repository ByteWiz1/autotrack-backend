
import {
  randomBytes,
  createHmac,
  timingSafeEqual
} from 'node:crypto';

import { supabase } from '../config/supabase.js';

// Server-controlled SMS packages.
// Prices are in pesewas (GHp).
const SMS_PACKAGES = {
  pkg_547: {
    credits: 547,
    amountKobo: 3590
  },
  pkg_1095: {
    credits: 1095,
    amountKobo: 7183
  },
  pkg_2191: {
    credits: 2191,
    amountKobo: 14369
  },
  pkg_3287: {
    credits: 3287,
    amountKobo: 21555
  },
  pkg_5479: {
    credits: 5479,
    amountKobo: 35926
  },
  pkg_13800: {
    credits: 13800,
    amountKobo: 90113
  },
  pkg_28860: {
    credits: 28860,
    amountKobo: 183889
  }
};

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function getPaystackSecret() {
  return process.env.PAYSTACK_SECRET_KEY;
}

function generatePaymentReference() {
  return `AT-${Date.now()}-${randomBytes(6)
    .toString('hex')
    .toUpperCase()}`;
}

// GET /api/payments/packages
export const getSmsPackages = async (req, res) => {
  const packages = Object.entries(SMS_PACKAGES).map(
    ([packageId, item]) => ({
      packageId,
      credits: item.credits,
      amountKobo: item.amountKobo,
      amountGhs: (item.amountKobo / 100).toFixed(2),
      currency: 'GHS'
    })
  );

  return res.json({
    success: true,
    packages
  });
};

// POST /api/payments/initialize
export const initializeSmsPayment = async (req, res) => {
  try {
    const secretKey = getPaystackSecret();

    if (!secretKey) {
      return res.status(500).json({
        success: false,
        message: 'Payment service is not configured.'
      });
    }

    const shopId = req.shop?.id;
    const { packageId } = req.body || {};

    if (!shopId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.'
      });
    }

    const selectedPackage = SMS_PACKAGES[packageId];

    if (!selectedPackage) {
      return res.status(400).json({
        success: false,
        message: 'Invalid SMS package selected.'
      });
    }

    // Retrieve the authenticated garage's account details.
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('id, shop_name, email')
      .eq('id', shopId)
      .single();

    if (shopError || !shop) {
      console.error('Payment shop lookup failed:', shopError);

      return res.status(404).json({
        success: false,
        message: 'Garage account not found.'
      });
    }

    if (!shop.email) {
      return res.status(400).json({
        success: false,
        message: 'Add an account email before purchasing SMS credits.'
      });
    }

    const reference = generatePaymentReference();

    // Create the pending order BEFORE contacting Paystack.
    const { error: orderError } = await supabase
      .from('sms_payment_orders')
      .insert({
        shop_id: shop.id,
        reference,
        credits: selectedPackage.credits,
        amount_kobo: selectedPackage.amountKobo,
        currency: 'GHS',
        status: 'pending'
      });

    if (orderError) {
      console.error('Payment order creation failed:', orderError);

      return res.status(500).json({
        success: false,
        message: 'Unable to create payment order.'
      });
    }

    const paymentPayload = {
      email: shop.email,
      amount: selectedPackage.amountKobo,
      currency: 'GHS',
      reference,
      metadata: {
        shop_id: shop.id,
        shop_name: shop.shop_name,
        credits: selectedPackage.credits,
        package_id: packageId
      }
    };

    // Optional callback URL, configured through environment variables.
    if (process.env.PAYSTACK_CALLBACK_URL) {
      paymentPayload.callback_url =
        process.env.PAYSTACK_CALLBACK_URL;
    }

    // Initialize checkout directly with Paystack.
    const paystackResponse = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(paymentPayload)
      }
    );

    const paystackResult = await paystackResponse.json();

    if (!paystackResponse.ok || !paystackResult.status) {
      console.error(
        'Paystack initialization rejected:',
        paystackResult
      );

      await supabase
        .from('sms_payment_orders')
        .update({
          status: 'failed',
          failure_reason: 'Paystack initialization failed.',
          updated_at: new Date().toISOString()
        })
        .eq('reference', reference)
        .eq('status', 'pending');

      return res.status(502).json({
        success: false,
        message: 'Paystack could not initialize this payment.'
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Payment initialized successfully.',
      reference,
      authorizationUrl: paystackResult.data.authorization_url,
      accessCode: paystackResult.data.access_code
    });

  } catch (error) {
    console.error('Initialize payment error:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred while initializing payment.'
    });
  }
};

// GET /api/payments/verify/:reference
export const verifySmsPayment = async (req, res) => {
  try {
    const secretKey = getPaystackSecret();

    if (!secretKey) {
      return res.status(500).json({
        success: false,
        message: 'Payment service is not configured.'
      });
    }

    const shopId = req.shop?.id;
    const { reference } = req.params;

    if (!shopId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.'
      });
    }

    if (!reference || reference.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment reference.'
      });
    }

    // Find the order belonging to this authenticated garage.
    const { data: order, error: orderError } = await supabase
      .from('sms_payment_orders')
      .select(
        'id, shop_id, reference, credits, amount_kobo, currency, status, paystack_transaction_id'
      )
      .eq('reference', reference)
      .eq('shop_id', shopId)
      .maybeSingle();

    if (orderError) {
      console.error('Payment order lookup failed:', orderError);

      return res.status(500).json({
        success: false,
        message: 'Unable to retrieve payment order.'
      });
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Payment order not found.'
      });
    }

    // An already-paid order must never be credited again.
    if (order.status === 'paid') {
      return res.json({
        success: true,
        alreadyPaid: true,
        reference: order.reference,
        credits: order.credits,
        message: 'This payment has already been processed.'
      });
    }

    if (order.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: 'This payment order is no longer pending.',
        paymentStatus: order.status
      });
    }

    // Verify the transaction directly with Paystack.
    const verifyResponse = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const verifyResult = await verifyResponse.json();

    if (!verifyResponse.ok || !verifyResult.status) {
      console.error('Paystack verification request failed:', verifyResult);

      return res.status(502).json({
        success: false,
        message: 'Unable to verify payment with Paystack.'
      });
    }

    const transaction = verifyResult.data;

    // Do not credit pending, failed, or otherwise unsuccessful payments.
    if (transaction.status !== 'success') {
      return res.status(409).json({
        success: false,
        message: 'Payment has not been completed successfully.',
        paymentStatus: transaction.status
      });
    }

    // Match every critical value against our stored order.
    if (
      transaction.reference !== order.reference ||
      Number(transaction.amount) !== order.amount_kobo ||
      transaction.currency !== order.currency ||
      !Number.isSafeInteger(Number(transaction.id)) ||
      Number(transaction.id) <= 0
    ) {
      console.error('Paystack transaction does not match order:', {
        reference,
        verifiedReference: transaction.reference,
        verifiedAmount: transaction.amount,
        expectedAmount: order.amount_kobo,
        verifiedCurrency: transaction.currency,
        expectedCurrency: order.currency
      });

      return res.status(400).json({
        success: false,
        message: 'Verified payment details do not match the order.'
      });
    }

    // Atomically credit the wallet and mark the order as paid.
    const { data: completionResult, error: completionError } =
      await supabase.rpc('complete_sms_payment_order', {
        p_reference: order.reference,
        p_paystack_transaction_id: Number(transaction.id),
        p_verified_amount_kobo: Number(transaction.amount),
        p_verified_currency: transaction.currency
      });

    if (completionError) {
      console.error(
        'Atomic payment completion failed:',
        completionError
      );

      return res.status(500).json({
        success: false,
        message: 'Payment was verified, but wallet processing needs attention.',
        reference: order.reference
      });
    }

    if (!completionResult?.success) {
      console.error(
        'Unexpected payment completion response:',
        completionResult
      );

      return res.status(500).json({
        success: false,
        message: 'Wallet processing could not be confirmed.',
        reference: order.reference
      });
    }

    return res.json({
      success: true,
      alreadyPaid: Boolean(completionResult.duplicate),
      reference: order.reference,
      credits: order.credits,
      walletResult: completionResult.wallet_result || null,
      message: completionResult.duplicate
        ? 'Payment was already processed.'
        : 'Payment verified and SMS credits added successfully.'
    });

  } catch (error) {
    console.error('Verify payment error:', error);

    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying payment.'
    });
  }
};


// POST /api/webhooks/paystack
// Paystack payment-success webhook.
export const handlePaystackWebhook = async (req, res) => {
  try {
    const secretKey = getPaystackSecret();

    if (!secretKey) {
      console.error('[Paystack Webhook] Secret key is not configured.');
      return res.status(503).json({ success: false });
    }

    // Paystack signature verification requires the original raw body.
    if (!Buffer.isBuffer(req.body)) {
      console.error('[Paystack Webhook] Raw request body is missing.');
      return res.status(400).json({ success: false });
    }

    const signature = req.get('x-paystack-signature');

    if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) {
      return res.status(401).json({ success: false });
    }

    const expectedSignature = createHmac('sha512', secretKey)
      .update(req.body)
      .digest();

    const suppliedSignature = Buffer.from(signature, 'hex');

    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(expectedSignature, suppliedSignature)
    ) {
      console.warn('[Paystack Webhook] Invalid signature.');
      return res.status(401).json({ success: false });
    }

    let event;

    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ success: false });
    }

    // We only process successful charges.
    if (event.event !== 'charge.success') {
      return res.status(200).json({
        success: true,
        message: 'Event ignored.'
      });
    }

    const reference = event.data?.reference;

    if (
      typeof reference !== 'string' ||
      !reference ||
      reference.length > 100
    ) {
      console.error('[Paystack Webhook] Invalid payment reference.');
      return res.status(400).json({ success: false });
    }

    // Look up the order created by AutoTrack.
    const { data: order, error: orderError } = await supabase
      .from('sms_payment_orders')
      .select(
        'id, shop_id, reference, credits, amount_kobo, currency, status'
      )
      .eq('reference', reference)
      .maybeSingle();

    if (orderError) {
      console.error('[Paystack Webhook] Order lookup failed:', orderError);
      return res.status(500).json({ success: false });
    }

    if (!order) {
      console.error('[Paystack Webhook] No matching order:', reference);

      // This reference does not belong to a known AutoTrack order.
      return res.status(200).json({
        success: true,
        message: 'No matching AutoTrack order.'
      });
    }

    // Already completed: acknowledge without crediting again.
    if (order.status === 'paid') {
      return res.status(200).json({
        success: true,
        alreadyPaid: true
      });
    }

    if (order.status !== 'pending') {
      console.warn('[Paystack Webhook] Order is not pending:', {
        reference,
        status: order.status
      });

      return res.status(200).json({
        success: true,
        message: 'Order is not pending.'
      });
    }

    // Independently verify the transaction with Paystack.
    const verifyResponse = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!verifyResponse.ok) {
      console.error(
        '[Paystack Webhook] Paystack verification HTTP error:',
        verifyResponse.status
      );
      return res.status(502).json({ success: false });
    }

    const verifyResult = await verifyResponse.json();

    if (!verifyResult.status || !verifyResult.data) {
      console.error('[Paystack Webhook] Invalid verification response.');
      return res.status(502).json({ success: false });
    }

    const transaction = verifyResult.data;

    // Confirm every critical payment value against our stored order.
    if (
      transaction.status !== 'success' ||
      transaction.reference !== order.reference ||
      Number(transaction.amount) !== order.amount_kobo ||
      transaction.currency !== order.currency ||
      !Number.isSafeInteger(Number(transaction.id)) ||
      Number(transaction.id) <= 0
    ) {
      console.error('[Paystack Webhook] Transaction/order mismatch:', {
        reference,
        transactionStatus: transaction.status,
        verifiedReference: transaction.reference,
        verifiedAmount: transaction.amount,
        expectedAmount: order.amount_kobo,
        verifiedCurrency: transaction.currency,
        expectedCurrency: order.currency
      });

      // Do not credit an unverified or mismatched transaction.
      return res.status(400).json({ success: false });
    }

    // Atomically credit the wallet and mark the order as paid.
    const { data: completionResult, error: completionError } =
      await supabase.rpc('complete_sms_payment_order', {
        p_reference: order.reference,
        p_paystack_transaction_id: Number(transaction.id),
        p_verified_amount_kobo: Number(transaction.amount),
        p_verified_currency: transaction.currency
      });

    if (completionError) {
      console.error(
        '[Paystack Webhook] Atomic payment completion failed:',
        completionError
      );

      // Non-2xx response allows Paystack to retry.
      return res.status(500).json({ success: false });
    }

    if (!completionResult?.success) {
      console.error(
        '[Paystack Webhook] Unexpected completion result:',
        completionResult
      );

      return res.status(500).json({ success: false });
    }

    console.log('[Paystack Webhook] Payment processed:', {
      reference,
      credits: order.credits,
      duplicate: Boolean(completionResult.duplicate)
    });

    return res.status(200).json({
      success: true,
      alreadyPaid: Boolean(completionResult.duplicate)
    });

  } catch (error) {
    console.error('[Paystack Webhook] Processing error:', error);
    return res.status(500).json({ success: false });
  }
};
