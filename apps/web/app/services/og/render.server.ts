// Share-card renderer for Workers: satori (layout → SVG) + resvg (SVG → PNG).
// Wasm comes in as compiled modules (Workers can't compile wasm from bytes at runtime) and the
// fonts are bundled, so a render never depends on another network fetch.
import satori, { init as initSatori } from "satori/wasm";
import initYoga from "yoga-wasm-web";
import { Resvg, initWasm as initResvg } from "@resvg/resvg-wasm";
import yogaWasm from "yoga-wasm-web/dist/yoga.wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import latin500 from "./fonts/inter-latin-500.woff.bin";
import latin600 from "./fonts/inter-latin-600.woff.bin";
import latin800 from "./fonts/inter-latin-800.woff.bin";
import ext500 from "./fonts/inter-latin-ext-500.woff.bin";
import ext600 from "./fonts/inter-latin-ext-600.woff.bin";
import ext800 from "./fonts/inter-latin-ext-800.woff.bin";
import { OgCard, OG_HEIGHT, OG_WIDTH, type OgCardInput } from "./card";

let ready: Promise<void> | undefined;

function setup(): Promise<void> {
  ready ??= (async () => {
    initSatori(await initYoga(yogaWasm));
    await initResvg(resvgWasm);
  })().catch((error) => {
    ready = undefined; // let the next request try again
    throw error;
  });
  return ready;
}

// Latin-ext glyphs (ő, ł, …) need their own family name: satori keeps one font per name+weight.
const FONTS = [
  { name: "Inter", data: latin500, weight: 500 as const },
  { name: "Inter", data: latin600, weight: 600 as const },
  { name: "Inter", data: latin800, weight: 800 as const },
  { name: "Inter Ext", data: ext500, weight: 500 as const },
  { name: "Inter Ext", data: ext600, weight: 600 as const },
  { name: "Inter Ext", data: ext800, weight: 800 as const },
].map((font) => ({ ...font, style: "normal" as const }));

/** Card → PNG bytes. Throws on failure (the caller decides the fallback). */
export async function renderOgPng(input: OgCardInput): Promise<Uint8Array> {
  await setup();
  const svg = await satori(OgCard(input), { width: OG_WIDTH, height: OG_HEIGHT, fonts: FONTS });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: OG_WIDTH } });
  try {
    const png = resvg.render();
    try {
      return png.asPng();
    } finally {
      png.free();
    }
  } finally {
    resvg.free();
  }
}
