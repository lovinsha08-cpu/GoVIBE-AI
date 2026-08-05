import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing';
import TravelerAuth from './pages/TravelerAuth';
import BusinessAuth from './pages/BusinessAuth';
import TripWizard from './pages/wizard/TripWizard';
import ItineraryResults from './pages/ItineraryResults';
import EmergencyServices from './pages/EmergencyServices';
import BookingItinerary from './pages/BookingItinerary';
import BudgetTracker from './pages/BudgetTracker';
import Explore from './pages/Explore';
import BusinessDashboard from "./pages/BusinessDashboard";
import TravelerDashboard from "./pages/TravelerDashboard";
import TravelerOffers from "./pages/TravelerOffers";
import SavedItineraries from "./pages/SavedItineraries";
import BusinessOffers from "./pages/business/BusinessOffers";
import BusinessProfile from "./pages/business/BusinessProfile";
import BusinessAnalytics from "./pages/business/BusinessAnalytics";
import BusinessListings from "./pages/business/BusinessListings";
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/traveler" element={<TravelerAuth />} />
        <Route path="/business" element={<BusinessAuth />} />
         <Route 
    path="/dashboard" 
    element={<TravelerDashboard />} 
  />

  <Route 
    path="/business/dashboard" 
    element={<BusinessDashboard />} 
  />

        <Route path="/itineraries" element={<SavedItineraries />} />
        <Route path="/trip/new" element={<TripWizard />} />
        <Route path="/trip/:tripId/itinerary" element={<ItineraryResults />} />
        <Route path="/trip/:tripId/emergency-services" element={<EmergencyServices />} />
        <Route path="/trip/:tripId/booking" element={<BookingItinerary />} />
        <Route path="/trip/:tripId/budget" element={<BudgetTracker />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/offers" element={<TravelerOffers />} />
        <Route path="/business/offers" element={<BusinessOffers />} />
        <Route path="/business/profile" element={<BusinessProfile />} />
        <Route path="/business/analytics" element={<BusinessAnalytics />} />
        <Route path="/business/listings" element={<BusinessListings />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;