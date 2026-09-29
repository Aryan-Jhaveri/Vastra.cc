import { Router } from 'express'
import { getCurrentWeather } from '../../../tools/weather.js'
import { geocodeCity } from '../../../weather/fetch.js'

const router = Router()

// GET /api/weather?lat=&lon=
router.get('/', async (req, res) => {
  try {
    const { lat, lon } = req.query as Record<string, string>
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon are required' })

    const latNum = parseFloat(lat)
    const lonNum = parseFloat(lon)
    if (isNaN(latNum) || isNaN(lonNum)) {
      return res.status(400).json({ error: 'lat and lon must be numbers' })
    }

    const weather = await getCurrentWeather(latNum, lonNum)
    res.json(weather)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/weather/geocode?city=
router.get('/geocode', async (req, res) => {
  try {
    const { city } = req.query as Record<string, string>
    if (!city) return res.status(400).json({ error: 'city is required' })

    const result = await geocodeCity(city)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
