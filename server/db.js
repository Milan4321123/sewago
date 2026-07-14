const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require('./passwords');
const { coordsFor } = require('./places');
const { config } = require('./config');
const { loadSupabaseState, saveSupabaseState } = require('./storage/supabaseStateStore');
const supabaseRowStore = require('./storage/supabaseRowStore');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const db = {};
let initialized = false;

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// All seeded drivers can log in to the Driver app with password "driver123".
// "base" is the real place each driver waits at — arrival ETAs are computed from it.
const SEED_DRIVERS = [
  { id: 'drv-1', name: 'Ramesh Thapa', email: 'ramesh@sewago.app', tier: 'bike', vehicle: 'Bajaj Pulsar 150', plate: 'BA 94 PA 2041', rating: 4.9, base: 'Thamel' },
  { id: 'drv-2', name: 'Sunita Rai', email: 'sunita@sewago.app', tier: 'bike', vehicle: 'Honda Shine', plate: 'BA 12 PA 8890', rating: 4.8, base: 'New Baneshwor' },
  { id: 'drv-3', name: 'Bikash Gurung', email: 'bikash@sewago.app', tier: 'bike', vehicle: 'TVS Apache', plate: 'GA 5 PA 1122', rating: 4.7, base: 'Kalanki' },
  { id: 'drv-4', name: 'Sita Shrestha', email: 'sita@sewago.app', tier: 'car', vehicle: 'Suzuki Swift (White)', plate: 'BA 20 CHA 4455', rating: 4.9, base: 'Jawalakhel' },
  { id: 'drv-5', name: 'Hari Tamang', email: 'hari@sewago.app', tier: 'car', vehicle: 'Hyundai i20 (Silver)', plate: 'BA 8 CHA 7811', rating: 4.6, base: 'Chabahil' },
  { id: 'drv-6', name: 'Anita Karki', email: 'anita@sewago.app', tier: 'car', vehicle: 'Tata Tiago (Blue)', plate: 'GA 3 CHA 9034', rating: 4.8, base: 'Balaju' },
  { id: 'drv-7', name: 'Dipesh Lama', email: 'dipesh@sewago.app', tier: 'xl', vehicle: 'Toyota HiAce', plate: 'BA 2 JHA 5566', rating: 4.7, base: 'Koteshwor' },
  { id: 'drv-8', name: 'Krishna Adhikari', email: 'krishna@sewago.app', tier: 'xl', vehicle: 'Mahindra Scorpio', plate: 'BA 15 JHA 3321', rating: 4.8, base: 'Maharajgunj' }
];

function driverDefaults() {
  return { password: hashPassword('driver123'), online: false, earnings: 0, tripsCompleted: 0 };
}

function driverBase(base) {
  const loc = coordsFor(base);
  return { baseName: loc.name, baseLat: loc.lat, baseLng: loc.lng };
}

function seed() {
  return {
    users: [],
    tokens: {},
    driverTokens: {},
    partners: [],
    partnerTokens: {},
    drivers: SEED_DRIVERS.map((d) => ({ ...d, ...driverDefaults(), ...driverBase(d.base) })),
    restaurants: [
      {
        id: 'res-momo-ghar', name: 'Momo Ghar', cuisine: 'Nepali · Momo', rating: 4.8,
        etaMinutes: 25, deliveryFee: 60, icon: '🥟',
        menu: [
          { id: 'mg-1', name: 'Steam Chicken Momo (10 pcs)', price: 180, desc: 'Juicy chicken momos with homemade achar' },
          { id: 'mg-2', name: 'Fried Buff Momo (10 pcs)', price: 200, desc: 'Crispy fried buff momos' },
          { id: 'mg-3', name: 'Jhol Momo', price: 220, desc: 'Momos dunked in warm sesame jhol' },
          { id: 'mg-4', name: 'Sadeko Momo', price: 210, desc: 'Tossed in spicy tangy masala' }
        ]
      },
      {
        id: 'res-thakali', name: 'Thakali Bhanchha', cuisine: 'Nepali · Thali', rating: 4.9,
        etaMinutes: 35, deliveryFee: 80, icon: '🍛',
        menu: [
          { id: 'tk-1', name: 'Chicken Thakali Set', price: 380, desc: 'Rice, chicken curry, gundruk, saag, achar' },
          { id: 'tk-2', name: 'Veg Thakali Set', price: 300, desc: 'Full veg thali with seasonal tarkari' },
          { id: 'tk-3', name: 'Dhido Set', price: 400, desc: 'Buckwheat dhido with local chicken' },
          { id: 'tk-4', name: 'Sukuti Sadeko', price: 250, desc: 'Smoked dried meat, tossed spicy' }
        ]
      },
      {
        id: 'res-pizza', name: 'Pizza Pasal', cuisine: 'Italian · Pizza', rating: 4.5,
        etaMinutes: 30, deliveryFee: 100, icon: '🍕',
        menu: [
          { id: 'pz-1', name: 'Margherita (Medium)', price: 550, desc: 'Classic tomato, mozzarella, basil' },
          { id: 'pz-2', name: 'Chicken BBQ (Medium)', price: 750, desc: 'BBQ chicken, onion, smoky sauce' },
          { id: 'pz-3', name: 'Veggie Supreme (Medium)', price: 620, desc: 'Loaded garden veggies' },
          { id: 'pz-4', name: 'Garlic Bread', price: 250, desc: 'With cheese dip' }
        ]
      },
      {
        id: 'res-burger', name: 'Burger Bros', cuisine: 'Fast food · Burgers', rating: 4.4,
        etaMinutes: 20, deliveryFee: 70, icon: '🍔',
        menu: [
          { id: 'bb-1', name: 'Classic Beefless Burger', price: 320, desc: 'Buff patty, house sauce' },
          { id: 'bb-2', name: 'Double Cheese Burger', price: 450, desc: 'Two patties, double cheese' },
          { id: 'bb-3', name: 'Crispy Chicken Burger', price: 380, desc: 'Fried chicken, slaw, mayo' },
          { id: 'bb-4', name: 'Masala Fries', price: 180, desc: 'Fries dusted with masala' }
        ]
      },
      {
        id: 'res-biryani', name: 'Biryani House', cuisine: 'Indian · Biryani', rating: 4.6,
        etaMinutes: 40, deliveryFee: 90, icon: '🍚',
        menu: [
          { id: 'bh-1', name: 'Chicken Biryani', price: 420, desc: 'Hyderabadi style, raita included' },
          { id: 'bh-2', name: 'Mutton Biryani', price: 520, desc: 'Slow-cooked mutton, saffron rice' },
          { id: 'bh-3', name: 'Veg Biryani', price: 320, desc: 'Seasonal vegetables, basmati' },
          { id: 'bh-4', name: 'Extra Raita', price: 80, desc: 'Cool cucumber raita' }
        ]
      },
      {
        id: 'res-juju', name: 'Juju Dhau & Sweets', cuisine: 'Desserts · Sweets', rating: 4.9,
        etaMinutes: 25, deliveryFee: 50, icon: '🍮',
        menu: [
          { id: 'jd-1', name: 'Juju Dhau (Clay Pot)', price: 150, desc: 'Bhaktapur king curd' },
          { id: 'jd-2', name: 'Lalmohan (4 pcs)', price: 120, desc: 'Warm syrupy lalmohan' },
          { id: 'jd-3', name: 'Jeri (4 pcs)', price: 80, desc: 'Crispy, syrup-soaked jeri' },
          { id: 'jd-4', name: 'Rasbari (4 pcs)', price: 140, desc: 'Soft milk rasbari' }
        ]
      }
    ],
    hotels: [
      {
        id: 'htl-himalaya', name: 'Himalaya Grand Hotel', city: 'Kathmandu', rating: 4.7, icon: '🏨',
        area: 'Durbar Marg', desc: '5-star comfort in the heart of the city',
        rooms: [
          { id: 'hg-std', type: 'Standard Room', pricePerNight: 3500, count: 5, sleeps: 2, amenities: ['WiFi', 'Breakfast', 'AC'] },
          { id: 'hg-dlx', type: 'Deluxe Room', pricePerNight: 5500, count: 3, sleeps: 2, amenities: ['WiFi', 'Breakfast', 'AC', 'City view'] },
          { id: 'hg-ste', type: 'Executive Suite', pricePerNight: 9000, count: 2, sleeps: 4, amenities: ['WiFi', 'Breakfast', 'AC', 'Living room', 'Bathtub'] }
        ]
      },
      {
        id: 'htl-thamel', name: 'Thamel Boutique Inn', city: 'Kathmandu', rating: 4.4, icon: '🏡',
        area: 'Thamel', desc: 'Cozy boutique stay for travellers',
        rooms: [
          { id: 'tb-std', type: 'Standard Room', pricePerNight: 2200, count: 6, sleeps: 2, amenities: ['WiFi', 'Breakfast'] },
          { id: 'tb-dlx', type: 'Deluxe Room', pricePerNight: 3800, count: 3, sleeps: 3, amenities: ['WiFi', 'Breakfast', 'Balcony'] }
        ]
      },
      {
        id: 'htl-everest', name: 'Everest Sky Hotel', city: 'Kathmandu', rating: 4.6, icon: '🏙️',
        area: 'Lazimpat', desc: 'Rooftop views of the valley',
        rooms: [
          { id: 'es-std', type: 'Standard Room', pricePerNight: 4000, count: 4, sleeps: 2, amenities: ['WiFi', 'Breakfast', 'AC'] },
          { id: 'es-exe', type: 'Executive Room', pricePerNight: 7000, count: 2, sleeps: 3, amenities: ['WiFi', 'Breakfast', 'AC', 'Mountain view'] }
        ]
      },
      {
        id: 'htl-lakeside', name: 'Lakeside Retreat', city: 'Pokhara', rating: 4.8, icon: '🌅',
        area: 'Lakeside', desc: 'Steps away from Phewa Lake',
        rooms: [
          { id: 'lr-std', type: 'Standard Room', pricePerNight: 3000, count: 5, sleeps: 2, amenities: ['WiFi', 'Breakfast'] },
          { id: 'lr-lkv', type: 'Lake View Room', pricePerNight: 4800, count: 3, sleeps: 2, amenities: ['WiFi', 'Breakfast', 'Lake view', 'Balcony'] },
          { id: 'lr-ste', type: 'Retreat Suite', pricePerNight: 8000, count: 1, sleeps: 4, amenities: ['WiFi', 'Breakfast', 'Lake view', 'Living room'] }
        ]
      },
      {
        id: 'htl-machha', name: 'Machhapuchhre View Lodge', city: 'Pokhara', rating: 4.5, icon: '⛰️',
        area: 'Sarangkot', desc: 'Sunrise over the Annapurnas',
        rooms: [
          { id: 'mv-std', type: 'Standard Room', pricePerNight: 1800, count: 6, sleeps: 2, amenities: ['WiFi', 'Breakfast'] },
          { id: 'mv-dlx', type: 'Deluxe Room', pricePerNight: 3200, count: 3, sleeps: 3, amenities: ['WiFi', 'Breakfast', 'Mountain view'] }
        ]
      },
      {
        id: 'htl-jungle', name: 'Jungle Safari Resort', city: 'Chitwan', rating: 4.6, icon: '🐘',
        area: 'Sauraha', desc: 'Safari lodge at the edge of the national park',
        rooms: [
          { id: 'js-cot', type: 'Safari Cottage', pricePerNight: 4200, count: 4, sleeps: 2, amenities: ['WiFi', 'Breakfast', 'Safari desk'] },
          { id: 'js-fam', type: 'Family Cottage', pricePerNight: 6500, count: 2, sleeps: 5, amenities: ['WiFi', 'Breakfast', 'Safari desk', 'Veranda'] }
        ]
      }
    ],
    rides: [],
    orders: [],
    bookings: []
  };
}

// Upgrade databases created before the Driver app / real locations existed.
function migrate(data) {
  data.driverTokens = data.driverTokens || {};
  data.partners = data.partners || [];
  data.partnerTokens = data.partnerTokens || {};
  data.adminTokens = data.adminTokens || {};
  data.tasks = data.tasks || [];
  data.payments = data.payments || [];
  data.withdrawals = data.withdrawals || [];
  data.transactions = data.transactions || [];
  data.platformLedger = data.platformLedger || [];
  data.otpCodes = data.otpCodes || [];
  data.passwordResetTokens = data.passwordResetTokens || [];
  data.uploads = data.uploads || [];
  data.reviews = data.reviews || [];
  for (const user of data.users) {
    if (user.phone === undefined) user.phone = '';
    if (user.phoneVerified === undefined) user.phoneVerified = false;
  }
  for (const partner of data.partners) {
    if (partner.phone === undefined) partner.phone = '';
    if (partner.regNo === undefined) partner.regNo = '';
    if (partner.earnings === undefined) partner.earnings = 0;
    if (partner.phoneVerified === undefined) partner.phoneVerified = false;
    const hasPartnerListings = [...data.restaurants, ...data.hotels].some((x) => x.ownerId === partner.id);
    if (!partner.businessKycStatus) partner.businessKycStatus = hasPartnerListings ? 'approved' : 'pending';
    if (!partner.businessKyc) {
      partner.businessKyc = {
        legalName: partner.name,
        regNo: partner.regNo,
        documentRef: '',
        submittedAt: partner.regNo ? Date.now() : null,
        reviewedAt: null,
        note: ''
      };
    }
  }
  for (const ride of data.rides) {
    if (!ride.payment) ride.payment = 'wallet';
  }
  // Listings created before the approval flow (and seeded ones) stay live.
  for (const listing of [...data.restaurants, ...data.hotels]) {
    if (!listing.status) {
      listing.status = 'approved';
      listing.reviewNote = '';
    }
  }
  // Restaurants need pickup coordinates for courier dispatch. Seeded ones get
  // their real neighbourhood; anything else resolves via the gazetteer (stable
  // pseudo-location for unknown names — good enough until the partner edits it).
  const SEED_RESTAURANT_AREAS = {
    'res-momo-ghar': 'Thamel',
    'res-thakali': 'Jawalakhel',
    'res-pizza': 'New Road',
    'res-burger': 'New Baneshwor',
    'res-biryani': 'Kalanki',
    'res-juju': 'Bhaktapur Durbar Square'
  };
  for (const r of data.restaurants) {
    if (!r.loc) {
      const spot = coordsFor(SEED_RESTAURANT_AREAS[r.id] || r.area || r.name);
      r.loc = { name: spot.name, lat: spot.lat, lng: spot.lng };
    }
  }
  // Orders created before live fulfillment existed keep the demo timers.
  for (const order of data.orders) {
    if (!order.fulfillment) order.fulfillment = 'sim';
  }
  // Seeded ratings become weighted starting points for real customer ratings:
  // the count says how many "votes" the seed value is worth.
  for (const r of data.restaurants) {
    if (r.ratingCount === undefined) r.ratingCount = r.rating ? 25 : 0;
  }
  for (const driver of data.drivers) {
    if (driver.ratingCount === undefined) driver.ratingCount = driver.rating ? 50 : 0;
  }
  for (const seedDriver of SEED_DRIVERS) {
    const existing = data.drivers.find((d) => d.id === seedDriver.id);
    if (!existing) {
      data.drivers.push({ ...seedDriver, ...driverDefaults(), ...driverBase(seedDriver.base) });
    } else if (!existing.email) {
      Object.assign(existing, { email: seedDriver.email }, driverDefaults());
    }
  }
  for (const driver of data.drivers) {
    if (driver.baseLat == null) {
      const seedDriver = SEED_DRIVERS.find((d) => d.id === driver.id);
      Object.assign(driver, driverBase(seedDriver ? seedDriver.base : 'Thamel'));
    }
    if (!driver.verificationStatus) {
      driver.verificationStatus = 'verified';
      driver.licenseVerified = true;
      driver.licenseLast4 = driver.licenseLast4 || 'demo';
      driver.licenseVerifiedAt = driver.licenseVerifiedAt || Date.now();
    }
    if (driver.licenseVerified === undefined) {
      driver.licenseVerified = driver.verificationStatus === 'verified';
    }
    if (driver.phone === undefined) driver.phone = '';
    if (driver.phoneVerified === undefined) driver.phoneVerified = driver.id && driver.id.startsWith('drv-');
    if (!driver.kycStatus) driver.kycStatus = driver.licenseVerified ? 'approved' : 'pending';
    if (!driver.kyc) {
      driver.kyc = {
        licenseLast4: driver.licenseLast4 || '',
        vehicle: driver.vehicle || '',
        plate: driver.plate || '',
        submittedAt: driver.licenseVerifiedAt || null,
        reviewedAt: driver.licenseVerifiedAt || null,
        note: ''
      };
    }
  }
  for (const ride of data.rides) {
    if (!ride.mode) ride.mode = 'sim';
    // Old rides stored the full driver record; keep only public fields.
    if (ride.driver) {
      const { id, name, vehicle, plate, rating } = ride.driver;
      ride.driver = { id, name, vehicle, plate, rating };
    }
    if (!ride.pickupLoc) {
      const p = coordsFor(ride.pickup);
      const q = coordsFor(ride.dropoff);
      ride.pickupLoc = { lat: p.lat, lng: p.lng };
      ride.dropoffLoc = { lat: q.lat, lng: q.lng };
    }
  }
  return data;
}

function replaceDb(next) {
  for (const key of Object.keys(db)) delete db[key];
  Object.assign(db, migrate(next));
}

function loadJsonState() {
  if (fs.existsSync(DB_PATH)) {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }
  return seed();
}

// Atomic write: never leave a half-written db.json if the process dies mid-save.
function saveJsonState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_PATH);
}

async function saveJsonStateAsync() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(db));
  await fs.promises.rename(tmp, DB_PATH);
}

function initJsonSync() {
  replaceDb(loadJsonState());
  initialized = true;
  saveJsonState();
}

// Rotating on-disk backups of the JSON state (kept next to it in backups/).
// Money data lives in this file — a bad deploy or fat-fingered delete should
// never be able to erase the only copy. Keeps the newest 14.
function backupJsonState() {
  if (config.dataStore !== 'json' || !fs.existsSync(DB_PATH)) return;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  fs.copyFileSync(DB_PATH, path.join(dir, `db-${stamp}.json`));
  const old = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort();
  while (old.length > 14) fs.unlinkSync(path.join(dir, old.shift()));
}

async function initDb() {
  if (initialized) return db;
  if (config.dataStore === 'json') {
    initJsonSync();
    return db;
  }
  if (config.dataStore === 'supabase') {
    const loaded = await loadSupabaseState(migrate(seed()));
    replaceDb(loaded);
    initialized = true;
    return db;
  }
  if (config.dataStore === 'supabase_rows') {
    const loaded = await supabaseRowStore.loadState(migrate(seed()));
    replaceDb(loaded);
    initialized = true;
    return db;
  }
  throw new Error(`Unsupported DATA_STORE=${config.dataStore}. Use "json", "supabase" or "supabase_rows".`);
}

function snapshot() {
  return JSON.parse(JSON.stringify(db));
}

// Saves are coalesced: mutations mark the state dirty and one background flush
// per interval persists everything. Serializing the whole db on every request
// collapses under load (measured: 1,365 -> 33 rps at 18 MB of data), so writes
// are decoupled from requests. Crash guards and shutdown call flushSaves() to
// force the final write, capping the loss window at one interval.
const SAVE_INTERVAL_MS = 1000;
let dirty = false;
let flushTimer = null;
let flushing = null;
// Persistence health, exposed via saveHealth() for /api/health. A save loop that
// silently backs up is a data-loss risk, so monitors need to see it.
let lastFlushAt = 0;
let lastFlushMs = 0;
let lastFlushError = null;

function saveHealth() {
  return {
    dirty,
    lastFlushAt: lastFlushAt || null,
    lastFlushMs,
    lastError: lastFlushError,
    staleMs: lastFlushAt ? Date.now() - lastFlushAt : null
  };
}

function persist() {
  if (config.dataStore === 'json') return saveJsonStateAsync();
  if (config.dataStore === 'supabase_rows') return supabaseRowStore.saveState(db);
  return saveSupabaseState(snapshot());
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow().catch((err) => console.error('State save failed (will retry):', err.message || err));
  }, SAVE_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

async function flushNow() {
  if (flushing) await flushing.catch(() => {});
  if (!dirty) return;
  dirty = false;
  const startedFlush = Date.now();
  flushing = persist();
  try {
    await flushing;
    lastFlushAt = Date.now();
    lastFlushMs = lastFlushAt - startedFlush;
    lastFlushError = null;
  } catch (err) {
    dirty = true; // keep the data; retry on the next interval
    lastFlushError = err && err.message ? err.message : String(err);
    scheduleFlush();
    throw err;
  } finally {
    flushing = null;
  }
  if (dirty) scheduleFlush();
}

function save() {
  if (!initialized) return Promise.resolve();
  dirty = true;
  scheduleFlush();
  return Promise.resolve();
}

// Force the pending state out now — used by shutdown and the crash guards.
// The JSON path writes synchronously so it works even mid-crash.
async function flushSaves() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) await flushing.catch(() => {});
  if (!dirty) return;
  dirty = false;
  if (config.dataStore === 'json') {
    saveJsonState();
  } else if (config.dataStore === 'supabase_rows') {
    await supabaseRowStore.saveState(db);
  } else {
    await saveSupabaseState(snapshot());
  }
  lastFlushAt = Date.now();
  lastFlushError = null;
}

if (config.dataStore === 'json') {
  initJsonSync();
}

module.exports = { db, save, uid, initDb, flushSaves, backupJsonState, saveHealth, seed, migrate, DB_PATH };
