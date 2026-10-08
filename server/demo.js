import { upsertProperties, upsertBookings, addDays, iso } from './sync.js';
import { setSetting } from './db.js';

// Small deterministic PRNG so demo data is stable between runs.
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }

const FIRST = ['Ava','Liam','Noah','Emma','Olivia','Mason','Sophia','Lucas','Mia','Ethan','Harper','Jack','Ella','Owen','Zoe'];
const LAST = ['Smith','Johnson','Lee','Garcia','Brown','Davis','Miller','Wilson','Moore','Clark','Hall','Young','King','Scott'];

export function loadDemo(db, today = iso(Date.now())) {
  upsertProperties(db, [
    { id: 1, name: 'Lakeside Cabin', city: 'Jackson, WY', currency: 'USD', roomTypes: [{ id: 11, name: 'Whole cabin', qty: 1 }] },
    { id: 2, name: 'Downtown Lofts', city: 'Lander, WY', currency: 'USD',
      roomTypes: [{ id: 21, name: 'Loft A', qty: 1 }, { id: 22, name: 'Loft B', qty: 1 }, { id: 23, name: 'Loft C', qty: 1 }] },
    { id: 3, name: 'Ridge House', city: 'Cody, WY', currency: 'USD', roomTypes: [{ id: 31, name: 'Entire home', qty: 1 }] },
  ]);
  const rand = rng(42);
  const channels = ['airbnb', 'airbnb', 'airbnb', 'booking', 'vrbo', 'vrbo', 'direct'];
  const rooms = [[1, 11, 240], [2, 21, 140], [2, 22, 150], [2, 23, 130], [3, 31, 310]];
  const bookings = [];
  let id = 1000;
  for (const [propertyId, roomId, rate] of rooms) {
    let cursor = addDays(today, -150);
    while (cursor < addDays(today, 150)) {
      cursor = addDays(cursor, Math.floor(rand() * 4));            // gap
      const nights = 2 + Math.floor(rand() * 6);
      const dep = addDays(cursor, nights);
      if (rand() < 0.78) {
        const channel = channels[Math.floor(rand() * channels.length)];
        const cancelled = rand() < 0.08;
        bookings.push({
          id: id++, propertyId, roomId, arrival: cursor, departure: dep,
          status: cancelled ? 'cancelled' : (dep > today && cursor > addDays(today, 60) && rand() < 0.1 ? 'request' : 'confirmed'),
          channel, firstName: FIRST[Math.floor(rand() * FIRST.length)], lastName: LAST[Math.floor(rand() * LAST.length)],
          numAdult: 1 + Math.floor(rand() * 4), numChild: Math.floor(rand() * 3),
          price: Math.round(nights * rate * (0.85 + rand() * 0.4)), currency: 'USD',
          bookingTime: addDays(cursor, -Math.floor(5 + rand() * 60)) + 'T12:00:00Z',
        });
      } else if (rand() < 0.2) {
        bookings.push({ id: id++, propertyId, roomId, arrival: cursor, departure: dep, status: 'black', title: 'Owner block' });
      }
      cursor = dep;
    }
  }
  upsertBookings(db, bookings);
  setSetting(db, 'demo', '1');
  return { properties: 3, rooms: rooms.length, bookings: bookings.length };
}
