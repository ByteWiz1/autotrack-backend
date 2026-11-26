
import { supabase } from '../config/supabase.js';


const getCombinedSmsTransactions = async (shopId, limit = 100) => {
  const [
    { data: walletTransactions, error: walletError },
    { data: paymentOrders, error: ordersError }
  ] = await Promise.all([
    supabase
      .from('sms_transactions')
      .select('*')
      .eq('shop_id', shopId)
      .order('created_at', { ascending: false })
      .limit(limit),

    supabase
      .from('sms_payment_orders')
      .select(`
        id,
        shop_id,
        reference,
        credits,
        amount_kobo,
        currency,
        status,
        failure_reason,
        paystack_transaction_id,
        created_at,
        updated_at
      `)
      .eq('shop_id', shopId)
      .order('created_at', { ascending: false })
      .limit(limit)
  ]);

  if (walletError) throw walletError;
  if (ordersError) throw ordersError;

  const walletRows = walletTransactions || [];

  // Prevent completed payments from appearing twice.
  const completedReferences = new Set(
    walletRows
      .map(transaction => transaction.payment_reference)
      .filter(Boolean)
  );

  const paymentRows = (paymentOrders || [])
    .filter(order => {
      const status = String(order.status || '')
        .toLowerCase()
        .trim();

      return !(
        status === 'paid' &&
        completedReferences.has(order.reference)
      );
    })
    .map(order => {
      const status = String(order.status || '')
        .toLowerCase()
        .trim();

      const credits = Number(order.credits) || 0;
      const isPaid = status === 'paid';

      return {
        id: `payment-order-${order.id}`,
        shop_id: order.shop_id,

        transaction_type: 'payment_attempt',
        type: 'payment_attempt',
        description: 'SMS credit purchase',

        status: order.status,
        failure_reason: order.failure_reason,

        // Only show added credits for a paid order.
        credit_change: isPaid ? credits : 0,
        requested_credits: credits,

        amount_paid: Number(order.amount_kobo) / 100,
        currency: order.currency,

        reference: order.reference,
        payment_reference: order.reference,
        gateway_reference: order.paystack_transaction_id,

        created_at: order.created_at,
        updated_at: order.updated_at,

        source: 'sms_payment_orders'
      };
    });

  return [...walletRows, ...paymentRows]
    .sort((a, b) =>
      new Date(b.created_at).getTime() -
      new Date(a.created_at).getTime()
    )
    .slice(0, limit);
};

// GET SMS WALLET BALANCE

export const getSmsWallet = async (req, res) => {
  try {
    const { data: shop, error } = await supabase
      .from('shops')
      .select('id, sms_credits')
      .eq('id', req.shop.id)
      .single();

    if (error) throw error;

    const transactions = await getCombinedSmsTransactions(
      req.shop.id,
      20
    );

    const { data: notifications, error: notificationError } =
      await supabase
        .from('sms_notifications')
        .select('*')
        .eq('shop_id', req.shop.id)
        .eq('status', 'unread')
        .order('created_at', { ascending: false });

    if (notificationError) throw notificationError;

    return res.status(200).json({
      success: true,
      balance: shop.sms_credits,
      transactions,
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
    const transactions = await getCombinedSmsTransactions(
      req.shop.id,
      100
    );

    return res.status(200).json({
      success: true,
      transactions
    });
  } catch (error) {
    console.error(
      'SMS transaction history error:',
      error.message
    );

    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve SMS transaction history.'
    });
  }
};
