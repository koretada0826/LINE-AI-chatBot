// ============================================================
// 診断用（運営マスタートークン保護）：AI生成の生エラーを直接見る。障害切り分け用。
// 例: /api/diag?token=MASTER&q=最近しんどいです
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { consult } from "../lib/ai.js";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from "../lib/prompt.js";

const M = process.env.REPORT_ACCESS_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!M || (req.query?.token || "") !== M) {
    return res.status(401).json({ ok: false, error: "Unauthorized（運営専用）" });
  }
  const text = (req.query?.q || "最近、上司との関係でしんどいです").toString();
  const out = {};

  // ① 生のAPI呼び出しでエラーを掴む（maxRetries:0で即失敗させ、生メッセージを取得）
  try {
    const client = new Anthropic({ maxRetries: 0 });
    const t0 = Date.now();
    const resp = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
      max_tokens: 12000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    const tb = (resp.content || []).find((b) => b.type === "text");
    out.raw = { ok: true, ms: Date.now() - t0, stop_reason: resp.stop_reason, text: (tb?.text || "").slice(0, 600) };
  } catch (e) {
    out.raw = { ok: false, status: e?.status, name: e?.name, error: String(e?.message || e).slice(0, 800) };
  }

  // ② consult経由（本番の実際の経路）
  try {
    const r = await consult([{ role: "user", content: text }], {});
    out.consult = { ok: true, reply: r.reply, category: r.category, topic: r.topic };
  } catch (e) {
    out.consult = { ok: false, error: String(e?.message || e).slice(0, 400) };
  }

  return res.status(200).json(out);
}
