// ============================================================
// オンボーディング（個人登録）の会話ステートマシン
// 登録が完了するまで相談機能は使わせない。会社→氏名→役職→電話→メール→悩みカテゴリ。
// 会社は運営が事前登録したものから選択（検索→ボタン）。
// ============================================================
import { getEmployee, upsertEmployee, getCompanyByCode, getCompany } from "./tenant.js";
import { signUid } from "./formauth.js";

const APP_BASE_URL =
  process.env.APP_BASE_URL || "https://line-ai-chat-bot-eosin.vercel.app";
const formUrl = (uid, companyCode) =>
  `${APP_BASE_URL}/api/register?uid=${encodeURIComponent(uid)}&sig=${signUid(uid)}` +
  (companyCode ? `&cc=${encodeURIComponent(companyCode)}` : "");

// 登録フォームへのリンクを本文に直接埋め込んだテキストメッセージを作る。
// LINEはメッセージ内のURLを自動でタップ可能なリンクにするため、確実に見える・押せる。
function formPrompt(uid, { companyCode = "", heading, lines = [], note = "" }) {
  const url = formUrl(uid, companyCode);
  const body = [heading, ...lines, "", "▼ 登録フォームはこちら（タップで開きます）", url];
  if (note) body.push("", note);
  return { type: "text", text: body.join("\n") };
}

// 企業番号のあと：残り（氏名・役職・電話・メール）は必ず"フォーム"で入力してもらう。
// ★チャットで一問一答はしない（氏名/役職/電話/メールをLINEで聞き返さない）。
function afterCompanyMessage(uid, company) {
  return formPrompt(uid, {
    companyCode: company.invite_code,
    heading: `「${company.name}」ですね😊`,
    lines: [
      "相談の前に、1分ほどで終わる登録フォームにご登録ください。",
    ],
    note: "登録が終わると、そのままLINEでご相談いただけます。",
  });
}

// 入力検証
const PHONE_RE = /^[0-9+\-() ]{10,15}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_LEN = 100;

const clean = (s) => (s || "").trim().slice(0, MAX_LEN);

// テキストメッセージ（＋任意のクイックリプライ）を作る
function msg(text, quickReplies) {
  const m = { type: "text", text };
  if (quickReplies && quickReplies.length) {
    m.quickReply = {
      items: quickReplies.slice(0, 13).map((q) => ({
        type: "action",
        action: {
          type: "postback",
          label: q.label.slice(0, 20),
          data: q.data,
          displayText: q.label.slice(0, 20),
        },
      })),
    };
  }
  return m;
}

// 登録済みか
export function isRegistered(emp) {
  return !!(emp && emp.registered);
}

// オンボーディングを1ステップ進める。
// event: LINEイベント（message.text か postback）
// 返り値: { messages: LINEメッセージ配列, registered: bool }
export async function handleOnboarding(userId, event) {
  let emp = await getEmployee(userId);

  // 初回：レコードを作り、登録フォームのボタンを出す（会話でも登録可）
  if (!emp) {
    emp = await upsertEmployee(userId, { onboarding_step: "company", registered: false });
    return {
      messages: [
        msg(
          "はじめまして😊 来てくださって、ありがとうございます。\n" +
            "ご相談の前に、かんたんな登録をお願いします（1分ほど）。\n" +
            "上司や人事に伝わることはないので、安心してくださいね。\n\n" +
            "まず、初めに企業番号を教えてください。"
        ),
      ],
      registered: false,
    };
  }

  const step = emp.onboarding_step || "company";
  const isPostback = event.type === "postback";
  const text = isPostback ? "" : clean(event.message?.text);
  const postbackData = isPostback ? event.postback?.data : "";

  // 会社選択（postbackで company:{id} を受ける・後方互換）
  if (postbackData.startsWith("company:")) {
    const companyId = Number(postbackData.split(":")[1]);
    const company = await getCompany(companyId);
    if (!company) {
      return { messages: [msg("会社の選択に失敗しました。もう一度、企業番号を入力してください。")], registered: false };
    }
    await upsertEmployee(userId, { company_id: companyId, onboarding_step: "form" });
    return { messages: [afterCompanyMessage(userId, company)], registered: false };
  }

  // ① 企業番号の入力ステップ（会社未特定ならここ）
  if (step === "company" || !emp.company_id) {
    if (!text)
      return { messages: [msg("会社から配布された「企業番号」を入力してください。")], registered: false };
    const company = await getCompanyByCode(text);
    if (!company) {
      return {
        messages: [
          msg(
            "その企業番号が見つかりませんでした🙏\n会社から配布された番号を、もう一度ご確認ください。\n分からない場合は、担当者にお問い合わせください。"
          ),
        ],
        registered: false,
      };
    }
    await upsertEmployee(userId, { company_id: company.id, onboarding_step: "form" });
    return { messages: [afterCompanyMessage(userId, company)], registered: false };
  }

  // ② 企業番号は済み・フォーム未提出：フォームへ誘導するだけ。
  //   ★氏名・役職・電話・メールをチャットで一問一答しない（暴走・ループの原因を排除）。
  //   実際の登録完了は api/register.js（フォーム送信）でのみ行う。
  const company = await getCompany(emp.company_id);
  return {
    messages: [
      formPrompt(userId, {
        companyCode: company?.invite_code || "",
        heading: "ご登録がまだ完了していないようです🙏",
        lines: [
          "お手数ですが、下のフォームから登録をお願いします（1分ほどで終わります）。",
          "登録が終わると、そのままLINEでご相談いただけます。",
        ],
        note: "フォームが開けない・うまくいかないときは、会社のご担当者にお知らせください。",
      }),
    ],
    registered: false,
  };
}

// 企業番号の入力に確実に戻す（企業番号なしでは絶対に登録完了させない）
async function needCompany(userId) {
  await upsertEmployee(userId, { onboarding_step: "company", registered: false });
  return {
    messages: [msg("はじめに、会社から配布された「企業番号」を入力してください。")],
    registered: false,
  };
}

function doneMessage() {
  return {
    type: "text",
    text:
      "登録が完了しました🎉 ありがとうございます。\n" +
      "ここは、仕事のモヤモヤやしんどさを社外の相手にこっそり話せる場所です。上司や人事に伝わることはないので、安心してくださいね。\n" +
      "どんなことでも、話しかけてください。\n\n" +
      "💡 画面下のメニューから、いつでも「メンターに相談」（匿名でじっくり）や「今すぐ相談」（緊急）が使えます。",
  };
}
