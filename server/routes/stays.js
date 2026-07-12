const express = require('express');
const { db, save, uid } = require('../db');
const { authRequired, publicUser } = require('./auth');
const { recordTxn, recordPlatformRevenue } = require('../payments');
const events = require('../events');

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// YYYY-MM-DD strings compare correctly lexicographically.
function overlaps(booking, checkIn, checkOut) {
  return booking.checkIn < checkOut && booking.checkOut > checkIn;
}

function availableCount(hotelId, room, checkIn, checkOut) {
  const taken = db.bookings.filter(
    (b) => b.hotelId === hotelId && b.roomId === room.id && b.status === 'active' && overlaps(b, checkIn, checkOut)
  ).length;
  return Math.max(0, room.count - taken);
}

// Only listings approved by SewaGo staff are visible / bookable.
function isLive(listing) {
  return !listing.status || listing.status === 'approved';
}

router.get('/cities', authRequired, (req, res) => {
  res.json({ cities: [...new Set(db.hotels.filter(isLive).map((h) => h.city))].sort() });
});

router.get('/hotels', authRequired, (req, res) => {
  const { city, checkIn, checkOut } = req.query;
  const datesGiven = isDate(checkIn) && isDate(checkOut);
  if (datesGiven && checkIn >= checkOut) {
    return res.status(400).json({ error: 'Check-out must be after check-in.' });
  }
  let hotels = db.hotels.filter((h) => isLive(h) && h.rooms.length > 0);
  if (city && city !== 'All') hotels = hotels.filter((h) => h.city === city);
  const featured = (h) => (h.promotedUntil > Date.now() ? 1 : 0);
  const result = hotels
    .map((h) => ({
      ...h,
      rooms: h.rooms.map((room) => ({
        ...room,
        available: datesGiven ? availableCount(h.id, room, checkIn, checkOut) : room.count
      }))
    }))
    .sort((a, b) => featured(b) - featured(a));
  res.json({ hotels: result });
});

router.post('/bookings', authRequired, (req, res) => {
  const { hotelId, roomId, checkIn, checkOut } = req.body || {};
  const hotel = db.hotels.find((h) => h.id === hotelId && isLive(h));
  const room = hotel && hotel.rooms.find((r) => r.id === roomId);
  if (!hotel || !room) return res.status(404).json({ error: 'Room not found.' });
  if (!isDate(checkIn) || !isDate(checkOut)) return res.status(400).json({ error: 'Valid dates are required.' });
  if (checkIn < todayStr()) return res.status(400).json({ error: 'Check-in cannot be in the past.' });
  if (checkIn >= checkOut) return res.status(400).json({ error: 'Check-out must be after check-in.' });

  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS);
  if (nights > 30) return res.status(400).json({ error: 'Bookings are limited to 30 nights.' });
  if (availableCount(hotelId, room, checkIn, checkOut) < 1) {
    return res.status(409).json({ error: 'That room is sold out for those dates.' });
  }
  const total = nights * room.pricePerNight;
  if (req.user.wallet < total) {
    return res.status(402).json({ error: 'Not enough wallet balance. Top up in Profile.' });
  }

  const booking = {
    id: uid(),
    userId: req.user.id,
    hotelId: hotel.id,
    hotelName: hotel.name,
    hotelIcon: hotel.icon,
    city: hotel.city,
    roomId: room.id,
    roomType: room.type,
    checkIn,
    checkOut,
    nights,
    pricePerNight: room.pricePerNight,
    total,
    status: 'active',
    createdAt: Date.now()
  };
  req.user.wallet -= total;
  recordTxn('user', req.user, {
    type: 'stay',
    label: `Stay: ${hotel.name} (${nights} night${nights > 1 ? 's' : ''})`,
    amount: total,
    sign: -1,
    refId: booking.id
  });
  // Partner-owned hotels earn 90% of the booking (SewaGo keeps 10%);
  // reversed if the guest cancels before check-in.
  const owner = hotel.ownerId && db.partners.find((p) => p.id === hotel.ownerId);
  if (owner) {
    booking.partnerId = owner.id;
    booking.partnerCut = Math.round(total * 0.9);
    owner.earnings = (owner.earnings || 0) + booking.partnerCut;
    recordTxn('partner', owner, {
      type: 'booking_income',
      label: `Booking income: ${hotel.name} (${nights} night${nights > 1 ? 's' : ''})`,
      amount: booking.partnerCut,
      sign: 1,
      refId: booking.id
    });
    recordPlatformRevenue({
      source: 'stay_commission',
      label: `Stay commission: ${hotel.name}`,
      amount: total - booking.partnerCut,
      refId: booking.id
    });
  }
  db.bookings.push(booking);
  save();
  events.publish('admin', { topic: 'bookings' });
  res.json({ booking, user: publicUser(req.user) });
});

router.get('/bookings', authRequired, (req, res) => {
  const bookings = db.bookings.filter((b) => b.userId === req.user.id).slice().reverse();
  res.json({ bookings });
});

router.post('/bookings/:id/cancel', authRequired, (req, res) => {
  const booking = db.bookings.find((b) => b.id === req.params.id && b.userId === req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.status !== 'active') return res.status(400).json({ error: 'This booking is not active.' });
  if (booking.checkIn <= todayStr()) {
    return res.status(400).json({ error: 'Bookings can only be cancelled before the check-in date.' });
  }
  booking.status = 'cancelled';
  booking.cancelledAt = Date.now();
  req.user.wallet += booking.total; // full refund before check-in
  recordTxn('user', req.user, {
    type: 'stay_refund',
    label: `Booking cancelled — refund: ${booking.hotelName}`,
    amount: booking.total,
    sign: 1,
    refId: booking.id
  });
  if (booking.partnerCut && booking.partnerId) {
    const owner = db.partners.find((p) => p.id === booking.partnerId);
    if (owner) {
      owner.earnings = (owner.earnings || 0) - booking.partnerCut;
      recordTxn('partner', owner, {
        type: 'booking_reversal',
        label: `Booking cancelled: ${booking.hotelName}`,
        amount: booking.partnerCut,
        sign: -1,
        refId: booking.id
      });
    }
    recordPlatformRevenue({
      source: 'stay_commission',
      label: `Booking cancelled — commission reversed: ${booking.hotelName}`,
      amount: -(booking.total - booking.partnerCut),
      refId: booking.id
    });
  }
  save();
  res.json({ booking, user: publicUser(req.user) });
});

module.exports = router;
