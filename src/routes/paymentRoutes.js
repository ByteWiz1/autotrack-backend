
import express from 'express';

import {
  getSmsPackages,
  initializeSmsPayment,
  verifySmsPayment
} from '../controllers/paymentController.js';

import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// All payment operations require garage authentication.
router.use(protect);

router.get('/packages', getSmsPackages);

router.post('/initialize', initializeSmsPayment);

router.get('/verify/:reference', verifySmsPayment);

export default router;