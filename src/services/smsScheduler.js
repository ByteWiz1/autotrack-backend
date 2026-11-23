
import crypto from 'node:crypto';
import { supabase } from '../config/supabase.js';

import {
  buildReminderMessage,
  calculateSmsSegments,
  normalizeGhanaNumber,
  sendSmsGateway
} from './smsService.js';

// A batch is processed sequentially. The longer lease prevents another
// worker from claiming reminders while the current worker is still active.
const BATCH_SIZE = 20;
const LEASE_SECONDS = 900;

// SasuSync idempotency keys are valid for 24 hours.
// Stop automatic retries before that window expires.
const MAX_SAFE_RETRY_AGE_MS = 23 * 60 * 60 * 1000;

// Provider credit exhaustion should not consume mechanic wallet credits.
// It is marked for review and refunded rather than repeatedly retried.
const DEFINITE_REJECTIONS = [400, 401, 402, 403, 404];

const logError = (context, error) => {
  console.error(
    `[SMS Scheduler] ${context}:`,
    error?.message || error
  );
};

const getIdempotencyKey = (reminderId) =>
  `autotrack-${reminderId}`;

const getRefundKey = (logId) =>
  `autotrack-refund-${logId}`;

const updateReminder = async (reminder, workerId, updates) => {
  const { data, error } = await supabase
    .from('sms_reminders')
    .update(updates)
    .eq('id', reminder.id)
    .eq('worker_id', workerId)
    .in('status', ['pending', 'processing'])
    .select('id')
    .maybeSingle();

  if (error) throw error;

  return Boolean(data);
};

const releaseReminder = async (reminderId, workerId) => {
  const { error } = await supabase.rpc('release_sms_reminder', {
    p_reminder_id: reminderId,
    p_worker_id: workerId
  });

  if (error) throw error;
};

const markReminderFailed = async (
  reminder,
  workerId,
  reason
) => {
  const updated = await updateReminder(reminder, workerId, {
    status: 'failed',
    last_error: String(
      reason || 'SMS processing failed'
    ).slice(0, 1000),
    worker_id: null,
    locked_until: null
  });

  if (!updated) {
    throw new Error(
      `Could not mark reminder ${reminder.id} as failed.`
    );
  }
};

const markReminderSent = async (reminder, workerId) => {
  const updated = await updateReminder(reminder, workerId, {
    status: 'sent',
    sent_at: new Date().toISOString(),
    last_error: null,
    worker_id: null,
    locked_until: null
  });

  if (!updated) {
    throw new Error(
      `Could not mark reminder ${reminder.id} as sent.`
    );
  }
};

const getSmsLogForReminder = async (reminder) => {
  const { data, error } = await supabase
    .from('sms_logs')
    .select('*')
    .eq('shop_id', reminder.shop_id)
    .eq('reminder_id', reminder.id)
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  return data;
};

const getSmsLogById = async (logId) => {
  const { data, error } = await supabase
    .from('sms_logs')
    .select('*')
    .eq('id', logId)
    .maybeSingle();

  if (error) throw error;

  return data;
};

const refundFailedLog = async (log) => {
  if (!log || log.refunded_at) {
    return {
      success: true,
      alreadyRefunded: true
    };
  }

  const refundableStatuses = [
    'failed',
    'rejected',
    'undelivered',
    'expired'
  ];

  if (!refundableStatuses.includes(log.status)) {
    return {
      success: false,
      reason: 'SMS log is not in a refundable status.'
    };
  }

  const { data, error } = await supabase.rpc(
    'refund_sms_send',
    {
      p_log_id: log.id,
      p_shop_id: log.shop_id,
      p_idempotency_key: getRefundKey(log.id)
    }
  );

  if (error) throw error;

  if (!data?.success) {
    throw new Error(
      data?.message || 'SMS wallet refund was not confirmed.'
    );
  }

  return {
    success: true,
    alreadyRefunded: data.duplicate === true
  };
};

// Only recover a reminder if it is still processing under the
// same worker and its lease has genuinely expired.
const updateExpiredReminder = async (
  reminder,
  updates,
  now
) => {
  const { data, error } = await supabase
    .from('sms_reminders')
    .update(updates)
    .eq('id', reminder.id)
    .eq('status', 'processing')
    .eq('worker_id', reminder.worker_id)
    .lt('locked_until', now)
    .select('id')
    .maybeSingle();

  if (error) throw error;

  return Boolean(data);
};

// Recover reminders left processing after a worker interruption.
const recoverInterruptedReminders = async () => {
  const now = new Date().toISOString();

  const { data: reminders, error } = await supabase
    .from('sms_reminders')
    .select('id, shop_id, status, worker_id, locked_until')
    .eq('status', 'processing')
    .not('locked_until', 'is', null)
    .lt('locked_until', now)
    .limit(100);

  if (error) throw error;

  let recovered = 0;
  let manualReview = 0;

  for (const reminder of reminders || []) {
    try {
      const log = await getSmsLogForReminder(reminder);

      // No wallet reservation was created. Safely return the
      // reminder to the pending queue.
      if (!log) {
        const updated = await updateExpiredReminder(
          reminder,
          {
            status: 'pending',
            worker_id: null,
            locked_until: null,
            last_error: null
          },
          now
        );

        if (updated) recovered++;
        continue;
      }

      // A queued or accepted message must never be sent again.
      if (
        ['queued', 'sent', 'delivered'].includes(log.status)
      ) {
        const updated = await updateExpiredReminder(
          reminder,
          {
            status: 'sent',
            sent_at: new Date().toISOString(),
            last_error: null,
            worker_id: null,
            locked_until: null
          },
          now
        );

        if (updated) recovered++;
        continue;
      }

      // Refund only confirmed gateway failures.
      if (
        ['failed', 'rejected', 'undelivered', 'expired'].includes(
          log.status
        )
      ) {
        await refundFailedLog(log);

        const updated = await updateExpiredReminder(
          reminder,
          {
            status: 'failed',
            last_error: `Gateway status: ${log.status}`,
            worker_id: null,
            locked_until: null
          },
          now
        );

        if (updated) recovered++;
        continue;
      }

      if (log.status === 'reserved') {
        const age = Date.now() - new Date(log.created_at).getTime();

        // Retry using the SAME saved idempotency key while
        // the provider's 24-hour protection window is valid.
        if (
          Number.isFinite(age) &&
          age >= 0 &&
          age <= MAX_SAFE_RETRY_AGE_MS
        ) {
          const updated = await updateExpiredReminder(
            reminder,
            {
              status: 'pending',
              worker_id: null,
              locked_until: null,
              last_error: null
            },
            now
          );

          if (updated) recovered++;
          continue;
        }

        const updated = await updateExpiredReminder(
          reminder,
          {
            status: 'failed',
            last_error:
              'Manual review required: SMS gateway outcome is uncertain.',
            worker_id: null,
            locked_until: null
          },
          now
        );

        if (updated) manualReview++;
        continue;
      }

      logError(
        `Unexpected SMS log status for reminder ${reminder.id}`,
        new Error(String(log.status))
      );
    } catch (error) {
      logError(
        `Could not recover reminder ${reminder.id}`,
        error
      );
    }
  }

  return {
    recovered,
    manualReview
  };
};

const processReminder = async (reminder, workerId) => {
  let currentLog = null;

  try {
    // Do not reserve wallet credits if provider configuration
    // is missing.
    if (
      !process.env.SASUSYNC_API_KEY ||
      !process.env.SASUSYNC_SENDER_ID
    ) {
      await releaseReminder(reminder.id, workerId);

      return {
        success: false,
        reason: 'SasuSync configuration is missing.'
      };
    }

    const { data: vehicle, error: vehicleError } =
      await supabase
        .from('vehicles')
        .select('*')
        .eq('id', reminder.vehicle_id)
        .eq('shop_id', reminder.shop_id)
        .maybeSingle();

    if (vehicleError) throw vehicleError;

    if (!vehicle) {
      await markReminderFailed(
        reminder,
        workerId,
        'Vehicle record was not found.'
      );

      return {
        success: false,
        reason: 'Vehicle not found.'
      };
    }

    if (!vehicle.owner_phone) {
      await markReminderFailed(
        reminder,
        workerId,
        'Customer mobile number is missing.'
      );

      return {
        success: false,
        reason: 'Missing phone number.'
      };
    }

    const { data: shop, error: shopError } =
      await supabase
        .from('shops')
        .select('id, shop_name')
        .eq('id', reminder.shop_id)
        .maybeSingle();

    if (shopError) throw shopError;

    if (!shop) {
      await markReminderFailed(
        reminder,
        workerId,
        'Shop record was not found.'
      );

      return {
        success: false,
        reason: 'Shop not found.'
      };
    }

    const recipient = normalizeGhanaNumber(
      vehicle.owner_phone
    );

    // Always check for an existing reservation first.
    currentLog = await getSmsLogForReminder(reminder);

    let message;
    let segmentInfo;
    let idempotencyKey;

    if (currentLog) {
      idempotencyKey = currentLog.idempotency_key;

      if (!idempotencyKey) {
        await markReminderFailed(
          reminder,
          workerId,
          'Existing SMS reservation has no idempotency key.'
        );

        return {
          success: false,
          reason: 'Missing idempotency key.'
        };
      }

      if (
        ['queued', 'sent', 'delivered'].includes(currentLog.status)
      ) {
        await markReminderSent(reminder, workerId);

        return {
          success: true,
          alreadySent: true
        };
      }

      if (
        ['failed', 'rejected', 'undelivered', 'expired'].includes(
          currentLog.status
        )
      ) {
        await refundFailedLog(currentLog);

        await markReminderFailed(
          reminder,
          workerId,
          `Previous gateway status: ${currentLog.status}`
        );

        return {
          success: false,
          reason: currentLog.status
        };
      }

      if (currentLog.status !== 'reserved') {
        await markReminderFailed(
          reminder,
          workerId,
          `Unsupported SMS log status: ${currentLog.status}`
        );

        return {
          success: false,
          reason: 'Unsupported log status.'
        };
      }

      const reservationAge =
        Date.now() - new Date(currentLog.created_at).getTime();

      if (
        !Number.isFinite(reservationAge) ||
        reservationAge < 0 ||
        reservationAge > MAX_SAFE_RETRY_AGE_MS
      ) {
        await markReminderFailed(
          reminder,
          workerId,
          'Manual review required: previous gateway outcome is uncertain.'
        );

        return {
          success: false,
          reason: 'Manual review required.'
        };
      }

      // Never rebuild the message during a retry.
      // Reuse the exact original content and recipient.
      message = currentLog.message_body;
      segmentInfo = calculateSmsSegments(message);

      if (
        currentLog.recipient !== recipient ||
        currentLog.encoding !== segmentInfo.encoding ||
        currentLog.segments !== segmentInfo.segments ||
        currentLog.credit_cost !== segmentInfo.segments
      ) {
        await markReminderFailed(
          reminder,
          workerId,
          'Existing reservation does not match the current customer or message.'
        );

        return {
          success: false,
          reason: 'Reservation mismatch.'
        };
      }
    } else {
      message = buildReminderMessage({
        reminderType: reminder.reminder_type,
        shopName: shop.shop_name,
        vehicle
      });

      segmentInfo = calculateSmsSegments(message);
      idempotencyKey = getIdempotencyKey(reminder.id);

      const { data: reservation, error: reservationError } =
        await supabase.rpc('reserve_sms_send', {
          p_shop_id: reminder.shop_id,
          p_vehicle_id: reminder.vehicle_id,
          p_reminder_id: reminder.id,
          p_recipient: recipient,
          p_message_body: message,
          p_encoding: segmentInfo.encoding,
          p_segments: segmentInfo.segments,
          p_idempotency_key: idempotencyKey
        });

      if (reservationError) throw reservationError;

      if (reservation?.insufficient_credits) {
        await releaseReminder(reminder.id, workerId);

        return {
          success: false,
          insufficientCredits: true,
          required: reservation.required,
          available: reservation.available
        };
      }

      if (!reservation?.success || !reservation.log_id) {
        throw new Error(
          reservation?.message ||
          'SMS wallet reservation failed.'
        );
      }

      // Set this immediately. If fetching the log fails, the catch
      // handler must know that a wallet reservation may exist.
      currentLog = {
        id: reservation.log_id,
        shop_id: reminder.shop_id,
        reminder_id: reminder.id,
        status: 'reserved',
        idempotency_key: idempotencyKey
      };

      currentLog = await getSmsLogForReminder(reminder);

      if (!currentLog) {
        throw new Error(
          'SMS reservation was created but its log could not be retrieved.'
        );
      }

      if (currentLog.status !== 'reserved') {
        if (
          ['queued', 'sent', 'delivered'].includes(currentLog.status)
        ) {
          await markReminderSent(reminder, workerId);

          return {
            success: true,
            alreadySent: true
          };
        }

        throw new Error(
          `Unexpected reservation status: ${currentLog.status}`
        );
      }
    }

    const gatewayResult = await sendSmsGateway({
      recipient: currentLog.recipient,
      message: currentLog.message_body,
      idempotencyKey: currentLog.idempotency_key,
      shopId: reminder.shop_id,
      reminderId: reminder.id
    });

    const gatewayStatus =
      gatewayResult.status === 'sent' ? 'sent' : 'queued';

    // Confirm the log update actually affected a row.
    const { data: updatedLog, error: logUpdateError } =
      await supabase
        .from('sms_logs')
        .update({
          gateway_message_id: gatewayResult.gatewayMessageId,
          status: gatewayStatus,
          gateway_response: gatewayResult.gatewayResponse
        })
        .eq('id', currentLog.id)
        .eq('status', 'reserved')
        .select('id, status, gateway_message_id')
        .maybeSingle();

    if (logUpdateError) throw logUpdateError;

    if (!updatedLog) {
      // A webhook or another process may have changed the log
      // while the provider request was being completed.
      const latestLog = await getSmsLogById(currentLog.id);

      if (!latestLog) {
        throw new Error(
          'SMS log disappeared after gateway acceptance.'
        );
      }

      if (
        ['queued', 'sent', 'delivered'].includes(latestLog.status)
      ) {
        await markReminderSent(reminder, workerId);

        return {
          success: true,
          alreadySent: true,
          status: latestLog.status
        };
      }

      if (
        ['failed', 'rejected', 'undelivered', 'expired'].includes(
          latestLog.status
        )
      ) {
        await refundFailedLog(latestLog);

        await markReminderFailed(
          reminder,
          workerId,
          `Gateway status: ${latestLog.status}`
        );

        return {
          success: false,
          reason: latestLog.status
        };
      }

      throw new Error(
        `SMS log update was not confirmed. Current status: ${latestLog.status}`
      );
    }

    await markReminderSent(reminder, workerId);

    return {
      success: true,
      status: gatewayStatus,
      segments: segmentInfo.segments
    };
  } catch (error) {
    logError(
      `Reminder ${reminder.id} failed`,
      error
    );

    // These HTTP responses are treated as definite provider
    // rejections. A timeout, 409, 422, 429 or server error is
    // NOT automatically refunded because the outcome may be uncertain.
    const definiteRejection = DEFINITE_REJECTIONS.includes(
      error.status
    );

    if (currentLog && definiteRejection) {
      try {
        const { data: updatedLog, error: logUpdateError } =
          await supabase
            .from('sms_logs')
            .update({
              status: 'failed',
              gateway_response: error.gatewayResponse || {
                error: error.message
              }
            })
            .eq('id', currentLog.id)
            .eq('status', 'reserved')
            .select('id')
            .maybeSingle();

        if (logUpdateError) throw logUpdateError;

        const refreshedLog = await getSmsLogById(
          currentLog.id
        );

        if (!refreshedLog) {
          throw new Error(
            'Could not retrieve SMS log after provider rejection.'
          );
        }

        // Never refund if another process has already recorded
        // a successful or uncertain gateway outcome.
        if (
          !['failed', 'rejected'].includes(refreshedLog.status)
        ) {
          if (
            ['queued', 'sent', 'delivered'].includes(
              refreshedLog.status
            )
          ) {
            await markReminderSent(reminder, workerId);

            return {
              success: true,
              alreadySent: true,
              status: refreshedLog.status
            };
          }

          throw new Error(
            `Cannot refund SMS log with status ${refreshedLog.status}.`
          );
        }

        await refundFailedLog(refreshedLog);

        await markReminderFailed(
          reminder,
          workerId,
          error.message
        );

        return {
          success: false,
          rejected: true,
          refunded: true,
          reason: error.message
        };
      } catch (refundError) {
        logError(
          `Could not complete rejection/refund for ${reminder.id}`,
          refundError
        );

        // Leave it for recovery. Never silently release a
        // reservation when its refund has not been confirmed.
        return {
          success: false,
          refundPending: true,
          reason: refundError.message
        };
      }
    }

    // Before reservation, release the claim for a safe retry.
    if (!currentLog) {
      try {
        await releaseReminder(
          reminder.id,
          workerId
        );
      } catch (releaseError) {
        logError(
          `Could not release reminder ${reminder.id}`,
          releaseError
        );
      }
    }

    // After reservation, keep the reminder processing.
    // Recovery will inspect the existing log and reuse its
    // original idempotency key if a retry is safe.
    return {
      success: false,
      uncertain: Boolean(currentLog),
      reason: error.message
    };
  }
};

export const runSmsSchedulerBatch = async () => {
  const workerId = crypto.randomUUID();

  const recovery = await recoverInterruptedReminders();

  const { data: reminders, error } = await supabase.rpc(
    'claim_sms_reminders',
    {
      p_worker_id: workerId,
      p_batch_size: BATCH_SIZE,
      p_lease_seconds: LEASE_SECONDS
    }
  );

  if (error) throw error;

  const results = {
    workerId,
    claimed: reminders?.length || 0,
    sent: 0,
    insufficientCredits: 0,
    failed: 0,
    uncertain: 0,
    recovery
  };

  for (const reminder of reminders || []) {
    const result = await processReminder(
      reminder,
      workerId
    );

    if (result.success) {
      results.sent++;
    } else if (result.insufficientCredits) {
      results.insufficientCredits++;
    } else if (
      result.uncertain ||
      result.refundPending
    ) {
      results.uncertain++;
    } else {
      results.failed++;
    }
  }

  console.log(
    '[SMS Scheduler] Batch completed:',
    results
  );

  return results;
};
