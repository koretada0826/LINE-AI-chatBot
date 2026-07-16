// ============================================================
// AI接続（Claude / Anthropic）
// 相談への返信＋対応区分を、構造化JSONで得る。
// ※ここだけ差し替えれば、別プロバイダにも乗り換え可能。
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from "./prompt.js";
import { KNOWLEDGE_BASE } from "./knowledge.js";
import { DIALOGUE_EXAMPLES } from "./examples.js";

const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読む
// 品質重視は claude-opus-4-8。コスト重視なら ANTHROPIC_MODEL=claude-sonnet-4-6
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// history: [{ role: "user"|"assistant", content }]
// opts.criticalHint: 安全キーワード検知
// opts.userMemory: この相手の長期メモ
export async function consult(history, opts = {}) {
  const { criticalHint = false, userMemory = "" } = opts;

  const messages = [...history];
  if (criticalHint) {
    messages.push({
      role: "user",
      content:
        "[システム注記] 直近の発言に、安全に関わる可能性のある表現が含まれています。相手の安全を最優先に、丁寧に受け止めたうえで、必ず有人・専門窓口への接続を提案し、区分は escalation としてください。",
    });
  }

  // system: ペルソナ＋対話例＋ナレッジ（ここまで prompt caching）＋ 相手の長期メモ（可変）
  const system = [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: DIALOGUE_EXAMPLES },
    { type: "text", text: KNOWLEDGE_BASE, cache_control: { type: "ephemeral" } },
  ];
  if (userMemory) {
    system.push({
      type: "text",
      text: `# この相手の長期メモ（過去の相談から蓄積・必ず踏まえる）\n${userMemory}`,
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
        name: "consultation_result",
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
