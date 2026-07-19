// ============================================================
// メンター選択 & 緊急相談のFlex UI（Lステップ相当・より豪華に）
// ・メンターに相談（急ぎでない）＝会社の3名から選ぶカルーセル
// ・今すぐ相談（緊急・死にたい等）＝別対応（緊急窓口＋運営へ即連携）
// ============================================================

const initial = (name) => (name || "?").trim().charAt(0) || "?";

// 特徴タグを小さなチップ（最大3つ）。文字色はカードのアクセントカラー。
function tagChips(tags = [], accent = "#2F6FB0") {
  const chips = (tags || []).slice(0, 3).map((t) => ({
    type: "box",
    layout: "vertical",
    backgroundColor: "#F2F4F7",
    cornerRadius: "16px",
    paddingTop: "6px",
    paddingBottom: "6px",
    paddingStart: "13px",
    paddingEnd: "13px",
    flex: 0,
    contents: [{ type: "text", text: String(t), size: "xs", color: accent, weight: "bold" }],
  }));
  if (!chips.length) return { type: "filler" };
  return { type: "box", layout: "horizontal", spacing: "sm", contents: chips };
}

// アバター（白リング付きの丸写真 or 頭文字）
function avatar(m) {
  const accent = m.accent_color || "#2F6FB0";
  const inner = m.avatar_url
    ? { type: "image", url: m.avatar_url, size: "full", aspectMode: "cover", aspectRatio: "1:1" }
    : { type: "text", text: initial(m.display_name), color: accent, size: "xxl", weight: "bold", align: "center", gravity: "center" };
  // 白いリングで囲って豪華に
  return {
    type: "box",
    layout: "vertical",
    width: "72px",
    height: "72px",
    backgroundColor: "#FFFFFF",
    cornerRadius: "36px",
    paddingAll: "3px",
    contents: [
      {
        type: "box",
        layout: "vertical",
        cornerRadius: "33px",
        backgroundColor: "#FFFFFF",
        justifyContent: "center",
        contents: [inner],
      },
    ],
  };
}

function mentorBubble(m) {
  const accent = m.accent_color || "#2F6FB0";

  const body = [
    tagChips(m.tags, accent),
  ];
  if (m.industries) {
    body.push({ type: "text", text: "経験業界", size: "xxs", color: "#AAB2BD", weight: "bold", margin: "lg" });
    body.push({ type: "text", text: m.industries, size: "xs", color: "#66707B", wrap: true });
  }
  if (m.tagline) {
    // 一言メッセージは引用調の淡いボックスで上品に
    body.push({
      type: "box",
      layout: "vertical",
      backgroundColor: "#F7F8FA",
      cornerRadius: "12px",
      paddingAll: "13px",
      margin: "lg",
      contents: [{ type: "text", text: "“" + m.tagline + "”", size: "sm", color: "#444444", wrap: true }],
    });
  }

  return {
    type: "bubble",
    size: "mega",
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
            { type: "text", text: "キャリアパートナー", color: "#EAF2FB", size: "xxs", weight: "bold" },
            { type: "text", text: m.display_name || "メンター", color: "#FFFFFF", weight: "bold", size: "xl", wrap: true, margin: "xs" },
            { type: "text", text: "🔒 匿名で本音を相談できます", color: "#EAF2FB", size: "xs", margin: "sm", wrap: true },
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
          // Spir予約URLがあれば予約ページを開く。無ければ受付(postback)にフォールバック。
          action: m.booking_url
            ? { type: "uri", label: "💬 この人に相談する", uri: m.booking_url }
            : {
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

// メンターのカルーセル（横スワイプ）＝「メンターに相談」（急ぎでない）
export function mentorCarousel(mentors) {
  const bubbles = (mentors || []).slice(0, 10).map((m) => mentorBubble(m));
  return {
    type: "flex",
    altText: "あなたの相談メンター",
    contents: { type: "carousel", contents: bubbles },
  };
}

// どの場面からも、チャット/メンター/今すぐ/終える に行き来できる統一ナビ
// （「今すぐ相談を押してもメンターやチャットに戻れる」を保証する）
export function navQuickReply() {
  return {
    items: [
      { type: "action", action: { type: "postback", label: "💬 チャットで相談", data: "chat_consult", displayText: "チャットで相談したい" } },
      { type: "action", action: { type: "postback", label: "🗣️ メンターに相談", data: "want_human", displayText: "メンターに相談" } },
      { type: "action", action: { type: "postback", label: "🚨 今すぐ相談", data: "want_now", displayText: "今すぐ相談" } },
      { type: "action", action: { type: "postback", label: "✅ 会話を終える", data: "end_chat", displayText: "会話を終える" } },
    ],
  };
}
// 後方互換（同じ統一ナビを返す）
export const humanQuickReply = navQuickReply;
export const chatReturnQuickReply = navQuickReply;

// 登録直後などに出す「メンター紹介＋カルーセル」メッセージ配列
export function mentorWelcome(mentors) {
  if (!mentors || !mentors.length) return [];
  const carousel = mentorCarousel(mentors);
  carousel.quickReply = humanQuickReply();
  return [
    {
      type: "text",
      text:
        "こちらが、あなたの会社のメンターです😊\n" +
        "どなたにも、上司や人事に知られず匿名で本音を相談できます。\n" +
        "気になる人がいたら「💬 この人に相談する」を押してくださいね。",
    },
    carousel,
  ];
}

// 今すぐ相談（緊急）＝メンターとは別。緊急窓口＋運営への即連携を案内する。
export function emergencyFlex() {
  const RED = "#D64550";
  return {
    type: "flex",
    altText: "今すぐ相談（緊急）",
    // カードの後も行き止まりにしない（チャット/メンター/今すぐ/終える へ行き来できる）
    quickReply: navQuickReply(),
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: RED,
        paddingAll: "20px",
        contents: [
          { type: "text", text: "🚨 今すぐ相談", color: "#FFFFFF", weight: "bold", size: "xl" },
          { type: "text", text: "ひとりで抱えないで。すぐに専門の担当がお話を聞きます。", color: "#FFECEC", size: "sm", wrap: true, margin: "sm" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "18px",
        contents: [
          { type: "text", text: "つらい気持ちや、命に関わるような不安があるときは、今すぐ下記へ。電話が難しいときは、このままここで話してくれても大丈夫です。", size: "sm", color: "#333333", wrap: true },
          { type: "button", style: "primary", color: RED, height: "md", margin: "md", action: { type: "uri", label: "📞 よりそいホットライン", uri: "tel:0120279338" } },
          { type: "text", text: "24時間・通話無料でつながります", size: "xxs", color: "#8894A3", align: "center" },
          { type: "button", style: "secondary", height: "md", margin: "md", action: { type: "uri", label: "📞 いのちの電話", uri: "tel:0120783556" } },
          { type: "text", text: "フリーダイヤル（受付時間は時期により異なります）", size: "xxs", color: "#8894A3", align: "center" },
          { type: "button", style: "link", height: "sm", margin: "md", action: { type: "postback", label: "運営（社外）に今すぐつないでもらう", data: "urgent_connect", displayText: "今すぐ運営につないでほしい" } },
          { type: "text", text: "※命に関わる差し迫った危険があるときは、迷わず 119 / 110 へ。", size: "xxs", color: "#999999", wrap: true, margin: "md" },
        ],
      },
    },
  };
}
