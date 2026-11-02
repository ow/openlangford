import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

// OpenFreeMap's public, keyless service (same as matters-map). Do not substitute a metered provider.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const MAP_STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const BRAND = "#00747A";

/** A polygon approximating a circle of `radius` metres, for the alert area. */
function circle(lat: number, lng: number, radius: number, steps = 64) {
  const dLat = radius / 111_320;
  const dLng = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [ring] } };
}

/** South-west and north-east corners around the alert area, with a little room. */
function bounds(lat: number, lng: number, radius: number): [[number, number], [number, number]] {
  const dLat = (radius * 1.15) / 111_320;
  const dLng = (radius * 1.15) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]];
}

/** A small, still map of the alert area: a dot at the saved point and the radius around it. */
export function PlaceMap({ lat, lng, radius, className }: { lat: number; lng: number; radius: number; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<import("maplibre-gl").Map | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    const dark = document.documentElement.classList.contains("dark");
    void import("./matters-map.client")
      .then(({ maplibre }) => {
        if (disposed || !container.current) return;
        const instance = new maplibre.Map({
          container: container.current,
          style: dark ? MAP_STYLE_DARK : MAP_STYLE,
          bounds: bounds(lat, lng, radius),
          interactive: false,
          // Credit is shown as a line of text under the map (OpenFreeMap / OpenStreetMap terms).
          attributionControl: false,
        });
        instance.on("error", () => setFailed(true));
        instance.on("load", () => {
          instance.addSource("area", { type: "geojson", data: circle(lat, lng, radius) });
          instance.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": BRAND, "fill-opacity": 0.12 } });
          instance.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": BRAND, "line-width": 2 } });
          instance.addSource("point", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } } });
          instance.addLayer({
            id: "point",
            type: "circle",
            source: "point",
            paint: { "circle-radius": 6, "circle-color": BRAND, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
          });
        });
        map.current = instance;
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
    };
    // The map is rebuilt only when the point changes; radius changes update it in place below.
  }, [lat, lng]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const update = () => {
      (instance.getSource("area") as import("maplibre-gl").GeoJSONSource | undefined)?.setData(circle(lat, lng, radius));
      instance.fitBounds(bounds(lat, lng, radius), { duration: 300 });
    };
    if (instance.loaded()) update();
    else instance.once("load", update);
  }, [radius, lat, lng]);

  return (
    <div className={className}>
      {failed ? (
        <div className="flex h-full items-center justify-center rounded-xl bg-zinc-100 text-xs text-zinc-500">The map couldn't load.</div>
      ) : (
        <div ref={container} className="h-full w-full bg-zinc-100" aria-hidden="true" />
      )}
    </div>
  );
}
