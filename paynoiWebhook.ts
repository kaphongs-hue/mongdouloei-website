import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

/**
 * Webhook รับแจ้งเตือนเงินเข้าจาก Paynoi
 *
 * ⚠️ ต้องปรับตามจริงก่อนใช้งาน:
 * 1. PAYNOI_WEBHOOK_SECRET — ตั้งค่าผ่าน `firebase functions:secrets:set PAYNOI_WEBHOOK_SECRET`
 *    (เอาค่า secret/token จากหน้า dashboard Paynoi ตอนตั้งค่า Webhook URL)
 * 2. ชื่อฟิลด์ใน req.body (amount / amt / transAmount ฯลฯ) — Paynoi ส่ง JSON มาเป็นรูปแบบ
 *    ไหนต้องดูจาก payload ตัวอย่างจริงที่ dashboard เขาโชว์ตอนทดสอบ webhook แล้วแก้บรรทัด
 *    ที่ comment ว่า "TODO: ปรับชื่อฟิลด์" ด้านล่างให้ตรง
 *
 * URL ของ function นี้ (หลัง deploy) เอาไปวางเป็น Webhook URL ในหน้าตั้งค่า Paynoi:
 *   https://asia-southeast1-booking-f90a4.cloudfunctions.net/paynoiWebhook
 */

const paynoiWebhookSecret = defineSecret("PAYNOI_WEBHOOK_SECRET");

export const paynoiWebhook = onRequest(
  { region: "asia-southeast1", secrets: [paynoiWebhookSecret] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // ยืนยันว่าเป็น Paynoi จริง ไม่ใช่ใครก็ได้ยิง POST มาปลอมยอดเงิน
    const providedSecret =
      req.get("x-paynoi-secret") || req.get("authorization") || req.query.secret;
    const expectedSecret = paynoiWebhookSecret.value();
    if (expectedSecret && providedSecret !== expectedSecret) {
      res.status(401).send("Unauthorized");
      return;
    }

    const body = req.body || {};

    // TODO: ปรับชื่อฟิลด์ให้ตรงกับ payload จริงของ Paynoi
    const amountRaw = body.amount ?? body.amt ?? body.transAmount ?? body.total;
    const amount = Number(amountRaw);
    const bankRef =
      body.transRef ?? body.ref ?? body.transactionId ?? body.id ?? null;

    if (!amount || Number.isNaN(amount)) {
      console.error("paynoiWebhook: missing/invalid amount in payload", body);
      res.status(400).send("Missing amount");
      return;
    }

    const db = getFirestore();

    // จับคู่จากยอดเงินที่ตรงเป๊ะ (มีเศษสตางค์เฉพาะ) + ยังอยู่ในสถานะรอมัดจำ
    const matchSnap = await db
      .collection("bookings")
      .where("paymentUniqueAmount", "==", amount)
      .where("status", "==", "รอมัดจำ")
      .limit(1)
      .get();

    if (matchSnap.empty) {
      // ไม่พบ booking ที่ตรง — บันทึกไว้ให้แอดมินตรวจเองแทนที่จะปล่อยหาย
      await db.collection("unmatchedPayments").add({
        amount,
        bankRef,
        rawPayload: body,
        receivedAt: FieldValue.serverTimestamp(),
      });
      console.warn("paynoiWebhook: no matching booking for amount", amount);
      res.status(200).send("No matching booking, logged for review");
      return;
    }

    const doc = matchSnap.docs[0];
    const booking = doc.data();

    await doc.ref.update({
      status: "มัดจำแล้ว",
      paidDeposit: Math.round(Number(booking.expectedDeposit) || 0),
      paymentConfirmedAt: FieldValue.serverTimestamp(),
      paymentBankRef: bankRef,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await db.collection("auditLogs").add({
      bookingId: doc.id,
      bookingCode: booking.bookingCode || null,
      action: "status_changed",
      note: `ยืนยันมัดจำอัตโนมัติผ่าน PromptPay QR (ยอด ${amount} บาท)`,
      performedBy: "system:paynoi_webhook",
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(`paynoiWebhook: confirmed deposit for booking ${doc.id} (${amount} THB)`);
    res.status(200).send("OK");
  }
);
