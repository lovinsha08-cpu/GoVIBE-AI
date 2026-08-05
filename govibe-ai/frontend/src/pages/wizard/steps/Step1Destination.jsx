import { MapPin, Locate } from 'lucide-react';
import LocationAutocomplete from '../../../components/LocationAutocomplete';

export default function Step1Destination({ data, update }) {
  const tagCurrentLocation = async (field) => {
    if (!navigator.geolocation) {
      alert("Location is not supported");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
          );
          const data = await response.json();
          const locationName = data.display_name || "Current location";

          update({
            [`${field}_lat`]: lat,
            [`${field}_lng`]: lng,
            [field]: locationName,
          });
        } catch (error) {
          update({
            [`${field}_lat`]: lat,
            [`${field}_lng`]: lng,
            [field]: "Current location",
          });
        }
      },
      () => {
        alert(
          "Could not get your location. Please check location permissions."
        );
      }
    );
  };

  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">Where are you headed?</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Tell us your starting point and destination.</p>

      <LocationAutocomplete
        label="Starting location"
        value={data.start_location || ''}
        // Free typing invalidates any previously-picked coordinates — the
        // existing trip-creation flow (resolveCoords in trip.controller.js)
        // will geocode the typed name server-side as a fallback if the
        // traveler submits without picking a suggestion.
        onChangeText={(text) => update({ start_location: text, start_lat: null, start_lng: null })}
        // Picking a suggestion stores lat/lng exactly the way the "use
        // current location" button below already does, so nothing
        // downstream needs to change to consume it.
        onSelect={(place) => update({ start_location: place.name, start_lat: place.lat, start_lng: place.lng })}
        placeholder="e.g. Chennai"
        rightAdornment={
          <button
            type="button"
            onClick={() => tagCurrentLocation('start_location')}
            className="text-[#2563EB]"
            title="Use current location"
          >
            <Locate size={18} />
          </button>
        }
      />

      <LocationAutocomplete
        label="Preferred destination"
        required
        value={data.destination || ''}
        onChangeText={(text) => update({ destination: text, destination_lat: null, destination_lng: null })}
        onSelect={(place) => update({ destination: place.name, destination_lat: place.lat, destination_lng: place.lng })}
        placeholder="e.g. Munnar, Kerala"
      />

      <LocationAutocomplete
        label="End location (if different from destination)"
        value={data.end_location || ''}
        onChangeText={(text) => update({ end_location: text, end_lat: null, end_lng: null })}
        onSelect={(place) => update({ end_location: place.name, end_lat: place.lat, end_lng: place.lng })}
        placeholder="Leave blank if returning to start"
      />

      <p className="flex items-center gap-1.5 text-xs text-[#0C3B5E]/45 mt-2">
        <MapPin size={13} /> Tap the location icon to tag your current position as the start, or start typing to search.
      </p>
    </div>
  );
}