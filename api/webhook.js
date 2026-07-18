// ============================================================
// 才職CARE LINE AI相談ボット — Webhook 本体
// 流れ：署名検証 → イベント処理 → 会話履歴読込 → 安全ガード →
//       Claude で一次対応＋区分判定 → LINE返信 → 履歴/ログ保存 → 必要ならエスカレーション通知
// ============================================================
import { verifySignature, replyText, replyMessages, pushMessages } from "../lib/line.js";
import { consult } from "../lib/ai.js";
import { detectCritical } from "../lib/safety.js";
import {
  getHistory,
  appendTurn,
  logConsultation,
  getUserProfile,
  saveUserProfile,
  logCoverageGap,
  logEscalation,
  setHumanMode,
  isHumanMode,
} from "../lib/store.js";
import { sendOperatorAlert } from "../lib/notify.js";
import { getEmployee } from "../lib/tenant.js";
import { handleOnboarding, isRegistered } from "../lib/onboarding.js";
import { getCompanyMentors, getMentor } from "../lib/mentors.js";
import { mentorCarousel, mentorWelcome } from "../lib/mentorui.js";

// 登録完了（チャット経由）直後に、メンター紹介カードをプッシュする
async function maybePushMentorsAfterRegister(userId, r) {
  if (!r?.registered) return;
  try {
    const emp = await getEmployee(userId);
    const mentors = await getCompanyMentors(emp?.company_id);
    const msgs = mentorWelcome(mentors);
    if (msgs.length) await pushMessages(userId, msgs);
  } catch (e) {
    console.error("mentor welcome push error:", e.message);
  }
}

// 有人テイクオーバー（緊急時にBotが引いて人が対応するモード）を使うか
const ENABLE_HUMAN_TAKEOVER = process.env.ENABLE_HUMAN_TAKEOVER === "true";
// つらいときの公的窓口（保留メッセージにも添える）
const HOTLINE =
  "つらいときは、よりそいホットライン 0120-279-338（24時間・無料）。差し迫って危険なときは119番も。";

// 署名検証のため生のリクエストボディが必要。Vercelの自動パースを止める。
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// エスカレーションを運営へ通知（Slack + LINE 複数チャンネルへ）
async function notifyEscalation(userId, result, lastUserText) {
  const msg =
    `🚨【緊急】相談者を人につないでください\n` +
    `リスク: ${result.risk_level}（区分: ${result.category}）\n` +
    `テーマ: ${result.topic}\n` +
    `要約: ${result.summary}\n` +
    `直近の発言: ${lastUserText}\n` +
    `対象ユーザーID: ${userId}\n` +
    (ENABLE_HUMAN_TAKEOVER
      ? `→ Botは一時停止中。LINE公式アカウントの「チャット」からこの方に直接対応してください。`
      : `→ この方へ電話/LINEで折り返し対応してください。`);
  await sendOperatorAlert(msg);
}

// AIの選択肢＋常設「人と話したい」を、LINEクイックリプライとして返信メッセージに付ける
function withQuickReplies(text, suggested = []) {
  const items = [];
  for (const label of (suggested || []).slice(0, 4)) {
    const s = String(label || "").trim().slice(0, 20);
    if (s) items.push({ type: "action", action: { type: "message", label: s, text: s } });
  }
  // 常に有人接続の入口を添える（要件5-2：能動的に人へ切り替えられるように）
  // 「人と話したい」＝落ち着いて相談 ／「今すぐ相談したい」＝緊急性の高い即時
  items.push({
    type: "action",
    action: {
      type: "postback",
      label: "🗣️ 人と話したい",
      data: "want_human",
      displayText: "人と話したい",
    },
  });
  items.push({
    type: "action",
    action: {
      type: "postback",
      label: "⚡ 今すぐ相談したい",
      data: "want_now",
      displayText: "今すぐ相談したい",
    },
  });
  return { type: "text", text, quickReply: { items: items.slice(0, 13) } };
}

// メンター一覧を出す（人と話したい／今すぐ相談）。繋ぎ先は後で接続（今は表示＋運営通知のスタブ）。
async function showMentors(event, employee, { urgent }) {
  const companyId = employee?.company_id ?? null;
  const mentors = await getCompanyMentors(companyId);
  if (!mentors.length) {
    // メンター未設定の会社：スタブ対応（担当へ通知）
    await replyText(
      event.replyToken,
      urgent
        ? "今すぐ相談のご希望、承りました🤝\n担当より順番におつなぎしますので、少しお待ちくださいね。\n（お急ぎで危険を感じるときは、よりそいホットライン 0120-279-338 も24時間）"
        : "担当のメンターにおつなぎします🤝\n少しだけお待ちくださいね。"
    );
    await sendOperatorAlert(
      `🙋 ${urgent ? "【今すぐ相談】" : "有人相談ご希望"}（会社にメンター未設定）\n会社ID: ${companyId ?? "-"} / 氏名: ${employee?.name || "-"}\nユーザーID: ${event.source?.userId}`
    );
    return;
  }
  const intro = urgent
    ? {
        type: "text",
        text: "⚡ 今すぐ話せるメンターです。\n気になる人の「💬 この人に相談する」を押してくださいね。",
      }
    : {
        type: "text",
        text:
          "あなたの会社のメンターです😊\nどなたにも、上司や人事に知られず匿名で本音を相談できます。\n気になる人の「💬 この人に相談する」を押してください。",
      };
  await replyMessages(event.replyToken, [intro, mentorCarousel(mentors, { urgent })]);
}

// メンターが選ばれたとき（繋ぎ先は後で接続。今は受付＋運営通知のスタブ）
async function handleMentorPick(event, employee, mentorId) {
  const m = await getMentor(mentorId);
  const name = m?.display_name || "担当メンター";
  await replyText(
    event.replyToken,
    `${name}さんですね😊 ありがとうございます。\n相談の準備を進めますね。担当より順番にご連絡しますので、少しお待ちください。\n（メンターとのやり取りの接続は、ただいま準備中です）`
  );
  await sendOperatorAlert(
    `🙋 メンター指名: ${name}（id:${mentorId}）\n会社ID: ${employee?.company_id ?? "-"} / 氏名: ${employee?.name || "-"}\nユーザーID: ${event.source?.userId}\n→ このメンターへの接続をお願いします。`
  );
}

async function handleTextMessage(event, employee) {
  const userId = event.source?.userId;
  const userText = event.message.text;
  const companyId = employee?.company_id ?? null; // 会社ごとに分離

  // 0) 有人テイクオーバー中なら、Botは前に出ず、人へ引き継ぐ（放置回避に保留メッセージだけ返す）
  if (ENABLE_HUMAN_TAKEOVER && (await isHumanMode(userId))) {
    await replyText(
      event.replyToken,
      `いま、担当者におつなぎしています。もう少しだけお待ちくださいね。\n${HOTLINE}`
    );
    await sendOperatorAlert(
      `📩 対応中の相談者から新しいメッセージです（ユーザーID: ${userId}）\n「${userText}」\n→ LINEの「チャット」からご対応ください。`
    );
    return;
  }

  // 1) 会話履歴＋この相手の蓄積プロフィールを読み込み、今回の発言を足す
  const [history, prof] = await Promise.all([
    getHistory(userId),
    getUserProfile(userId),
  ]);
  history.push({ role: "user", content: userText });
  // 前回の相談からの経過日数（「お久しぶりです」等の自然な会話に使う）
  const daysSince = prof.updated_at
    ? Math.floor((Date.now() - Date.parse(prof.updated_at)) / 86400000)
    : null;

  // 2) 決定論的な安全ガード（AI判定と二重チェック）
  const criticalHint = detectCritical(userText);

  // 3) Claude で一次対応＋区分判定（蓄積プロフィールを踏まえる＝どんどん学ぶ）
  let result;
  try {
    result = await consult(history, {
      criticalHint,
      profile: prof.profile,
      daysSince,
      name: employee?.name || "",
    });
  } catch (err) {
    console.error("consult error:", err);
    await replyText(
      event.replyToken,
      "申し訳ありません、いま少し混み合っているようです。少し時間をおいて、もう一度お話しかけてもらえますか。"
    );
    return;
  }

  // 4) ユーザーへ返信（状況に応じた選択肢＋「人と話したい」ボタン付き）
  await replyMessages(event.replyToken, [
    withQuickReplies(result.reply, result.suggested_replies),
  ]);

  // 5) 履歴・ログ・学習を保存（会社IDで分離・集計）
  await appendTurn(userId, "user", userText, companyId);
  await appendTurn(userId, "assistant", result.reply, companyId);
  await logConsultation(userId, result, companyId);
  // 継続学習：相手のプロフィールを積み上げ更新し、ナレッジの穴を記録する
  await saveUserProfile(userId, result.profile_update);
  await logCoverageGap(userId, result);

  // 6) 緊急なら「人へつなぐ」：記録＋運営へアラート（＋設定時は有人へ引き継ぎ）
  if (result.escalate) {
    await logEscalation(userId, result, companyId);
    await notifyEscalation(userId, result, userText);
    if (ENABLE_HUMAN_TAKEOVER) {
      await setHumanMode(userId); // 以降しばらくBotは前に出ず、人が対応
    }
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("OK: 才職CARE AI相談ボットは稼働中です");
  }
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await getRawBody(req);

  // 署名検証（改ざん・なりすまし防止）。相談は機微情報のため必須。
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(rawBody, signature)) {
    return res.status(401).send("Invalid signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send("Bad Request");
  }

  const events = body.events ?? [];
  await Promise.all(
    events.map(async (event) => {
      try {
        const userId = event.source?.userId;

        // 友だち追加（初回）→ 登録フローを開始
        if (event.type === "follow") {
          const r = await handleOnboarding(userId, event);
          await replyMessages(event.replyToken, r.messages);
          return;
        }

        // postback（会社選択・悩みカテゴリの選択）→ 登録フロー／登録済みは有人接続希望
        if (event.type === "postback") {
          const emp = await getEmployee(userId);
          if (!isRegistered(emp)) {
            const r = await handleOnboarding(userId, event);
            await replyMessages(event.replyToken, r.messages);
            await maybePushMentorsAfterRegister(userId, r);
            return;
          }
          const data = event.postback?.data || "";
          if (data === "want_human") {
            await showMentors(event, emp, { urgent: false });
          } else if (data === "want_now") {
            await showMentors(event, emp, { urgent: true });
          } else if (data.startsWith("mentor:")) {
            await handleMentorPick(event, emp, Number(data.split(":")[1]));
          }
          return;
        }

        if (event.type === "message") {
          const emp = await getEmployee(userId);

          // ★未登録 → 登録が終わるまで相談機能はロック（オンボーディングへ）
          if (!isRegistered(emp)) {
            if (event.message?.type === "text") {
              const r = await handleOnboarding(userId, event);
              await replyMessages(event.replyToken, r.messages);
              await maybePushMentorsAfterRegister(userId, r);
            } else {
              await replyText(
                event.replyToken,
                "登録を進めています。お手数ですが、テキストで入力してくださいね。"
              );
            }
            return;
          }

          // 登録済み → AI相談（会社IDで分離）
          if (event.message?.type === "text") {
            await handleTextMessage(event, emp);
            return;
          }
          // 非テキスト
          await replyText(
            event.replyToken,
            "メッセージありがとうございます😊 いまはテキストでのご相談を受けています。よかったら、言葉で聞かせてもらえますか？"
          );
        }
      } catch (err) {
        console.error("event handling error:", err);
      }
    })
  );

  return res.status(200).end();
}
