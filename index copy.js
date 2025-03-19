const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const fastCsv = require("fast-csv");
const axios = require("axios");
const { default: cluster } = require("cluster");
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const NodeCache = require('node-cache');
const { promisify } = require('util');

const app = express();
const port = 5001;

// OSRM base URL
const OSRM_BASE_URL = "http://router.project-osrm.org/route/v1/driving";
// Nominatim base URL
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";

const originCoordinatesMap = new Map();

const coordinatesCache = new NodeCache({ stdTTL: 86400, checkperiod: 120 }); // 1 day cache for coordinates
const routeCache = new NodeCache({ stdTTL: 86400, checkperiod: 120 }); // 1 day cache for routes


// // Configure rate limiters
// const nominatimLimit = pLimit(1); // 1 request at a time to Nominatim
// const osrmLimit = pLimit(2); // 2 concurrent requests to OSRM

let nominatimLimit;
let osrmLimit;

// Initialize the rate limiters after importing p-limit
const initializeRateLimiters = async () => {
  try {
    const pLimit = (await import('p-limit')).default;
    nominatimLimit = pLimit(1); // 1 request at a time to Nominatim
    osrmLimit = pLimit(2); // 2 concurrent requests to OSRM
    console.log("Rate limiters initialized successfully");
  } catch (error) {
    console.error("Error initializing rate limiters:", error.message);
    // Fallback function in case p-limit fails to load
    nominatimLimit = osrmLimit = async (fn) => fn();
  }
};
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ dest: "tmp/" });
// const upload = multer({ storage: multer.memoryStorage() }); // Use memory storage

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headersTrimmed = false; // Flag to ensure headers are trimmed only once

    fs.createReadStream(filePath)
      .pipe(
        csv({
          mapHeaders: ({ header }) => {
            // Trim spaces from column headers
            if (header) {
              return header.trim();
            }
            return header;
          },
        })
      )
      .on("data", (row) => {
        return rows.push(row)
      })
      .on("end", () => resolve(rows))
      .on("error", (error) => reject(error));
  });
}

function writeCsv(filePath, data) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    fastCsv
      .write(data, { headers: true })
      .pipe(ws)
      .on("finish", resolve)
      .on("error", reject);
  });
}

function calculateDistance(coord1, coord2) {
  try {
    console.log("Entered calculateDistance");
    console.log("Coordinate 1:", JSON.stringify(coord1));
    console.log("Coordinate 2:", JSON.stringify(coord2));

    // Validate input coordinates
    if (!coord1 || !coord2) {
      throw new Error("Invalid coordinates: Both coord1 and coord2 must be provided");
    }

    const { lat: lat1, lng: lng1 } = coord1;
    const { lat: lat2, lng: lng2 } = coord2;

    // Validate latitude and longitude values
    if (typeof lat1 !== 'number' || typeof lng1 !== 'number' || 
        typeof lat2 !== 'number' || typeof lng2 !== 'number') {
      throw new Error("Coordinates must be numeric values");
    }

    if (lat1 < -90 || lat1 > 90 || lat2 < -90 || lat2 > 90 ||
        lng1 < -180 || lng1 > 180 || lng2 < -180 || lng2 > 180) {
      throw new Error("Coordinates are out of valid range");
    }

    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) *
        Math.cos(lat2 * rad) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const radius = 6371; // Earth's radius in kilometers
    const distance = radius * c;

    // console.log(`Calculated great-circle distance: ${distance.toFixed(2)} kilometers`);
    return distance;
  } catch (error) {
    console.error("Error in calculateDistance:", error.message);
    console.error("Input coordinates:", JSON.stringify({ coord1, coord2 }));
    throw error; // Re-throw to allow caller to handle the error
  }
}

async function getRoadRouteDistance(origin, destination, originPincode) {
  try {
    // Skip if invalid coordinates
    if (!origin || !destination || 
        !origin.lat || !origin.lng || 
        !destination.lat || !destination.lng) {
      console.error("Invalid coordinates provided");
      return null;
    }

    const { lat: originLat, lng: originLng } = origin;
    const { lat: destLat, lng: destLng } = destination;

    // Cache key for the route
    const cacheKey = `route_${originLat.toFixed(4)}_${originLng.toFixed(4)}_${destLat.toFixed(4)}_${destLng.toFixed(4)}`;
    
    // Check cache first
    const cachedRoute = routeCache.get(cacheKey);
    if (cachedRoute !== undefined) {
      return cachedRoute;
    }

    // Store origin coordinate in map if valid
    if (typeof originLat === "number" && typeof originLng === "number" && originPincode) {
      if (!originCoordinatesMap.has(originPincode)) {
        originCoordinatesMap.set(originPincode, { lat: originLat, lng: originLng });
      }
    }

    // Skip cross-continent requests
    if (Math.abs(originLng - destLng) > 50) {
      console.error("Skipping route: Possible cross-continent request.");
      routeCache.set(cacheKey, null);
      return null;
    }
    if (!osrmLimit) {
      await initializeRateLimiters();
    }

    // Use rate limiter for OSRM API
    const response = await osrmLimit(() => axios.get(
      `${OSRM_BASE_URL}/${originLng},${originLat};${destLng},${destLat}`,
      {
        params: {
          overview: "false",
          annotations: "distance",
        },
        timeout: 30000, // 30 second timeout
      }
    ));

    const routes = response.data.routes;
    if (routes && routes.length > 0) {
      const roadDistance = routes[0].distance / 1000; // Convert meters to kilometers
      // Store in cache
      routeCache.set(cacheKey, roadDistance);
      return roadDistance;
    }

    console.warn("No routes found in OSRM API response");
    routeCache.set(cacheKey, null);
    return null;
  } catch (error) {
    console.error(`Error in getRoadRouteDistance:`, error.message);
    // Return previously cached value as fallback
    const cacheKey = `route_${origin.lat.toFixed(4)}_${origin.lng.toFixed(4)}_${destination.lat.toFixed(4)}_${destination.lng.toFixed(4)}`;
    const cachedRoute = routeCache.get(cacheKey, true);
    if (cachedRoute !== undefined) {
      return cachedRoute;
    }
    return null;
  }
}

async function getCoordinates(pincode) {
  try {
    console.log("Entered getCoordinates for pincode:", pincode);
    
    // Check cache first
    const cacheKey = `coords_${pincode}`;
    const cachedCoords = coordinatesCache.get(cacheKey);
    if (cachedCoords) {
      console.log(`Using cached coordinates for ${pincode}`);
      return cachedCoords;
    }

    if (!nominatimLimit) {
      await initializeRateLimiters();
    }
    
    // Use the rate limiter for Nominatim API
    const response = await nominatimLimit(() => axios.get(NOMINATIM_BASE_URL, {
      params: {
        q: pincode,
        format: 'json',
        limit: 1
      },
      headers: {
        'User-Agent': 'DeliveryOptimizationApp/1.0'
      },
      timeout: 10000 // 10 second timeout
    }));

    if (response.data && response.data.length > 0) {
      const coordinates = {
        lat: parseFloat(response.data[0].lat),
        lng: parseFloat(response.data[0].lon)
      };
      
      // Store in cache
      coordinatesCache.set(cacheKey, coordinates);
      return coordinates;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching coordinates for ${pincode}:`, error.message);
    // Return previously cached value even if expired as fallback
    const cachedCoords = coordinatesCache.get(`coords_${pincode}`, true);
    if (cachedCoords) {
      console.log(`Using expired cached coordinates for ${pincode} as fallback`);
      return cachedCoords;
    }
    return null;
  }
}

async function getDirectionsRoute(origin, destinations, originCoordinatesList) {
  console.log("Entered getDirectionsRoute");
  try {
    if (!origin || !originCoordinatesList || originCoordinatesList.length === 0) {
      console.error("Invalid input parameters");
      return null;
    }

    // Create cache key from all coordinates
    const cacheKeyParts = [
      `${origin.lng.toFixed(4)},${origin.lat.toFixed(4)}`,
      ...originCoordinatesList.map(coord => `${coord.lng.toFixed(4)},${coord.lat.toFixed(4)}`)
    ];
    const cacheKey = `direction_${cacheKeyParts.join('_')}`;
    
    // Check cache first
    const cachedRoute = routeCache.get(cacheKey);
    if (cachedRoute) {
      console.log("Using cached route direction");
      return cachedRoute;
    }

    // Sort destinations by stop order if available
    const sortedDestinations = destinations && Array.isArray(destinations) && destinations.length > 0 && 
                             destinations[0].Stop_Order !== undefined ? 
                             [...destinations].sort((a, b) => a.Stop_Order - b.Stop_Order) : 
                             destinations;
    
    // Construct coordinates string for OSRM
    const coordinates = [
      `${origin.lng},${origin.lat}`,
      ...originCoordinatesList.map(dest => `${dest.lng},${dest.lat}`)
    ];

    if (!osrmLimit) {
      await initializeRateLimiters();
    }

    // Use rate limiter for OSRM API
    const response = await osrmLimit(() => axios.get(
      `${OSRM_BASE_URL}/${coordinates.join(';')}`,
      {
        params: {
          overview: 'full',
          geometries: 'polyline',
          steps: 'true',
          annotations: 'true'
        },
        timeout: 20000 // 20 second timeout
      }
    ));

    // Extract route data
    const route = response.data.routes[0];

    if (route) {
      const result = {
        geometry: route.geometry,
        distance: route.distance / 1000, // Total route distance in kilometers
        duration: route.duration / 60, // Total route duration in minutes
        steps: route.legs.flatMap(leg => leg.steps),
        waypoints: coordinates.map((coord, index) => ({
          location: coord.split(',').map(parseFloat),
          type: index === 0 ? 'origin' : 'destination',
          order: index === 0 ? 0 : 
                 (sortedDestinations && sortedDestinations[index - 1] && 
                  sortedDestinations[index - 1].Stop_Order !== undefined ? 
                  sortedDestinations[index - 1].Stop_Order : index)
        }))
      };
      
      // Cache the result
      routeCache.set(cacheKey, result);
      return result;
    }
    return null;
  } catch (error) {
    console.error("Error fetching route directions:", error.message);
    return null;
  }
}

function normalizeClusterIds(clusters) {
  console.log("Entered normalizeClusterIds");
  // Find unique cluster IDs and sort them
  const uniqueClusterIds = [...new Set(clusters.map(cluster => cluster.id))].sort((a, b) => a - b);

  // Create a mapping of old cluster IDs to new cluster IDs
  const clusterIdMap = new Map();
  uniqueClusterIds.forEach((oldId, index) => {
    clusterIdMap.set(oldId, index + 1);
  });

  // Update cluster IDs
  clusters.forEach(cluster => {
    const newId = clusterIdMap.get(cluster.id);
    cluster.id = newId;

    // Update cluster_id for each delivery in the cluster
    cluster.deliveries.forEach(delivery => {
      delivery.cluster_id = newId;
    });
  });

  return clusters;
}

function calculateSpread(cluster) {
  console.log("Entered calculateSpread");
  const coordinates = cluster.deliveries.map((delivery) => delivery.coordinates);
  let maxDistance = 0;

  for (let i = 0; i < coordinates.length; i++) {
    for (let j = i + 1; j < coordinates.length; j++) {
      const distance = calculateDistance(coordinates[i], coordinates[j]);
      maxDistance = Math.max(maxDistance, distance);
    }
  }
  return maxDistance;
}

function determineTruckModel(clusterVolume, clusterWeight, truckModels) {
  console.log("Entered determineTruckModel");
  console.log("Cluster Volume:", clusterVolume);
  console.log("Cluster Weight:", clusterWeight);
  console.log("Truck Models:", truckModels);

  let selectedTruck = null;

  // Sort truck models by volume capacity in ascending order
  const sortedTrucks = truckModels.sort((a, b) => 
    parseFloat(a["usable_volume_cft"]) - parseFloat(b["usable_volume_cft"])
  );

  for (const truck of sortedTrucks) {
    const volumeCapacity = parseFloat(truck["usable_volume_cft"]);
    const weightCapacity = parseFloat(truck["payload_kgs"]);

    console.log(`Checking truck: ${truck["truck_name"]}, Volume Capacity: ${volumeCapacity}, Weight Capacity: ${weightCapacity}`);

    if (clusterVolume <= volumeCapacity && clusterWeight <= weightCapacity) {
      selectedTruck = truck["truck_name"];
      console.log(`Selected Truck: ${selectedTruck}`);
      break;
    }
  }

  if (!selectedTruck) {
    console.log("No suitable truck found for volume:", clusterVolume, "and weight:", clusterWeight);
  }

  return selectedTruck;
}

async function createGeographicalClusters(deliveries) {
  console.log("Creating geographical clusters for", deliveries.length, "deliveries");
  const clusters = [];
  let clusterIdCounter = 1;
  const batchSize = 10; // Process in batches of 10
  
  // Preload coordinates in batches
  for (let i = 0; i < deliveries.length; i += batchSize) {
    const batch = deliveries.slice(i, i + batchSize);
    const coordPromises = batch.map(async (delivery) => {
      const originCoords = await getCoordinates(delivery["Origin Pincode"]);
      const destinationCoords = await getCoordinates(delivery["Destination Pincode"]);
      return { delivery, originCoords, destinationCoords };
    });
    
    // Wait for the batch to complete
    const results = await Promise.allSettled(coordPromises);
    
    // Process the batch results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { delivery, originCoords, destinationCoords } = result.value;
        
        if (!originCoords || !destinationCoords) {
          console.error(`Could not fetch coordinates for pincode: ${delivery["Origin Pincode"]} or ${delivery["Destination Pincode"]}`);
          continue;
        }
        
        delivery.coordinates = destinationCoords;
        let addedToExistingCluster = false;
        
        // Try to add to existing clusters
        for (const cluster of clusters) {
          try {
            // Get road route distances with retries
            let originRouteDistance = await getRoadRouteDistance(cluster.originCoordinates, originCoords);
            let destinationRouteDistance = await getRoadRouteDistance(cluster.destinationCoordinates, destinationCoords);
            
            // Fall back to straight-line distance if route distance fails
            if (originRouteDistance === null) {
              originRouteDistance = calculateDistance(cluster.originCoordinates, originCoords);
              console.log(`Falling back to straight-line distance for origin: ${originRouteDistance}`);
            }
            
            if (destinationRouteDistance === null) {
              destinationRouteDistance = calculateDistance(cluster.destinationCoordinates, destinationCoords);
              console.log(`Falling back to straight-line distance for destination: ${destinationRouteDistance}`);
            }
            
            const spread = calculateSpread(cluster);
            const spreadFactor = spread > 20 ? 2 : 1;
            const dynamicRadius = Math.sqrt(cluster.totalVolume) * 1.5 + cluster.deliveries.length * 3 * spreadFactor;
            
            if (originRouteDistance <= dynamicRadius && destinationRouteDistance <= dynamicRadius) {
              cluster.deliveries.push(delivery);
              cluster.originCoordinatesList.push(originCoords);
              
              // Update cluster totals
              cluster.totalVolume += delivery.Volume;
              cluster.totalWeight += delivery.Weight;
              
              delivery.cluster_id = cluster.id;
              addedToExistingCluster = true;
              break;
            }
          } catch (error) {
            console.error("Error during cluster assignment:", error.message);
            continue; // Try next cluster
          }
        }
        
        // Create new cluster if not added to existing one
        if (!addedToExistingCluster) {
          const newCluster = {
            id: clusterIdCounter++,
            originCoordinates: originCoords,
            originCoordinatesList: [originCoords],
            destinationCoordinates: destinationCoords,
            deliveries: [delivery],
            totalVolume: delivery.Volume,
            totalWeight: delivery.Weight,
          };
          clusters.push(newCluster);
          delivery.cluster_id = newCluster.id;
        }
      }
    }
    
    // Add a small delay between batches to prevent rate limiting
    if (i + batchSize < deliveries.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return {
    clusters: clusters,
    lastClusterId: clusterIdCounter - 1,
  };
}

function splitCluster(cluster, startingClusterId) {
  console.log("Entered splitCluster");
  const finalClusters = [];
  let currentClusterId = startingClusterId;

  // Sort deliveries by a combination of volume and weight in descending order
  const sortedDeliveries = [...cluster.deliveries].sort((a, b) => {
    // Combine volume and weight for sorting
    const scoreA = a.Volume + a.Weight;
    const scoreB = b.Volume + b.Weight;
    return scoreB - scoreA;
  });

  // Initialize the first sub-cluster
  let currentCluster = {
    id: currentClusterId++,
    originCoordinates: cluster.originCoordinates,
    destinationCoordinates: cluster.destinationCoordinates,
    deliveries: [],
    totalVolume: 0,
    totalWeight: 0
  };

  // Distribute deliveries across sub-clusters
  sortedDeliveries.forEach((delivery) => {
    // If current cluster exceeds either volume or weight limit, create a new cluster
    if (currentCluster.totalVolume + delivery.Volume > 1500 ||
        currentCluster.totalWeight + delivery.Weight > 14000) {
      // Add current cluster to final clusters if it has deliveries
      if (currentCluster.deliveries.length > 0) {
        finalClusters.push(currentCluster);
      }

      // Start a new cluster
      currentCluster = {
        id: currentClusterId++,
        originCoordinates: cluster.originCoordinates,
        destinationCoordinates: cluster.destinationCoordinates,
        deliveries: [],
        totalVolume: 0,
        totalWeight: 0
      };
    }

    // Add delivery to current cluster
    currentCluster.deliveries.push(delivery);
    currentCluster.totalVolume += delivery.Volume;
    currentCluster.totalWeight += delivery.Weight;
    delivery.cluster_id = currentCluster.id;
  });

  // Add the last cluster if it has deliveries
  if (currentCluster.deliveries.length > 0) {
    finalClusters.push(currentCluster);
  }

  return finalClusters;
}

function calculateDeliveryDays(totalDistance, dailyTravelDistance) {
   console.log("Entered calculateDeliveryDays");
  // Ensure the inputs are valid numbers and not zero
  totalDistance = parseFloat(totalDistance) || 0;
  dailyTravelDistance = parseFloat(dailyTravelDistance) || 100; // Default to max trip distance for TATA ACE

  if (dailyTravelDistance <= 0) {
    return null; // Return null if the truck cannot travel any distance
  }

  // For TATA ACE, if total distance exceeds 100 km, return null (cannot complete trip)
  if (dailyTravelDistance === 100 && totalDistance > 100) {
    return null;
  }

  // Calculate delivery days based on total route distance
  const daysRequired = Math.max(1, Math.ceil(totalDistance / dailyTravelDistance));
  return daysRequired;
}

async function assignTrucksToCluster(cluster, truckModels) {
  console.log("Entered assignTrucksToCluster");

  // First, try to determine the initial truck based on volume and weight
  let truckModel = determineTruckModel(cluster.totalVolume, cluster.totalWeight, truckModels);

  // Estimate total route distance
  let totalRouteDistance = 0;
  for (let i = 1; i < cluster.deliveries.length; i++) {
    const prevDelivery = cluster.deliveries[i - 1];
    const currentDelivery = cluster.deliveries[i];
    const legDistance = await getRoadRouteDistance(
      prevDelivery.coordinates,
      currentDelivery.coordinates
    );
    totalRouteDistance += legDistance;
  }

  // Add distance from origin to first delivery and last delivery to destination
  const originDistance = await getRoadRouteDistance(
    cluster.originCoordinates,
    cluster.deliveries[0].coordinates
  );
  const destinationDistance = await getRoadRouteDistance(
    cluster.deliveries[cluster.deliveries.length - 1].coordinates,
    cluster.destinationCoordinates
  );
  totalRouteDistance += originDistance + destinationDistance;

  // Round to two decimal places
  totalRouteDistance = Math.round(totalRouteDistance * 100) / 100;

  // If TATA ACE is selected and route distance exceeds 100 km
  if (truckModel === "TATA ACE" && totalRouteDistance > 100) {
    // Sort truck models by volume capacity in ascending order, starting from the next truck after TATA ACE
    const sortedTrucks = truckModels
      .filter(truck => {
        // Only consider trucks with higher volume capacity than TATA ACE
        const currentVolumeCapacity = truckModels.find(t => t["truck_name"] === "TATA ACE")["usable_volume_cft"];
        return parseFloat(truck["usable_volume_cft"]) > parseFloat(currentVolumeCapacity);
      })
      .sort((a, b) => parseFloat(a["usable_volume_cft"]) - parseFloat(b["usable_volume_cft"]));

    // Try to find a suitable truck that can handle the volume, weight, and distance
    for (const truck of sortedTrucks) {
      const volumeCapacity = parseFloat(truck["usable_volume_cft"]);
      const weightCapacity = parseFloat(truck["payload_kgs"]);
      const maxTripDistance = getDailyTravelDistance(truck["truck_name"]);

      if (cluster.totalVolume <= volumeCapacity &&
          cluster.totalWeight <= weightCapacity &&
          totalRouteDistance <= maxTripDistance) {
        truckModel = truck["truck_name"];
        break;
      }
    }
  }

  // Verify the truck's payload capacity
  const selectedTruck = truckModels.find(truck => truck["truck_name"] === truckModel);

  if (selectedTruck) {
    const payloadCapacity = parseFloat(selectedTruck["payload_kgs"]);
    const maxTripDistance = getDailyTravelDistance(truckModel);

    // Check both volume and payload constraints, and calculate delivery days
    if (cluster.totalVolume <= parseFloat(selectedTruck["usable_volume_cft"]) &&
        cluster.totalWeight <= payloadCapacity) {

      // Calculate total delivery days for the entire cluster
      const totalDeliveryDays = calculateDeliveryDays(totalRouteDistance, maxTripDistance);

      cluster.deliveries.forEach((delivery) => {
        delivery.Assigned_Truck = truckModel;
        // Remove DeliveryDays property from output, but keep calculation for internal use
        delivery._calculatedDeliveryDays = totalDeliveryDays;
      });

      // Set cluster-level route distance for potential future use
      cluster.totalRouteDistance = totalRouteDistance;

      // Log cluster details
      console.log(`Cluster ${cluster.id} Details:`);
      console.log(`- Assigned Truck: ${truckModel}`);
      console.log(`- Total Route Distance: ${totalRouteDistance.toFixed(2)} km`);
      console.log(`- Max Trip Distance: ${maxTripDistance} km`);
      console.log(`- Total Deliveries: ${cluster.deliveries.length}`);
      console.log(`- Total Volume: ${cluster.totalVolume.toFixed(2)} CFT`);
      console.log(`- Total Weight: ${cluster.totalWeight.toFixed(2)} kg`);
      console.log(`- Total Delivery Days: ${totalDeliveryDays}`);
    } else {
      cluster.deliveries.forEach((delivery) => {
        delivery.Assigned_Truck = "Not Assigned";
        delivery._calculatedDeliveryDays = null;
      });
      console.log(`Cluster exceeds truck capacity. Volume: ${cluster.totalVolume}, Weight: ${cluster.totalWeight}`);
    }
  } else {
    cluster.deliveries.forEach((delivery) => {
      delivery.Assigned_Truck = "Not Assigned";
      delivery._calculatedDeliveryDays = null;
    });
    console.log(`No suitable truck found for cluster. Volume: ${cluster.totalVolume}, Weight: ${cluster.totalWeight}`);
  }
}

function getDailyTravelDistance(truckModel) {
  console.log("Entered getDailyTravelDistance");
  switch (truckModel) {
    case "TATA ACE":
      return 100; // Total trip distance, not daily distance
    case "TATA 407":
      return 200;
    case "EICHER 17 FEET":
      return 250;
    case "CONTAINER 20 FT":
       return 450;
    case "CONTAINER 32 FT SXL":
       return 450;
    case "CONTAINER 32 FT MXL":
       return 450;
    default:
      return 450;
  }
}

async function optimizeStopOrder(cluster) {
  console.log("Entered optimizeStopOrder");
  const destinationCoords = cluster.deliveries.map((delivery) => delivery.coordinates);

  let currentStopIndex = 0;
  const visited = new Set([currentStopIndex]);
  const stopOrder = [currentStopIndex];

  while (visited.size < destinationCoords.length) {
    let nearestStopIndex = -1;
    let minDistance = Infinity;

    for (let i = 0; i < destinationCoords.length; i++) {
      if (visited.has(i)) continue;
      const distance = calculateDistance(destinationCoords[currentStopIndex], destinationCoords[i]);
      if (distance < minDistance) {
        minDistance = distance;
        nearestStopIndex = i;
      }
    }

    visited.add(nearestStopIndex);
    stopOrder.push(nearestStopIndex);
    currentStopIndex = nearestStopIndex;
  }

  cluster.deliveries.forEach((delivery, index) => {
    delivery.Stop_Order = stopOrder.indexOf(index) + 1;
  });
}

let globalClusters = []; // Global variable to store clusters for map visualization

app.post("/optimize", upload.fields([
  { name: "deliveries", maxCount: 1 },
  { name: "truckMaster", maxCount: 1 },
  { name: "goodsMaster", maxCount: 1 },
]), async (req, res) => {
  try {
    globalClusters = [];
    // coordinatesCache.flushAll();
    // routeCache.flushAll();
    console.log("Uploaded Files Details:", req.files);
    initializeRateLimiters();
    console.log("Received optimization request");
    
    // Extract uploaded file paths
    const deliveriesFilePath = req.files.deliveries[0].path;
    const truckMasterFilePath = req.files.truckMaster[0].path;
    const goodsMasterFilePath = req.files.goodsMaster?.[0]?.path;
    
    // Read CSV files
    console.log("Reading CSV files");
    const deliveries = await readCsv(deliveriesFilePath);
    const truckModels = await readCsv(truckMasterFilePath);
    let goodsMaster = [];
    
    if (goodsMasterFilePath) {
      goodsMaster = await readCsv(goodsMasterFilePath);
    }
    
    // Process deliveries in the main thread as it's not CPU-intensive
    console.log("Processing deliveries");
    const processedDeliveries = deliveries.map((delivery) => {
      let volume = parseFloat(delivery["Volume"] || delivery["CFT"]) || 0;
      let weight = parseFloat(delivery["Weight"] || delivery["weight(kgs)"]) || 0;
      let quantity = parseFloat(delivery["Qty"] || delivery["Quantity"]) || 1;
      
      if (goodsMasterFilePath) {
        const matchingGoods = goodsMaster.find((goodsDetails) => goodsDetails["ID"] === delivery["ID"]);
        
        if (matchingGoods) {
          volume = parseFloat(matchingGoods["CFT"] || matchingGoods["Volume"]) || volume;
          weight = parseFloat(matchingGoods["Weight"] || matchingGoods["weight(kgs)"]) || weight;
        }
      }
      
      return {
        cluster_id: null,
        delivery_id: delivery["ID"],
        "Origin Pincode": delivery["Origin Pincode"],
        "Destination Pincode": delivery["Destination Pincode"],
        Volume: volume,
        Weight: weight,
        Assigned_Truck: "",
        Stop_Order: "",
        Quantity: quantity,
      };
    });

    res.status(202).json({ message: "Optimization process started. Please wait..." });
    // // Implement a timeout handler
    // let isTimeout = false;
    // const timeoutId = setTimeout(() => {
    //   isTimeout = true;
    //   res.status(202).send({
    //     status: "processing",
    //     message: "Your request is being processed in the background due to the large dataset. Please check back in a few minutes."
    //   });
    // }, 25000); // 25 seconds timeout
    
    // Create geographical clusters with built-in batching
    console.log("Creating geographical clusters");
    const { clusters, lastClusterId } = await createGeographicalClusters(processedDeliveries);
    
    // Split clusters exceeding limits
    console.log("Splitting oversized clusters");
    const finalClusters = [];
    let nextClusterId = 1;
    
    for (const cluster of clusters) {
      if (cluster.totalVolume > 1500 || cluster.totalWeight > 14000) {
        const splitResults = splitCluster(cluster, nextClusterId);
        finalClusters.push(...splitResults);
        nextClusterId += splitResults.length;
      } else {
        cluster.id = nextClusterId++;
        finalClusters.push(cluster);
      }
    }
    
    // Normalize cluster IDs
    const normalizedClusters = normalizeClusterIds(finalClusters);
    
    // Process clusters in batches to avoid timeouts
    console.log("Assigning trucks and optimizing stop orders");
    const clusterBatchSize = 5;
    for (let i = 0; i < normalizedClusters.length; i += clusterBatchSize) {
      const batchClusters = normalizedClusters.slice(i, i + clusterBatchSize);
      
      // Process each cluster in the batch concurrently
      await Promise.all(batchClusters.map(async (cluster) => {
        await assignTrucksToCluster(cluster, truckModels);
        await optimizeStopOrder(cluster);
      }));
      
      // Short delay between batches
      if (i + clusterBatchSize < normalizedClusters.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    // Prepare final deliveries for output
    console.log("Preparing final output");
    const finalDeliveries = processedDeliveries
      .map((delivery) => {
        const { coordinates, ...rest } = delivery;
        return rest;
      })
      .sort((a, b) => a.cluster_id - b.cluster_id);
    
    // Write optimized deliveries to CSV
    const outputFilePath = path.join(__dirname, "tmp", "optimized_deliveries.csv");
    await writeCsv(outputFilePath, finalDeliveries);
    
    // Store clusters globally for map visualization
    globalClusters = normalizedClusters;
    
    // Clear the timeout since we finished processing
    // clearTimeout(timeoutId);
    
    // Only redirect if we haven't already sent a timeout response
    // if (!isTimeout) {
      // res.redirect('/map.html');
    // }
  } catch (error) {
    console.error("Error processing request:", error.message);
    res.status(500).send("An error occurred during optimization: " + error.message);
  }
});

app.get("/check-optimization-status", (req, res) => {
  if (globalClusters.length > 0) {
    res.json({ status: "complete" });
  } else {
    res.json({ status: "processing" });
  }
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Modified function with rate limiting
app.get('/get-optimized-clusters', async (req, res) => {
  try {
    console.log("Fetching optimized clusters");
    if (!globalClusters || globalClusters.length === 0) {
      return res.status(404).json({
        error: "No clusters available. Please run optimization first."
      });
    }
    
    const clustersWithRoutes = [];
    const batchSize = 3; // Process 3 clusters at a time
    
    // Process clusters in batches
    for (let i = 0; i < globalClusters.length; i += batchSize) {
      const batchClusters = globalClusters.slice(i, i + batchSize);
      
      // Create an array of promises for this batch
      const batchPromises = batchClusters.map(async (cluster) => {
        try {
          // Add a delay between requests to respect rate limits
          await delay(1000);
          
          const routeDetails = await getDirectionsRoute(
            cluster.originCoordinates,
            cluster.deliveries,
            cluster.originCoordinatesList
          );
          
          const totalVolume = cluster.deliveries.reduce((sum, delivery) => sum + delivery.Volume, 0);
          const totalWeight = cluster.deliveries.reduce((sum, delivery) => sum + delivery.Weight, 0);
          const deliveryDays = cluster.deliveries.length > 0 && cluster.deliveries[0]._calculatedDeliveryDays
            ? cluster.deliveries[0]._calculatedDeliveryDays
            : null;
          
          return {
            clusterId: cluster.id,
            originCoordinates: cluster.originCoordinates,
            allOriginCoordinates: cluster.originCoordinatesList,
            destinationCoordinates: cluster.destinationCoordinates,
            selectedTruck: cluster.deliveries[0]?.Assigned_Truck || "Not Assigned",
            totalDeliveryDays: deliveryDays,
            totalVolume: totalVolume,
            totalWeight: totalWeight,
            routePolyline: routeDetails?.geometry || null,
            routeDetails: {
              totalDistance: routeDetails?.distance || 0,
              totalDuration: routeDetails?.duration || 0,
              waypoints: routeDetails?.waypoints || [],
            },
            deliveries: cluster.deliveries.map(delivery => ({
              deliveryId: delivery.delivery_id,
              originPincode: delivery["Origin Pincode"],
              destinationPincode: delivery["Destination Pincode"],
              volume: delivery.Volume,
              weight: delivery.Weight,
              assignedTruck: delivery.Assigned_Truck,
              stopOrder: delivery.Stop_Order,
              deliveryDays: delivery._calculatedDeliveryDays,
              coordinates: delivery.coordinates
            })),
          };
        } catch (routeError) {
          console.error(`Error getting route for cluster ${cluster.id}:`, routeError.message);
          return {
            clusterId: cluster.id,
            originCoordinates: cluster.originCoordinates,
            allOriginCoordinates: cluster.originCoordinatesList || [],
            destinationCoordinates: cluster.destinationCoordinates,
            selectedTruck: cluster.deliveries[0]?.Assigned_Truck || "Not Assigned",
            totalVolume: cluster.deliveries.reduce((sum, delivery) => sum + delivery.Volume, 0),
            totalWeight: cluster.deliveries.reduce((sum, delivery) => sum + delivery.Weight, 0),
            routePolyline: null,
            routeDetails: { totalDistance: 0, totalDuration: 0, waypoints: [] },
            deliveries: cluster.deliveries.map(delivery => ({
              deliveryId: delivery.delivery_id,
              originPincode: delivery["Origin Pincode"],
              destinationPincode: delivery["Destination Pincode"],
              volume: delivery.Volume,
              weight: delivery.Weight,
              assignedTruck: delivery.Assigned_Truck,
              stopOrder: delivery.Stop_Order,
              coordinates: delivery.coordinates
            })),
            error: routeError.message
          };
        }
      });
      
      // Wait for all promises in this batch to complete
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Add successful results to the final array
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          clustersWithRoutes.push(result.value);
        }
      });
      
      // Add a delay between batches
      if (i + batchSize < globalClusters.length) {
        await delay(1500);
      }
    }
    
    res.json({
      clusters: clustersWithRoutes,
      totalClusters: clustersWithRoutes.length,
      totalDeliveries: clustersWithRoutes.reduce((sum, cluster) => sum + cluster.deliveries.length, 0),
    });
    console.log("Function completed");
  } catch (error) {
    console.error("Error fetching cluster routes:", error.message);
    res.status(500).json({
      error: "An error occurred while fetching cluster routes.",
      details: error.message,
    });
  }
});

// Add a new route to serve the optimized CSV file
app.get('/download-optimized-csv', async (req, res) => {
  try {
    // Read the original CSV file
    const filePath = path.join(__dirname, "tmp", "optimized_deliveries.csv");
    
    // Read the CSV file
    const originalDeliveries = await readCsv(filePath);
    
    // Remove _calculatedDeliveryDays property from each delivery object
    const filteredDeliveries = originalDeliveries.map(delivery => {
      const { _calculatedDeliveryDays, ...filteredDelivery } = delivery;
      return filteredDelivery;
    });
    
    // Create a new CSV file with filtered data
    const outputFilePath = path.join(__dirname, "tmp", "filtered_optimized_deliveries.csv");
    await writeCsv(outputFilePath, filteredDeliveries);
    
    // Download the filtered CSV file
    res.download(outputFilePath, "optimized_deliveries.csv", (err) => {
      if (err) {
        console.error("Download error:", err);
        res.status(500).send("Error downloading the file");
      }
      
      // Optional: Clean up the temporary file after download
      fs.unlink(outputFilePath, (unlinkErr) => {
        if (unlinkErr) console.error("Error deleting temporary file:", unlinkErr);
      });
    });
  } catch (error) {
    console.error("Error processing CSV download:", error.message);
    res.status(500).send("Error processing the CSV file");
  }
});


app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
