// ============================================================
// 診断用（運営マスタートークン保護）：consult(AI生成)が本番で正常か直接確認する。
// 例: /api/diag?token=MASTER&q=最近しんどいです
// LINEを介さずAIの返信を返す。障害切り分け用。個人データは使わない。
// ============================================================
import { consult } from "../lib/ai.js";

const M = process.env.REPORT_ACCESS_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!M || (req.query?.token || "") !== M) {
    return res.status(401).json({ ok: false, error: "Unauthorized（運営専用）" });
  }
  const text = (req.query?.q || "最近、上司との関係で少し悩んでいます。").toString();
  const t0 = Date.now();
  try {
    const r = await consult([{ role: "user", content: text }], {});
    return res.status(200).json({
      ok: true,
      ms: Date.now() - t0,
      reply: r.reply,
      category: r.category,
      topic: r.topic,
      risk_level: r.risk_level,
      suggested_replies: r.suggested_replies,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, ms: Date.now() - t0, error: String(e?.message || e) });
  }
}
