import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { mapBooking, upsertBookings } from '../server/sync.js';
import { saveExpense, deleteExpense, listExpenses, receiptOf, pnl, payouts, markPayout, taxReport, saveMoneySettings, moneySettings } from '../server/money.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name) VALUES(500,'Laramie Retreat'); INSERT INTO rooms(id,property_id,name) VALUES(600,500,'Whole house');");
  upsertBookings(db, [
    { id: 1, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', arrival: '2026-01-30', departure: '2026-02-02', price: 300, commission: 9, tax: 30, firstName: 'Ann' },
    { id: 2, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2026-02-10', departure: '2026-02-12', price: 400, firstName: 'Dee' },   // direct
    { id: 3, propertyId: 500, roomId: 600, status: 'cancelled', channel: 'airbnb', arrival: '2026-03-01', departure: '2026-03-03', price: 500, firstName: 'Cal' },
  ]);
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,price,payout,source) VALUES(-1,500,600,'confirmed','VRBO','2026-03-10','2026-03-12',2,'Guesty Guest',250,220,'guesty')`).run();
  return db;
}

test('Beds24 commission and tax are kept with each booking', () => {
  const m = mapBooking({ id: 9, arrival: '2026-01-01', departure: '2026-01-03', price: '300', commission: '9.5', tax: 30 });
  assert.equal(m.commission, 9.5);
  assert.equal(m.tax, 30);
  assert.equal(mapBooking({ id: 9, arrival: '2026-01-01', departure: '2026-01-03' }).commission, null, 'unknown stays unknown');
  const db = setup();
  assert.deepEqual({ ...db.prepare('SELECT commission, tax FROM bookings WHERE id = 1').get() }, { commission: 9, tax: 30 });
});

test('expenses: checks, receipts, editing, monthly repeats', () => {
  const db = setup();
  assert.throws(() => saveExpense(db, { date: 'today', category: 'Supplies', amount: 5 }), /date/);
  assert.throws(() => saveExpense(db, { date: '2026-01-05', category: 'Snacks', amount: 5 }), /category/);
  assert.throws(() => saveExpense(db, { date: '2026-01-05', category: 'Supplies', amount: 0 }), /amount/);
  assert.throws(() => saveExpense(db, { date: '2026-01-05', category: 'Supplies', amount: 5, receipt: 'data:text/html;base64,AAAA' }), /photo or a PDF/);
  assert.throws(() => saveExpense(db, { date: '2026-02-05', category: 'Utilities', amount: 5, repeat: 'monthly', until: '2026-01-01' }), /after the first/);
  const id = saveExpense(db, { date: '2026-01-05', category: 'Supplies', amount: 42.555, vendor: 'Walmart', receipt: PNG });
  assert.equal(listExpenses(db, { year: 2026 })[0].amount, 42.56);
  assert.equal(receiptOf(db, id).receipt_mime, 'image/png');
  saveExpense(db, { id, date: '2026-01-06', category: 'Supplies', amount: 40, vendor: 'Walmart', removeReceipt: true });
  assert.equal(receiptOf(db, id), null);
  saveExpense(db, { date: '2026-01-31', category: 'Internet & TV', amount: 80, repeat: 'monthly', until: '2026-04-15' });
  const p = pnl(db, 2026, { today: '2026-12-31' });
  const internet = p.expenses.find(e => e.category === 'Internet & TV');
  assert.deepEqual(internet.months.slice(0, 5), [80, 80, 80, 0, 0], 'Jan 31, Feb 28, Mar 31; April is after "until"');
  assert.equal(listExpenses(db, { year: 2027 }).length, 0);
  deleteExpense(db, id);
  assert.equal(listExpenses(db, { year: 2026 }).length, 1);
});

test('profit and loss: income by night, channel fees, expenses, estimated cleaning', () => {
  const db = setup();
  saveExpense(db, { date: '2026-02-15', category: 'Repairs & maintenance', amount: 150 });
  saveMoneySettings(db, { cleaningPerStay: 60 });
  const p = pnl(db, 2026, { today: '2026-02-20' });
  const [jan, feb, mar] = p.months;
  assert.equal(jan.gross, 200, '2 of the 3 nights of a $300 stay');
  assert.equal(feb.gross, 500, 'the last night ($100) plus the direct stay ($400)');
  assert.equal(jan.fees, 6);
  assert.equal(mar.gross, 250, 'Guesty history counts; the cancelled stay does not');
  assert.equal(mar.fees, 30, 'Guesty fees = total minus payout');
  assert.equal(feb.expenses, 150 + 2 * 60, 'repair plus two checkouts of estimated cleaning');
  assert.equal(feb.profit, r(500 - 3 - 270));
  assert.equal(mar.future, true);
  assert.equal(p.total.nights, 7);
  assert.ok(p.expenses.some(e => e.category === 'Cleaning (estimated per stay)'));
  assert.deepEqual(p.channels.map(c => c.channel), ['Direct', 'Airbnb', 'VRBO']);
  assert.throws(() => pnl(db, 'abc'), /Choose a year/);
});
const r = v => Math.round(v * 100) / 100;

test('payouts: expected from total minus commission; marking what arrived', () => {
  const db = setup();
  const list = payouts(db, '2026-03-20');
  assert.deepEqual(list.map(p => p.id), [-1, 2, 1]);
  const ann = list.find(p => p.id === 1);
  assert.equal(ann.expected, 291);
  assert.equal(ann.feesKnown, true);
  assert.equal(list.find(p => p.id === 2).feesKnown, false);
  assert.equal(list.find(p => p.id === -1).expected, 220, 'Guesty payout used');
  markPayout(db, 1, { amount: 291, receivedOn: '2026-02-01' });
  markPayout(db, 2, { amount: 380 });
  const after = Object.fromEntries(payouts(db, '2026-03-20').map(p => [p.id, p]));
  assert.equal(after[1].status, 'ok');
  assert.equal(after[2].status, 'short');
  assert.equal(after[2].diff, -20);
  assert.equal(after[-1].status, 'waiting');
  markPayout(db, 2, { amount: '' });
  assert.equal(payouts(db, '2026-03-20').find(p => p.id === 2).status, 'waiting', 'cleared');
  assert.throws(() => markPayout(db, 99, { amount: 1 }), /Unknown booking/);
});

test('lodging tax: only on channels that don\'t collect it, at your rates', () => {
  const db = setup();
  assert.deepEqual(moneySettings(db).remits, { Airbnb: true, VRBO: true, 'Booking.com': false, Direct: false, Other: false });
  assert.throws(() => saveMoneySettings(db, { taxes: [{ name: 'Lodging', pct: 50 }] }), /between 0 and 30/);
  saveMoneySettings(db, { taxes: [{ name: 'State lodging', pct: 5 }, { name: 'Sales', pct: 4 }] });
  const t = taxReport(db, 2026);
  const feb = t.months[1];
  assert.equal(feb.remitted, 100, 'Airbnb collects its own');
  assert.equal(feb.owner, 400, 'the direct stay is yours');
  assert.equal(feb.due, 36);
  assert.deepEqual(feb.byTax, [{ name: 'State lodging', amount: 20 }, { name: 'Sales', amount: 16 }]);
  assert.equal(t.quarters[0].due, 36);
  saveMoneySettings(db, { remits: { Direct: true } });
  assert.equal(taxReport(db, 2026).total.due, 0);
  assert.throws(() => saveMoneySettings(db, { cleaningPerStay: -1 }), /Cleaning cost/);
});
