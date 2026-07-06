// ─────────────────────────────────────────────────────────────────────────
// Auto VIN decode — enriches inventory with full NHTSA specs after every sync
// (server-side) and every extension pull (Cloudflare dealers).
//
// Uses NHTSA's FREE batch endpoint (DecodeVINValuesBatch, up to 50 VINs per
// POST) — no API key, no cost, no rate limit. Runs in the background so it
// never slows down the sync/capture response.
//
// Behaviour:
//   • Only decodes vehicles that have a real 17-char VIN and no vin_data yet
//     (incremental — already-decoded cars are skipped, synthetic STK- VINs are
//     ignored). So the first run backfills the lot; later runs only touch new
//     arrivals → near-zero ongoing work.
//   • Always writes the rich vin_data JSON (powers window stickers/brochures).
//   • Fills core columns (trim, body_style, drivetrain, engine, doors,
//     fuel_type, transmission) ONLY when the feed left them blank — never
//     overwrites data the dealer's feed already provided.
// ─────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from '../shared.js'

const NHTSA_BATCH = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/'
// 17 chars, excludes I/O/Q which never appear in a real VIN.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i

const nv = v => (v && v !== 'Not Applicable' && v !== '0' && String(v).trim() !== '') ? String(v).trim() : null
const ni = v => { const n = parseInt(v); return isNaN(n) ? null : n }
const nf = v => { const n = parseFloat(v); return isNaN(n) ? null : n }

// Map one NHTSA Results row → the same shape /vin/decode produces.
function mapResult(r) {
  const dispL = nf(r.DisplacementL)
  const cyls  = nv(r.EngineCylinders)
  const engineStr = [
    dispL ? `${dispL}L` : null,
    cyls ? `${cyls}-cyl` : null,
    nv(r.EngineConfiguration),
    nv(r.ValveTrainDesign),
    nv(r.Turbo) === 'Yes' ? 'Turbocharged' : null,
    nv(r.EngineHP) ? `${nv(r.EngineHP)} HP` : null,
  ].filter(Boolean).join(' ') || null

  return {
    year:         ni(r.ModelYear),
    make:         nv(r.Make),
    model:        nv(r.Model),
    trim:         nv(r.Trim),
    body_style:   nv(r.BodyClass),
    doors:        ni(r.Doors),
    fuel_type:    nv(r.FuelTypePrimary),
    drivetrain:   nv(r.DriveType),
    transmission: nv(r.TransmissionStyle),
    engine:       engineStr,
    vin_data: {
      manufacturer:        nv(r.Manufacturer),
      vehicle_type:        nv(r.VehicleType),
      series:              nv(r.Series) || nv(r.Series2),
      plant_city:          nv(r.PlantCity),
      plant_state:         nv(r.PlantState),
      plant_country:       nv(r.PlantCountry),
      plant_company:       nv(r.PlantCompanyName),
      engine_model:        nv(r.EngineModel),
      engine_manufacturer: nv(r.EngineManufacturer),
      engine_config:       nv(r.EngineConfiguration),
      valve_train:         nv(r.ValveTrainDesign),
      displacement_l:      dispL,
      displacement_cc:     nf(r.DisplacementCC),
      cylinders:           nv(r.EngineCylinders),
      horsepower:          nv(r.EngineHP),
      turbo:               nv(r.Turbo),
      fuel_type_secondary: nv(r.FuelTypeSecondary),
      fuel_injection:      nv(r.FuelDeliveryFuelInjectionType),
      electrification:     nv(r.ElectrificationLevel),
      transmission_speeds: nv(r.TransmissionSpeed),
      wheel_base:          nv(r.WheelBaseLong) || nv(r.WheelBaseShort),
      wheel_size_front:    nv(r.WheelSizeFront),
      wheel_size_rear:     nv(r.WheelSizeRear),
      wheels:              nv(r.Wheels),
      axles:               nv(r.Axles),
      windows:             nv(r.Windows),
      seat_rows:           nv(r.SeatRows),
      seats:               nv(r.Seats),
      gvwr:                nv(r.GVWR),
      curb_weight_lb:      nv(r.CurbWeightLB),
      brake_system:        nv(r.BrakeSystemType),
      brake_desc:          nv(r.BrakeSystemDesc),
      steering_location:   nv(r.SteeringLocation),
      abs:                 nv(r.ABS),
      esc:                 nv(r.ESC),
      tpms:                nv(r.TPMS),
      forward_collision:   nv(r.ForwardCollisionWarning),
      lane_departure:      nv(r.LaneDepartureWarning),
      lane_keep:           nv(r.LaneKeepSystem),
      blind_spot_mon:      nv(r.BlindSpotMon),
      blind_spot_interv:   nv(r.BlindSpotIntervention),
      adaptive_cruise:     nv(r.AdaptiveCruiseControl),
      auto_brake:          nv(r.AutomaticEmergencyBraking) || nv(r.RearAutomaticEmergencyBraking),
      adaptive_headlights: nv(r.AdaptiveHeadlights),
      adaptive_beam:       nv(r.AdaptiveDrivingBeam),
      airbag_front:        nv(r.AirBagLocFront),
      airbag_side:         nv(r.AirBagLocSide),
      airbag_curtain:      nv(r.AirBagLocCurtain),
      airbag_knee:         nv(r.AirBagLocKnee),
      keyless_ignition:    nv(r.KeylessIgnition),
      sae_automation:      nv(r.SAEAutomationLevel_To),
      decode_error:        r.ErrorCode === '0' ? null : nv(r.ErrorText),
      decoded_at:          new Date().toISOString(),
    },
  }
}

// Fields we'll backfill from NHTSA only when the row's own value is empty.
const CORE_FIELDS = ['trim', 'body_style', 'drivetrain', 'engine', 'doors', 'fuel_type', 'transmission']

/**
 * Decode + persist NHTSA specs for a dealership's un-decoded inventory.
 * Safe to call fire-and-forget; catches its own errors.
 *
 * @param {string} dealershipId
 * @param {object} [opts]
 * @param {number} [opts.max=400]  hard cap on vehicles processed per run
 */
export async function autoDecodeInventory(dealershipId, { max = 400 } = {}) {
  if (!dealershipId) return { decoded: 0 }
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('inventory')
      .select('id, vin, trim, body_style, drivetrain, engine, doors, fuel_type, transmission')
      .eq('dealership_id', dealershipId)
      .is('vin_data', null)
      .limit(max)
    if (error) { console.warn('[vin-decode] fetch failed:', error.message); return { decoded: 0 } }

    const todo = (rows || []).filter(r => r.vin && VIN_RE.test(r.vin))
    if (!todo.length) return { decoded: 0 }

    const byVin = new Map(todo.map(r => [r.vin.toUpperCase(), r]))
    let decoded = 0

    // NHTSA batch: POST form-encoded data=VIN1;VIN2;… (max 50 per call).
    for (let i = 0; i < todo.length; i += 50) {
      const chunk = todo.slice(i, i + 50)
      const body = new URLSearchParams({ format: 'json', data: chunk.map(r => r.vin).join(';') })
      let json
      try {
        const res = await fetch(NHTSA_BATCH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(30000),
        })
        if (!res.ok) { console.warn(`[vin-decode] batch HTTP ${res.status}`); continue }
        json = await res.json()
      } catch (e) { console.warn('[vin-decode] batch failed:', e.message); continue }

      for (const result of json?.Results || []) {
        const row = byVin.get(String(result.VIN || '').toUpperCase())
        if (!row) continue
        const m = mapResult(result)
        // Always store the rich spec blob; backfill only empty core columns.
        const update = { vin_data: m.vin_data }
        for (const f of CORE_FIELDS) {
          if ((row[f] == null || row[f] === '') && m[f] != null) update[f] = m[f]
        }
        const { error: upErr } = await supabaseAdmin.from('inventory').update(update).eq('id', row.id)
        if (!upErr) decoded++
      }
    }

    if (decoded) console.log(`[vin-decode] dealership ${dealershipId}: decoded ${decoded}/${todo.length} vehicles`)
    return { decoded }
  } catch (e) {
    console.warn('[vin-decode] auto-decode failed (non-fatal):', e.message)
    return { decoded: 0 }
  }
}
