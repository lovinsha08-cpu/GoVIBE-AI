export function validateTripCreation(req, res, next) {
  const b = req.body;
  const errors = [];

  // Required fields
  if (!b.destination) errors.push('destination is required');
  if (!b.start_date) errors.push('start_date is required');
  if (!b.end_date) errors.push('end_date is required');
  if (b.total_budget_inr === undefined || b.total_budget_inr === null) {
    errors.push('total_budget_inr is required');
  } else if (typeof b.total_budget_inr !== 'number' || b.total_budget_inr < 0) {
    errors.push('total_budget_inr must be a positive number');
  }

  // Group counts
  const groupFields = ['adults', 'kids', 'elderly', 'specially_abled'];
  for (const field of groupFields) {
    if (b[field] !== undefined && b[field] !== null) {
      if (typeof b[field] !== 'number' || b[field] < 0 || !Number.isInteger(b[field])) {
        errors.push(`${field} must be a positive integer`);
      }
    }
  }

  if (b.adults !== undefined && typeof b.adults === 'number' && b.adults < 1) {
    errors.push('At least 1 adult is required');
  }

  // Dates
  if (b.start_date && b.end_date) {
    const startDate = new Date(b.start_date);
    const endDate = new Date(b.end_date);
    if (isNaN(startDate.getTime())) errors.push('start_date is invalid');
    if (isNaN(endDate.getTime())) errors.push('end_date is invalid');
    if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && startDate > endDate) {
      errors.push('start_date must be before or equal to end_date');
    }
  }

  // Arrays
  const arrayFields = ['interests', 'transport_modes', 'food_preferences'];
  for (const field of arrayFields) {
    if (b[field] !== undefined && b[field] !== null && !Array.isArray(b[field])) {
      errors.push(`${field} must be an array`);
    }
  }

  // Coordinates
  const coordFields = ['start_lat', 'start_lng', 'destination_lat', 'destination_lng', 'end_lat', 'end_lng'];
  for (const field of coordFields) {
    if (b[field] !== undefined && b[field] !== null) {
      if (typeof b[field] !== 'number' || isNaN(b[field])) {
        errors.push(`${field} must be a valid number`);
      } else if (field.includes('lat') && (b[field] < -90 || b[field] > 90)) {
        errors.push(`${field} must be between -90 and 90`);
      } else if (field.includes('lng') && (b[field] < -180 || b[field] > 180)) {
        errors.push(`${field} must be between -180 and 180`);
      }
    }
  }

  // String lengths
  const stringFields = ['start_location', 'destination', 'end_location', 'trip_name', 'trip_style', 'transport_priority'];
  for (const field of stringFields) {
    if (b[field] !== undefined && b[field] !== null) {
      if (typeof b[field] !== 'string') {
        errors.push(`${field} must be a string`);
      } else if (b[field].length > 255) {
        errors.push(`${field} is too long (max 255 characters)`);
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  next();
}
