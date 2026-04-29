(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.OdooMatrixifyConverter = factory();
    }
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    var MATRIXIFY_HEADERS = [
        "Name",
        "Command",
        "Send Receipt",
        "Inventory Behaviour",
        "Processed At",
        "Currency",
        "Source",
        "Source Identifier",
        "Payment: Status",
        "Phone",
        "Note",
        "Additional Details",
        "Line: Type",
        "Line: Quantity",
        "Line: Title",
        "Line: Price",
        "Line: Properties",
        "Odoo Order Reference",
        "Odoo Customer",
        "Odoo Total",
        "Odoo Currency",
        "Odoo Delivery Address",
        "Odoo Cart Quantity",
        "Odoo Mobile",
        "Odoo Order Status",
        "Odoo Payment Status",
        "Odoo Order ID",
        "Odoo Order Lines",
        "Odoo Order Lines displayed on Website",
        "Odoo Order Date",
        "Odoo Shipping Address",
        "Odoo Shipping Amount",
        "Odoo Shipping Phone",
        "Odoo Shipping Policy",
        "Odoo Shipping Status",
        "Odoo Delivery Date",
        "Odoo Transactions",
        "Derived Line Price Allocation",
        "Derived Quantity Note",
        "Derived Phone Note"
    ];

    var MAPPING_HEADERS = [
        "Source Column",
        "Matrixify Column / Handling",
        "Action",
        "Notes"
    ];

    var MAPPING_ROWS = [
        {
            "Source Column": "Order Reference",
            "Matrixify Column / Handling": "Name, Source Identifier, Odoo Order Reference",
            "Action": "Renamed + Copied",
            "Notes": "Used as the Shopify order key and preserved in audit columns."
        },
        {
            "Source Column": "Customer",
            "Matrixify Column / Handling": "Additional Details, Odoo Customer",
            "Action": "Copied to audit/detail",
            "Notes": "Not forced into Shopify Customer fields because source lacks a reliable customer identifier."
        },
        {
            "Source Column": "Total",
            "Matrixify Column / Handling": "Line: Price (distributed), Odoo Total",
            "Action": "Derived",
            "Notes": "Source has no line prices, so order total was split across unit rows to preserve the order total exactly."
        },
        {
            "Source Column": "Currency",
            "Matrixify Column / Handling": "Currency, Odoo Currency",
            "Action": "Renamed + Copied",
            "Notes": "Kept as the Shopify order currency."
        },
        {
            "Source Column": "Delivery Address",
            "Matrixify Column / Handling": "Additional Details, Odoo Delivery Address",
            "Action": "Copied to audit/detail",
            "Notes": "Not mapped to Shopify address fields because the export contains names, not structured addresses."
        },
        {
            "Source Column": "Cart Quantity",
            "Matrixify Column / Handling": "Line: Quantity (expanded into unit rows), Odoo Cart Quantity",
            "Action": "Derived",
            "Notes": "Used to expand rows so the Shopify file matches the source quantity count."
        },
        {
            "Source Column": "Mobile",
            "Matrixify Column / Handling": "Phone, Additional Details, Odoo Mobile",
            "Action": "Derived + Copied",
            "Notes": "Normalized to +65 where possible; original value preserved."
        },
        {
            "Source Column": "Order Status",
            "Matrixify Column / Handling": "Additional Details, Odoo Order Status",
            "Action": "Copied to audit/detail",
            "Notes": "Not mapped to fulfillment because Matrixify requires fulfillment lines for shipped/delivered status."
        },
        {
            "Source Column": "Payment Status",
            "Matrixify Column / Handling": "Payment: Status, Odoo Payment Status",
            "Action": "Fallback",
            "Notes": "Source values were blank, so generated file uses Matrixify's default paid state for new orders."
        },
        {
            "Source Column": "Order ID",
            "Matrixify Column / Handling": "Odoo Order ID",
            "Action": "Not imported",
            "Notes": "Source column is blank for all rows."
        },
        {
            "Source Column": "Order Lines",
            "Matrixify Column / Handling": "Line: Title, Line: Properties, Odoo Order Lines",
            "Action": "Parsed + Copied",
            "Notes": "Parsed into SKU and title; SKU stored in line properties to keep custom line item import safe."
        },
        {
            "Source Column": "Order Lines displayed on Website",
            "Matrixify Column / Handling": "Odoo Order Lines displayed on Website",
            "Action": "Not imported",
            "Notes": "Kept only as an audit column because it duplicates order lines and is not needed by Matrixify."
        },
        {
            "Source Column": "Order Date",
            "Matrixify Column / Handling": "Processed At, Odoo Order Date",
            "Action": "Renamed + Copied",
            "Notes": "Used as the Shopify processed date."
        },
        {
            "Source Column": "Shipping Address",
            "Matrixify Column / Handling": "Odoo Shipping Address",
            "Action": "Not imported",
            "Notes": "Source column is blank for all rows."
        },
        {
            "Source Column": "Shipping Amount",
            "Matrixify Column / Handling": "Odoo Shipping Amount",
            "Action": "Not imported",
            "Notes": "Source column is blank for all rows, so no Shopify Shipping Line was created."
        },
        {
            "Source Column": "Shipping Phone",
            "Matrixify Column / Handling": "Odoo Shipping Phone",
            "Action": "Not imported",
            "Notes": "Source column is blank for all rows."
        },
        {
            "Source Column": "Shipping Policy",
            "Matrixify Column / Handling": "Additional Details, Odoo Shipping Policy",
            "Action": "Copied to audit/detail",
            "Notes": "Preserved as metadata because it has no direct Shopify order field."
        },
        {
            "Source Column": "Shipping Status",
            "Matrixify Column / Handling": "Additional Details, Odoo Shipping Status",
            "Action": "Copied to audit/detail",
            "Notes": "Not mapped to Shopify fulfillment status because fulfillment lines are required."
        },
        {
            "Source Column": "Delivery Date",
            "Matrixify Column / Handling": "Odoo Delivery Date",
            "Action": "Not imported",
            "Notes": "Source column is blank for all rows."
        },
        {
            "Source Column": "Transactions",
            "Matrixify Column / Handling": "Odoo Transactions",
            "Action": "Not imported",
            "Notes": "Source column is blank for all rows, so no transaction rows were created."
        }
    ];

    var CUSTOMER_MAPPING_HEADERS = [
        "Source Column",
        "Shopify Column / Handling",
        "Action",
        "Notes"
    ];

    var CUSTOMER_MAPPING_ROWS = [
        {
            "Source Column": "Display Name",
            "Shopify Column / Handling": "First Name, Last Name, Note",
            "Action": "Derived",
            "Notes": "Split into first and last name; for values like 'Company, Person' the person part is preferred as the name and the original display name is preserved in the note."
        },
        {
            "Source Column": "Phone",
            "Shopify Column / Handling": "Phone, Default Address Phone",
            "Action": "Renamed + Normalized",
            "Notes": "Phone is normalized where possible and copied to both customer and default address phone."
        },
        {
            "Source Column": "Email",
            "Shopify Column / Handling": "Email",
            "Action": "Renamed",
            "Notes": "Copied directly to Shopify customer email."
        },
        {
            "Source Column": "Activities",
            "Shopify Column / Handling": "Note",
            "Action": "Copied to note",
            "Notes": "Preserved inside the customer note because there is no direct Shopify customer template column for Odoo activities."
        },
        {
            "Source Column": "City",
            "Shopify Column / Handling": "Default Address City",
            "Action": "Renamed",
            "Notes": "If Odoo city is blank and country is Singapore, the city defaults to Singapore."
        },
        {
            "Source Column": "Country",
            "Shopify Column / Handling": "Default Address Country Code",
            "Action": "Derived",
            "Notes": "Converted from country name to a Shopify country code when recognized."
        },
        {
            "Source Column": "Company",
            "Shopify Column / Handling": "Default Address Company",
            "Action": "Renamed",
            "Notes": "Copied directly into the Shopify default address company field."
        },
        {
            "Source Column": "Contact Address Complete",
            "Shopify Column / Handling": "Default Address Address1, Default Address Address2, Note",
            "Action": "Derived",
            "Notes": "Used as an address fallback when the main complete address needs support, and preserved in the note."
        },
        {
            "Source Column": "Complete Address",
            "Shopify Column / Handling": "Default Address Address1, Default Address Address2",
            "Action": "Derived",
            "Notes": "Split into address lines after removing duplicated zip and country lines."
        },
        {
            "Source Column": "Created on",
            "Shopify Column / Handling": "Note",
            "Action": "Copied to note",
            "Notes": "Preserved in the note for audit history."
        },
        {
            "Source Column": "Currency",
            "Shopify Column / Handling": "Note",
            "Action": "Copied to note",
            "Notes": "Preserved in the note because the Shopify customer template has no direct currency column."
        },
        {
            "Source Column": "Payment Status / Payment Terms",
            "Shopify Column / Handling": "Tags, Note",
            "Action": "Derived",
            "Notes": "Payment metadata is copied into customer tags and note to mirror order-level payment tracking."
        },
        {
            "Source Column": "Zip",
            "Shopify Column / Handling": "Default Address Zip",
            "Action": "Renamed",
            "Notes": "Copied directly to the Shopify default address zip field."
        },
        {
            "Source Column": "Contact",
            "Shopify Column / Handling": "First Name, Last Name, Note",
            "Action": "Derived",
            "Notes": "Used as a fallback contact/person name when available and preserved in the note."
        },
        {
            "Source Column": "Gender",
            "Shopify Column / Handling": "Note",
            "Action": "Copied to note",
            "Notes": "Preserved in the note because the Shopify customer template has no direct gender column."
        },
        {
            "Source Column": "Parent name",
            "Shopify Column / Handling": "Default Address Company, Note",
            "Action": "Derived",
            "Notes": "Used as a company fallback when Odoo Company is blank and preserved in the note."
        },
        {
            "Source Column": "Channels/Alias Name",
            "Shopify Column / Handling": "Note",
            "Action": "Copied to note",
            "Notes": "Preserved in the note for audit history."
        },
        {
            "Source Column": "Channels/Display Name",
            "Shopify Column / Handling": "Note",
            "Action": "Copied to note",
            "Notes": "Preserved in the note for audit history."
        }
    ];

    var COUNTRY_CODE_MAP = {
        "singapore": "SG",
        "india": "IN",
        "united states": "US",
        "usa": "US",
        "us": "US",
        "canada": "CA",
        "malaysia": "MY",
        "indonesia": "ID",
        "philippines": "PH",
        "thailand": "TH",
        "vietnam": "VN",
        "australia": "AU",
        "united kingdom": "GB",
        "uk": "GB",
        "great britain": "GB",
        "united arab emirates": "AE",
        "uae": "AE"
    };

    function getStringValue(value) {
        if (value === null || value === undefined) {
            return "";
        }
        return String(value).trim();
    }

    function parseDecimalOrNull(value) {
        var trimmed = getStringValue(value);
        if (!trimmed) {
            return null;
        }

        var parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function parseIntOrNull(value) {
        var trimmed = getStringValue(value);
        if (!trimmed) {
            return null;
        }

        var parsed = parseInt(trimmed, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizePhone(phone) {
        var digits = getStringValue(phone).replace(/\D/g, "");
        if (!digits) {
            return "";
        }

        if (digits.length === 8) {
            return "+65" + digits;
        }

        if (digits.length === 10 && digits.indexOf("65") === 0) {
            return "+" + digits;
        }

        if (digits.indexOf("65") === 0 && digits.length > 10) {
            return "+" + digits;
        }

        return "";
    }

    function escapeMatrixifyValuePart(value) {
        return getStringValue(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
    }

    function formatMatrixifyKeyValueLine(key, value) {
        return getStringValue(key) + ": " + escapeMatrixifyValuePart(value);
    }

    function escapeRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function splitOrderLine(orderReference, rawLine) {
        var cleanLine = getStringValue(rawLine);
        if (!cleanLine) {
            return {
                rawLine: "",
                sku: "",
                title: ""
            };
        }

        var pattern = new RegExp("^" + escapeRegex(orderReference) + "\\s*-\\s*(\\S+)\\s*(.*)$");
        var match = cleanLine.match(pattern);

        if (match) {
            var sku = getStringValue(match[1]);
            var title = getStringValue(match[2]);

            if (!title) {
                title = sku;
                sku = "";
            }

            return {
                rawLine: cleanLine,
                sku: sku,
                title: title
            };
        }

        return {
            rawLine: cleanLine,
            sku: "",
            title: cleanLine
        };
    }

    function getAdditionalDetails(order, actualLineCount, targetLineCount) {
        var details = [];
        details.push(formatMatrixifyKeyValueLine("Odoo Order Reference", order.orderReference));

        if (order.totalRaw) {
            details.push(formatMatrixifyKeyValueLine("Odoo Total", order.totalRaw + " " + order.currency));
        } else {
            details.push(formatMatrixifyKeyValueLine("Odoo Total", "Missing in source export"));
        }

        if (order.customer) {
            details.push(formatMatrixifyKeyValueLine("Odoo Customer", order.customer));
        }

        if (order.deliveryAddress) {
            details.push(formatMatrixifyKeyValueLine("Odoo Delivery Address", order.deliveryAddress));
        }

        if (order.mobileRaw) {
            details.push(formatMatrixifyKeyValueLine("Odoo Mobile", order.mobileRaw));
        }

        if (order.shippingPolicy) {
            details.push(formatMatrixifyKeyValueLine("Odoo Shipping Policy", order.shippingPolicy));
        }

        if (order.orderStatus) {
            details.push(formatMatrixifyKeyValueLine("Odoo Order Status", order.orderStatus));
        }

        if (order.shippingStatus) {
            details.push(formatMatrixifyKeyValueLine("Odoo Shipping Status", order.shippingStatus));
        }

        if (order.orderDate) {
            details.push(formatMatrixifyKeyValueLine("Odoo Order Date", order.orderDate));
        }

        details.push(formatMatrixifyKeyValueLine("Odoo Parsed Order Lines", actualLineCount));
        details.push(formatMatrixifyKeyValueLine("Odoo Cart Quantity", order.cartQuantityRaw));

        if (targetLineCount > actualLineCount) {
            details.push(formatMatrixifyKeyValueLine("Quantity Assumption", "Source cart quantity exceeded parsed order lines by " + (targetLineCount - actualLineCount) + "; extra quantity assigned to the first line item."));
        }

        if (targetLineCount < actualLineCount) {
            details.push(formatMatrixifyKeyValueLine("Quantity Warning", "Parsed order lines exceeded source cart quantity by " + (actualLineCount - targetLineCount) + "; all parsed lines were kept."));
        }

        return details.join("\n");
    }

    function parseCsvDocument(text) {
        var content = String(text || "");
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }

        var rows = [];
        var row = [];
        var field = "";
        var inQuotes = false;
        var i;

        for (i = 0; i < content.length; i += 1) {
            var char = content[i];
            var next = content[i + 1];

            if (inQuotes) {
                if (char === "\"") {
                    if (next === "\"") {
                        field += "\"";
                        i += 1;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += char;
                }
            } else if (char === "\"") {
                inQuotes = true;
            } else if (char === ",") {
                row.push(field);
                field = "";
            } else if (char === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            } else if (char === "\r") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
                if (next === "\n") {
                    i += 1;
                }
            } else {
                field += char;
            }
        }

        row.push(field);
        if (!(row.length === 1 && row[0] === "" && rows.length > 0)) {
            rows.push(row);
        }

        if (!rows.length) {
            return {
                headers: [],
                rows: []
            };
        }

        var headers = rows[0].map(function (header) {
            return getStringValue(header);
        });

        return {
            headers: headers,
            rows: rows.slice(1).filter(function (rawRow) {
            return rawRow.some(function (value) {
                return getStringValue(value) !== "";
            });
        }).map(function (rawRow) {
            var record = {};
            headers.forEach(function (header, index) {
                record[header] = rawRow[index] === undefined ? "" : rawRow[index];
            });
            return record;
        })
        };
    }

    function parseCsv(text) {
        return parseCsvDocument(text).rows;
    }

    function csvEscape(value) {
        var text = value === null || value === undefined ? "" : String(value);
        if (/[",\r\n]/.test(text)) {
            return "\"" + text.replace(/"/g, "\"\"") + "\"";
        }
        return text;
    }

    function toCsv(rows, headers) {
        var lines = [];
        lines.push(headers.map(csvEscape).join(","));
        rows.forEach(function (row) {
            lines.push(headers.map(function (header) {
                return csvEscape(row[header]);
            }).join(","));
        });
        return lines.join("\r\n");
    }

    function cloneLine(line) {
        return {
            sourceOrderLine: line.sourceOrderLine,
            odooSku: line.odooSku,
            title: line.title,
            assumedExtraQuantity: !!line.assumedExtraQuantity
        };
    }

    function normalizeCountryCode(country) {
        var cleaned = getStringValue(country).toLowerCase();
        if (!cleaned) {
            return "";
        }

        if (/^[a-z]{2}$/.test(cleaned)) {
            return cleaned.toUpperCase();
        }

        return COUNTRY_CODE_MAP[cleaned] || "";
    }

    function isLikelyEmail(value) {
        var cleaned = getStringValue(value);
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned);
    }

    function splitDisplayName(displayName) {
        var cleaned = getStringValue(displayName).replace(/\s+/g, " ").trim();
        if (!cleaned) {
            return {
                firstName: "",
                lastName: ""
            };
        }

        var parts = cleaned.split(" ");
        if (parts.length === 1) {
            return {
                firstName: cleaned,
                lastName: ""
            };
        }

        return {
            firstName: parts.slice(0, -1).join(" "),
            lastName: parts[parts.length - 1]
        };
    }

    function chooseCustomerName(row) {
        var displayName = getStringValue(row["Display Name"]);
        var contact = getStringValue(row["Contact"]);
        var parentName = getStringValue(row["Parent name"]);
        var candidate = displayName;

        if (displayName.indexOf(",") >= 0) {
            var parts = displayName.split(",");
            if (parts.length >= 2 && getStringValue(parts[1])) {
                candidate = getStringValue(parts.slice(1).join(","));
            }
        }

        if (!candidate && contact) {
            candidate = contact;
        }

        if (parentName && contact && getStringValue(contact).toLowerCase().indexOf(getStringValue(parentName).toLowerCase()) === 0) {
            var contactParts = contact.split(",");
            if (contactParts.length >= 2 && getStringValue(contactParts[1])) {
                candidate = getStringValue(contactParts.slice(1).join(","));
            }
        }

        return splitDisplayName(candidate || displayName || contact);
    }

    function parseCustomerAddress(completeAddress, zip, country, city) {
        var normalizedAddress = String(completeAddress || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        var zipClean = getStringValue(zip).replace(/\s+/g, "");
        var countryClean = getStringValue(country);
        var countryLower = countryClean.toLowerCase();
        var lines = normalizedAddress.split(/\n+/).map(function (line) {
            return getStringValue(line);
        }).filter(Boolean);

        lines = lines.filter(function (line) {
            return line.toLowerCase() !== countryLower;
        }).filter(function (line) {
            return line.replace(/\s+/g, "") !== zipClean;
        });

        return {
            address1: lines.length ? lines[0] : "",
            address2: lines.length > 1 ? lines.slice(1).join(", ") : "",
            city: getStringValue(city) || (countryLower === "singapore" ? "Singapore" : "")
        };
    }

    function buildCustomerNote(row) {
        var lines = [];

        if (getStringValue(row["Display Name"])) {
            lines.push("Odoo Display Name: " + getStringValue(row["Display Name"]));
        }

        if (getStringValue(row["Created on"])) {
            lines.push("Odoo Created on: " + getStringValue(row["Created on"]));
        }

        if (getStringValue(row["Currency"])) {
            lines.push("Odoo Currency: " + getStringValue(row["Currency"]));
        }

        if (getStringValue(row["Activities"])) {
            lines.push("Odoo Activities: " + getStringValue(row["Activities"]));
        }

        if (getStringValue(row["Gender"])) {
            lines.push("Odoo Gender: " + getStringValue(row["Gender"]));
        }

        if (getStringValue(row["Parent name"])) {
            lines.push("Odoo Parent name: " + getStringValue(row["Parent name"]));
        }

        if (getStringValue(row["Contact"])) {
            lines.push("Odoo Contact: " + getStringValue(row["Contact"]));
        }

        if (getStringValue(row["Contact Address Complete"])) {
            lines.push("Odoo Contact Address Complete: " + getStringValue(row["Contact Address Complete"]));
        }

        if (getStringValue(row["Channels/Alias Name"])) {
            lines.push("Odoo Channels Alias Name: " + getStringValue(row["Channels/Alias Name"]));
        }

        if (getStringValue(row["Channels/Display Name"])) {
            lines.push("Odoo Channels Display Name: " + getStringValue(row["Channels/Display Name"]));
        }

        return lines.join("\n");
    }

    function createEmptyRecord(headers) {
        var record = {};
        headers.forEach(function (header) {
            record[header] = "";
        });
        return record;
    }

    function buildCustomerRows(templateHeaders, odooRows) {
        return odooRows.map(function (row) {
            var record = createEmptyRecord(templateHeaders);
            var nameParts = chooseCustomerName(row);
            var addressSource = getStringValue(row["Complete Address"]) || getStringValue(row["Contact Address Complete"]);
            var address = parseCustomerAddress(addressSource, row["Zip"], row["Country"], row["City"]);
            var phone = normalizePhone(row["Phone"]);
            var email = isLikelyEmail(row["Email"]) ? getStringValue(row["Email"]) : "";
            var company = getStringValue(row["Company"]) || getStringValue(row["Parent name"]);
            var note = buildCustomerNote(row);
            var paymentProfile = buildCustomerPaymentProfile(row);

            if (record.hasOwnProperty("First Name")) {
                record["First Name"] = nameParts.firstName;
            }
            if (record.hasOwnProperty("Last Name")) {
                record["Last Name"] = nameParts.lastName;
            }
            if (record.hasOwnProperty("Email")) {
                record["Email"] = email;
            }
            if (record.hasOwnProperty("Accepts Email Marketing")) {
                record["Accepts Email Marketing"] = "no";
            }
            if (record.hasOwnProperty("Default Address Company")) {
                record["Default Address Company"] = company;
            }
            if (record.hasOwnProperty("Default Address Address1")) {
                record["Default Address Address1"] = address.address1;
            }
            if (record.hasOwnProperty("Default Address Address2")) {
                record["Default Address Address2"] = address.address2;
            }
            if (record.hasOwnProperty("Default Address City")) {
                record["Default Address City"] = address.city;
            }
            if (record.hasOwnProperty("Default Address Province Code")) {
                record["Default Address Province Code"] = "";
            }
            if (record.hasOwnProperty("Default Address Country Code")) {
                record["Default Address Country Code"] = normalizeCountryCode(row["Country"]);
            }
            if (record.hasOwnProperty("Default Address Zip")) {
                record["Default Address Zip"] = getStringValue(row["Zip"]);
            }
            if (record.hasOwnProperty("Default Address Phone")) {
                record["Default Address Phone"] = phone;
            }
            if (record.hasOwnProperty("Phone")) {
                record["Phone"] = phone;
            }
            if (record.hasOwnProperty("Accepts SMS Marketing")) {
                record["Accepts SMS Marketing"] = "no";
            }
            if (record.hasOwnProperty("Tags")) {
                record["Tags"] = paymentProfile.tags;
            }
            if (record.hasOwnProperty("Note")) {
                record["Note"] = [note, paymentProfile.note].filter(Boolean).join("\n");
            }
            if (record.hasOwnProperty("Tax Exempt")) {
                record["Tax Exempt"] = "no";
            }

            return record;
        });
    }

    function buildCustomerPaymentProfile(row) {
        var paymentStatus = getStringValue(row["Payment Status"]) || getStringValue(row["payment_status"]);
        var paymentTerms = getStringValue(row["Payment Terms"]) || getStringValue(row["payment_terms"]) || getStringValue(row["Payment Term"]);
        var paymentReference = getStringValue(row["Payment Reference"]) || getStringValue(row["payment_reference"]);
        var tags = [];
        var noteParts = [];

        if (paymentStatus) {
            tags.push("odoo_payment_status:" + slugifyTagValue(paymentStatus));
            noteParts.push("Payment Status: " + paymentStatus);
        }
        if (paymentTerms) {
            tags.push("odoo_payment_terms:" + slugifyTagValue(paymentTerms));
            noteParts.push("Payment Terms: " + paymentTerms);
        }
        if (paymentReference) {
            noteParts.push("Payment Reference: " + paymentReference);
        }

        return {
            tags: tags.join(", "),
            note: noteParts.join(" | ")
        };
    }

    function slugifyTagValue(value) {
        return getStringValue(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
    }

    function buildOrders(sourceRows) {
        var orders = [];
        var currentOrder = null;

        sourceRows.forEach(function (row) {
            var orderReference = getStringValue(row["Order Reference"]);
            var orderLine = getStringValue(row["Order Lines"]);

            if (orderReference) {
                if (currentOrder) {
                    orders.push(currentOrder);
                }

                currentOrder = {
                    orderReference: orderReference,
                    customer: getStringValue(row["Customer"]),
                    totalRaw: getStringValue(row["Total"]),
                    total: parseDecimalOrNull(row["Total"]),
                    currency: getStringValue(row["Currency"]),
                    deliveryAddress: getStringValue(row["Delivery Address"]),
                    cartQuantityRaw: getStringValue(row["Cart Quantity"]),
                    cartQuantity: parseIntOrNull(row["Cart Quantity"]),
                    mobileRaw: getStringValue(row["Mobile"]),
                    normalizedPhone: normalizePhone(row["Mobile"]),
                    orderStatus: getStringValue(row["Order Status"]),
                    paymentStatus: getStringValue(row["Payment Status"]),
                    orderId: getStringValue(row["Order ID"]),
                    orderDate: getStringValue(row["Order Date"]),
                    shippingAddress: getStringValue(row["Shipping Address"]),
                    shippingAmount: getStringValue(row["Shipping Amount"]),
                    shippingPhone: getStringValue(row["Shipping Phone"]),
                    shippingPolicy: getStringValue(row["Shipping Policy"]),
                    shippingStatus: getStringValue(row["Shipping Status"]),
                    deliveryDate: getStringValue(row["Delivery Date"]),
                    transactions: getStringValue(row["Transactions"]),
                    sourceHeaderRow: row,
                    lineItems: []
                };
            }

            if (currentOrder && orderLine) {
                var parsedLine = splitOrderLine(currentOrder.orderReference, orderLine);
                currentOrder.lineItems.push({
                    sourceOrderLine: parsedLine.rawLine,
                    odooSku: parsedLine.sku,
                    title: parsedLine.title,
                    assumedExtraQuantity: false
                });
            }
        });

        if (currentOrder) {
            orders.push(currentOrder);
        }

        return orders;
    }

    function buildMatrixifyRows(orders) {
        var matrixifyRows = [];

        orders.forEach(function (order) {
            var actualLineCount = order.lineItems.length;
            var targetLineCount = order.cartQuantity && order.cartQuantity > 0 ? order.cartQuantity : actualLineCount;
            var expandedLines = order.lineItems.map(cloneLine);

            if (expandedLines.length > 0 && targetLineCount > expandedLines.length) {
                var firstLine = cloneLine(expandedLines[0]);
                while (expandedLines.length < targetLineCount) {
                    var extraLine = cloneLine(firstLine);
                    extraLine.assumedExtraQuantity = true;
                    expandedLines.push(extraLine);
                }
            }

            if (expandedLines.length === 0) {
                expandedLines.push({
                    sourceOrderLine: "",
                    odooSku: "",
                    title: "Imported Odoo Order",
                    assumedExtraQuantity: false
                });
                targetLineCount = 1;
            }

            var unitPrices = [];
            if (order.total !== null) {
                var totalCents = Math.round(order.total * 100);
                var baseCents = Math.floor(totalCents / expandedLines.length);
                var remainder = totalCents % expandedLines.length;
                var index;

                for (index = 0; index < expandedLines.length; index += 1) {
                    var lineCents = baseCents;
                    if (index < remainder) {
                        lineCents += 1;
                    }
                    unitPrices.push(lineCents / 100);
                }
            } else {
                expandedLines.forEach(function () {
                    unitPrices.push(0);
                });
            }

            var additionalDetails = getAdditionalDetails(order, actualLineCount, targetLineCount);
            var lineDistributionNote = targetLineCount > actualLineCount ? "Assumed extra quantity on duplicated first line item" : "";
            var orderNote = "Imported from Odoo CSV for Matrixify. Historical line prices were distributed from the order total because the source file had no line-level prices.";

            expandedLines.forEach(function (line, index) {
                var lineProperties = [];

                if (line.odooSku) {
                    lineProperties.push(formatMatrixifyKeyValueLine("Odoo SKU", line.odooSku));
                }

                if (line.sourceOrderLine) {
                    lineProperties.push(formatMatrixifyKeyValueLine("Odoo Source Line", line.sourceOrderLine));
                }

                if (line.assumedExtraQuantity) {
                    lineProperties.push(formatMatrixifyKeyValueLine("Quantity Assumption", "Added duplicate row to match Odoo cart quantity."));
                }

                matrixifyRows.push({
                    "Name": order.orderReference,
                    "Command": "NEW",
                    "Send Receipt": "FALSE",
                    "Inventory Behaviour": "bypass",
                    "Processed At": order.orderDate,
                    "Currency": order.currency || "SGD",
                    "Source": "odoo_migration",
                    "Source Identifier": order.orderReference,
                    "Payment: Status": order.paymentStatus || "paid",
                    "Phone": order.normalizedPhone,
                    "Note": orderNote,
                    "Additional Details": additionalDetails,
                    "Line: Type": "Line Item",
                    "Line: Quantity": "1",
                    "Line: Title": line.title,
                    "Line: Price": unitPrices[index].toFixed(2),
                    "Line: Properties": lineProperties.join("\n"),
                    "Odoo Order Reference": order.orderReference,
                    "Odoo Customer": order.customer,
                    "Odoo Total": order.totalRaw,
                    "Odoo Currency": order.currency,
                    "Odoo Delivery Address": order.deliveryAddress,
                    "Odoo Cart Quantity": order.cartQuantityRaw,
                    "Odoo Mobile": order.mobileRaw,
                    "Odoo Order Status": order.orderStatus,
                    "Odoo Payment Status": order.paymentStatus,
                    "Odoo Order ID": order.orderId,
                    "Odoo Order Lines": line.sourceOrderLine,
                    "Odoo Order Lines displayed on Website": getStringValue(order.sourceHeaderRow["Order Lines displayed on Website"]),
                    "Odoo Order Date": order.orderDate,
                    "Odoo Shipping Address": order.shippingAddress,
                    "Odoo Shipping Amount": order.shippingAmount,
                    "Odoo Shipping Phone": order.shippingPhone,
                    "Odoo Shipping Policy": order.shippingPolicy,
                    "Odoo Shipping Status": order.shippingStatus,
                    "Odoo Delivery Date": order.deliveryDate,
                    "Odoo Transactions": order.transactions,
                    "Derived Line Price Allocation": "Distributed from order total across " + expandedLines.length + " unit rows",
                    "Derived Quantity Note": line.assumedExtraQuantity ? lineDistributionNote : "",
                    "Derived Phone Note": order.mobileRaw && !order.normalizedPhone ? "Source phone could not be normalized safely" : ""
                });
            });
        });

        return matrixifyRows;
    }

    function getStats(orders, matrixifyRows) {
        return {
            ordersParsed: orders.length,
            matrixifyRowsWritten: matrixifyRows.length,
            ordersWithMissingTotal: orders.filter(function (order) {
                return order.total === null;
            }).length,
            ordersWithNormalizedPhone: orders.filter(function (order) {
                return !!order.normalizedPhone;
            }).length,
            ordersWithQuantityAssumptions: orders.filter(function (order) {
                var actualCount = order.lineItems.length;
                var targetCount = order.cartQuantity && order.cartQuantity > 0 ? order.cartQuantity : actualCount;
                return targetCount > actualCount;
            }).length
        };
    }

    function convertCsvText(csvText, options) {
        var settings = options || {};
        var sourceRows = parseCsv(csvText);

        if (!sourceRows.length) {
            throw new Error("The selected CSV does not contain any data rows.");
        }

        var orders = buildOrders(sourceRows);
        if (!orders.length) {
            throw new Error("No orders were detected. Please check that the CSV has the same Odoo order layout.");
        }

        var matrixifyRows = buildMatrixifyRows(orders);
        var stats = getStats(orders, matrixifyRows);
        var ordersFileName = settings.ordersFileName || "Orders.csv";
        var mappingFileName = settings.mappingFileName || "odoo_to_matrixify_column_mapping.csv";

        return {
            orders: orders,
            matrixifyRows: matrixifyRows,
            mappingRows: MAPPING_ROWS.slice(),
            matrixifyHeaders: MATRIXIFY_HEADERS.slice(),
            mappingHeaders: MAPPING_HEADERS.slice(),
            matrixifyCsvText: toCsv(matrixifyRows, MATRIXIFY_HEADERS),
            mappingCsvText: toCsv(MAPPING_ROWS, MAPPING_HEADERS),
            ordersFileName: ordersFileName,
            mappingFileName: mappingFileName,
            stats: stats
        };
    }

    function convertCustomerCsvTexts(templateCsvText, odooCsvText, options) {
        var settings = options || {};
        var templateDocument = parseCsvDocument(templateCsvText);
        var odooDocument = parseCsvDocument(odooCsvText);

        if (!templateDocument.headers.length) {
            throw new Error("The Shopify customer template file is empty.");
        }

        if (!odooDocument.rows.length) {
            throw new Error("The Odoo customer CSV does not contain any data rows.");
        }

        var customerRows = buildCustomerRows(templateDocument.headers, odooDocument.rows);
        var customerFileName = settings.customerFileName || "customers.shopify.csv";
        var mappingFileName = settings.mappingFileName || "customers.mapping.csv";

        return {
            templateHeaders: templateDocument.headers.slice(),
            odooRows: odooDocument.rows,
            customerRows: customerRows,
            mappingRows: CUSTOMER_MAPPING_ROWS.slice(),
            customerCsvText: toCsv(customerRows, templateDocument.headers),
            mappingCsvText: toCsv(CUSTOMER_MAPPING_ROWS, CUSTOMER_MAPPING_HEADERS),
            customerFileName: customerFileName,
            mappingFileName: mappingFileName,
            stats: {
                templateColumns: templateDocument.headers.length,
                odooColumns: odooDocument.headers.length,
                customersParsed: odooDocument.rows.length,
                customersWithEmail: odooDocument.rows.filter(function (row) {
                    return !!getStringValue(row["Email"]);
                }).length,
                customersWithPhone: odooDocument.rows.filter(function (row) {
                    return !!normalizePhone(row["Phone"]);
                }).length
            }
        };
    }

    return {
        parseCsv: parseCsv,
        parseCsvDocument: parseCsvDocument,
        toCsv: toCsv,
        convertCsvText: convertCsvText,
        convertCustomerCsvTexts: convertCustomerCsvTexts,
        matrixifyHeaders: MATRIXIFY_HEADERS.slice(),
        mappingHeaders: MAPPING_HEADERS.slice(),
        customerMappingHeaders: CUSTOMER_MAPPING_HEADERS.slice()
    };
}));
