// Google Places API (New) — Text Search. Official, permitted business search.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
import { getSecret } from '../secrets.js';
import { fetchWithRetry, throttle } from '../ratelimit.js';
import { IntegrationMissingError } from './errors.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.types',
  'places.primaryTypeDisplayName',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.googleMapsUri',
  'nextPageToken',
].join(',');

export function placesConfigured() {
  return Boolean(getSecret('GOOGLE_PLACES_API_KEY'));
}

function component(place, type) {
  const c = (place.addressComponents || []).find((x) => (x.types || []).includes(type));
  return c ? c.shortText || c.longText : null;
}

export function normalizePlace(p) {
  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    category: p.primaryTypeDisplayName?.text || null,
    types: p.types || [],
    address: p.formattedAddress || null,
    city: component(p, 'locality') || component(p, 'postal_town') || component(p, 'sublocality'),
    state: component(p, 'administrative_area_level_1'),
    postal_code: component(p, 'postal_code'),
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    rating: p.rating ?? null,
    review_count: p.userRatingCount ?? null,
    business_status: p.businessStatus || null,
    google_maps_url: p.googleMapsUri || null,
  };
}

/**
 * @param {{query:string, lat?:number, lng?:number, radiusMiles?:number, maxResults?:number}} args
 */
export async function searchPlaces({ query, lat, lng, radiusMiles = 15, maxResults = 20 }) {
  const apiKey = getSecret('GOOGLE_PLACES_API_KEY');
  if (!apiKey) {
    throw new IntegrationMissingError(
      'Google Places API',
      'Add GOOGLE_PLACES_API_KEY (Google Cloud console → enable "Places API (New)" → create an API key) in Agent Settings or the server environment.'
    );
  }
  const max = Math.min(Math.max(1, maxResults), 60);
  const results = [];
  let pageToken;
  do {
    const body = { textQuery: query, pageSize: Math.min(20, max - results.length), regionCode: 'US' };
    if (pageToken) body.pageToken = pageToken;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      body.locationBias = {
        circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50000, Math.round(radiusMiles * 1609.34)) },
      };
    }
    await throttle('google-places', 250);
    const res = await fetchWithRetry(
      ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
        body: JSON.stringify(body),
      },
      { provider: 'Google Places' }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText;
      throw new Error(`Google Places API error ${res.status}: ${msg}`);
    }
    for (const p of json.places || []) results.push(normalizePlace(p));
    pageToken = json.nextPageToken;
  } while (pageToken && results.length < max);
  return results;
}

/** Rough geocode of a city/area name using Text Search (returns first result location). */
export async function geocodeArea(area) {
  const [first] = await searchPlaces({ query: area, maxResults: 1 });
  return first && Number.isFinite(first.lat) ? { lat: first.lat, lng: first.lng, label: first.address } : null;
}
