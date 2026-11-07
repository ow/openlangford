import type { Route } from "./+types/how-council-works";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { GLOSSARY, GLOSSARY_PATH } from "../lib/glossary";
import { ogImageUrl, ogUrl } from "../lib/og";

const TITLE = "How council works";
const DESCRIPTION = "What readings, motions, carried, in camera and other council words mean, in plain language.";

export const meta: Route.MetaFunction = () => [
  { title: `${TITLE} | Open Langford` },
  { name: "description", content: DESCRIPTION },
  { property: "og:title", content: `${TITLE} | Open Langford` },
  { property: "og:description", content: DESCRIPTION },
  { property: "og:type", content: "website" },
  { property: "og:url", content: ogUrl(GLOSSARY_PATH) },
  { property: "og:image", content: ogImageUrl(TITLE, { subtitle: "Council words, explained" }) },
  { property: "og:image:width", content: "1200" },
  { property: "og:image:height", content: "630" },
  { name: "twitter:card", content: "summary_large_image" },
];

export default function HowCouncilWorks() {
  return (
    <div className="min-h-screen bg-zinc-50 pb-20">
      <div className="bg-zinc-900 px-4 py-16 text-white">
        <div className="container mx-auto max-w-3xl">
          <Link to="/about" className="mb-6 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> About Open Langford
          </Link>
          <h1 className="mb-4 text-4xl font-black tracking-tight md:text-5xl">{TITLE}</h1>
          <p className="max-w-2xl text-lg leading-relaxed text-zinc-400">
            Council minutes use words with exact meanings. This page says what they mean and how this site puts them
            in plain language.
          </p>
        </div>
      </div>

      <div className="container mx-auto max-w-3xl px-4">
        <nav aria-label="Sections" className="-mt-6 mb-8 flex flex-wrap gap-2">
          {GLOSSARY.groups.map((g) => (
            <a
              key={g.id}
              href={`#${g.id}`}
              className="rounded-full border border-zinc-200 bg-surface px-3 py-1 text-sm font-medium text-zinc-700 shadow-sm hover:border-brand-500 hover:text-brand-700"
            >
              {g.title}
            </a>
          ))}
        </nav>

        {GLOSSARY.groups.map((g) => (
          <section key={g.id} id={g.id} className="mb-10 scroll-mt-24">
            <h2 className="mb-1 text-2xl font-black text-zinc-900">{g.title}</h2>
            {g.intro && <p className="mb-4 text-zinc-600">{g.intro}</p>}
            <dl className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
              {g.terms.map((t) => (
                <div key={t.id} id={t.id} className="scroll-mt-24 px-5 py-4">
                  <dt className="font-bold text-zinc-900">
                    <a href={`#${t.id}`} className="hover:text-brand-700">{t.term}</a>
                  </dt>
                  <dd className="mt-1 text-zinc-700">{t.means}</dd>
                  {t.in_the_record && (
                    <dd className="mt-2 text-sm text-zinc-500">
                      <span className="font-medium text-zinc-600">In the minutes:</span> {t.in_the_record}
                    </dd>
                  )}
                  {t.we_write && (
                    <dd className="mt-1 text-sm text-zinc-500">
                      <span className="font-medium text-zinc-600">On this site:</span> {t.we_write}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </section>
        ))}

        <p className="text-sm text-zinc-500">
          Missing a word, or think one of these is wrong?{" "}
          <Link to="/contact" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
            Let us know
          </Link>
          . The City's{" "}
          <a
            href="https://www.langford.ca"
            className="text-brand-700 underline underline-offset-2 hover:text-brand-800"
            target="_blank"
            rel="noopener noreferrer"
          >
            own records
          </a>{" "}
          are the source of truth.
        </p>
      </div>
    </div>
  );
}
