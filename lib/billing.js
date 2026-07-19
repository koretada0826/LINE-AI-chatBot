// ============================================================
// 請求（課金）集計：Notion単価表の3階建てを会社ごとに算出
//   ① 月額基本料 50,000円/月       … 固定
//   ② 社員従量   500円/人・月       … 登録済み社員数 × 500（自動）
//   ③ セッション従量               … billing_items の明細を合算（面談・レポート等）
// 個別の相談内容や個人名は一切扱わない。金額計算のみ。
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Notion単価表のデフォルト単価（会社ごとに companies.billing_config で上書き可）
export const DEFAULTS = {
  BASE_MONTHLY: 50000, // 月額基本料（No.3）
  PER_EMPLOYEE: 500, // 社員従量（No.4）
};
// 優先度別の時間単価（No.10 チャット稼働などの時間換算）
export const HOURLY_RATE = { 低: 3000, 中: 5000, 高: 10000 };

export const SESSION_TYPES = ["面談", "チャット", "レポート", "研修", "その他"];

export const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");

// 単価表ルールで1セッションの金額を自動算出。
//  面談（個別面談セッション No.5）: 対応時間の刻みで固定
//    10分以下=1,000 / 15分以下=2,500 / 60分以下=6,000 / 60分超=10,000（上限）
//  チャット（No.10）: 15分単位に切上げ → 時間 × 優先度別単価（低3,000/中5,000/高10,000）
//  レポート/研修/その他: 都度見積もり → 手入力金額を使う
// manualAmount が渡された場合は常にそれを優先（手入力上書き）。
export function priceSession(type, minutes, priority, manualAmount = null) {
  if (manualAmount != null && manualAmount !== "" && !Number.isNaN(Number(manualAmount))) {
    return Math.round(Number(manualAmount));
  }
  const m = Number(minutes) || 0;
  if (type === "面談") {
    if (m <= 10) return 1000;
    if (m <= 15) return 2500;
    if (m <= 60) return 6000;
    return 10000;
  }
  if (type === "チャット") {
    const rate = HOURLY_RATE[priority] ?? HOURLY_RATE["中"];
    const billedMin = Math.ceil(m / 15) * 15; // 15分単位に切上げ
    return Math.round((billedMin / 60) * rate);
  }
  return 0; // レポート/研修/その他は手入力（都度見積もり）
}

// 対象月（YYYY-MM）→ 月初日ISO。未指定なら当月。
function monthStart(month) {
  const [y, m] = (month || "").split("-").map(Number);
  const d = y && m ? new Date(Date.UTC(y, m - 1, 1)) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// 会社ごとの「登録済み・在籍」社員数を数える（②の算出元）
async function headcountByCompany() {
  const m = {};
  if (!supabase) return m;
  const { data, error } = await supabase
    .from("employees")
    .select("company_id, registered, status");
  if (error) {
    console.error("headcountByCompany error:", error.message);
    return m;
  }
  for (const e of data || []) {
    if (e.registered && (e.status ?? "active") === "active" && e.company_id != null) {
      m[e.company_id] = (m[e.company_id] || 0) + 1;
    }
  }
  return m;
}

// 1社ぶんの請求を算出。month="YYYY-MM"（未指定=当月）。
export async function computeBilling(company, month, headcount = null) {
  const cfg = company?.billing_config || {};
  const base = Number(cfg.base_monthly ?? DEFAULTS.BASE_MONTHLY);
  const per = Number(cfg.per_employee ?? DEFAULTS.PER_EMPLOYEE);
  const monthISO = monthStart(month);

  // ② 社員従量
  let hc = headcount;
  if (hc == null) {
    const all = await headcountByCompany();
    hc = all[company.id] || 0;
  }
  const employeeAmount = hc * per;

  // ③ セッション従量（当月ぶんの明細）
  let items = [];
  if (supabase) {
    const { data, error } = await supabase
      .from("billing_items")
      .select("menu, qty, unit_price, amount, priority, note")
      .eq("company_id", company.id)
      .eq("billing_month", monthISO)
      .order("id");
    if (error) console.error("billing_items error:", error.message);
    else items = data || [];
  }
  const itemsTotal = items.reduce(
    (s, it) => s + Number(it.amount ?? it.qty * it.unit_price),
    0
  );

  // ③-b メンター稼働（誰が何時間対応したか）→ 単価表で算出済みの amount を合算
  let sessions = [];
  if (supabase) {
    const { data, error } = await supabase
      .from("mentor_sessions")
      .select("mentor_name, session_type, minutes, priority, occurred_on, amount, note")
      .eq("company_id", company.id)
      .eq("billing_month", monthISO)
      .order("occurred_on");
    if (error) console.error("mentor_sessions error:", error.message);
    else sessions = data || [];
  }
  const sessionsTotal = sessions.reduce((s, x) => s + Number(x.amount || 0), 0);

  // メンター別の稼働サマリー（誰が・何件・合計何分・いくら）
  const bySummary = {};
  for (const s of sessions) {
    const key = s.mentor_name || "(未設定)";
    const cur = bySummary[key] || { mentor: key, count: 0, minutes: 0, amount: 0 };
    cur.count += 1;
    cur.minutes += Number(s.minutes || 0);
    cur.amount += Number(s.amount || 0);
    bySummary[key] = cur;
  }
  const mentorSummary = Object.values(bySummary).sort((a, b) => b.amount - a.amount);

  const usageTotal = itemsTotal + sessionsTotal; // ③従量合計（手入力明細＋メンター稼働）
  const fixedTotal = base + employeeAmount; // ①+②（毎月ほぼ自動で決まる部分）
  const total = fixedTotal + usageTotal; // 当月の合計請求額

  return {
    companyId: company.id,
    companyName: company.name || "",
    month: monthISO.slice(0, 7),
    base,
    perEmployee: per,
    headcount: hc,
    employeeAmount,
    items,
    itemsTotal,
    sessions,
    sessionsTotal,
    mentorSummary,
    usageTotal,
    fixedTotal,
    total,
  };
}

// 全社ぶんをまとめて算出（運営ダッシュボード用）
export async function computeAllBilling(companies, month) {
  const hc = await headcountByCompany();
  const rows = [];
  for (const c of companies) {
    rows.push(await computeBilling(c, month, hc[c.id] || 0));
  }
  return rows;
}

// ============================================================
// 表示（HTML）
// ============================================================
const he = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const STYLE = `
  *{box-sizing:border-box} body{font-family:-apple-system,'Hiragino Sans',sans-serif;margin:0;background:#f4f5f7;color:#1c2430}
  .wrap{max-width:820px;margin:0 auto;padding:24px 18px 60px}
  .head{background:#0e2a47;color:#fff;border-radius:16px;padding:22px 20px}
  .head h1{font-size:18px;margin:0 0 6px} .head .sub{opacity:.85;font-size:13px}
  section{background:#fff;border-radius:14px;padding:16px 18px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h2{font-size:15px;margin:0 0 12px;color:#0e2a47}
  table{width:100%;border-collapse:collapse}
  th{font-size:12px;color:#8894a3;text-align:left;padding:6px 4px;border-bottom:2px solid #eef1f4;font-weight:700}
  td{padding:10px 4px;font-size:14px;border-bottom:1px solid #eef1f4;vertical-align:middle}
  th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
  .total td{font-weight:800;font-size:16px;border-top:2px solid #0e2a47;border-bottom:none;padding-top:12px}
  .co b{font-size:14.5px} .co .code{display:block;font-size:11px;color:#98a3b0;margin-top:2px}
  .act a{color:#2f6fb0;text-decoration:none;font-weight:600;font-size:13px}
  .muted{color:#98a3b0}
  .filters{margin:0 0 10px;font-size:13px}
  .note{color:#8894a3;font-size:12px;line-height:1.7;margin-top:8px}
  .foot{color:#98a3b0;font-size:12px;text-align:center;margin-top:20px}
  .pill{display:inline-block;font-size:11px;font-weight:700;color:#2f6fb0;background:#eef4fb;border-radius:20px;padding:3px 10px;margin-left:6px}
`;

// 1社ぶんの請求書ビュー
export function billingToHtml(b, backHref = "") {
  const itemRows = b.items.length
    ? b.items
        .map(
          (it) => `<tr>
        <td>${he(it.menu)}${it.priority ? `<span class="pill">${he(it.priority)}</span>` : ""}${
            it.note ? `<div class="muted" style="font-size:12px">${he(it.note)}</div>` : ""
          }</td>
        <td class="num">${it.qty}</td>
        <td class="num">${yen(it.unit_price)}</td>
        <td class="num">${yen(it.amount ?? it.qty * it.unit_price)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="muted">当月のセッション従量（面談・レポート等）はありません</td></tr>`;

  // メンター稼働の明細（誰が・いつ・何分・いくら）
  const sessionRows = (b.sessions || []).length
    ? b.sessions
        .map(
          (s) => `<tr>
        <td>${he(s.occurred_on || "")}</td>
        <td>${he(s.mentor_name || "(未設定)")}</td>
        <td>${he(s.session_type)}${s.priority ? `<span class="pill">${he(s.priority)}</span>` : ""}${
            s.note ? `<div class="muted" style="font-size:12px">${he(s.note)}</div>` : ""
          }</td>
        <td class="num">${s.minutes}分</td>
        <td class="num">${yen(s.amount)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">当月のメンター稼働記録はありません</td></tr>`;

  // メンター別サマリー（誰が何時間対応したか）
  const summaryRows = (b.mentorSummary || []).length
    ? b.mentorSummary
        .map(
          (m) => `<tr>
        <td>${he(m.mentor)}</td>
        <td class="num">${m.count}件</td>
        <td class="num">${(m.minutes / 60).toFixed(1)}h（${m.minutes}分）</td>
        <td class="num">${yen(m.amount)}</td>
      </tr>`
        )
        .join("")
    : "";

  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>請求サマリー ｜ ${he(b.companyName)}</title><style>${STYLE}</style></head><body><div class="wrap">
  <div class="head"><h1>請求サマリー</h1>
    <div class="sub">${he(b.companyName)}　対象月：${he(b.month)}</div></div>
  <section>
    <h2>① 固定（毎月自動で決まる部分）</h2>
    <table>
      <thead><tr><th>項目</th><th class="num">数量</th><th class="num">単価</th><th class="num">金額</th></tr></thead>
      <tbody>
        <tr><td>月額基本料</td><td class="num">1</td><td class="num">${yen(b.base)}</td><td class="num">${yen(b.base)}</td></tr>
        <tr><td>社員従量（登録社員数 × 単価）</td><td class="num">${b.headcount}</td><td class="num">${yen(b.perEmployee)}</td><td class="num">${yen(b.employeeAmount)}</td></tr>
        <tr class="total"><td>固定小計</td><td></td><td></td><td class="num">${yen(b.fixedTotal)}</td></tr>
      </tbody>
    </table>
  </section>
  ${
    summaryRows
      ? `<section>
    <h2>👥 メンター別 稼働サマリー（誰が何時間対応したか）</h2>
    <table>
      <thead><tr><th>メンター</th><th class="num">件数</th><th class="num">対応時間</th><th class="num">金額</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
  </section>`
      : ""
  }
  <section>
    <h2>② メンター稼働（単価表で自動算出）</h2>
    <table>
      <thead><tr><th>日付</th><th>メンター</th><th>種別</th><th class="num">時間</th><th class="num">金額</th></tr></thead>
      <tbody>${sessionRows}
        <tr class="total"><td colspan="4">メンター稼働 小計</td><td class="num">${yen(b.sessionsTotal)}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h2>③ その他セッション従量（手入力の明細）</h2>
    <table>
      <thead><tr><th>メニュー</th><th class="num">数量</th><th class="num">単価</th><th class="num">金額</th></tr></thead>
      <tbody>${itemRows}
        <tr class="total"><td>手入力 小計</td><td></td><td></td><td class="num">${yen(b.itemsTotal)}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <table><tbody>
      <tr><td>従量合計（②＋③）</td><td class="num">${yen(b.usageTotal)}</td></tr>
      <tr class="total"><td>当月 合計請求額（①固定＋従量）</td><td class="num">${yen(b.total)}</td></tr>
    </tbody></table>
  </section>
  <p class="note">※固定部分は登録社員数から自動算出（月額基本料＋社員数×単価）。<br>メンター稼働は単価表ルールで自動計算（面談＝時間刻み、チャット＝15分単位×優先度別時間単価）。<br>初期費用（社長・人事インタビュー等）は導入時1回のため、この月次請求には含みません。</p>
  ${backHref ? `<p class="act"><a href="${backHref}">← 一覧に戻る</a></p>` : ""}
  <div class="foot">才職CARE ｜ 請求（Uniboost社内）</div>
</div></body></html>`;
}

// 全社の請求一覧（運営）
export function billingAdminHtml(rows, month, masterToken = "") {
  const tk = encodeURIComponent(masterToken);
  const monthParam = month ? `&month=${encodeURIComponent(month)}` : "";
  const sumFixed = rows.reduce((s, r) => s + r.fixedTotal, 0);
  const sumUsage = rows.reduce((s, r) => s + (r.usageTotal ?? r.itemsTotal), 0);
  const sumTotal = rows.reduce((s, r) => s + r.total, 0);
  const sumHead = rows.reduce((s, r) => s + r.headcount, 0);
  const sorted = [...rows].sort((a, b) => b.total - a.total);

  const body = sorted
    .map(
      (r) => `<tr>
      <td class="co"><b>${he(r.companyName || "(無名)")}</b></td>
      <td class="num">${r.headcount}</td>
      <td class="num">${yen(r.fixedTotal)}</td>
      <td class="num">${yen(r.usageTotal ?? r.itemsTotal)}</td>
      <td class="num"><b>${yen(r.total)}</b></td>
      <td class="act"><a href="/api/billing?token=${tk}&company_id=${r.companyId}${monthParam}">明細 →</a></td>
    </tr>`
    )
    .join("");

  const label = rows[0]?.month || month || "当月";
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>請求一覧（運営） ｜ 才職CARE</title><style>${STYLE}</style></head><body><div class="wrap">
  <div class="head"><h1>請求一覧（運営）</h1>
    <div class="sub">全 ${rows.length} 社　対象月：${he(label)}</div></div>
  <section>
    <div class="filters">
      <a class="act" href="/api/report?token=${tk}">← 運営ダッシュボードへ</a>
      <span style="margin:0 8px;color:#cfd6de">｜</span>
      <a href="/api/session-log?token=${tk}" style="display:inline-block;padding:6px 12px;border-radius:20px;background:#0e7a4b;color:#fff;text-decoration:none;font-weight:600">＋ メンター稼働を記録</a>
    </div>
    <table>
      <thead><tr><th>企業</th><th class="num">社員数</th><th class="num">固定</th><th class="num">従量</th><th class="num">合計</th><th></th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">企業がありません</td></tr>'}
        <tr class="total"><td>全社合計</td><td class="num">${sumHead}</td><td class="num">${yen(sumFixed)}</td><td class="num">${yen(sumUsage)}</td><td class="num">${yen(sumTotal)}</td><td></td></tr>
      </tbody>
    </table>
  </section>
  <p class="note">※固定＝月額基本料＋登録社員数×単価（自動）。従量＝当月のメンター稼働（単価表で自動算出）＋手入力明細の合算。<br>「＋ メンター稼働を記録」から、誰が・何分・どの優先度で対応したかを登録すると、単価表を元に自動で請求へ反映されます。初期費用は月次に含みません。</p>
  <div class="foot">才職CARE ｜ 運営コンソール（Uniboost）</div>
</div></body></html>`;
}
