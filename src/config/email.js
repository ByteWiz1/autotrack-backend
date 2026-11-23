
import { Resend } from 'resend';

export async function sendVehicleRegistrationEmail({
  to,
  ownerName,
  shopName,
  carBrand,
  plateNumber,
  nextServiceDate
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const from =
    process.env.EMAIL_FROM ||
    'AutoTrack Pro <onboarding@resend.dev>';

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Vehicle Registration Confirmation',
    text: `Hello ${ownerName},

Your vehicle has been successfully registered in the ${shopName} system.

Your ${carBrand} (${plateNumber}) is due for servicing on ${nextServiceDate}.

Thank you for choosing ${shopName}. We look forward to keeping your vehicle in excellent condition!`
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
