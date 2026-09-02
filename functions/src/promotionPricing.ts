import {getFirestore} from "firebase-admin/firestore";

export interface Promotion {
  id: string;
  name: string;
  active: boolean;
  startDate: string;
  endDate: string;
  weekdays: number[];
  price: number;
  appliesToAllRooms: boolean;
  roomIds: string[];
  appliesToPricingModes: string[];
}

export async function loadPromotions(): Promise<Promotion[]> {
  const snap = await getFirestore().collection("promotions").where("active", "==", true).get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: String(data.name ?? "โปรโมชั่น"),
      active: data.active === true,
      startDate: String(data.startDate ?? ""),
      endDate: String(data.endDate ?? ""),
      weekdays: Array.isArray(data.weekdays) ? data.weekdays.map(Number).filter(Number.isInteger) : [],
      price: Number(data.price),
      appliesToAllRooms: data.appliesToAllRooms === true,
      roomIds: Array.isArray(data.roomIds) ? data.roomIds.map(String) : [],
      appliesToPricingModes: Array.isArray(data.appliesToPricingModes) ? data.appliesToPricingModes.map(String) : [],
    };
  }).filter((promo) => promo.startDate && promo.endDate && promo.price > 0);
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function applicablePromotion(
  promos: Promotion[], roomId: string, pricingMode: string, date: string
): Promotion | undefined {
  return promos
    .filter((promo) =>
      date >= promo.startDate && date <= promo.endDate &&
      (promo.weekdays.length === 0 || promo.weekdays.includes(dayOfWeek(date))) &&
      (promo.appliesToAllRooms || promo.roomIds.includes(roomId)) &&
      (promo.appliesToPricingModes.length === 0 || promo.appliesToPricingModes.includes(pricingMode))
    )
    .sort((a, b) => a.price - b.price)[0];
}

export function quoteStay(
  promos: Promotion[], roomId: string, basePrice: number, pricingMode: string,
  checkIn: string, checkOut: string, guests: number
): {roomTotal: number; promotionNames: string[]} {
  let roomTotal = 0;
  const names = new Set<string>();
  for (let date = checkIn; date < checkOut; date = nextDate(date)) {
    const promo = applicablePromotion(promos, roomId, pricingMode, date);
    const nightlyPrice = Math.min(basePrice, promo?.price ?? basePrice);
    roomTotal += nightlyPrice * (pricingMode === "per_guest" ? guests : 1);
    if (promo && promo.price < basePrice) names.add(promo.name);
  }
  return {roomTotal, promotionNames: Array.from(names)};
}
