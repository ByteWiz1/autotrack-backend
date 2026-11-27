
import crypto from 'node:crypto';
import { supabase } from '../config/supabase.js';

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

const ACCOUNT_EVENTS = [
  'low_balance',
  'topup_succeeded'
];

const logError = (context, error) => {
  console.error(
    `[SMS Webhook Processor] ${context}:`,
    error?.message || error
  );
};

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

const findSmsLog = async (data) => {
  const identifiers = getGatewayIdentifiers(data);

  for (const identifier of identifiers) {
    const { data: log, error } = await supabase
      .from('sms_logs')
      .select('*')
      .eq('gateway_message_id', identifier)
      .maybeSingle();

    if (error) throw error;
    if (log) return log;
  }

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

  const { data, error } = await supabase.rpc(
    'refund_sms_send',
    {
      p_log_id: log.id,
      p_shop_id: log.shop_id,
      p_idempotency_key: `autotrack-refund-${log.id}`
    }
  );

  if (error) throw error;

  if (!data?.success) {
    throw new Error(
      data?.message || 'SMS wallet refund was not confirmed.'
    );
  }
};

const updateReminderStatus = async (log) => {
  if (!log.reminder_id) return;

  const isFailed = FAILED_STATUSES.includes(log.status);
  const isSuccessful = ['sent', 'delivered'].includes(log.status);

  if (!isFailed && !isSuccessful) return;

  const updates = {
    status: isFailed ? 'failed' : 'sent',
    worker_id: null,
    locked_until: null
  };

  if (isFailed) {
    updates.last_error = `Gateway delivery status: ${log.status}`;
  } else {
    updates.sent_at =
      log.gateway_status_at || new Date().toISOString();

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

// Reconcile using the latest accepted SMS log state.
// This also recovers a reminder update or refund that failed
// after the gateway event was already stored.
const reconcileLatestSmsLog = async (logId) => {
  const { data: latestLog, error } = await supabase
    .from('sms_logs')
    .select('*')
    .eq('id', logId)
    .maybeSingle();

  if (error) throw error;

  if (!latestLog) {
    throw new Error('SMS log disappeared during reconciliation.');
  }

  if (FAILED_STATUSES.includes(latestLog.status)) {
    await refundFailedLog(latestLog);
  }

  await updateReminderStatus(latestLog);

  return latestLog;
};

const processStoredEvent = async (event) => {
  const payload = event.payload || {};
  const data = payload.data || {};

  // Central SasuSync account events never affect garage wallets.
  if (ACCOUNT_EVENTS.includes(event.event_type)) {
    console.log(
      '[SMS Webhook Processor] Account event:',
      event.event_type
    );

    return {
      ignored: true,
      reason: 'account_event'
    };
  }

  const status = String(
    data.status || event.event_type
  ).toLowerCase();

  if (!DELIVERY_STATUSES.includes(status)) {
    return {
      ignored: true,
      reason: 'unsupported_status'
    };
  }

  const timestamp = Date.parse(payload.timestamp);

  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid provider event timestamp.');
  }

  const log = await findSmsLog(data);

  if (!log) {
    throw new Error('SMS reservation not found yet.');
  }

  const gatewayIdentifier =
    log.gateway_message_id ||
    data.task_id ||
    data.message_id;

  if (
    typeof gatewayIdentifier !== 'string' ||
    !gatewayIdentifier.trim()
  ) {
    throw new Error('No gateway identifier is available.');
  }

  const { data: rpcResult, error: rpcError } =
    await supabase.rpc('apply_sms_gateway_event', {
      p_log_id: log.id,
      p_gateway_message_id: gatewayIdentifier,
      p_status: status,
      p_event_at: new Date(timestamp).toISOString(),
      p_gateway_response: payload
    });

  if (rpcError) throw rpcError;

  if (!rpcResult || typeof rpcResult.applied !== 'boolean') {
    throw new Error('Invalid gateway event RPC response.');
  }

  if (
    !rpcResult.applied &&
    !['duplicate_or_stale'].includes(rpcResult.reason)
  ) {
    throw new Error(
      `Gateway event was not applied: ${
        rpcResult.reason || 'unknown reason'
      }`
    );
  }

  // For a stale event, reconcile only against the latest stored
  // SMS log state, never against the stale event's status.
  const latestLog = await reconcileLatestSmsLog(log.id);

  return {
    ignored: !rpcResult.applied,
    reason: rpcResult.reason || null,
    status: latestLog.status,
    applied: rpcResult.applied
  };
};

const retryDelaySeconds = (attempts) => {
  return Math.min(
    3600,
    30 * (2 ** Math.max(0, attempts - 1))
  );
};

const finishEvent = async (
  event,
  workerId,
  outcome,
  errorMessage = null
) => {
  const { data, error } = await supabase.rpc(
    'finish_sms_webhook_event',
    {
      p_event_id: event.id,
      p_worker_id: workerId,
      p_outcome: outcome,
      p_error: errorMessage,
      p_retry_seconds: retryDelaySeconds(event.attempts)
    }
  );

  if (error) throw error;

  if (data !== true) {
    throw new Error(
      'Webhook event lease expired or is no longer owned by this worker.'
    );
  }
};

export const processSasuSyncWebhookEvents = async (req, res) => {
  const workerId = crypto.randomUUID();

  try {
    const batchSize = 5;
    const leaseSeconds = 900;

    const { data: events, error } = await supabase.rpc(
      'claim_sms_webhook_events',
      {
        p_worker_id: workerId,
        p_batch_size: batchSize,
        p_lease_seconds: leaseSeconds
      }
    );

    if (error) throw error;

    const results = {
      claimed: events?.length || 0,
      completed: 0,
      retried: 0,
      ignored: 0,
      leaseLost: 0
    };

    for (const event of events || []) {
      let ownershipConfirmed = false;

      try {
        // Renew and confirm ownership before processing.
        const { data: renewed, error: renewError } =
          await supabase.rpc('renew_sms_webhook_event', {
            p_event_id: event.id,
            p_worker_id: workerId,
            p_lease_seconds: leaseSeconds
          });

        if (renewError) throw renewError;

        if (renewed !== true) {
          results.leaseLost++;
          continue;
        }

        ownershipConfirmed = true;

        const outcome = await processStoredEvent(event);

        await finishEvent(
          event,
          workerId,
          'completed'
        );

        ownershipConfirmed = false;
        results.completed++;

        if (outcome.ignored) {
          results.ignored++;
        }
      } catch (error) {
        logError(`Event ${event.id} failed`, error);

        // Do not attempt to finish an event when ownership
        // was never confirmed or has already been lost.
        if (!ownershipConfirmed) {
          results.leaseLost++;
          continue;
        }

        try {
          await finishEvent(
            event,
            workerId,
            'retry',
            error?.message || 'Unknown processing error'
          );

          ownershipConfirmed = false;
          results.retried++;
        } catch (finishError) {
          logError(
            `Could not release event ${event.id}`,
            finishError
          );

          results.leaseLost++;
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook processing batch completed.',
      results
    });
  } catch (error) {
    logError('Batch processing failed', error);

    return res.status(500).json({
      success: false,
      error: 'Webhook processing batch failed.'
    });
  }
};
