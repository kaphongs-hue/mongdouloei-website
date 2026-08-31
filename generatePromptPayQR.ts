import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import generatePayload from "promptpay-qr";
import * as QRCode from "qrcode";

// มองดูเลยโฮมสเตย์ — เบอร์พร้อมเพย์ของที่พัก
const PROMPTPAY_ID = "0813689478";

/**
 * สร้าง QR พร้อมเพย์สำหรับยอดมัดจำของ booking หนึ่งรายการ
 * - ปัดยอดให้มีเศษสตางค์ที่ไม่ซ้ำกัน (derive จาก bookingId) เพื่อให้ webhook
 *   จับคู่ยอดเงินเข้ากับ booking ได้แม่นยำ แม้สองบุ๊คกิ้งจะมัดจำเท่ากันพอดี
 * - เขียน paymentUniqueAmount กลับเข้า booking doc ไว้ให้ paynoiWebhook ใช้จับคู่
 *
 * เรียกจาก booking.html ด้วย:
 *   const generatePromptPayQR = httpsCallable(functions, "generatePromptPayQR");
 *   const { data } = await generatePromptPayQR({ bookingId });
 *   // data: { qrDataUrl, amount, promptpayId }
 */
export const generatePromptPayQR = onCall(
  { region: "asia-southeast1" },
  async (request) => {
    const bookingId = request.data?.bookingId;
    if (!bookingId || typeof bookingId !== "string") {
      throw new HttpsError("invalid-argument", "ต้องระบุ bookingId");
    }

    const db = getFirestore();
    const bookingRef = db.collection("bookings").doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "ไม่พบข้อมูลการจองนี้");
    }
    const booking = snap.data()!;

    if (booking.status !== "รอมัดจำ") {
      throw new HttpsError(
        "failed-precondition",
        "การจองนี้ไม่ได้อยู่ในสถานะรอมัดจำแล้ว"
      );
    }

    const baseDeposit = Math.round(Number(booking.expectedDeposit) || 0);
    if (baseDeposit <= 0) {
      throw new HttpsError("failed-precondition", "ยอดมัดจำไม่ถูกต้อง");
    }

    // ถ้าเคยสร้างยอดเฉพาะไว้แล้ว (เช่น รีเฟรชหน้าเว็บ) ใช้ยอดเดิมซ้ำ
    // ไม่สุ่มใหม่ทุกครั้ง ป้องกันเปิดหน้าซ้ำแล้วยอดเปลี่ยน
    let uniqueAmount: number = booking.paymentUniqueAmount;

    if (!uniqueAmount || Math.floor(uniqueAmount) !== baseDeposit) {
      // เศษสตางค์ 0.01–0.99 คำนวณจาก hash ของ bookingId ให้ deterministic
      let hash = 0;
      for (let i = 0; i < bookingId.length; i++) {
        hash = (hash * 31 + bookingId.charCodeAt(i)) >>> 0;
      }
      const cents = (hash % 99) + 1; // 1–99 สตางค์ ไม่ให้เป็น .00
      uniqueAmount = Math.round((baseDeposit + cents / 100) * 100) / 100;

      await bookingRef.update({
        paymentUniqueAmount: uniqueAmount,
        paymentMethod: "promptpay_qr",
        paymentQrGeneratedAt: new Date().toISOString(),
      });
    }

    const payload = generatePayload(PROMPTPAY_ID, { amount: uniqueAmount });
    const qrDataUrl = await QRCode.toDataURL(payload, {
      width: 480,
      margin: 1,
    });

    return {
      qrDataUrl,
      amount: uniqueAmount,
      promptpayId: PROMPTPAY_ID,
    };
  }
);
