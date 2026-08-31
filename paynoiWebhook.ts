import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

// Paynoi ใช้ api_key เป็น HMAC secret สำหรับ LINE Connect webhook
const paynoiApiKey = defineSecret("PAYNOI_API_KEY");

type PaynoiLineData = {
  source?: unknown;
  amount?: unknown;
  bankaccount?: unknown;
  currency?: unknown;
  date?: unknown;
  balance?: unknown;
  trans_id?: unknown;
  transactiontype?: unknown;
};

function secureEqualHex(provided: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const a = Buffer.from(provided.toLowerCase(), "hex");
  const b = Buffer.from(expected.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ตัด JSON value ของ top-level property จาก raw body โดยไม่ parse/stringify ใหม่
 * เพราะ Paynoi เซ็นลายมือชื่อบน JSON string ของ data แบบเดิมทุก byte
 */
function extractRawTopLevelObject(raw: string, wantedKey: string): string | null {
  let i = 0;
  const skipWhitespace = () => { while (/\s/.test(raw[i] || "")) i += 1; };
  const readString = (): { value: string; raw: string } | null => {
    if (raw[i] !== '"') return null;
    const start = i++;
    let escaped = false;
    while (i < raw.length) {
      const char = raw[i++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') {
        const token = raw.slice(start, i);
        try { return { value: JSON.parse(token), raw: token }; } catch { return null; }
      }
    }
    return null;
  };
  const readObjectValue = (): string | null => {
    if (raw[i] !== "{") return null;
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (i < raw.length) {
      const char = raw[i++];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) return raw.slice(start, i);
    }
    return null;
  };

  skipWhitespace();
  if (raw[i++] !== "{") return null;
  while (i < raw.length) {
    skipWhitespace();
    if (raw[i] === "}") return null;
    const key = readString();
    if (!key) return null;
    skipWhitespace();
    if (raw[i++] !== ":") return null;
    skipWhitespace();
    if (key.value === wantedKey) return readObjectValue();

    // ข้าม value อื่นอย่างถูกต้องพอสำหรับ JSON object/array/string/primitive
    if (raw[i] === '"') { if (!readString()) return null; }
    else if (raw[i] === "{" || raw[i] === "[") {
      const opener = raw[i]; const closer = opener === "{" ? "}" : "]";
      let depth = 0; let inString = false; let escaped = false;
      while (i < raw.length) {
        const char = raw[i++];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === opener) depth += 1;
        else if (char === closer && --depth === 0) break;
      }
    } else {
      while (i < raw.length && raw[i] !== "," && raw[i] !== "}") i += 1;
    }
    skipWhitespace();
    if (raw[i] === ",") { i += 1; continue; }
    if (raw[i] === "}") return null;
    return null;
  }
  return null;
}

function toSatang(raw: unknown): number | null {
  const value = Number(typeof raw === "string" ? raw.replace(/,/g, "").trim() : raw);
  const satang = Math.round(value * 100);
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 &&
    Math.abs(value * 100 - satang) < 0.001 ? satang : null;
}

type JsonResponse = {
  status(code: number): JsonResponse;
  json(body: { status: 0 | 1 }): unknown;
};

function json(res: JsonResponse, statusCode: number, status: 0 | 1) {
  res.status(statusCode).json({ status });
}

export const paynoiWebhook = onRequest(
  { region: "asia-southeast1", secrets: [paynoiApiKey], timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST"); json(res, 405, 0); return;
    }
    const apiKey = paynoiApiKey.value();
    if (!apiKey) { console.error("PAYNOI_API_KEY is not configured"); json(res, 503, 0); return; }
    if (!req.is("application/json") || !req.rawBody?.length) { json(res, 415, 0); return; }

    const raw = req.rawBody.toString("utf8");
    let body: { data?: PaynoiLineData; signature?: unknown };
    try { body = JSON.parse(raw); } catch { json(res, 400, 0); return; }
    const rawData = extractRawTopLevelObject(raw, "data");
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!rawData || !body.data || typeof body.data !== "object") { json(res, 400, 0); return; }

    const expected = createHmac("sha256", apiKey).update(rawData, "utf8").digest("hex");
    if (!secureEqualHex(signature, expected)) {
      console.warn("Paynoi signature verification failed"); json(res, 401, 0); return;
    }

    const data = body.data;
    const transactionType = typeof data.transactiontype === "string" ? data.transactiontype.trim() : "";
    if (transactionType !== "เงินเข้า") {
      console.info("Ignored non-credit Paynoi event", { transactionType });
      json(res, 200, 1); return;
    }
    const amountSatang = toSatang(data.amount);
    const transId = typeof data.trans_id === "string" || typeof data.trans_id === "number"
      ? String(data.trans_id).trim() : "";
    if (amountSatang === null || !/^[A-Za-z0-9_-]{1,200}$/.test(transId)) {
      console.warn("Invalid signed Paynoi payload", { amount: data.amount, hasTransId: Boolean(transId) });
      json(res, 400, 0); return;
    }

    const db = getFirestore();
    const eventId = createHash("sha256").update(`paynoi:${transId}`).digest("hex");
    const eventRef = db.collection("paymentEvents").doc(eventId);
    const previous = await eventRef.get();
    if (previous.exists && previous.get("outcome") === "confirmed") {
      console.info("Paynoi payment processed", { eventId, outcome: "duplicate" });
      json(res, 200, 1); return;
    }

    // รองรับทั้ง booking รุ่นใหม่ (integer satang) และรุ่นเดิม (number บาท)
    // ใช้ single-field queries เพื่อไม่ให้ webhook ล้มเพราะ composite index ยังสร้างไม่เสร็จ
    const [newMatches, legacyMatches] = await Promise.all([
      db.collection("bookings").where("paymentAmountSatang", "==", amountSatang).limit(10).get(),
      db.collection("bookings").where("paymentUniqueAmount", "==", amountSatang / 100).limit(10).get(),
    ]);
    const pendingById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    for (const doc of [...newMatches.docs, ...legacyMatches.docs]) {
      if (doc.get("status") === "รอมัดจำ") pendingById.set(doc.id, doc);
    }
    const matches = [...pendingById.values()];
    if (matches.length !== 1) {
      await eventRef.set({ provider: "paynoi_line", transId, amountSatang,
        bankAccount: data.bankaccount || null, transactionDate: data.date || null,
        outcome: matches.length === 0 ? "unmatched" : "ambiguous", payload: data,
        receivedAt: FieldValue.serverTimestamp() }, { merge: true });
      console.warn("Paynoi payment not uniquely matched", {
        eventId, amountSatang, matchCount: matches.length,
      });
      json(res, 200, 1); return;
    }

    const bookingRef = matches[0].ref;
    const outcome = await db.runTransaction(async (tx) => {
      const event = await tx.get(eventRef);
      if (event.exists && event.get("outcome") === "confirmed") return "duplicate";
      const snap = await tx.get(bookingRef);
      if (!snap.exists) return "stale";
      const storedSatang = snap.get("paymentAmountSatang");
      const storedLegacyAmount = snap.get("paymentUniqueAmount");
      if (snap.get("status") !== "รอมัดจำ" ||
          (storedSatang !== amountSatang && storedLegacyAmount !== amountSatang / 100)) return "stale";
      const booking = snap.data()!;
      tx.update(bookingRef, { status: "มัดจำแล้ว", paidDeposit: amountSatang / 100,
        paymentConfirmedAt: FieldValue.serverTimestamp(), paymentBankRef: transId,
        paymentProvider: "paynoi_line", updatedAt: FieldValue.serverTimestamp() });
      tx.delete(db.collection("paymentAmountClaims").doc(String(amountSatang)));
      tx.set(eventRef, { provider: "paynoi_line", transId, amountSatang,
        bankAccount: data.bankaccount || null, transactionDate: data.date || null,
        bookingId: bookingRef.id, outcome: "confirmed", payload: data,
        receivedAt: FieldValue.serverTimestamp() });
      tx.set(db.collection("auditLogs").doc(), { bookingId: bookingRef.id,
        bookingCode: booking.bookingCode || null, action: "status_changed",
        note: `ยืนยันมัดจำอัตโนมัติผ่าน Paynoi LINE Connect (${(amountSatang / 100).toFixed(2)} บาท)`,
        performedBy: "system:paynoi_webhook", createdAt: FieldValue.serverTimestamp() });
      return "confirmed";
    });
    console.info("Paynoi payment processed", { eventId, bookingId: bookingRef.id, outcome });
    json(res, 200, 1);
  }
);
