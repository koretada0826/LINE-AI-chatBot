// ============================================================
// メンター選択のFlex UI（Lステップ相当の"目立つ"リッチカード・カルーセル）
// ・カード上部にアクセントカラーのヘッダー帯（白抜き名前＋白丸アバター）
// ・特徴タグはカラーチップ、経験業界、一言メッセージ、色付き大ボタン
// ・avatar_url があれば丸型写真、無ければ「頭文字」円アイコン
// ============================================================

const initial = (name) => (name || "?").trim().charAt(0) || "?";

// 特徴タグを小さなチップ（最大3つ）で横並び。文字色はカードのアクセントカラー。
function tagChips(tags = [], accent = "#2F6FB0") {
  const chips = (tags || []).slice(0, 3).map((t) => ({
    type: "box",
    layout: "vertical",
    backgroundColor: "#F2F4F7",
    cornerRadius: "14px",
    paddingTop: "5px",
    paddingBottom: "5px",
    paddingStart: "12px",
    paddingEnd: "12px",
    flex: 0,
    contents: [{ type: "text", text: String(t), size: "xs", color: accent, weight: "bold" }],
  }));
  if (!chips.length) return { type: "filler" };
  return { type: "box", layout: "horizontal", spacing: "sm", contents: chips };
}

// アバター（白丸に頭文字 or 丸型写真）。色ヘッダー帯の上で映えるように白背景。
function avatar(m) {
  const accent = m.accent_color || "#2F6FB0";
  const inner = m.avatar_url
    ? { type: "image", url: m.avatar_url, size: "full", aspectMode: "cover", aspectRatio: "1:1" }
    : { type: "text", text: initial(m.display_name), color: accent, size: "xxl", weight: "bold", align: "center", gravity: "center" };
  return {
    type: "box",
    layout: "vertical",
    width: "64px",
    height: "64px",
    backgroundColor: "#FFFFFF",
    cornerRadius: "32px",
    justifyContent: "center",
    contents: [inner],
  };
}

function mentorBubble(m, { urgent = false } = {}) {
  const accent = m.accent_color || "#2F6FB0";
  const badge = urgent ? "🟢 今すぐ相談OK" : "🔒 匿名で本音を相談できます";

  const body = [tagChips(m.tags, accent)];
  if (m.industries) {
    body.push({ type: "text", text: "経験業界", size: "xxs", color: "#AAB2BD", weight: "bold", margin: "md" });
    body.push({ type: "text", text: m.industries, size: "xs", color: "#66707B", wrap: true });
  }
  if (m.tagline) {
    body.push({ type: "text", text: m.tagline, size: "sm", color: "#333333", wrap: true, margin: "md" });
  }

  return {
    type: "bubble",
    size: "mega",
    // 目立つ：アクセントカラーのヘッダー帯
    header: {
      type: "box",
      layout: "horizontal",
      backgroundColor: accent,
      paddingAll: "20px",
      spacing: "md",
      contents: [
        avatar(m),
        {
          type: "box",
          layout: "vertical",
          justifyContent: "center",
          flex: 1,
          contents: [
            { type: "text", text: m.display_name || "メンター", color: "#FFFFFF", weight: "bold", size: "xl", wrap: true },
            { type: "text", text: badge, color: "#EAF2FB", size: "xs", margin: "sm", wrap: true },
          ],
        },
      ],
    },
    body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "18px", contents: body },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      paddingTop: "none",
      contents: [
        {
          type: "button",
          style: "primary",
          color: accent,
          height: "md",
          action: {
            type: "postback",
            label: "💬 この人に相談する",
            data: "mentor:" + m.id,
            displayText: (m.display_name || "メンター") + "さんに相談したい",
          },
        },
      ],
    },
  };
}

// メンターのカルーセル（横スワイプ）
export function mentorCarousel(mentors, { urgent = false } = {}) {
  const bubbles = (mentors || []).slice(0, 10).map((m) => mentorBubble(m, { urgent }));
  return {
    type: "flex",
    altText: urgent ? "今すぐ相談できるメンター" : "あなたの相談メンター",
    contents: { type: "carousel", contents: bubbles },
  };
}
