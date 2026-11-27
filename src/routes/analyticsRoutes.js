import express from 'express';
import { getBusinessAnalytics } from '../controllers/analyticsController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/', getBusinessAnalytics);

export default router;