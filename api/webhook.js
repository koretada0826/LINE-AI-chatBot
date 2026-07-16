// ============================================================
// 才職CARE LINE AI相談ボット — Webhook 本体
// 流れ：署名検証 → イベント処理 → 会話履歴読込 → 安全ガード →
//       Claude で一次対応＋区分判定 → LINE返信 → 履歴/ログ保存 → 必要ならエスカレーション通知
// ============================================================
import { verifySignature, replyText } from "../lib/line.js";
import { consult } from "../lib/ai.js";
import { detectCritical } from "../lib/safety.js";
import {
  getHistory,
  appendTurn,
  logConsultation,
  getUserMemory,
  saveUserMemory,
  logCoverageGap,
  logEscalation,
  setHumanMode,
  isHumanMode,
} from "../lib/store.js";
import { sendOperatorAlert } from "../lib/notify.js";

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

async function handleTextMessage(event) {
  const userId = event.source?.userId;
  const userText = event.message.text;

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

  // 1) 会話履歴＋この相手の長期メモを読み込み、今回の発言を足す
  const [history, userMemory] = await Promise.all([
    getHistory(userId),
    getUserMemory(userId),
  ]);
  history.push({ role: "user", content: userText });

  // 2) 決定論的な安全ガード（AI判定と二重チェック）
  const criticalHint = detectCritical(userText);

  // 3) Claude で一次対応＋区分判定（長期メモを踏まえる）
  let result;
  try {
    result = await consult(history, { criticalHint, userMemory });
  } catch (err) {
    console.error("consult error:", err);
    await replyText(
      event.replyToken,
      "申し訳ありません、いま少し混み合っているようです。少し時間をおいて、もう一度お話しかけてもらえますか。"
    );
    return;
  }

  // 4) ユーザーへ返信
  await replyText(event.replyToken, result.reply);

  // 5) 履歴・ログ・学習を保存
  await appendTurn(userId, "user", userText);
  await appendTurn(userId, "assistant", result.reply);
  await logConsultation(userId, result);
  // 継続学習：相手の長期メモを更新し、ナレッジの穴を記録する
  await saveUserMemory(userId, result.memory_update);
  await logCoverageGap(userId, result);

  // 6) 緊急なら「人へつなぐ」：記録＋運営へアラート（＋設定時は有人へ引き継ぎ）
  if (result.escalate) {
    await logEscalation(userId, result);
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
        // 友だち追加（初回）→ 温かいあいさつで相談の入口をひらく
        if (event.type === "follow") {
          await replyText(
            event.replyToken,
            "はじめまして、来てくださってありがとうございます😊\n" +
              "ここは、仕事のモヤモヤやしんどさを、社外の相手にこっそり話せる場所です。上司や人事に伝わることはないので、安心してくださいね。\n" +
              "ちょっとした愚痴でも大丈夫。今日はどんなことが気になっていますか？"
          );
          return;
        }
        // テキストメッセージ → AI相談
        if (event.type === "message" && event.message?.type === "text") {
          await handleTextMessage(event);
          return;
        }
        // スタンプ・画像など非テキスト → やさしくテキストへ誘導
        if (event.type === "message") {
          await replyText(
            event.replyToken,
            "メッセージありがとうございます😊 いまはテキストでのご相談を受けています。よかったら、気になっていることを言葉で聞かせてもらえますか？"
          );
        }
      } catch (err) {
        console.error("event handling error:", err);
      }
    })
  );

  return res.status(200).end();
}
