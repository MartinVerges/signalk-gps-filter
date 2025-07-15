# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2025-07-13

### Added
- Multi-source GPS filtering support (single source, array of sources, or "ALL")
- Invalid coordinate filtering with configurable tolerance zones
- Position history tracking for multi-point speed analysis
- Configurable timeout mechanism for position acceptance
- Real-time plugin status updates and statistics
- Comprehensive logging and debugging capabilities
- Support for NMEA 2000 source identification
- Cross-source validation using combined position history
- Heartbeat monitoring with detailed metrics

### Changed
- **BREAKING**: Complete architectural rewrite using SignalK subscription API
- **BREAKING**: Configuration schema completely redesigned
- **BREAKING**: Renamed all configuration fields for clarity
- Enhanced speed calculation using multiple historical reference points
- Improved distance calculation accuracy with Haversine formula
- Better error handling and resource management
- Default filtering now applies to ALL GPS sources instead of single source

### Configuration Migration
```diff
// v1 Configuration
{
-  "maxSpeedKnots": 250,
-  "enableLogging": false
}

// v43 Configuration  
{
+  "targetSource": "ALL",
+  "maxSpeedKnots": 250,
+  "enableLogging": true,
+  "timeoutSeconds": 30,
+  "historySize": 10,
+  "invalidCoordinates": [
+    {"latitude": 0, "longitude": 0, "tolerance": 1000}
+  ],
+  "enableInvalidCoordinateFilter": true
}
Technical

Migrated from basic delta interception to proper SignalK subscription management
Implemented standard delta message processing following SignalK documentation
Added proper resource cleanup and subscription management
Enhanced source filtering and identification
Improved plugin lifecycle management (start/stop)


## [1.0.0] - 2025-07-13

### Added
- Initial release
- GPS position filtering based on maximum speed
- NMEA 2000 source detection
- Configurable speed threshold (default: 250 knots)
- Timeout mechanism for position acceptance
- Detailed logging capabilities
- Web interface configuration support

### Features
- Haversine formula for accurate distance calculation
- Delta message filtering and forwarding
- Plugin lifecycle management (start/stop)
