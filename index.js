const fs = require('fs');
const path = require('path');

module.exports = function(app) {
  const plugin = {};
  
  // Plugin metadata
  plugin.id = 'gps-speed-filter';
  plugin.name = 'GPS Speed Filter';
  plugin.description = 'Filters GPS data based on maximum possible speed between consecutive positions';
  
  // Configuration schema
  plugin.schema = {
    type: 'object',
    properties: {
      maxSpeedKnots: {
        type: 'number',
        title: 'Maximum Speed (knots)',
        description: 'Maximum allowed speed between GPS positions in knots',
        default: 250
      },
      enableLogging: {
        type: 'boolean',
        title: 'Enable Logging',
        description: 'Enables detailed logging of filtered positions',
        default: false
      },
      timeoutSeconds: {
        type: 'number',
        title: 'Timeout (seconds)',
        description: 'Time in seconds after which a position is considered "expired"',
        default: 30
      },
      filterOnlyN2K: {
        type: 'boolean',
        title: 'Filter only NMEA 2000',
        description: 'Only filter positions from NMEA 2000 sources',
        default: true
      }
    }
  };
  
  let unsubscribes = [];
  let lastPosition = null;
  let lastTimestamp = null;
  let config = {};
  
  // Calculates distance between two GPS coordinates in meters (Haversine formula)
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  // Converts knots to meters per second
  function knotsToMeterPerSecond(knots) {
    return knots * 0.514444;
  }
  
  // Checks if source is NMEA 2000
  function isN2KSource(source) {
    if (!source || !source.bus) return false;
    return source.bus.toLowerCase().includes('n2k') || 
           source.bus.toLowerCase().includes('nmea2000') ||
           source.bus.toLowerCase().includes('canbus');
  }
  
  // Checks if a new position is realistic
  function isPositionRealistic(newLat, newLon, newTimestamp) {
    if (!lastPosition || !lastTimestamp) {
      return true; // First position is always valid
    }
    
    const timeDiff = (newTimestamp - lastTimestamp) / 1000; // Time in seconds
    
    // Check timeout
    if (timeDiff > config.timeoutSeconds) {
      if (config.enableLogging) {
        app.debug(`GPS Filter: Position accepted after timeout (${timeDiff}s)`);
      }
      return true;
    }
    
    // If time difference is too small, reject position
    if (timeDiff <= 0) {
      if (config.enableLogging) {
        app.debug('GPS Filter: Position rejected - no time difference');
      }
      return false;
    }
    
    const distance = calculateDistance(
      lastPosition.latitude,
      lastPosition.longitude,
      newLat,
      newLon
    );
    
    const maxDistance = knotsToMeterPerSecond(config.maxSpeedKnots) * timeDiff;
    const calculatedSpeed = distance / timeDiff; // m/s
    const calculatedSpeedKnots = calculatedSpeed / 0.514444;
    
    if (config.enableLogging) {
      app.debug(`GPS Filter: Distance: ${distance.toFixed(2)}m, Time: ${timeDiff.toFixed(2)}s, ` +
                `Speed: ${calculatedSpeedKnots.toFixed(2)} knots, ` +
                `Max allowed: ${config.maxSpeedKnots} knots`);
    }
    
    const isRealistic = distance <= maxDistance;
    
    if (!isRealistic && config.enableLogging) {
      app.debug(`GPS Filter: Position rejected - speed too high: ${calculatedSpeedKnots.toFixed(2)} knots`);
    }
    
    return isRealistic;
  }
  
  // Processes incoming GPS data
  function processGPSData(delta) {
    if (!delta.updates) return;
    
    delta.updates.forEach(update => {
      if (!update.values || !update.source) return;
      
      // Check if we should filter this source
      if (config.filterOnlyN2K && !isN2KSource(update.source)) {
        // Not an N2K source, pass through without filtering
        app.handleMessage(plugin.id, delta);
        return;
      }
      
      let filteredValues = [];
      let hasPosition = false;
      
      update.values.forEach(value => {
        if (value.path === 'navigation.position') {
          hasPosition = true;
          const position = value.value;
          if (!position || typeof position.latitude !== 'number' || typeof position.longitude !== 'number') {
            return;
          }
          
          const timestamp = update.timestamp ? new Date(update.timestamp).getTime() : Date.now();
          
          if (isPositionRealistic(position.latitude, position.longitude, timestamp)) {
            // Position is realistic, include it
            lastPosition = {
              latitude: position.latitude,
              longitude: position.longitude
            };
            lastTimestamp = timestamp;
            
            filteredValues.push(value);
          } else {
            // Position filtered out
            if (config.enableLogging) {
              app.debug(`GPS Filter: Position filtered: ${position.latitude}, ${position.longitude}`);
            }
          }
        } else {
          // Non-position data, pass through
          filteredValues.push(value);
        }
      });
      
      // Send filtered delta if there are values to send
      if (filteredValues.length > 0) {
        const filteredDelta = {
          updates: [{
            timestamp: update.timestamp,
            source: update.source,
            values: filteredValues
          }]
        };
        app.handleMessage(plugin.id, filteredDelta);
      }
    });
  }
  
  // Start plugin
  plugin.start = function(options) {
    config = {
      maxSpeedKnots: 250,
      enableLogging: false,
      timeoutSeconds: 30,
      filterOnlyN2K: true,
      ...options
    };
    
    app.debug(`GPS Filter Plugin started with max speed: ${config.maxSpeedKnots} knots`);
    
    // Subscribe to position updates
    const subscription = {
      context: '*',
      subscribe: [{
        path: 'navigation.position',
        period: 1000,
        format: 'delta',
        policy: 'ideal',
        minPeriod: 200
      }]
    };
    
    app.subscriptionmanager.subscribe(subscription, unsubscribes, 
      (delta) => processGPSData(delta),
      (err) => app.error('GPS Filter subscription error:', err)
    );
    
    if (config.enableLogging) {
      app.debug('GPS Filter: Subscribed to navigation.position updates');
    }
  };
  
  // Stop plugin
  plugin.stop = function() {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    lastPosition = null;
    lastTimestamp = null;
    app.debug('GPS Filter Plugin stopped');
  };
  
  return plugin;
};
