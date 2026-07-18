// ============================================================
// リッチメニュー登録（管理用・1回叩けばOK）
//   GET /api/setup-richmenu?key=<SETUP_KEY>
//   1) リッチメニュー作成 → 2) 画像アップロード → 3) デフォルト設定
// 画像は public/richmenu.png（1200x405）。ボタン=相談する/メンターに相談/今すぐ相談。
// ============================================================
import { getAccessToken } from "../lib/line.js";

const APP_BASE_URL =
  process.env.APP_BASE_URL || "https://line-ai-chat-bot-eosin.vercel.app";

// 3分割（各400px）のタップ領域
const RICHMENU = {
  size: { width: 1200, height: 405 },
  selected: true,
  name: "saishoku-main",
  chatBarText: "メニュー",
  areas: [
    { bounds: { x: 0, y: 0, width: 400, height: 405 }, action: { type: "message", text: "相談したいです" } },
    { bounds: { x: 400, y: 0, width: 400, height: 405 }, action: { type: "postback", data: "want_human", displayText: "メンターに相談" } },
    { bounds: { x: 800, y: 0, width: 400, height: 405 }, action: { type: "postback", data: "want_now", displayText: "今すぐ相談" } },
  ],
};

export default async function handler(req, res) {
  // 簡易ガード（管理用）。SETUP_KEY 未設定時は既定フレーズを許可。
  const key = req.query?.key || "";
  const expected = process.env.SETUP_KEY || "setup-richmenu-2026";
  if (key !== expected) return res.status(401).json({ error: "unauthorized" });

  try {
    const token = await getAccessToken();
    const auth = { Authorization: `Bearer ${token}` };

    // 1) 作成
    const created = await fetch("https://api.line.me/v2/bot/richmenu", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(RICHMENU),
    });
    const createdBody = await created.json();
    if (!created.ok) return res.status(500).json({ step: "create", status: created.status, body: createdBody });
    const richMenuId = createdBody.richMenuId;

    // 2) 画像アップロード（自ホストのpublic/richmenu.pngを取得して送る）
    const imgResp = await fetch(`${APP_BASE_URL}/richmenu.png`);
    if (!imgResp.ok) return res.status(500).json({ step: "fetch-image", status: imgResp.status });
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    const uploaded = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: "POST",
      headers: { "Content-Type": "image/png", ...auth },
      body: imgBuf,
    });
    if (!uploaded.ok) return res.status(500).json({ step: "upload", status: uploaded.status, body: await uploaded.text() });

    // 3) 全ユーザーのデフォルトに設定
    const setDefault = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
      method: "POST",
      headers: auth,
    });
    if (!setDefault.ok) return res.status(500).json({ step: "set-default", status: setDefault.status, body: await setDefault.text() });

    return res.status(200).json({ ok: true, richMenuId, message: "リッチメニューを登録し、デフォルトに設定しました。" });
  } catch (e) {
    console.error("setup-richmenu error:", e);
    return res.status(500).json({ error: e.message });
  }
}
