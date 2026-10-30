// Share card (1200×630) for every page without its own image. Matches the meeting share cards
// (apps/pipeline/pipeline/video/templates/meeting_card.html, no-frame variant): teal gradient,
// faint building mark, logo + label, large title. Satori renders it: every element with more
// than one child must be display:flex, and text is plain children (no HTML parsing, so no
// escaping is needed).
import type { ReactElement } from "react";
import { OG_LABELS, OG_SUBTITLE_MAX, OG_TITLE_MAX, type OgKind } from "../../lib/og";
import { SITE_NAME } from "../../lib/site-name";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const TEAL = "#00747a";
const TEAL_BRIGHT = "#3cc4c9";
const INK = "#f6f8f8";
const INK_SOFT = "rgba(236, 242, 242, 0.84)";
const INK_MUTE = "rgba(214, 226, 226, 0.66)";

export type OgCardInput = {
  title: string;
  subtitle?: string;
  label: string;
  /** data: URI of a portrait (JPEG/PNG). */
  image?: string;
};

function clean(value: string | null | undefined, max: number): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,;:.—–-]+$/, "")}…`;
}

/** Old share URLs (before OG_VERSION 2) used "matter" for decisions and properties. */
const LEGACY_KINDS: Record<string, OgKind> = { matter: "decision" };

/** Query string → card text. Unknown types get no label; text is trimmed to the URL limits. */
export function ogCardInput(params: URLSearchParams): Omit<OgCardInput, "image"> & { imagePath?: string } {
  const rawType = params.get("type") || "default";
  const kind = (LEGACY_KINDS[rawType] || rawType) as OgKind;
  const label = Object.hasOwn(OG_LABELS, kind) ? OG_LABELS[kind] : "";
  const title = clean(params.get("title"), OG_TITLE_MAX) || SITE_NAME;
  const subtitle = clean(params.get("subtitle"), OG_SUBTITLE_MAX) || undefined;
  // Only site portraits: no arbitrary URLs (the Worker would fetch them).
  const image = params.get("image") || "";
  const imagePath = /^\/images\/[a-z0-9/_-]+\.(jpe?g|png)$/i.test(image) && !image.includes("..") ? image : undefined;
  return { title, subtitle, label, imagePath };
}

/** Title size steps down with length so long names still fit in three lines. */
export function titleSize(title: string, narrow: boolean): number {
  const n = title.length;
  if (narrow) return n <= 22 ? 64 : n <= 40 ? 54 : n <= 70 ? 46 : 40;
  return n <= 28 ? 72 : n <= 48 ? 62 : n <= 80 ? 52 : 44;
}

function Logo() {
  return (
    <svg width="38" height="38" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill={TEAL} />
      <g transform="translate(5 5) scale(0.9167)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 12h4" />
        <path d="M10 8h4" />
        <path d="M14 21v-3a2 2 0 0 0-4 0v3" />
        <path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2" />
        <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
      </g>
    </svg>
  );
}

function Mark() {
  return (
    <svg
      width="460"
      height="460"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#7fe3e6"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ position: "absolute", right: -40, top: 85, opacity: 0.09 }}
    >
      <path d="M10 12h4" />
      <path d="M10 8h4" />
      <path d="M14 21v-3a2 2 0 0 0-4 0v3" />
      <path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2" />
      <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
    </svg>
  );
}

export function OgCard({ title, subtitle, label, image }: OgCardInput): ReactElement {
  const narrow = !!image;
  const size = titleSize(title, narrow);
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: OG_WIDTH,
        height: OG_HEIGHT,
        fontFamily: "Inter, Inter Ext",
        color: INK,
        backgroundColor: "#0a1314",
        backgroundImage: "radial-gradient(circle at 100% 0%, #0d5a5e 0%, #0b2426 50%, #0a1314 100%)",
      }}
    >
      {image ? (
        <div
          style={{
            display: "flex",
            position: "absolute",
            right: 72,
            top: 115,
            width: 400,
            height: 400,
            borderRadius: 200,
            padding: 8,
            backgroundColor: "rgba(60, 196, 201, 0.35)",
          }}
        >
          <img src={image} width={384} height={384} style={{ borderRadius: 192, objectFit: "cover" }} />
        </div>
      ) : (
        <Mark />
      )}
      <div style={{ display: "flex", position: "absolute", left: 0, top: 0, bottom: 0, width: 8, backgroundColor: TEAL_BRIGHT }} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: 0,
          top: 0,
          width: OG_WIDTH,
          height: OG_HEIGHT,
          padding: "52px 64px 48px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <Logo />
          <div style={{ display: "flex", marginLeft: 14, fontSize: 25, fontWeight: 800, letterSpacing: -0.3 }}>{SITE_NAME}</div>
          {label ? (
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ display: "flex", width: 1, height: 20, margin: "0 16px", backgroundColor: "rgba(255,255,255,0.28)" }} />
              <div style={{ display: "flex", fontSize: 17, fontWeight: 800, letterSpacing: 2, color: TEAL_BRIGHT, textTransform: "uppercase" }}>{label}</div>
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", maxWidth: narrow ? 600 : 900 }}>
          <div
            style={{
              display: "block",
              fontSize: size,
              fontWeight: 800,
              lineHeight: 1.06,
              letterSpacing: -size * 0.025,
              lineClamp: 3,
            }}
          >
            {title}
          </div>
          {subtitle ? (
            <div
              style={{
                display: "block",
                marginTop: 22,
                fontSize: 27,
                fontWeight: 500,
                lineHeight: 1.32,
                color: INK_SOFT,
                lineClamp: 3,
              }}
            >
              {subtitle}
            </div>
          ) : null}
          <div style={{ display: "flex", marginTop: 30, fontSize: 19, fontWeight: 600, color: INK_MUTE }}>openlangford.ca</div>
        </div>
      </div>
    </div>
  );
}
