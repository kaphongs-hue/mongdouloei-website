const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {quoteStay} = require('../lib/promotionPricing.js');
const {octoberNightRate, octoberExtraGuestTotal, OCTOBER_ROOM_IDS} = require('../lib/octoberPricing.js');
const regular = OCTOBER_ROOM_IDS[0], special = OCTOBER_ROOM_IDS[1];
const next = date => new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0,10);
const html = fs.readFileSync(require('node:path').join(__dirname, '../../booking.html'), 'utf8');
const quoteSource = html.slice(html.indexOf('  const nextDateStr ='), html.indexOf('  const money ='));
const context = {octoberNightRate, octoberExtraGuestTotal, activePromotions: []};
vm.createContext(context);
vm.runInContext(quoteSource + '\nglobalThis.quote = stayQuote;', context);

test('October calendar rates and long-weekend room scope', () => {
  for (const [date, base, premium] of [
    ['2026-10-01',1390,1390], ['2026-10-02',1590,1590], ['2026-10-03',1790,1790],
    ['2026-10-04',1390,1390], ['2026-10-10',1790,1790], ['2026-10-11',1390,1890],
    ['2026-10-12',1390,1890], ['2026-10-13',1790,1890], ['2026-10-14',1390,1390],
    ['2026-10-16',1590,1590], ['2026-10-22',1390,1390], ['2026-10-23',1790,1890],
    ['2026-10-24',1790,1890], ['2026-10-25',1390,1890], ['2026-10-26',1390,1390],
    ['2026-10-31',1790,1790],
  ]) {
    assert.equal(octoberNightRate(regular,'per_room',date),base,date);
    for (const id of [special,'tzg3nMAqDhqfZRB7NXRw']) assert.equal(octoberNightRate(id,'per_room',date),premium,date);
  }
});
test('No campaign outside October, for new rooms, or for camping', () => {
  for (const date of ['2026-09-30','2026-11-01','2027-10-23']) assert.equal(octoberNightRate(special,'per_room',date),null);
  assert.equal(octoberNightRate('new-room','per_room','2026-10-23'),null);
  assert.equal(quoteStay([], 'camping-ground',150,'per_guest','2026-10-23','2026-10-26',3).roomTotal,1350);
  assert.equal(octoberExtraGuestTotal('camping-ground','per_guest','2026-10-23','2026-10-26',3),0);
});
test('October tariff overrides base prices and overlapping discounts', () => {
  const promo = {id:'legacy',name:'Legacy',active:true,startDate:'2026-09-01',endDate:'2026-10-31',weekdays:[],price:999,appliesToAllRooms:true,roomIds:[],appliesToPricingModes:[]};
  assert.equal(quoteStay([promo],special,1800,'per_room','2026-10-23','2026-10-26',2).roomTotal,5670);
  assert.equal(quoteStay([promo],regular,1500,'per_room','2026-09-30','2026-10-02',2).roomTotal,2389);
});
test('October 11–13 premium applies per occupied night and excludes checkout', () => {
  for (const id of [special, 'tzg3nMAqDhqfZRB7NXRw']) {
    assert.equal(quoteStay([],id,1800,'per_room','2026-10-11','2026-10-14',2).roomTotal,5670);
    assert.equal(quoteStay([],id,1800,'per_room','2026-10-10','2026-10-11',2).roomTotal,1790);
    assert.equal(quoteStay([],id,1800,'per_room','2026-10-13','2026-10-15',2).roomTotal,3280);
  }
  assert.equal(quoteStay([],regular,1500,'per_room','2026-10-11','2026-10-14',2).roomTotal,4570);
});
test('Extra guests, mixed-month stays and deposit totals', () => {
  const q=quoteStay([],special,1800,'per_room','2026-10-23','2026-10-26',3);
  assert.equal(q.extraGuestTotal,1200);
  assert.equal(q.roomTotal+q.extraGuestTotal,6870);
  assert.equal(Math.round((q.roomTotal+q.extraGuestTotal)*0.5),3435);
  const mixed=quoteStay([],regular,1500,'per_room','2026-09-30','2026-10-02',4);
  assert.equal(mixed.roomTotal,2890); assert.equal(mixed.extraGuestTotal,800);
  const end=quoteStay([],regular,1500,'per_room','2026-10-31','2026-11-02',3);
  assert.equal(end.roomTotal,3290);assert.equal(end.extraGuestTotal,400);
});
test('Browser and server totals agree for all six houses, every October night and guest counts', () => {
  for (const id of OCTOBER_ROOM_IDS) for(let date='2026-10-01';date<='2026-10-31';date=next(date)) for(const guests of [1,2,3,5]) {
    const room={id,price:1500};const end=next(next(date));
    const browser=context.quote(room,date,end,guests);
    const server=quoteStay([],id,1500,'per_room',date,end,guests);
    assert.equal(browser.total,server.roomTotal,`${id} ${date} ${guests}`);
    assert.equal(browser.extraGuestTotal,server.extraGuestTotal);
    assert.ok(Number.isFinite(browser.lowestNightlyPrice));
  }
});
test('Booking window includes October 31 checkout on November 1, in Bangkok time',()=>{
 const code=html.slice(html.indexOf('  const todayStr = new Intl.DateTimeFormat'),html.indexOf('  // ---------------- ส่งคำขอจอง'));
 for(const [instant,min,max,out] of [['2026-09-15T12:00:00Z','2026-09-15','2026-10-31','2026-11-01'],['2026-09-30T18:00:00Z','2026-10-01','2026-10-31','2026-11-01'],['2026-10-31T12:00:00Z','2026-10-31','2026-10-31','2026-11-01'],['2026-11-15T12:00:00Z','2026-11-15','2026-11-30','2026-12-01']]) {
 const els={checkIn:{},checkOut:{},bookingWindowEnd:{}};class Clock extends Date {constructor(...args){super(...(args.length?args:[instant]));}}
 vm.runInNewContext(code,{Date:Clock,Intl,document:{getElementById:id=>els[id]},formatThaiDate:x=>x,nextDateStr:next});
 assert.equal(els.checkIn.min,min);assert.equal(els.checkIn.max,max);assert.equal(els.checkOut.max,out);
 }
});
