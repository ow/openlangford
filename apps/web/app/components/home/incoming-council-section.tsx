import { Link } from "react-router";
import { User } from "lucide-react";
import { personPath } from "../../lib/people-paths";
import { formatDate } from "../../lib/utils";
import type { IncomingCouncil } from "../../services/incoming-council";

export function IncomingCouncilSection({ council }: { council: IncomingCouncil | null }) {
  if (!council) return null;

  return (
    <section aria-labelledby="incoming-council-heading" className="border-b border-zinc-200 bg-surface">
      <div className="container mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div>
            <h2 id="incoming-council-heading" className="text-xl font-bold tracking-tight text-zinc-900">
              <Link
                to={`/people?term=${council.termId}`}
                className="rounded-sm hover:text-brand-700 hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600"
              >
                Incoming council
              </Link>
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              A new council is on the way. Inauguration is scheduled for {formatDate(council.startDate)}.
            </p>
          </div>
        </div>
        <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-7">
          {council.members.map((member) => (
            <li key={member.id}>
              <Link to={personPath(member)} className="group flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600 lg:flex-col lg:items-start lg:gap-2">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 ring-1 ring-zinc-200 lg:h-14 lg:w-14">
                  {member.image_url ? <img src={member.image_url} alt="" width={56} height={56} className="h-full w-full object-cover object-top" /> : <User aria-hidden="true" className="h-6 w-6 text-zinc-400" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold leading-snug text-zinc-800 group-hover:text-brand-700">{member.name}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-zinc-500">{member.role}-elect</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {council.preliminary && <p className="mt-4 text-xs text-zinc-500">Based on preliminary election results. <Link to="/elections" className="underline underline-offset-2 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600">View results</Link></p>}
      </div>
    </section>
  );
}
