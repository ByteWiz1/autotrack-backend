
import crypto from 'node:crypto';
import { supabase } from '../config/supabase.js';

const logError = (context, error) => {
  console.error(
    `[SMS Webhook] ${context}:`,
    error?.message || error
  );
};

const DELIVERY_STATUSES = [
  'sent',
  'delivered',
  'failed',
  'rejected',
  'undelivered',
  'expired'
];

const getGatewayIdentifiers = (data = {}) => {
  return [
    data.task_id,
    data.message_id
  ].filter(
    (value, index, values) =>
      typeof value === 'string' &&
      value.trim() &&
      values.indexOf(value) === index
  );
};

const verifySignature = (rawBody, signature, secret) => {
  if (
    !Buffer.isBuffer(rawBody) ||
    typeof signature !== 'string' ||
    !secret
  ) {
    return false;
  }

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest();

  const supplied = Buffer.from(signature, 'hex');

  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(expected, supplied)
  );
};

const findExistingEvent = async (eventHash) => {
  const { data, error } = await supabase
    .from('sms_webhook_events')
    .select('id')
    .eq('provider', 'sasusync')
    .eq('event_hash', eventHash)
    .maybeSingle();

  if (error) throw error;

  return data;
};

export const handleSasuSyncWebhook = async (req, res) => {
  try {
    const secret = process.env.SASUSYNC_WEBHOOK_SECRET;
    const signature = req.get('X-Webhook-Signature');

    if (!secret) {
      return res.status(503).json({
        success: false,
        error: 'Webhook verification is not configured.'
      });
    }

    if (!verifySignature(req.body, signature, secret)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook signature.'
      });
    }

    let payload;

    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON payload.'
      });
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook payload.'
      });
    }

    const event = payload.event;
    const data = payload.data || {};

    if (
      typeof event !== 'string' ||
      !event.trim() ||
      typeof data !== 'object' ||
      Array.isArray(data)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook event or data.'
      });
    }

    const status = String(
      data.status || event
    ).toLowerCase();

    const isAccountEvent = [
      'low_balance',
      'topup_succeeded'
    ].includes(event);

    const isDeliveryEvent =
      DELIVERY_STATUSES.includes(status);

    if (isDeliveryEvent) {
      const identifiers = getGatewayIdentifiers(data);
      const metadata = data.metadata || {};

      if (
        identifiers.length === 0 &&
        !(
          metadata.reminder_id &&
          (metadata.shop_id || metadata.mechanic_id)
        )
      ) {
        return res.status(400).json({
          success: false,
          error: 'Missing gateway identifier and reservation metadata.'
        });
      }
    }

    if (isDeliveryEvent) {
  const eventTimestamp = Date.parse(payload.timestamp);

  if (!Number.isFinite(eventTimestamp)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid webhook timestamp.'
    });
  }
}

    // SHA-256 of the exact original request body.
    const eventHash = crypto
      .createHash('sha256')
      .update(req.body)
      .digest('hex');

    const identifiers = getGatewayIdentifiers(data);

    const record = {
      provider: 'sasusync',
      event_hash: eventHash,
      event_type: event,
      gateway_message_id: identifiers[0] || null,
      provider_timestamp_text:
        typeof payload.timestamp === 'string'
          ? payload.timestamp
          : null,
      payload,
      status: 'pending'
    };

    const { error: insertError } = await supabase
      .from('sms_webhook_events')
      .insert(record);

    if (insertError) {
      // Only a confirmed duplicate is acknowledged as already received.
      if (insertError.code === '23505') {
        const existing = await findExistingEvent(eventHash);

        if (existing) {
          return res.status(200).json({
            success: true,
            received: true,
            duplicate: true
          });
        }
      }

      throw insertError;
    }

    console.log('[SMS Webhook] Event durably stored:', {
      event,
      accountEvent: isAccountEvent,
      deliveryEvent: isDeliveryEvent,
      eventHash
    });

    return res.status(200).json({
      success: true,
      received: true,
      duplicate: false
    });
  } catch (error) {
    logError('Webhook persistence failed', error);

    return res.status(500).json({
      success: false,
      error: 'Webhook could not be stored.'
    });
  }
};
