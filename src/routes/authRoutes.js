import express from 'express';
import { signup, login, resetPassword } from '../controllers/authController.js';
import {
  getAccountEmail,
  updateAccountEmail
} from '../controllers/accountController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/signup', signup);
router.post('/login', login);
router.post('/reset-password', resetPassword);

// Protected garage account routes
router.get('/account/email', protect, getAccountEmail);
router.patch('/account/email', protect, updateAccountEmail);

export default router;