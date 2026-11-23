
import express from 'express';
import {
  handleSasuSyncWebhook
} from '../controllers/smsWebhookController.js';

const router = express.Router();

// Preserve the exact raw JSON body for HMAC verification.
router.post(
  '/',
  express.raw({
    type: 'application/json',
    limit: '1mb'
  }),
  handleSasuSyncWebhook
);

export default router;
