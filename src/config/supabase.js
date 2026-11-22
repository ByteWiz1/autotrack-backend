import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing Supabase credentials in .env file");
  process.exit(1);
}

// We use the Service Role Key here so the backend bypasses RLS and can insert data
export const supabase = createClient(supabaseUrl, supabaseServiceKey);