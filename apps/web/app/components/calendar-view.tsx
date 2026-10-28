import { useMemo } from "react";
import { meetingPath } from "../lib/paths";
import { Link } from "react-router";
import type { Meeting } from "../lib/types";
import { cn } from "../lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface CalendarViewProps {
  meetings: Meeting[];
  year: number;
  month: number;
  previous?: string;
  next?: string;
  today: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local YYYY-MM-DD key (avoids the UTC shift of toISOString). */
function dateKey(date: Date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

type Tone = "upcoming" | "past" | "cancelled";

function meetingTone(meeting: Meeting, todayKey: string): Tone {
  if (meeting.status === "Cancelled") return "cancelled";
  return meeting.meeting_date >= todayKey ? "upcoming" : "past";
}

const chipTone: Record<Tone, string> = {
  upcoming:
    "bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200 hover:bg-brand-100",
  past: "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
  cancelled: "bg-zinc-50 text-zinc-400 line-through hover:bg-zinc-100",
};

function meetingLabel(meeting: Meeting) {
  return meeting.calendar_source_id ? meeting.title : meeting.type || meeting.organization?.name || meeting.title;
}

export function CalendarView({
  meetings,
  year,
  month: monthNumber,
  previous,
  next,
  today,
}: CalendarViewProps) {
  const month = monthNumber - 1;
  const currentDate = new Date(year, month, 1);
  const todayKey = dateKey(new Date());

  const firstDayOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startingDayOfWeek = firstDayOfMonth.getDay();

  const calendarDays = useMemo(() => {
    const days: (Date | null)[] = [];
    for (let i = 0; i < startingDayOfWeek; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) days.push(new Date(year, month, i));
    while (days.length % 7 !== 0) days.push(null);
    return days;
  }, [year, month, daysInMonth, startingDayOfWeek]);

  const meetingsByDay = useMemo(() => {
    const map: Record<string, Meeting[]> = {};
    for (const m of meetings) {
      (map[m.meeting_date] ||= []).push(m);
    }
    return map;
  }, [meetings]);

  const monthMeetings = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
    return meetings
      .filter((m) => m.meeting_date.startsWith(prefix))
      .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));
  }, [meetings, year, month]);

  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(
    currentDate,
  );

  const navButton =
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

  return (
    <div className="bg-surface">
      {/* Month navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-1">
          {previous ? (
            <Link
              to={previous}
              className={navButton}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
          ) : (
            <button
              disabled
              className={cn(navButton, "opacity-30")}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <h2
            className="min-w-[9.5rem] text-center text-base font-semibold text-zinc-900"
            aria-live="polite"
          >
            {monthName}{" "}
            <span className="font-normal text-zinc-500 tabular-nums">
              {year}
            </span>
          </h2>
          {next ? (
            <Link to={next} className={navButton} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <button
              disabled
              className={cn(navButton, "opacity-30")}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}

          {!todayKey.startsWith(
            `${year}-${String(monthNumber).padStart(2, "0")}`,
          ) && (
            <Link
              to={today}
              className="ml-2 rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Today
            </Link>
          )}
        </div>

        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand-100 ring-1 ring-inset ring-brand-300" />
            Upcoming
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-zinc-200" />
            Past
          </span>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-zinc-100">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="py-2 text-center text-xs font-medium text-zinc-500"
          >
            <span className="sm:hidden">{day[0]}</span>
            <span className="hidden sm:inline">{day}</span>
          </div>
        ))}
      </div>

      {/* Desktop grid with meeting chips */}
      <div className="hidden grid-cols-7 sm:grid">
        {calendarDays.map((date, idx) => {
          if (!date) {
            return (
              <div
                key={`empty-${idx}`}
                className="min-h-[104px] border-b border-r border-zinc-100 bg-zinc-50/50 [&:nth-child(7n)]:border-r-0"
              />
            );
          }
          const key = dateKey(date);
          const dayMeetings = meetingsByDay[key] || [];
          const isToday = key === todayKey;

          return (
            <div
              key={key}
              className={cn(
                "min-h-[104px] border-b border-r border-zinc-100 p-1.5 [&:nth-child(7n)]:border-r-0",
                isToday && "bg-brand-50/40",
              )}
            >
              <span
                className={cn(
                  "mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums",
                  isToday
                    ? "bg-brand-100 font-semibold text-brand-800"
                    : "text-zinc-500",
                )}
                aria-label={isToday ? `${date.getDate()} (today)` : undefined}
              >
                {date.getDate()}
              </span>
              <div className="space-y-1">
                {dayMeetings.map((meeting) => {
                  const tone = meetingTone(meeting, todayKey);
                  return (
                    <Link
                      key={meeting.id}
                      to={meetingPath(meeting)}
                      title={meeting.title}
                      className={cn(
                        "block truncate rounded-md px-1.5 py-1 text-xs font-medium leading-tight transition-colors",
                        chipTone[tone],
                      )}
                    >
                      {meetingLabel(meeting)}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {monthMeetings.length === 0 && (
        <p className="hidden px-5 py-3 text-sm text-zinc-500 sm:block">
          No meetings in {monthName} {year}.
        </p>
      )}

      {/* Mobile: compact month grid + agenda list */}
      <div className="sm:hidden">
        <div className="grid grid-cols-7 gap-y-1 px-2 py-2">
          {calendarDays.map((date, idx) => {
            if (!date) return <div key={`m-empty-${idx}`} />;
            const key = dateKey(date);
            const dayMeetings = meetingsByDay[key] || [];
            const isToday = key === todayKey;
            const hasUpcoming = dayMeetings.some(
              (m) => meetingTone(m, todayKey) === "upcoming",
            );
            return (
              <div
                key={key}
                className="flex flex-col items-center gap-0.5 py-1"
              >
                <span
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-full text-xs tabular-nums",
                    isToday
                      ? "bg-brand-100 font-semibold text-brand-800"
                      : dayMeetings.length
                        ? "font-semibold text-zinc-900"
                        : "text-zinc-400",
                  )}
                >
                  {date.getDate()}
                </span>
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    dayMeetings.length === 0
                      ? "bg-transparent"
                      : hasUpcoming
                        ? "bg-brand-500"
                        : "bg-zinc-400",
                  )}
                  aria-hidden="true"
                />
              </div>
            );
          })}
        </div>

        <div className="border-t border-zinc-100">
          {monthMeetings.length === 0 ? (
            <p className="px-4 py-5 text-sm text-zinc-500">
              No meetings in {monthName} {year}.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {monthMeetings.map((meeting) => {
                const tone = meetingTone(meeting, todayKey);
                const [y, m, d] = meeting.meeting_date.split("-").map(Number);
                const date = new Date(y, m - 1, d);
                return (
                  <li key={meeting.id}>
                    <Link
                      to={meetingPath(meeting)}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50"
                    >
                      <div
                        className={cn(
                          "flex w-11 shrink-0 flex-col items-center rounded-lg py-1",
                          tone === "upcoming"
                            ? "bg-brand-50 text-brand-800"
                            : "bg-zinc-100 text-zinc-600",
                        )}
                      >
                        <span className="text-[11px] leading-none">
                          {WEEKDAYS[date.getDay()]}
                        </span>
                        <span className="mt-0.5 text-base font-semibold leading-none tabular-nums">
                          {d}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "truncate text-sm font-medium",
                            tone === "cancelled"
                              ? "text-zinc-400 line-through"
                              : "text-zinc-900",
                          )}
                        >
                          {meetingLabel(meeting)}
                        </p>
                        <p className="truncate text-xs text-zinc-500">
                          {tone === "upcoming"
                            ? "Upcoming"
                            : tone === "cancelled"
                              ? "Cancelled"
                              : "Past"}
                          {meeting.title !== meetingLabel(meeting) &&
                            ` · ${meeting.title}`}
                        </p>
                      </div>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-zinc-300"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
