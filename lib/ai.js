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

// LINEはプレーンテキスト表示。まれにAIが返すHTMLエンティティ(&#39; など)を
// 実際の文字に戻し、文字化けを防ぐ。
export function sanitizeReply(s) {
  if (!s) return s;
  let out = String(s)
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);?/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    // 漏洩したHTMLタグを除去（<br>→改行、その他タグは削除）。LINEはプレーンテキスト。
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    // 制御文字（改行・タブ以外）を除去（NUL等の混入防止）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  // 日本語の返信に紛れた"壊れた短い断片"のみ除去（例: t'd）。
  // 正当な短い英単語(OK/Yes)やURL・R&D等は消さない＝アポストロフィ/実体の残骸を含む断片だけ対象。
  out = out
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // 空行は改行維持のため残す
      if (/[぀-ヿ㐀-鿿＀-￯]/.test(t)) return true; // 日本語を含む行は残す
      const looksBroken = t.length <= 4 && /['’#;]/.test(t) && /^[A-Za-z'’#;.,]+$/.test(t);
      return !looksBroken;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

// 劣化生成（文字化け）検知：日本語の返信として不自然なら true。
// ※誤検知を避けるため、正常な英単語(LINE/AI等)1回程度やURLは通す。
export function isGarbledReply(text) {
  if (!text) return true;
  // バックスラッシュ・Unicode置換文字は、正常な返信本文には出ない
  if (/[\\�]/.test(text)) return true;
  const jp = (text.match(/[ぁ-んァ-ヶー一-龯]/g) || []).length;
  const t = String(text).trim();
  // 実質空・極端に短い返信は、日本語カウンセリングの返答として成立しない
  if (t.length < 2) return true;
  // 残存HTMLタグ/フラグメント（<br>, </p> 等）は劣化・漏洩
  if (/<\s*\/?\s*(br|p|div|span|strong|em|ul|ol|li|table|td|tr|a|h[1-6])\b[^>]*>?/i.test(t)) return true;
  // 日本語がまったく無い返信は異常。例外は「URL単体」だけ許容する。
  // （"br" / "<br>" / "OK" / "..." / "n/a" / 絵文字のみ 等を全部捕捉）
  if (jp === 0 && !/^https?:\/\/\S+$/.test(t)) return true;
  // 日本語はあるが実質ゼロに近い（記号・英字だらけの長文）＝劣化
  if (jp > 0 && jp < 2 && t.length >= 8) return true;
  // ★内部コード・スキーマ用語・思考(reasoning)の漏洩は、reply本文に絶対出てはいけない
  //   （例: 「mentor_normal寄り」「escalationは不要」「I'll pick 人間関係」「reply short」等）
  if (/mentor_normal|mentor_caution|ai_only|admin_broadcast|escalation|suggested[_ ]?repl|risk[_ ]?level|\brisk\s*[0-9]|reply\s+short|end\s*\{|the concern is|i'?ll pick|could be\b/i.test(t))
    return true;
  // 英単語が5語以上＝英語の思考文・分析が混入した劣化（URLは除外。日本語返信に英語は普通ほぼ出ない）
  if ((t.replace(/https?:\/\/\S+/g, "").match(/[A-Za-z]{2,}/g) || []).length >= 5) return true;
  // 日本語に挟まれた孤立ラテン片が2つ以上（1回は許容＝LINE/AI等）
  const isoLatin = (text.match(/[ぁ-んァ-ヶ一-龯][A-Za-z]{1,4}[ぁ-んァ-ヶ一-龯]/g) || []).length;
  if (isoLatin >= 2) return true;
  return false;
}
const SAFE_FALLBACK =
  "ごめんなさい、うまくお返事を作れませんでした。\nもう一度、いまのお気持ちや状況を聞かせてもらえますか？";

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
    "データの意味: themeTrends=相談テーマ別の件数と前期比(delta)＝レポートの主役。handlingBreakdown=社内の対応区分の内訳（参考）。escalations=緊急対応件数。\n" +
    "これをもとに、その会社の社長向けの経営レポート要約を、日本語で作成してください。\n" +
    "- overview: 全体所見を2〜3文で。数字の羅列ではなく「何が起きているか」を経営目線で。\n" +
    "- findings: 注目点。相談テーマ(themeTrends)の多い順・前期比の増減やリスク（緊急対応・離職検討の兆候）に触れる。3〜4項目。\n" +
    "- recommendations: 経営が取れる具体的な打ち手を2〜3項目（例：1on1頻度の見直し、マネジメント研修、特定部署の労務確認）。\n" +
    "重要: 社長向けなので必ず『相談テーマ』の言葉（人間関係・キャリア・労務など）で語り、mentor_normal等の社内コード名は出さないこと。\n" +
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
function renderProfile(profile, daysSince, name, supportStyle) {
  const lines = [];
  if (name) lines.push(`呼び名（登録名）: ${name}`);
  if (daysSince != null) lines.push(`前回の相談から約${daysSince}日経過`);
  if (supportStyle)
    lines.push(`【支援スタイルの好み】${supportStyle}（本人のフィードバックより。必ず尊重する）`);
  if (profile && typeof profile === "object") {
    if (profile.narrative) lines.push(profile.narrative);
    const list = (label, arr) => {
      if (Array.isArray(arr) && arr.length) lines.push(`【${label}】${arr.join(" / ")}`);
    };
    list("継続中の悩み", profile.concerns);
    list("状況・事実", profile.context);
    list("会話で配慮する点", profile.watch_points);
    list("本人の希望", profile.hopes);
    list("次回そっと確認したいこと", profile.follow_ups);
  }
  return lines.join("\n");
}

// history: [{ role: "user"|"assistant", content }]
// opts.criticalHint: 安全キーワード検知
// opts.profile: この相手の蓄積プロフィール(object) / opts.daysSince: 前回からの経過日数 / opts.name: 登録名
export async function consult(history, opts = {}) {
  const { criticalHint = false, profile = null, daysSince = null, name = "", supportStyle = null } = opts;

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
  const profileText = renderProfile(profile, daysSince, name, supportStyle);
  if (profileText) {
    system.push({
      type: "text",
      text: `# この相手について（過去の相談から蓄積・必ず踏まえる）\n${profileText}`,
    });
  }

  // 1回分の生成（parse＋sanitizeまで）。全textブロックを連結して途中欠けを防ぐ。
  const generateOnce = async (effort) => {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 12000, // 既知の正常値に戻す（16000は上限超過で400の懸念があったため）
      thinking: { type: "adaptive" },
      output_config: {
        effort,
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system,
      messages,
    });
    // 途中打ち切りは、不完全JSONならJSON.parseがthrow→catchで再生成に回る。
    // 完成した劣化出力(br等)は isGarbledReply が捕捉するため、ここでは例外化しない
    // （stop_reason===max_tokens で毎回throw→毎回SAFE_FALLBACKになる事故を避ける）。
    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const p = JSON.parse(text);
    p.reply = sanitizeReply(p.reply);
    if (Array.isArray(p.suggested_replies)) p.suggested_replies = p.suggested_replies.map(sanitizeReply);
    return p;
  };

  // 危機・要注意ほど深く考える。平常時は応答性優先。
  const baseEffort = criticalHint ? "high" : "medium";

  // 「壊れている」判定：解析失敗(null)・文字化け・実質空/短すぎ のいずれか。
  const isBad = (p) => !p || isGarbledReply(p.reply);

  // 1回目（途中打ち切り・解析失敗もcatchして握りつぶさない）
  let parsed = null;
  try {
    parsed = await generateOnce(baseEffort);
  } catch (e) {
    console.error("generate error (1st):", e.message);
  }

  // ★劣化生成（文字化け・途中崩壊・空/短すぎ）を検知したら1回だけ再生成。
  //   それでも壊れていれば安全な定型に差し替え、ユーザーには壊れた文を絶対に見せない。
  if (isBad(parsed)) {
    console.error(
      "bad reply detected, regenerating. sample:",
      parsed ? String(parsed.reply).slice(0, 120) : "(no parse)"
    );
    try {
      const retry = await generateOnce(baseEffort);
      parsed = isBad(retry)
        ? { ...(parsed || {}), reply: SAFE_FALLBACK, suggested_replies: [] }
        : retry;
    } catch (e) {
      console.error("regenerate error:", e.message);
      parsed = { ...(parsed || {}), reply: SAFE_FALLBACK, suggested_replies: [] };
    }
  }

  // 安全側フェイルセーフ：キーワード検知時は必ずエスカレーション扱い
  if (criticalHint) {
    parsed.escalate = true;
    parsed.category = "escalation";
    parsed.risk_level = Math.max(parsed.risk_level ?? 0, 3);
  }
  return parsed;
}
