import express from 'express';
import { getVehicles, addVehicle, deleteVehicle } from '../controllers/vehicleController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Apply the 'protect' middleware to all routes in this file
router.use(protect);

router.route('/')
  .get(getVehicles)
  .post(addVehicle);

router.route('/:id')
  .delete(deleteVehicle);

export default router;