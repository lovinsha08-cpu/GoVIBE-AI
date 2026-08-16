import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';

// Colored, numbered pin — avoids bundling Leaflet's default marker image assets.
function pinIcon({ color = '#2563EB', label } = {}) {
  return L.divIcon({
    className: 'govibe-pin',
    html: `
      <div style="
        background:${color};
        width:28px;height:28px;border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 6px rgba(0,0,0,0.35);
        border:2px solid white;
      ">
        <span style="transform:rotate(45deg);color:white;font-size:11px;font-weight:700;font-family:monospace;">
          ${label ?? ''}
        </span>
      </div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -26],
  });
}

const CATEGORY_COLOR = {
  religious_spiritual: '#E8A33D',
  heritage_historical: '#22C55E',
  nature_scenic: '#16A34A',
  wildlife: '#0E9F6E',
  entertainment_recreation: '#F97316',
  arts_culture: '#A855F7',
  science_learning: '#0EA5E9',
  shopping: '#8B7FD6',
  food_dining: '#2563EB',
  photography_landmarks: '#EC4899',
  sports_adventure: '#DC2626',
  wellness_leisure: '#14B8A6',
  nightlife: '#7C3AED',
  stay: '#0C3B5E',
};

function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 13);
    } else {
      map.fitBounds(points, { padding: [32, 32] });
    }
  }, [map, points]);
  return null;
}

/**
 * Real Leaflet map with OpenStreetMap tiles — no API key required.
 * `spots`: array of { latitude, longitude, name, category, order?, rating?,
 *          entry_fee_inr?, opening_hours? }
 * `showRoute`: draws a dashed line connecting spots in array order (for itineraries).
 */
export default function RealMap({ spots = [], showRoute = false, height = 260 }) {
  const points = useMemo(
    () => spots.filter((s) => s.latitude != null && s.longitude != null).map((s) => [s.latitude, s.longitude]),
    [spots]
  );

  if (points.length === 0) {
    return (
      <div
        className="rounded-2xl bg-[#0C3B5E]/5 flex items-center justify-center text-xs text-[#0C3B5E]/40"
        style={{ height }}
      >
        No locations to show yet
      </div>
    );
  }

  return (
    <div className="rounded-2xl overflow-hidden" style={{ height }}>
      <MapContainer
        center={points[0]}
        zoom={13}
        style={{ width: '100%', height: '100%' }}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        {showRoute && points.length > 1 && (
          <Polyline positions={points} pathOptions={{ color: '#2563EB', weight: 3, dashArray: '6 8' }} />
        )}
        {spots.filter((s) => s.latitude != null && s.longitude != null).map((s, i) => (
          <Marker
            key={s.id ?? `${s.name}-${i}`}
            position={[s.latitude, s.longitude]}
            icon={pinIcon({ color: CATEGORY_COLOR[s.category] || '#2563EB', label: s.order ?? '' })}
          >
            <Popup>
              <div style={{ fontFamily: 'sans-serif', minWidth: 160 }}>
                <strong>{s.name}</strong>
                {s.category && <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'capitalize' }}>{s.category}</div>}
                {s.rating != null && <div style={{ fontSize: 12, marginTop: 4 }}>★ {s.rating}</div>}
                {s.opening_hours && <div style={{ fontSize: 12 }}>{s.opening_hours}</div>}
                {s.entry_fee_inr != null && (
                  <div style={{ fontSize: 12 }}>
                    {s.entry_fee_inr > 0 ? `₹${s.entry_fee_inr}` : 'Free entry'}
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}