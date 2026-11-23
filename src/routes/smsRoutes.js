
import express from 'express';
import {
  getSmsWallet,
  getSmsNotifications,
  markSmsNotificationRead,
  getSmsTransactions
} from '../controllers/smsController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// All SMS wallet routes require authentication.
router.use(protect);

router.get('/wallet', getSmsWallet);
router.get('/notifications', getSmsNotifications);
router.patch('/notifications/:notificationId/read', markSmsNotificationRead);
router.get('/transactions', getSmsTransactions);

export default router;
