// ============================================================
// LINE Messaging API ヘルパー（返信・プッシュ）
// ============================================================
import crypto from "crypto";

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// X-Line-Signature の署名検証（改ざん・なりすまし防止）
export function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature) return false;
  const expected = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  // タイミング攻撃対策で timingSafeEqual を使う
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 返信（replyToken を使う。無料枠。1分以内・1回のみ有効）
export async function replyText(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) console.error("LINE reply error:", res.status, await res.text());
}

// プッシュ（任意のタイミングで送る。従量課金対象。運営通知などに使用）
export async function pushText(to, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.error("LINE push error:", res.status, await res.text());
}
