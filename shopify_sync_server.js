const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const converter = require("./odoo_matrixify_converter.js");

const PORT = Number(process.env.PORT || 3456);
const API_VERSION = "2026-04";
const HOST = process.env.HOST || "0.0.0.0";
const MAX_JSON_BODY_BYTES = 100 * 1024 * 1024;
const jobs = new Map();

const SHOP_QUERY = `
query AppShopInfo {
  shop {
    name
    myshopifyDomain
    currencyCode
  }
}
`;

const FIND_ORDERS_QUERY = `
query FindOrders($query: String!) {
  orders(first: 10, query: $query) {
    nodes {
      id
      name
      sourceIdentifier
      note
      phone
      customAttributes {
        key
        value
      }
    }
  }
}
`;

const CREATE_ORDER_MUTATION = `
mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order {
      id
      name
      sourceIdentifier
    }
    userErrors {
      field
      message
    }
  }
}
`;

const UPDATE_ORDER_MUTATION = `
mutation UpdateOrder($input: OrderInput!) {
  orderUpdate(input: $input) {
    order {
      id
      name
      note
      phone
    }
    userErrors {
      field
      message
    }
  }
}
`;

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
    });
    response.end(body);
}

function sendText(response, statusCode, body, contentType) {
    response.writeHead(statusCode, {
        "Content-Type": contentType || "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
    });
    response.end(body);
}

function sendFile(response, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".html"
        ? "text/html; charset=utf-8"
        : extension === ".js"
            ? "application/javascript; charset=utf-8"
            : extension === ".css"
                ? "text/css; charset=utf-8"
                : "application/octet-stream";

    fs.readFile(filePath, (error, buffer) => {
        if (error) {
            sendText(response, 404, "Not found");
            return;
        }

        response.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": buffer.length
        });
        response.end(buffer);
    });
}

function normalizeShopDomain(input) {
    const raw = String(input || "").trim();
    if (!raw) {
        return "";
    }

    let normalized = raw
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .trim()
        .toLowerCase();

    if (!normalized.endsWith(".myshopify.com")) {
        normalized += ".myshopify.com";
    }

    return normalized;
}

async function readJsonBody(request) {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_JSON_BODY_BYTES) {
            throw new Error("Request body is too large.");
        }
        chunks.push(chunk);
    }

    const body = Buffer.concat(chunks).toString("utf8");
    if (!body) {
        return {};
    }

    return JSON.parse(body);
}

async function shopifyGraphql(shopDomain, accessToken, query, variables) {
    const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken
        },
        body: JSON.stringify({
            query,
            variables: variables || {}
        })
    });

    const text = await response.text();
    let payload;

    try {
        payload = text ? JSON.parse(text) : {};
    } catch (error) {
        throw new Error(`Shopify returned an invalid response (${response.status}).`);
    }

    if (!response.ok) {
        const message = payload && payload.errors
            ? JSON.stringify(payload.errors)
            : `HTTP ${response.status}`;
        throw new Error(`Shopify request failed: ${message}`);
    }

    if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors.map((item) => item.message).join("; "));
    }

    return payload.data;
}

function parseEscapedKeyValueLines(text) {
    const input = String(text || "");
    if (!input.trim()) {
        return [];
    }

    return input
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            let key = "";
            let value = "";
            let separatorIndex = -1;
            let escaping = false;

            for (let index = 0; index < line.length; index += 1) {
                const char = line[index];

                if (escaping) {
                    escaping = false;
                    continue;
                }

                if (char === "\\") {
                    escaping = true;
                    continue;
                }

                if (char === ":") {
                    separatorIndex = index;
                    break;
                }
            }

            if (separatorIndex === -1) {
                key = line;
                value = "";
            } else {
                key = line.slice(0, separatorIndex).trim();
                value = line.slice(separatorIndex + 1).trimStart();
            }

            return {
                key,
                value: unescapeMatrixifyValue(value)
            };
        });
}

function unescapeMatrixifyValue(text) {
    const input = String(text || "");
    let output = "";
    let escaping = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];

        if (escaping) {
            output += char;
            escaping = false;
            continue;
        }

        if (char === "\\") {
            escaping = true;
            continue;
        }

        output += char;
    }

    if (escaping) {
        output += "\\";
    }

    return output;
}

function mapPaymentStatus(value) {
    const normalized = String(value || "").trim().toLowerCase();

    if (!normalized || normalized === "paid") {
        return "PAID";
    }
    if (normalized === "pending") {
        return "PENDING";
    }
    if (normalized === "authorized") {
        return "AUTHORIZED";
    }
    if (normalized === "refunded") {
        return "REFUNDED";
    }
    if (normalized === "partially refunded") {
        return "PARTIALLY_REFUNDED";
    }
    if (normalized === "partially paid") {
        return "PARTIALLY_PAID";
    }
    if (normalized === "voided") {
        return "VOIDED";
    }
    if (normalized === "expired") {
        return "EXPIRED";
    }

    return "PAID";
}

function mapFulfillmentStatus(orderStatus, shippingStatus) {
    const combined = `${orderStatus || ""} ${shippingStatus || ""}`.trim().toLowerCase();
    if (!combined) {
        return null;
    }

    if (combined.includes("delivered") || combined.includes("shipped") || combined.includes("dispatch")) {
        return "FULFILLED";
    }

    return null;
}

function toShopifyDateTime(value, timeZoneOffset) {
    const input = String(value || "").trim();
    if (!input) {
        return null;
    }

    if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
        return input;
    }

    const match = input.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
    if (!match) {
        return null;
    }

    const offset = /^([+-]\d{2}:\d{2}|Z)$/.test(String(timeZoneOffset || "").trim())
        ? String(timeZoneOffset).trim()
        : "+08:00";

    return `${match[1]}T${match[2]}${offset}`;
}

function mergeCustomAttributes(existingAttributes, incomingAttributes) {
    const merged = new Map();

    (existingAttributes || []).forEach((attribute) => {
        if (attribute && attribute.key) {
            merged.set(attribute.key, String(attribute.value || ""));
        }
    });

    (incomingAttributes || []).forEach((attribute) => {
        if (attribute && attribute.key) {
            merged.set(attribute.key, String(attribute.value || ""));
        }
    });

    return Array.from(merged.entries()).map(([key, value]) => ({ key, value }));
}

function mergeNotes(existingNote, incomingNote) {
    const current = String(existingNote || "").trim();
    const next = String(incomingNote || "").trim();

    if (!next) {
        return current;
    }

    if (!current) {
        return next;
    }

    if (current.includes(next)) {
        return current;
    }

    return `${current}\n\n${next}`;
}

function groupRowsByName(matrixifyRows) {
    const grouped = new Map();

    matrixifyRows.forEach((row) => {
        const key = String(row.Name || "").trim();
        if (!key) {
            return;
        }

        if (!grouped.has(key)) {
            grouped.set(key, []);
        }

        grouped.get(key).push(row);
    });

    return grouped;
}

function buildApiImportOrders(csvText, timeZoneOffset) {
    const converted = converter.convertCsvText(csvText, {
        ordersFileName: "Orders.csv",
        mappingFileName: "odoo_to_matrixify_column_mapping.csv"
    });

    const groupedRows = groupRowsByName(converted.matrixifyRows);
    const apiOrders = [];

    groupedRows.forEach((rows, orderReference) => {
        const firstRow = rows[0];
        const currency = String(firstRow.Currency || "SGD").trim() || "SGD";
        const customAttributes = parseEscapedKeyValueLines(firstRow["Additional Details"]);
        const financialStatus = mapPaymentStatus(firstRow["Payment: Status"]);
        const fulfillmentStatus = mapFulfillmentStatus(firstRow["Odoo Order Status"], firstRow["Odoo Shipping Status"]);
        const processedAt = toShopifyDateTime(firstRow["Processed At"], timeZoneOffset);

        const lineItems = rows.map((row) => {
            const lineProperties = parseEscapedKeyValueLines(row["Line: Properties"]);
            const skuProperty = lineProperties.find((property) => property.key === "Odoo SKU");

            const lineItem = {
                title: String(row["Line: Title"] || "Imported Odoo Order").trim() || "Imported Odoo Order",
                quantity: Number.parseInt(String(row["Line: Quantity"] || "1"), 10) || 1,
                requiresShipping: false,
                priceSet: {
                    shopMoney: {
                        amount: String(row["Line: Price"] || "0.00"),
                        currencyCode: currency
                    }
                }
            };

            if (skuProperty && skuProperty.value) {
                lineItem.sku = skuProperty.value;
            }

            if (lineProperties.length) {
                lineItem.properties = lineProperties.map((property) => ({
                    name: property.key,
                    value: property.value
                }));
            }

            return lineItem;
        });

        const orderInput = {
            name: orderReference,
            sourceIdentifier: orderReference,
            currency,
            presentmentCurrency: currency,
            financialStatus,
            note: String(firstRow.Note || "").trim(),
            lineItems,
            customAttributes
        };

        if (firstRow.Phone) {
            orderInput.phone = String(firstRow.Phone).trim();
        }

        if (processedAt) {
            orderInput.processedAt = processedAt;
        }

        if (fulfillmentStatus) {
            orderInput.fulfillmentStatus = fulfillmentStatus;
        }

        apiOrders.push({
            orderReference,
            orderInput,
            convertedRowSample: firstRow
        });
    });

    return {
        converted,
        apiOrders
    };
}

function createImportResultsCsv(results) {
    const headers = [
        "Order Reference",
        "Action",
        "Status",
        "Shopify Order ID",
        "Shopify Order Name",
        "Message"
    ];

    return converter.toCsv(
        results.map((result) => ({
            "Order Reference": result.orderReference,
            "Action": result.action,
            "Status": result.status,
            "Shopify Order ID": result.shopifyOrderId || "",
            "Shopify Order Name": result.shopifyOrderName || "",
            "Message": result.message || ""
        })),
        headers
    );
}

function createJob(stats) {
    const jobId = crypto.randomUUID();
    const job = {
        id: jobId,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stats,
        summary: {
            totalOrders: 0,
            processedOrders: 0,
            createdOrders: 0,
            updatedOrders: 0,
            failedOrders: 0
        },
        warnings: [],
        results: [],
        recentResults: []
    };

    jobs.set(jobId, job);
    return job;
}

function appendJobResult(job, result) {
    job.results.push(result);
    job.recentResults.push(result);

    if (job.recentResults.length > 25) {
        job.recentResults.shift();
    }

    job.summary.processedOrders += 1;
    if (result.status === "created") {
        job.summary.createdOrders += 1;
    } else if (result.status === "updated") {
        job.summary.updatedOrders += 1;
    } else if (result.status === "failed") {
        job.summary.failedOrders += 1;
    }
    job.updatedAt = new Date().toISOString();
}

async function connectShop(payload) {
    const shopDomain = normalizeShopDomain(payload.shopDomain);
    const accessToken = String(payload.accessToken || "").trim();

    if (!shopDomain) {
        throw new Error("Enter a valid Shopify domain.");
    }

    if (!accessToken) {
        throw new Error("Enter a valid Shopify Admin API access token.");
    }

    const data = await shopifyGraphql(shopDomain, accessToken, SHOP_QUERY);
    return {
        shopDomain,
        shop: data.shop
    };
}

async function findExistingOrder(shopDomain, accessToken, orderReference) {
    const query = `"${String(orderReference || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
    const data = await shopifyGraphql(shopDomain, accessToken, FIND_ORDERS_QUERY, { query });
    const nodes = data && data.orders && Array.isArray(data.orders.nodes) ? data.orders.nodes : [];
    return nodes.find((node) => node.name === orderReference || node.sourceIdentifier === orderReference) || null;
}

async function createOrder(shopDomain, accessToken, orderInput) {
    const data = await shopifyGraphql(shopDomain, accessToken, CREATE_ORDER_MUTATION, {
        order: orderInput,
        options: {
            inventoryBehaviour: "BYPASS",
            sendReceipt: false,
            sendFulfillmentReceipt: false
        }
    });

    const payload = data.orderCreate;
    if (payload.userErrors && payload.userErrors.length) {
        throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    }

    return payload.order;
}

async function updateOrder(shopDomain, accessToken, existingOrder, orderInput) {
    const mergedAttributes = mergeCustomAttributes(existingOrder.customAttributes, orderInput.customAttributes);
    const mergedNote = mergeNotes(existingOrder.note, orderInput.note);

    const input = {
        id: existingOrder.id
    };

    if (mergedNote) {
        input.note = mergedNote;
    }

    if (orderInput.phone) {
        input.phone = orderInput.phone;
    }

    if (mergedAttributes.length) {
        input.customAttributes = mergedAttributes;
    }

    const data = await shopifyGraphql(shopDomain, accessToken, UPDATE_ORDER_MUTATION, { input });
    const payload = data.orderUpdate;
    if (payload.userErrors && payload.userErrors.length) {
        throw new Error(payload.userErrors.map((item) => item.message).join("; "));
    }

    return payload.order;
}

async function runImportJob(job, payload) {
    job.status = "running";
    job.updatedAt = new Date().toISOString();

    try {
        const connection = await connectShop(payload);
        const importBuild = buildApiImportOrders(payload.csvText, payload.timeZoneOffset);
        const apiOrders = importBuild.apiOrders;

        job.summary.totalOrders = apiOrders.length;
        job.stats = importBuild.converted.stats;

        job.warnings = [
            "Existing Shopify orders are updated only with note, phone, and custom attributes. Shopify line items and processed date are not rewritten for existing orders."
        ];

        for (const apiOrder of apiOrders) {
            try {
                const existingOrder = await findExistingOrder(connection.shopDomain, payload.accessToken, apiOrder.orderReference);

                if (existingOrder) {
                    const updatedOrder = await updateOrder(connection.shopDomain, payload.accessToken, existingOrder, apiOrder.orderInput);
                    appendJobResult(job, {
                        orderReference: apiOrder.orderReference,
                        action: "UPDATE",
                        status: "updated",
                        shopifyOrderId: updatedOrder.id,
                        shopifyOrderName: updatedOrder.name,
                        message: "Updated note, phone, and custom attributes on the existing Shopify order."
                    });
                } else {
                    const createdOrder = await createOrder(connection.shopDomain, payload.accessToken, apiOrder.orderInput);
                    appendJobResult(job, {
                        orderReference: apiOrder.orderReference,
                        action: "CREATE",
                        status: "created",
                        shopifyOrderId: createdOrder.id,
                        shopifyOrderName: createdOrder.name,
                        message: "Created a new Shopify order from the uploaded Odoo CSV."
                    });
                }
            } catch (error) {
                appendJobResult(job, {
                    orderReference: apiOrder.orderReference,
                    action: "CREATE_OR_UPDATE",
                    status: "failed",
                    shopifyOrderId: "",
                    shopifyOrderName: "",
                    message: error.message
                });
            }
        }

        job.status = "completed";
        job.updatedAt = new Date().toISOString();
    } catch (error) {
        job.status = "failed";
        job.error = error.message;
        job.updatedAt = new Date().toISOString();
    }
}

function getJobPayload(job) {
    return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        stats: job.stats,
        summary: job.summary,
        warnings: job.warnings,
        error: job.error || "",
        recentResults: job.recentResults
    };
}

async function handleApiRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/connect") {
        try {
            const payload = await readJsonBody(request);
            const connection = await connectShop(payload);
            sendJson(response, 200, {
                ok: true,
                shopDomain: connection.shopDomain,
                shop: connection.shop
            });
        } catch (error) {
            sendJson(response, 400, {
                ok: false,
                error: error.message
            });
        }
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/import/start") {
        try {
            const payload = await readJsonBody(request);
            if (!payload.csvText || !String(payload.csvText).trim()) {
                throw new Error("Upload an Odoo CSV before starting the import.");
            }

            const preview = buildApiImportOrders(payload.csvText, payload.timeZoneOffset);
            const job = createJob(preview.converted.stats);
            job.summary.totalOrders = preview.apiOrders.length;
            runImportJob(job, payload).catch((error) => {
                job.status = "failed";
                job.error = error.message;
                job.updatedAt = new Date().toISOString();
            });

            sendJson(response, 202, {
                ok: true,
                job: getJobPayload(job)
            });
        } catch (error) {
            sendJson(response, 400, {
                ok: false,
                error: error.message
            });
        }
        return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const jobId = parts[2];
        const job = jobs.get(jobId);

        if (!job) {
            sendJson(response, 404, {
                ok: false,
                error: "Import job not found."
            });
            return;
        }

        if (parts.length === 4 && parts[3] === "results.csv") {
            const csv = createImportResultsCsv(job.results);
            response.writeHead(200, {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${job.id}.shopify-import-results.csv"`,
                "Content-Length": Buffer.byteLength(csv)
            });
            response.end(csv);
            return;
        }

        sendJson(response, 200, {
            ok: true,
            job: getJobPayload(job)
        });
        return;
    }

    sendJson(response, 404, {
        ok: false,
        error: "API route not found."
    });
}

function handleStaticRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
        sendFile(response, path.join(__dirname, "frontend_pages.html"));
        return;
    }

    if (url.pathname === "/migration-tool") {
        sendFile(response, path.join(__dirname, "odoo_matrixify_browser.html"));
        return;
    }

    if (url.pathname === "/admin") {
        sendFile(response, path.join(__dirname, "admin_panel.html"));
        return;
    }

    if (url.pathname === "/odoo_matrixify_converter.js") {
        sendFile(response, path.join(__dirname, "odoo_matrixify_converter.js"));
        return;
    }

    sendText(response, 404, "Not found");
}

const server = http.createServer((request, response) => {
    if (request.url.startsWith("/api/")) {
        handleApiRequest(request, response).catch((error) => {
            sendJson(response, 500, {
                ok: false,
                error: error.message
            });
        });
        return;
    }

    handleStaticRequest(request, response);
});

server.listen(PORT, HOST, () => {
    process.stdout.write(`Odoo Shopify sync app running at http://${HOST}:${PORT}\n`);
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        process.stdout.write(`Port ${PORT} is already in use. Open http://${HOST}:${PORT}\n`);
        process.exit(0);
        return;
    }

    throw error;
});
