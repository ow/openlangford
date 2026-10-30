/** UTC offset ("-07:00") of an IANA time zone at a given instant. */
export function utcOffset(instant: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  // "GMT-07:00", or plain "GMT" for UTC itself.
  const offset = name?.replace(/^GMT/, "") || "+00:00";
  return offset;
}

const offsetMinutes = (offset: string) => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};

/**
 * Local midnight of a calendar date ("2026-07-14") in the given time zone, as ISO 8601 with
 * that day's offset: "2026-07-14T00:00:00-07:00" in summer, "...-08:00" in winter.
 */
export function zonedMidnightIso(date: string, timeZone: string): string {
  const day = date.slice(0, 10);
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  // The offset at UTC midnight is a first guess; re-check at the local midnight it implies so a
  // date whose offset changes during the day still gets the offset in force at 00:00 local.
  let offset = utcOffset(new Date(utcMidnight), timeZone);
  offset = utcOffset(new Date(utcMidnight - offsetMinutes(offset) * 60_000), timeZone);
  return `${day}T00:00:00${offset}`;
}
