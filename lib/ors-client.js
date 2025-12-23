const ORS_BASE_URL = 'https://api.openrouteservice.org/v2';

class ORSClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastRequestTime = null;
  }

  async getRoute(fromLat, fromLng, toLat, toLng, profile = 'driving-car') {
    await this.rateLimit(); // 1.5s delay between requests

    const response = await fetch(`${ORS_BASE_URL}/directions/${profile}`, {
      method: 'POST',
      headers: {
        'Authorization': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        coordinates: [[fromLng, fromLat], [toLng, toLat]],
        preference: 'recommended',
        instructions: false,
        geometry: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ORS API Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const route = data.routes[0];

    return {
      geometry: typeof route.geometry === 'string'
        ? this.decodePolyline(route.geometry)
        : route.geometry.coordinates,
      distance: route.summary.distance,
      duration: route.summary.duration,
      bbox: route.bbox
    };
  }

  async rateLimit() {
    const now = Date.now();
    if (this.lastRequestTime) {
      const elapsed = now - this.lastRequestTime;
      if (elapsed < 1500) {
        await new Promise(resolve => setTimeout(resolve, 1500 - elapsed));
      }
    }
    this.lastRequestTime = Date.now();
  }

  decodePolyline(encoded) {
    // ORS polyline decoding (precision 5)
    let index = 0, lat = 0, lng = 0;
    const coordinates = [];

    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lng += dlng;

      coordinates.push([lat / 1e5, lng / 1e5]);
    }
    return coordinates;
  }
}

module.exports = ORSClient;
