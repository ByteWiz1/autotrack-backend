import { supabase } from '../config/supabase.js';

// 1. GET ALL VEHICLES (For the logged-in shop only)
export const getVehicles = async (req, res) => {
  try {
    const { data: vehicles, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('shop_id', req.shop.id)
      .order('next_service_date', { ascending: true });

    if (error) throw error;
    res.status(200).json(vehicles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 2. ADD OR UPDATE A VEHICLE
export const addVehicle = async (req, res) => {
  const { car_brand, plate_number, odometer, owner_name, owner_phone, owner_email } = req.body;

  try {
    if (!car_brand || !plate_number || !owner_name || !owner_phone) {
      return res.status(400).json({ error: "Please fill all required fields." });
    }

    const unique_id = `${plate_number}-${car_brand}`.toLowerCase().replace(/\s+/g, '');

    // Check if car already exists IN THIS SHOP
    const { data: existingCar } = await supabase
      .from('vehicles')
      .select('*')
      .eq('unique_id', unique_id)
      .eq('shop_id', req.shop.id)
      .single();

    const lastService = new Date();
    const nextService = new Date(lastService);
    nextService.setMonth(nextService.getMonth() + 3);

    const vehicleData = {
      shop_id: req.shop.id,
      unique_id,
      car_brand,
      plate_number: plate_number.toUpperCase(),
      odometer,
      owner_name,
      owner_phone,
      owner_email: owner_email || null,
      last_service_date: lastService.toISOString().split('T')[0],
      next_service_date: nextService.toISOString().split('T')[0],
    };

    if (existingCar) {
      // Update existing record
      const { error } = await supabase
        .from('vehicles')
        .update({
          ...vehicleData,
          instant_sent: false,
          three_day_sent: false,
          today_sent: false,
          overdue_sent: false
        })
        .eq('id', existingCar.id);
      
      if (error) throw error;
      return res.status(200).json({ message: "Vehicle updated successfully", isUpdate: true });
    } else {
      // Insert new record
      const { error } = await supabase.from('vehicles').insert([vehicleData]);
      
      if (error) throw error;
      return res.status(201).json({ message: "Vehicle added successfully", isUpdate: false });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 3. DELETE A VEHICLE
export const deleteVehicle = async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('vehicles')
      .delete()
      .eq('id', id)
      .eq('shop_id', req.shop.id); // Security: Only delete if it belongs to this shop

    if (error) throw error;
    res.status(200).json({ message: "Vehicle deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};