# SignalK GPS Speed Filter Plugin

A SignalK plugin that filters GPS position data based on maximum achievable speed between consecutive positions.

## Features

- Filters unrealistic GPS position jumps
- Configurable maximum speed (default: 250 knots)
- NMEA 2000 source detection
- Detailed logging capabilities
- Timeout mechanism for position acceptance

## Installation

### Via SignalK App Store
1. Open SignalK web interface
2. Go to "App Store"
3. Search for "GPS Speed Filter"
4. Click "Install"

### Manual Installation
1. Navigate to your SignalK installation directory
2. Run: `npm install signalk-gps-speed-filter`
3. Restart SignalK server

## Configuration

The plugin can be configured through the SignalK web interface:

- **Maximum Speed (knots)**: Maximum allowed speed between positions (default: 250)
- **Enable Logging**: Detailed logging of filtered positions
- **Timeout (seconds)**: Time after which positions are accepted regardless (default: 30)
- **Filter only NMEA 2000**: Only filter positions from NMEA 2000 sources (default: true)

## How it works

The plugin monitors incoming GPS position data and calculates the required speed to travel between consecutive positions. If the calculated speed exceeds the configured maximum, the position update is filtered out.

## Algorithm

1. Receives new GPS position
2. Calculates distance from last valid position using Haversine formula
3. Determines required speed based on time difference
4. Accepts or rejects position based on speed threshold

## License

MIT License - see LICENSE file for details

## Contributing

Pull requests welcome! Please read the contributing guidelines first.

