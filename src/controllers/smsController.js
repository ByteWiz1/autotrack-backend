
import { supabase } from '../config/supabase.js';

// GET SMS WALLET BALANCE
export const getSmsWallet = async (req, res) => {
  try {
    const { data: shop, error } = await supabase
      .from('shops')
      .select('id, sms_credits')
      .eq('id', req.shop.id)
      .single();

    if (error) throw error;

    const { data: transactions, error: transactionError } = await supabase
      .from('sms_transactions')
      .select('*')
      .eq('shop_id', req.shop.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (transactionError) throw transactionError;

    const { data: notifications, error: notificationError } = await supabase
      .from('sms_notifications')
      .select('*')
      .eq('shop_id', req.shop.id)
      .eq('status', 'unread')
      .order('created_at', { ascending: false });

    if (notificationError) throw notificationError;

    return res.status(200).json({
      success: true,
      balance: shop.sms_credits,
      transactions: transactions || [],
      notifications: notifications || []
    });
  } catch (error) {
    console.error('SMS wallet error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve SMS wallet information.'
    });
  }
};

// GET SMS NOTIFICATIONS
export const getSmsNotifications = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sms_notifications')
      .select('*')
      .eq('shop_id', req.shop.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      notifications: data || []
    });
  } catch (error) {
    console.error('SMS notification error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve SMS notifications.'
    });
  }
};

// MARK A NOTIFICATION AS READ
export const markSmsNotificationRead = async (req, res) => {
  try {
    const { notificationId } = req.params;

    if (!notificationId) {
      return res.status(400).json({
        success: false,
        error: 'Notification ID is required.'
      });
    }

    const { data, error } = await supabase
      .from('sms_notifications')
      .update({ status: 'read' })
      .eq('id', notificationId)
      .eq('shop_id', req.shop.id)
      .eq('status', 'unread')
      .select('id')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Unread notification not found.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Notification marked as read.'
    });
  } catch (error) {
    console.error('SMS notification update error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to update SMS notification.'
    });
  }
};

// GET SMS TRANSACTION HISTORY
export const getSmsTransactions = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sms_transactions')
      .select('*')
      .eq('shop_id', req.shop.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      transactions: data || []
    });
  } catch (error) {
    console.error('SMS transaction history error:', error.message);

    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve SMS transaction history.'
    });
  }
};
