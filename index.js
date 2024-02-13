// Load environment variables
require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;

// Configure Cloudflare API client
const cfApi = axios.create({
    baseURL: 'https://api.cloudflare.com/client/v4',
    headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
    },
});

class RelayNode {
    constructor(name, srvId, metricsSrvId, aRecordId, cnameId) {
        this.name = name;
        this.srvId = srvId;
        this.metricsSrvId = metricsSrvId;
        this.aRecordId = aRecordId;
        this.cnameId = cnameId;
    }
}

async function fetchDnsRecords() {
    let allRecords = [];
    let page = 1;
    while (true) {
        const response = await cfApi.get(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
            params: { page, per_page: 100 },
        });
        const recordsPage = response.data.result;
        if (!recordsPage.length) break;
        allRecords = allRecords.concat(recordsPage);
        page += 1;
    }
    const aRecords = allRecords.filter(record => record.type === 'A');
    const cnameRecords = allRecords.filter(record => record.type === 'CNAME');
    const srvRecords = allRecords.filter(record => record.type === 'SRV');
    return { aRecords, cnameRecords, srvRecords };
}

function populateRelayNodes(srvRecords, aRecords, cnameRecords) {
    const relayNodes = [];
    const completeNodes = [];
    const regionIterations = { na: 0, eu: 0, apac: 0, sa: 0, af: 0 };

    cnameRecords.forEach(cnameRecord => {
        // Extract region and iteration from CNAME record name, assuming the format is 'r-{region}-{iteration}.testnet'
        const nameParts = cnameRecord.name.split('.')[0].split('-');
        if (nameParts.length === 3 && nameParts[0] === 'r') {
            const region = nameParts[1];
            const iteration = parseInt(nameParts[2], 10);
            if (!isNaN(iteration) && regionIterations.hasOwnProperty(region)) {
                // Update the region iteration if the current iteration is higher than the stored one
                if (iteration > regionIterations[region]) {
                    regionIterations[region] = iteration;
                }
            }
        }
    });

    srvRecords.forEach(record => {
        if (record.data.service === '_algobootstrap') {
            const metricsSrvRecord = srvRecords.find(r => r.data.service === '_metrics' && r.data.target === record.data.target);
            const cnameRecord = cnameRecords.find(r => r.name === record.data.target);
            let aRecord = null;
            if (cnameRecord) {
                aRecord = aRecords.find(r => r.name === cnameRecord.content);
            }
            const relayNode = {
                name: cnameRecord ? cnameRecord.content : record.data.target,
                srvId: record.id,
                metricsSrvId: metricsSrvRecord ? metricsSrvRecord.id : null,
                aRecordId: aRecord ? aRecord.id : null,
                cnameId: cnameRecord ? cnameRecord.id : null,
            };
            relayNodes.push(relayNode);
            if (relayNode.srvId && relayNode.metricsSrvId && relayNode.aRecordId && relayNode.cnameId) {
                completeNodes.push(relayNode);
            }
        }
    });

    return { relayNodes, completeNodes, regionIterations };
}


async function listNodes() {
    const { aRecords, cnameRecords, srvRecords } = await fetchDnsRecords();
    const { relayNodes, completeNodes } = await populateRelayNodes(srvRecords, aRecords, cnameRecords);
    await fs.writeFile('nodes.json', JSON.stringify(completeNodes.map(node => ({
        name: node.name,
        srvId: node.srvId,
        metricsSrvId: node.metricsSrvId,
        aRecordId: node.aRecordId,
        cnameId: node.cnameId,
    })), null, 2));
    console.log(`Count of Complete Nodes: ${completeNodes.length}`);
    completeNodes.forEach((node, i) => console.log(`${i}. ${node.name}`));
}

async function addNode(ip, hostname, region, regionIterations) {
    // Assuming regionIterations is already updated
    const availIteration = regionIterations[region] + 1;

    // Create an A Record (no changes here)
    await cfApi.post(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
        type: 'A',
        name: `${hostname}.testnet`,
        content: ip,
        ttl: 3600,
    });

    // Create a CNAME Record (no changes here)
    const cnameName = `r-${region}-${availIteration}.testnet`;
    await cfApi.post(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
        type: 'CNAME',
        name: cnameName,
        content: `${hostname}.testnet.voi.network`,
        ttl: 3600,
    });

    // Create SRV Records directly after CNAME creation
    // SRV Record for _algobootstrap
    await cfApi.post(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
        type: 'SRV',
        data: {
            service: '_algobootstrap',
            name: 'voitest',
            proto: '_tcp',
            priority: 1,
            weight: 1,
            port: 5011,
            target: `${cnameName}.voi.network`
        },
        ttl: 3600,
    });

    // SRV Record for _metrics
    await cfApi.post(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
        type: 'SRV',
        data: {
            service: '_metrics',
            name: 'voitest',
            proto: '_tcp',
            priority: 1,
            weight: 1,
            port: 9100,
            target: `${cnameName}.voi.network`
        },
        ttl: 3600,
    });

    console.log(`Node ${hostname} with IP ${ip} added. SRV records created.`);
}


async function deleteNode(index) {
    const nodesData = await fs.readFile('nodes.json', 'utf-8');
    const completeNodes = JSON.parse(nodesData);
    if (index < 0 || index >= completeNodes.length) {
        console.error(`Invalid index: ${index}. No nodes were deleted.`);
        return;
    }
    const nodeToDelete = completeNodes[index];
    await Promise.all([
        cfApi.delete(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDelete.srvId}`),
        cfApi.delete(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDelete.metricsSrvId}`),
        cfApi.delete(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDelete.aRecordId}`),
        cfApi.delete(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDelete.cnameId}`),
    ]);
    completeNodes.splice(index, 1);
    await fs.writeFile('nodes.json', JSON.stringify(completeNodes, null, 2));
    console.log(`Node ${nodeToDelete.name} deleted successfully.`);
}

async function detailNode(index) {
    const nodesData = await fs.readFile('nodes.json', 'utf-8');
    const completeNodes = JSON.parse(nodesData);
    if (index < 0 || index >= completeNodes.length) {
        console.error(`Invalid index: ${index}.`);
        return;
    }
    const nodeToDetail = completeNodes[index];
    const details = await Promise.all([
        cfApi.get(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDetail.srvId}`),
        cfApi.get(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDetail.metricsSrvId}`),
        cfApi.get(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDetail.aRecordId}`),
        cfApi.get(`/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records/${nodeToDetail.cnameId}`),
    ]);
    console.log(details.map(detail => detail.data.result));
}

const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
});

const ask = (question) => new Promise(resolve => readline.question(question, resolve));

async function main() {
    let running = true;

    while (running) {
        console.log("\nAvailable actions:\n- list\n- add\n- delete\n- detail\n- exit");
        const action = await ask("Enter action: ");

        switch (action.toLowerCase()) {
            case 'list':
                await listNodes();
                break;
            case 'add':
                const ip = await ask("Enter IP: ");
                const hostname = await ask("Enter Hostname: ");
                const region = await ask("Enter Region: ");
                const { aRecords, cnameRecords, srvRecords } = await fetchDnsRecords();
                const { regionIterations } = await populateRelayNodes(srvRecords, aRecords, cnameRecords);
                await addNode(ip, hostname, region, regionIterations);
                break;
            case 'delete':
                await listNodes(); // Show list for reference
                const indexToDelete = await ask("Enter index of node to delete: ");
                await deleteNode(parseInt(indexToDelete));
                break;
            case 'detail':
                await listNodes(); // Show list for reference
                const indexToDetail = await ask("Enter index of node to detail: ");
                await detailNode(parseInt(indexToDetail));
                break;
            case 'exit':
                running = false;
                console.log("Exiting program.");
                break;
            default:
                console.log("Invalid action. Please enter 'list', 'add', 'delete', 'detail', or 'exit'.");
        }
    }

    readline.close();
}

main().catch(error => {
    console.error("An error occurred:", error);
    readline.close();
});


