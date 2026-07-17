// ============================================================
// AI接続（Claude / Anthropic）
// 相談への返信＋対応区分を、構造化JSONで得る。
// ※ここだけ差し替えれば、別プロバイダにも乗り換え可能。
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from "./prompt.js";
import { KNOWLEDGE_BASE } from "./knowledge.js";
import { DIALOGUE_EXAMPLES } from "./examples.js";

// ANTHROPIC_API_KEY を環境変数から読む。
// maxRetries: Claude混雑時(429/529)に自動リトライ（指数バックオフ）。既定2→4に増やす。
const client = new Anthropic({ maxRetries: 4 });
// 品質重視は claude-opus-4-8。コスト重視なら ANTHROPIC_MODEL=claude-sonnet-4-6
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// 経営レポート用サマリーのスキーマ
const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string", description: "全体所見（2〜3文。社長が30秒で掴める）" },
    findings: { type: "array", items: { type: "string" }, description: "注目点（トレンド・リスク含む。3〜4項目）" },
    recommendations: { type: "array", items: { type: "string" }, description: "経営への提言（2〜3項目・実行可能なもの）" },
  },
  required: ["overview", "findings", "recommendations"],
};

// 匿名集計データから、社長向けの経営レポート要約を生成（個別の相談内容は使わない）
export async function execSummary(payload) {
  const sys =
    "あなたは組織開発の経験豊富なコンサルタントです。以下は、ある企業の相談窓口の【匿名集計データ】（個人が特定される情報・相談の生内容は一切含まれない）です。\n" +
    "これをもとに、その会社の社長向けの経営レポート要約を、日本語で作成してください。\n" +
    "- overview: 全体所見を2〜3文で。数字の羅列ではなく「何が起きているか」を経営目線で。\n" +
    "- findings: 注目点。前月比の増減（trend/delta）やリスク（緊急対応・離職検討の兆候）に触れる。3〜4項目。\n" +
    "- recommendations: 経営が取れる具体的な打ち手を2〜3項目（例：1on1頻度の見直し、マネジメント研修、特定部署の労務確認）。\n" +
    "断定しすぎず、根拠は集計データに基づくこと。個人を推測・特定する記述は禁止。データが少ない場合はその旨を正直に述べる。";
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SUMMARY_SCHEMA },
    },
    system: sys,
    messages: [
      { role: "user", content: "次の匿名集計データから要約を作成:\n" + JSON.stringify(payload) },
    ],
  });
  const t = response.content.find((b) => b.type === "text");
  return JSON.parse(t.text);
}

// 蓄積した相手のプロフィールを、読みやすいテキストに整形
function renderProfile(profile, daysSince, name) {
  if (!profile || typeof profile !== "object") return "";
  const lines = [];
  if (name) lines.push(`呼び名（登録名）: ${name}`);
  if (daysSince != null) lines.push(`前回の相談から約${daysSince}日経過`);
  if (profile.narrative) lines.push(profile.narrative);
  const list = (label, arr) => {
    if (Array.isArray(arr) && arr.length) lines.push(`【${label}】${arr.join(" / ")}`);
  };
  list("継続中の悩み", profile.concerns);
  list("状況・事実", profile.context);
  list("会話で配慮する点", profile.watch_points);
  list("本人の希望", profile.hopes);
  list("次回そっと確認したいこと", profile.follow_ups);
  return lines.join("\n");
}

// history: [{ role: "user"|"assistant", content }]
// opts.criticalHint: 安全キーワード検知
// opts.profile: この相手の蓄積プロフィール(object) / opts.daysSince: 前回からの経過日数 / opts.name: 登録名
export async function consult(history, opts = {}) {
  const { criticalHint = false, profile = null, daysSince = null, name = "" } = opts;

  const messages = [...history];
  if (criticalHint) {
    messages.push({
      role: "user",
      content:
        "[システム注記] 直近の発言に、安全に関わる可能性のある表現が含まれています。相手の安全を最優先に、丁寧に受け止めたうえで、必ず有人・専門窓口への接続を提案し、区分は escalation としてください。",
    });
  }

  // system: ペルソナ＋対話例＋ナレッジ（ここまで prompt caching）＋ 相手のプロフィール（可変）
  const system = [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: DIALOGUE_EXAMPLES },
    { type: "text", text: KNOWLEDGE_BASE, cache_control: { type: "ephemeral" } },
  ];
  const profileText = renderProfile(profile, daysSince, name);
  if (profileText) {
    system.push({
      type: "text",
      text: `# この相手について（過去の相談から蓄積・必ず踏まえる）\n${profileText}`,
    });
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" }, // 安全判定のため、必要に応じてじっくり考える
    output_config: {
      // 危機・要注意ほど深く考える。平常時は応答性優先。
      effort: criticalHint ? "high" : "medium",
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA,
      },
    },
    system,
    messages,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(textBlock.text);

  // 安全側フェイルセーフ：キーワード検知時は必ずエスカレーション扱い
  if (criticalHint) {
    parsed.escalate = true;
    parsed.category = "escalation";
    parsed.risk_level = Math.max(parsed.risk_level ?? 0, 3);
  }
  return parsed;
}
