import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, Compass } from 'lucide-react';
import WizardProgress from './WizardProgress';
import Step1Destination from './steps/Step1Destination';
import Step2Duration from './steps/Step2Duration';
import Step3Interests from './steps/Step3Interests';
import StepTripStyle from './steps/StepTripStyle';
import Step4Budget from './steps/Step4Budget';
import Step5People from './steps/Step5People';
import Step6Transport from './steps/Step6Transport';
import Step7Food from './steps/Step7Food';
import { api } from '../../lib/api';

const STEP_COMPONENTS = [
  Step1Destination, Step2Duration, Step3Interests, StepTripStyle, Step4Budget, Step5People, Step6Transport, Step7Food,
];

function validateStep(step, data) {
  switch (step) {
    case 0: return !!data.destination;
    case 1: return !!data.start_date && !!data.end_date;
    case 2: return (data.interests || []).length > 0;
    case 3: return !!data.trip_style;
    case 4: return !!data.total_budget_inr && data.total_budget_inr > 0;
    case 5: return (data.adults ?? 1) >= 1;
    case 6: return !!data.transport_priority;
    case 7: return (data.food_preferences || []).length > 0;
    default: return true;
  }
}

export default function TripWizard() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState({ adults: 1, kids: 0, elderly: 0, specially_abled: 0, needs_accommodation: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const update = (patch) => setData((d) => ({ ...d, ...patch }));
  const isValid = validateStep(step, data);
  const isLastStep = step === STEP_COMPONENTS.length - 1;
  const StepComponent = STEP_COMPONENTS[step];

  const handleNext = async () => {
    if (!isValid) return;
    if (!isLastStep) {
      setStep((s) => s + 1);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { trip } = await api.createTrip(data);
      const { itinerary } = await api.generateItinerary(trip.id);
      navigate(`/trip/${trip.id}/itinerary`, { state: { itinerary } });
    } catch (err) {
      setError(err.message || 'Something went wrong generating your itinerary.');
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (step === 0) navigate(-1);
    else setStep((s) => s - 1);
  };

  return (
    <div className="min-h-screen bg-[#EAF7EF] flex flex-col items-center px-6 py-10">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
            <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
          </div>
          <span className="font-display font-bold text-lg text-[#0C3B5E]">GoVIBE</span>
        </div>

        <WizardProgress current={step} />

        <div className="bg-white/60 rounded-2xl p-6 sm:p-8 border border-[#0C3B5E]/8 min-h-[420px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.25 }}
            >
              <StepComponent data={data} update={update} />
            </motion.div>
          </AnimatePresence>

          {error && <p className="text-sm text-red-500 mt-4">{error}</p>}
        </div>

        <div className="flex items-center justify-between mt-6">
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 text-sm font-medium text-[#0C3B5E]/60 px-4 py-2.5"
          >
            <ArrowLeft size={16} /> Back
          </button>
          <button
            onClick={handleNext}
            disabled={!isValid || loading}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-[#0C3B5E] text-white font-semibold
                       disabled:opacity-40 hover:bg-[#0C3B5E]/90 transition-colors"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {isLastStep ? 'Generate your optimized itinerary' : 'Next'}
            {!isLastStep && <ArrowRight size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}