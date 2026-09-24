// Shared by the booking page and Cloud Functions: prices are per occupied night.
// Nationwide October 2026 holidays: Oct 13 and Oct 23. Oct 23-25 is the
// continuous long weekend; Oct 16 is a Bangkok-only holiday, not a Loei holiday.
// Sources: https://www.thaipbs.or.th/news/content/500481
// https://www.thaigov.go.th/th/news/164228
export const OCTOBER_ROOM_IDS = [
  "MaJf2iO5wb6UNV83wn1J", "ObHkwUBBcJqSPDtOACVC", "YhkGdGjKeOkkYZmwhWaA",
  "kCCzNxk0kKO5FtNM3GIQ", "tzg3nMAqDhqfZRB7NXRw", "zWO0Cej1LJjnaVqAMnLf",
];
export const LONG_WEEKEND_ROOM_IDS = ["ObHkwUBBcJqSPDtOACVC", "tzg3nMAqDhqfZRB7NXRw"];

export function octoberNightRate(roomId, pricingMode, date) {
  if (pricingMode === "per_guest" || !OCTOBER_ROOM_IDS.includes(roomId) ||
      date < "2026-10-01" || date > "2026-10-31") return null;
  const longWeekend = (date >= "2026-10-11" && date <= "2026-10-13") ||
    (date >= "2026-10-23" && date <= "2026-10-25");
  if (longWeekend && LONG_WEEKEND_ROOM_IDS.includes(roomId)) return 1890;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 6 || date === "2026-10-13" || date === "2026-10-23") return 1790;
  return weekday === 5 ? 1590 : 1390;
}

export function octoberExtraGuestTotal(roomId, pricingMode, checkIn, checkOut, guests) {
  let total = 0;
  for (let date = checkIn; date < checkOut;) {
    if (octoberNightRate(roomId, pricingMode, date) !== null) total += Math.max(0, guests - 2) * 400;
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return total;
}
