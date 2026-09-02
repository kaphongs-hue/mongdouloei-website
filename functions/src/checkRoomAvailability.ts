import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {getApps, initializeApp} from "firebase-admin/app";
import {loadPromotions} from "./promotionPricing";

if (getApps().length === 0) initializeApp();
const db = getFirestore();
const CANCELLED = "ยกเลิกแล้ว";

interface Input {
  checkInDate: string;
  checkOutDate: string;
}

function dateOnly(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

export const checkRoomAvailability = onCall(
  {region: "asia-southeast1"},
  async (request) => {
    const data = request.data as Input;
    if (!data?.checkInDate || !data.checkOutDate || data.checkOutDate <= data.checkInDate) {
      throw new HttpsError("invalid-argument", "กรุณาระบุวันเช็คอินและเช็คเอาท์ให้ถูกต้อง");
    }

    const [bookingSnap, roomSnap, promotions] = await Promise.all([
      db.collection("bookings").where("status", "!=", CANCELLED).get(),
      db.collection("rooms").where("active", "==", true).get(),
      loadPromotions(),
    ]);
    const rooms = new Map(roomSnap.docs.map((doc) => {
      const room = doc.data();
      return [room.name as string, {
        pricingMode: room.pricingMode as string | undefined,
        capacity: Math.max(1, Number(room.capacity) || 1),
      }];
    }));
    const occupied = new Set<string>();
    const reservedGuests = new Map<string, number>();

    bookingSnap.docs.forEach((doc) => {
      const booking = doc.data();
      const roomName = booking.roomName as string | undefined;
      const start = dateOnly(booking.checkIn);
      const end = dateOnly(booking.checkOut);
      if (!roomName || !start || !end || start >= data.checkOutDate || end <= data.checkInDate) return;
      const room = rooms.get(roomName);
      if (room?.pricingMode === "per_guest") {
        reservedGuests.set(roomName, (reservedGuests.get(roomName) ?? 0) + Math.max(0, Number(booking.guests) || 0));
      } else {
        occupied.add(roomName);
      }
    });

    reservedGuests.forEach((count, roomName) => {
      if (count >= (rooms.get(roomName)?.capacity ?? 1)) occupied.add(roomName);
    });
    return {
      occupiedRoomNames: Array.from(occupied),
      promotions: promotions.map((promo) => ({
        id: promo.id,
        name: promo.name,
        startDate: promo.startDate,
        endDate: promo.endDate,
        weekdays: promo.weekdays,
        price: promo.price,
        appliesToAllRooms: promo.appliesToAllRooms,
        roomIds: promo.roomIds,
        appliesToPricingModes: promo.appliesToPricingModes,
      })),
    };
  }
);
