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
  .pctcell{width:64px;text-align:right;color:#667;font-size:13px}
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
    <div class="card"><div class="n">${rep.byTopic.length}</div><div class="l">相談テーマ数</div></div>
  </div>
  <div class="summary">${summaryHtml}</div>
  <section>
    <h2>相談テーマの傾向（どんな相談が多いか）</h2>
    <table>${topicRows || '<tr><td class="note">データがありません</td></tr>'}</table>
  </section>
  <section>
    <h2>対応区分の内訳</h2>
    <table>${catRows || '<tr><td class="note">データがありません</td></tr>'}</table>
  </section>
  ${
    rep.byDepartment && rep.byDepartment.length
      ? `<section>
    <h2>部署別の相談件数</h2>
    <table>${rep.byDepartment
      .map(
        (dp) => `<tr><td>${he(dp.name)}</td><td class="num">${dp.count}</td>
        <td class="barcell"><div class="bar"><div class="fill" style="width:${dp.pct}%"></div></div><span class="pct">${dp.pct}%</span></td></tr>`
      )
      .join("")}</table>
  </section>`
      : ""
  }
  <p class="note">※本レポートは匿名で集計した組織全体の傾向です。個別の相談内容・個人が特定される情報は一切含まれません。<br>提供：才職CARE（Uniboost）</p>
  <div class="foot">才職CARE ｜ 社外相談窓口サービス</div>
</div></body></html>`;
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
