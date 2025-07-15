module.exports = function(app) {
  const plugin = {};
  
  // Plugin metadata
  plugin.id = 'gps-speed-filter';
  plugin.name = 'GPS Speed Filter';
  plugin.description = 'Filters GPS position data based on maximum speed and invalid coordinates';
  
  // Configuration schema
  plugin.schema = {
    type: 'object',
    required: ['targetSource'],
    properties: {
      targetSource: {
        oneOf: [
          {
            type: 'string',
            title: 'Single Source',
            description: 'Single source identifier (e.g., "n2k.177")'
          },
          {
            type: 'array',
            title: 'Multiple Sources',
            description: 'Array of source identifiers to filter',
            items: {
              type: 'string',
              title: 'Source ID'
            }
          }
        ],
        title: 'Target GPS Source(s)',
        description: 'Source identifier(s) to filter. Use "ALL" to filter all GPS sources, specific source like "n2k.177", or array of sources',
        default: 'ALL'
      },
      maxSpeedKnots: {
        type: 'number',
        title: 'Maximum Speed (knots)',
        description: 'Maximum allowed speed between consecutive GPS positions',
        default: 250,
        minimum: 1
      },
      enableLogging: {
        type: 'boolean',
        title: 'Enable Detailed Logging',
        description: 'Enable detailed logging of position filtering decisions',
        default: true
      },
      timeoutSeconds: {
        type: 'number',
        title: 'Position Timeout (seconds)',
        description: 'Time after which positions are accepted regardless of speed',
        default: 30,
        minimum: 1
      },
      historySize: {
        type: 'number',
        title: 'Position History Size',
        description: 'Number of valid positions to keep for speed calculations',
        default: 10,
        minimum: 2,
        maximum: 100
      },
      invalidCoordinates: {
        type: 'array',
        title: 'Invalid Coordinates',
        description: 'Coordinate pairs to filter out as invalid',
        default: [
          { latitude: 0, longitude: 0, tolerance: 1000 }
        ],
        items: {
          type: 'object',
          required: ['latitude', 'longitude'],
          properties: {
            latitude: {
              type: 'number',
              title: 'Latitude',
              minimum: -90,
              maximum: 90
            },
            longitude: {
              type: 'number',
              title: 'Longitude',
              minimum: -180,
              maximum: 180
            },
            tolerance: {
              type: 'number',
              title: 'Tolerance (meters)',
              description: 'Radius around coordinate to filter',
              default: 1000,
              minimum: 0
            }
          }
        }
      },
      enableInvalidCoordinateFilter: {
        type: 'boolean',
        title: 'Enable Invalid Coordinate Filter',
        description: 'Filter out predefined invalid coordinates',
        default: true
      }
    }
  };
  
  // Plugin state
  let unsubscribes = [];
  let config = {};
  let positionHistory = [];
  let stats = {
    received: 0,
    allowed: 0,
    dropped: 0,
    lastPosition: null
  };
  let heartbeatInterval = null;
  
  // Calculate distance between two coordinates using Haversine formula
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
  
  // Check if a source should be processed based on configuration
  function shouldProcessSource(sourceId) {
    if (!config.targetSource) {
      return false;
    }
    
    // Handle "ALL" case
    if (config.targetSource === 'ALL' || config.targetSource === '*') {
      return true;
    }
    
    // Handle array of sources
    if (Array.isArray(config.targetSource)) {
      return config.targetSource.includes(sourceId);
    }
    
    // Handle single source string
    if (typeof config.targetSource === 'string') {
      return sourceId === config.targetSource;
    }
    
    return false;
  }
  
  // Check if coordinates match invalid coordinate filter
  function isInvalidCoordinate(lat, lon) {
    if (!config.enableInvalidCoordinateFilter || !config.invalidCoordinates) {
      return { isInvalid: false };
    }
    
    for (const invalidCoord of config.invalidCoordinates) {
      const tolerance = invalidCoord.tolerance || 1000;
      const distance = calculateDistance(lat, lon, invalidCoord.latitude, invalidCoord.longitude);
      
      if (distance <= tolerance) {
        return { 
          isInvalid: true, 
          matchedCoordinate: invalidCoord, 
          distance: distance 
        };
      }
    }
    
    return { isInvalid: false };
  }
  
  // Add position to history and maintain size limit
  function addToHistory(position, timestamp, source) {
    positionHistory.push({
      latitude: position.latitude,
      longitude: position.longitude,
      timestamp: timestamp,
      source: source
    });
    
    // Keep only the configured number of positions
    if (positionHistory.length > config.historySize) {
      positionHistory.shift();
    }
  }
  
  // Get the most recent position from history
  function getLastPosition() {
    return positionHistory.length > 0 ? positionHistory[positionHistory.length - 1] : null;
  }
  
  // Calculate average position from history
  function getAveragePosition() {
    if (positionHistory.length === 0) return null;
    
    const sum = positionHistory.reduce((acc, pos) => ({
      latitude: acc.latitude + pos.latitude,
      longitude: acc.longitude + pos.longitude
    }), { latitude: 0, longitude: 0 });
    
    return {
      latitude: sum.latitude / positionHistory.length,
      longitude: sum.longitude / positionHistory.length
    };
  }
  
  // Validate position based on speed limits
  function validatePositionSpeed(newLat, newLon, newTimestamp) {
    if (positionHistory.length === 0) {
      return { isValid: true, reason: 'First position' };
    }
    
    const lastPos = getLastPosition();
    const timeDiff = (newTimestamp - lastPos.timestamp) / 1000; // seconds
    
    // Accept position if timeout exceeded
    if (timeDiff > config.timeoutSeconds) {
      return { 
        isValid: true, 
        reason: 'Timeout exceeded',
        timeDiff: timeDiff
      };
    }
    
    // Reject if time difference too small
    if (timeDiff <= 0.1) {
      return { 
        isValid: false, 
        reason: 'Time difference too small',
        timeDiff: timeDiff
      };
    }
    
    // Check speed against recent positions
    let maxCalculatedSpeed = 0;
    const recentPositions = positionHistory.slice(-5); // Last 5 positions
    
    for (const histPos of recentPositions) {
      const histTimeDiff = (newTimestamp - histPos.timestamp) / 1000;
      
      if (histTimeDiff > 0.1) {
        const distance = calculateDistance(
          histPos.latitude,
          histPos.longitude,
          newLat,
          newLon
        );
        
        const speedMps = distance / histTimeDiff;
        const speedKnots = speedMps / 0.514444;
        
        maxCalculatedSpeed = Math.max(maxCalculatedSpeed, speedKnots);
      }
    }
    
    // Also check against average position if we have enough history
    if (positionHistory.length >= 3) {
      const avgPos = getAveragePosition();
      const avgDistance = calculateDistance(
        avgPos.latitude,
        avgPos.longitude,
        newLat,
        newLon
      );
      
      const avgSpeed = (avgDistance / timeDiff) / 0.514444; // knots
      maxCalculatedSpeed = Math.max(maxCalculatedSpeed, avgSpeed);
    }
    
    const isValid = maxCalculatedSpeed <= config.maxSpeedKnots;
    
    return {
      isValid: isValid,
      reason: isValid ? 'Speed check passed' : 'Speed too high',
      maxCalculatedSpeed: maxCalculatedSpeed,
      maxAllowedSpeed: config.maxSpeedKnots,
      timeDiff: timeDiff
    };
  }
  
  // Process incoming position data
  function processPositionData(positionData) {
    try {
      stats.received++;
      
      const { path, value, context, source, $source, timestamp } = positionData;
      
      // Validate basic position data structure
      if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
        if (config.enableLogging) {
          app.debug(`GPS Filter: Invalid position data structure - lat: ${typeof value?.latitude}, lon: ${typeof value?.longitude}`);
        }
        return;
      }
      
      const processingTime = timestamp ? new Date(timestamp).getTime() : Date.now();
      stats.lastPosition = processingTime;
      
      // Calculate distance from last position
      let distanceFromLast = null;
      const lastPos = getLastPosition();
      if (lastPos) {
        distanceFromLast = calculateDistance(
          lastPos.latitude,
          lastPos.longitude,
          value.latitude,
          value.longitude
        );
      }
      
      const distanceText = distanceFromLast !== null ? `${distanceFromLast.toFixed(2)}m` : 'N/A (first)';
      
      if (config.enableLogging) {
        app.debug(`GPS Filter: NEW POSITION from ${$source}: ` +
                 `${value.latitude.toFixed(7)}, ${value.longitude.toFixed(7)} ` +
                 `(distance: ${distanceText}) [${stats.received}]`);
      }
      
      // Check for invalid coordinates
      const invalidCheck = isInvalidCoordinate(value.latitude, value.longitude);
      if (invalidCheck.isInvalid) {
        stats.dropped++;
        
        if (config.enableLogging) {
          app.debug(`GPS Filter: DROPPED - Invalid coordinate (${invalidCheck.distance.toFixed(2)}m from ${invalidCheck.matchedCoordinate.latitude}, ${invalidCheck.matchedCoordinate.longitude})`);
        }
        
        app.setPluginStatus(`Dropped invalid coordinate (${stats.dropped} total dropped)`);
        return; // Don't forward this position
      }
      
      // Validate speed
      const speedCheck = validatePositionSpeed(value.latitude, value.longitude, processingTime);
      
      if (speedCheck.isValid) {
        // Position is valid - add to history and forward
        addToHistory(value, processingTime, $source);
        stats.allowed++;
        
        if (config.enableLogging) {
          app.debug(`GPS Filter: ALLOWED - ${speedCheck.reason} (history: ${positionHistory.length})`);
        }
        
        // Forward the position data to SignalK
        app.handleMessage(plugin.id, {
          updates: [{
            timestamp: timestamp,
            source: source,
            values: [{
              path: path,
              value: value
            }]
          }]
        });
        
        app.setPluginStatus(`GPS filtering active (${stats.allowed} allowed, ${stats.dropped} dropped)`);
        
      } else {
        // Position invalid - drop it
        stats.dropped++;
        
        if (config.enableLogging) {
          app.debug(`GPS Filter: DROPPED - ${speedCheck.reason}` +
                   (speedCheck.maxCalculatedSpeed ? 
                    ` (${speedCheck.maxCalculatedSpeed.toFixed(2)} > ${speedCheck.maxAllowedSpeed} knots)` : ''));
        }
        
        app.setPluginStatus(`Dropped high-speed position (${stats.dropped} total dropped)`);
        // Don't forward this position
      }
      
    } catch (error) {
      app.error('GPS Filter: Error processing position data:', error);
    }
  }
  
  // Plugin start function
  plugin.start = function(options) {
    config = {
      targetSource: 'ALL',
      maxSpeedKnots: 250,
      enableLogging: false,
      timeoutSeconds: 30,
      historySize: 10,
      invalidCoordinates: [
        { latitude: 0, longitude: 0, tolerance: 1000 }
      ],
      enableInvalidCoordinateFilter: true,
      ...options
    };
    
    // Reset state
    positionHistory = [];
    stats = {
      received: 0,
      allowed: 0,
      dropped: 0,
      lastPosition: null
    };
    
    app.debug(`GPS Filter Plugin started`);
    
    // Log target source configuration
    if (config.targetSource === 'ALL' || config.targetSource === '*') {
      app.debug(`Target sources: ALL GPS sources`);
    } else if (Array.isArray(config.targetSource)) {
      app.debug(`Target sources: [${config.targetSource.join(', ')}]`);
    } else {
      app.debug(`Target source: '${config.targetSource}'`);
    }
    
    app.debug(`Max speed: ${config.maxSpeedKnots} knots`);
    app.debug(`History size: ${config.historySize} positions`);
    app.debug(`Invalid coordinate filter: ${config.enableInvalidCoordinateFilter}`);
    
    // Create subscription for navigation.position
    const subscription = {
      context: 'vessels.self',
      subscribe: [{
        path: 'navigation.position',
        period: 1000,    // Request updates every second
        minPeriod: 100   // But accept faster updates
      }]
    };
    
    // Subscribe to position updates
    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error('GPS Filter subscription error:', subscriptionError);
      },
      (delta) => {
        try {
          // Process each update in the delta
          delta.updates.forEach((update) => {
            // Check if this update is from a target source
            if (shouldProcessSource(update.$source)) {
              
              // Process each value in the update
              update.values.forEach((valueUpdate) => {
                if (valueUpdate.path === 'navigation.position') {
                  
                  // Create position data object as per SignalK documentation format
                  const positionData = {
                    path: valueUpdate.path,
                    value: valueUpdate.value,
                    context: delta.context || 'vessels.self',
                    source: update.source,
                    $source: update.$source,
                    timestamp: update.timestamp
                  };
                  
                  processPositionData(positionData);
                }
              });
            } else if (config.enableLogging && stats.received < 5) {
              // Log first few ignored sources for debugging
              app.debug(`GPS Filter: Ignoring source '${update.$source}' (not in target list)`);
            }
          });
        } catch (error) {
          app.error('GPS Filter: Error processing delta:', error);
        }
      }
    );
    
    // Log subscription details
    if (config.targetSource === 'ALL' || config.targetSource === '*') {
      app.debug(`GPS Filter: Subscribed to navigation.position from ALL sources`);
    } else if (Array.isArray(config.targetSource)) {
      app.debug(`GPS Filter: Subscribed to navigation.position from sources: [${config.targetSource.join(', ')}]`);
    } else {
      app.debug(`GPS Filter: Subscribed to navigation.position from source '${config.targetSource}'`);
    }
    
    // Start heartbeat for monitoring
    heartbeatInterval = setInterval(() => {
      const timeSinceLast = stats.lastPosition ? 
        Math.round((Date.now() - stats.lastPosition) / 1000) : 'never';
      
      app.debug(`GPS Filter: Heartbeat - Received: ${stats.received}, ` +
               `Allowed: ${stats.allowed}, Dropped: ${stats.dropped}, ` +
               `Last: ${timeSinceLast}s ago, History: ${positionHistory.length}`);
      
      // Check current position in data store for debugging
      try {
        const currentPos = app.getSelfPath('navigation.position');
        if (currentPos && config.enableLogging && stats.received === 0) {
          app.debug(`GPS Filter: Current position in data store: ` +
                   `lat=${currentPos.value?.latitude}, lon=${currentPos.value?.longitude}, ` +
                   `source=${currentPos.$source || 'unknown'}`);
        }
      } catch (error) {
        // Ignore errors accessing data store
      }
    }, 30000);
    
    const sourceText = config.targetSource === 'ALL' ? 'all GPS sources' : 
                      Array.isArray(config.targetSource) ? `${config.targetSource.length} GPS sources` :
                      '1 GPS source';
    app.setPluginStatus(`GPS filter active - monitoring ${sourceText}`);
  };
  
  // Plugin stop function  
  plugin.stop = function() {
    // Unsubscribe from all subscriptions
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    unsubscribes = [];
    
    // Clear heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    
    // Reset state
    positionHistory = [];
    stats = {
      received: 0,
      allowed: 0,
      dropped: 0,
      lastPosition: null
    };
    
    app.setPluginStatus('GPS filter stopped');
    app.debug('GPS Filter Plugin stopped');
  };
  
  return plugin;
};
