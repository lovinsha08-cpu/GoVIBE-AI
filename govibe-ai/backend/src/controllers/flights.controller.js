import { searchFlightOffers, AmadeusApiError } from '../services/amadeus.service.js';

const IATA_CODE_REGEX = /^[A-Za-z]{3}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/flights/search?origin=MAA&destination=DEL&departureDate=2026-08-15&adults=1
export async function searchFlights(req, res, next) {
  try {
    const { origin, destination, departureDate } = req.query;
    const adultsRaw = req.query.adults;

    const missing = ['origin', 'destination', 'departureDate'].filter((key) => !req.query[key]);
    if (missing.length) {
      return res.status(400).json({
        error: `Missing required parameter(s): ${missing.join(', ')}`,
      });
    }

    if (!IATA_CODE_REGEX.test(origin) || !IATA_CODE_REGEX.test(destination)) {
      return res.status(400).json({
        error: 'origin and destination must be valid 3-letter IATA airport codes (e.g. MAA, DEL).',
      });
    }

    if (origin.toUpperCase() === destination.toUpperCase()) {
      return res.status(400).json({ error: 'origin and destination cannot be the same airport.' });
    }

    if (!DATE_REGEX.test(departureDate)) {
      return res.status(400).json({ error: 'departureDate must be in YYYY-MM-DD format.' });
    }

    const departureDateObj = new Date(`${departureDate}T00:00:00Z`);
    if (Number.isNaN(departureDateObj.getTime())) {
      return res.status(400).json({ error: 'departureDate is not a valid calendar date.' });
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (departureDateObj < today) {
      return res.status(400).json({ error: 'departureDate cannot be in the past.' });
    }

    const adults = adultsRaw !== undefined ? parseInt(adultsRaw, 10) : 1;
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) {
      return res.status(400).json({ error: 'adults must be a whole number between 1 and 9.' });
    }

    const flights = await searchFlightOffers({
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      departureDate,
      adults,
    });

    if (!flights.length) {
      return res.status(200).json({
        flights: [],
        message: 'No flights found for the given search criteria.',
      });
    }

    res.status(200).json({ flights });
  } catch (err) {
    if (err instanceof AmadeusApiError) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.details && { details: err.details }),
      });
    }
    next(err);
  }
}