import { lazy, Suspense, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "~/lib/utils";
import type { SavedPlace } from "~/lib/saved-place";

const PlaceMap = lazy(() => import("./place-map").then((m) => ({ default: m.PlaceMap })));

export const RADIUS_OPTIONS = [
  { value: 500, label: "500 m" },
  { value: 1000, label: "1 km" },
  { value: 2000, label: "2 km" },
  { value: 3000, label: "3 km" },
];

const radiusLabel = (value: number) => RADIUS_OPTIONS.find((o) => o.value === value)?.label ?? `${value} m`;

export type PlaceChoice = {
  place: SavedPlace | null;
  /** Typed but not looked up yet; the server looks it up on save and keeps only the result. */
  lookup: string;
  radius: number;
  cleared: boolean;
};

/**
 * Where nearby alerts are measured from. People can type an address or use their device's
 * location; either way only a rounded point and the street name are kept (lib/saved-place.ts).
 *
 * With `formFields`, it also renders the hidden inputs the settings form posts:
 * place_lat / place_lng / place_label, place_lookup, place_clear and proximity_radius.
 */
export function PlacePicker({
  initial,
  initialRadius = 1000,
  idPrefix,
  formFields = false,
  onChange,
}: {
  initial: SavedPlace | null;
  initialRadius?: number;
  idPrefix: string;
  formFields?: boolean;
  onChange?: (choice: PlaceChoice) => void;
}) {
  const [place, setPlace] = useState<SavedPlace | null>(initial);
  const [editing, setEditing] = useState(!initial);
  const [lookup, setLookup] = useState("");
  const [radius, setRadius] = useState(initialRadius);
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState<"address" | "device" | null>(null);
  const [error, setError] = useState("");

  function update(next: Partial<PlaceChoice>) {
    const choice = { place, lookup, radius, cleared, ...next };
    if ("place" in next) setPlace(choice.place);
    if ("lookup" in next) setLookup(choice.lookup);
    if ("radius" in next) setRadius(choice.radius);
    if ("cleared" in next) setCleared(choice.cleared);
    onChange?.(choice);
  }

  async function find(body: Record<string, unknown>, kind: "address" | "device") {
    setBusy(kind);
    setError("");
    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Partial<SavedPlace> & { error?: string };
      if (res.ok && typeof data.lat === "number" && typeof data.lng === "number") {
        update({ place: { lat: data.lat, lng: data.lng, label: data.label || "Langford" }, lookup: "", cleared: false });
        setEditing(false);
      } else {
        setError(data.error || "We couldn't find that place.");
      }
    } catch {
      setError("The map lookup isn't answering. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  function useDevice() {
    if (!navigator.geolocation) {
      setError("This browser can't share its location. Type an address instead.");
      return;
    }
    setBusy("device");
    setError("");
    navigator.geolocation.getCurrentPosition(
      (position) => void find({ lat: position.coords.latitude, lng: position.coords.longitude }, "device"),
      () => {
        setBusy(null);
        setError("We couldn't get your location. Type an address instead.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }

  const inputId = `${idPrefix}-place`;

  return (
    <div className="space-y-3">
      {formFields && (
        <>
          {place && !editing && (
            <>
              <input type="hidden" name="place_lat" value={place.lat} />
              <input type="hidden" name="place_lng" value={place.lng} />
              <input type="hidden" name="place_label" value={place.label} />
            </>
          )}
          {editing && lookup.trim() && <input type="hidden" name="place_lookup" value={lookup.trim()} />}
          {cleared && <input type="hidden" name="place_clear" value="1" />}
          <input type="hidden" name="proximity_radius" value={radius} />
        </>
      )}

      {place && !editing ? (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-surface">
          <Suspense fallback={<div className="h-44 bg-zinc-100" />}>
            <PlaceMap lat={place.lat} lng={place.lng} radius={radius} className="h-44" />
          </Suspense>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <div>
              <p className="text-sm text-zinc-800">
                Near <span className="font-medium">{place.label}</span>
                <span className="text-zinc-500"> · within {radiusLabel(radius)}</span>
              </p>
              <p className="text-[11px] text-zinc-400">
                Map:{" "}
                <a href="https://openfreemap.org" target="_blank" rel="noreferrer" className="hover:text-zinc-600">OpenFreeMap</a>,{" "}
                <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer" className="hover:text-zinc-600">© OpenMapTiles</a>,{" "}
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="hover:text-zinc-600">© OpenStreetMap</a>
              </p>
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Change place
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-zinc-500"
                onClick={() => {
                  update({ place: null, lookup: "", cleared: true });
                  setEditing(true);
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor={inputId} className="text-sm font-medium text-zinc-700">
            Street address or nearby intersection
          </label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              value={lookup}
              autoComplete="off"
              className="h-10 bg-surface"
              placeholder="e.g. Goldstream Ave and Peatt Rd"
              onChange={(e) => {
                update({ lookup: e.target.value });
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (lookup.trim()) void find({ address: lookup.trim() }, "address");
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="h-10 shrink-0"
              disabled={!lookup.trim() || busy !== null}
              onClick={() => void find({ address: lookup.trim() }, "address")}
            >
              {busy === "address" ? "Finding…" : "Find"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <button
              type="button"
              onClick={useDevice}
              disabled={busy !== null}
              className="font-medium text-brand-700 underline-offset-4 hover:underline disabled:opacity-50"
            >
              {busy === "device" ? "Finding your location…" : "Use my current location"}
            </button>
            {place && (
              <button type="button" onClick={() => { update({ lookup: "" }); setEditing(false); setError(""); }} className="text-zinc-500 hover:text-zinc-700">
                Keep {place.label}
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-sm text-amber-800">
              {error}
            </p>
          )}
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-zinc-700">Alert radius</legend>
        <div className="grid grid-cols-4 gap-2">
          {RADIUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={radius === opt.value}
              onClick={() => update({ radius: opt.value })}
              className={cn(
                "rounded-lg border px-2 py-2 text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
                radius === opt.value ? "border-brand-500 bg-brand-50 text-brand-800" : "border-zinc-200 bg-surface text-zinc-600 hover:border-zinc-300",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-zinc-500">
        We keep only a map point, rounded to about a block, and the street name. We don't keep the address you type.
      </p>
    </div>
  );
}
