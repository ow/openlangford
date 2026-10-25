import { attendanceCoverageText, attendanceRateText } from "../lib/attendance-evidence";
import { personPath } from "../lib/people-paths";
import { Link } from "react-router";
import { User, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import type { PersonWithStats } from "../services/people";
import { councilServicePeriods, councilServiceRange } from "../lib/council-service";

interface PersonCardProps {
  person: PersonWithStats;
  role: string;
  showStats?: boolean;
}

export function PersonCard({ person, role, showStats = true }: PersonCardProps) {
  const isMayor = role.includes("Mayor");
  const previousService = councilServicePeriods(person).filter((period) => period.status !== "upcoming");

  return (
    <Link
      to={personPath(person)}
      className={cn(
        "group flex flex-col sm:flex-row sm:items-center bg-white rounded-2xl border border-zinc-200 shadow-sm transition-all overflow-hidden hover:shadow-md hover:border-brand-300 p-6 gap-6",
        isMayor && "ring-1 ring-brand-100 border-brand-200"
      )}
    >
      {/* Avatar */}
      <div className="relative shrink-0 mx-auto sm:mx-0">
        <div className={cn(
          "h-20 w-20 rounded-full flex items-center justify-center overflow-hidden border-2 shadow-sm",
          isMayor ? "border-brand-100 bg-brand-50" : "border-zinc-100 bg-zinc-50"
        )}>
          {person.image_url ? (
            <img 
              src={person.image_url} 
              alt={person.name} 
              className="h-full w-full object-cover" 
              width={80}
              height={80}
              loading="lazy"
            />
          ) : (
            <User className={cn("h-8 w-8", isMayor ? "text-brand-300" : "text-zinc-300")} />
          )}
        </div>
      </div>
      
      {/* Info */}
      <div className="text-center sm:text-left min-w-0 flex-1">
        <h3 className="font-bold text-lg text-zinc-900 group-hover:text-brand-600 transition-colors leading-tight mb-2">
          {person.name}
        </h3>
        <div className="flex flex-wrap gap-1.5 justify-center sm:justify-start">
          <Badge variant="secondary" className={cn(
            "px-2.5 py-1 text-xs font-medium whitespace-nowrap border-transparent",
            isMayor 
              ? "bg-brand-50 text-brand-700 hover:bg-brand-100" 
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          )}>
            {role}
          </Badge>
        </div>
        {previousService.map((period) => (
          <p key={`${period.organizationId}-${period.role}-${period.startYear}`} className="mt-2 text-sm text-zinc-500">
            {period.status === "past" ? `Previously ${period.role.toLowerCase()}` : "Council service"} · {councilServiceRange(period)}
          </p>
        ))}
      </div>

      {/* Stats Section */}
      {!showStats ? <p className="text-sm text-muted-foreground">Term has not started</p> : person.stats.total === 0 ? <p className="text-sm text-muted-foreground">No recorded meetings</p> : <div className="w-full sm:w-56 pt-4 sm:pt-0 border-t sm:border-t-0 sm:border-l border-zinc-100 sm:pl-6">
        <div className="mb-1.5 flex items-end justify-between gap-2">
          <span className="text-xs text-zinc-500">Attendance</span>
          <span className="text-xs font-bold tabular-nums text-zinc-700" title={attendanceRateText(person.stats)}>
            {person.stats.rate === null ? "Incomplete" : `${person.stats.rate}%`}
          </span>
        </div>
        {/* Present, absent, and (grey) unknown: missing records are never counted as absences. */}
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100"
          role="img"
          aria-label={attendanceCoverageText(person.stats)}
          title={attendanceCoverageText(person.stats)}
        >
          <div className="h-full bg-brand-500" style={{ width: `${(person.stats.attended / person.stats.total) * 100}%` }} />
          <div className="h-full bg-amber-400" style={{ width: `${(person.stats.absent / person.stats.total) * 100}%` }} />
        </div>
        <p className="mt-1 text-right text-[11px] tabular-nums text-zinc-400">
          <span className="whitespace-nowrap">{person.stats.attended}/{person.stats.total} meetings</span>
          {person.stats.absent ? <span className="whitespace-nowrap"> · {person.stats.absent} absent</span> : null}
          {person.stats.unknown ? <span className="whitespace-nowrap"> · {person.stats.unknown} unknown</span> : null}
        </p>
      </div>}
      
      {/* Chevron */}
      <div className="hidden sm:flex items-center justify-center text-zinc-300 group-hover:text-brand-600 transition-colors">
        <ChevronRight className="h-5 w-5" />
      </div>
    </Link>
  );
}
