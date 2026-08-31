import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import generatePayload from "promptpay-qr";
import * as QRCode from "qrcode";

const PROMPTPAY_ID = process.env.PROMPTPAY_ID || "0813689478";
const PAYMENT_TTL_MS = 30 * 60 * 1000;

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) >>> 0;
  return result;
}

function bookingIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(value)) {
    throw new HttpsError("invalid-argument", "bookingId ไม่ถูกต้อง");
  }
  return value;
}

export const generatePromptPayQR = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const bookingId = bookingIdOf(request.data?.bookingId);
    const db = getFirestore();
    const ref = db.collection("bookings").doc(bookingId);

    const satang = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "ไม่พบข้อมูลการจองนี้");
      const booking = snap.data()!;
      if (booking.status !== "รอมัดจำ") {
        throw new HttpsError("failed-precondition", "การจองนี้ไม่ได้อยู่ในสถานะรอมัดจำ");
      }
      const deposit = Number(booking.expectedDeposit);
      if (!Number.isFinite(deposit) || deposit <= 0) {
        throw new HttpsError("failed-precondition", "ยอดมัดจำไม่ถูกต้อง");
      }
      const base = Math.floor(Math.round(deposit * 100) / 100) * 100;
      if (Number.isSafeInteger(booking.paymentAmountSatang) &&
          Math.floor(booking.paymentAmountSatang / 100) * 100 === base) {
        return booking.paymentAmountSatang as number;
      }

      const start = hash(bookingId) % 99;
      for (let offset = 0; offset < 99; offset += 1) {
        const candidate = base + ((start + offset) % 99) + 1;
        const claimRef = db.collection("paymentAmountClaims").doc(String(candidate));
        const claim = await tx.get(claimRef);
        if (!claim.exists) {
          tx.create(claimRef, { bookingId, amountSatang: candidate,
            expiresAt: new Date(Date.now() + PAYMENT_TTL_MS), createdAt: FieldValue.serverTimestamp() });
          tx.update(ref, {
            paymentAmountSatang: candidate,
            paymentUniqueAmount: candidate / 100,
            paymentMethod: "promptpay_qr",
            paymentQrGeneratedAt: FieldValue.serverTimestamp(),
            paymentExpiresAt: new Date(Date.now() + PAYMENT_TTL_MS),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return candidate;
        }
      }
      throw new HttpsError("resource-exhausted", "ยอดชำระซ้ำกันมากเกินไป กรุณาติดต่อที่พัก");
    });

    const amount = satang / 100;
    const payload = generatePayload(PROMPTPAY_ID, { amount });
    const qrDataUrl = await QRCode.toDataURL(payload, { width: 480, margin: 1 });
    return { qrDataUrl, amount, expiresInSeconds: PAYMENT_TTL_MS / 1000 };
  }
);

// ใช้แทนการเปิด read bookings ให้เว็บไซต์ จึงไม่เผยข้อมูลส่วนตัวของผู้จอง
export const getPublicPaymentStatus = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const bookingId = bookingIdOf(request.data?.bookingId);
    const snap = await getFirestore().collection("bookings").doc(bookingId).get();
    if (!snap.exists) throw new HttpsError("not-found", "ไม่พบข้อมูลการจองนี้");
    return { confirmed: snap.get("status") === "มัดจำแล้ว" };
  }
);

