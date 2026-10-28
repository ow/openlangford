import { useSiteFlags } from "../../lib/use-site-flags";
import { AskQuestion } from "../ask-question";

export function AskSection({ shortName }: { shortName: string }) {
  const { aiSearchAvailable } = useSiteFlags();
  if (!aiSearchAvailable) return null;

  return (
    <section
      aria-labelledby="ask-heading"
      className="light-scope bg-gradient-to-b from-brand-700 to-brand-800 text-white"
    >
      <div className="container mx-auto max-w-4xl px-4 py-12 md:py-16">
        <div className="mb-6 text-center">
          <h2 id="ask-heading" className="text-2xl md:text-3xl font-extrabold tracking-tight mb-2">
            Looking for something else?
          </h2>
          <p className="text-brand-100 text-base max-w-2xl mx-auto">
            Ask about any meeting, decision, or debate. Answers are drawn from
            official records and transcripts.
          </p>
        </div>
        <AskQuestion
          title=""
          placeholder={`Ask anything about ${shortName} council decisions...`}
          className="bg-surface text-zinc-900 shadow-2xl border-0"
        />
      </div>
    </section>
  );
}
