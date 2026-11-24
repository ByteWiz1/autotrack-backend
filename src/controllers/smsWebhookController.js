
import crypto from 'node:crypto';
import { supabase } from '../config/supabase.js';

const logError = (context, error) => {
  console.error(`[SMS Webhook] ${context}:`, error?.message || error);
};

const DELIVERY_STATUSES = [
  'sent',
  'delivered',
  'failed',
  'rejected',
  'undelivered',
  'expired'
];

const FAILED_STATUSES = [
  'failed',
  'rejected',
  'undelivered',
  'expired'
];

const verifySignature = (rawBody, signature, secret) => {
  if (
    !Buffer.isBuffer(rawBody) ||
    typeof signature !== 'string' ||
    !secret
  ) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest();

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const supplied = Buffer.from(signature, 'hex');

  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected)
  );
};

// SasuSync documents task_id as the delivery lookup identifier.
// Its webhook example names the corresponding field message_id.
// Accept both names without assuming they are different identifiers.
const getGatewayIdentifiers = (data) => {
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

const findSmsLog = async (data) => {
  const identifiers = getGatewayIdentifiers(data);

  // First try the provider's task/message identifier.
  for (const identifier of identifiers) {
    const { data: log, error } = await supabase
      .from('sms_logs')
      .select('*')
      .eq('gateway_message_id', identifier)
      .maybeSingle();

    if (error) throw error;
    if (log) return log;
  }

  // Metadata is the fallback if the provider identifier
  // cannot yet be matched to the stored reservation.
  const metadata = data.metadata || {};
  const reminderId = metadata.reminder_id;
  const shopId = metadata.shop_id || metadata.mechanic_id;

  if (reminderId && shopId) {
    const { data: log, error } = await supabase
      .from('sms_logs')
      .select('*')
      .eq('reminder_id', reminderId)
      .eq('shop_id', shopId)
      .maybeSingle();

    if (error) throw error;
    if (log) return log;
  }

  return null;
};

const refundFailedLog = async (log) => {
  if (!log || log.refunded_at) return;
  if (!FAILED_STATUSES.includes(log.status)) return;

  const { data, error } = await supabase.rpc('refund_sms_send', {
    p_log_id: log.id,
    p_shop_id: log.shop_id,
    p_idempotency_key: `autotrack-refund-${log.id}`
  });

  if (error) throw error;

  if (!data?.success) {
    throw new Error(
      data?.message || 'SMS wallet refund was not confirmed.'
    );
  }
};

const updateReminderStatus = async (log, status) => {
  if (!log.reminder_id) return;

  const isFailed = FAILED_STATUSES.includes(status);

  const updates = {
    status: isFailed ? 'failed' : 'sent',
    worker_id: null,
    locked_until: null
  };

  if (isFailed) {
    updates.last_error = `Gateway delivery status: ${status}`;
  } else {
    updates.sent_at = new Date().toISOString();
    updates.last_error = null;
  }

  const { error } = await supabase
    .from('sms_reminders')
    .update(updates)
    .eq('id', log.reminder_id)
    .eq('shop_id', log.shop_id)
    .in('status', ['pending', 'processing', 'sent']);

  if (error) throw error;
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

    const event = payload?.event;
    const data = payload?.data || {};

    if (!event || typeof event !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing webhook event.'
      });
    }

    // These events relate to the central SasuSync account,
    // not an individual mechanic's SMS wallet.
    if (['low_balance', 'topup_succeeded'].includes(event)) {
      console.log(`[SMS Webhook] Account event received: ${event}`);

      return res.status(200).json({
        success: true,
        received: true
      });
    }

    const status = String(data.status || event).toLowerCase();

    if (!DELIVERY_STATUSES.includes(status)) {
      return res.status(200).json({
        success: true,
        received: true,
        ignored: true
      });
    }

    const identifiers = getGatewayIdentifiers(data);
    const metadata = data.metadata || {};

    if (
      identifiers.length === 0 &&
      !(metadata.reminder_id && (metadata.shop_id || metadata.mechanic_id))
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing gateway identifier and reservation metadata.'
      });
    }

    const eventTimestamp = Date.parse(payload.timestamp);

    if (!Number.isFinite(eventTimestamp)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook timestamp.'
      });
    }

    const log = await findSmsLog(data);

    if (!log) {
      // A temporary failure allows the provider to retry
      // if the webhook arrives before the reservation is available.
      return res.status(503).json({
        success: false,
        error: 'SMS reservation not found yet.'
      });
    }

    // Preserve the task ID returned by the original send request.
    // Do not replace it with a different identifier from a webhook.
    const gatewayIdentifier =
      log.gateway_message_id ||
      data.task_id ||
      data.message_id;

    if (!gatewayIdentifier) {
      throw new Error('No gateway identifier is available for this SMS log.');
    }

    const { data: result, error: rpcError } = await supabase.rpc(
      'apply_sms_gateway_event',
      {
        p_log_id: log.id,
        p_gateway_message_id: gatewayIdentifier,
        p_status: status,
        p_event_at: new Date(eventTimestamp).toISOString(),
        p_gateway_response: payload
      }
    );

    if (rpcError) throw rpcError;

    const { data: latestLog, error: reloadError } = await supabase
      .from('sms_logs')
      .select('*')
      .eq('id', log.id)
      .maybeSingle();

    if (reloadError) throw reloadError;

    if (!latestLog) {
      throw new Error('SMS log disappeared after webhook update.');
    }

    if (FAILED_STATUSES.includes(latestLog.status)) {
      await refundFailedLog(latestLog);
      await updateReminderStatus(latestLog, latestLog.status);
    } else if (['sent', 'delivered'].includes(latestLog.status)) {
      await updateReminderStatus(latestLog, latestLog.status);
    }

    console.log('[SMS Webhook] Event processed:', {
      event,
      gatewayIdentifier,
      status,
      applied: result?.applied,
      reason: result?.reason
    });

    return res.status(200).json({
      success: true,
      received: true,
      applied: result?.applied === true
    });
  } catch (error) {
    logError('Webhook processing failed', error);

    return res.status(500).json({
      success: false,
      error: 'Webhook processing failed.'
    });
  }
};
