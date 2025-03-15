const express = require("express");
const multer = require("multer");
const { parse } = require("json2csv");
const { Client } = require("@googlemaps/google-maps-services-js");
const DBSCAN = require("density-clustering").DBSCAN;
const fs = require("fs");
const csv = require("fast-csv");
const path = require("path");
const { OPTICS } = require("density-clustering");

const app = express();
const PORT = 5000;

const upload = multer({ dest: "uploads/" });
const client = new Client({});

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, "public")));

// Utility to parse CSV to JSON
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv.parse({ headers: true }))
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
};

// Endpoint to optimize deliveries
app.post("/optimize", upload.fields([{ name: "deliveries" }, { name: "truckMaster" }]), async (req, res) => {
  try {
    const apiKey = "AIzaSyCXTtvY6EYw5NI72BE3GdckCKyDaTkgGn4";

    // Parse uploaded files
    const deliveries = await parseCSV(req.files.deliveries[0].path);
    const truckMaster = await parseCSV(req.files.truckMaster[0].path);

    // Step 1: Geocode all delivery locations
    const geoData = await Promise.all(
      deliveries.map(async (delivery) => {
        const response = await client.geocode({
          params: { address: delivery["Destination Pincode"], key: apiKey },
        });
        const location = response.data.results[0]?.geometry.location;
        return { ...delivery, location };
      })
    );

    console.log('GEODATA:', geoData);

    // Step 2: DBSCAN clustering
    const coordinates = geoData.map((d) => [d.location.lat, d.location.lng]);
    const dbscan = new DBSCAN();
    const epsilon = calculateEpsilon(geoData);
    const minPoints = 3;

    console.log("Coordinates:", coordinates);
    console.log("Epsilon:", epsilon);

    const clusters = dbscan.run(coordinates, epsilon, minPoints);

    console.log(clusters.length);

    // Step 3: Map clusters and assign trucks
    const clusteredDeliveries = clusters.map((cluster, clusterIndex) => ({
      clusterId: clusterIndex + 1,
      deliveries: cluster.map((index) => geoData[index]),
    }));

    console.log(clusteredDeliveries.length);

    const results = clusteredDeliveries.map((cluster) => {
      const totalVolume = cluster.deliveries.reduce(
        (sum, delivery) => sum + parseFloat(delivery.Volume),
        0
      );
      const assignedTruck = assignTruck(totalVolume, cluster.deliveries, truckMaster);

      return cluster.deliveries.map((delivery, index) => ({
        Cluster_ID: cluster.clusterId,
        Delivery_ID: delivery.ID,
        Origin_Pincode: delivery["Origin Pincode"],
        Destination_Pincode: delivery["Destination Pincode"],
        Volume: delivery.Volume,
        Assigned_Truck: assignedTruck ? assignedTruck["Truck Name"] : "No Truck Available",
        Stop_Order: index + 1,
      }));
    });

    // Flatten results and convert to CSV
    const csvData = parse(results.flat());
    const filePath = path.join(__dirname, "output.csv");
    fs.writeFileSync(filePath, csvData);

    // Clean up uploaded files
    fs.unlinkSync(req.files.deliveries[0].path);
    fs.unlinkSync(req.files.truckMaster[0].path);

    res.download(filePath, "delivery_plan.csv");
  } catch (error) {
    console.error("Error during optimization:", error);
    res.status(500).send("Error during optimization");
  }
});

/**
 * Calculate dynamic epsilon for DBSCAN
 */
const calculateEpsilon = (geoData) => {
  const distances = [];
  for (let i = 0; i < geoData.length; i++) {
    for (let j = i + 1; j < geoData.length; j++) {
      const distance = calculateDistance(geoData[i].location, geoData[j].location)
      distances.push(distance);
    }
  }

  const averageDistance = distances.reduce((sum, d) => sum + d, 0) / distances.length;
  const minDistance = Math.min(...distances);
  const maxDistance = Math.max(...distances);

  console.log("Average Distance:", averageDistance);
  console.log("Min Distance:", minDistance);
  console.log("Max Distance:", maxDistance);

  return Math.min(averageDistance * 0.01, 10); // Use a smaller multiplier for tighter clustering
};

/**
 * Calculate distance between two coordinates
 */
const calculateDistance = (loc1, loc2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371; // Radius of Earth in km
  const dLat = toRad(loc2.lat - loc1.lat);
  const dLon = toRad(loc2.lng - loc1.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(loc1.lat)) *
      Math.cos(toRad(loc2.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return distance;
};

/**
 * Assign trucks based on total volume
 */
const assignTruck = (volume, deliveries, truckMaster) => {
  const preferredTruck = deliveries.find((d) => d["Truck Preference"]);
  if (preferredTruck) {
    return truckMaster.find((truck) => truck.ID === preferredTruck["Truck Preference"]);
  }
  return truckMaster.find((truck) => parseFloat(truck["Volume Capacity"]) >= volume) || null;
};

//console.log("Clusters:", clusters);
console.log("Calculated epsilon:", epsilon);


// Start the server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
