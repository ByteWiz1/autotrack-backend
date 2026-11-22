import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

// Helper function to generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d', // Token lasts for 30 days (Remember Me)
  });
};

// 1. SIGN UP (Create Shop)
export const signup = async (req, res) => {
  const { shop_name, username, password, recovery_pin } = req.body;

  try {
    // Validate inputs
    if (!shop_name || !username || !password || !recovery_pin) {
      return res.status(400).json({ error: "Please fill all fields." });
    }
    if (recovery_pin.length !== 4) {
      return res.status(400).json({ error: "PIN must be exactly 4 digits." });
    }

    // Check if username already exists
    const { data: existingShop } = await supabase
      .from('shops')
      .select('username')
      .eq('username', username)
      .single();

    if (existingShop) {
      return res.status(400).json({ error: "Username is already taken." });
    }

    // Hash password and PIN
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const recovery_pin_hash = await bcrypt.hash(recovery_pin, salt);

    // Insert into Database
    const { data: newShop, error } = await supabase
      .from('shops')
      .insert([{ shop_name, username, password_hash, recovery_pin_hash }])
      .select('id, shop_name, username')
      .single();

    if (error) throw error;

    res.status(201).json({
      ...newShop,
      token: generateToken(newShop.id)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 2. LOGIN
export const login = async (req, res) => {
  const { username, password } = req.body;

  try {
    // Find shop by username
    const { data: shop, error } = await supabase
      .from('shops')
      .select('*')
      .eq('username', username)
      .single();

    if (!shop) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // Check Password
    const isMatch = await bcrypt.compare(password, shop.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // Success
    res.status(200).json({
      id: shop.id,
      shop_name: shop.shop_name,
      username: shop.username,
      token: generateToken(shop.id)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 3. FORGOT PASSWORD (Reset using PIN)
export const resetPassword = async (req, res) => {
  const { username, recovery_pin, new_password } = req.body;

  try {
    if (new_password.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    // Find shop
    const { data: shop } = await supabase
      .from('shops')
      .select('*')
      .eq('username', username)
      .single();

    if (!shop) {
      return res.status(404).json({ error: "Shop not found." });
    }

    // Verify PIN
    const isPinMatch = await bcrypt.compare(recovery_pin, shop.recovery_pin_hash);
    if (!isPinMatch) {
      return res.status(401).json({ error: "Incorrect Recovery PIN." });
    }

    // Hash new password and update
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await supabase
      .from('shops')
      .update({ password_hash })
      .eq('id', shop.id);

    res.status(200).json({ message: "Password updated successfully. You can now login." });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};