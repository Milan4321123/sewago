const { db, save } = require('./db');
const { hashPassword } = require('./passwords');
const { recordTxn } = require('./payments');
const { coordsFor, haversineKm } = require('./places');
const { ROAD_FACTOR, payoutFor, driverPublic } = require('./rideLogic');

const DEMO_PASSWORDS = {
  customer: 'customer123',
  driver: 'driver123',
  partner: 'partner123'
};

const TIER_META = {
  bike: { label: 'SewaGo Bike', icon: '🏍️', base: 50, perKm: 25 },
  car: { label: 'SewaGo Car', icon: '🚗', base: 100, perKm: 45 },
  xl: { label: 'SewaGo XL', icon: '🚐', base: 150, perKm: 60 }
};

function now() {
  return Date.now();
}

function daysFromNow(days) {
  return new Date(now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function demoId(kind, id) {
  return `demo-${kind}-${id}`;
}

function removeDemoData() {
  const removeDemo = (x) => !String(x.id || '').startsWith('demo-');
  for (const key of ['users', 'drivers', 'partners', 'restaurants', 'hotels', 'rides', 'orders', 'bookings', 'tasks', 'payments', 'withdrawals', 'otpCodes', 'passwordResetTokens']) {
    if (Array.isArray(db[key])) db[key] = db[key].filter(removeDemo);
  }
  if (Array.isArray(db.transactions)) {
    db.transactions = db.transactions.filter((txn) =>
      !String(txn.id || '').startsWith('demo-') &&
      !String(txn.ownerId || '').startsWith('demo-') &&
      !String(txn.refId || '').startsWith('demo-')
    );
  }
  for (const tokenKey of ['tokens', 'driverTokens', 'partnerTokens']) {
    for (const [token, ownerId] of Object.entries(db[tokenKey] || {})) {
      if (String(ownerId).startsWith('demo-')) delete db[tokenKey][token];
    }
  }
}

function addUser(id, name, email, phone, wallet) {
  const user = {
    id: demoId('user', id),
    name,
    email,
    phone,
    phoneVerified: true,
    phoneVerifiedAt: now() - 20 * 24 * 60 * 60 * 1000,
    password: hashPassword(DEMO_PASSWORDS.customer),
    wallet: 0
  };
  db.users.push(user);
  user.wallet = wallet;
  recordTxn('user', user, { type: 'bonus', label: 'Demo wallet balance', amount: wallet, sign: 1 });
  return user;
}

function spendUser(user, type, label, amount, refId) {
  user.wallet -= amount;
  recordTxn('user', user, { type, label, amount, sign: -1, refId });
}

function earnUser(user, type, label, amount, refId) {
  user.wallet += amount;
  recordTxn('user', user, { type, label, amount, sign: 1, refId });
}

function addDriver(id, name, email, phone, tier, vehicle, plate, baseName, lat, lng) {
  const driver = {
    id: demoId('driver', id),
    name,
    email,
    phone,
    phoneVerified: true,
    phoneVerifiedAt: now() - 21 * 24 * 60 * 60 * 1000,
    password: hashPassword(DEMO_PASSWORDS.driver),
    tier,
    vehicle,
    plate,
    licenseHash: `demo-license-${id}`,
    licenseLast4: plate.slice(-4),
    licenseVerified: true,
    verificationStatus: 'verified',
    licenseVerifiedAt: now() - 21 * 24 * 60 * 60 * 1000,
    kycStatus: 'approved',
    kyc: {
      licenseLast4: plate.slice(-4),
      vehicle,
      plate,
      submittedAt: now() - 22 * 24 * 60 * 60 * 1000,
      reviewedAt: now() - 21 * 24 * 60 * 60 * 1000,
      note: ''
    },
    rating: 4.8,
    online: true,
    earnings: 0,
    tripsCompleted: 0,
    baseName,
    baseLat: lat,
    baseLng: lng,
    currentLat: lat,
    currentLng: lng,
    locationAccuracy: 16,
    locationUpdatedAt: now()
  };
  db.drivers.push(driver);
  return driver;
}

function ensureSeedDriverOnline(id, lat, lng, accuracy = 18) {
  const driver = db.drivers.find((d) => d.id === id);
  if (!driver) return null;
  driver.phone = driver.phone || `98000000${id.slice(-1)}`;
  driver.phoneVerified = true;
  driver.phoneVerifiedAt = driver.phoneVerifiedAt || now() - 30 * 24 * 60 * 60 * 1000;
  driver.kycStatus = 'approved';
  driver.online = true;
  driver.currentLat = lat;
  driver.currentLng = lng;
  driver.locationAccuracy = accuracy;
  driver.locationUpdatedAt = now();
  return driver;
}

function fareFor(tier, pickup, dropoff) {
  const p = coordsFor(pickup);
  const q = coordsFor(dropoff);
  const t = TIER_META[tier];
  const distanceKm = Math.max(0.8, Math.round(haversineKm(p, q) * ROAD_FACTOR * 10) / 10);
  return {
    pickup: p,
    dropoff: q,
    distanceKm,
    fare: Math.round(t.base + t.perKm * distanceKm),
    tierLabel: t.label,
    icon: t.icon
  };
}

function addRide({ id, user, driver, pickup, dropoff, tier, payment = 'wallet', status = 'completed', rating = null, ageHours = 12 }) {
  const trip = fareFor(tier, pickup, dropoff);
  const ride = {
    id: demoId('ride', id),
    userId: user.id,
    customerName: user.name,
    pickup: trip.pickup.name,
    dropoff: trip.dropoff.name,
    pickupLoc: { lat: trip.pickup.lat, lng: trip.pickup.lng },
    dropoffLoc: { lat: trip.dropoff.lat, lng: trip.dropoff.lng },
    tier,
    tierLabel: trip.tierLabel,
    icon: trip.icon,
    distanceKm: trip.distanceKm,
    fare: trip.fare,
    payment,
    mode: driver ? 'live' : 'sim',
    driver: driver ? driverPublic(driver) : null,
    driverId: driver ? driver.id : null,
    driverStart: driver ? { lat: driver.currentLat || driver.baseLat, lng: driver.currentLng || driver.baseLng } : null,
    driverEtaToPickupMin: 8,
    status,
    tripSeconds: Math.min(90, Math.max(20, Math.round(trip.distanceKm * 8))),
    rating,
    createdAt: now() - ageHours * 60 * 60 * 1000
  };
  if (status === 'completed') {
    ride.acceptedAt = ride.createdAt + 2 * 60 * 1000;
    ride.startedAt = ride.createdAt + 12 * 60 * 1000;
    ride.completedAt = ride.createdAt + 32 * 60 * 1000;
    ride.payout = payoutFor(ride);
    if (payment === 'wallet') {
      spendUser(user, 'ride', `Ride: ${ride.pickup} → ${ride.dropoff}`, ride.fare, ride.id);
      if (driver) {
        driver.earnings = (driver.earnings || 0) + ride.payout;
        driver.tripsCompleted = (driver.tripsCompleted || 0) + 1;
        recordTxn('driver', driver, {
          type: 'trip_payout',
          label: `Demo trip payout: ${ride.pickup} → ${ride.dropoff}`,
          amount: ride.payout,
          sign: 1,
          refId: ride.id
        });
      }
    } else if (driver) {
      const commission = ride.fare - ride.payout;
      driver.earnings = (driver.earnings || 0) - commission;
      driver.tripsCompleted = (driver.tripsCompleted || 0) + 1;
      recordTxn('driver', driver, {
        type: 'cash_commission',
        label: `Demo cash commission: ${ride.pickup} → ${ride.dropoff}`,
        amount: commission,
        sign: -1,
        refId: ride.id
      });
    }
  }
  db.rides.push(ride);
  return ride;
}

function addOrder({ id, user, restaurant, itemIds, status, ageSeconds }) {
  const lines = itemIds.map(([itemId, qty]) => {
    const item = restaurant.menu.find((m) => m.id === itemId) || restaurant.menu[0];
    return { id: item.id, name: item.name, price: item.price, qty };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.qty, 0);
  const total = subtotal + restaurant.deliveryFee;
  const order = {
    id: demoId('order', id),
    userId: user.id,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    restaurantIcon: restaurant.icon,
    items: lines,
    subtotal,
    deliveryFee: restaurant.deliveryFee,
    total,
    status,
    // Demo orders always run on the simulated timeline — nobody is standing by
    // to press "accept" on seeded data.
    fulfillment: 'sim',
    createdAt: now() - ageSeconds * 1000
  };
  if (status === 'delivered') order.deliveredAt = order.createdAt + 75 * 1000;
  spendUser(user, 'food', `Food order: ${restaurant.name}`, total, order.id);
  const owner = restaurant.ownerId && db.partners.find((p) => p.id === restaurant.ownerId);
  if (owner) {
    order.partnerId = owner.id;
    order.partnerCut = Math.round(subtotal * 0.85);
    owner.earnings = (owner.earnings || 0) + order.partnerCut;
    recordTxn('partner', owner, {
      type: 'order_income',
      label: `Demo order income: ${restaurant.name}`,
      amount: order.partnerCut,
      sign: 1,
      refId: order.id
    });
  }
  db.orders.push(order);
  return order;
}

function addBooking({ id, user, hotel, room, checkIn, checkOut, status = 'active', ageDays = 2 }) {
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / (24 * 60 * 60 * 1000));
  const total = nights * room.pricePerNight;
  const booking = {
    id: demoId('booking', id),
    userId: user.id,
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
    status,
    createdAt: now() - ageDays * 24 * 60 * 60 * 1000
  };
  spendUser(user, 'stay', `Stay: ${hotel.name} (${nights} night${nights > 1 ? 's' : ''})`, total, booking.id);
  const owner = hotel.ownerId && db.partners.find((p) => p.id === hotel.ownerId);
  if (owner) {
    booking.partnerId = owner.id;
    booking.partnerCut = Math.round(total * 0.9);
    owner.earnings = (owner.earnings || 0) + booking.partnerCut;
    recordTxn('partner', owner, {
      type: 'booking_income',
      label: `Demo booking income: ${hotel.name}`,
      amount: booking.partnerCut,
      sign: 1,
      refId: booking.id
    });
  }
  db.bookings.push(booking);
  return booking;
}

function addTask({ id, poster, worker = null, title, category, desc, place, budget, status, ageHours }) {
  const fee = Math.round(budget * 0.1);
  const task = {
    id: demoId('task', id),
    posterId: poster.id,
    posterName: poster.name,
    title,
    category,
    desc,
    place,
    budget,
    fee,
    workerPayout: budget - fee,
    status,
    workerId: worker ? worker.id : null,
    workerName: worker ? worker.name : null,
    createdAt: now() - ageHours * 60 * 60 * 1000
  };
  spendUser(poster, 'task_hold', `Task budget held: ${title}`, budget, task.id);
  if (status === 'assigned' || status === 'done' || status === 'completed') task.assignedAt = task.createdAt + 60 * 60 * 1000;
  if (status === 'done' || status === 'completed') task.doneAt = task.assignedAt + 3 * 60 * 60 * 1000;
  if (status === 'completed') {
    task.completedAt = task.doneAt + 2 * 60 * 60 * 1000;
    if (worker) earnUser(worker, 'task_income', `Task payment: ${title}`, task.workerPayout, task.id);
  }
  db.tasks.push(task);
  return task;
}

function addDemoPartnerInventory() {
  const partner = {
    id: demoId('partner', 'himalayan-hospitality'),
    name: 'Himalayan Hospitality Group',
    email: 'partner.demo@sewago.app',
    phone: '9841000910',
    phoneVerified: true,
    phoneVerifiedAt: now() - 14 * 24 * 60 * 60 * 1000,
    regNo: 'PAN-DEMO-445566',
    businessKycStatus: 'approved',
    businessKyc: {
      legalName: 'Himalayan Hospitality Group Pvt Ltd',
      regNo: 'PAN-DEMO-445566',
      documentRef: 'demo-certificate-himalayan-hospitality.pdf',
      submittedAt: now() - 14 * 24 * 60 * 60 * 1000,
      reviewedAt: now() - 13 * 24 * 60 * 60 * 1000,
      note: ''
    },
    password: hashPassword(DEMO_PASSWORDS.partner),
    earnings: 0
  };
  db.partners.push(partner);

  const restaurant = {
    id: demoId('restaurant', 'newa-kitchen'),
    ownerId: partner.id,
    name: 'Newa Kitchen Demo',
    cuisine: 'Newari · Snacks',
    rating: 4.7,
    etaMinutes: 28,
    deliveryFee: 65,
    icon: '🥘',
    status: 'approved',
    reviewNote: '',
    submittedAt: now() - 13 * 24 * 60 * 60 * 1000,
    reviewedAt: now() - 12 * 24 * 60 * 60 * 1000,
    menu: [
      { id: demoId('menu', 'chatamari'), name: 'Chicken Chatamari', price: 280, desc: 'Newari rice crepe with chicken and egg' },
      { id: demoId('menu', 'choila'), name: 'Buff Choila Set', price: 360, desc: 'Spiced grilled buff with beaten rice' },
      { id: demoId('menu', 'bara'), name: 'Mixed Bara Platter', price: 240, desc: 'Lentil patties with spicy achar' }
    ]
  };
  db.restaurants.push(restaurant);

  const hotel = {
    id: demoId('hotel', 'city-view'),
    ownerId: partner.id,
    name: 'City View Demo Hotel',
    city: 'Kathmandu',
    rating: 4.5,
    icon: '🏨',
    area: 'Lazimpat',
    desc: 'Business-friendly stay near embassies and cafes',
    status: 'approved',
    reviewNote: '',
    submittedAt: now() - 13 * 24 * 60 * 60 * 1000,
    reviewedAt: now() - 12 * 24 * 60 * 60 * 1000,
    rooms: [
      { id: demoId('room', 'city-standard'), type: 'Standard Queen', pricePerNight: 3200, count: 8, sleeps: 2, amenities: ['WiFi', 'Breakfast', 'AC'] },
      { id: demoId('room', 'city-suite'), type: 'Terrace Suite', pricePerNight: 6500, count: 2, sleeps: 3, amenities: ['WiFi', 'Breakfast', 'AC', 'Terrace'] }
    ]
  };
  db.hotels.push(hotel);
  return { partner, restaurant, hotel };
}

function seedDemoData({ persist = true } = {}) {
  removeDemoData();
  const t = now();

  const users = {
    aarav: addUser('aarav', 'Aarav Shrestha', 'aarav.demo@sewago.app', '9841000001', 22000),
    maya: addUser('maya', 'Maya Gurung', 'maya.demo@sewago.app', '9841000002', 18000),
    nisha: addUser('nisha', 'Nisha Rana', 'nisha.demo@sewago.app', '9841000003', 16000),
    kabir: addUser('kabir', 'Kabir Lama', 'kabir.demo@sewago.app', '9841000004', 14000),
    puja: addUser('puja', 'Puja Karki', 'puja.demo@sewago.app', '9841000005', 12500)
  };

  const seedOnlineDrivers = [
    ensureSeedDriverOnline('drv-1', 27.7154, 85.3123, 12),
    ensureSeedDriverOnline('drv-2', 27.6893, 85.3436, 20),
    ensureSeedDriverOnline('drv-4', 27.6726, 85.3134, 18),
    ensureSeedDriverOnline('drv-7', 27.6789, 85.3494, 25)
  ].filter(Boolean);
  const drivers = {
    bijay: addDriver('bijay', 'Bijay Maharjan', 'bijay.demo@sewago.app', '9842000001', 'bike', 'Yamaha FZ', 'BA DEMO 1201', 'Patan Durbar Square', 27.6727, 85.3255),
    tara: addDriver('tara', 'Tara Tamang', 'tara.demo@sewago.app', '9842000002', 'car', 'Hyundai Grand i10', 'BA DEMO 4402', 'Thamel', 27.7154, 85.3123),
    om: addDriver('om', 'Om Gurung', 'om.demo@sewago.app', '9842000003', 'xl', 'Mahindra Scorpio', 'BA DEMO 8803', 'Koteshwor', 27.6789, 85.3494)
  };

  const { partner, restaurant, hotel } = addDemoPartnerInventory();
  const momo = db.restaurants.find((r) => r.id === 'res-momo-ghar');
  const thakali = db.restaurants.find((r) => r.id === 'res-thakali');
  const lakeside = db.hotels.find((h) => h.id === 'htl-lakeside');
  const thamelHotel = db.hotels.find((h) => h.id === 'htl-thamel');

  addRide({ id: 'aarav-thamel-patan', user: users.aarav, driver: drivers.bijay, pickup: 'Thamel', dropoff: 'Patan Durbar Square', tier: 'bike', payment: 'wallet', rating: 5, ageHours: 30 });
  addRide({ id: 'aarav-airport-jawalakhel', user: users.aarav, driver: drivers.tara, pickup: 'Tribhuvan Airport', dropoff: 'Jawalakhel', tier: 'car', payment: 'cash', rating: 4, ageHours: 8 });
  addRide({ id: 'maya-boudha-swayambhu', user: users.maya, driver: drivers.bijay, pickup: 'Boudhanath Stupa', dropoff: 'Swayambhunath', tier: 'bike', payment: 'wallet', rating: 5, ageHours: 18 });
  addRide({ id: 'nisha-koteshwor-thamel', user: users.nisha, driver: drivers.om, pickup: 'Koteshwor', dropoff: 'Thamel', tier: 'xl', payment: 'wallet', rating: 5, ageHours: 44 });

  addOrder({ id: 'aarav-active-momo', user: users.aarav, restaurant: momo, itemIds: [['mg-1', 2], ['mg-3', 1]], status: 'active', ageSeconds: 28 });
  addOrder({ id: 'aarav-delivered-newa', user: users.aarav, restaurant, itemIds: [[demoId('menu', 'chatamari'), 1], [demoId('menu', 'bara'), 1]], status: 'delivered', ageSeconds: 86400 });
  addOrder({ id: 'maya-active-thakali', user: users.maya, restaurant: thakali, itemIds: [['tk-1', 1], ['tk-4', 1]], status: 'active', ageSeconds: 55 });

  addBooking({ id: 'aarav-lakeside', user: users.aarav, hotel: lakeside, room: lakeside.rooms[1], checkIn: daysFromNow(5), checkOut: daysFromNow(7), status: 'active', ageDays: 1 });
  addBooking({ id: 'aarav-city-view', user: users.aarav, hotel, room: hotel.rooms[0], checkIn: daysFromNow(12), checkOut: daysFromNow(13), status: 'active', ageDays: 0.5 });
  addBooking({ id: 'nisha-thamel', user: users.nisha, hotel: thamelHotel, room: thamelHotel.rooms[0], checkIn: daysFromNow(3), checkOut: daysFromNow(5), status: 'active', ageDays: 1 });

  addTask({ id: 'open-grocery', poster: users.maya, title: 'Buy groceries from Bhatbhateni', category: 'shopping', desc: 'Milk, eggs, rice and vegetables. Deliver by evening.', place: 'Maharajgunj', budget: 650, status: 'open', ageHours: 2 });
  addTask({ id: 'open-documents', poster: users.nisha, title: 'Deliver documents to Lalitpur', category: 'delivery', desc: 'Pickup sealed envelope from New Road, drop at Jawalakhel.', place: 'New Road', budget: 900, status: 'open', ageHours: 4 });
  addTask({ id: 'open-cleaning', poster: users.kabir, title: 'Clean one-bedroom apartment', category: 'cleaning', desc: 'Basic cleaning after moving out. Supplies provided.', place: 'Thamel', budget: 1800, status: 'open', ageHours: 7 });
  addTask({ id: 'aarav-posted-open', poster: users.aarav, title: 'Pick up dry cleaning', category: 'delivery', desc: 'Collect two jackets and bring to Lazimpat.', place: 'Lazimpat', budget: 450, status: 'open', ageHours: 1 });
  addTask({ id: 'aarav-posted-done', poster: users.aarav, worker: users.puja, title: 'Fix kitchen tap leak', category: 'repair', desc: 'Small leak under kitchen sink.', place: 'Balaju', budget: 1400, status: 'done', ageHours: 20 });
  addTask({ id: 'aarav-working', poster: users.kabir, worker: users.aarav, title: 'Assemble study table', category: 'repair', desc: 'Flat-pack desk and chair from Daraz.', place: 'Kirtipur', budget: 1200, status: 'assigned', ageHours: 6 });
  addTask({ id: 'completed-demo', poster: users.maya, worker: users.aarav, title: 'Drop parcel at airport cargo', category: 'delivery', desc: 'Small package, receipt required.', place: 'Tribhuvan Airport', budget: 1000, status: 'completed', ageHours: 48 });

  // Fresh marketplace request for driver app demos. It will expire naturally if not accepted.
  const live = fareFor('bike', 'Boudhanath Stupa', 'Swayambhunath');
  db.rides.push({
    id: demoId('ride', 'live-bike-request'),
    userId: users.puja.id,
    customerName: users.puja.name,
    pickup: live.pickup.name,
    dropoff: live.dropoff.name,
    pickupLoc: { lat: live.pickup.lat, lng: live.pickup.lng },
    dropoffLoc: { lat: live.dropoff.lat, lng: live.dropoff.lng },
    tier: 'bike',
    tierLabel: live.tierLabel,
    icon: live.icon,
    distanceKm: live.distanceKm,
    fare: live.fare,
    payment: 'cash',
    mode: 'live',
    driver: null,
    driverId: null,
    driverStart: null,
    driverEtaToPickupMin: null,
    status: 'searching',
    searchTimeoutSeconds: 10 * 60,
    tripSeconds: Math.min(90, Math.max(20, Math.round(live.distanceKm * 8))),
    rating: null,
    createdAt: t
  });

  if (persist) save();
  return {
    users: Object.keys(users).length,
    onlineDrivers: seedOnlineDrivers.length + Object.keys(drivers).length,
    partner: partner.email,
    restaurants: db.restaurants.filter((r) => String(r.id).startsWith('demo-')).length,
    hotels: db.hotels.filter((h) => String(h.id).startsWith('demo-')).length,
    rides: db.rides.filter((r) => String(r.id).startsWith('demo-')).length,
    orders: db.orders.filter((o) => String(o.id).startsWith('demo-')).length,
    bookings: db.bookings.filter((b) => String(b.id).startsWith('demo-')).length,
    tasks: db.tasks.filter((task) => String(task.id).startsWith('demo-')).length,
    credentials: {
      customers: [
        'aarav.demo@sewago.app',
        'maya.demo@sewago.app',
        'nisha.demo@sewago.app',
        'kabir.demo@sewago.app',
        'puja.demo@sewago.app'
      ],
      customerPassword: DEMO_PASSWORDS.customer,
      partner: partner.email,
      partnerPassword: DEMO_PASSWORDS.partner,
      drivers: ['ramesh@sewago.app', 'sunita@sewago.app', 'sita@sewago.app', 'dipesh@sewago.app', 'bijay.demo@sewago.app', 'tara.demo@sewago.app', 'om.demo@sewago.app'],
      driverPassword: DEMO_PASSWORDS.driver
    }
  };
}

module.exports = { seedDemoData, DEMO_PASSWORDS };
