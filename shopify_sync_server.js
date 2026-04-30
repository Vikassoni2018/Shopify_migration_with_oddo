const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const converter = require("./odoo_matrixify_converter.js");

loadEnvFile(path.join(__dirname, ".env"));

const API_VERSION = "2026-04";
const MAX_JSON_BODY_BYTES = 100 * 1024 * 1024;
const FREE_ORDER_LIMIT = 10;
const PER_THOUSAND_PRICE_USD_CENTS = 1000;
const FULL_MIGRATION_PRICE_USD_CENTS = 10000;
const DEFAULT_LOCAL_PORT = 3456;
const PORT = Number.parseInt(String(process.env.PORT || DEFAULT_LOCAL_PORT), 10) || DEFAULT_LOCAL_PORT;
const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const DEFAULT_LOCAL_API_BASE_URL = normalizeBaseUrl(process.env.LOCAL_API_BASE_URL || `http://127.0.0.1:${PORT}`);
const RUNTIME_SESSION_SECRET = crypto.randomBytes(32).toString("hex");
const CONFIG = Object.freeze({
    appName: String(process.env.APP_NAME || "Shopify Migration with Odoo").trim() || "Shopify Migration with Odoo",
    host: HOST,
    port: PORT,
    nodeEnv: String(process.env.NODE_ENV || "development").trim() || "development",
    publicBaseUrl: normalizeBaseUrl(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || ""),
    defaultApiBaseUrl: normalizeBaseUrl(process.env.DEFAULT_API_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || ""),
    defaultTimeZoneOffset: sanitizeTimeZoneOffset(process.env.DEFAULT_TIMEZONE_OFFSET || "+08:00"),
    localApiBaseUrl: DEFAULT_LOCAL_API_BASE_URL,
    adminEmail: String(process.env.ADMIN_EMAIL || "").trim(),
    adminPassword: String(process.env.ADMIN_PASSWORD || ""),
    sessionSecret: String(process.env.APP_SESSION_SECRET || RUNTIME_SESSION_SECRET),
    stripePublishableKey: String(process.env.STRIPE_PUBLISHABLE_KEY || "").trim(),
    stripeSecretKey: String(process.env.STRIPE_SECRET_KEY || "").trim(),
    stripeWebhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || "").trim(),
    renderExternalUrl: normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL || "")
});
const jobs = new Map();
const entitlements = new Map();

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

function loadEnvFile(filePath) {
    let fileText = "";

    try {
        fileText = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }

    fileText.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return;
        }

        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) {
            return;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
            return;
        }

        let value = trimmed.slice(separatorIndex + 1).trim();
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        process.env[key] = value.replace(/\\n/g, "\n");
    });
}

function normalizeBaseUrl(input) {
    const raw = String(input || "").trim();
    if (!raw) {
        return "";
    }

    return raw.replace(/\/+$/, "");
}

function sanitizeTimeZoneOffset(input) {
    const value = String(input || "").trim();
    return /^([+-]\d{2}:\d{2}|Z)$/.test(value) ? value : "+08:00";
}

function buildCommonHeaders(contentType, contentLength, extraHeaders) {
    return Object.assign({
        "Content-Type": contentType,
        "Content-Length": contentLength,
        "Referrer-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff"
    }, extraHeaders || {});
}

function buildApiHeaders(contentType, contentLength, extraHeaders) {
    return buildCommonHeaders(contentType, contentLength, Object.assign({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Cache-Control": "no-store"
    }, extraHeaders || {}));
}

function getRequestOrigin(request) {
    const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const host = forwardedHost || String(request.headers.host || "").trim();
    const protocol = forwardedProto || "http";

    if (!host) {
        return "";
    }

    return normalizeBaseUrl(`${protocol}://${host}`);
}

function resolvePublicBaseUrl(request) {
    return CONFIG.publicBaseUrl || CONFIG.renderExternalUrl || getRequestOrigin(request) || CONFIG.localApiBaseUrl;
}

function resolveDefaultApiBaseUrl(request) {
    return CONFIG.defaultApiBaseUrl || resolvePublicBaseUrl(request) || CONFIG.localApiBaseUrl;
}

function buildRuntimeConfig(request) {
    return {
        appName: CONFIG.appName,
        environment: CONFIG.nodeEnv,
        publicBaseUrl: resolvePublicBaseUrl(request),
        defaultApiBaseUrl: resolveDefaultApiBaseUrl(request),
        localApiBaseUrl: CONFIG.localApiBaseUrl,
        defaultTimeZoneOffset: CONFIG.defaultTimeZoneOffset,
        renderExternalUrl: CONFIG.renderExternalUrl,
        shopifyApiVersion: API_VERSION,
        features: {
            adminConfigured: isAdminConfigured(),
            stripeCheckoutConfigured: Boolean(CONFIG.stripePublishableKey && CONFIG.stripeSecretKey),
            stripeWebhookConfigured: Boolean(CONFIG.stripeWebhookSecret)
        }
    };
}

function serializeRuntimeConfigScript(request) {
    const payload = JSON.stringify(buildRuntimeConfig(request))
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");

    return `window.APP_CONFIG = Object.freeze(${payload});\n`;
}

function injectRuntimeConfig(htmlText) {
    const runtimeScriptTag = "<script src=\"/app-config.js\"></script>";
    if (htmlText.includes(runtimeScriptTag)) {
        return htmlText;
    }

    if (htmlText.includes("</head>")) {
        return htmlText.replace("</head>", `    ${runtimeScriptTag}\n</head>`);
    }

    return `${runtimeScriptTag}\n${htmlText}`;
}

function sendJson(response, statusCode, payload, extraHeaders) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, buildApiHeaders("application/json; charset=utf-8", Buffer.byteLength(body), extraHeaders));
    response.end(body);
}

function sendText(response, statusCode, body, contentType, extraHeaders) {
    response.writeHead(statusCode, buildCommonHeaders(contentType || "text/plain; charset=utf-8", Buffer.byteLength(body), extraHeaders));
    response.end(body);
}

function sendFile(response, request, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".html"
        ? "text/html; charset=utf-8"
        : extension === ".js"
            ? "application/javascript; charset=utf-8"
            : extension === ".css"
                ? "text/css; charset=utf-8"
                : extension === ".svg"
                    ? "image/svg+xml"
                    : "application/octet-stream";

    fs.readFile(filePath, extension === ".html" ? "utf8" : null, (error, fileContents) => {
        if (error) {
            sendText(response, 404, "Not found");
            return;
        }

        if (extension === ".html") {
            const body = injectRuntimeConfig(fileContents);
            sendText(response, 200, body, contentType, {
                "Cache-Control": "no-store"
            });
            return;
        }

        response.writeHead(200, buildCommonHeaders(contentType, fileContents.length, {
            "Cache-Control": extension === ".js" || extension === ".css" || extension === ".svg"
                ? "public, max-age=3600"
                : "public, max-age=300"
        }));
        response.end(fileContents);
    });
}

function isAdminConfigured() {
    return Boolean(CONFIG.adminEmail && CONFIG.adminPassword);
}

function maskConfiguredValue(value) {
    const text = String(value || "");
    if (!text) {
        return "";
    }

    if (text.length <= 8) {
        return `${text.slice(0, 2)}***`;
    }

    return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function buildAdminConfigStatus() {
    return {
        appName: CONFIG.appName,
        environment: CONFIG.nodeEnv,
        publicBaseUrl: CONFIG.publicBaseUrl || "",
        defaultApiBaseUrl: CONFIG.defaultApiBaseUrl || "",
        defaultTimeZoneOffset: CONFIG.defaultTimeZoneOffset,
        adminConfigured: isAdminConfigured(),
        adminEmail: CONFIG.adminEmail || "",
        stripePublishableKeyConfigured: Boolean(CONFIG.stripePublishableKey),
        stripePublishableKeyPreview: maskConfiguredValue(CONFIG.stripePublishableKey),
        stripeSecretKeyConfigured: Boolean(CONFIG.stripeSecretKey),
        stripeWebhookSecretConfigured: Boolean(CONFIG.stripeWebhookSecret)
    };
}

function buildAdminOverviewPayload() {
    const allJobs = Array.from(jobs.values()).sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
        const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
        return rightTime - leftTime;
    });

    const stores = Array.from(entitlements.values()).sort((left, right) => {
        const leftLast = left.transactions && left.transactions.length
            ? Date.parse(left.transactions[left.transactions.length - 1].grantedAt || 0)
            : 0;
        const rightLast = right.transactions && right.transactions.length
            ? Date.parse(right.transactions[right.transactions.length - 1].grantedAt || 0)
            : 0;
        return rightLast - leftLast;
    }).map((entitlement) => ({
        shopDomain: entitlement.shopDomain,
        paidOrderQuota: entitlement.paidOrderQuota || 0,
        fullMigrationUnlocked: Boolean(entitlement.fullMigrationUnlocked),
        transactionCount: Array.isArray(entitlement.transactions) ? entitlement.transactions.length : 0,
        lastTransactionAt: Array.isArray(entitlement.transactions) && entitlement.transactions.length
            ? entitlement.transactions[entitlement.transactions.length - 1].grantedAt
            : ""
    }));

    const payments = Array.from(entitlements.values()).flatMap((entitlement) => (
        Array.isArray(entitlement.transactions) ? entitlement.transactions.map((transaction) => ({
            shopDomain: entitlement.shopDomain,
            transactionId: transaction.transactionId || "",
            eventType: transaction.eventType || "",
            plan: transaction.plan || "",
            grantedAt: transaction.grantedAt || ""
        })) : []
    )).sort((left, right) => Date.parse(right.grantedAt || 0) - Date.parse(left.grantedAt || 0));

    return {
        apiVersion: API_VERSION,
        configStatus: buildAdminConfigStatus(),
        metrics: {
            totalJobs: allJobs.length,
            completedJobs: allJobs.filter((job) => job.status === "completed").length,
            processingJobs: allJobs.filter((job) => job.status === "processing" || job.status === "queued").length,
            failedJobs: allJobs.filter((job) => job.status === "failed").length,
            activeStoreEntitlements: stores.length,
            totalTransactions: payments.length,
            fullUnlocks: stores.filter((store) => store.fullMigrationUnlocked).length,
            totalPaidQuota: stores.reduce((sum, store) => sum + (store.paidOrderQuota || 0), 0)
        },
        recentJobs: allJobs.slice(0, 12).map((job) => getJobPayload(job)),
        stores,
        payments: payments.slice(0, 24)
    };
}

function parseCookies(request) {
    const header = String(request.headers.cookie || "");
    if (!header) {
        return {};
    }

    return header.split(";").reduce((cookies, cookiePart) => {
        const separatorIndex = cookiePart.indexOf("=");
        if (separatorIndex === -1) {
            return cookies;
        }

        const key = cookiePart.slice(0, separatorIndex).trim();
        const value = cookiePart.slice(separatorIndex + 1).trim();
        if (key) {
            cookies[key] = decodeURIComponent(value);
        }
        return cookies;
    }, {});
}

function encodeSignedPayload(payload) {
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = crypto
        .createHmac("sha256", CONFIG.sessionSecret)
        .update(encodedPayload)
        .digest("base64url");

    return `${encodedPayload}.${signature}`;
}

function decodeSignedPayload(token) {
    const value = String(token || "");
    const separatorIndex = value.lastIndexOf(".");
    if (separatorIndex === -1) {
        return null;
    }

    const encodedPayload = value.slice(0, separatorIndex);
    const signature = value.slice(separatorIndex + 1);
    const expectedSignature = crypto
        .createHmac("sha256", CONFIG.sessionSecret)
        .update(encodedPayload)
        .digest("base64url");

    const receivedBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
        return null;
    }

    try {
        return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch (error) {
        return null;
    }
}

function serializeCookie(name, value, options) {
    const settings = options || {};
    const parts = [`${name}=${encodeURIComponent(value)}`];

    if (settings.maxAge != null) {
        parts.push(`Max-Age=${Math.max(0, Number(settings.maxAge) || 0)}`);
    }
    if (settings.expires instanceof Date) {
        parts.push(`Expires=${settings.expires.toUTCString()}`);
    }

    parts.push(`Path=${settings.path || "/"}`);
    parts.push(`SameSite=${settings.sameSite || "Lax"}`);

    if (settings.httpOnly !== false) {
        parts.push("HttpOnly");
    }

    if (settings.secure) {
        parts.push("Secure");
    }

    return parts.join("; ");
}

function createAdminSessionCookie(email) {
    const token = encodeSignedPayload({
        email,
        issuedAt: new Date().toISOString()
    });

    return serializeCookie("admin_session", token, {
        httpOnly: true,
        maxAge: 60 * 60 * 8,
        path: "/",
        sameSite: "Lax",
        secure: CONFIG.nodeEnv === "production"
    });
}

function clearAdminSessionCookie() {
    return serializeCookie("admin_session", "", {
        httpOnly: true,
        expires: new Date(0),
        maxAge: 0,
        path: "/",
        sameSite: "Lax",
        secure: CONFIG.nodeEnv === "production"
    });
}

function getAdminSession(request) {
    if (!isAdminConfigured()) {
        return null;
    }

    const cookies = parseCookies(request);
    const session = decodeSignedPayload(cookies.admin_session || "");
    if (!session || session.email !== CONFIG.adminEmail) {
        return null;
    }

    return session;
}

function passwordsMatch(left, right) {
    const leftBuffer = Buffer.from(String(left || ""), "utf8");
    const rightBuffer = Buffer.from(String(right || ""), "utf8");
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyStripeWebhookSignature(rawBody, signatureHeader) {
    if (!CONFIG.stripeWebhookSecret) {
        return;
    }

    const elements = String(signatureHeader || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    let timestamp = "";
    const signatures = [];

    elements.forEach((element) => {
        const separatorIndex = element.indexOf("=");
        if (separatorIndex === -1) {
            return;
        }

        const key = element.slice(0, separatorIndex).trim();
        const value = element.slice(separatorIndex + 1).trim();

        if (key === "t") {
            timestamp = value;
        } else if (key === "v1") {
            signatures.push(value);
        }
    });

    if (!timestamp || !signatures.length) {
        throw new Error("Invalid Stripe-Signature header.");
    }

    const timestampNumber = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampNumber)) {
        throw new Error("Invalid Stripe webhook timestamp.");
    }

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampNumber);
    if (ageSeconds > 300) {
        throw new Error("Stripe webhook timestamp is outside the allowed tolerance.");
    }

    const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
    const expectedSignature = crypto
        .createHmac("sha256", CONFIG.stripeWebhookSecret)
        .update(signedPayload, "utf8")
        .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const hasMatch = signatures.some((signature) => {
        const receivedBuffer = Buffer.from(signature, "utf8");
        return receivedBuffer.length === expectedBuffer.length
            && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
    });

    if (!hasMatch) {
        throw new Error("Stripe webhook signature verification failed.");
    }
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

async function readRawBody(request) {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_JSON_BODY_BYTES) {
            throw new Error("Request body is too large.");
        }
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

function parseCsvUploadHeaders(request) {
    return {
        shopDomain: normalizeShopDomain(request.headers["x-shop-domain"]),
        accessToken: String(request.headers["x-shopify-access-token"] || "").trim()
    };
}

function getShopEntitlement(shopDomain) {
    const key = normalizeShopDomain(shopDomain);
    return entitlements.get(key) || {
        shopDomain: key,
        paidOrderQuota: 0,
        fullMigrationUnlocked: false,
        transactions: []
    };
}

function setShopEntitlement(shopDomain, entitlement) {
    entitlements.set(normalizeShopDomain(shopDomain), entitlement);
}

function computeAdditionalPaidOrders(totalOrders) {
    if (totalOrders <= FREE_ORDER_LIMIT) {
        return 0;
    }
    return totalOrders - FREE_ORDER_LIMIT;
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

async function shopifyRest(shopDomain, accessToken, method, endpoint, payload) {
    const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}${endpoint}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken
        },
        body: payload ? JSON.stringify(payload) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error((data && data.errors && JSON.stringify(data.errors)) || `HTTP ${response.status}`);
    }
    return data;
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

function parseSimpleCsv(csvText) {
    const text = String(csvText || "");
    const rows = [];
    let row = [];
    let value = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (char === "\"") {
            if (inQuotes && text[index + 1] === "\"") {
                value += "\"";
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            row.push(value);
            value = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !inQuotes) {
            if (char === "\r" && text[index + 1] === "\n") {
                index += 1;
            }
            row.push(value);
            if (row.some((cell) => String(cell || "").length > 0)) {
                rows.push(row);
            }
            row = [];
            value = "";
            continue;
        }

        value += char;
    }

    row.push(value);
    if (row.some((cell) => String(cell || "").length > 0)) {
        rows.push(row);
    }

    if (!rows.length) {
        return [];
    }

    const headers = rows[0].map((header) => String(header || "").trim());
    return rows.slice(1).map((cells) => {
        const output = {};
        headers.forEach((header, columnIndex) => {
            output[header] = cells[columnIndex] || "";
        });
        return output;
    });
}

function parseWooImageUrls(value) {
    const input = String(value || "").trim();
    if (!input) {
        return [];
    }

    const urls = input
        .split(/\s*,\s*/)
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .filter((item) => /^https?:\/\//i.test(item));

    return Array.from(new Set(urls));
}

async function ensureProductImages(shopDomain, accessToken, productId, imageUrls, altText) {
    if (!productId || !Array.isArray(imageUrls) || !imageUrls.length) {
        return {
            added: 0,
            skipped: 0
        };
    }

    const existingProduct = await shopifyRest(shopDomain, accessToken, "GET", `/products/${productId}.json?fields=id,images`);
    const existingImages = existingProduct && existingProduct.product && Array.isArray(existingProduct.product.images)
        ? existingProduct.product.images
        : [];
    const existingSources = new Set(
        existingImages
            .map((image) => String(image && image.src ? image.src : "").trim())
            .filter(Boolean)
    );

    let added = 0;
    let skipped = 0;

    for (const imageUrl of imageUrls) {
        if (existingSources.has(imageUrl)) {
            skipped += 1;
            continue;
        }

        await shopifyRest(shopDomain, accessToken, "POST", `/products/${productId}/images.json`, {
            image: {
                src: imageUrl,
                alt: altText || null
            }
        });
        existingSources.add(imageUrl);
        added += 1;
    }

    return {
        added,
        skipped
    };
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
        : CONFIG.defaultTimeZoneOffset;

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
    const requestOrigin = getRequestOrigin(request) || `http://${request.headers.host || `127.0.0.1:${PORT}`}`;
    const url = new URL(request.url, requestOrigin);

    if (request.method === "OPTIONS") {
        response.writeHead(204, buildApiHeaders("text/plain; charset=utf-8", 0));
        response.end();
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
            ok: true,
            status: "healthy",
            appName: CONFIG.appName,
            environment: CONFIG.nodeEnv,
            publicBaseUrl: resolvePublicBaseUrl(request),
            defaultApiBaseUrl: resolveDefaultApiBaseUrl(request)
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, {
            ok: true,
            config: buildRuntimeConfig(request)
        });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/login") {
        try {
            if (!isAdminConfigured()) {
                throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env or Render environment variables first.");
            }

            const payload = await readJsonBody(request);
            const email = String(payload.email || "").trim();
            const password = String(payload.password || "");
            if (!email || !password) {
                throw new Error("Email and password are required.");
            }

            if (email !== CONFIG.adminEmail || !passwordsMatch(password, CONFIG.adminPassword)) {
                throw new Error("Invalid admin credentials.");
            }

            sendJson(response, 200, {
                ok: true,
                authenticated: true,
                admin: {
                    email: CONFIG.adminEmail
                },
                configStatus: buildAdminConfigStatus()
            }, {
                "Set-Cookie": createAdminSessionCookie(CONFIG.adminEmail)
            });
        } catch (error) {
            sendJson(response, 401, {
                ok: false,
                error: error.message
            });
        }
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
        sendJson(response, 200, {
            ok: true,
            authenticated: false
        }, {
            "Set-Cookie": clearAdminSessionCookie()
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/session") {
        const session = getAdminSession(request);
        sendJson(response, 200, {
            ok: true,
            authenticated: Boolean(session),
            admin: session ? { email: session.email } : null,
            adminConfigured: isAdminConfigured(),
            configStatus: session ? buildAdminConfigStatus() : null
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/overview") {
        const session = getAdminSession(request);
        if (!session) {
            sendJson(response, 401, {
                ok: false,
                error: "Admin authentication required."
            });
            return;
        }

        sendJson(response, 200, {
            ok: true,
            authenticated: true,
            admin: {
                email: session.email
            },
            overview: buildAdminOverviewPayload()
        });
        return;
    }

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
            const selectedPlan = String(payload.selectedPlan || "free").toLowerCase();
            const shopDomain = normalizeShopDomain(payload.shopDomain);
            const entitlement = getShopEntitlement(shopDomain);
            const additionalPaidOrders = computeAdditionalPaidOrders(preview.apiOrders.length);

            if (additionalPaidOrders > 0 && !entitlement.fullMigrationUnlocked) {
                const remainingQuota = Math.max(0, entitlement.paidOrderQuota || 0);
                if (selectedPlan !== "per_1000" && selectedPlan !== "full") {
                    throw new Error("Payment required after 10 orders. Select plan per_1000 or full.");
                }

                if (selectedPlan === "per_1000" && remainingQuota < additionalPaidOrders) {
                    throw new Error(`Payment required. Need quota for ${additionalPaidOrders} additional orders, but only ${remainingQuota} remaining.`);
                }
            }

            const job = createJob(preview.converted.stats);
            job.summary.totalOrders = preview.apiOrders.length;
            job.payment = {
                selectedPlan,
                freeOrderLimit: FREE_ORDER_LIMIT,
                additionalPaidOrders
            };
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

    if (request.method === "POST" && url.pathname === "/api/payments/quote") {
        try {
            const payload = await readJsonBody(request);
            const totalOrders = Number.parseInt(String(payload.totalOrders || "0"), 10) || 0;
            const additionalPaidOrders = computeAdditionalPaidOrders(totalOrders);
            const blocks = Math.max(1, Math.ceil(additionalPaidOrders / 1000));
            sendJson(response, 200, {
                ok: true,
                pricing: {
                    freeTierLimit: FREE_ORDER_LIMIT,
                    perThousandUsd: PER_THOUSAND_PRICE_USD_CENTS / 100,
                    fullMigrationUsd: FULL_MIGRATION_PRICE_USD_CENTS / 100
                },
                quote: {
                    totalOrders,
                    freeOrders: Math.min(totalOrders, FREE_ORDER_LIMIT),
                    additionalPaidOrders,
                    perThousandBlocks: additionalPaidOrders ? blocks : 0,
                    perThousandTotalUsd: additionalPaidOrders ? blocks * (PER_THOUSAND_PRICE_USD_CENTS / 100) : 0
                }
            });
        } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message });
        }
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/payments/webhook") {
        try {
            const rawBody = await readRawBody(request);
            verifyStripeWebhookSignature(rawBody, request.headers["stripe-signature"]);
            const event = JSON.parse(rawBody.toString("utf8"));
            const eventType = String(event.type || "");
            if (eventType !== "checkout.session.completed" && eventType !== "payment_intent.succeeded") {
                sendJson(response, 200, { ok: true, ignored: true });
                return;
            }

            const metadata = (event.data && event.data.object && event.data.object.metadata) || {};
            const shopDomain = normalizeShopDomain(metadata.shopDomain);
            const plan = String(metadata.plan || "").toLowerCase();
            const transactionId = String((event.data && event.data.object && event.data.object.id) || event.id || "");
            const entitlement = getShopEntitlement(shopDomain);

            if (plan === "full") {
                entitlement.fullMigrationUnlocked = true;
            } else if (plan === "per_1000") {
                entitlement.paidOrderQuota += 1000;
            }

            entitlement.transactions.push({
                transactionId,
                eventType,
                plan,
                grantedAt: new Date().toISOString()
            });
            setShopEntitlement(shopDomain, entitlement);

            sendJson(response, 200, { ok: true, entitlement });
        } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message });
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
            response.writeHead(200, buildApiHeaders("text/csv; charset=utf-8", Buffer.byteLength(csv), {
                "Content-Disposition": `attachment; filename="${job.id}.shopify-import-results.csv"`
            }));
            response.end(csv);
            return;
        }

        sendJson(response, 200, {
            ok: true,
            job: getJobPayload(job)
        });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/products/sync") {
        try {
            const body = await readJsonBody(request);
            const shopDomain = normalizeShopDomain(body.shopDomain);
            const accessToken = String(body.accessToken || "").trim();
            const products = Array.isArray(body.products) ? body.products : [];
            if (!shopDomain || !accessToken || !products.length) {
                throw new Error("shopDomain, accessToken, and products are required.");
            }
            const summary = { created: 0, updated: 0, failed: 0 };
            for (const row of products) {
                try {
                    const handle = String(row.Name || "product").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                    const search = await shopifyGraphql(shopDomain, accessToken, `query($query: String!){products(first:1, query:$query){nodes{id handle}}}`, { query: `handle:${handle}` });
                    const existing = search && search.products && search.products.nodes && search.products.nodes[0];
                    const productPayload = {
                        product: {
                            title: row.Name || "Untitled",
                            body_html: row.Description || row["Short description"] || "",
                            handle: handle,
                            tags: [row.Categories, row.Tags].filter(Boolean).join(", "),
                            variants: [{ sku: row.SKU || "", price: row["Sale price"] || row["Regular price"] || "0", compare_at_price: row["Regular price"] || null, inventory_quantity: Number(row.Stock || 0) }]
                        }
                    };
                    if (existing && existing.id) {
                        const numericId = String(existing.id).split("/").pop();
                        await shopifyRest(shopDomain, accessToken, "PUT", `/products/${numericId}.json`, { product: { id: Number(numericId), ...productPayload.product } });
                        summary.updated += 1;
                    } else {
                        await shopifyRest(shopDomain, accessToken, "POST", "/products.json", productPayload);
                        summary.created += 1;
                    }
                } catch (error) {
                    summary.failed += 1;
                }
            }
            sendJson(response, 200, { ok: true, summary });
        } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message });
        }
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/woocommerce/shopify-sync-products") {
        try {
            const contentType = String(request.headers["content-type"] || "").toLowerCase();
            let shopDomain = "";
            let accessToken = "";
            let csvText = "";

            if (contentType.includes("application/json")) {
                const body = await readJsonBody(request);
                shopDomain = normalizeShopDomain(body.shopDomain);
                accessToken = String(body.accessToken || "").trim();
                csvText = String(body.csvText || "");
            } else {
                const uploadHeaders = parseCsvUploadHeaders(request);
                const rawBody = await readRawBody(request);
                shopDomain = uploadHeaders.shopDomain;
                accessToken = uploadHeaders.accessToken;
                csvText = rawBody.toString("utf8");
            }

            const products = parseSimpleCsv(csvText);
            if (!shopDomain || !accessToken || !products.length) {
                throw new Error("shopDomain, accessToken, and csvText are required.");
            }

            const results = [];
            const summary = {
                created: 0,
                updated: 0,
                failed: 0
            };
            for (const row of products) {
                const title = row.Name || row.Title || "Untitled";
                const handle = String(title || row.SKU || "product")
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "");
                const imageUrls = parseWooImageUrls(row.Images);
                try {
                    const search = await shopifyGraphql(shopDomain, accessToken, `query($query: String!){products(first:1, query:$query){nodes{id}}}`, { query: `handle:${handle}` });
                    const existing = search && search.products && search.products.nodes && search.products.nodes[0];
                    const productPayload = {
                        product: {
                            title,
                            body_html: row.Description || row["Short description"] || "",
                            handle,
                            vendor: row.Brands || row.Vendor || "",
                            product_type: row.Categories ? String(row.Categories).split(",")[0].trim() : "",
                            tags: [row.Categories, row.Tags].filter(Boolean).join(", "),
                            status: (String(row.Published || "1") === "1" || String(row.Published || "").toLowerCase() === "true") ? "active" : "draft",
                            variants: [{
                                sku: row.SKU || "",
                                price: row["Sale price"] || row["Regular price"] || row.Price || "0",
                                compare_at_price: row["Regular price"] || null,
                                inventory_quantity: Number(row.Stock || 0),
                                inventory_management: "shopify",
                                inventory_policy: (String(row["Backorders allowed?"] || "").trim() === "1" || String(row["Backorders allowed?"] || "").toLowerCase() === "yes") ? "continue" : "deny",
                                fulfillment_service: "manual",
                                taxable: !["none", "false", "0"].includes(String(row["Tax status"] || "").trim().toLowerCase()),
                                barcode: row["GTIN, UPC, EAN, or ISBN"] || ""
                            }]
                        }
                    };

                    if (row["Weight (kg)"]) {
                        productPayload.product.variants[0].weight = Number.parseFloat(String(row["Weight (kg)"] || "0")) || 0;
                        productPayload.product.variants[0].weight_unit = "kg";
                    }

                    if (row["Attribute 1 name"] && row["Attribute 1 value(s)"]) {
                        productPayload.product.options = [row["Attribute 1 name"]];
                        productPayload.product.variants[0].option1 = row["Attribute 1 value(s)"];
                    }

                    if (imageUrls.length) {
                        productPayload.product.images = imageUrls.map((imageUrl) => ({
                            src: imageUrl,
                            alt: title
                        }));
                    }

                    if (existing && existing.id) {
                        const numericId = String(existing.id).split("/").pop();
                        const updateProduct = Object.assign({}, productPayload.product);
                        delete updateProduct.images;
                        await shopifyRest(shopDomain, accessToken, "PUT", `/products/${numericId}.json`, { product: { id: Number(numericId), ...updateProduct } });
                        const imageSummary = await ensureProductImages(shopDomain, accessToken, numericId, imageUrls, title);
                        summary.updated += 1;
                        results.push({
                            title,
                            action: "update",
                            shopifyId: numericId,
                            status: "ok",
                            imagesAdded: imageSummary.added,
                            imagesSkipped: imageSummary.skipped
                        });
                    } else {
                        const created = await shopifyRest(shopDomain, accessToken, "POST", "/products.json", productPayload);
                        const shopifyId = created && created.product && created.product.id;
                        const imageSummary = await ensureProductImages(shopDomain, accessToken, shopifyId, imageUrls, title);
                        summary.created += 1;
                        results.push({
                            title,
                            action: "create",
                            shopifyId: shopifyId || "",
                            status: "ok",
                            imagesAdded: imageSummary.added,
                            imagesSkipped: imageSummary.skipped
                        });
                    }
                } catch (error) {
                    summary.failed += 1;
                    results.push({ title, action: "error", shopifyId: "", status: error.message });
                }
            }

            sendJson(response, 200, { ok: true, total: results.length, summary, results });
        } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message });
        }
        return;
    }

    sendJson(response, 404, {
        ok: false,
        error: "API route not found."
    });
}

function handleStaticRequest(request, response) {
    const requestOrigin = getRequestOrigin(request) || `http://${request.headers.host || `127.0.0.1:${PORT}`}`;
    const url = new URL(request.url, requestOrigin);

    if (url.pathname === "/app-config.js") {
        sendText(response, 200, serializeRuntimeConfigScript(request), "application/javascript; charset=utf-8", {
            "Cache-Control": "no-store"
        });
        return;
    }

    const staticRoutes = {
        "/": "frontend_pages.html",
        "/index.html": "frontend_pages.html",
        "/pricing": "pricing.html",
        "/help": "help.html",
        "/login": "login.html",
        "/signup": "signup.html",
        "/checkout": "checkout.html",
        "/payment-success": "payment-success.html",
        "/payment-failed": "payment-failed.html",
        "/dashboard": "dashboard.html",
        "/dashboard/odoo": "odoo-migration.html",
        "/dashboard/woocommerce": "wp-to-shopify-migration.html",
        "/dashboard/messages": "messages.html",
        "/dashboard/odoo-panel": "odoo-panel.html",
        "/odoo-migration": "odoo-migration.html",
        "/woocommerce-migration": "wp-to-shopify-migration.html",
        "/migration-tool": "odoo_matrixify_browser.html",
        "/admin": "admin_panel.html",
        "/admin/users": "admin_panel.html",
        "/admin/jobs": "admin_panel.html",
        "/admin/payments": "admin_panel.html",
        "/admin/settings": "admin_panel.html",
        "/favicon.svg": "assets/img/favicon.svg",
        "/odoo_matrixify_converter.js": "odoo_matrixify_converter.js",
        "/home.html": "frontend_pages.html",
        "/services.html": "pricing.html",
        "/security.html": "help.html",
        "/migration-tool-page.html": "migration-tool-page.html",
        "/wp-to-shopify-migration": "wp-to-shopify-migration.html"
    };

    if (staticRoutes[url.pathname]) {
        sendFile(response, request, path.join(__dirname, staticRoutes[url.pathname]));
        return;
    }

    if (url.pathname.endsWith(".html")) {
        const htmlPath = path.normalize(path.join(__dirname, url.pathname));
        if (!htmlPath.startsWith(__dirname)) {
            sendText(response, 403, "Forbidden");
            return;
        }
        sendFile(response, request, htmlPath);
        return;
    }

    if (url.pathname.startsWith("/assets/")) {
        const assetPath = path.normalize(path.join(__dirname, url.pathname));
        if (!assetPath.startsWith(path.join(__dirname, "assets"))) {
            sendText(response, 403, "Forbidden");
            return;
        }
        sendFile(response, request, assetPath);
        return;
    }

    sendText(response, 404, "Not found");
}

const server = http.createServer((request, response) => {
    if (request.url && request.url.startsWith("/api/")) {
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
    const localUrl = CONFIG.localApiBaseUrl || `http://127.0.0.1:${PORT}`;
    const publicUrl = CONFIG.publicBaseUrl || CONFIG.renderExternalUrl || localUrl;
    process.stdout.write(`${CONFIG.appName} running at ${publicUrl} (local: ${localUrl})\n`);
    process.stdout.write(`Health check ready at ${publicUrl}/api/health\n`);
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        process.stdout.write(`Port ${PORT} is already in use. Open ${CONFIG.localApiBaseUrl || `http://127.0.0.1:${PORT}`}\n`);
        process.exit(0);
        return;
    }

    throw error;
});
