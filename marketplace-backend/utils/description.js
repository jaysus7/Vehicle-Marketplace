export function mapFuel(fuel) {
  if (!fuel) return 'Gasoline'
  const f = fuel.toLowerCase()
  if (f.includes('electric')) return 'Electric'
  if (f.includes('hybrid')) return 'Hybrid'
  if (f.includes('diesel')) return 'Diesel'
  return 'Gasoline'
}

export function buildDescription(vehicle) {
  // Feature list: prefer the feed's explicit searchables, fall back to upgrades/options.
  // Entries may be plain strings or { name } objects depending on the platform.
  const featureSrc = (Array.isArray(vehicle.searchablesarray) && vehicle.searchablesarray.length)
    ? vehicle.searchablesarray
    : (Array.isArray(vehicle.upgrades) ? vehicle.upgrades
      : (Array.isArray(vehicle.options) ? vehicle.options : []))
  const features = featureSrc
    .map(f => (typeof f === 'string' ? f : (f?.name || f?.label || '')))
    .map(s => String(s).trim())
    .filter(Boolean)
    .slice(0, 18)
    .join(' • ')

  const tags = []
  if (vehicle.condition) tags.push(String(vehicle.condition).toUpperCase())
  if (vehicle.certified) tags.push('CERTIFIED PRE-OWNED')
  if (vehicle.demo) tags.push('DEMO')
  if (vehicle.salepending) tags.push('SALE PENDING')

  const headline = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.trim || ''}`
    .replace(/\s+/g, ' ').trim()
  const tagLine = tags.length ? tags.join(' • ') : null

  const specs = [
    vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : null,
    vehicle.exteriorcolor ? `${vehicle.exteriorcolor} exterior` : null,
    vehicle.interiorcolor ? `${vehicle.interiorcolor} interior` : null,
    vehicle.bodystyle || null,
    vehicle.drivetrain || null,
    vehicle.engine || null,
    vehicle.transmission ? `${vehicle.transmission} transmission` : null,
    vehicle.fueltype ? `${vehicle.fueltype} fuel` : null,
    vehicle.seats ? `${vehicle.seats} seats` : null
  ].filter(Boolean)

  // A short trim/marketing blurb when the feed ships one.
  const blurb = [vehicle.trimdescription, vehicle.description]
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .find(s => s && s.length > 20 && s.length < 600) || null

  const sections = [
    tagLine ? `${tagLine}\n${headline}` : headline,
    specs.length ? specs.join(' • ') : null,
    blurb,
    features ? `FEATURES:\n${features}` : null,
    vehicle.stocknumber ? `Stock #${vehicle.stocknumber}` : null
  ].filter(Boolean)

  return sections.join('\n\n')
}

export async function fetchVehiclePhotos(stocknumber) {
  try {
    const res = await fetch(`https://yippi.uxauto.agency/inventory-by-stock/${stocknumber}`)
    const data = await res.json()
    if (data.result !== 'Success' || !data.records?.length) return []
    return (data.records[0].images || []).map(img => img.url).filter(Boolean)
  } catch (e) {
    return []
  }
}
