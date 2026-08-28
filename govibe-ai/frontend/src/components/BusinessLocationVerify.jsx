import { useEffect, useRef, useState } from 'react';
import { LocateFixed, Loader2, CheckCircle2, AlertTriangle, MapPinOff } from 'lucide-react';
import { api, getPreciseLocation } from '../lib/api';

const VERIFY_DEBOUNCE_MS = 600;
// A GPS reading looser than this is still usable, but the owner is warned
// so a "too far" result isn't confusing when it's really just a weak signal.
const LOW_ACCURACY_WARNING_METERS = 200;

/**
 * Business onboarding — Phase 2 geo-location verification.
 *
 * Lets the owner capture their current GPS position and previews whether it
 * matches a real place (by name, via the backend's Google-Places-backed
 * check) before they submit signup. Purely a preview: the backend re-runs
 * the same deterministic check authoritatively during signup, so nothing
 * here needs to be trusted — this component only exists to give the owner
 * feedback early.
 *
 * Props:
 *   businessName, category - current form values, used to run the check
 *   onLocationChange({ latitude, longitude, accuracyMeters } | null)
 *       - called whenever a GPS position is captured (or cleared)
 *   onVerificationChange(result | null)
 *       - called whenever a verification attempt resolves (or is reset)
 */
export default function BusinessLocationVerify({ businessName, category, onLocationChange, onVerificationChange }) {
  const [gpsState, setGpsState] = useState('idle'); // idle | locating | located | error
  const [gpsError, setGpsError] = useState(null);
  const [coords, setCoords] = useState(null); // { lat, lng, accuracyMeters }

  const [verifyState, setVerifyState] = useState('idle'); // idle | loading | done | error
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyError, setVerifyError] = useState(null);

  const debounceRef = useRef(null);
  const requestIdRef = useRef(0);

  const handleUseLocation = async () => {
    setGpsState('locating');
    setGpsError(null);
    try {
      const pos = await getPreciseLocation();
      setCoords(pos);
      setGpsState('located');
      onLocationChange?.({ latitude: pos.lat, longitude: pos.lng, accuracyMeters: pos.accuracyMeters });
    } catch (err) {
      setGpsState('error');
      setGpsError(err);
      setCoords(null);
      onLocationChange?.(null);
    }
  };

  // Re-run the (debounced) verification whenever we have coordinates AND a
  // business name to check them against — including re-checking if the
  // owner edits the name/category after already capturing GPS.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!coords || !businessName?.trim()) {
      setVerifyState('idle');
      setVerifyResult(null);
      setVerifyError(null);
      onVerificationChange?.(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      setVerifyState('loading');
      setVerifyError(null);
      try {
        const result = await api.verifyBusinessLocation({
          businessName: businessName.trim(),
          category,
          latitude: coords.lat,
          longitude: coords.lng,
        });
        if (requestId !== requestIdRef.current) return;
        setVerifyResult(result);
        setVerifyState('done');
        onVerificationChange?.(result);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setVerifyError(err.message);
        setVerifyState('error');
        onVerificationChange?.(null);
      }
    }, VERIFY_DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, businessName, category]);

  const lowAccuracy = coords?.accuracyMeters != null && coords.accuracyMeters > LOW_ACCURACY_WARNING_METERS;

  return (
    <div className="mb-4">
      <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Business location (GPS)</span>

      <button
        type="button"
        onClick={handleUseLocation}
        disabled={gpsState === 'locating'}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-[#0C3B5E]/15
                   bg-white text-[#0C3B5E] font-medium hover:border-[#16A34A]/50 hover:text-[#16A34A]
                   transition-colors disabled:opacity-60"
      >
        {gpsState === 'locating' ? <Loader2 size={18} className="animate-spin" /> : <LocateFixed size={18} />}
        {gpsState === 'located' ? 'Update current location' : 'Use my current location'}
      </button>

      {gpsState === 'error' && gpsError && (
        <p className="flex items-start gap-1.5 text-xs text-red-500 mt-2">
          <MapPinOff size={14} className="mt-0.5 shrink-0" /> {gpsError.message}
        </p>
      )}

      {coords && (
        <p className="text-xs text-[#0C3B5E]/50 mt-2">
          Captured: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
          {coords.accuracyMeters != null && ` (±${Math.round(coords.accuracyMeters)}m accuracy)`}
        </p>
      )}

      {lowAccuracy && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 mt-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          This reading looks imprecise. If verification below says "too far", try again outdoors or with location services set to high accuracy.
        </p>
      )}

      {verifyState === 'loading' && (
        <p className="flex items-center gap-1.5 text-xs text-[#0C3B5E]/50 mt-2">
          <Loader2 size={14} className="animate-spin" /> Checking this location against Google Places…
        </p>
      )}

      {verifyState === 'error' && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 mt-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {verifyError || 'Could not check this location right now.'} You can still register — this can be verified later.
        </p>
      )}

      {verifyState === 'done' && verifyResult && (
        <div
          className={`mt-2 rounded-xl px-3 py-2.5 text-xs flex items-start gap-2
            ${verifyResult.locationVerified ? 'bg-[#16A34A]/10 text-[#0C3B5E]' : 'bg-amber-50 text-[#0C3B5E]'}`}
        >
          {verifyResult.locationVerified ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[#16A34A]" />
          ) : (
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          )}
          <span>
            {verifyResult.message}
            {verifyResult.place?.address && (
              <span className="block text-[#0C3B5E]/50 mt-0.5">{verifyResult.place.address}</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}