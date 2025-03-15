const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csvParser = require('csv-parser');
const path = require('path');
const { getDistanceMatrix } = require('./services/googleMapsService');
const { parse } = require('json2csv');

// Initialize express app
const app = express();
const upload = multer({ dest: 'uploads/' });

const port = 3000;

// Serve the uploaded CSV files for download
app.use('/output', express.static(path.join(__dirname, 'output')));

// Endpoint to handle file upload
app.post('/upload', upload.fields([{ name: 'deliveries' }, { name: 'vehicleMaster' }]), async (req, res) => {
    try {
        // Read the deliveries CSV file
        const deliveries = await parseCSV(req.files['deliveries'][0].path);
        const vehicles = await parseCSV(req.files['vehicleMaster'][0].path);
        
        // Process the clustering logic here
        const maxDistance = 10; // in km
        const maxWeight = 500; // in kg
        const maxVolume = 3000000; // in cubic cm

        const clusters = await clusterDeliveries(deliveries, vehicles, maxDistance, maxWeight, maxVolume);
        
        // Write the output to CSV
        const outputCsvPath = path.join(__dirname, 'output', 'output.csv');
        writeCSV(clusters, outputCsvPath);
        
        // Respond with the output file URL
        res.json({ success: true, fileUrl: `/output/${path.basename(outputCsvPath)}` });
    } catch (error) {
        console.error('Error processing files:', error);
        res.json({ success: false, message: 'Error processing files.' });
    }
});

// Function to handle CSV parsing
function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const data = [];
        fs.createReadStream(filePath)
            .pipe(csvParser())
            .on('data', (row) => data.push(row))
            .on('end', () => resolve(data))
            .on('error', reject);
    });
}

// Function to write CSV data
function writeCSV(data, filePath) {
    const csvData = data.map(cluster => ({
        ClusterNo: cluster.sNo,
        Origin: cluster.origin,
        Destinations: cluster.destinations.map(d => d.destination).join('|'),
        TotalWeight: cluster.totalWeight,
        TotalVolume: cluster.totalVolume,
        DeliveryDetails: JSON.stringify(cluster.destinations)
    }));

    const fields = ['ClusterNo', 'Origin', 'Destinations', 'TotalWeight', 'TotalVolume', 'DeliveryDetails'];
    const csvContent = parse(csvData, { fields });

    fs.writeFileSync(filePath, csvContent);
}

// Core clustering function (You can integrate your logic from the previous steps)
async function clusterDeliveries(deliveries, vehicles, maxDistance, maxWeight, maxVolume) {
    const clusters = [];

    let clusterCount = 0;
    
    // Clustering logic (simplified version)
    let currentCluster = {
        sNo: ++clusterCount,
        origin: deliveries[0].Origin,
        destinations: [],
        totalWeight: 0,
        totalVolume: 0
    };

    for (let i = 0; i < deliveries.length; i++) {
        const delivery = deliveries[i];
        const destination = {
            destination: delivery.Destination,
            weight: parseFloat(delivery.Weight),
            volume: parseFloat(delivery.Length) * parseFloat(delivery.Breadth) * parseFloat(delivery.Height)
        };

        // Check if the delivery fits in the current cluster
        if (currentCluster.destinations.length === 0 || 
            (currentCluster.totalWeight + destination.weight <= maxWeight &&
            currentCluster.totalVolume + destination.volume <= maxVolume)) {
            currentCluster.destinations.push(delivery);
            currentCluster.totalWeight += destination.weight;
            currentCluster.totalVolume += destination.volume;
        } else {
            // If it doesn't fit, push the current cluster and start a new one
            clusters.push(currentCluster);
            currentCluster = {
                sNo: ++clusterCount,
                origin: delivery.Origin,
                destinations: [delivery],
                totalWeight: destination.weight,
                totalVolume: destination.volume
            };
        }
    }

    // Add the last cluster
    clusters.push(currentCluster);

    // You can add more sophisticated clustering logic here based on distance matrix or other factors

    return clusters;
}

// Serve the HTML page directly from the root of the server
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});