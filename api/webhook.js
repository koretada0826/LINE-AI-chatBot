// ============================================================
// 才職CARE LINE AI相談ボット — Webhook 本体
// 流れ：署名検証 → イベント処理 → 会話履歴読込 → 安全ガード →
//       Claude で一次対応＋区分判定 → LINE返信 → 履歴/ログ保存 → 必要ならエスカレーション通知
// ============================================================
import { verifySignature, replyText, replyMessages, pushMessages, showLoading } from "../lib/line.js";
import { consult } from "../lib/ai.js";
import { detectCritical, detectLifeCrisis } from "../lib/safety.js";
import {
  getHistory,
  appendTurn,
  logConsultation,
  getUserProfile,
  saveUserProfile,
  saveFeedback,
  saveFeedbackRating,
  saveFeedbackReason,
  clearPendingFeedback,
  logCoverageGap,
  logEscalation,
  setHumanMode,
  isHumanMode,
} from "../lib/store.js";
import { sendOperatorAlert } from "../lib/notify.js";
import { getEmployee } from "../lib/tenant.js";
import { handleOnboarding, isRegistered } from "../lib/onboarding.js";
import { getCompanyMentors, getMentor } from "../lib/mentors.js";
import { mentorCarousel, mentorWelcome, emergencyFlex, humanQuickReply, chatReturnQuickReply } from "../lib/mentorui.js";

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
    // Bufferで受けてconcat（マルチバイト分割で日本語が壊れ→署名不一致→401再送地獄になるのを防ぐ）
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
  // 常に有人接続の入口を添える
  // 「メンターに相談」＝急ぎでない有人相談 ／「今すぐ相談」＝緊急（別対応）
  items.push({
    type: "action",
    action: {
      type: "postback",
      label: "🗣️ メンターに相談",
      data: "want_human",
      displayText: "メンターに相談",
    },
  });
  items.push({
    type: "action",
    action: {
      type: "postback",
      label: "🚨 今すぐ相談",
      data: "want_now",
      displayText: "今すぐ相談",
    },
  });
  // ①会話後アンケートの入口
  items.push({
    type: "action",
    action: {
      type: "postback",
      label: "✅ 会話を終える",
      data: "end_chat",
      displayText: "会話を終える",
    },
  });
  // LINEテキスト上限(5000字)を超えると送信失敗→無応答になるため安全側で切る
  const safeText = String(text || "").slice(0, 4900);
  return { type: "text", text: safeText, quickReply: { items: items.slice(0, 13) } };
}

// 「メンターに相談」（急ぎでない）＝会社の3名から選ぶカルーセルを表示
async function showMentors(event, employee) {
  const companyId = employee?.company_id ?? null;
  const mentors = await getCompanyMentors(companyId);
  if (!mentors.length) {
    await replyMessages(event.replyToken, [
      {
        type: "text",
        text: "担当のメンターにおつなぎします🤝\n運営（社外の相談窓口）から順番にご連絡しますね。\nそれまでの間、このままチャットでお話しいただいても大丈夫です。",
        quickReply: chatReturnQuickReply(),
      },
    ]);
    await sendOperatorAlert(
      `🙋 メンター相談ご希望（会社にメンター未設定）\n会社ID: ${companyId ?? "-"} / 氏名: ${employee?.name || "-"}\nユーザーID: ${event.source?.userId}`
    );
    return;
  }
  const intro = {
    type: "text",
    text:
      "あなたの会社のメンターです😊\nどなたにも、上司や人事に知られず匿名で本音を相談できます。\n気になる人の「💬 この人に相談する」を押してください。\n\n（このままチャットで相談したいときは、下の「💬 チャットで相談」からどうぞ）",
  };
  const carousel = mentorCarousel(mentors);
  carousel.quickReply = chatReturnQuickReply(); // 見ただけの人がチャットへ戻れる動線
  await replyMessages(event.replyToken, [intro, carousel]);
}

// 「相談する」＝チャット(AI) と メンター(人) の両方を提示
async function showConsultMenu(event) {
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text:
        "ご相談ですね😊 どちらでお話ししますか？\n\n" +
        "💬 このままチャットで、まず私（AI）に話す\n" +
        "🗣️ 担当のメンター（人）に相談する\n\n" +
        "下から選んでくださいね。",
      quickReply: {
        items: [
          { type: "action", action: { type: "postback", label: "💬 チャットで相談", data: "chat_consult", displayText: "チャットで相談したい" } },
          { type: "action", action: { type: "postback", label: "🗣️ メンターに相談", data: "want_human", displayText: "メンターに相談" } },
        ],
      },
    },
  ]);
}

// 「チャットで相談」を選んだとき＝そのままAIが聞く姿勢に入る
async function startChatConsult(event) {
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text:
        "はい、このままお聞きしますね😊\n\n" +
        "この下の入力欄に、いま気になっていることを、そのまま書き込んでみてください。\n" +
        "些細なことでも大丈夫。ゆっくりで大丈夫ですよ。",
      quickReply: humanQuickReply(),
    },
  ]);
}

// ①会話後アンケート：「会話を終える」→ 1〜5で評価してもらう
async function showFeedbackSurvey(event) {
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text:
        "お話しできてよかったです😊 ありがとうございました。\n" +
        "よろしければ、今日のやりとりを1〜5で評価してもらえますか？\n" +
        "（5がとても良い・1があまり良くない）",
      quickReply: {
        items: [
          { type: "action", action: { type: "postback", label: "⭐️1", data: "fb_rate:1", displayText: "1" } },
          { type: "action", action: { type: "postback", label: "⭐️2", data: "fb_rate:2", displayText: "2" } },
          { type: "action", action: { type: "postback", label: "⭐️3", data: "fb_rate:3", displayText: "3" } },
          { type: "action", action: { type: "postback", label: "⭐️4", data: "fb_rate:4", displayText: "4" } },
          { type: "action", action: { type: "postback", label: "⭐️5", data: "fb_rate:5", displayText: "5" } },
          { type: "action", action: { type: "postback", label: "スキップ", data: "fb_skip", displayText: "スキップ" } },
        ],
      },
    },
  ]);
}

// ①評価(1〜5)を保存し、続けて「理由」を自由記述で聞く（次の発言を理由として拾う状態にする）
async function handleFeedbackRating(event, employee, rating) {
  const userId = event.source?.userId;
  await saveFeedbackRating(userId, rating, employee?.company_id ?? null);
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text:
        `${"⭐️".repeat(rating)}（${rating}）ですね。ありがとうございます！\n\n` +
        "差し支えなければ、その評価の理由を、このまま入力して教えてもらえますか？\n" +
        "（良かった点・物足りなかった点など、ひと言でもOK）",
      quickReply: {
        items: [
          { type: "action", action: { type: "postback", label: "理由はスキップ", data: "fb_reason_skip", displayText: "スキップ" } },
        ],
      },
    },
  ]);
}

// ①評価の「理由」を保存（直前の評価に追記）して、待ち状態を解除
async function handleFeedbackReason(event, pending, reasonText) {
  const userId = event.source?.userId;
  await saveFeedbackReason(userId, pending, reasonText);
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text: "教えてくれて、ありがとうございます😊 いただいた声は、これからの改善に活かします。\nまた話したくなったら、いつでもこの下から続けられます。",
      quickReply: humanQuickReply(),
    },
  ]);
}

// 「今すぐ相談」（緊急・死にたい等）＝メンターとは別。緊急窓口＋運営へ即連携。
async function handleUrgent(event, employee) {
  await replyMessages(event.replyToken, [emergencyFlex()]);
  await sendOperatorAlert(
    `🚨【今すぐ相談】緊急ボタンが押されました。至急ご対応ください。\n会社ID: ${employee?.company_id ?? "-"} / 氏名: ${employee?.name || "-"}\nユーザーID: ${event.source?.userId}`
  );
}

// 「運営に今すぐつないで」→ 運営へ最優先の接続要請（待つ間の命綱も必ず残す）
async function handleUrgentConnect(event, employee) {
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text:
        "運営（社外の相談窓口）の担当に、最優先で連絡しました。\n" +
        "日中はできるだけ早く、夜間や休日は順番にご連絡します。\n\n" +
        "もし今、とてもつらいときは、下の「📞 よりそいホットライン（24時間・無料）」に、どうか遠慮なく。\n" +
        "あなたはひとりではありません。",
    },
    emergencyFlex(), // 待つ間も公的窓口へ確実に届く導線を再掲
  ]);
  await sendOperatorAlert(
    `🚨🚨 至急接続要請（「運営に今すぐつないで」）\n会社ID: ${employee?.company_id ?? "-"} / 氏名: ${employee?.name || "-"}\nユーザーID: ${event.source?.userId}\n→ 最優先で対応してください。`
  );
}

// メンターが選ばれたとき（繋ぎ先は後で接続。今は受付＋運営通知）
async function handleMentorPick(event, employee, mentorId) {
  const m = await getMentor(mentorId);
  const name = m?.display_name || "担当";
  await replyMessages(event.replyToken, [
    {
      type: "text",
      text:
        `${name}さんですね😊 ありがとうございます。\n` +
        `運営（社外の相談窓口）から、通常1〜2営業日以内に、このLINEでご連絡します。\n` +
        `それまでの間、このままチャットでお話しいただいても大丈夫ですよ。`,
      quickReply: humanQuickReply(),
    },
  ]);
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

  // 0.5) 「相談する」メニュー（=「相談したいです」）→ チャット/メンターの両方を提示
  if (userText.trim() === "相談したいです") {
    await showConsultMenu(event);
    return;
  }

  // 1) 会話履歴＋この相手の蓄積プロフィールを読み込み、今回の発言を足す
  const [history, prof] = await Promise.all([
    getHistory(userId),
    getUserProfile(userId),
  ]);

  // ①会話後アンケートの「理由」待ち：この発言は相談ではなく"評価の理由"として保存する
  if (prof.pending_feedback) {
    await handleFeedbackReason(event, prof.pending_feedback, userText);
    return;
  }

  history.push({ role: "user", content: userText });
  // 前回の相談からの経過日数（「お久しぶりです」等の自然な会話に使う）
  const daysSince = prof.updated_at
    ? Math.floor((Date.now() - Date.parse(prof.updated_at)) / 86400000)
    : null;

  // 2) 決定論的な安全ガード（AI判定と二重チェック）
  const criticalHint = detectCritical(userText); // 有人へ確実につなぐべき重篤語
  const lifeCrisis = detectLifeCrisis(userText); // 命に関わる＝"命のホットライン"を出してよい場面

  // 3) Claude で一次対応＋区分判定（蓄積プロフィールを踏まえる＝どんどん学ぶ）
  //    生成には数秒かかるため、先に「考え中…」のローディングを表示（返信到着で自動的に消える）
  await showLoading(userId, 20);
  let result;
  try {
    result = await consult(history, {
      criticalHint,
      profile: prof.profile,
      daysSince,
      name: employee?.name || "",
      supportStyle: prof.support_style || null, // ②共感/解決の出し分け
    });
  } catch (err) {
    console.error("consult error:", err);
    // ★フェイルセーフ：AI障害でも「命の危機」は決定論的に公的窓口を提示
    if (lifeCrisis) {
      await replyMessages(event.replyToken, [emergencyFlex()]);
      try {
        await logEscalation(
          userId,
          { category: "escalation", risk_level: 3, topic: "（AI障害時フェイルセーフ）", summary: userText.slice(0, 200) },
          companyId
        );
      } catch (e) {
        console.error("failsafe logEscalation error:", e.message);
      }
      await sendOperatorAlert(
        `🚨【命の危機・AI障害時フェイルセーフ】至急ご対応ください。\nユーザーID: ${userId}\n直近の発言: ${userText}`
      );
    } else if (criticalHint) {
      // 重篤だが命の危機ワードではない（ハラス/暴力/不正等）→ ホットラインは出さず、人へ確実につなぐ
      await replyText(
        event.replyToken,
        "大切なお話、受け止めました。\nいま一時的に応答が不安定なため、担当（運営）に確実に引き継ぎます。少しお待ちくださいね。"
      );
      try {
        await logEscalation(userId, { category: "escalation", risk_level: 2, topic: "（AI障害時フェイルセーフ）", summary: userText.slice(0, 200) }, companyId);
      } catch (e) { console.error("failsafe logEscalation error:", e.message); }
      await sendOperatorAlert(`⚠️【要対応・AI障害時】担当につないでください。\nユーザーID: ${userId}\n直近の発言: ${userText}`);
    } else {
      await replyText(
        event.replyToken,
        "申し訳ありません、いま少し混み合っているようです。少し時間をおいて、もう一度お話しかけてもらえますか。"
      );
    }
    return;
  }

  // 4) ユーザーへ返信（状況に応じた選択肢＋「人と話したい」ボタン付き）
  await replyMessages(event.replyToken, [
    withQuickReplies(result.reply, result.suggested_replies),
  ]);

  // 5) 履歴・ログ・学習を保存（会社IDで分離・集計）
  await appendTurn(userId, "user", userText, companyId);
  await appendTurn(userId, "assistant", result.reply, companyId);
  await logConsultation(userId, result, companyId, employee?.department ?? null);
  // 継続学習：相手のプロフィールを積み上げ更新し、ナレッジの穴を記録する
  await saveUserProfile(userId, result.profile_update);
  await logCoverageGap(userId, result);

  // 6) エスカレーション：記録＋運営へアラート（有人へつなぐ）。※これは裏側の通知で、利用者体験は変えない
  if (result.escalate) {
    await logEscalation(userId, result, companyId);
    await notifyEscalation(userId, result, userText);
    if (ENABLE_HUMAN_TAKEOVER) {
      await setHumanMode(userId); // 以降しばらくBotは前に出ず、人が対応
    }
  }
  // ★"命のホットライン"カードは、命に関わる危機のときだけ提示（パワハラ等では出さない）
  if (lifeCrisis) {
    await pushMessages(userId, [emergencyFlex()]);
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
          const pdata = event.postback?.data || "";
          // ★安全最優先：未登録でも「緊急」だけは即対応（登録に戻さない）
          if (pdata === "want_now") {
            await handleUrgent(event, emp);
            return;
          }
          if (pdata === "urgent_connect") {
            await handleUrgentConnect(event, emp);
            return;
          }
          if (!isRegistered(emp)) {
            const r = await handleOnboarding(userId, event);
            await replyMessages(event.replyToken, r.messages);
            await maybePushMentorsAfterRegister(userId, r);
            return;
          }
          const data = event.postback?.data || "";
          if (data === "consult_menu") {
            await showConsultMenu(event);
          } else if (data === "chat_consult") {
            await startChatConsult(event);
          } else if (data === "want_human") {
            await showMentors(event, emp);
          } else if (data === "want_now") {
            await handleUrgent(event, emp);
          } else if (data === "urgent_connect") {
            await handleUrgentConnect(event, emp);
          } else if (data === "end_chat") {
            await showFeedbackSurvey(event);
          } else if (data.startsWith("fb_rate:")) {
            const r = Number(data.split(":")[1]);
            if (r >= 1 && r <= 5) await handleFeedbackRating(event, emp, r);
          } else if (data === "fb_skip") {
            await replyText(event.replyToken, "ありがとうございました😊 またいつでもどうぞ。");
          } else if (data === "fb_reason_skip") {
            await clearPendingFeedback(event.source?.userId);
            await replyMessages(event.replyToken, [
              { type: "text", text: "ありがとうございました😊 またいつでもどうぞ。", quickReply: humanQuickReply() },
            ]);
          } else if (data.startsWith("mentor:")) {
            const mid = Number(data.split(":")[1]);
            if (Number.isFinite(mid)) {
              await handleMentorPick(event, emp, mid);
            } else {
              await replyText(event.replyToken, "うまく受け取れませんでした🙏 もう一度メニューからお試しください。");
            }
          } else {
            // 未知/古いボタン（旧カード等）を押されたときの無反応を防ぐ
            await replyText(event.replyToken, "うまく受け取れませんでした🙏 下のメニューからもう一度お試しください。");
          }
          return;
        }

        if (event.type === "message") {
          const emp = await getEmployee(userId);

          // ★未登録 → 登録が終わるまで相談機能はロック（オンボーディングへ）
          if (!isRegistered(emp)) {
            // ★安全最優先：登録前でも"命に関わる"発言は見逃さず、公的窓口＋運営通知
            if (event.message?.type === "text" && detectLifeCrisis(event.message.text)) {
              await replyMessages(event.replyToken, [emergencyFlex()]);
              await sendOperatorAlert(
                `🚨【命の危機・未登録ユーザー】至急ご対応ください。\nユーザーID: ${userId}\n発言: ${event.message.text}`
              );
              return;
            }
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
