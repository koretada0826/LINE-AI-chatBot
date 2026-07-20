// ============================================================
// LINE Messaging API ヘルパー（返信・プッシュ・署名検証）
// アクセストークンは、Supabase接続時は Channel ID + secret から自動更新する
// （静的トークンの30日失効を運用上ゼロにできる）。未接続時は静的トークンを使う。
// ============================================================
import crypto from "crypto";
import { getLineToken, saveLineToken, persistenceEnabled } from "./store.js";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const STATIC_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const REFRESH_MARGIN_MS = 24 * 3600 * 1000; // 期限の1日前には更新する

let cached = null; // { token, expiresAt(ms) }（ウォームインスタンス内キャッシュ）

// Channel ID + secret から新しいトークンを発行
async function mintToken() {
  const res = await fetch("https://api.line.me/v2/oauth/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CHANNEL_ID,
      client_secret: CHANNEL_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("token mint failed: " + JSON.stringify(data));
  return { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

// 有効なアクセストークンを返す（必要なら自動更新）
export async function getAccessToken() {
  const now = Date.now();
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) return cached.token;

  // Supabase(永続化)＋Channel ID+secret があれば自動更新（30トークン制限を避けるため保存して使い回す）
  if (persistenceEnabled && CHANNEL_ID && CHANNEL_SECRET) {
    try {
      const saved = await getLineToken();
      if (saved && Date.parse(saved.expires_at) - now > REFRESH_MARGIN_MS) {
        cached = { token: saved.token, expiresAt: Date.parse(saved.expires_at) };
        return cached.token;
      }
      const minted = await mintToken();
      cached = minted;
      await saveLineToken(minted.token, new Date(minted.expiresAt).toISOString());
      return minted.token;
    } catch (e) {
      console.error("token auto-refresh failed, fallback to static token:", e.message);
    }
  }
  // フォールバック：静的トークン（Supabase未接続時など）
  return STATIC_TOKEN;
}

// X-Line-Signature の署名検証（改ざん・なりすまし防止）
export function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature) return false;
  const expected = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 返信（任意のメッセージ配列。クイックリプライ等に対応）
export async function replyMessages(replyToken, messages) {
  const token = await getAccessToken();
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!res.ok) console.error("LINE reply error:", res.status, await res.text());
}

// 返信（テキスト1通。無料枠。1分以内・1回のみ有効）
export async function replyText(replyToken, text) {
  return replyMessages(replyToken, [{ type: "text", text }]);
}

// プッシュ（任意のメッセージ配列。Flex等も可。最大5通/回）
export async function pushMessages(to, messages) {
  const token = await getAccessToken();
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, messages: messages.slice(0, 5) }),
  });
  if (!res.ok) console.error("LINE push error:", res.status, await res.text());
}

// プッシュ（テキスト1通）
export async function pushText(to, text) {
  return pushMessages(to, [{ type: "text", text }]);
}

// 「考え中…」のローディングアニメーションを表示（1:1チャットのみ）。
// AI生成中に出しておくと、返信までの"無反応"をなくせる。返信が届くと自動で消える。
// loadingSeconds は 5〜60 の5刻み。失敗しても本処理は止めない（best-effort）。
export async function showLoading(chatId, seconds = 20) {
  try {
    const token = await getAccessToken();
    const s = Math.min(60, Math.max(5, Math.round(seconds / 5) * 5));
    const res = await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ chatId, loadingSeconds: s }),
    });
    if (!res.ok) console.error("LINE loading error:", res.status, await res.text());
  } catch (e) {
    console.error("showLoading error:", e.message);
  }
}
