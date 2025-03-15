const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const fastCsv = require("fast-csv");
const kmeans = require("ml-kmeans");

const app = express();
const port = 3000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, "public")));

// Configure multer for file uploads
const upload = multer({ dest: "uploads/" });

// Helper functions for reading and writing CSV files
function readCsv(filePath) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (row) => rows.push(row))
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

// K-Means Clustering Logic
async function clusterDeliveries(deliveries) {
    const dataPoints = deliveries.map((delivery) => [
        parseFloat(delivery["Origin Pincode"]),
        parseFloat(delivery["Volume"]),
    ]);

    const numClusters = Math.min(5, deliveries.length); // Use up to 5 clusters or the number of deliveries
    const result = kmeans(dataPoints, numClusters);

    const clusters = result.clusters.map((_, index) => ({
        id: index + 1,
        deliveries: [],
        truck: null,
    }));

    deliveries.forEach((delivery, index) => {
        const clusterId = result.clusters[index];
        const cluster = clusters[clusterId];
        cluster.deliveries.push(delivery);
        delivery.cluster_id = cluster.id;
    });

    return clusters;
}

// Function to assign the most preferred truck to a cluster
function assignMostPreferredTruck(clusters, deliveries) {
    clusters.forEach((cluster) => {
        const clusterDeliveries = deliveries.filter(
            (delivery) => delivery.cluster_id === cluster.id
        );

        const truckPreferences = clusterDeliveries
            .map((delivery) => delivery["Truck Preference"])
            .filter(Boolean);

        if (truckPreferences.length > 0) {
            const truckCounts = truckPreferences.reduce((acc, truck) => {
                acc[truck] = (acc[truck] || 0) + 1;
                return acc;
            }, {});

            const mostPreferredTruck = Object.entries(truckCounts).reduce((a, b) =>
                b[1] > a[1] ? b : a
            )[0];

            cluster.truck = mostPreferredTruck;

            clusterDeliveries.forEach((delivery, index) => {
                delivery.Assigned_Truck = mostPreferredTruck;
                delivery.Stop_Order = index + 1;
            });
        } else {
            cluster.truck = null;
            clusterDeliveries.forEach((delivery, index) => {
                delivery.Assigned_Truck = null;
                delivery.Stop_Order = index + 1;
            });
        }
    });

    return clusters;
}

app.post("/optimize", upload.fields([{ name: "deliveries" }, { name: "truckMaster" }]), async (req, res) => {
    try {
        const deliveriesFilePath = req.files.deliveries[0].path;
        const deliveries = await readCsv(deliveriesFilePath);

        const processedDeliveries = deliveries.map((delivery) => ({
            cluster_id: null,
            delivery_id: delivery["ID"],
            "Origin Pincode": delivery["Origin Pincode"],
            "Destination Pincode": delivery["Destination Pincode"],
            Volume: parseFloat(delivery["Volume"]),
            "Truck Preference": delivery["Truck Preference"] || null,
            Assigned_Truck: null,
            Stop_Order: null,
        }));

        const clusters = await clusterDeliveries(processedDeliveries);
        const finalClusters = assignMostPreferredTruck(clusters, processedDeliveries);

        const output = [];
        finalClusters.forEach((cluster) => {
            cluster.deliveries.forEach((delivery) => {
                output.push({
                    cluster_id: cluster.id,
                    delivery_id: delivery.delivery_id,
                    Origin_pincode: delivery["Origin Pincode"],
                    Destination_pincode: delivery["Destination Pincode"],
                    Volume: delivery.Volume,
                    Assigned_Truck: delivery.Assigned_Truck,
                    Stop_Order: delivery.Stop_Order,
                });
            });
        });

        const outputFilePath = path.join(__dirname, "output.csv");
        await writeCsv(outputFilePath, output);

        res.download(outputFilePath, "delivery_plan.csv", (err) => {
            if (err) console.error("Error sending file:", err);
            fs.unlinkSync(deliveriesFilePath);
            fs.unlinkSync(outputFilePath);
        });
    } catch (error) {
        console.error("Error during optimization:", error.message);
        res.status(500).send("Error during optimization. Check server logs for details.");
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

