// ============================================================
// 登録フォーム（Webフォーム）
//  GET  /api/register?uid=...&sig=...  → フォーム表示
//  POST 同URL（フォーム送信）          → 検証して社員登録（registered=true）
// 本人のLINE IDは署名付きURLで受け取り、なりすまし登録を防ぐ。
// ============================================================
import { verifyUid } from "../lib/formauth.js";
import { getCompanyByCode, upsertEmployee } from "../lib/tenant.js";
import { pushText } from "../lib/line.js";

const PHONE_RE = /^[0-9+\-() ]{10,15}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export default async function handler(req, res) {
  const uid = req.query?.uid || req.body?.uid;
  const sig = req.query?.sig || req.body?.sig;

  if (!verifyUid(uid, sig)) {
    return html(res, 401, page("リンクが無効です", "<p>お手数ですが、LINEのメッセージから登録フォームをもう一度お開きください。</p>"));
  }

  // 送信処理
  if (req.method === "POST") {
    const b = req.body || {};
    const errors = [];
    if (!b.company_code?.trim()) errors.push("企業番号を入力してください");
    if (!b.name?.trim()) errors.push("氏名を入力してください");
    if (!b.role_title?.trim()) errors.push("役職を入力してください");
    if (!PHONE_RE.test((b.phone || "").trim())) errors.push("電話番号の形式が正しくありません");
    if (!EMAIL_RE.test((b.email || "").trim())) errors.push("メールアドレスの形式が正しくありません");

    let company = null;
    if (b.company_code?.trim()) company = await getCompanyByCode(b.company_code.trim());
    if (b.company_code?.trim() && !company) errors.push("企業番号が正しくありません（会社から配布された番号をご確認ください）");

    if (errors.length) {
      return html(res, 400, formPage(uid, sig, b, errors));
    }

    await upsertEmployee(uid, {
      company_id: company.id,
      name: b.name.trim().slice(0, 100),
      role_title: b.role_title.trim().slice(0, 100),
      phone: b.phone.trim(),
      email: b.email.trim(),
      concern_category: (b.concern_category || "").trim().slice(0, 100) || null,
      onboarding_step: "done",
      registered: true,
    });

    // LINEにも完了通知（フォームを閉じてLINEに戻ると届く）
    try {
      await pushText(
        uid,
        `登録が完了しました🎉 ありがとうございます、${esc(b.name.trim())}さん。\nここは、仕事のモヤモヤやしんどさを社外の相手にこっそり話せる場所です。上司や人事に伝わることはないので、安心してくださいね。\nどんなことでも、話しかけてください。`
      );
    } catch (e) {
      console.error("register push error:", e.message);
    }

    return html(
      res,
      200,
      page(
        "登録が完了しました🎉",
        `<p><b>${esc(company.name)}</b> の一員として登録しました。</p>
         <p>このタブを閉じて、LINEに戻ってご相談ください。<br>いつでも、どんなことでもお話しください。</p>`
      )
    );
  }

  // フォーム表示（チャットで入力済みの企業番号があれば cc で受け取り事前入力）
  const prefill = { company_code: (req.query?.cc || "").toString().trim().slice(0, 20) };
  return html(res, 200, formPage(uid, sig, prefill, []));
}

// ---- HTML ----
function formPage(uid, sig, v = {}, errors = []) {
  const err = errors.length
    ? `<div class="err">${errors.map((e) => `・${esc(e)}`).join("<br>")}</div>`
    : "";
  const concerns = ["", "人間関係", "キャリア", "メンタル・体調", "労働環境・待遇", "その他"];
  const concernOpts = concerns
    .map(
      (c) =>
        `<option value="${esc(c)}" ${v.concern_category === c ? "selected" : ""}>${c === "" ? "（任意・未選択）" : esc(c)}</option>`
    )
    .join("");

  const body = `
  <p class="lead">はじめに、かんたんな登録をお願いします（1分ほど）。<br>この内容が上司や人事に伝わることはありません。</p>
  ${err}
  <form method="POST" action="/api/register">
    <input type="hidden" name="uid" value="${esc(uid)}">
    <input type="hidden" name="sig" value="${esc(sig)}">
    <label>企業番号 <span class="req">必須</span>
      <input name="company_code" required maxlength="20" value="${esc(v.company_code || "")}" placeholder="会社から配布された番号（例：1234）" autocomplete="off">
      <span class="hint">会社から配布された「企業番号」を入力してください</span>
    </label>
    <label>氏名 <span class="req">必須</span>
      <input name="name" required maxlength="100" value="${esc(v.name || "")}" placeholder="山田 太郎">
    </label>
    <label>役職 <span class="req">必須</span>
      <input name="role_title" required maxlength="100" value="${esc(v.role_title || "")}" placeholder="一般社員 / 主任 / 部長 など">
    </label>
    <label>電話番号 <span class="req">必須</span>
      <input name="phone" type="tel" required value="${esc(v.phone || "")}" placeholder="090-1234-5678">
    </label>
    <label>メールアドレス <span class="req">必須</span>
      <input name="email" type="email" required value="${esc(v.email || "")}" placeholder="you@example.com">
    </label>
    <label>今いちばん気になっていること <span class="opt">任意</span>
      <select name="concern_category">${concernOpts}</select>
    </label>
    <button type="submit">登録する</button>
  </form>`;
  return page("才職CARE 登録フォーム", body);
}

function page(title, body) {
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,'Hiragino Sans',sans-serif;margin:0;background:#f4f5f7;color:#222}
  .wrap{max-width:480px;margin:0 auto;padding:20px 16px 48px}
  h1{font-size:20px;margin:8px 0 4px} .lead{color:#555;font-size:14px;line-height:1.7}
  form{display:flex;flex-direction:column;gap:14px;margin-top:8px}
  label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
  input,select{font-size:16px;padding:12px;border:1px solid #ccc;border-radius:10px;background:#fff}
  .req{color:#c0392b;font-size:11px;font-weight:600} .opt{color:#888;font-size:11px;font-weight:600}
  .hint{color:#888;font-size:12px;font-weight:400}
  button{margin-top:6px;padding:14px;font-size:16px;font-weight:700;color:#fff;background:#06c755;border:0;border-radius:12px}
  .err{background:#fdecea;color:#b02a1e;border:1px solid #f5c6c0;border-radius:10px;padding:12px;font-size:14px;line-height:1.7}
  p{font-size:15px;line-height:1.8}
</style></head><body><div class="wrap"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}

function html(res, code, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(code).send(body);
}
