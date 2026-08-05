const { db, save } = require('./db');
const { hashPassword } = require('./passwords');
const { recordTxn } = require('./payments');
const { coordsFor, haversineKm } = require('./places');
const { ROAD_FACTOR, payoutFor, driverPublic } = require('./rideLogic');
const storeSearch = require('./storeSearch');

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
  // Shops also live in the search index, so drop them there before the array.
  for (const store of db.stores || []) {
    if (String(store.id || '').startsWith('demo-')) storeSearch.unindexStore(store.id);
  }
  if (Array.isArray(db.stores)) db.stores = db.stores.filter(removeDemo);
  const demoStoreRef = (x) => String(x.storeId || '').startsWith('demo-');
  if (Array.isArray(db.stockMoves)) db.stockMoves = db.stockMoves.filter((m) => !demoStoreRef(m));
  if (Array.isArray(db.itemSubscriptions)) {
    db.itemSubscriptions = db.itemSubscriptions.filter(
      (s) => !String(s.id || '').startsWith('demo-') && !demoStoreRef(s) && !String(s.userId || '').startsWith('demo-')
    );
  }
  if (Array.isArray(db.subscriptionRequests)) {
    db.subscriptionRequests = db.subscriptionRequests.filter(
      (r) => !String(r.id || '').startsWith('demo-') && !demoStoreRef(r) && !String(r.userId || '').startsWith('demo-')
    );
  }
  if (Array.isArray(db.deliveryRuns)) {
    db.deliveryRuns = db.deliveryRuns.filter((r) => !String(r.id || '').startsWith('demo-') && !demoStoreRef(r));
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
    // Match the live model: delivered income is settled (withdrawable earnings);
    // anything still in flight sits in pendingEarnings until the courier delivers.
    const settled = status === 'delivered';
    order.partnerSettled = settled;
    if (settled) owner.earnings = (owner.earnings || 0) + order.partnerCut;
    else owner.pendingEarnings = (owner.pendingEarnings || 0) + order.partnerCut;
    recordTxn('partner', owner, {
      type: settled ? 'order_income' : 'order_income_pending',
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
    // Active bookings whose check-in is still ahead are refundable, so their
    // income is pending; anything else (past check-in / non-active) is settled.
    const today = new Date().toISOString().slice(0, 10);
    const settled = !(status === 'active' && checkIn > today);
    booking.settled = settled;
    if (settled) owner.earnings = (owner.earnings || 0) + booking.partnerCut;
    else owner.pendingEarnings = (owner.pendingEarnings || 0) + booking.partnerCut;
    recordTxn('partner', owner, {
      type: settled ? 'booking_income' : 'booking_income_pending',
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

/* ---------------- kirana shops ---------------- */

// Deterministic 0..1 from a string, so repeated seeds produce the same market.
function seededRand(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// What a Kathmandu kirana actually stocks, at street prices (NPR).
// perDay is a typical daily sales velocity used to build believable history.
const KIRANA_CATALOG = [
  { name: 'Chamal (Sona Mansuli)', unit: 'kg', price: 92, category: 'Rice & Grains', perDay: 6 },
  { name: 'Jira Masino Chamal 20kg', unit: 'sack', price: 2450, category: 'Rice & Grains', perDay: 0.4 },
  { name: 'Chiura', unit: 'kg', price: 95, category: 'Rice & Grains', perDay: 1.5 },
  { name: 'Musuro Dal', unit: 'kg', price: 185, category: 'Rice & Grains', perDay: 2 },
  { name: 'Chini', unit: 'kg', price: 110, category: 'Rice & Grains', perDay: 4 },
  { name: 'Aayo Nun', unit: 'packet', price: 25, category: 'Spices & Oil', perDay: 3 },
  { name: 'Dhara Sunflower Oil 1L', unit: 'bottle', price: 265, category: 'Spices & Oil', perDay: 1.5 },
  { name: 'Besar 100g', unit: 'packet', price: 60, category: 'Spices & Oil', perDay: 0.6 },
  { name: 'Jeera 100g', unit: 'packet', price: 85, category: 'Spices & Oil', perDay: 0.5 },
  { name: 'Tokla Chiya 500g', unit: 'packet', price: 240, category: 'Spices & Oil', perDay: 0.7 },
  { name: 'Wai Wai Chicken', unit: 'packet', price: 25, category: 'Snacks', perDay: 14 },
  { name: 'Rara Masala Noodles', unit: 'packet', price: 32, category: 'Snacks', perDay: 5 },
  { name: 'Parle-G', unit: 'packet', price: 20, category: 'Snacks', perDay: 8 },
  { name: 'Hulas Digestive Biscuit', unit: 'packet', price: 55, category: 'Snacks', perDay: 3 },
  { name: 'Lays Classic Salted', unit: 'packet', price: 65, category: 'Snacks', perDay: 4 },
  { name: 'Kurkure Masala Munch', unit: 'packet', price: 35, category: 'Snacks', perDay: 5 },
  { name: 'Dairy Milk Chocolate', unit: 'each', price: 120, category: 'Snacks', perDay: 2 },
  { name: 'Coca-Cola 1L', unit: 'bottle', price: 135, category: 'Drinks', perDay: 3 },
  { name: 'Frooti 200ml', unit: 'each', price: 35, category: 'Drinks', perDay: 5 },
  { name: 'Himalayan Spring Water 1L', unit: 'bottle', price: 30, category: 'Drinks', perDay: 6 },
  { name: 'Real Mixed Fruit Juice 1L', unit: 'packet', price: 250, category: 'Drinks', perDay: 1 },
  { name: 'DDC Dudh 500ml', unit: 'packet', price: 62, category: 'Dairy & Eggs', perDay: 10, subscribable: true },
  { name: 'Local Anda', unit: 'dozen', price: 250, category: 'Dairy & Eggs', perDay: 3, subscribable: true },
  { name: 'DDC Paneer 200g', unit: 'packet', price: 180, category: 'Dairy & Eggs', perDay: 0.8 },
  { name: 'Juju Dhau 200ml', unit: 'each', price: 90, category: 'Dairy & Eggs', perDay: 1.2 },
  { name: 'Aalu', unit: 'kg', price: 55, category: 'Vegetables', perDay: 8 },
  { name: 'Pyaj', unit: 'kg', price: 95, category: 'Vegetables', perDay: 7 },
  { name: 'Golbheda', unit: 'kg', price: 85, category: 'Vegetables', perDay: 5 },
  { name: 'Hariyo Khursani 250g', unit: 'packet', price: 30, category: 'Vegetables', perDay: 2 },
  { name: 'Kauli', unit: 'kg', price: 70, category: 'Vegetables', perDay: 3 },
  { name: 'Surf Excel 500g', unit: 'packet', price: 155, category: 'Household', perDay: 1 },
  { name: 'Vim Bar', unit: 'each', price: 30, category: 'Household', perDay: 2 },
  { name: 'Harpic 500ml', unit: 'bottle', price: 210, category: 'Household', perDay: 0.5 },
  { name: 'Mainbatti Packet', unit: 'packet', price: 50, category: 'Household', perDay: 0.5 },
  { name: 'Colgate 100g', unit: 'each', price: 185, category: 'Personal Care', perDay: 1 },
  { name: 'Lifebuoy Sabun', unit: 'each', price: 65, category: 'Personal Care', perDay: 2.5 },
  { name: 'Sunsilk Shampoo 180ml', unit: 'bottle', price: 340, category: 'Personal Care', perDay: 0.5 },
  { name: 'Clinic Plus Sachet', unit: 'each', price: 10, category: 'Personal Care', perDay: 6 },
  { name: 'Horlicks 500g', unit: 'bottle', price: 780, category: 'Baby & Health', perDay: 0.4 },
  { name: 'Cerelac Wheat 300g', unit: 'packet', price: 550, category: 'Baby & Health', perDay: 0.3 }
];

// Real neighbourhoods, real coordinates — these pins land where the areas are.
const DEMO_SHOPS = [
  { key: 'ram-kirana', name: 'Ram Kirana Pasal', icon: '🏪', area: 'Thamel', lat: 27.7148, lng: 85.3121, deliveryFee: 40, owner: 'shopkeeper', full: true },
  { key: 'sita-general', name: 'Sita General Store', icon: '🛒', area: 'New Baneshwor', lat: 27.6899, lng: 85.343, deliveryFee: 50, owner: 'shopkeeper' },
  { key: 'city-mart', name: 'City Mart Lazimpat', icon: '🏬', area: 'Lazimpat', lat: 27.7218, lng: 85.3216, deliveryFee: 60, owner: 'partner' },
  { key: 'gurung-cold-store', name: 'Gurung Cold Store', icon: '🧊', area: 'Jawalakhel', lat: 27.6738, lng: 85.3142, deliveryFee: 45, owner: 'valley' },
  { key: 'boudha-fresh', name: 'Boudha Fresh Mart', icon: '🥬', area: 'Boudha', lat: 27.7208, lng: 85.361, deliveryFee: 55, owner: 'valley' },
  { key: 'koteshwor-suppliers', name: 'Koteshwor Kirana Suppliers', icon: '🏪', area: 'Koteshwor', lat: 27.6786, lng: 85.349, deliveryFee: 35, owner: 'valley', open: false }
];

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Quantities in believable shop units: whole pieces, half-kilos.
function roundQty(unit, qty) {
  if (unit === 'kg' || unit === 'l') return Math.max(0.5, Math.round(qty * 2) / 2);
  return Math.max(1, Math.round(qty));
}

function dateKeyAgo(daysAgo) {
  return new Date(now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

// Hand-tuned shelf situations for the flagship shop so the dashboard has a
// story to tell: a fast mover nearly gone, oil sold out, eggs running low.
const FLAGSHIP_STOCK = {
  'Wai Wai Chicken': 4,
  'Dhara Sunflower Oil 1L': 0,
  'Local Anda': 2,
  'Chini': 3
};

function buildShopItem(shop, product) {
  const r = (purpose) => seededRand(`${shop.key}:${product.name}:${purpose}`);
  // Every shop prices a little differently — that is what makes comparing fun.
  let price = Math.round(product.price * (0.96 + 0.08 * r('price')));
  if (price > 500) price = Math.round(price / 5) * 5;
  const createdAt = now() - Math.round((40 + 10 * r('age')) * 86400000);

  // Three weeks of daily sales at the item's natural pace, with day-to-day wobble.
  const salesDaily = {};
  let recentSold = 0;
  for (let d = 0; d <= 20; d += 1) {
    let qty = product.perDay * (0.55 + 0.9 * r(`day${d}`));
    if (d === 0) qty *= 0.5; // today is still in progress
    if (qty < (product.perDay >= 1 ? 0.5 : 0.2)) continue;
    qty = roundQty(product.unit, qty);
    salesDaily[dateKeyAgo(d)] = qty;
    recentSold += qty;
  }

  const targetStock = Object.prototype.hasOwnProperty.call(FLAGSHIP_STOCK, product.name) && shop.full
    ? FLAGSHIP_STOCK[product.name]
    : roundQty(product.unit, Math.max(0.5, product.perDay * (3 + 18 * r('cover'))));

  return {
    id: demoId('item', `${shop.key}-${slug(product.name)}`),
    name: product.name,
    unit: product.unit,
    price,
    subscribePrice: product.subscribable && shop.owner === 'shopkeeper' ? Math.round(price * 0.93) : null,
    stock: targetStock,
    lowStockAt: null,
    category: product.category,
    photo: '',
    photos: [],
    salesDaily,
    soldTotal: Math.round((recentSold * 2.2) * 10) / 10,
    createdAt,
    updatedAt: now()
  };
}

/**
 * A consistent audit trail for one item: an opening shelf count, then the last
 * three days of counter sales (and a restock for the fast mover), each move's
 * stockAfter agreeing with the one before it and ending at today's shelf count.
 */
function ledgerMovesFor(store, item, shopkeeperName) {
  const events = [];
  if (item.name === 'Wai Wai Chicken') {
    events.push({ qty: 36, reason: 'restock', at: now() - 3 * 86400000 - 8 * 3600000 });
  }
  for (let d = 2; d >= 0; d -= 1) {
    const sold = item.salesDaily[dateKeyAgo(d)] || 0;
    if (sold <= 0) continue;
    const morning = roundQty(item.unit, sold * 0.6);
    const evening = Math.round((sold - morning) * 10) / 10;
    events.push({ qty: -Math.min(morning, sold), reason: 'sale_counter', at: now() - d * 86400000 - 7 * 3600000 });
    if (evening > 0) events.push({ qty: -evening, reason: 'sale_counter', at: now() - d * 86400000 - 2 * 3600000 });
  }

  // Walk forward from an opening count chosen so the chain lands exactly on
  // today's stock; if sales outrun it, clamp and correct the final stock.
  const delta = events.reduce((sum, e) => sum + e.qty, 0);
  let running = Math.max(0, Math.round((item.stock - delta) * 10) / 10);
  const moves = [{
    storeId: store.id, itemId: item.id, itemName: item.name,
    qty: running, reason: 'initial_count', stockAfter: running,
    actorKind: 'partner', actorId: store.ownerId, actorName: shopkeeperName,
    refId: null, at: item.createdAt
  }];
  for (const e of events) {
    running = Math.max(0, Math.round((running + e.qty) * 10) / 10);
    moves.push({
      storeId: store.id, itemId: item.id, itemName: item.name,
      qty: e.qty, reason: e.reason, stockAfter: running,
      actorKind: 'partner', actorId: store.ownerId, actorName: shopkeeperName,
      refId: null, at: e.at
    });
  }
  item.stock = running;
  return moves;
}

function addShopPartner(id, name, legalName, email, phone) {
  const partner = {
    id: demoId('partner', id),
    name,
    email,
    phone,
    phoneVerified: true,
    phoneVerifiedAt: now() - 25 * 24 * 60 * 60 * 1000,
    regNo: `PAN-DEMO-${phone.slice(-6)}`,
    businessKycStatus: 'approved',
    businessKyc: {
      legalName,
      regNo: `PAN-DEMO-${phone.slice(-6)}`,
      documentRef: `demo-certificate-${id}.pdf`,
      submittedAt: now() - 25 * 24 * 60 * 60 * 1000,
      reviewedAt: now() - 24 * 24 * 60 * 60 * 1000,
      note: ''
    },
    password: hashPassword(DEMO_PASSWORDS.partner),
    earnings: 0
  };
  db.partners.push(partner);
  return partner;
}

function addDemoStores(users, hospitalityPartner) {
  const shopkeeper = addShopPartner('ram-shrestha', 'Ram Bahadur Shrestha', 'Ram Kirana Pasal Pvt Ltd', 'shopkeeper.demo@sewago.app', '9841000920');
  const valley = addShopPartner('valley-retail', 'Valley Retail Suppliers', 'Valley Retail Suppliers Pvt Ltd', 'valley.demo@sewago.app', '9841000930');
  const owners = { shopkeeper, partner: hospitalityPartner, valley };

  const stores = [];
  const allMoves = [];
  let itemCount = 0;

  for (const spec of DEMO_SHOPS) {
    const owner = owners[spec.owner];
    const store = {
      id: demoId('store', spec.key),
      ownerId: owner.id,
      name: spec.name,
      area: spec.area,
      loc: { name: spec.area, lat: spec.lat, lng: spec.lng },
      locPinned: true,
      icon: spec.icon,
      photo: '',
      photos: [],
      deliveryFee: spec.deliveryFee,
      open: spec.open !== false,
      items: [],
      helpers: [],
      status: 'approved',
      reviewNote: '',
      submittedAt: now() - 20 * 24 * 60 * 60 * 1000,
      reviewedAt: now() - 19 * 24 * 60 * 60 * 1000
    };

    for (const product of KIRANA_CATALOG) {
      // The flagship carries the full range; smaller shops a personal subset.
      // The cold store always stocks its namesake chilled lines.
      const chilled = product.category === 'Dairy & Eggs' || product.category === 'Drinks';
      const keep = spec.full ||
        (spec.key === 'gurung-cold-store' && chilled) ||
        seededRand(`${spec.key}:${product.name}:carries`) < 0.6;
      if (!keep) continue;
      const item = buildShopItem(spec, product);
      store.items.push(item);
      itemCount += 1;
    }

    // The audit trail is the feature — every shop's ledger should reconcile.
    for (const item of store.items) {
      allMoves.push(...ledgerMovesFor(store, item, owner.name));
    }

    db.stores.push(store);
    stores.push(store);
  }

  // The ledger is append-only and read newest-first, so keep global time order.
  allMoves.sort((a, b) => a.at - b.at);
  allMoves.forEach((move, i) => {
    db.stockMoves.push({ id: demoId('move', String(i + 1)), ...move });
  });

  // A live helper on the flagship shop, plus one invite still waiting.
  const flagship = stores[0];
  flagship.helpers.push(
    { code: '734519', status: 'active', userId: users.puja.id, name: users.puja.name, createdAt: now() - 10 * 86400000, joinedAt: now() - 10 * 86400000 },
    { code: '281673', status: 'invited', userId: null, name: 'Suresh', createdAt: now() - 86400000 }
  );

  // Standing daily-needs subscriptions, at the subscriber price.
  const milk = flagship.items.find((i) => i.name === 'DDC Dudh 500ml');
  const eggs = flagship.items.find((i) => i.name === 'Local Anda');
  if (milk && milk.subscribePrice) {
    db.itemSubscriptions.push({
      id: demoId('sub', 'aarav-milk'), userId: users.aarav.id,
      storeId: flagship.id, storeName: flagship.name,
      itemId: milk.id, itemName: milk.name,
      everyDays: 2, price: milk.subscribePrice, listPrice: milk.price,
      status: 'active', createdAt: now() - 12 * 86400000, nextDueAt: now() + 86400000
    });
  }
  if (eggs && eggs.subscribePrice) {
    db.itemSubscriptions.push({
      id: demoId('sub', 'maya-anda'), userId: users.maya.id,
      storeId: flagship.id, storeName: flagship.name,
      itemId: eggs.id, itemName: eggs.name,
      everyDays: 7, price: eggs.subscribePrice, listPrice: eggs.price,
      status: 'active', createdAt: now() - 6 * 86400000, nextDueAt: now() + 86400000
    });
  }

  // A customer asking for a subscriber price the shop has not answered yet —
  // gives the partner app's Subscriptions inbox something real to decide on.
  const dhau = flagship.items.find((i) => i.name === 'Juju Dhau 200ml');
  if (dhau && !dhau.subscribePrice) {
    db.subscriptionRequests.push({
      id: demoId('subreq', 'kabir-dhau'), userId: users.kabir.id, userName: users.kabir.name,
      storeId: flagship.id, itemId: dhau.id, itemName: dhau.name,
      status: 'pending', createdAt: now() - 2 * 3600000
    });
  }

  for (const store of stores) storeSearch.indexStore(store);
  return { shopkeeper, stores, itemCount };
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
  const shops = addDemoStores(users, partner);
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
    stores: shops.stores.length,
    storeItems: shops.itemCount,
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
      shopkeeper: shops.shopkeeper.email,
      partnerPassword: DEMO_PASSWORDS.partner,
      drivers: ['ramesh@sewago.app', 'sunita@sewago.app', 'sita@sewago.app', 'dipesh@sewago.app', 'bijay.demo@sewago.app', 'tara.demo@sewago.app', 'om.demo@sewago.app'],
      driverPassword: DEMO_PASSWORDS.driver
    }
  };
}

module.exports = { seedDemoData, DEMO_PASSWORDS };
