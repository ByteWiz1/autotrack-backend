
import { supabase } from '../config/supabase.js';

export const getBusinessAnalytics = async (req, res) => {
  try {
    const shopId = req.shop.id;

    if (!shopId) {
      return res.status(401).json({
        success: false,
        error: 'Garage account not identified.'
      });
    }

    const [
      vehiclesResult,
      remindersResult,
      paymentsResult,
      transactionsResult,
      logsResult
    ] = await Promise.all([
      supabase
        .from('vehicles')
        .select('id, created_at, next_service_date')
        .eq('shop_id', shopId),

      supabase
        .from('sms_reminders')
        .select('id, status')
        .eq('shop_id', shopId),

      supabase
        .from('sms_payment_orders')
        .select('credits, amount_kobo, status')
        .eq('shop_id', shopId),

      supabase
        .from('sms_transactions')
        .select('transaction_type, credit_change, amount_paid')
        .eq('shop_id', shopId),

      supabase
        .from('sms_logs')
        .select('status, credit_cost')
        .eq('shop_id', shopId)
    ]);

    const results = [
      vehiclesResult,
      remindersResult,
      paymentsResult,
      transactionsResult,
      logsResult
    ];

    const failedQuery = results.find(result => result.error);

    if (failedQuery) {
      throw failedQuery.error;
    }

    const vehicles = vehiclesResult.data || [];
    const reminders = remindersResult.data || [];
    const payments = paymentsResult.data || [];
    const transactions = transactionsResult.data || [];
    const logs = logsResult.data || [];

    const today = new Date().toISOString().slice(0, 10);

    const paidPayments = payments.filter(
      payment => payment.status === 'paid'
    );

    const analytics = {
      vehicles: {
        total: vehicles.length,
        upcomingServices: vehicles.filter(vehicle =>
          vehicle.next_service_date &&
          vehicle.next_service_date >= today &&
          vehicle.next_service_date <= new Date(
            Date.now() + 30 * 86400000
          ).toISOString().slice(0, 10)
        ).length,
        overdueServices: vehicles.filter(vehicle =>
          vehicle.next_service_date &&
          vehicle.next_service_date < today
        ).length
      },

      reminders: {
        total: reminders.length,
        pending: reminders.filter(item => item.status === 'pending').length,
        sent: reminders.filter(item => item.status === 'sent').length,
        failed: reminders.filter(item => item.status === 'failed').length
      },

      sms: {
        paidOrders: paidPayments.length,
        creditsPurchased: paidPayments.reduce(
          (sum, item) => sum + Number(item.credits || 0), 0
        ),
        revenueGhs: paidPayments.reduce(
          (sum, item) => sum + Number(item.amount_kobo || 0), 0
        ) / 100,
        creditsUsed: transactions
          .filter(item => item.transaction_type === 'deduction')
          .reduce((sum, item) =>
            sum + Math.abs(Number(item.credit_change || 0)), 0),
        creditsRefunded: transactions
          .filter(item => item.transaction_type === 'refund')
          .reduce((sum, item) =>
            sum + Number(item.credit_change || 0), 0),
        smsLogs: logs.length
      }
    };

    return res.json({
      success: true,
      analytics
    });

  } catch (error) {
    console.error('Business analytics error:', error);

    return res.status(500).json({
      success: false,
      error: 'Unable to load business analytics.'
    });
  }
};
