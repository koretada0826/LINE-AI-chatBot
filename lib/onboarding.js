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

// 登録フォームを"目立たせる"Flexカード（トーク内に大きなボタンが残り、消えない）
function formFlex(uid, { companyCode = "", heading, lines = [], note = "" }) {
  const bodyContents = [
    { type: "text", text: heading, weight: "bold", size: "lg", wrap: true, color: "#0e2a47" },
  ];
  for (const l of lines) {
    bodyContents.push({ type: "text", text: l, wrap: true, size: "sm", color: "#555555" });
  }
  const footerContents = [
    {
      type: "button",
      style: "primary",
      color: "#06C755",
      height: "md",
      action: { type: "uri", label: "📝 登録フォームを開く", uri: formUrl(uid, companyCode) },
    },
  ];
  if (note) {
    footerContents.push({
      type: "text",
      text: note,
      wrap: true,
      size: "xxs",
      color: "#999999",
      align: "center",
      margin: "sm",
    });
  }
  return {
    type: "flex",
    altText: `${heading}｜登録フォームはこちら`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: bodyContents },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: footerContents },
    },
  };
}

// 企業番号のあと：残り（氏名・役職・電話・メール）をフォームで一括入力に誘導。
// フォームを使わずテキストで答えても進めるよう、onboarding_step は "name" のまま。
function afterCompanyMessage(uid, company) {
  return formFlex(uid, {
    companyCode: company.invite_code,
    heading: `「${company.name}」ですね😊`,
    lines: [
      "ありがとうございます。",
      "残りの登録（氏名・役職・電話・メール）は、下のボタンから1画面でまとめてお願いします。",
      "（企業番号は入力済みです）",
    ],
    note: "フォームが使えないときは、このまま順番にお答えいただいてもOK。まずはお名前から。",
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
        formFlex(userId, {
          heading: "はじめまして😊",
          lines: [
            "来てくださって、ありがとうございます。",
            "ご相談の前に、かんたんな登録をお願いします（1分ほど）。",
            "上司や人事に伝わることはないので、安心してくださいね。",
          ],
          note: "フォームが使えない場合は、会社から配布された「企業番号」をこのまま送信してもOKです。",
        }),
      ],
      registered: false,
    };
  }

  const step = emp.onboarding_step || "company";
  const isPostback = event.type === "postback";
  const text = isPostback ? "" : clean(event.message?.text);
  const postbackData = isPostback ? event.postback?.data : "";

  // 会社選択（postbackで company:{id} を受ける）
  if (postbackData.startsWith("company:")) {
    const companyId = Number(postbackData.split(":")[1]);
    const company = await getCompany(companyId);
    if (!company) {
      return { messages: [msg("会社の選択に失敗しました。もう一度、会社名を入力してください。")], registered: false };
    }
    await upsertEmployee(userId, { company_id: companyId, onboarding_step: "name" });
    return {
      messages: [afterCompanyMessage(userId, company)],
      registered: false,
    };
  }
  if (postbackData.startsWith("concern:")) {
    // 企業番号（会社特定）が無いまま登録完了にはしない
    if (!emp.company_id) return needCompany(userId);
    const val = postbackData.split(":")[1];
    await upsertEmployee(userId, {
      concern_category: val === "skip" ? null : val,
      onboarding_step: "done",
      registered: true,
    });
    return { messages: [doneMessage()], registered: true };
  }

  switch (step) {
    case "company": {
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
      await upsertEmployee(userId, { company_id: company.id, onboarding_step: "name" });
      return {
        messages: [afterCompanyMessage(userId, company)],
        registered: false,
      };
    }
    case "name": {
      if (!text) return { messages: [msg("お名前（氏名）を教えてください。")], registered: false };
      await upsertEmployee(userId, { name: text, onboarding_step: "role" });
      return { messages: [msg("ありがとうございます。役職を教えてください。（例：一般社員／主任／部長 など）")], registered: false };
    }
    case "role": {
      if (!text) return { messages: [msg("役職を教えてください。（例：一般社員 など）")], registered: false };
      await upsertEmployee(userId, { role_title: text, onboarding_step: "phone" });
      return { messages: [msg("電話番号を教えてください。（例：090-1234-5678）")], registered: false };
    }
    case "phone": {
      if (!PHONE_RE.test(text)) {
        return { messages: [msg("電話番号の形式が正しくないようです。数字とハイフンで、もう一度入力してください（例：090-1234-5678）。")], registered: false };
      }
      await upsertEmployee(userId, { phone: text, onboarding_step: "email" });
      return { messages: [msg("メールアドレスを教えてください。")], registered: false };
    }
    case "email": {
      if (!EMAIL_RE.test(text)) {
        return { messages: [msg("メールアドレスの形式が正しくないようです。もう一度入力してください。")], registered: false };
      }
      await upsertEmployee(userId, { email: text, onboarding_step: "concern" });
      return {
        messages: [
          msg(
            "最後に、今いちばん気になっていることに近いものはありますか？（任意・スキップOK）",
            [
              { label: "人間関係", data: "concern:人間関係" },
              { label: "キャリア", data: "concern:キャリア" },
              { label: "メンタル・体調", data: "concern:メンタル" },
              { label: "労働環境・待遇", data: "concern:労働環境" },
              { label: "その他", data: "concern:その他" },
              { label: "スキップ", data: "concern:skip" },
            ]
          ),
        ],
        registered: false,
      };
    }
    case "concern": {
      // 企業番号（会社特定）が無いまま登録完了にはしない
      if (!emp.company_id) return needCompany(userId);
      // ボタンではなくテキストで来た場合も受ける
      await upsertEmployee(userId, {
        concern_category: text || null,
        onboarding_step: "done",
        registered: true,
      });
      return { messages: [doneMessage()], registered: true };
    }
    default:
      // 想定外の状態：勝手に登録完了にせず、必ず企業番号入力からやり直す（企業番号は必須）
      return needCompany(userId);
  }
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
      "登録が完了しました🎉 ありがとうございます。\nここは、仕事のモヤモヤやしんどさを社外の相手にこっそり話せる場所です。上司や人事に伝わることはないので、安心してくださいね。\nどんなことでも、話しかけてください。",
  };
}
