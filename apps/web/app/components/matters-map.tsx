import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { Loader2, MapPin } from "lucide-react";
import type { GeoJSONSource, Map as LibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { matterPath } from "../lib/paths";
import type { Matter } from "../lib/types";
import { displayTitle } from "../lib/display-text";
import {
  isMapLocation,
  markerGeoJSON,
  matterMapMarkers,
} from "../lib/matter-map-data";
import { Badge } from "./ui/badge";

const DEFAULT_CENTER = { lat: 48.4496, lng: -123.5045 };
// OpenFreeMap's public, keyless service. Do not substitute a metered provider.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

export function MattersMap({
  matters,
  onMarkerClick,
  activeLocation,
  selectedAddress,
  mapCenter,
  hrefFor = matterPath,
  linkLabel = "View matter",
  compact = false,
  tall = false,
  fitToMarkers = false,
}: {
  matters: Matter[];
  /** Where a pin's links go; the property pages pin addresses rather than matters. */
  hrefFor?: (matter: Matter) => string;
  linkLabel?: string;
  /** One place (a property page): a shorter map without the counts and location list. */
  compact?: boolean;
  /** A page-leading map (the properties index): taller, same compact chrome. */
  tall?: boolean;
  /** Frame every pin on load (a street page) instead of the default town view. */
  fitToMarkers?: boolean;
  onMarkerClick?: (matter: Matter, address?: string) => void;
  activeLocation?: { lat: number; lng: number };
  selectedAddress?: string | null;
  mapCenter?: { lat: number; lng: number };
}) {
  const container = useRef<HTMLDivElement>(null);
  const markers = useMemo(() => matterMapMarkers(matters), [matters]);
  const latest = useRef({ markers, onMarkerClick, activeLocation, mapCenter, fitToMarkers });
  latest.current = { markers, onMarkerClick, activeLocation, mapCenter, fitToMarkers };
  const [map, setMap] = useState<LibreMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [popupHost, setPopupHost] = useState<HTMLDivElement | null>(null);
  const selected = markers.find((marker) => marker.key === selectedKey);
  // Several matters can share an address/coordinate. Keep every link reachable.
  const popupMarkers = selected
    ? markers
        .filter(
          (marker) =>
            (marker.lat === selected.lat && marker.lng === selected.lng) ||
            (!!selected.address && marker.address === selected.address),
        )
        .filter(
          (marker, index, all) =>
            all.findIndex((other) => other.matter.id === marker.matter.id) ===
            index,
        )
    : [];

  useEffect(() => {
    let disposed = false;
    let instance: LibreMap | undefined;
    let observer: ResizeObserver | undefined;
    setLoading(true);
    setFailed(false);
    setMap(null);
    setPopupHost(null);
    // Covers a blocked style/worker request that never emits a load event.
    const timeout = setTimeout(() => {
      if (!disposed) {
        setLoading(false);
        setFailed(true);
      }
    }, 20000);
    void import("./matters-map.client")
      .then(({ maplibre }) => {
        if (disposed || !container.current) return;
        const { activeLocation: focus, mapCenter: configured } = latest.current;
        const center = isMapLocation(focus)
          ? focus
          : isMapLocation(configured)
            ? configured
            : DEFAULT_CENTER;
        const current = (instance = new maplibre.Map({
          container: container.current,
          style: MAP_STYLE,
          center: [center.lng, center.lat],
          zoom: isMapLocation(focus) ? 16 : 12.8,
          maxZoom: 19,
          renderWorldCopies: false,
          attributionControl: false,
        }));
        current.addControl(
          new maplibre.NavigationControl({ showCompass: false }),
          "top-right",
        );
        current.addControl(
          new maplibre.AttributionControl({ compact: true }),
          "bottom-right",
        );
        current
          .getCanvas()
          .setAttribute(
            "aria-label",
            "Council matter locations. Use arrow keys to pan and plus or minus to zoom. Locations are also available in the address list.",
          );
        current.getCanvas().addEventListener("webglcontextlost", () => {
          if (!disposed) setFailed(true);
        });
        current.on("error", () => {
          if (!disposed) {
            clearTimeout(timeout);
            setLoading(false);
            setFailed(true);
          }
        });
        current.on("load", () => {
          if (disposed) return;
          clearTimeout(timeout);
          const { fitToMarkers: fit, markers: pins } = latest.current;
          if (fit && !isMapLocation(focus) && pins.length > 1) {
            const lngs = pins.map((p) => p.lng);
            const lats = pins.map((p) => p.lat);
            current.fitBounds(
              [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
              { padding: 48, maxZoom: 16, duration: 0 },
            );
          }
          current.addSource("matters", {
            type: "geojson",
            data: markerGeoJSON(latest.current.markers),
            cluster: true,
            clusterRadius: 48,
            clusterMaxZoom: 16,
          });
          current.addSource("selected-matter", {
            type: "geojson",
            data: markerGeoJSON([]),
          });
          current.addLayer({
            id: "matter-cluster-halo",
            type: "circle",
            source: "matters",
            filter: ["has", "point_count"],
            paint: {
              "circle-color": "#287779",
              "circle-opacity": 0.12,
              "circle-radius": [
                "step",
                ["get", "point_count"],
                22,
                10,
                26,
                50,
                31,
              ],
            },
          });
          current.addLayer({
            id: "matter-clusters",
            type: "circle",
            source: "matters",
            filter: ["has", "point_count"],
            paint: {
              "circle-color": "#287779",
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 2.5,
              "circle-radius": [
                "step",
                ["get", "point_count"],
                16,
                10,
                20,
                50,
                25,
              ],
            },
          });
          current.addLayer({
            id: "matter-cluster-count",
            type: "symbol",
            source: "matters",
            filter: ["has", "point_count"],
            layout: {
              "text-field": ["get", "point_count_abbreviated"],
              "text-font": ["Noto Sans Bold"],
              "text-size": 12,
            },
            paint: { "text-color": "#fff" },
          });
          current.addLayer({
            id: "matter-points",
            type: "circle",
            source: "matters",
            filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-color": "#287779",
              "circle-radius": 6,
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 2,
            },
          });
          current.addLayer({
            id: "selected-matter-point",
            type: "circle",
            source: "selected-matter",
            paint: {
              "circle-color": "#205c5e",
              "circle-radius": 10,
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 3,
            },
          });
          current.on("click", "matter-clusters", async (event) => {
            const feature = event.features?.[0];
            if (!feature || feature.geometry.type !== "Point") return;
            try {
              const zoom = await (
                current.getSource("matters") as GeoJSONSource
              ).getClusterExpansionZoom(Number(feature.properties.cluster_id));
              if (!disposed)
                current.easeTo({
                  center: feature.geometry.coordinates as [number, number],
                  zoom,
                });
            } catch {
              /* A filter change can replace the cluster while its worker responds. */
            }
          });
          for (const layer of ["matter-points", "selected-matter-point"]) {
            current.on("click", layer, (event) => {
              const marker = latest.current.markers.find(
                (m) => m.key === event.features?.[0]?.properties.key,
              );
              if (!marker) return;
              setSelectedKey(marker.key);
              latest.current.onMarkerClick?.(marker.matter, marker.address);
            });
          }
          for (const layer of [
            "matter-clusters",
            "matter-points",
            "selected-matter-point",
          ]) {
            current.on("mouseenter", layer, () => {
              current.getCanvas().style.cursor = "pointer";
            });
            current.on("mouseleave", layer, () => {
              current.getCanvas().style.cursor = "";
            });
          }
          setLoading(false);
          setFailed(false);
          setMap(current);
        });
        observer = new ResizeObserver(() => current.resize());
        observer.observe(container.current);
      })
      .catch(() => {
        if (!disposed) {
          clearTimeout(timeout);
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      observer?.disconnect();
      instance?.remove();
    };
  }, [attempt]);

  useEffect(() => {
    if (!map) return;
    let disposed = false;
    // Updates only the overlay; filters never re-create the basemap or reset the camera.
    void (map.getSource("matters") as GeoJSONSource)
      .setData(markerGeoJSON(markers))
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [map, markers]);

  useEffect(() => {
    if (!selectedAddress) return;
    setSelectedKey(
      (previous) =>
        markers.find((m) => m.key === previous && m.address === selectedAddress)
          ?.key ??
        markers.find((m) => m.address === selectedAddress)?.key ??
        null,
    );
  }, [selectedAddress, markers]);

  useEffect(() => {
    if (map && isMapLocation(activeLocation))
      map.easeTo({
        center: [activeLocation.lng, activeLocation.lat],
        zoom: 16,
      });
  }, [map, activeLocation?.lat, activeLocation?.lng]);

  useEffect(() => {
    if (!map) return;
    let disposed = false;
    void (map.getSource("selected-matter") as GeoJSONSource)
      .setData(markerGeoJSON(selected ? [selected] : []))
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    setPopupHost(null);
    if (!selected)
      return () => {
        disposed = true;
      };
    const host = document.createElement("div");
    let popup: import("maplibre-gl").Popup | undefined;
    void import("./matters-map.client").then(({ maplibre }) => {
      if (disposed) return;
      popup = new maplibre.Popup({
        maxWidth: "280px",
        offset: 14,
        focusAfterOpen: false,
      })
        .setLngLat([selected.lng, selected.lat])
        .setDOMContent(host)
        .addTo(map);
      popup.on("close", () => {
        if (!disposed) {
          setSelectedKey(null);
          setPopupHost(null);
        }
      });
      setPopupHost(host);
      // Keep sidebar selections visible even when their point is inside a cluster.
      map.easeTo({
        center: [selected.lng, selected.lat],
        zoom: Math.max(map.getZoom(), 16),
      });
    });
    return () => {
      disposed = true;
      popup?.remove();
    };
  }, [map, selected]);

  return (
    <div className="space-y-2">
      <div
        className={`relative z-0 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm ${tall ? "h-[420px] sm:h-[640px]" : compact ? "h-[360px] sm:h-[450px]" : "h-[360px] sm:h-[560px]"}`}
        role="region"
        aria-label={hrefFor === matterPath ? "Map of council matters" : "Map of addresses"}
        aria-busy={loading}
      >
        <div ref={container} className="h-full w-full" />
        {loading && !failed && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-2 bg-zinc-100"
          >
            <Loader2
              aria-hidden="true"
              className="h-6 w-6 animate-spin text-brand-700"
            />
            <span>Loading map…</span>
          </div>
        )}
        {failed && (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50 p-6 text-center text-sm text-zinc-600"
          >
            <MapPin aria-hidden="true" className="h-7 w-7 text-brand-700" />
            <p>
              The map could not load. You can still browse the locations below
              or use the address list.
            </p>
            <button
              type="button"
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2 font-semibold text-brand-700"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry map
            </button>
          </div>
        )}
      </div>
      {!compact && <p className="px-1 text-xs text-zinc-500">
        {markers.length.toLocaleString()} mapped{" "}
        {markers.length === 1 ? "location" : "locations"} across{" "}
        {matters.length.toLocaleString()}{" "}
        {matters.length === 1 ? "matter" : "matters"}
      </p>}
      {markers.length === 0 && (
        <p className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-5 text-sm text-zinc-500">
          None of these addresses have been geocoded yet, so there's nothing to
          plot on the map.
        </p>
      )}
      {!compact && !loading && !failed && (
        <p className="px-1 text-xs text-zinc-500">
          Numbered circles group nearby locations. Zoom in to explore.
        </p>
      )}
      {!compact && <details
        className="rounded-lg border border-zinc-200 bg-white p-3 text-sm"
        open={failed || undefined}
      >
        <summary className="cursor-pointer font-medium text-brand-700">
          Browse mapped locations without the map
        </summary>
        <ul
          className="mt-3 max-h-64 space-y-2 overflow-auto"
          aria-label="Mapped locations"
        >
          {markers.map((marker) => (
            <li
              key={marker.key}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <button
                type="button"
                className="text-left font-medium text-brand-700 underline"
                onClick={() => {
                  setSelectedKey(marker.key);
                  onMarkerClick?.(marker.matter, marker.address);
                }}
              >
                {marker.address || "Show location"}
              </button>
              <Link className="underline" to={hrefFor(marker.matter)}>
                {displayTitle(marker.matter.title)}
              </Link>
            </li>
          ))}
        </ul>
      </details>}
      {popupHost &&
        selected &&
        createPortal(
          <div className="max-h-64 space-y-3 overflow-auto p-1 text-zinc-900">
            {/* Street pages pin addresses whose title is the address itself: don't repeat it. */}
            {selected.address && !popupMarkers.every(({ matter }) => displayTitle(matter.title) === selected.address) && (
              <p className="text-xs text-zinc-500">{selected.address}</p>
            )}
            {popupMarkers.map(({ matter }) => (
              <div key={matter.id} className="space-y-1.5">
                <h3 className="text-sm font-semibold leading-snug">
                  {displayTitle(matter.title)}
                </h3>
                {matter.status && <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={
                      ["Adopted", "Completed"].includes(matter.status)
                        ? "success"
                        : ["Denied", "Repealed"].includes(matter.status)
                          ? "danger"
                          : matter.status === "Active"
                            ? "brand"
                            : "muted"
                    }
                  >
                    {matter.status}
                  </Badge>
                  <span className="text-xs text-zinc-500">
                    {matter.category}
                  </span>
                </div>}
                {matter.description && (
                  <p className="line-clamp-2 text-xs text-zinc-600">
                    {matter.description}
                  </p>
                )}
                <Link
                  to={hrefFor(matter)}
                  className="inline-block text-xs font-semibold text-brand-700 underline"
                >
                  {linkLabel}
                </Link>
              </div>
            ))}
          </div>,
          popupHost,
        )}
    </div>
  );
}
