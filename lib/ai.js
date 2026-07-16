// ============================================================
// AI接続（Gemini / Google AI Studio）
// 相談への返信＋対応区分を、構造化JSONで得る。
// ※ここだけ差し替えれば、後でClaude等の別プロバイダに乗り換え可能。
// ============================================================
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT } from "./prompt.js";
import { KNOWLEDGE_BASE } from "./knowledge.js";
import { DIALOGUE_EXAMPLES } from "./examples.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Geminiの構造化出力スキーマ（型名は大文字）
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    category: {
      type: "STRING",
      enum: [
        "ai_only",
        "mentor_normal",
        "mentor_caution",
        "escalation",
        "admin_broadcast",
        "onboarding",
        "other",
      ],
    },
    risk_level: { type: "INTEGER" }, // 0..3
    escalate: { type: "BOOLEAN" },
    topic: { type: "STRING" },
    summary: { type: "STRING" },
    memory_update: { type: "STRING" },
    coverage_gap: { type: "STRING" },
  },
  required: [
    "reply",
    "category",
    "risk_level",
    "escalate",
    "topic",
    "summary",
    "memory_update",
    "coverage_gap",
  ],
  propertyOrdering: [
    "reply",
    "category",
    "risk_level",
    "escalate",
    "topic",
    "summary",
    "memory_update",
    "coverage_gap",
  ],
};

// history: [{ role: "user"|"assistant", content }]
// opts.criticalHint: 安全キーワード検知
// opts.userMemory: この相手の長期メモ
export async function consult(history, opts = {}) {
  const { criticalHint = false, userMemory = "" } = opts;

  // system命令：ペルソナ＋対話例＋ナレッジ（＋長期メモ／緊急注記）
  let systemInstruction = [SYSTEM_PROMPT, DIALOGUE_EXAMPLES, KNOWLEDGE_BASE].join(
    "\n\n"
  );
  if (userMemory) {
    systemInstruction += `\n\n# この相手の長期メモ（過去の相談から蓄積・必ず踏まえる）\n${userMemory}`;
  }
  if (criticalHint) {
    systemInstruction +=
      "\n\n# 重要な注記\n直近の発言に、安全に関わる可能性のある表現が含まれています。相手の安全を最優先に、丁寧に受け止めたうえで、必ず有人・専門窓口への接続を提案し、区分は escalation としてください。";
  }

  // Geminiの会話形式（assistant→model にマッピング）
  const contents = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }],
  }));

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
    },
  });

  const parsed = JSON.parse(response.text);

  // 安全側フェイルセーフ：キーワード検知時は必ずエスカレーション扱い
  if (criticalHint) {
    parsed.escalate = true;
    parsed.category = "escalation";
    parsed.risk_level = Math.max(parsed.risk_level ?? 0, 3);
  }
  return parsed;
}
