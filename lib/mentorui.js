// ============================================================
// メンター選択のFlex UI（Lステップ相当のリッチなカード・カルーセル）
// 顔写真URLがあれば写真、無ければ「頭文字＋アクセントカラー」の丸アイコン。
// ============================================================

const CHIP_BG = "#EEF3F8";
const CHIP_FG = "#2F6FB0";

const initial = (name) => (name || "?").trim().charAt(0) || "?";

// 特徴タグを小さなチップ（最大3つ）で横並び
function tagChips(tags = []) {
  const chips = (tags || []).slice(0, 3).map((t) => ({
    type: "box",
    layout: "vertical",
    backgroundColor: CHIP_BG,
    cornerRadius: "12px",
    paddingAll: "6px",
    paddingStart: "10px",
    paddingEnd: "10px",
    flex: 0,
    contents: [{ type: "text", text: String(t), size: "xs", color: CHIP_FG, weight: "bold" }],
  }));
  if (!chips.length) return { type: "filler" };
  return { type: "box", layout: "horizontal", spacing: "sm", margin: "md", contents: chips };
}

// アバター（写真 or 頭文字の丸）
function avatar(m) {
  const accent = m.accent_color || "#2F6FB0";
  if (m.avatar_url) {
    return {
      type: "image",
      url: m.avatar_url,
      size: "full",
      aspectMode: "cover",
      aspectRatio: "1:1",
    };
  }
  return {
    type: "box",
    layout: "vertical",
    width: "60px",
    height: "60px",
    backgroundColor: accent,
    cornerRadius: "30px",
    justifyContent: "center",
    contents: [
      { type: "text", text: initial(m.display_name), color: "#FFFFFF", size: "xxl", weight: "bold", align: "center" },
    ],
  };
}

function mentorBubble(m, { urgent = false } = {}) {
  const accent = m.accent_color || "#2F6FB0";
  const badge = urgent
    ? { type: "text", text: "🟢 今すぐ相談OK", size: "xs", color: "#1F9D55", weight: "bold", margin: "xs" }
    : { type: "text", text: "匿名で本音を相談できます", size: "xs", color: "#8894A3", margin: "xs" };

  const body = [
    // ヘッダー：アバター＋名前＋ステータス
    {
      type: "box",
      layout: "horizontal",
      spacing: "md",
      contents: [
        avatar(m),
        {
          type: "box",
          layout: "vertical",
          justifyContent: "center",
          flex: 1,
          contents: [
            { type: "text", text: m.display_name || "メンター", weight: "bold", size: "lg", wrap: true, color: "#1C2430" },
            badge,
          ],
        },
      ],
    },
    { type: "separator", margin: "md" },
    tagChips(m.tags),
  ];
  if (m.industries) {
    body.push({ type: "text", text: "経験業界： " + m.industries, size: "xxs", color: "#99A3B0", wrap: true, margin: "md" });
  }
  if (m.tagline) {
    body.push({ type: "text", text: m.tagline, size: "sm", color: "#333333", wrap: true, margin: "sm" });
  }

  return {
    type: "bubble",
    size: "mega",
    body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "18px", contents: body },
    footer: {
      type: "box",
      layout: "vertical",
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
