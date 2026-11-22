import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

export const protect = async (req, res, next) => {
  let token;

  // Check if token exists in the headers
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // Get token from header (Format: "Bearer <token>")
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get shop from the database (excluding password)
      const { data: shop } = await supabase
        .from('shops')
        .select('id, shop_name, username')
        .eq('id', decoded.id)
        .single();

      if (!shop) return res.status(401).json({ error: "Shop not found." });

      // Attach shop to the request object
      req.shop = shop;
      next(); // Move to the next function (the controller)
    } catch (error) {
      res.status(401).json({ error: "Not authorized, token failed." });
    }
  } else {
    res.status(401).json({ error: "Not authorized, no token." });
  }
};