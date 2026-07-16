// ============================================================
// レポート集計：会社ごとに「こういう相談が多い」を匿名集計
// 個別の相談内容は出さず、カテゴリ・テーマの傾向のみ（要件通り）。
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function tally(rows, key, total) {
  const m = {};
  for (const r of rows) {
    const k = r[key] || "(未分類)";
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m)
    .map(([name, count]) => ({
      name,
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

// companyId を指定するとその会社のみ。未指定なら全社。
export async function generateReport(companyId = null) {
  if (!supabase) return null;
  let q = supabase
    .from("consultation_logs")
    .select("category, topic, escalated, created_at, company_id");
  if (companyId) q = q.eq("company_id", companyId);
  const { data, error } = await q;
  if (error) {
    console.error("generateReport error:", error.message);
    return null;
  }
  const logs = data ?? [];
  const total = logs.length;
  return {
    companyId,
    total,
    escalations: logs.filter((l) => l.escalated).length,
    byCategory: tally(logs, "category", total),
    byTopic: tally(logs, "topic", total),
    generatedAt: new Date().toISOString(),
  };
}

// スプレッドシート用CSV
export function reportToCsv(rep) {
  const lines = ["種別,項目,件数,割合(%)"];
  for (const c of rep.byCategory) lines.push(`カテゴリ,${csv(c.name)},${c.count},${c.pct}`);
  for (const t of rep.byTopic) lines.push(`テーマ,${csv(t.name)},${t.count},${t.pct}`);
  lines.push(`合計,相談件数,${rep.total},100`);
  lines.push(`合計,エスカレーション,${rep.escalations},`);
  return "﻿" + lines.join("\n"); // BOM付き（Excel/スプシで文字化け防止）
}
const csv = (s) => `"${String(s).replace(/"/g, '""')}"`;

// 社長向けテキストサマリー
export function reportToText(rep) {
  if (!rep.total) return "対象期間の相談はまだありません。";
  const top = rep.byCategory
    .slice(0, 3)
    .map((c) => `${c.name}（${c.pct}%）`)
    .join("、");
  const topics = rep.byTopic.slice(0, 5).map((t) => `${t.name}(${t.count})`).join("、");
  return (
    `【組織コンディション・レポート】\n` +
    `相談件数：${rep.total}件（うち緊急対応：${rep.escalations}件）\n` +
    `多い相談カテゴリ：${top}\n` +
    `よくあるテーマ：${topics}\n` +
    `※個別の相談内容は含まれません（匿名集計）。`
  );
}
