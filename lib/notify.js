// ============================================================
// 運営への緊急アラート（Slack + LINE の複数チャンネルへ同時送信）
// 緊急時に「人へ確実につなぐ」ための通知。どれか1つでも設定されていれば飛ぶ。
// ============================================================
import { pushText } from "./line.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
// カンマ区切りで複数指定可（個人のLINEユーザーID または グループID）
const LINE_OPERATORS = (
  process.env.OPERATOR_LINE_USER_IDS ||
  process.env.OPERATOR_LINE_USER_ID ||
  ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export async function sendOperatorAlert(text) {
  const jobs = [];

  // Slack（運営の主チャンネル。最も確実）
  if (SLACK_WEBHOOK_URL) {
    jobs.push(
      fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch((e) => console.error("slack notify error:", e.message))
    );
  }

  // LINE（担当者個人 or 運営グループ）
  for (const to of LINE_OPERATORS) {
    jobs.push(pushText(to, text));
  }

  if (jobs.length === 0) {
    console.warn("[notify] アラート送信先が未設定です（SLACK_WEBHOOK_URL / OPERATOR_LINE_USER_IDS）");
  }
  await Promise.all(jobs);
}
