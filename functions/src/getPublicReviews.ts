import {onCall} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import {getFirestore, Timestamp} from "firebase-admin/firestore";

const db = getFirestore();
const googlePlacesApiKey = defineSecret("GOOGLE_PLACES_API_KEY");
const BUSINESS_QUERY = "มองดูเลยโฮมสเตย์ ไฮตาก ภูเรือ เลย";
const CACHE_DOCUMENT = db.collection("internalCache").doc("googleReviews");
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface PublicReview {
  id: string;
  customerName: string;
  text: string;
  rating: number;
  source: string;
  sourceUrl: string;
  reviewDate: string;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanUrl(value: unknown): string {
  const raw = cleanText(value, 1000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function isoDate(value: unknown): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

async function loadGoogleReviews(apiKey: string): Promise<{
  reviews: PublicReview[];
  rating?: number;
  reviewCount?: number;
  sourceUrl?: string;
}> {
  const searchResponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id",
    },
    body: JSON.stringify({textQuery: BUSINESS_QUERY, languageCode: "th", regionCode: "TH", maxResultCount: 1}),
  });
  if (!searchResponse.ok) throw new Error(`Google place search failed: ${searchResponse.status}`);
  const search = await searchResponse.json() as {places?: Array<{id?: string}>};
  const placeId = search.places?.[0]?.id;
  if (!placeId) return {reviews: []};

  const fields = "id,displayName,rating,userRatingCount,reviews,googleMapsUri";
  const detailResponse = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=th`,
    {headers: {"X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fields}}
  );
  if (!detailResponse.ok) throw new Error(`Google place details failed: ${detailResponse.status}`);
  const place = await detailResponse.json() as {
    rating?: number;
    userRatingCount?: number;
    googleMapsUri?: string;
    reviews?: Array<{
      name?: string;
      rating?: number;
      text?: {text?: string};
      publishTime?: string;
      authorAttribution?: {displayName?: string};
      googleMapsUri?: string;
    }>;
  };
  const placeUrl = cleanUrl(place.googleMapsUri);
  const reviews = (place.reviews ?? []).map((review, index) => ({
    id: cleanText(review.name, 200) || `google-${index}`,
    customerName: cleanText(review.authorAttribution?.displayName, 100) || "ผู้ใช้ Google",
    text: cleanText(review.text?.text, 1200),
    rating: Math.min(5, Math.max(1, Math.round(Number(review.rating) || 5))),
    source: "Google",
    sourceUrl: cleanUrl(review.googleMapsUri) || placeUrl,
    reviewDate: isoDate(review.publishTime),
  })).filter((review) => review.text).slice(0, 6);
  return {
    reviews,
    rating: Number.isFinite(Number(place.rating)) ? Number(place.rating) : undefined,
    reviewCount: Number.isFinite(Number(place.userRatingCount)) ? Number(place.userRatingCount) : undefined,
    sourceUrl: placeUrl,
  };
}

async function loadApprovedReviews(): Promise<PublicReview[]> {
  const snapshot = await db.collection("reviews").where("active", "==", true).get();
  return snapshot.docs.map((document) => {
    const review = document.data();
    return {
      id: document.id,
      customerName: cleanText(review.customerName ?? review.authorName, 100) || "ผู้เข้าพัก",
      text: cleanText(review.text ?? review.comment, 1200),
      rating: Math.min(5, Math.max(1, Math.round(Number(review.rating) || 5))),
      source: cleanText(review.source, 80) || "รีวิวจากลูกค้า",
      sourceUrl: cleanUrl(review.sourceUrl ?? review.url),
      reviewDate: isoDate(review.reviewDate ?? review.date),
      sortOrder: Number.isFinite(Number(review.sortOrder)) ? Number(review.sortOrder) : 999,
    };
  }).filter((review) => review.text)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, 6)
    .map(({sortOrder: _sortOrder, ...review}) => review);
}

async function readCachedGoogleReviews(allowStale = false): Promise<{
  reviews: PublicReview[];
  rating?: number;
  reviewCount?: number;
  sourceUrl?: string;
} | null> {
  const snapshot = await CACHE_DOCUMENT.get();
  if (!snapshot.exists) return null;
  const cache = snapshot.data();
  const cachedAt = cache?.cachedAt instanceof Timestamp ? cache.cachedAt.toMillis() : 0;
  if (!allowStale && Date.now() - cachedAt > CACHE_MAX_AGE_MS) return null;
  const payload = cache?.payload;
  return payload && Array.isArray(payload.reviews) ? payload : null;
}

export const getPublicReviews = onCall(
  {region: "asia-southeast1", maxInstances: 10, secrets: [googlePlacesApiKey]},
  async () => {
    const cached = await readCachedGoogleReviews();
    if (cached) return cached;
    const apiKey = googlePlacesApiKey.value();
    if (apiKey) {
      try {
        const google = await loadGoogleReviews(apiKey);
        if (google.reviews.length) {
          await CACHE_DOCUMENT.set({payload: google, cachedAt: Timestamp.now()});
          return google;
        }
      } catch (error) {
        console.warn("Google reviews unavailable; using approved reviews.", error);
        const staleCache = await readCachedGoogleReviews(true);
        if (staleCache) return staleCache;
      }
    }
    return {reviews: await loadApprovedReviews()};
  }
);
