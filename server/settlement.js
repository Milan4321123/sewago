const { db } = require('./db');

// Stay bookings credit the partner's PENDING balance at booking time, because a
// booking is fully refundable right up until check-in. Once the check-in date
// arrives the booking can no longer be cancelled (see stays cancel guard), so
// the income is final: move it from pendingEarnings into withdrawable earnings.
//
// Called from the hourly housekeeping sweep and lazily whenever a partner reads
// their balance or requests a payout, so settlement is both timely and never
// blocks a withdrawal the partner has genuinely earned.
function settleDueBookings(todayStr) {
  const today = todayStr || new Date().toISOString().slice(0, 10);
  const { recordTxn } = require('./payments'); // lazy: avoid load-time cycle
  let settled = 0;
  for (const b of db.bookings) {
    if (b.status !== 'active' || b.settled || !b.partnerCut || !b.partnerId) continue;
    if (b.checkIn > today) continue; // stay hasn't started yet — still refundable
    const owner = db.partners.find((p) => p.id === b.partnerId);
    if (owner) {
      owner.pendingEarnings = (owner.pendingEarnings || 0) - b.partnerCut;
      owner.earnings = (owner.earnings || 0) + b.partnerCut;
      recordTxn('partner', owner, {
        type: 'booking_income',
        label: `Stay settled — income: ${b.hotelName}`,
        amount: b.partnerCut,
        sign: 1,
        refId: b.id
      });
    }
    b.settled = true;
    settled += 1;
  }
  return settled;
}

module.exports = { settleDueBookings };
