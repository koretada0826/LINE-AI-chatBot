// ============================================================
// 登録フォームの署名（本人のLINE IDを改ざん不可の署名付きURLで渡す）
// ?uid=<LINEユーザーID>&sig=<署名> でフォームを開く。sigが一致しないと無効。
// これで「他人になりすまして登録」を防ぐ。
// ============================================================
import crypto from "crypto";

const SECRET = process.env.LINE_CHANNEL_SECRET || "dev-secret";

export function signUid(uid) {
  return crypto
    .createHmac("sha256", SECRET)
    .update("register:" + uid)
    .digest("hex")
    .slice(0, 32);
}

export function verifyUid(uid, sig) {
  if (!uid || !sig) return false;
  const expected = signUid(uid);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
