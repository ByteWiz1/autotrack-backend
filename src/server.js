
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

import authRoutes from './routes/authRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import smsRoutes from './routes/smsRoutes.js';
import smsWebhookRoutes from './routes/smsWebhookRoutes.js';
import { runSmsSchedulerBatch } from './services/smsScheduler.js';

dotenv.config();

const app = express();

// General middleware
app.use(cors());

// Webhook MUST be mounted before express.json().
app.use('/api/webhooks/sasusync', smsWebhookRoutes);

// Normal API JSON parsing
app.use(express.json({ limit: '1mb' }));

// Health check: keeps the existing Render wake-up endpoint.
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AutoTrack Pro Backend is Running Securely.'
  });
});

// Protected SMS scheduler endpoint
app.post('/api/internal/sms/run', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return res.status(503).json({
      success: false,
      error: 'SMS scheduler is not configured.'
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
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);

  if (!authorized) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized.'
    });
  }

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
});

// Existing API routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/sms', smsRoutes);

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
