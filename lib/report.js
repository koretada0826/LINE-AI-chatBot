// ============================================================
// レポート集計：会社ごとに「こういう相談が多い」を匿名集計
// 個別の相談内容は出さず、カテゴリ・テーマの傾向のみ（要件通り）。
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// 対応区分(category)の内部コード → 社長にも分かる日本語ラベル
const CAT_LABELS = {
  ai_only: "情報提供・FAQ",
  mentor_normal: "通常相談（傾聴・整理）",
  mentor_caution: "要注意（離職・ハラス兆候等）",
  escalation: "緊急対応",
  admin_broadcast: "全社配信依頼",
  onboarding: "登録・使い方",
  other: "その他・雑談",
  "(未分類)": "未分類",
};
const catLabel = (name) => CAT_LABELS[name] || name;

// 前期のkey別件数マップ
function prevCounts(rows, key) {
  const m = {};
  for (const r of rows) {
    const k = r[key] || "(未分類)";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}
// tally結果に前期比(prev/delta)を付ける
function withTrend(items, prevMap) {
  return items.map((it) => ({
    ...it,
    prev: prevMap[it.name] || 0,
    delta: it.count - (prevMap[it.name] || 0),
  }));
}

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
    .select("category, topic, escalated, created_at, company_id, department");
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

  // 相談テーマ(topic)＝社長が見る主役。対応区分(category)＝社内の対応内訳。
  const byTopic = tally(cur, "topic", total);
  const topicTrends = withTrend(byTopic, prevCounts(prev, "topic"));
  const byCategory = tally(cur, "category", total).map((c) => ({
    ...c,
    label: catLabel(c.name),
  }));
  const categoryTrends = withTrend(byCategory, prevCounts(prev, "category"));

  // 部署別（登録時に部署が入っている相談のみ）。部署未設定は集計から除く。
  const withDept = cur.filter((l) => l.department);
  const byDepartment = tally(withDept, "department", withDept.length);

  return {
    companyId,
    sinceDays,
    total,
    prevTotal: prev.length,
    escalations: cur.filter((l) => l.escalated).length,
    prevEscalations: prev.filter((l) => l.escalated).length,
    byTopic,
    topicTrends,
    byCategory,
    categoryTrends,
    byDepartment,
    generatedAt: new Date().toISOString(),
  };
}

// スプレッドシート用CSV
export function reportToCsv(rep) {
  const lines = ["種別,項目,件数,割合(%)"];
  for (const t of rep.byTopic) lines.push(`相談テーマ,${csv(t.name)},${t.count},${t.pct}`);
  for (const c of rep.byCategory)
    lines.push(`対応区分,${csv(c.label || c.name)},${c.count},${c.pct}`);
  lines.push(`合計,相談件数,${rep.total},100`);
  lines.push(`合計,緊急対応,${rep.escalations},`);
  return "﻿" + lines.join("\n"); // BOM付き（Excel/スプシで文字化け防止）
}
const csv = (s) => `"${String(s).replace(/"/g, '""')}"`;

// 社長向けHTMLレポート（そのままCEOに渡せる画面）
const he = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export function reportToHtml(rep, companyName = "", periodLabel = "全期間", exec = null) {
  // トレンド矢印（前期比）。増=▲(赤)、減=▼(緑)、横ばい=±0。
  const arrowFrom = (trends) => {
    const m = {};
    for (const t of trends || []) m[t.name] = t.delta;
    return (name) => {
      const d = m[name];
      if (d == null || !rep.sinceDays) return "";
      if (d > 0) return `<span class="tr up">▲${d}</span>`;
      if (d < 0) return `<span class="tr down">▼${-d}</span>`;
      return `<span class="tr flat">±0</span>`;
    };
  };
  const topicArrow = arrowFrom(rep.topicTrends);
  const catArrow = arrowFrom(rep.categoryTrends);

  // 主役＝相談テーマ(topic)。バー付きで表示。
  const topicRows = rep.byTopic
    .map(
      (t) => `<tr><td>${he(t.name)} ${topicArrow(t.name)}</td><td class="num">${t.count}</td>
        <td class="barcell"><div class="bar"><div class="fill" style="width:${t.pct}%"></div></div><span class="pct">${t.pct}%</span></td></tr>`
    )
    .join("");
  // 従＝対応区分(category)。日本語ラベルで内訳表示。
  const catRows = rep.byCategory
    .map(
      (c) => `<tr><td>${he(c.label || c.name)} ${catArrow(c.name)}</td><td class="num">${c.count}</td><td class="pctcell">${c.pct}%</td></tr>`
    )
    .join("");
  const d = new Date(rep.generatedAt);
  const dstr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

  // AI経営サマリー（execがあれば優先）。無ければ数字ベースの簡易文。
  const top3 = rep.byTopic.slice(0, 3).map((t) => `${he(t.name)}（${t.pct}%）`).join("、");
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

  // 部署別セクション（データがある時のみ）
  const deptSection =
    rep.byDepartment && rep.byDepartment.length
      ? `<section class="blk3">
    <div class="sec-h"><span class="secnum">03</span><h2>部署別の相談件数</h2></div>
    <table>${rep.byDepartment
      .map(
        (dp) => `<tr><td class="lbl">${he(dp.name)}</td><td class="num">${dp.count}</td>
        <td class="barcell"><div class="bar"><div class="fill" style="width:${dp.pct}%"></div></div><span class="pct">${dp.pct}%</span></td></tr>`
      )
      .join("")}</table>
  </section>`
      : "";

  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>組織コンディション・レポート${companyName ? " ｜ " + he(companyName) : ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Noto+Serif+JP:wght@600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --navy:#0f2846; --navy2:#20456f; --gold:#c8a44d; --ink:#1b2430; --muted:#6b7684;
    --line:#e7ecf1; --bar:#3a6ea5; --bar2:#7fb0dd; --paper:#fff; --bg:#e9edf1; --alert:#c0392b; --green:#0e7a4b;
  }
  *{box-sizing:border-box}
  body{font-family:'Noto Sans JP','Hiragino Sans',-apple-system,sans-serif;margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  .page{max-width:760px;margin:24px auto;background:var(--paper);box-shadow:0 8px 40px rgba(15,40,70,.12);border-radius:8px;overflow:hidden}
  /* 表紙ヘッダー */
  .cover{position:relative;background:linear-gradient(135deg,#0f2846 0%,#20456f 100%);color:#fff;padding:40px 44px 34px}
  .cover::after{content:"";position:absolute;right:-60px;top:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(200,164,77,.22),transparent 70%)}
  .brand{font-size:13px;letter-spacing:.22em;font-weight:700;color:#fff;opacity:.92}
  .brand span{font-weight:400;opacity:.6;letter-spacing:.1em;margin-left:8px;font-size:11px}
  .goldrule{width:46px;height:3px;background:var(--gold);border-radius:2px;margin:22px 0 16px}
  .doc-title{font-family:'Noto Serif JP',serif;font-size:26px;font-weight:700;letter-spacing:.02em;margin:0}
  .company{font-size:17px;font-weight:500;margin-top:12px;opacity:.96}
  .cover .meta{font-size:12.5px;opacity:.72;margin-top:6px;letter-spacing:.02em}
  /* KPI */
  .kpis{display:flex;gap:14px;padding:26px 44px 6px}
  .kpi{flex:1;background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 14px 16px;text-align:center;position:relative;overflow:hidden}
  .kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--bar)}
  .kpi.alert::before{background:var(--alert)}
  .kpi .n{font-size:32px;font-weight:900;line-height:1;letter-spacing:-.01em}
  .kpi.alert .n{color:var(--alert)}
  .kpi .l{font-size:11.5px;color:var(--muted);margin-top:8px;letter-spacing:.04em}
  .cardtr{display:block;font-size:11px;font-weight:700;margin-top:5px}
  .cardtr.up{color:var(--alert)} .cardtr.down{color:var(--green)} .cardtr.flat{color:#98a3b0}
  /* 本文 */
  .body{padding:22px 44px 8px}
  section{margin-bottom:26px;break-inside:avoid}
  .sec-h{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .secnum{font-family:'Noto Serif JP',serif;font-size:13px;font-weight:700;color:var(--gold);border:1.5px solid var(--gold);border-radius:6px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
  h2{font-size:16px;margin:0;color:var(--navy);font-weight:700;letter-spacing:.01em}
  /* エグゼクティブサマリー */
  .exec{background:#f7f9fb;border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:10px;padding:22px 24px}
  .eyebrow{font-size:10.5px;letter-spacing:.28em;font-weight:700;color:var(--gold);margin-bottom:4px}
  .exec .headline{font-family:'Noto Serif JP',serif;font-size:17px;font-weight:700;color:var(--navy);margin:0 0 14px}
  .summary .ov{font-size:15px;line-height:1.95;color:var(--ink)}
  .summary .blk{margin-top:18px}
  .summary .bt{font-size:11px;font-weight:700;color:var(--navy);letter-spacing:.14em;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .summary ul{margin:0;padding-left:4px;list-style:none}
  .summary li{font-size:13.5px;line-height:1.8;margin-bottom:8px;padding-left:20px;position:relative}
  .summary li::before{content:"";position:absolute;left:2px;top:9px;width:6px;height:6px;border-radius:50%;background:var(--bar)}
  .summary .reco .bt{color:var(--green)}
  .summary .reco li::before{background:var(--green)}
  /* テーブル */
  table{width:100%;border-collapse:collapse}
  td{padding:10px 4px;font-size:13.5px;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .lbl{font-weight:500}
  .num{width:44px;text-align:right;color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
  .pctcell{width:58px;text-align:right;color:var(--muted);font-size:12.5px}
  .barcell{width:50%}
  .bar{background:#eaeff4;border-radius:5px;height:9px;overflow:hidden;display:inline-block;width:calc(100% - 44px);vertical-align:middle}
  .fill{height:100%;background:linear-gradient(90deg,var(--bar),var(--bar2));border-radius:5px}
  .pct{font-size:11.5px;color:var(--muted);margin-left:8px;font-weight:600}
  .tr{font-size:10.5px;font-weight:700;margin-left:6px;vertical-align:middle}
  .tr.up{color:var(--alert)} .tr.down{color:var(--green)} .tr.flat{color:#98a3b0}
  /* フッター */
  .foot{border-top:1px solid var(--line);margin:8px 44px 0;padding:18px 0 26px}
  .conf{font-size:11px;color:var(--muted);line-height:1.7}
  .footbrand{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:11px;color:#9aa4b0}
  .footbrand b{color:var(--navy);font-weight:700;letter-spacing:.1em}
  .printbtn{position:fixed;right:20px;bottom:20px;z-index:9;padding:13px 20px;border:0;border-radius:26px;
    background:var(--navy);color:#fff;font-size:14px;font-weight:700;box-shadow:0 6px 18px rgba(15,40,70,.28);cursor:pointer}
  .printbtn:hover{background:var(--navy2)}
  @page{size:A4;margin:12mm}
  @media print{
    body{background:#fff} .page{max-width:100%;margin:0;box-shadow:none;border-radius:0}
    .printbtn{display:none}
    .cover,.kpi,.exec,.fill,.secnum{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    section{break-inside:avoid}
  }
</style></head><body>
  <button class="printbtn" onclick="window.print()">🖨 PDFで保存（資料として共有）</button>
  <div class="page">
    <header class="cover">
      <div class="brand">才職CARE<span>社外相談窓口サービス</span></div>
      <div class="goldrule"></div>
      <h1 class="doc-title">組織コンディション・レポート</h1>
      ${companyName ? `<div class="company">${he(companyName)} 御中</div>` : ""}
      <div class="meta">対象期間：${he(periodLabel)}　／　作成日：${dstr}</div>
    </header>
    <div class="kpis">
      <div class="kpi"><div class="n">${rep.total}</div><div class="l">相談件数</div>${totalTrend}</div>
      <div class="kpi alert"><div class="n">${rep.escalations}</div><div class="l">緊急対応</div></div>
      <div class="kpi"><div class="n">${rep.byTopic.length}</div><div class="l">相談テーマ数</div></div>
    </div>
    <div class="body">
      <section class="exec">
        <div class="eyebrow">EXECUTIVE SUMMARY</div>
        <div class="headline">エグゼクティブ・サマリー</div>
        <div class="summary">${summaryHtml}</div>
      </section>
      <section>
        <div class="sec-h"><span class="secnum">01</span><h2>相談テーマの傾向</h2></div>
        <table>${topicRows || '<tr><td class="conf">データがありません</td></tr>'}</table>
      </section>
      <section>
        <div class="sec-h"><span class="secnum">02</span><h2>対応区分の内訳</h2></div>
        <table>${catRows || '<tr><td class="conf">データがありません</td></tr>'}</table>
      </section>
      ${deptSection}
    </div>
    <div class="foot">
      <div class="conf">※本レポートは匿名で集計した組織全体の傾向です。個別の相談内容・個人が特定される情報は一切含まれません。取り扱いには十分ご注意ください。</div>
      <div class="footbrand"><span>Confidential</span><span><b>才職CARE</b>　by Uniboost</span></div>
    </div>
  </div>
</body></html>`;
}

// ============================================================
// 運営ダッシュボード：全社を1画面で一覧（運営マスタトークンでのみ閲覧）
// rows: [{ id, name, invite_code, rep }]  rep=generateReportの結果 or null
// masterToken: 各社詳細レポートへのリンクに使う（運営自身のトークン）
// ============================================================
export function reportToAdminHtml(rows, periodLabel = "全期間", masterToken = "") {
  const tk = encodeURIComponent(masterToken);
  const sinceParam = rows[0]?.rep?.sinceDays ? `&since=${rows[0].rep.sinceDays}` : "";
  // 全社合計
  const totalAll = rows.reduce((s, r) => s + (r.rep?.total || 0), 0);
  const escAll = rows.reduce((s, r) => s + (r.rep?.escalations || 0), 0);
  // 件数の多い順に並べる
  const sorted = [...rows].sort((a, b) => (b.rep?.total || 0) - (a.rep?.total || 0));

  const trArrow = (delta, since) => {
    if (delta == null || !since) return "";
    if (delta > 0) return `<span class="tr up">▲${delta}</span>`;
    if (delta < 0) return `<span class="tr down">▼${-delta}</span>`;
    return `<span class="tr flat">±0</span>`;
  };

  const bodyRows = sorted
    .map((r) => {
      const rep = r.rep;
      const total = rep?.total || 0;
      const esc = rep?.escalations || 0;
      const topTheme = rep?.byTopic?.[0]
        ? `${he(rep.byTopic[0].name)}（${rep.byTopic[0].pct}%）`
        : '<span class="muted">—</span>';
      const totalDelta = rep?.sinceDays ? total - (rep.prevTotal || 0) : null;
      const link = `/api/report?token=${tk}&company_id=${r.id}${sinceParam}`;
      const escCls = esc > 0 ? ' class="num alert"' : ' class="num"';
      return `<tr>
        <td class="co"><b>${he(r.name || "(無名)")}</b><span class="code">${he(r.invite_code || "")}</span></td>
        <td class="num">${total} ${trArrow(totalDelta, rep?.sinceDays)}</td>
        <td${escCls}>${esc}</td>
        <td class="theme">${topTheme}</td>
        <td class="act"><a href="${link}">レポートを見る →</a></td>
      </tr>`;
    })
    .join("");
  const d = new Date();
  const dstr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>運営ダッシュボード ｜ 才職CARE</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,'Hiragino Sans',sans-serif;margin:0;background:#f4f5f7;color:#1c2430}
  .wrap{max-width:840px;margin:0 auto;padding:24px 18px 60px}
  .head{background:#0e2a47;color:#fff;border-radius:16px;padding:22px 20px}
  .head h1{font-size:18px;margin:0 0 6px} .head .sub{opacity:.85;font-size:13px}
  .cards{display:flex;gap:12px;margin:16px 0}
  .card{flex:1;background:#fff;border-radius:14px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  .card .n{font-size:28px;font-weight:800} .card .l{font-size:12px;color:#667}
  .card.alert .n{color:#c0392b}
  section{background:#fff;border-radius:14px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h2{font-size:15px;margin:0 0 12px;color:#0e2a47}
  .filters{margin:0 0 14px;font-size:13px}
  .filters a{display:inline-block;padding:6px 12px;margin-right:8px;border-radius:20px;background:#eef1f4;color:#2f6fb0;text-decoration:none}
  .filters a.on{background:#2f6fb0;color:#fff}
  table{width:100%;border-collapse:collapse}
  th{font-size:12px;color:#8894a3;text-align:left;padding:6px 4px;border-bottom:2px solid #eef1f4;font-weight:700}
  td{padding:11px 4px;font-size:14px;border-bottom:1px solid #eef1f4;vertical-align:middle}
  .co b{font-size:14.5px} .co .code{display:block;font-size:11px;color:#98a3b0;margin-top:2px}
  .num{width:70px;text-align:right;color:#334;font-variant-numeric:tabular-nums}
  .num.alert{color:#c0392b;font-weight:700}
  th.num{text-align:right}
  .theme{font-size:13px;color:#445}
  .act{width:120px;text-align:right} .act a{color:#2f6fb0;text-decoration:none;font-weight:600;font-size:13px}
  .muted{color:#b3bcc7}
  .tr{font-size:11px;font-weight:700;margin-left:2px}
  .tr.up{color:#c0392b} .tr.down{color:#1f7a4d} .tr.flat{color:#98a3b0}
  .note{color:#8894a3;font-size:12px;line-height:1.7;margin-top:8px}
  .foot{color:#98a3b0;font-size:12px;text-align:center;margin-top:20px}
</style></head><body><div class="wrap">
  <div class="head">
    <h1>運営ダッシュボード</h1>
    <div class="sub">全 ${rows.length} 社　対象：${he(periodLabel)}　閲覧日：${dstr}</div>
  </div>
  <div class="cards">
    <div class="card"><div class="n">${rows.length}</div><div class="l">導入企業</div></div>
    <div class="card"><div class="n">${totalAll}</div><div class="l">相談件数（全社）</div></div>
    <div class="card alert"><div class="n">${escAll}</div><div class="l">緊急対応（全社）</div></div>
  </div>
  <section>
    <div class="filters">
      期間：
      <a href="/api/report?token=${tk}&since=7" class="${rows[0]?.rep?.sinceDays === 7 ? "on" : ""}">直近7日</a>
      <a href="/api/report?token=${tk}&since=30" class="${rows[0]?.rep?.sinceDays === 30 ? "on" : ""}">直近30日</a>
      <a href="/api/report?token=${tk}&since=90" class="${rows[0]?.rep?.sinceDays === 90 ? "on" : ""}">直近90日</a>
      <a href="/api/report?token=${tk}" class="${!rows[0]?.rep?.sinceDays ? "on" : ""}">全期間</a>
      <span style="margin:0 8px;color:#cfd6de">｜</span>
      <a href="/api/billing?token=${tk}" style="background:#0e7a4b;color:#fff">💴 請求一覧を見る</a>
    </div>
    <table>
      <thead><tr><th>企業</th><th class="num">相談</th><th class="num">緊急</th><th>多いテーマ</th><th></th></tr></thead>
      <tbody>${bodyRows || '<tr><td colspan="5" class="note">登録企業がありません</td></tr>'}</tbody>
    </table>
  </section>
  <p class="note">※各社の数字は匿名集計です。「レポートを見る」から、その企業の社長向けレポート（AI経営サマリー付き）を開けます。<br>このダッシュボードは運営マスタートークンでのみ閲覧できます。URL・トークンの取り扱いにご注意ください。</p>
  <div class="foot">才職CARE ｜ 運営コンソール（Uniboost）</div>
</div></body></html>`;
}

// 社長向けテキストサマリー
export function reportToText(rep) {
  if (!rep.total) return "対象期間の相談はまだありません。";
  const top = rep.byTopic
    .slice(0, 3)
    .map((t) => `${t.name}（${t.pct}%）`)
    .join("、");
  const topics = rep.byTopic.slice(0, 5).map((t) => `${t.name}(${t.count})`).join("、");
  return (
    `【組織コンディション・レポート】\n` +
    `相談件数：${rep.total}件（うち緊急対応：${rep.escalations}件）\n` +
    `多い相談テーマ：${top}\n` +
    `テーマ内訳：${topics}\n` +
    `※個別の相談内容は含まれません（匿名集計）。`
  );
}
