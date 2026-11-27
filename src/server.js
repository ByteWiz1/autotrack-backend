
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

import authRoutes from './routes/authRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import smsRoutes from './routes/smsRoutes.js';
import smsWebhookRoutes from './routes/smsWebhookRoutes.js';
import { runSmsSchedulerBatch } from './services/smsScheduler.js';
import { handlePaystackWebhook } from './controllers/paymentController.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import {
  processSasuSyncWebhookEvents
} from './controllers/smsWebhookProcessorController.js';


dotenv.config();

const app = express();

const allowedOrigins = [
  'https://autotrack-pro-app.vercel.app',
  'http://127.0.0.1:5500',
  'http://localhost:5500'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
  maxAge: 86400
};

const authorizeInternalRequest = (req, res, next) => {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return res.status(503).json({
      success: false,
      error: 'Internal service authentication is not configured.'
    });
  }

  const authorization = req.get('authorization') || '';

  const suppliedToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';

  const expectedBuffer = Buffer.from(cronSecret);
  const suppliedBuffer = Buffer.from(suppliedToken);

  const authorized =
    suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);

  if (!authorized) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized.'
    });
  }

  next();
};

// General middleware
// General middleware
app.use(cors(corsOptions));

// IMPORTANT:
// The SasuSync webhook must remain BEFORE express.json()
// because it requires the original raw request body for HMAC verification.
app.use('/api/webhooks/sasusync', smsWebhookRoutes);

// Paystack webhook: preserve the original raw request body
// for HMAC signature verification.
app.post(
  '/api/webhooks/paystack',
  express.raw({ type: 'application/json' }),
  handlePaystackWebhook
);

// Parse JSON requests for normal API routes.
app.use(express.json({ limit: '1mb' }));

// Payment routes
app.use('/api/payments', paymentRoutes);

// Health check: keeps the existing Render wake-up endpoint.
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AutoTrack Pro Backend is Running Securely.'
  });
});

// Protected SMS webhook event processor.
// This processes stored delivery events only.
// It does not send SMS or run the reminder scheduler.
app.post(
  '/api/internal/sms/webhooks/process',
  authorizeInternalRequest,
  processSasuSyncWebhookEvents
);

// Protected SMS reminder scheduler endpoint.
// Keep this separate from webhook event processing.
app.post(
  '/api/internal/sms/run',
  authorizeInternalRequest,
  async (req, res) => {
    try {
      const results = await runSmsSchedulerBatch();

      return res.status(200).json({
        success: true,
        message: 'SMS scheduler batch completed.',
        results
      });
    } catch (error) {
      console.error('[SMS Scheduler] Batch execution failed:', error);

      return res.status(500).json({
        success: false,
        error: 'SMS scheduler batch failed.'
      });
    }
  }
);

// Existing API routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/analytics', analyticsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found.'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  res.status(err.status || 500).json({
    success: false,
    error: 'An unexpected server error occurred.'
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`AutoTrack Pro backend running on port ${PORT}`);
});
