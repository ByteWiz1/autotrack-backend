
import crypto from 'node:crypto';

const SASUSYNC_BASE_URL =
  process.env.SASUSYNC_BASE_URL || 'https://sms.sasusync.com';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_MESSAGE_LENGTH = 650;

// GSM-7 character sets.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

const GSM7_EXTENDED = '^{}\\[~]|€\f';

const isGsm7 = (message) => {
  for (const character of message) {
    if (
      !GSM7_BASIC.includes(character) &&
      !GSM7_EXTENDED.includes(character)
    ) {
      return false;
    }
  }

  return true;
};

// Extended GSM-7 characters consume two septets.
const calculateGsm7Length = (message) => {
  let length = 0;

  for (const character of message) {
    length += GSM7_EXTENDED.includes(character) ? 2 : 1;
  }

  return length;
};

// Calculate billable SMS segments.
export const calculateSmsSegments = (message) => {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('SMS message cannot be empty.');
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('SMS message exceeds the 650-character provider limit.');
  }

  if (isGsm7(message)) {
    const length = calculateGsm7Length(message);

    return {
      encoding: 'GSM-7',
      length,
      segments: length <= 160 ? 1 : Math.ceil(length / 153)
    };
  }

  // JavaScript length counts UTF-16 code units.
  const length = message.length;

  return {
    encoding: 'UCS-2',
    length,
    segments: length <= 70 ? 1 : Math.ceil(length / 67)
  };
};

// Normalize Ghanaian mobile numbers.
export const normalizeGhanaNumber = (phone) => {
  if (typeof phone !== 'string') {
    throw new Error('Customer mobile number must be a string.');
  }

  let number = phone.replace(/[\s()-]/g, '');

  if (number.startsWith('+')) {
    number = number.slice(1);
  }

  if (/^0\d{9}$/.test(number)) {
    number = `233${number.slice(1)}`;
  }

  if (!/^233\d{9}$/.test(number)) {
    throw new Error('Invalid Ghanaian mobile number.');
  }

  return number;
};

// Format service dates.
const formatDate = (date) => {
  if (!date) {
    return 'your scheduled date';
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return 'your scheduled date';
  }

  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
};

// Build automatic reminder messages.
export const buildReminderMessage = ({
  reminderType,
  shopName,
  vehicle
}) => {
  if (!vehicle) {
    throw new Error('Vehicle information is required.');
  }

  const business = String(shopName || 'AutoTrack Pro').trim();
  const owner = String(vehicle.owner_name || 'Customer').trim();
  const car = String(vehicle.car_brand || 'your vehicle').trim();
  const plate = String(vehicle.plate_number || '').trim();
  const serviceDate = formatDate(vehicle.next_service_date);

  const vehicleDetails = plate
    ? `${car} (${plate})`
    : car;

  const messages = {
    registration:
      `Hello ${owner}, ${vehicleDetails} has been registered at ${business}. Your next service is scheduled for ${serviceDate}. Thank you.`,

    three_day_before:
      `Hello ${owner}, a reminder from ${business}: ${vehicleDetails} is due for servicing on ${serviceDate}. Please plan your visit.`,

    due_date:
      `Hello ${owner}, ${vehicleDetails} is due for servicing today. Please visit ${business}. Thank you.`,

    overdue:
      `Hello ${owner}, our records show that ${vehicleDetails} was due for servicing on ${serviceDate}. Please contact ${business} to arrange your service.`
  };

  const message = messages[reminderType];

  if (!message) {
    throw new Error(`Unsupported reminder type: ${reminderType}`);
  }

  calculateSmsSegments(message);

  return message;
};

// Send SMS through SasuSync.
// This function must only be called after wallet credits are reserved.
export const sendSmsGateway = async ({
  recipient,
  message,
  idempotencyKey,
  shopId,
  reminderId
}) => {
  const apiKey = process.env.SASUSYNC_API_KEY;
  const sender = process.env.SASUSYNC_SENDER_ID;

  if (!apiKey) {
    throw new Error('SASUSYNC_API_KEY is not configured.');
  }

  if (
    typeof sender !== 'string' ||
    !sender.trim() ||
    sender.length > 11
  ) {
    throw new Error('A valid approved SasuSync sender ID is required.');
  }

  if (!shopId || !reminderId || !idempotencyKey) {
    throw new Error(
      'Shop, reminder and idempotency identifiers are required.'
    );
  }

  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new Error('Invalid SMS message.');
  }

  const normalizedRecipient = normalizeGhanaNumber(recipient);
  const segmentInfo = calculateSmsSegments(message);

  const sandbox = process.env.SASUSYNC_SANDBOX === 'true';

  const endpoint = sandbox
    ? '/smssandbox/v1/send'
    : '/api/v1/send';

  const url =
    `${SASUSYNC_BASE_URL.replace(/\/+$/, '')}${endpoint}`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        sender: sender.trim(),
        recipients: [normalizedRecipient],
        message,
        metadata: {
          mechanic_id: String(shopId),
          shop_id: String(shopId),
          reminder_id: String(reminderId)
        }
      }),
      signal: controller.signal
    });

    const responseData = await response.json().catch(() => ({}));

    if (!response.ok || responseData.success === false) {
      const error = new Error(
        responseData.detail ||
        responseData.message ||
        `SasuSync request failed with status ${response.status}.`
      );

      error.status = response.status;
      error.gatewayResponse = responseData;
      throw error;
    }

    const taskId =
      responseData.data?.task_id ||
      responseData.data?.job_id;

    if (!taskId) {
      throw new Error(
        'SasuSync did not return a message task ID.'
      );
    }

    return {
      success: true,
      gatewayMessageId: taskId,
      status: responseData.data?.status || 'queued',
      encoding: segmentInfo.encoding,
      calculatedSegments: segmentInfo.segments,
      gatewayDeducted: responseData.balance?.deducted ?? null,
      gatewayRemaining: responseData.balance?.remaining ?? null,
      idempotentReplay:
        responseData.idempotent_replay === true,
      sandbox,
      gatewayResponse: responseData
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(
        'SasuSync request timed out. Retry using the same idempotency key.'
      );

      timeoutError.code = 'SMS_GATEWAY_TIMEOUT';
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// Generate a key once for a new reservation.
// Save it in sms_logs and reuse it for every retry.
export const createSmsIdempotencyKey = (reminderId) => {
  if (!reminderId) {
    throw new Error('Reminder ID is required.');
  }

  return `autotrack-${reminderId}-${crypto.randomUUID()}`;
};
