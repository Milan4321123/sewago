const crypto = require('crypto');

// Real Kathmandu-valley locations with actual GPS coordinates.
const PLACES = [
  { name: 'Thamel', lat: 27.7154, lng: 85.3123 },
  { name: 'Kathmandu Durbar Square', lat: 27.7042, lng: 85.3068 },
  { name: 'New Road', lat: 27.7016, lng: 85.3117 },
  { name: 'Patan Durbar Square', lat: 27.6727, lng: 85.3255 },
  { name: 'Jawalakhel', lat: 27.6726, lng: 85.3134 },
  { name: 'Lagankhel', lat: 27.6667, lng: 85.3242 },
  { name: 'Bhaktapur Durbar Square', lat: 27.6722, lng: 85.4281 },
  { name: 'Boudhanath Stupa', lat: 27.7215, lng: 85.362 },
  { name: 'Pashupatinath', lat: 27.7105, lng: 85.3487 },
  { name: 'Swayambhunath', lat: 27.7149, lng: 85.2904 },
  { name: 'Tribhuvan Airport', lat: 27.698, lng: 85.3592 },
  { name: 'Koteshwor', lat: 27.6789, lng: 85.3494 },
  { name: 'New Baneshwor', lat: 27.6893, lng: 85.3436 },
  { name: 'Maitighar', lat: 27.6949, lng: 85.322 },
  { name: 'Kalanki', lat: 27.6933, lng: 85.2817 },
  { name: 'Balaju', lat: 27.7359, lng: 85.3009 },
  { name: 'Maharajgunj', lat: 27.7394, lng: 85.335 },
  { name: 'Chabahil', lat: 27.7172, lng: 85.3466 },
  { name: 'Budhanilkantha', lat: 27.7784, lng: 85.3618 },
  { name: 'Kirtipur', lat: 27.6789, lng: 85.2775 },
  { name: 'Godavari', lat: 27.5965, lng: 85.3785 },
  { name: 'Sundarijal', lat: 27.7684, lng: 85.431 },
  { name: 'Thankot', lat: 27.6926, lng: 85.2354 },
  { name: 'Nagarkot', lat: 27.7172, lng: 85.5201 }
];

// Known place -> exact coordinates. Unknown text -> stable pseudo-location
// inside the valley (same input always maps to the same point).
function coordsFor(query) {
  const q = String(query || '').toLowerCase().trim();
  let place = PLACES.find((p) => p.name.toLowerCase() === q);
  if (!place && q.length >= 3) {
    place = PLACES.find((p) => p.name.toLowerCase().includes(q));
  }
  if (!place) {
    place = PLACES.find((p) => q.includes(p.name.toLowerCase()));
  }
  if (place) {
    return { name: place.name, lat: place.lat, lng: place.lng, known: true };
  }
  const h = crypto.createHash('md5').update(q).digest();
  return {
    name: String(query).trim(),
    lat: 27.66 + (h[0] / 255) * 0.09,
    lng: 85.27 + (h[1] / 255) * 0.12,
    known: false
  };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

module.exports = { PLACES, coordsFor, haversineKm };
