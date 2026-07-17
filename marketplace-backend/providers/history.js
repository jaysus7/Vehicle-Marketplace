/**
 * Vehicle-history provider abstraction (Carfax VHR / lien / valuation).
 *
 * Same pattern as the credit rail: one interface, a manual fallback today, and a real
 * CarfaxCanadaProvider that slots in once the dealer's Carfax account is wired via a
 * DSP integration. Manual mode = deep-link the dealer to Carfax with the VIN and let
 * them attach the report they pull; live mode (future) fetches + stores natively.
 *
 *   interface HistoryProvider {
 *     name: string
 *     deepLink(vin, country): string          // where to pull the report
 *     pull(vin, ctx): Promise<{ mode, url?, summary?, message }>
 *   }
 */

const CARFAX_CA = 'https://www.carfax.ca/vehicle-history-reports?vin='
const CARFAX_US = 'https://www.carfax.com/vehicle/'

class ManualCarfaxProvider {
  name = 'carfax'
  deepLink(vin, country) {
    const v = encodeURIComponent(String(vin || '').trim())
    if (!v) return country === 'US' ? 'https://www.carfax.com/' : 'https://www.carfax.ca/'
    return (country === 'US' ? CARFAX_US + v : CARFAX_CA + v)
  }
  async pull(vin, { country } = {}) {
    return {
      mode: 'manual',
      url: this.deepLink(vin, country),
      message: 'Open the report in Carfax with the dealership’s account, then attach the PDF here. Native pull turns on once your Carfax DSP integration is live.',
    }
  }
}

export function getHistoryProvider(name, integration) {
  const live = integration && integration.enabled && integration.status === 'live'
  // Only 'carfax' today; live Carfax pull is a future one-file swap.
  return new ManualCarfaxProvider()   // eslint-disable-line no-unused-vars
}

export function carfaxDeepLink(vin, country) { return new ManualCarfaxProvider().deepLink(vin, country) }
