// SAM.gov Get Opportunities Public API — federal contracting opportunities.
// Docs: https://open.gsa.gov/api/get-opportunities-public-api/
import { getSecret } from '../secrets.js';
import { fetchWithRetry, throttle } from '../ratelimit.js';
import { IntegrationMissingError } from './errors.js';

function mmddyyyy(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

export function samConfigured() {
  return Boolean(getSecret('SAM_GOV_API_KEY'));
}

export async function searchOpportunities({ keywords, state = 'MI', daysBack = 60, limit = 25 }) {
  const apiKey = getSecret('SAM_GOV_API_KEY');
  if (!apiKey) {
    throw new IntegrationMissingError(
      'SAM.gov Opportunities API',
      'Create a free SAM.gov account, generate a Public API key (Account Details → API Key), and add it as SAM_GOV_API_KEY.'
    );
  }
  const to = new Date();
  const from = new Date(Date.now() - Math.min(daysBack, 364) * 864e5);
  const params = new URLSearchParams({
    api_key: apiKey,
    postedFrom: mmddyyyy(from),
    postedTo: mmddyyyy(to),
    limit: String(Math.min(limit, 100)),
    offset: '0',
    title: keywords,
  });
  if (state) params.set('state', state);
  await throttle('sam.gov', 1000);
  const res = await fetchWithRetry(`https://api.sam.gov/opportunities/v2/search?${params}`, {}, { provider: 'SAM.gov' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SAM.gov API error ${res.status}: ${json?.error?.message || json?.errorMessage || res.statusText}`);
  return (json.opportunitiesData || []).map((o) => ({
    notice_id: o.noticeId,
    title: o.title,
    agency: o.fullParentPathName,
    type: o.type,
    posted: o.postedDate,
    response_deadline: o.responseDeadLine,
    naics: o.naicsCode,
    set_aside: o.typeOfSetAsideDescription,
    place_of_performance: [o.placeOfPerformance?.city?.name, o.placeOfPerformance?.state?.code].filter(Boolean).join(', '),
    url: o.uiLink,
  }));
}
