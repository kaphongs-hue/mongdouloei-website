import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, FieldValue} from "firebase-admin/firestore";

const db = getFirestore();
const WAITING_DEPOSIT = "รอมัดจำ";
const CANCELLED = "ยกเลิกแล้ว";

interface Input {
  roomId: string;
  guestName: string;
  phone: string;
  guests: number;
  checkInDate: string;
  checkOutDate: string;
  note?: string;
}

interface Room {
  name?: string;
  price?: number;
  capacity?: number;
  emoji?: string;
  chargesExtraGuestFee?: boolean;
  active?: boolean;
  pricingMode?: "per_guest" | "per_room";
}

function parseDateOnly(value: string): Date {
  const date = new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(date.getTime())) {
    throw new HttpsError("invalid-argument", "รูปแบบวันที่ไม่ถูกต้อง");
  }
  return date;
}

function extractDateOnly(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function bookingCode(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `MDL-${day}-${time}`;
}

function validate(data: Input): void {
  if (!data || !data.roomId) throw new HttpsError("invalid-argument", "กรุณาเลือกห้องพัก");
  if (!data.guestName?.trim()) throw new HttpsError("invalid-argument", "กรุณากรอกชื่อผู้จอง");
  if (!data.phone?.trim() || !/^[0-9+\-\s]{9,15}$/.test(data.phone.trim())) {
    throw new HttpsError("invalid-argument", "รูปแบบเบอร์โทรไม่ถูกต้อง");
  }
  if (!Number.isInteger(data.guests) || data.guests < 1) {
    throw new HttpsError("invalid-argument", "จำนวนผู้เข้าพักต้องอย่างน้อย 1 ท่าน");
  }
  if (!data.checkInDate || !data.checkOutDate) {
    throw new HttpsError("invalid-argument", "กรุณาระบุวันเช็คอินและเช็คเอาท์");
  }
  if (data.guestName.length > 100 || (data.note?.length ?? 0) > 500) {
    throw new HttpsError("invalid-argument", "ข้อมูลที่กรอกยาวเกินไป");
  }
}

export const createPublicBooking = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    const data = request.data as Input;
    validate(data);

    const checkIn = parseDateOnly(data.checkInDate);
    const checkOut = parseDateOnly(data.checkOutDate);
    const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86400000);
    if (nights < 1) {
      throw new HttpsError("invalid-argument", "วันเช็คเอาท์ต้องอยู่หลังวันเช็คอินอย่างน้อย 1 คืน");
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (checkIn.getTime() < today.getTime() - 86400000) {
      throw new HttpsError("invalid-argument", "ไม่สามารถจองวันที่ผ่านมาแล้วได้");
    }

    const roomSnap = await db.collection("rooms").doc(data.roomId).get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "ไม่พบที่พักที่เลือก");
    const room = roomSnap.data() as Room;
    if (room.active === false) {
      throw new HttpsError("failed-precondition", "ที่พักนี้ปิดให้จองชั่วคราว");
    }

    const roomName = room.name ?? "ที่พัก";
    const roomPrice = Number(room.price ?? 0);
    const roomCapacity = Number(room.capacity ?? 2);
    const roomEmoji = room.emoji ?? "🏡";
    const pricingMode = room.pricingMode ?? "per_room";
    if (!Number.isFinite(roomPrice) || roomPrice <= 0 || !Number.isInteger(roomCapacity) || roomCapacity < 1) {
      throw new HttpsError("failed-precondition", "ข้อมูลราคาหรือจำนวนผู้เข้าพักไม่ถูกต้อง");
    }
    if (pricingMode === "per_guest" && data.guests > roomCapacity) {
      throw new HttpsError("invalid-argument", `รองรับผู้เข้าพักสูงสุด ${roomCapacity} ท่าน`);
    }
    if (pricingMode === "per_room" && data.guests > roomCapacity + 10) {
      throw new HttpsError("invalid-argument", "จำนวนผู้เข้าพักมากเกินไปสำหรับห้องนี้");
    }

    const roomTotal = roomPrice * nights * (pricingMode === "per_guest" ? data.guests : 1);
    const extraGuests = pricingMode === "per_room" ? Math.max(0, data.guests - roomCapacity) : 0;
    const extraGuestRate = 0;
    const extraGuestTotal = room.chargesExtraGuestFee === false ? 0 : extraGuests * extraGuestRate * nights;
    const total = roomTotal + extraGuestTotal;
    const expectedDeposit = Math.round(total * 0.5);
    const now = new Date();
    const code = bookingCode(now);
    const bookingRef = db.collection("bookings").doc();

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(db.collection("bookings").where("roomName", "==", roomName));
      const overlapping = existing.docs.filter((doc) => {
        const value = doc.data();
        if (value.status === CANCELLED) return false;
        const start = extractDateOnly(value.checkIn);
        const end = extractDateOnly(value.checkOut);
        return Boolean(start && end && start < data.checkOutDate && end > data.checkInDate);
      });

      if (pricingMode === "per_guest") {
        const reservedGuests = overlapping.reduce((sum, doc) => sum + Math.max(0, Number(doc.data().guests) || 0), 0);
        if (reservedGuests + data.guests > roomCapacity) {
          throw new HttpsError("already-exists", `ช่วงวันที่เลือกเหลือพื้นที่ไม่พอสำหรับ ${data.guests} ท่าน`);
        }
      } else if (overlapping.length > 0) {
        throw new HttpsError("already-exists", `ขออภัย ห้อง "${roomName}" ถูกจองแล้วในช่วงวันที่เลือก`);
      }

      const nowIso = now.toISOString();
      tx.set(bookingRef, {
        bookingCode: code,
        roomName,
        roomPrice,
        roomCapacity,
        roomEmoji,
        pricingMode,
        guestName: data.guestName.trim(),
        phone: data.phone.trim(),
        guests: data.guests,
        checkIn: `${data.checkInDate}T00:00:00.000`,
        checkOut: `${data.checkOutDate}T00:00:00.000`,
        checkInTime: "14:00 น.",
        checkOutTime: "11:00 น.",
        nights,
        roomTotal,
        extraGuestTotal,
        extraGuestRate,
        total,
        expectedDeposit,
        paidDeposit: 0,
        balance: total,
        status: WAITING_DEPOSIT,
        note: data.note?.trim() ?? "",
        bookingSource: "website",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      tx.set(db.collection("auditLogs").doc(), {
        bookingId: bookingRef.id,
        bookingCode: code,
        guestName: data.guestName.trim(),
        roomName,
        action: "created",
        statusText: WAITING_DEPOSIT,
        actorUid: "website",
        actorName: "ลูกค้าจองผ่านเว็บไซต์",
        at: FieldValue.serverTimestamp(),
      });
    });

    return {
      bookingId: bookingRef.id,
      bookingCode: code,
      roomName,
      nights,
      total,
      expectedDeposit,
      checkInDate: data.checkInDate,
      checkOutDate: data.checkOutDate,
    };
  }
);
