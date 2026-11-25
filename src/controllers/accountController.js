import { supabase } from '../config/supabase.js';

export const getAccountEmail = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shops')
      .select('email')
      .eq('id', req.shop.id)
      .single();

    if (error) {
      console.error('Get account email error:', error);
      return res.status(500).json({
        message: 'Unable to retrieve account email.'
      });
    }

    return res.status(200).json({
      success: true,
      email: data.email || ''
    });
  } catch (error) {
    console.error('Get account email error:', error);

    return res.status(500).json({
      message: 'An unexpected error occurred.'
    });
  }
};

export const updateAccountEmail = async (req, res) => {
  try {
    const email = typeof req.body.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email || email.length > 254 || !emailPattern.test(email)) {
      return res.status(400).json({
        message: 'Please provide a valid email address.'
      });
    }

    const { data, error } = await supabase
      .from('shops')
      .update({ email })
      .eq('id', req.shop.id)
      .select('email')
      .single();

    if (error) {
      console.error('Update account email error:', error);
      return res.status(500).json({
        message: 'Unable to update account email.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Account email updated successfully.',
      email: data.email
    });
  } catch (error) {
    console.error('Update account email error:', error);

    return res.status(500).json({
      message: 'An unexpected error occurred.'
    });
  }
};