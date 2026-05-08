const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const converter = require("./odoo_matrixify_converter.js");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3456);
const API_VERSION = "2026-04";
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const MAX_JSON_BODY_BYTES = 100 * 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const LOG_DIR = path.join(DATA_DIR, "logs");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const IMPORT_PLANS_DIR = path.join(DATA_DIR, "import-plans");
const IMPORT_LOG_PATH = path.join(LOG_DIR, "shopify_import_debug.log");
const CONNECTION_PATH = path.join(DATA_DIR, "connection.json");
const SMTP_URL = String(process.env.SMTP_URL || "").trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || "vikassoni2018@gmail.com").trim();
const IMPORT_BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 1000);
const ORDER_CREATE_SPACING_MS = Number(process.env.ORDER_CREATE_SPACING_MS || 5000);
const SHOPIFY_THROTTLE_RETRY_WAIT_MS = Number(process.env.SHOPIFY_THROTTLE_RETRY_WAIT_MS || 65000);
const SHOPIFY_THROTTLE_MAX_ATTEMPTS = Number(process.env.SHOPIFY_THROTTLE_MAX_ATTEMPTS || 8);
const jobs = new Map();
const lastOrderCreateAttemptByShop = new Map();

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((line) => {
        const trimmed = line.trim();
        const separatorIndex = trimmed.indexOf("=");

        if (!trimmed || trimmed.startsWith("#") || separatorIndex < 1) {
            return;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (!process.env[key]) {
            process.env[key] = value;
        }
    });
}

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

function writeImportLog(event, details) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const record = {
            timestamp: new Date().toISOString(),
            event,
            ...(details || {})
        };

        fs.appendFileSync(IMPORT_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
        process.stderr.write(`Could not write import debug log: ${error.message}\n`);
    }
}

function truncateForLog(value, maxLength) {
    const text = String(value || "");
    const limit = maxLength || 1200;

    if (text.length <= limit) {
        return text;
    }

    return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

function getGraphqlOperationName(query) {
    const match = String(query || "").match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/);
    return match ? match[1] : "anonymous";
}

function getShopifyResponseHeaders(response) {
    const headerNames = [
        "x-request-id",
        "x-shopify-shop-api-call-limit",
        "retry-after",
        "content-type"
    ];
    const headers = {};

    headerNames.forEach((name) => {
        const value = response.headers.get(name);
        if (value) {
            headers[name] = value;
        }
    });

    return headers;
}

function extractShopifyErrorMessages(payload) {
    if (!payload || !payload.errors) {
        return [];
    }

    if (Array.isArray(payload.errors)) {
        return payload.errors.map((item) => {
            if (item && item.message) {
                return item.message;
            }

            return JSON.stringify(item);
        });
    }

    return [JSON.stringify(payload.errors)];
}

function createShopifyRequestError(message, details) {
    const error = new Error(message);
    const metadata = details || {};

    Object.keys(metadata).forEach((key) => {
        error[key] = metadata[key];
    });

    if (isRetryableShopifyThrottle(error)) {
        error.retryableThrottle = true;
    }

    return error;
}

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, milliseconds));
    });
}

function isThrottleText(value) {
    return /too many attempts|too many requests|throttl|rate.?limit/i.test(String(value || ""));
}

function isRetryableShopifyThrottle(error) {
    if (!error) {
        return false;
    }

    if (error.retryableThrottle || error.httpStatus === 429) {
        return true;
    }

    if (isThrottleText(error.message)) {
        return true;
    }

    if (Array.isArray(error.shopifyErrors) && error.shopifyErrors.some(isThrottleText)) {
        return true;
    }

    if (Array.isArray(error.shopifyUserErrors)) {
        return error.shopifyUserErrors.some((item) => isThrottleText(item && item.message));
    }

    return false;
}

function getThrottleRetryWaitMs(error, attempt) {
    const retryAfterSeconds = Number(error && error.retryAfterSeconds);

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.ceil(retryAfterSeconds * 1000) + 500;
    }

    return Math.min(SHOPIFY_THROTTLE_RETRY_WAIT_MS * attempt, 5 * 60 * 1000);
}

function setJobStatusMessage(job, message) {
    job.statusMessage = message || "";
    job.updatedAt = new Date().toISOString();
    savePersistedJob(job);
    syncImportPlanBatchFromJob(job);
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function getSafeId(value) {
    const id = String(value || "").trim();
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function getSavedConnection() {
    if (!fs.existsSync(CONNECTION_PATH)) {
        return {
            shopDomain: normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN),
            accessToken: String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim()
        };
    }

    try {
        const saved = JSON.parse(fs.readFileSync(CONNECTION_PATH, "utf8"));
        return {
            shopDomain: normalizeShopDomain(saved.shopDomain || process.env.SHOPIFY_SHOP_DOMAIN),
            accessToken: String(saved.accessToken || process.env.SHOPIFY_ACCESS_TOKEN || "").trim()
        };
    } catch (error) {
        writeImportLog("load_saved_connection_failed", {
            message: error.message
        });
        return {
            shopDomain: normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN),
            accessToken: String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim()
        };
    }
}

function saveConnection(connection) {
    const shopDomain = normalizeShopDomain(connection && connection.shopDomain);
    const accessToken = String(connection && connection.accessToken || "").trim();

    if (!shopDomain || !accessToken) {
        return;
    }

    fs.writeFileSync(CONNECTION_PATH, JSON.stringify({
        shopDomain,
        accessToken,
        updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
}

function getJobDirectory(jobId) {
    const safeId = getSafeId(jobId);
    if (!safeId) {
        throw new Error("Invalid import job id.");
    }

    return path.join(JOBS_DIR, safeId);
}

function getJobStatePath(jobId) {
    return path.join(getJobDirectory(jobId), "job.json");
}

function getJobCsvPath(jobId) {
    return path.join(getJobDirectory(jobId), "source.csv");
}

function getImportPlanDirectory(planId) {
    const safeId = getSafeId(planId);
    if (!safeId) {
        throw new Error("Invalid saved import id.");
    }

    return path.join(IMPORT_PLANS_DIR, safeId);
}

function getImportPlanStatePath(planId) {
    return path.join(getImportPlanDirectory(planId), "plan.json");
}

function getImportPlanCsvPath(planId) {
    return path.join(getImportPlanDirectory(planId), "source.csv");
}

function hasActiveRuntimeJobs() {
    return Array.from(jobs.values()).some((job) => (
        job
        && job.runtimeActive
        && (job.status === "running" || job.status === "queued")
    ));
}

function clearPersistedImportData() {
    if (hasActiveRuntimeJobs()) {
        throw new Error("An import job is still running. Wait for it to finish before clearing saved jobs.");
    }

    fs.rmSync(JOBS_DIR, { recursive: true, force: true });
    fs.rmSync(IMPORT_PLANS_DIR, { recursive: true, force: true });
    ensureDirectory(JOBS_DIR);
    ensureDirectory(IMPORT_PLANS_DIR);
    jobs.clear();

    writeImportLog("persisted_import_data_cleared", {
        jobsDir: JOBS_DIR,
        importPlansDir: IMPORT_PLANS_DIR
    });
}

function getDefaultSummary(totalOrders) {
    return {
        totalOrders: Number(totalOrders || 0),
        processedOrders: 0,
        createdOrders: 0,
        updatedOrders: 0,
        failedOrders: 0
    };
}

function recalculateJobSummary(job) {
    const existingSummary = job.summary || {};
    const totalOrders = Number(existingSummary.totalOrders || job.totalOrders || 0);

    job.results = Array.isArray(job.results) ? job.results : [];
    job.summary = getDefaultSummary(totalOrders);

    job.results.forEach((result) => {
        job.summary.processedOrders += 1;
        if (result.status === "created") {
            job.summary.createdOrders += 1;
        } else if (result.status === "updated") {
            job.summary.updatedOrders += 1;
        } else if (result.status === "failed") {
            job.summary.failedOrders += 1;
        }
    });

    job.recentResults = job.results.slice(-25);
    return job.summary;
}

function getJobProcessedReferenceSet(job) {
    const processed = new Set();
    (Array.isArray(job.results) ? job.results : []).forEach((result) => {
        const reference = String(result && result.orderReference || "").trim();
        if (reference) {
            processed.add(reference);
        }
    });
    return processed;
}

function getJobSnapshot(job) {
    return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt || "",
        completedAt: job.completedAt || "",
        stats: job.stats || {},
        summary: job.summary || getDefaultSummary(),
        warnings: Array.isArray(job.warnings) ? job.warnings : [],
        statusMessage: job.statusMessage || "",
        error: job.error || "",
        results: Array.isArray(job.results) ? job.results : [],
        recentResults: Array.isArray(job.recentResults) ? job.recentResults : [],
        persisted: !!job.persisted,
        csvFilePath: job.csvFilePath || "",
        sourceFileName: job.sourceFileName || "",
        shopDomain: normalizeShopDomain(job.shopDomain),
        batchLabel: job.batchLabel || "",
        orderReferences: Array.isArray(job.orderReferences) ? job.orderReferences : [],
        timeZoneOffset: job.timeZoneOffset || "",
        importPlanId: job.importPlanId || "",
        importPlanBatchNumber: job.importPlanBatchNumber || 0,
        interruptedAlertSentAt: job.interruptedAlertSentAt || ""
    };
}

function savePersistedJob(job) {
    if (!job || !job.persisted || !job.id) {
        return;
    }

    try {
        ensureDirectory(getJobDirectory(job.id));
        fs.writeFileSync(getJobStatePath(job.id), JSON.stringify(getJobSnapshot(job), null, 2), "utf8");
    } catch (error) {
        writeImportLog("persist_job_failed", {
            jobId: job && job.id,
            message: error.message
        });
    }
}

function saveJobCsv(job, csvText) {
    ensureDirectory(getJobDirectory(job.id));
    const csvFilePath = getJobCsvPath(job.id);
    fs.writeFileSync(csvFilePath, String(csvText || ""), "utf8");
    job.csvFilePath = csvFilePath;
    job.persisted = true;
    savePersistedJob(job);
}

function loadPersistedJob(jobId) {
    const safeId = getSafeId(jobId);
    if (!safeId) {
        return null;
    }

    const statePath = getJobStatePath(safeId);
    if (!fs.existsSync(statePath)) {
        return null;
    }

    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const savedStatus = saved.status || "queued";
    const wasInterrupted = savedStatus === "running" || savedStatus === "queued";
    const job = {
        id: safeId,
        status: wasInterrupted ? "queued" : savedStatus,
        createdAt: saved.createdAt || new Date().toISOString(),
        updatedAt: saved.updatedAt || new Date().toISOString(),
        startedAt: saved.startedAt || "",
        completedAt: saved.completedAt || "",
        stats: saved.stats || {},
        summary: saved.summary || getDefaultSummary(),
        warnings: Array.isArray(saved.warnings) ? saved.warnings : [],
        statusMessage: wasInterrupted ? "Previous run was interrupted. Click Resume Batch to continue from the next unprocessed order." : saved.statusMessage || "",
        error: saved.error || "",
        results: Array.isArray(saved.results) ? saved.results : [],
        recentResults: [],
        persisted: true,
        csvFilePath: saved.csvFilePath || getJobCsvPath(safeId),
        sourceFileName: saved.sourceFileName || "",
        shopDomain: normalizeShopDomain(saved.shopDomain),
        batchLabel: saved.batchLabel || "",
        orderReferences: Array.isArray(saved.orderReferences) ? saved.orderReferences : [],
        timeZoneOffset: saved.timeZoneOffset || "",
        importPlanId: saved.importPlanId || "",
        importPlanBatchNumber: Number(saved.importPlanBatchNumber || 0),
        interruptedAlertSentAt: saved.interruptedAlertSentAt || ""
    };

    recalculateJobSummary(job);
    if (wasInterrupted) {
        savePersistedJob(job);
        syncImportPlanBatchFromJob(job);
    }
    jobs.set(job.id, job);
    return job;
}

function getJobById(jobId) {
    const safeId = getSafeId(jobId);
    if (!safeId) {
        return null;
    }

    return jobs.get(safeId) || loadPersistedJob(safeId);
}

function listPersistedJobs() {
    if (!fs.existsSync(JOBS_DIR)) {
        return [];
    }

    return fs.readdirSync(JOBS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && getSafeId(entry.name))
        .map((entry) => {
            try {
                return loadPersistedJob(entry.name);
            } catch (error) {
                writeImportLog("load_persisted_job_failed", {
                    jobId: entry.name,
                    message: error.message
                });
                return null;
            }
        })
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function getPublicAppUrl() {
    const configuredUrl = String(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
    if (configuredUrl) {
        return configuredUrl.replace(/\/+$/, "");
    }

    return `http://${HOST}:${PORT}`;
}

function getInterruptedJobsForAlert() {
    return listPersistedJobs().filter((job) => {
        const summary = job.summary || getDefaultSummary();
        const totalOrders = Number(summary.totalOrders || 0);
        const processedOrders = Number(summary.processedOrders || 0);
        const pendingOrders = Math.max(0, totalOrders - processedOrders);
        return job.status === "queued"
            && !job.interruptedAlertSentAt
            && pendingOrders > 0
            && String(job.statusMessage || "").includes("Previous run was interrupted");
    });
}

async function sendInterruptedJobAlert(job) {
    if (!SMTP_URL || !ALERT_EMAIL_TO) {
        writeImportLog("interrupted_job_alert_skipped", {
            jobId: job.id,
            reason: "SMTP_URL or ALERT_EMAIL_TO is not configured"
        });
        return false;
    }

    const summary = job.summary || getDefaultSummary();
    const totalOrders = Number(summary.totalOrders || 0);
    const processedOrders = Number(summary.processedOrders || 0);
    const pendingOrders = Math.max(0, totalOrders - processedOrders);
    const appUrl = getPublicAppUrl();
    const subject = `Shopify import interrupted: ${job.sourceFileName || job.batchLabel || job.id}`;
    const lines = [
        "A Shopify import job was interrupted and needs resume.",
        "",
        `Job ID: ${job.id}`,
        `Source file: ${job.sourceFileName || "Odoo CSV"}`,
        `Batch: ${job.batchLabel || "Batch"}`,
        `Shop: ${job.shopDomain || "Not saved"}`,
        `Processed: ${processedOrders} of ${totalOrders}`,
        `Created: ${summary.createdOrders || 0}`,
        `Updated: ${summary.updatedOrders || 0}`,
        `Failed: ${summary.failedOrders || 0}`,
        `Remaining: ${pendingOrders}`,
        "",
        `Open the app and click Resume Batch: ${appUrl}`
    ];

    const transporter = nodemailer.createTransport(SMTP_URL);
    await transporter.sendMail({
        from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_FROM || "Odoo Shopify Sync <no-reply@localhost>",
        to: ALERT_EMAIL_TO,
        subject,
        text: lines.join("\n")
    });

    job.interruptedAlertSentAt = new Date().toISOString();
    savePersistedJob(job);
    writeImportLog("interrupted_job_alert_sent", {
        jobId: job.id,
        to: ALERT_EMAIL_TO,
        processedOrders,
        pendingOrders
    });
    return true;
}

async function sendInterruptedJobAlertsOnStartup() {
    const interruptedJobs = getInterruptedJobsForAlert();

    for (const job of interruptedJobs) {
        try {
            await sendInterruptedJobAlert(job);
        } catch (error) {
            writeImportLog("interrupted_job_alert_failed", {
                jobId: job.id,
                message: error.message
            });
        }
    }
}

function getJobCsvText(job) {
    const csvFilePath = job && job.csvFilePath ? job.csvFilePath : getJobCsvPath(job.id);
    if (!fs.existsSync(csvFilePath)) {
        throw new Error("The saved CSV for this job was not found on Render disk.");
    }

    return fs.readFileSync(csvFilePath, "utf8");
}

function getUniqueOrderReferences(apiOrders) {
    const seen = new Set();
    const references = [];

    apiOrders.forEach((apiOrder) => {
        const reference = String(apiOrder.orderReference || "").trim();
        if (!reference || seen.has(reference)) {
            return;
        }

        seen.add(reference);
        references.push(reference);
    });

    return references;
}

function createImportPlanBatches(orderReferences) {
    const batches = [];

    for (let index = 0; index < orderReferences.length; index += IMPORT_BATCH_SIZE) {
        const batchReferences = orderReferences.slice(index, index + IMPORT_BATCH_SIZE);
        batches.push({
            number: batches.length + 1,
            orderReferences: batchReferences,
            orderCount: batchReferences.length,
            firstOrder: batchReferences[0] || "",
            lastOrder: batchReferences[batchReferences.length - 1] || "",
            status: "pending",
            message: "",
            jobId: "",
            summary: getDefaultSummary(batchReferences.length),
            updatedAt: ""
        });
    }

    return batches;
}

function getImportPlanSummary(plan) {
    const summary = {
        totalOrders: Number(plan.totalOrders || 0),
        totalBatches: Array.isArray(plan.batches) ? plan.batches.length : 0,
        pendingBatches: 0,
        runningBatches: 0,
        completedBatches: 0,
        failedBatches: 0,
        processedOrders: 0,
        createdOrders: 0,
        updatedOrders: 0,
        failedOrders: 0
    };

    (Array.isArray(plan.batches) ? plan.batches : []).forEach((batch) => {
        const batchSummary = batch.summary || {};
        summary.processedOrders += Number(batchSummary.processedOrders || 0);
        summary.createdOrders += Number(batchSummary.createdOrders || 0);
        summary.updatedOrders += Number(batchSummary.updatedOrders || 0);
        summary.failedOrders += Number(batchSummary.failedOrders || 0);

        if (batch.status === "running" || batch.status === "queued") {
            summary.runningBatches += 1;
        } else if (batch.status === "completed" || batch.status === "completed_with_failures") {
            summary.completedBatches += 1;
        } else if (batch.status === "failed") {
            summary.failedBatches += 1;
        } else {
            summary.pendingBatches += 1;
        }
    });

    return summary;
}

function reconcileImportPlanBatches(plan) {
    if (!plan || !Array.isArray(plan.batches)) {
        return plan;
    }

    let changed = false;
    plan.batches.forEach((batch) => {
        if (!batch || !batch.jobId) {
            return;
        }

        const job = getJobById(batch.jobId);
        if (!job) {
            return;
        }

        batch.status = job.status || batch.status;
        batch.summary = job.summary || batch.summary;
        batch.updatedAt = job.updatedAt || batch.updatedAt;
        if (job.statusMessage) {
            batch.message = job.statusMessage;
        } else if (job.status === "queued") {
            batch.message = "Ready to resume";
        } else if (job.status === "completed") {
            batch.message = `Created ${job.summary.createdOrders}, updated ${job.summary.updatedOrders}, failed ${job.summary.failedOrders}`;
        } else if (job.status === "failed") {
            batch.message = job.error || "Import failed.";
        }
        changed = true;
    });

    if (changed) {
        plan.updatedAt = new Date().toISOString();
        saveImportPlan(plan);
    }

    return plan;
}

function getImportPlanSnapshot(plan) {
    return {
        id: plan.id,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        sourceFileName: plan.sourceFileName || "",
        csvFilePath: plan.csvFilePath || "",
        csvBytes: Number(plan.csvBytes || 0),
        timeZoneOffset: plan.timeZoneOffset || "",
        stats: plan.stats || {},
        totalOrders: Number(plan.totalOrders || 0),
        batchSize: Number(plan.batchSize || IMPORT_BATCH_SIZE),
        batches: Array.isArray(plan.batches) ? plan.batches : []
    };
}

function saveImportPlan(plan) {
    if (!plan || !plan.id) {
        return;
    }

    ensureDirectory(getImportPlanDirectory(plan.id));
    fs.writeFileSync(getImportPlanStatePath(plan.id), JSON.stringify(getImportPlanSnapshot(plan), null, 2), "utf8");
}

function loadImportPlan(planId) {
    const safeId = getSafeId(planId);
    if (!safeId) {
        return null;
    }

    const statePath = getImportPlanStatePath(safeId);
    if (!fs.existsSync(statePath)) {
        return null;
    }

    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const plan = {
        id: safeId,
        createdAt: saved.createdAt || new Date().toISOString(),
        updatedAt: saved.updatedAt || new Date().toISOString(),
        sourceFileName: saved.sourceFileName || "",
        csvFilePath: saved.csvFilePath || getImportPlanCsvPath(safeId),
        csvBytes: Number(saved.csvBytes || 0),
        timeZoneOffset: saved.timeZoneOffset || "",
        stats: saved.stats || {},
        totalOrders: Number(saved.totalOrders || 0),
        batchSize: Number(saved.batchSize || IMPORT_BATCH_SIZE),
        batches: Array.isArray(saved.batches) ? saved.batches : []
    };

    plan.batches.forEach((batch) => {
        batch.orderReferences = Array.isArray(batch.orderReferences) ? batch.orderReferences : [];
        batch.orderCount = Number(batch.orderCount || batch.orderReferences.length || 0);
        batch.summary = batch.summary || getDefaultSummary(batch.orderCount);
    });

    return plan;
}

function listImportPlans() {
    if (!fs.existsSync(IMPORT_PLANS_DIR)) {
        return [];
    }

    return fs.readdirSync(IMPORT_PLANS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && getSafeId(entry.name))
        .map((entry) => {
            try {
                return loadImportPlan(entry.name);
            } catch (error) {
                writeImportLog("load_import_plan_failed", {
                    importPlanId: entry.name,
                    message: error.message
                });
                return null;
            }
        })
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function getImportPlanPayload(plan) {
    reconcileImportPlanBatches(plan);
    return {
        ...getImportPlanSnapshot(plan),
        summary: getImportPlanSummary(plan)
    };
}

function createImportPlan(payload) {
    const csvText = String(payload.csvText || "");
    if (!csvText.trim()) {
        throw new Error("Upload an Odoo CSV before saving the import plan.");
    }

    const importBuild = buildApiImportOrders(csvText, payload.timeZoneOffset);
    const orderReferences = getUniqueOrderReferences(importBuild.apiOrders);
    const planId = crypto.randomUUID();
    const now = new Date().toISOString();
    const plan = {
        id: planId,
        createdAt: now,
        updatedAt: now,
        sourceFileName: String(payload.sourceFileName || "odoo-orders.csv").trim() || "odoo-orders.csv",
        csvFilePath: getImportPlanCsvPath(planId),
        csvBytes: Buffer.byteLength(csvText, "utf8"),
        timeZoneOffset: payload.timeZoneOffset || "",
        stats: importBuild.converted.stats,
        totalOrders: orderReferences.length,
        batchSize: IMPORT_BATCH_SIZE,
        batches: createImportPlanBatches(orderReferences)
    };

    ensureDirectory(getImportPlanDirectory(plan.id));
    fs.writeFileSync(plan.csvFilePath, csvText, "utf8");
    saveImportPlan(plan);

    writeImportLog("import_plan_saved", {
        importPlanId: plan.id,
        sourceFileName: plan.sourceFileName,
        csvBytes: plan.csvBytes,
        totalOrders: plan.totalOrders,
        batchCount: plan.batches.length
    });

    return plan;
}

function getImportPlanCsvText(plan) {
    const csvFilePath = plan && plan.csvFilePath ? plan.csvFilePath : getImportPlanCsvPath(plan.id);
    if (!fs.existsSync(csvFilePath)) {
        throw new Error("The saved CSV for this import plan was not found on Render disk.");
    }

    return fs.readFileSync(csvFilePath, "utf8");
}

function syncImportPlanBatchFromJob(job) {
    if (!job || !job.importPlanId || !job.importPlanBatchNumber) {
        return;
    }

    try {
        const plan = loadImportPlan(job.importPlanId);
        if (!plan) {
            return;
        }

        const batch = plan.batches.find((item) => Number(item.number) === Number(job.importPlanBatchNumber));
        if (!batch) {
            return;
        }

        batch.jobId = job.id;
        batch.summary = job.summary || batch.summary;
        batch.updatedAt = job.updatedAt || new Date().toISOString();

        if (job.status === "completed" && job.summary && job.summary.failedOrders) {
            batch.status = "completed_with_failures";
        } else {
            batch.status = job.status || batch.status;
        }

        if (job.status === "running" || job.status === "queued") {
            batch.message = `Processed ${job.summary.processedOrders} of ${job.summary.totalOrders}`;
        } else if (job.status === "completed") {
            batch.message = `Created ${job.summary.createdOrders}, updated ${job.summary.updatedOrders}, failed ${job.summary.failedOrders}`;
        } else if (job.status === "failed") {
            batch.message = job.error || "Import failed.";
        }

        plan.updatedAt = new Date().toISOString();
        saveImportPlan(plan);
    } catch (error) {
        writeImportLog("sync_import_plan_batch_failed", {
            jobId: job.id,
            importPlanId: job.importPlanId,
            importPlanBatchNumber: job.importPlanBatchNumber,
            message: error.message
        });
    }
}

async function waitForOrderCreateSlot(shopDomain, context, job) {
    const now = Date.now();
    const nextAllowedAt = lastOrderCreateAttemptByShop.get(shopDomain) || 0;
    const waitMs = Math.max(0, nextAllowedAt - now);

    if (waitMs > 0) {
        const waitSeconds = Math.ceil(waitMs / 1000);
        const message = `Waiting ${waitSeconds} seconds before creating the next Shopify order.`;

        if (job) {
            setJobStatusMessage(job, message);
        }

        writeImportLog("shopify_order_create_pacing_wait", {
            ...(context || {}),
            shopDomain,
            waitMs
        });
        await sleep(waitMs);
    }

    lastOrderCreateAttemptByShop.set(shopDomain, Date.now() + ORDER_CREATE_SPACING_MS);
}

async function runShopifyOperationWithRetry(job, action, context, operation) {
    for (let attempt = 1; attempt <= SHOPIFY_THROTTLE_MAX_ATTEMPTS; attempt += 1) {
        try {
            return await operation(attempt);
        } catch (error) {
            if (!isRetryableShopifyThrottle(error) || attempt >= SHOPIFY_THROTTLE_MAX_ATTEMPTS) {
                throw error;
            }

            const waitMs = getThrottleRetryWaitMs(error, attempt);
            const waitSeconds = Math.ceil(waitMs / 1000);
            const message = `Shopify is limiting requests. Waiting ${waitSeconds} seconds before retrying ${context.orderReference || action}.`;

            setJobStatusMessage(job, message);
            writeImportLog("shopify_throttle_retry_wait", {
                ...(context || {}),
                action,
                attempt,
                nextAttempt: attempt + 1,
                waitMs,
                httpStatus: error.httpStatus || null,
                retryAfterSeconds: error.retryAfterSeconds || null,
                message: error.message
            });

            await sleep(waitMs);
        }
    }

    throw new Error(`Shopify ${action} did not complete.`);
}

async function shopifyGraphql(shopDomain, accessToken, query, variables, context) {
    const operationName = getGraphqlOperationName(query);
    const logContext = {
        shopDomain,
        operationName,
        ...(context || {})
    };
    let response;

    try {
        response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
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
    } catch (error) {
        writeImportLog("shopify_request_network_error", {
            ...logContext,
            message: error.message
        });
        throw error;
    }

    const text = await response.text();
    let payload;

    try {
        payload = text ? JSON.parse(text) : {};
    } catch (error) {
        const headers = getShopifyResponseHeaders(response);
        writeImportLog("shopify_response_parse_error", {
            ...logContext,
            httpStatus: response.status,
            responseStatusText: response.statusText,
            headers,
            responsePreview: truncateForLog(text)
        });
        throw createShopifyRequestError(`Shopify returned an invalid response (${response.status}).`, {
            httpStatus: response.status,
            retryAfterSeconds: headers["retry-after"] || null
        });
    }

    if (!response.ok) {
        const shopifyErrors = extractShopifyErrorMessages(payload);
        const headers = getShopifyResponseHeaders(response);
        const message = payload && payload.errors
            ? JSON.stringify(payload.errors)
            : `HTTP ${response.status}`;

        writeImportLog("shopify_http_error", {
            ...logContext,
            httpStatus: response.status,
            responseStatusText: response.statusText,
            headers,
            shopifyErrors,
            responsePreview: truncateForLog(text)
        });

        throw createShopifyRequestError(`Shopify request failed: ${message}`, {
            httpStatus: response.status,
            retryAfterSeconds: headers["retry-after"] || null,
            shopifyErrors
        });
    }

    if (payload.errors && payload.errors.length) {
        const shopifyErrors = extractShopifyErrorMessages(payload);
        writeImportLog("shopify_graphql_errors", {
            ...logContext,
            httpStatus: response.status,
            headers: getShopifyResponseHeaders(response),
            shopifyErrors,
            cost: payload.extensions && payload.extensions.cost ? payload.extensions.cost : null
        });
        throw createShopifyRequestError(shopifyErrors.join("; "), {
            shopifyErrors
        });
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

function splitCustomerName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
        return {
            firstName: "",
            lastName: ""
        };
    }

    if (parts.length === 1) {
        return {
            firstName: parts[0],
            lastName: ""
        };
    }

    return {
        firstName: parts.slice(0, -1).join(" "),
        lastName: parts[parts.length - 1]
    };
}

function limitShopifyAddressField(value) {
    const text = String(value || "").trim();
    return text.length > 255 ? text.slice(0, 255) : text;
}

function buildShippingAddress(firstRow) {
    const rawAddress = String(
        firstRow["Odoo Customer/Contact Address Complete"]
        || firstRow["Odoo Shipping Address"]
        || firstRow["Odoo Delivery Address"]
        || ""
    ).trim();
    if (!rawAddress) {
        return null;
    }

    const customerName = splitCustomerName(firstRow["Odoo Customer"]);
    const address = {
        address1: limitShopifyAddressField(rawAddress)
    };

    if (customerName.firstName) {
        address.firstName = customerName.firstName;
    }

    if (customerName.lastName) {
        address.lastName = customerName.lastName;
    }

    if (firstRow.Phone) {
        address.phone = String(firstRow.Phone).trim();
    }

    return address;
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

function isShippingAddressUserError(userError) {
    const field = Array.isArray(userError && userError.field) ? userError.field : [];
    return field[0] === "shippingAddress";
}

async function sendOrderUpdate(shopDomain, accessToken, input, context) {
    const data = await shopifyGraphql(shopDomain, accessToken, UPDATE_ORDER_MUTATION, { input }, {
        action: "UPDATE_ORDER",
        ...(context || {})
    });
    const payload = data.orderUpdate;

    if (payload.userErrors && payload.userErrors.length) {
        writeImportLog("shopify_order_update_user_errors", {
            shopDomain,
            action: "UPDATE_ORDER",
            ...(context || {}),
            userErrors: payload.userErrors
        });
        throw createShopifyRequestError(payload.userErrors.map((item) => item.message).join("; "), {
            shopifyUserErrors: payload.userErrors
        });
    }

    return payload.order;
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
        const shippingAddress = buildShippingAddress(firstRow);

        const lineItems = rows.map((row) => {
            const lineProperties = parseEscapedKeyValueLines(row["Line: Properties"]);
            const skuProperty = lineProperties.find((property) => property.key === "Odoo SKU");

            const lineItem = {
                title: String(row["Line: Title"] || "Imported Odoo Order").trim() || "Imported Odoo Order",
                quantity: Number.parseInt(String(row["Line: Quantity"] || "1"), 10) || 1,
                requiresShipping: !!shippingAddress,
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

        if (shippingAddress) {
            orderInput.shippingAddress = shippingAddress;
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

function getRequestedOrderReferences(payload) {
    const references = Array.isArray(payload.orderReferences)
        ? payload.orderReferences
        : [];

    return references
        .map((reference) => String(reference || "").trim())
        .filter(Boolean);
}

function filterApiOrdersForPayload(apiOrders, payload) {
    const requestedReferences = getRequestedOrderReferences(payload);

    if (!requestedReferences.length) {
        return apiOrders;
    }

    const requestedSet = new Set(requestedReferences);
    return apiOrders.filter((apiOrder) => requestedSet.has(apiOrder.orderReference));
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

function createJob(stats, options) {
    const jobId = crypto.randomUUID();
    const metadata = options || {};
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
        statusMessage: "",
        results: [],
        recentResults: [],
        persisted: !!metadata.persisted,
        csvFilePath: metadata.csvFilePath || "",
        sourceFileName: metadata.sourceFileName || "",
        shopDomain: normalizeShopDomain(metadata.shopDomain),
        batchLabel: metadata.batchLabel || "",
        orderReferences: Array.isArray(metadata.orderReferences) ? metadata.orderReferences : [],
        timeZoneOffset: metadata.timeZoneOffset || "",
        importPlanId: metadata.importPlanId || "",
        importPlanBatchNumber: Number(metadata.importPlanBatchNumber || 0)
    };

    jobs.set(jobId, job);
    savePersistedJob(job);
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
    savePersistedJob(job);
    syncImportPlanBatchFromJob(job);
}

async function connectShop(payload, context) {
    const savedConnection = getSavedConnection();
    const shopDomain = normalizeShopDomain(payload.shopDomain || savedConnection.shopDomain || process.env.SHOPIFY_SHOP_DOMAIN);
    const accessToken = String(payload.accessToken || savedConnection.accessToken || process.env.SHOPIFY_ACCESS_TOKEN || "").trim();

    if (!shopDomain) {
        throw new Error("Enter a valid Shopify domain.");
    }

    if (!accessToken) {
        throw new Error("Enter a valid Shopify Admin API access token.");
    }

    const data = await shopifyGraphql(shopDomain, accessToken, SHOP_QUERY, {}, {
        phase: "connect",
        ...(context || {})
    });
    return {
        shopDomain,
        accessToken,
        shop: data.shop
    };
}

async function findExistingOrder(shopDomain, accessToken, orderReference, context) {
    const reference = String(orderReference || "").trim();
    const escapedReference = reference.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    const searchQueries = [
        `name:${escapedReference}`,
        `source_identifier:${escapedReference}`,
        `"${escapedReference}"`
    ];
    const seenOrderIds = new Set();

    for (const query of searchQueries) {
        const data = await shopifyGraphql(shopDomain, accessToken, FIND_ORDERS_QUERY, { query }, {
            action: "FIND_EXISTING_ORDER",
            orderReference: reference,
            searchQuery: query,
            ...(context || {})
        });
        const nodes = data && data.orders && Array.isArray(data.orders.nodes) ? data.orders.nodes : [];
        const exactMatch = nodes.find((node) => {
            if (!node || seenOrderIds.has(node.id)) {
                return false;
            }

            seenOrderIds.add(node.id);
            return node.name === reference || node.name === `#${reference}` || node.sourceIdentifier === reference;
        });

        if (exactMatch) {
            return exactMatch;
        }
    }

    return null;
}

async function createOrder(shopDomain, accessToken, orderInput, context) {
    const data = await shopifyGraphql(shopDomain, accessToken, CREATE_ORDER_MUTATION, {
        order: orderInput,
        options: {
            inventoryBehaviour: "BYPASS",
            sendReceipt: false,
            sendFulfillmentReceipt: false
        }
    }, {
        action: "CREATE_ORDER",
        ...(context || {})
    });

    const payload = data.orderCreate;
    if (payload.userErrors && payload.userErrors.length) {
        writeImportLog("shopify_order_create_user_errors", {
            shopDomain,
            action: "CREATE_ORDER",
            ...(context || {}),
            userErrors: payload.userErrors
        });
        throw createShopifyRequestError(payload.userErrors.map((item) => item.message).join("; "), {
            shopifyUserErrors: payload.userErrors
        });
    }

    return payload.order;
}

async function updateOrder(shopDomain, accessToken, existingOrder, orderInput, context) {
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

    if (orderInput.shippingAddress) {
        input.shippingAddress = orderInput.shippingAddress;
    }

    if (mergedAttributes.length) {
        input.customAttributes = mergedAttributes;
    }

    try {
        return await sendOrderUpdate(shopDomain, accessToken, input, context);
    } catch (error) {
        const userErrors = Array.isArray(error.shopifyUserErrors) ? error.shopifyUserErrors : [];
        const onlyShippingAddressErrors = userErrors.length > 0 && userErrors.every(isShippingAddressUserError);

        if (!input.shippingAddress || !onlyShippingAddressErrors) {
            throw error;
        }

        const fallbackInput = { ...input };
        delete fallbackInput.shippingAddress;
        writeImportLog("shopify_order_update_retry_without_shipping_address", {
            shopDomain,
            action: "UPDATE_ORDER",
            ...(context || {}),
            message: error.message
        });

        return sendOrderUpdate(shopDomain, accessToken, fallbackInput, {
            ...(context || {}),
            skippedShippingAddress: true
        });
    }
}

async function runImportJob(job, payload) {
    const runtimePayload = payload || {};

    job.runtimeActive = true;
    job.status = "running";
    job.error = "";
    job.startedAt = job.startedAt || new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    savePersistedJob(job);
    syncImportPlanBatchFromJob(job);

    try {
        const csvText = runtimePayload.csvText !== undefined
            ? String(runtimePayload.csvText || "")
            : getJobCsvText(job);
        const requestedReferences = getRequestedOrderReferences(runtimePayload).length
            ? getRequestedOrderReferences(runtimePayload)
            : job.orderReferences;
        const effectivePayload = {
            ...runtimePayload,
            csvText,
            shopDomain: runtimePayload.shopDomain || job.shopDomain,
            timeZoneOffset: runtimePayload.timeZoneOffset || job.timeZoneOffset,
            orderReferences: requestedReferences,
            batchLabel: runtimePayload.batchLabel || job.batchLabel
        };

        job.shopDomain = normalizeShopDomain(effectivePayload.shopDomain);
        job.timeZoneOffset = effectivePayload.timeZoneOffset || "";
        job.batchLabel = effectivePayload.batchLabel || "";
        job.orderReferences = requestedReferences;
        savePersistedJob(job);

        writeImportLog("import_job_started", {
            jobId: job.id,
            shopDomain: normalizeShopDomain(effectivePayload.shopDomain),
            uploadedCsvBytes: Buffer.byteLength(csvText, "utf8"),
            batchLabel: job.batchLabel || ""
        });

        const connection = await connectShop(effectivePayload, {
            jobId: job.id,
            phase: "import_connect"
        });
        saveConnection(connection);
        const importBuild = buildApiImportOrders(csvText, effectivePayload.timeZoneOffset);
        const apiOrders = filterApiOrdersForPayload(importBuild.apiOrders, effectivePayload);
        const processedReferences = getJobProcessedReferenceSet(job);
        const pendingApiOrders = apiOrders.filter((apiOrder) => !processedReferences.has(apiOrder.orderReference));

        job.summary.totalOrders = apiOrders.length;
        job.stats = importBuild.converted.stats;
        recalculateJobSummary(job);
        savePersistedJob(job);

        writeImportLog("import_job_prepared", {
            jobId: job.id,
            shopDomain: connection.shopDomain,
            totalOrders: apiOrders.length,
            pendingOrders: pendingApiOrders.length,
            alreadyProcessedOrders: processedReferences.size,
            requestedOrders: getRequestedOrderReferences(effectivePayload).length,
            batchLabel: effectivePayload.batchLabel || "",
            stats: importBuild.converted.stats
        });

        job.warnings = [
            "Existing Shopify orders are updated with note, phone, delivery address, and custom attributes. Shopify line items and processed date are not rewritten for existing orders.",
            "Shopify limits how quickly orders can be created. The importer now waits and retries instead of failing the remaining orders immediately.",
            "This job is saved on Render disk. If the service restarts, use the saved import list to resume from the next unprocessed order."
        ];
        savePersistedJob(job);

        for (const apiOrder of pendingApiOrders) {
            setJobStatusMessage(job, `Checking Shopify order ${apiOrder.orderReference}.`);
            writeImportLog("import_order_started", {
                jobId: job.id,
                shopDomain: connection.shopDomain,
                orderReference: apiOrder.orderReference
            });

            try {
                const retryContext = {
                    jobId: job.id,
                    shopDomain: connection.shopDomain,
                    orderReference: apiOrder.orderReference
                };
                const existingOrder = await runShopifyOperationWithRetry(
                    job,
                    "FIND_EXISTING_ORDER",
                    retryContext,
                    () => findExistingOrder(connection.shopDomain, connection.accessToken, apiOrder.orderReference, {
                        jobId: job.id
                    })
                );

                if (existingOrder) {
                    setJobStatusMessage(job, `Updating existing Shopify order ${apiOrder.orderReference}.`);
                    const updatedOrder = await runShopifyOperationWithRetry(
                        job,
                        "UPDATE_ORDER",
                        retryContext,
                        () => updateOrder(connection.shopDomain, connection.accessToken, existingOrder, apiOrder.orderInput, {
                            jobId: job.id,
                            orderReference: apiOrder.orderReference
                        })
                    );
                    appendJobResult(job, {
                        orderReference: apiOrder.orderReference,
                        action: "UPDATE",
                        status: "updated",
                        shopifyOrderId: updatedOrder.id,
                        shopifyOrderName: updatedOrder.name,
                        message: "Updated note, phone, delivery address, and custom attributes on the existing Shopify order."
                    });
                    writeImportLog("import_order_completed", {
                        jobId: job.id,
                        shopDomain: connection.shopDomain,
                        orderReference: apiOrder.orderReference,
                        action: "UPDATE",
                        status: "updated",
                        shopifyOrderId: updatedOrder.id,
                        shopifyOrderName: updatedOrder.name
                    });
                } else {
                    setJobStatusMessage(job, `Creating Shopify order ${apiOrder.orderReference}.`);
                    const createdOrder = await runShopifyOperationWithRetry(
                        job,
                        "CREATE_ORDER",
                        retryContext,
                        async () => {
                            await waitForOrderCreateSlot(connection.shopDomain, retryContext, job);
                            return createOrder(connection.shopDomain, connection.accessToken, apiOrder.orderInput, {
                                jobId: job.id,
                                orderReference: apiOrder.orderReference
                            });
                        }
                    );
                    appendJobResult(job, {
                        orderReference: apiOrder.orderReference,
                        action: "CREATE",
                        status: "created",
                        shopifyOrderId: createdOrder.id,
                        shopifyOrderName: createdOrder.name,
                        message: "Created a new Shopify order from the uploaded Odoo CSV."
                    });
                    writeImportLog("import_order_completed", {
                        jobId: job.id,
                        shopDomain: connection.shopDomain,
                        orderReference: apiOrder.orderReference,
                        action: "CREATE",
                        status: "created",
                        shopifyOrderId: createdOrder.id,
                        shopifyOrderName: createdOrder.name
                    });
                }
            } catch (error) {
                writeImportLog("import_order_failed", {
                    jobId: job.id,
                    shopDomain: connection.shopDomain,
                    orderReference: apiOrder.orderReference,
                    message: error.message
                });
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
        job.runtimeActive = false;
        job.completedAt = new Date().toISOString();
        job.updatedAt = new Date().toISOString();
        setJobStatusMessage(job, "");
        writeImportLog("import_job_completed", {
            jobId: job.id,
            shopDomain: connection.shopDomain,
            summary: job.summary
        });
    } catch (error) {
        job.status = "failed";
        job.runtimeActive = false;
        job.error = error.message;
        job.updatedAt = new Date().toISOString();
        setJobStatusMessage(job, "");
        writeImportLog("import_job_failed", {
            jobId: job.id,
            shopDomain: normalizeShopDomain(runtimePayload.shopDomain || job.shopDomain),
            message: error.message
        });
    }
}

function getJobPayload(job) {
    const summary = job.summary || getDefaultSummary();

    return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt || "",
        completedAt: job.completedAt || "",
        stats: job.stats,
        summary,
        warnings: job.warnings,
        statusMessage: job.statusMessage || "",
        error: job.error || "",
        recentResults: job.recentResults,
        pendingOrders: Math.max(0, Number(summary.totalOrders || 0) - Number(summary.processedOrders || 0)),
        persisted: !!job.persisted,
        sourceFileName: job.sourceFileName || "",
        batchLabel: job.batchLabel || "",
        shopDomain: normalizeShopDomain(job.shopDomain),
        importPlanId: job.importPlanId || "",
        importPlanBatchNumber: job.importPlanBatchNumber || 0
    };
}

function startJobInBackground(job, payload) {
    jobs.set(job.id, job);
    runImportJob(job, payload).catch((error) => {
        job.runtimeActive = false;
        job.status = "failed";
        job.error = error.message;
        job.updatedAt = new Date().toISOString();
        savePersistedJob(job);
        syncImportPlanBatchFromJob(job);
    });
}

function startImportPlanBatch(plan, batch, payload) {
    const runningJob = batch.jobId ? getJobById(batch.jobId) : null;

    if (runningJob && runningJob.runtimeActive && (runningJob.status === "running" || runningJob.status === "queued")) {
        return runningJob;
    }

    if (runningJob && runningJob.status === "completed") {
        return runningJob;
    }

    const job = runningJob || createJob(plan.stats, {
        persisted: true,
        csvFilePath: plan.csvFilePath,
        sourceFileName: plan.sourceFileName,
        shopDomain: payload.shopDomain,
        batchLabel: `Batch ${batch.number}`,
        orderReferences: batch.orderReferences,
        timeZoneOffset: payload.timeZoneOffset || plan.timeZoneOffset,
        importPlanId: plan.id,
        importPlanBatchNumber: batch.number
    });

    job.persisted = true;
    job.csvFilePath = plan.csvFilePath;
    job.sourceFileName = plan.sourceFileName;
    job.shopDomain = normalizeShopDomain(payload.shopDomain || job.shopDomain);
    job.batchLabel = `Batch ${batch.number}`;
    job.orderReferences = batch.orderReferences;
    job.timeZoneOffset = payload.timeZoneOffset || plan.timeZoneOffset || job.timeZoneOffset;
    job.importPlanId = plan.id;
    job.importPlanBatchNumber = batch.number;
    job.summary.totalOrders = batch.orderCount || batch.orderReferences.length;
    recalculateJobSummary(job);
    batch.jobId = job.id;
    batch.status = "queued";
    batch.summary = job.summary;
    batch.updatedAt = new Date().toISOString();
    batch.message = "Queued";
    plan.updatedAt = new Date().toISOString();
    savePersistedJob(job);
    saveImportPlan(plan);

    startJobInBackground(job, {
        ...payload,
        csvText: getImportPlanCsvText(plan),
        orderReferences: batch.orderReferences,
        batchLabel: `Batch ${batch.number}`,
        timeZoneOffset: payload.timeZoneOffset || plan.timeZoneOffset
    });

    return job;
}

async function handleApiRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/connect") {
        try {
            const payload = await readJsonBody(request);
            const connection = await connectShop(payload, {
                phase: "manual_connect"
            });
            saveConnection(connection);
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

    if (request.method === "GET" && url.pathname === "/api/connection") {
        const connection = getSavedConnection();
        sendJson(response, 200, {
            ok: true,
            shopDomain: connection.shopDomain,
            accessToken: connection.accessToken,
            hasConnection: !!(connection.shopDomain && connection.accessToken)
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/import-plans") {
        const plans = listImportPlans().map(getImportPlanPayload);
        sendJson(response, 200, {
            ok: true,
            plans
        });
        return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/import-data") {
        try {
            clearPersistedImportData();
            sendJson(response, 200, {
                ok: true
            });
        } catch (error) {
            sendJson(response, 400, {
                ok: false,
                error: error.message
            });
        }
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/import-plans") {
        try {
            const payload = await readJsonBody(request);
            const plan = createImportPlan(payload);
            sendJson(response, 201, {
                ok: true,
                plan: getImportPlanPayload(plan)
            });
        } catch (error) {
            sendJson(response, 400, {
                ok: false,
                error: error.message
            });
        }
        return;
    }

    if (url.pathname.startsWith("/api/import-plans/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const planId = parts[2];
        const plan = loadImportPlan(planId);

        if (!plan) {
            sendJson(response, 404, {
                ok: false,
                error: "Saved import plan not found."
            });
            return;
        }

        if (request.method === "GET" && parts.length === 3) {
            sendJson(response, 200, {
                ok: true,
                plan: getImportPlanPayload(plan)
            });
            return;
        }

        if (request.method === "POST" && parts.length === 6 && parts[3] === "batches" && parts[5] === "start") {
            try {
                const batchNumber = Number(parts[4]);
                const batch = plan.batches.find((item) => Number(item.number) === batchNumber);

                if (!batch) {
                    throw new Error("Saved import batch not found.");
                }

                const payload = await readJsonBody(request);
                const job = startImportPlanBatch(plan, batch, payload);
                sendJson(response, 202, {
                    ok: true,
                    job: getJobPayload(job),
                    plan: getImportPlanPayload(loadImportPlan(plan.id) || plan)
                });
            } catch (error) {
                sendJson(response, 400, {
                    ok: false,
                    error: error.message
                });
            }
            return;
        }

        sendJson(response, 404, {
            ok: false,
            error: "Saved import route not found."
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/import-jobs") {
        const importJobs = listPersistedJobs().map(getJobPayload);
        sendJson(response, 200, {
            ok: true,
            jobs: importJobs
        });
        return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/import-jobs/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const jobId = parts[2];
        const job = getJobById(jobId);

        if (!job) {
            sendJson(response, 404, {
                ok: false,
                error: "Import job not found."
            });
            return;
        }

        if (parts.length === 4 && parts[3] === "resume") {
            try {
                const payload = await readJsonBody(request);

                if (!job.runtimeActive && job.status !== "completed") {
                    startJobInBackground(job, {
                        ...payload,
                        csvText: getJobCsvText(job),
                        shopDomain: payload.shopDomain || job.shopDomain,
                        orderReferences: job.orderReferences,
                        batchLabel: job.batchLabel,
                        timeZoneOffset: payload.timeZoneOffset || job.timeZoneOffset
                    });
                }

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
    }

    if (request.method === "POST" && url.pathname === "/api/import/start") {
        try {
            const payload = await readJsonBody(request);
            if (!payload.csvText || !String(payload.csvText).trim()) {
                throw new Error("Upload an Odoo CSV before starting the import.");
            }

            const preview = buildApiImportOrders(payload.csvText, payload.timeZoneOffset);
            const apiOrders = filterApiOrdersForPayload(preview.apiOrders, payload);
            if (getRequestedOrderReferences(payload).length && !apiOrders.length) {
                throw new Error("The selected batch did not match any orders in the uploaded CSV.");
            }

            const job = createJob(preview.converted.stats, {
                persisted: true,
                sourceFileName: payload.sourceFileName || "",
                shopDomain: payload.shopDomain,
                batchLabel: payload.batchLabel || "",
                orderReferences: getRequestedOrderReferences(payload),
                timeZoneOffset: payload.timeZoneOffset || ""
            });
            job.summary.totalOrders = apiOrders.length;
            saveJobCsv(job, payload.csvText);
            startJobInBackground(job, payload);

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
        const job = getJobById(jobId);

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

    if (url.pathname === "/healthz") {
        sendJson(response, 200, {
            ok: true,
            service: "odoo-shopify-order-sync"
        });
        return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
        sendFile(response, path.join(__dirname, "odoo_matrixify_browser.html"));
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
    writeImportLog("server_started", {
        url: `http://${HOST}:${PORT}`,
        apiVersion: API_VERSION
    });
    sendInterruptedJobAlertsOnStartup();
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        process.stdout.write(`Port ${PORT} is already in use. Open http://${HOST}:${PORT}\n`);
        process.exit(0);
        return;
    }

    throw error;
});
