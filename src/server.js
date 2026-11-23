
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/authRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import smsRoutes from './routes/smsRoutes.js';
import smsWebhookRoutes from './routes/smsWebhookRoutes.js';

dotenv.config();

const app = express();

// General middleware
app.use(cors());

// Webhook MUST be mounted before express.json().
app.use('/api/webhooks/sasusync', smsWebhookRoutes);

// Normal API JSON parsing
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AutoTrack Pro Backend is Running Securely.'
  });
});

// API routes
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
