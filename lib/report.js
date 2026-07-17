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

// companyId を指定するとその会社のみ。sinceDays を指定すると直近N日に絞る（月次=30）。
// sinceDays 指定時は、直前の同じ期間（前月）と比較したトレンドも算出する。
export async function generateReport(companyId = null, sinceDays = null) {
  if (!supabase) return null;
  // トレンド算出のため、当期＋前期（2N日分）をまとめて取得
  const windowDays = sinceDays ? sinceDays * 2 : null;
  let q = supabase
    .from("consultation_logs")
    .select("category, topic, escalated, created_at, company_id");
  if (companyId) q = q.eq("company_id", companyId);
  if (windowDays)
    q = q.gte("created_at", new Date(Date.now() - windowDays * 86400000).toISOString());
  const { data, error } = await q;
  if (error) {
    console.error("generateReport error:", error.message);
    return null;
  }
  const all = data ?? [];
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
  const cur = sinceDays ? all.filter((l) => Date.parse(l.created_at) >= cutoff) : all;
  const prev = sinceDays ? all.filter((l) => Date.parse(l.created_at) < cutoff) : [];
  const total = cur.length;

  // 前期のカテゴリ別件数（トレンド比較用）
  const prevCat = {};
  for (const l of prev) {
    const k = l.category || "(未分類)";
    prevCat[k] = (prevCat[k] || 0) + 1;
  }
  const byCategory = tally(cur, "category", total);
  const categoryTrends = byCategory.map((c) => ({
    ...c,
    prev: prevCat[c.name] || 0,
    delta: c.count - (prevCat[c.name] || 0),
  }));

  return {
    companyId,
    sinceDays,
    total,
    prevTotal: prev.length,
    escalations: cur.filter((l) => l.escalated).length,
    prevEscalations: prev.filter((l) => l.escalated).length,
    byCategory,
    categoryTrends,
    byTopic: tally(cur, "topic", total),
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

// 社長向けHTMLレポート（そのままCEOに渡せる画面）
const he = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export function reportToHtml(rep, companyName = "", periodLabel = "全期間", exec = null) {
  // トレンド矢印（前期比）。件数の増減を ↑n / ↓n / → で表示。
  const trendMap = {};
  for (const t of rep.categoryTrends || []) trendMap[t.name] = t.delta;
  const arrow = (name) => {
    const d = trendMap[name];
    if (d == null || !rep.sinceDays) return "";
    if (d > 0) return `<span class="tr up">▲${d}</span>`;
    if (d < 0) return `<span class="tr down">▼${-d}</span>`;
    return `<span class="tr flat">±0</span>`;
  };
  const catRows = rep.byCategory
    .map(
      (c) => `<tr><td>${he(c.name)} ${arrow(c.name)}</td><td class="num">${c.count}</td>
        <td class="barcell"><div class="bar"><div class="fill" style="width:${c.pct}%"></div></div><span class="pct">${c.pct}%</span></td></tr>`
    )
    .join("");
  const topicRows = rep.byTopic
    .slice(0, 10)
    .map((t) => `<tr><td>${he(t.name)}</td><td class="num">${t.count}</td></tr>`)
    .join("");
  const d = new Date(rep.generatedAt);
  const dstr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

  // AI経営サマリー（execがあれば優先）。無ければ数字ベースの簡易文。
  const top3 = rep.byCategory.slice(0, 3).map((c) => `${he(c.name)}（${c.pct}%）`).join("、");
  let summaryHtml;
  if (exec && rep.total) {
    const findings = (exec.findings || [])
      .map((f) => `<li>${he(f)}</li>`)
      .join("");
    const recos = (exec.recommendations || [])
      .map((r) => `<li>${he(r)}</li>`)
      .join("");
    summaryHtml =
      `<div class="ov">${he(exec.overview)}</div>` +
      (findings ? `<div class="blk"><div class="bt">注目点</div><ul>${findings}</ul></div>` : "") +
      (recos ? `<div class="blk reco"><div class="bt">経営への提言</div><ul>${recos}</ul></div>` : "");
  } else {
    summaryHtml = rep.total
      ? `<div class="ov">この期間、最も多かったのは <b>${top3 || "—"}</b> でした。</div>`
      : `<div class="ov">この期間の相談はまだありません。</div>`;
  }
  // 相談件数の前期比
  const totalDelta = rep.sinceDays ? rep.total - (rep.prevTotal || 0) : null;
  const totalTrend =
    totalDelta == null
      ? ""
      : totalDelta > 0
      ? `<span class="cardtr up">前期比 ▲${totalDelta}</span>`
      : totalDelta < 0
      ? `<span class="cardtr down">前期比 ▼${-totalDelta}</span>`
      : `<span class="cardtr flat">前期比 ±0</span>`;

  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>組織コンディション・レポート${companyName ? " ｜ " + he(companyName) : ""}</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,'Hiragino Sans',sans-serif;margin:0;background:#f4f5f7;color:#1c2430}
  .wrap{max-width:720px;margin:0 auto;padding:24px 18px 60px}
  .head{background:#0e2a47;color:#fff;border-radius:16px;padding:22px 20px}
  .head h1{font-size:18px;margin:0 0 6px} .head .sub{opacity:.85;font-size:13px}
  .cards{display:flex;gap:12px;margin:16px 0}
  .card{flex:1;background:#fff;border-radius:14px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  .card .n{font-size:28px;font-weight:800} .card .l{font-size:12px;color:#667}
  .card.alert .n{color:#c0392b}
  .summary{background:#fff;border-radius:14px;padding:18px 20px;font-size:15px;line-height:1.9;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.05);border-left:4px solid #2f6fb0}
  .summary .ov{font-size:15.5px;color:#1c2430;margin-bottom:4px}
  .summary .blk{margin-top:14px} .summary .bt{font-size:12px;font-weight:700;color:#2f6fb0;letter-spacing:.04em;margin-bottom:6px}
  .summary ul{margin:0;padding-left:20px} .summary li{font-size:14px;line-height:1.75;margin-bottom:4px}
  .summary .reco .bt{color:#0e7a4b} .summary .reco li::marker{color:#0e7a4b}
  section{background:#fff;border-radius:14px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h2{font-size:15px;margin:0 0 12px;color:#0e2a47}
  table{width:100%;border-collapse:collapse} td{padding:8px 4px;font-size:14px;border-bottom:1px solid #eef1f4;vertical-align:middle}
  .num{width:48px;text-align:right;color:#334;font-variant-numeric:tabular-nums}
  .barcell{width:52%} .bar{background:#e9eef3;border-radius:6px;height:10px;overflow:hidden;display:inline-block;width:calc(100% - 46px);vertical-align:middle}
  .fill{height:100%;background:#2f6fb0;border-radius:6px} .pct{font-size:12px;color:#667;margin-left:8px}
  .tr{font-size:11px;font-weight:700;margin-left:4px;vertical-align:middle}
  .tr.up{color:#c0392b} .tr.down{color:#1f7a4d} .tr.flat{color:#98a3b0}
  .cardtr{display:block;font-size:11px;font-weight:700;margin-top:4px}
  .cardtr.up{color:#c0392b} .cardtr.down{color:#1f7a4d} .cardtr.flat{color:#98a3b0}
  .note{color:#8894a3;font-size:12px;line-height:1.7;margin-top:8px}
  .foot{color:#98a3b0;font-size:12px;text-align:center;margin-top:20px}
</style></head><body><div class="wrap">
  <div class="head">
    <h1>組織コンディション・レポート</h1>
    <div class="sub">${companyName ? he(companyName) + "　" : ""}対象：${he(periodLabel)}　作成日：${dstr}</div>
  </div>
  <div class="cards">
    <div class="card"><div class="n">${rep.total}</div><div class="l">相談件数</div>${totalTrend}</div>
    <div class="card alert"><div class="n">${rep.escalations}</div><div class="l">緊急対応</div></div>
    <div class="card"><div class="n">${rep.byCategory.length}</div><div class="l">相談カテゴリ数</div></div>
  </div>
  <div class="summary">${summaryHtml}</div>
  <section>
    <h2>相談カテゴリの傾向</h2>
    <table>${catRows || '<tr><td class="note">データがありません</td></tr>'}</table>
  </section>
  <section>
    <h2>よくあるテーマ（上位）</h2>
    <table>${topicRows || '<tr><td class="note">データがありません</td></tr>'}</table>
  </section>
  <p class="note">※本レポートは匿名で集計した組織全体の傾向です。個別の相談内容・個人が特定される情報は一切含まれません。<br>提供：才職CARE（Uniboost）</p>
  <div class="foot">才職CARE ｜ 社外相談窓口サービス</div>
</div></body></html>`;
}

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
