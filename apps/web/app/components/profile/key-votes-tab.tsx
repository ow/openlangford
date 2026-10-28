import { KeyVoteCard } from "./key-vote-card";
import type { KeyVote } from "../../lib/types";

interface KeyVotesTabProps {
  keyVotes: KeyVote[];
  personName?: string;
  totalKeyVotes?: number;
}

export function KeyVotesTab({ keyVotes, personName, totalKeyVotes }: KeyVotesTabProps) {
  if (!keyVotes || keyVotes.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
        <p className="font-medium text-zinc-700">No key votes identified</p>
        <p className="mt-1 leading-relaxed">
          A vote is flagged as key when this member was in the minority, the result was close, or they
          broke from the colleagues they usually vote with. None have been found in the documented
          votes so far.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        The {keyVotes.length} most notable votes, ranked by significance.
      </p>

      <div className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
        {keyVotes.map((kv) => (
          <KeyVoteCard key={kv.id} keyVote={kv} personName={personName} />
        ))}
      </div>

      {totalKeyVotes && totalKeyVotes > keyVotes.length ? (
        <p className="text-center text-sm text-zinc-500">
          {totalKeyVotes - keyVotes.length} more key votes not shown
        </p>
      ) : null}
    </div>
  );
}
