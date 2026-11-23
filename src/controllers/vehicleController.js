
import { supabase } from '../config/supabase.js';
import { sendVehicleRegistrationEmail } from '../config/email.js';

// =====================================================
// DATE HELPERS
// =====================================================

const getScheduledDate = (dateString, daysOffset = 0) => {
  const date = new Date(`${dateString}T09:00:00.000Z`);

  date.setUTCDate(date.getUTCDate() + daysOffset);

  return date.toISOString();
};

// =====================================================
// EMAIL NOTIFICATION
// =====================================================

const notifyVehicleOwner = async (vehicle, shopName) => {
  if (!vehicle.owner_email) {
    return 'skipped';
  }

  try {
    const formattedDate = new Date(
      `${vehicle.next_service_date}T00:00:00Z`
    ).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });

    await sendVehicleRegistrationEmail({
      to: vehicle.owner_email,
      ownerName: vehicle.owner_name,
      shopName,
      carBrand: vehicle.car_brand,
      plateNumber: vehicle.plate_number,
      nextServiceDate: formattedDate
    });

    return 'sent';
  } catch (error) {
    console.error('Vehicle notification email failed:', error.message);
    return 'failed';
  }
};

// =====================================================
// AUTOMATIC SMS REMINDER SCHEDULING
// =====================================================

const scheduleVehicleReminders = async (vehicle, isNewVehicle) => {
  const serviceDate = vehicle.next_service_date;

  // Cancel outdated pending reminders when the service
  // date changes. Already sent reminders remain untouched.
  const { error: cancelError } = await supabase
    .from('sms_reminders')
    .update({
      status: 'skipped',
      last_error: 'Service date changed.'
    })
    .eq('vehicle_id', vehicle.id)
    .eq('status', 'pending')
    .neq('service_cycle_date', serviceDate);

  if (cancelError) {
    throw cancelError;
  }

  const reminders = [];

  // 1. Immediate registration confirmation.
  // Only schedule this for newly registered vehicles.
  if (isNewVehicle) {
    reminders.push({
      shop_id: vehicle.shop_id,
      vehicle_id: vehicle.id,
      reminder_type: 'registration',
      service_cycle_date: serviceDate,
      scheduled_for: new Date().toISOString(),
      status: 'pending'
    });
  }

  // 2. Three days before service.
  reminders.push({
    shop_id: vehicle.shop_id,
    vehicle_id: vehicle.id,
    reminder_type: 'three_day_before',
    service_cycle_date: serviceDate,
    scheduled_for: getScheduledDate(serviceDate, -3),
    status: 'pending'
  });

  // 3. On the service due date.
  reminders.push({
    shop_id: vehicle.shop_id,
    vehicle_id: vehicle.id,
    reminder_type: 'due_date',
    service_cycle_date: serviceDate,
    scheduled_for: getScheduledDate(serviceDate),
    status: 'pending'
  });

  // 4. Three days after the service due date.
  reminders.push({
    shop_id: vehicle.shop_id,
    vehicle_id: vehicle.id,
    reminder_type: 'overdue',
    service_cycle_date: serviceDate,
    scheduled_for: getScheduledDate(serviceDate, 3),
    status: 'pending'
  });

  // Ignore existing reminder records to prevent
  // duplicate schedules when a request is retried.
  const { error: reminderError } = await supabase
    .from('sms_reminders')
    .upsert(reminders, {
      onConflict: 'vehicle_id,reminder_type,service_cycle_date',
      ignoreDuplicates: true
    });

  if (reminderError) {
    throw reminderError;
  }

  return reminders.length;
};

// =====================================================
// 1. GET ALL VEHICLES
// =====================================================

export const getVehicles = async (req, res) => {
  try {
    const { data: vehicles, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('shop_id', req.shop.id)
      .order('next_service_date', {
        ascending: true
      });

    if (error) throw error;

    return res.status(200).json(vehicles);

  } catch (error) {
    console.error('Get vehicles error:', error.message);

    return res.status(500).json({
      error: 'Unable to retrieve vehicles.'
    });
  }
};

// =====================================================
// 2. ADD OR UPDATE A VEHICLE
// =====================================================

export const addVehicle = async (req, res) => {
  const {
    car_brand,
    plate_number,
    odometer,
    owner_name,
    owner_phone,
    owner_email
  } = req.body;

  try {
    // Validate required fields.
    if (
      !car_brand ||
      !plate_number ||
      !owner_name ||
      !owner_phone
    ) {
      return res.status(400).json({
        error: 'Please fill all required fields.'
      });
    }

    const unique_id = `${plate_number}-${car_brand}`
      .toLowerCase()
      .replace(/\s+/g, '');

    // Check whether this vehicle already exists
    // within the authenticated shop.
    const { data: existingCar, error: lookupError } = await supabase
      .from('vehicles')
      .select('*')
      .eq('unique_id', unique_id)
      .eq('shop_id', req.shop.id)
      .maybeSingle();

    if (lookupError) throw lookupError;

    // Calculate service dates.
    const lastService = new Date();
    const nextService = new Date(lastService);

    nextService.setMonth(nextService.getMonth() + 3);

    const vehicleData = {
      shop_id: req.shop.id,
      unique_id,
      car_brand: car_brand.trim(),
      plate_number: plate_number.trim().toUpperCase(),
      odometer: odometer || null,
      owner_name: owner_name.trim(),
      owner_phone: owner_phone.trim(),
      owner_email: owner_email || null,
      last_service_date: lastService.toISOString().split('T')[0],
      next_service_date: nextService.toISOString().split('T')[0]
    };

    const shopName = req.shop.shop_name || 'AutoTrack Pro';

    let savedVehicle;
    let isUpdate = false;

    if (existingCar) {
      // UPDATE EXISTING VEHICLE.
      const { data, error } = await supabase
        .from('vehicles')
        .update({
          ...vehicleData,
          instant_sent: false,
          three_day_sent: false,
          today_sent: false,
          overdue_sent: false
        })
        .eq('id', existingCar.id)
        .eq('shop_id', req.shop.id)
        .select()
        .single();

      if (error) throw error;

      savedVehicle = data;
      isUpdate = true;

    } else {
      // REGISTER NEW VEHICLE.
      const { data, error } = await supabase
        .from('vehicles')
        .insert([vehicleData])
        .select()
        .single();

      if (error) throw error;

      savedVehicle = data;
    }

    // CREATE AUTOMATIC SMS REMINDER SCHEDULES.
    try {
      await scheduleVehicleReminders(
        savedVehicle,
        !isUpdate
      );
    } catch (reminderError) {
      console.error(
        'SMS reminder scheduling failed:',
        reminderError.message
      );

      return res.status(500).json({
        error: 'Vehicle saved, but SMS reminders could not be scheduled. Please retry.',
        vehicleSaved: true
      });
    }

    // Preserve existing registration email functionality.
    const emailStatus = await notifyVehicleOwner(
      savedVehicle,
      shopName
    );

    return res.status(isUpdate ? 200 : 201).json({
      message: isUpdate
        ? 'Vehicle updated successfully'
        : 'Vehicle added successfully',
      isUpdate,
      emailStatus,
      smsSchedulingStatus: 'scheduled',
      vehicle: savedVehicle
    });

  } catch (error) {
    console.error('Vehicle save error:', error.message);

    return res.status(500).json({
      error: 'Unable to save vehicle.'
    });
  }
};

// =====================================================
// 3. DELETE A VEHICLE
// =====================================================

export const deleteVehicle = async (req, res) => {
  const { id } = req.params;

  try {
    const { data: vehicle, error: lookupError } = await supabase
      .from('vehicles')
      .select('id')
      .eq('id', id)
      .eq('shop_id', req.shop.id)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (!vehicle) {
      return res.status(404).json({
        error: 'Vehicle not found.'
      });
    }

    const { error } = await supabase
      .from('vehicles')
      .delete()
      .eq('id', id)
      .eq('shop_id', req.shop.id);

    if (error) throw error;

    return res.status(200).json({
      message: 'Vehicle deleted successfully'
    });

  } catch (error) {
    console.error('Vehicle deletion error:', error.message);

    return res.status(500).json({
      error: 'Unable to delete vehicle.'
    });
  }
};
