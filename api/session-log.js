// ============================================================
// メンター稼働記録フォーム（運営＝Uniboost社内専用・マスタトークン保護）
//  GET  /api/session-log?token=MASTER            → 入力フォーム
//  POST 同URL                                    → 単価表で金額を自動計算して保存
// 「誰が・いつ・何分・どの優先度で対応したか」を記録すると、請求(/api/billing)へ自動反映。
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { priceSession, SESSION_TYPES, yen } from "../lib/billing.js";
import { listCompanies } from "../lib/tenant.js";

const REPORT_TOKEN = process.env.REPORT_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function monthStartOf(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  const token = req.query?.token || req.body?.token || "";
  const isMaster = REPORT_TOKEN && token === REPORT_TOKEN;
  if (!isMaster) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send("Unauthorized（運営マスタートークンが必要です）");
  }

  const companies = await listCompanies();

  if (req.method === "POST") {
    const b = req.body || {};
    const errors = [];
    const companyId = Number(b.company_id);
    if (!companyId) errors.push("企業を選択してください");
    if (!SESSION_TYPES.includes(b.session_type)) errors.push("種別を選択してください");
    const minutes = Number(b.minutes) || 0;
    const priority = ["低", "中", "高"].includes(b.priority) ? b.priority : null;
    const occurredOn = (b.occurred_on || todayStr()).slice(0, 10);
    const manual = b.amount === "" || b.amount == null ? null : Number(b.amount);
    // 面談・チャットは時間から自動計算。レポート/研修/その他は金額入力が必要。
    if (["レポート", "研修", "その他"].includes(b.session_type) && (manual == null || Number.isNaN(manual)))
      errors.push("この種別は「金額（都度見積もり）」を入力してください");
    if (["面談", "チャット"].includes(b.session_type) && minutes <= 0)
      errors.push("対応時間（分）を入力してください");

    if (errors.length) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(formPage(token, companies, b, errors));
    }

    const amount = priceSession(b.session_type, minutes, priority, manual);
    const row = {
      company_id: companyId,
      mentor_name: (b.mentor_name || "").trim().slice(0, 100) || null,
      session_type: b.session_type,
      minutes,
      priority,
      occurred_on: occurredOn,
      billing_month: monthStartOf(occurredOn),
      amount,
      note: (b.note || "").trim().slice(0, 300) || null,
    };
    let saveErr = null;
    if (supabase) {
      const { error } = await supabase.from("mentor_sessions").insert(row);
      if (error) saveErr = error.message;
    } else {
      saveErr = "Supabase未接続";
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (saveErr) return res.status(500).send(page("保存に失敗しました", `<div class="err">${esc(saveErr)}</div><p><a href="/api/session-log?token=${esc(token)}">← フォームに戻る</a></p>`));
    const companyName = companies.find((c) => c.id === companyId)?.name || "";
    return res.status(200).send(
      page(
        "記録しました ✅",
        `<p><b>${esc(companyName)}</b> / ${esc(row.mentor_name || "(メンター未設定)")}<br>
         ${esc(row.session_type)}　${row.minutes}分　優先度:${esc(row.priority || "-")}</p>
         <p class="amt">算出金額：<b>${yen(amount)}</b></p>
         <p class="muted">単価表を元に自動計算し、${esc(row.billing_month.slice(0,7))} 分の請求に反映しました。</p>
         <div class="row">
           <a class="btn" href="/api/session-log?token=${esc(token)}">＋ 続けて記録する</a>
           <a class="btn2" href="/api/billing?token=${esc(token)}&company_id=${companyId}&month=${esc(row.billing_month.slice(0,7))}">この会社の請求を見る →</a>
         </div>`
      )
    );
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(formPage(token, companies, { occurred_on: todayStr() }, []));
}

function formPage(token, companies, v = {}, errors = []) {
  const err = errors.length
    ? `<div class="err">${errors.map((e) => `・${esc(e)}`).join("<br>")}</div>`
    : "";
  const compOpts = companies
    .map((c) => `<option value="${c.id}" ${Number(v.company_id) === c.id ? "selected" : ""}>${esc(c.name)}</option>`)
    .join("");
  const typeOpts = SESSION_TYPES.map(
    (t) => `<option value="${esc(t)}" ${v.session_type === t ? "selected" : ""}>${esc(t)}</option>`
  ).join("");
  const prioOpts = ["", "低", "中", "高"]
    .map((p) => `<option value="${esc(p)}" ${v.priority === p ? "selected" : ""}>${p === "" ? "（任意）" : esc(p)}</option>`)
    .join("");

  const body = `
  <p class="lead">メンターが対応した記録を残すと、<b>単価表を元に自動で金額を計算</b>し、請求に反映します。</p>
  ${err}
  <form method="POST" action="/api/session-log?token=${esc(token)}">
    <input type="hidden" name="token" value="${esc(token)}">
    <label>企業 <span class="req">必須</span>
      <select name="company_id" required><option value="">選択してください</option>${compOpts}</select>
    </label>
    <label>メンター名
      <input name="mentor_name" maxlength="100" value="${esc(v.mentor_name || "")}" placeholder="岡本 希実 など">
    </label>
    <label>種別 <span class="req">必須</span>
      <select name="session_type" required>${typeOpts}</select>
      <span class="hint">面談＝時間刻みで自動／チャット＝15分単位×優先度単価で自動／レポート・研修・その他＝金額入力</span>
    </label>
    <div class="two">
      <label>対応時間（分）
        <input name="minutes" type="number" min="0" value="${esc(v.minutes || "")}" placeholder="60">
      </label>
      <label>優先度
        <select name="priority">${prioOpts}</select>
      </label>
    </div>
    <label>対応日 <span class="req">必須</span>
      <input name="occurred_on" type="date" required value="${esc(v.occurred_on || "")}">
    </label>
    <label>金額（都度見積もりの種別のみ）
      <input name="amount" type="number" min="0" value="${esc(v.amount || "")}" placeholder="レポート/研修/その他はここに金額（円）">
      <span class="hint">面談・チャットは空欄でOK（自動計算）。入力すると常にその金額で上書きします。</span>
    </label>
    <label>備考
      <input name="note" maxlength="300" value="${esc(v.note || "")}" placeholder="※個人名は書かない運用">
    </label>
    <button type="submit">この内容で記録する</button>
  </form>
  <p class="muted"><a href="/api/billing?token=${esc(token)}">← 請求一覧へ戻る</a></p>`;
  return page("メンター稼働の記録（運営）", body);
}

function page(title, body) {
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,'Hiragino Sans',sans-serif;margin:0;background:#f4f5f7;color:#222}
  .wrap{max-width:520px;margin:0 auto;padding:20px 16px 48px}
  h1{font-size:20px;margin:8px 0 4px} .lead{color:#555;font-size:14px;line-height:1.7}
  form{display:flex;flex-direction:column;gap:14px;margin-top:8px}
  label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
  input,select{font-size:16px;padding:12px;border:1px solid #ccc;border-radius:10px;background:#fff}
  .two{display:flex;gap:12px} .two label{flex:1}
  .req{color:#c0392b;font-size:11px;font-weight:600}
  .hint{color:#888;font-size:12px;font-weight:400}
  button{margin-top:6px;padding:14px;font-size:16px;font-weight:700;color:#fff;background:#0e7a4b;border:0;border-radius:12px}
  .err{background:#fdecea;color:#b02a1e;border:1px solid #f5c6c0;border-radius:10px;padding:12px;font-size:14px;line-height:1.7}
  .muted{color:#888;font-size:13px} p{font-size:15px;line-height:1.8}
  .amt{font-size:18px} .amt b{color:#0e7a4b}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
  .btn,.btn2{display:inline-block;padding:12px 16px;border-radius:10px;text-decoration:none;font-weight:700}
  .btn{background:#0e7a4b;color:#fff} .btn2{background:#eef4fb;color:#2f6fb0}
</style></head><body><div class="wrap"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}
