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

    var DEFAULT_CUSTOMER_HEADERS = [
        "First Name",
        "Last Name",
        "Email",
        "Accepts Email Marketing",
        "Default Address Company",
        "Default Address Address1",
        "Default Address Address2",
        "Default Address City",
        "Default Address Province Code",
        "Default Address Country Code",
        "Default Address Zip",
        "Default Address Phone",
        "Phone",
        "Accepts SMS Marketing",
        "Tags",
        "Note",
        "Tax Exempt"
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
            "Source Column": "Contact/Name",
            "Shopify Column / Handling": "New Shopify customer row, First Name, Last Name, Note",
            "Action": "Creates contact record",
            "Notes": "When a nested Odoo contact is present, an additional Shopify customer row is created for that contact person."
        },
        {
            "Source Column": "Contact/Email",
            "Shopify Column / Handling": "New Shopify customer row, Email",
            "Action": "Copied to contact record",
            "Notes": "Used as the email for the generated contact-person customer row."
        },
        {
            "Source Column": "Contact/Phone",
            "Shopify Column / Handling": "New Shopify customer row, Phone, Default Address Phone",
            "Action": "Copied + Normalized",
            "Notes": "Used as the contact-person phone when present; parent phone is used as a fallback."
        },
        {
            "Source Column": "Contact/City, Contact/Country, Contact/Complete Address",
            "Shopify Column / Handling": "New Shopify customer row, Default Address fields",
            "Action": "Derived",
            "Notes": "Used as the generated contact-person address, with parent address values used as fallbacks."
        },
        {
            "Source Column": "Contact/Tags",
            "Shopify Column / Handling": "New Shopify customer row, Tags",
            "Action": "Copied + Merged",
            "Notes": "Contact tags are merged with the parent customer's Odoo tags on generated contact-person rows."
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
        },
        {
            "Source Column": "Tags",
            "Shopify Column / Handling": "Tags",
            "Action": "Copied + Merged",
            "Notes": "Odoo tag values are merged into Shopify's comma-separated Tags field. Rows that only contain a tag are attached to the previous customer."
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

    function getFirstStringValue(values) {
        var index;
        var value;

        for (index = 0; index < values.length; index += 1) {
            value = getStringValue(values[index]);
            if (value) {
                return value;
            }
        }

        return "";
    }

    function getCommaPersonName(value) {
        var cleaned = getStringValue(value);
        var parts;

        if (cleaned.indexOf(",") < 0) {
            return "";
        }

        parts = cleaned.split(",");
        return getStringValue(parts.slice(1).join(","));
    }

    function getCommaParentName(value) {
        var cleaned = getStringValue(value);
        var parts;

        if (cleaned.indexOf(",") < 0) {
            return "";
        }

        parts = cleaned.split(",");
        return getStringValue(parts[0]);
    }

    function chooseCustomerName(row) {
        var displayName = getStringValue(row["Display Name"]);
        var contact = getStringValue(row["Contact"]);
        var parentName = getStringValue(row["Parent name"]);
        var candidate = getCommaPersonName(displayName) || displayName;

        if (!candidate && contact) {
            candidate = getCommaPersonName(contact) || contact;
        }

        if (parentName && contact && contact.toLowerCase().indexOf(parentName.toLowerCase()) === 0) {
            candidate = getCommaPersonName(contact) || candidate;
        }

        return splitDisplayName(candidate || displayName || contact);
    }

    function getNestedContactName(row) {
        return getFirstStringValue([
            row["Contact/Name"],
            getCommaPersonName(row["Contact"]),
            row["Contact"]
        ]);
    }

    function hasNestedContactDetails(row) {
        return !!getFirstStringValue([
            row["Contact/Name"],
            row["Contact/Email"],
            row["Contact/Phone"],
            row["Contact/City"],
            row["Contact/Country"],
            row["Contact/Tags"],
            row["Contact/Complete Address"]
        ]);
    }

    function hasMainCustomerDetails(row) {
        return !!getFirstStringValue([
            row["Display Name"],
            row["Phone"],
            row["Email"],
            row["Activities"],
            row["City"],
            row["Country"],
            row["Company"],
            row["Complete Address"],
            row["Contact Address Complete"],
            row["Zip"],
            row["Created on"],
            row["Currency"],
            row["Gender"],
            row["Parent name"],
            row["Channels/Alias Name"],
            row["Channels/Display Name"]
        ]);
    }

    function extractPostalCode(address) {
        var match = getStringValue(address).match(/(?:^|\D)(\d{6})(?:\D|$)/);
        return match ? match[1] : "";
    }

    function parseCustomerAddress(completeAddress, zip, country, city, addressNameToRemove) {
        var normalizedAddress = String(completeAddress || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        var zipValue = getStringValue(zip) || extractPostalCode(normalizedAddress);
        var zipClean = zipValue.replace(/\s+/g, "");
        var countryClean = getStringValue(country);
        var countryLower = countryClean.toLowerCase();
        var removableName = getStringValue(addressNameToRemove).toLowerCase();
        var lines = normalizedAddress.split(/\n+/).map(function (line) {
            return getStringValue(line);
        }).filter(Boolean);

        lines = lines.filter(function (line) {
            return line.toLowerCase() !== countryLower;
        }).filter(function (line) {
            return line.replace(/\s+/g, "") !== zipClean;
        });

        if (lines.length && removableName && lines[0].toLowerCase() === removableName) {
            lines.shift();
        }

        return {
            address1: lines.length ? lines[0] : "",
            address2: lines.length > 1 ? lines.slice(1).join(", ") : "",
            city: getStringValue(city) || (countryLower === "singapore" ? "Singapore" : ""),
            zip: zipValue
        };
    }

    function buildCustomerNote(row, source) {
        var context = source || {};
        var lines = [];

        function pushLine(label, value) {
            var cleaned = getStringValue(value);
            if (cleaned) {
                lines.push(label + ": " + cleaned);
            }
        }

        if (context.recordType === "contact") {
            pushLine("Odoo Record Type", "Contact");
            pushLine("Odoo Parent Customer", context.parentName);
            pushLine("Odoo Contact Name", context.displayName);
            pushLine("Odoo Contact Email", row["Contact/Email"]);
            pushLine("Odoo Contact Phone", row["Contact/Phone"]);
            pushLine("Odoo Contact Tags", row["Contact/Tags"]);
        }

        if (context.recordType === "customer") {
            pushLine("Odoo Record Type", "Customer");
        }

        pushLine("Odoo Display Name", row["Display Name"]);
        pushLine("Odoo Created on", row["Created on"]);
        pushLine("Odoo Currency", row["Currency"]);
        pushLine("Odoo Activities", row["Activities"]);
        pushLine("Odoo Gender", row["Gender"]);
        pushLine("Odoo Parent name", row["Parent name"]);
        pushLine("Odoo Contact", row["Contact"]);
        pushLine("Odoo Contact Address Complete", row["Contact Address Complete"]);
        pushLine("Odoo Contact Complete Address", row["Contact/Complete Address"]);
        pushLine("Odoo Channels Alias Name", row["Channels/Alias Name"]);
        pushLine("Odoo Channels Display Name", row["Channels/Display Name"]);

        return lines.join("\n");
    }

    function parseCustomerTags(value) {
        return getStringValue(value).split(/[\r\n,;]+/).map(function (part) {
            return getStringValue(part);
        }).filter(Boolean);
    }

    function appendUniqueValues(target, values) {
        values.forEach(function (value) {
            if (target.indexOf(value) === -1) {
                target.push(value);
            }
        });
    }

    function isCustomerTagOnlyRow(row) {
        var hasTags = !!getStringValue(row["Tags"]);
        if (!hasTags) {
            return false;
        }

        return Object.keys(row).every(function (key) {
            if (key === "Tags") {
                return true;
            }
            return getStringValue(row[key]) === "";
        });
    }

    function normalizeCustomerRows(odooRows) {
        var normalizedRows = [];
        var currentCustomer = null;
        var currentParentCustomer = null;
        var mergedTagOnlyRows = 0;
        var ignoredTagOnlyRows = 0;

        odooRows.forEach(function (row) {
            var tags = parseCustomerTags(row["Tags"]);

            if (isCustomerTagOnlyRow(row)) {
                if (currentParentCustomer) {
                    appendUniqueValues(currentParentCustomer.shopifyTags, tags);
                    mergedTagOnlyRows += 1;
                } else if (currentCustomer) {
                    appendUniqueValues(currentCustomer.shopifyTags, tags);
                    mergedTagOnlyRows += 1;
                } else {
                    ignoredTagOnlyRows += 1;
                }
                return;
            }

            if (!hasMainCustomerDetails(row) && !hasNestedContactDetails(row)) {
                return;
            }

            currentCustomer = {};
            Object.keys(row).forEach(function (key) {
                currentCustomer[key] = row[key];
            });
            currentCustomer.shopifyTags = [];
            appendUniqueValues(currentCustomer.shopifyTags, tags);

            if (currentParentCustomer && !hasMainCustomerDetails(row) && hasNestedContactDetails(row)) {
                currentCustomer._parentRow = currentParentCustomer;
            }

            if (hasMainCustomerDetails(row)) {
                currentParentCustomer = currentCustomer;
            }

            normalizedRows.push(currentCustomer);
        });

        return {
            rows: normalizedRows,
            mergedTagOnlyRows: mergedTagOnlyRows,
            ignoredTagOnlyRows: ignoredTagOnlyRows
        };
    }

    function createEmptyRecord(headers) {
        var record = {};
        headers.forEach(function (header) {
            record[header] = "";
        });
        return record;
    }

    function buildMainCustomerSource(row) {
        var displayName = getStringValue(row["Display Name"]) || getStringValue(row["Contact"]);
        var commaParentName = getCommaParentName(row["Display Name"]);
        var companyFallback = hasNestedContactDetails(row) ? displayName : "";

        return {
            row: row,
            recordType: "customer",
            displayName: displayName,
            originalDisplayName: getStringValue(row["Display Name"]),
            nameParts: chooseCustomerName(row),
            email: getStringValue(row["Email"]),
            phone: getStringValue(row["Phone"]),
            dedupePhone: getStringValue(row["Phone"]),
            addressSource: getStringValue(row["Complete Address"]) || getStringValue(row["Contact Address Complete"]),
            addressNameToRemove: commaParentName || getStringValue(row["Display Name"]),
            zip: getStringValue(row["Zip"]),
            country: getStringValue(row["Country"]),
            city: getStringValue(row["City"]),
            company: getFirstStringValue([row["Company"], row["Parent name"], commaParentName, companyFallback]),
            parentName: commaParentName,
            tags: Array.isArray(row.shopifyTags) ? row.shopifyTags.slice() : []
        };
    }

    function buildContactCustomerSource(row) {
        var parentRow = row._parentRow || row;
        var contactName = getNestedContactName(row);
        var contactEmail = getStringValue(row["Contact/Email"]);
        var contactPhone = getStringValue(row["Contact/Phone"]);
        var parentPhone = getFirstStringValue([row["Phone"], parentRow["Phone"]]);
        var contactNormalizedPhone = normalizePhone(contactPhone);
        var parentNormalizedPhone = normalizePhone(parentPhone);
        var contactPhoneForShopify = contactPhone;
        var parentName = getFirstStringValue([
            getCommaParentName(row["Contact"]),
            row["Display Name"],
            parentRow["Display Name"],
            row["Company"],
            row["Parent name"],
            parentRow["Company"],
            parentRow["Parent name"]
        ]);
        var addressSource = getFirstStringValue([
            row["Contact/Complete Address"],
            row["Contact Address Complete"],
            row["Complete Address"],
            parentRow["Contact Address Complete"],
            parentRow["Complete Address"]
        ]);
        var tags = [];

        if (!contactName && !contactEmail && !contactPhone) {
            return null;
        }

        if (!contactPhone || (contactNormalizedPhone && contactNormalizedPhone === parentNormalizedPhone)) {
            contactPhoneForShopify = "";
        }

        appendUniqueValues(tags, Array.isArray(parentRow.shopifyTags) ? parentRow.shopifyTags : []);
        appendUniqueValues(tags, Array.isArray(row.shopifyTags) ? row.shopifyTags : []);
        appendUniqueValues(tags, parseCustomerTags(row["Contact/Tags"]));

        return {
            row: row,
            recordType: "contact",
            displayName: contactName || contactEmail || contactPhone,
            originalDisplayName: getStringValue(row["Display Name"]),
            nameParts: splitDisplayName(contactName || contactEmail || contactPhone),
            email: contactEmail,
            phone: contactPhoneForShopify,
            dedupePhone: contactPhoneForShopify,
            parentPhone: parentPhone,
            addressSource: addressSource,
            addressNameToRemove: parentName,
            zip: getFirstStringValue([row["Contact/Zip"], row["Zip"], parentRow["Zip"], extractPostalCode(addressSource)]),
            country: getFirstStringValue([row["Contact/Country"], row["Country"], parentRow["Country"]]),
            city: getFirstStringValue([row["Contact/City"], row["City"], parentRow["City"]]),
            company: getFirstStringValue([row["Company"], row["Parent name"], parentRow["Company"], parentName]),
            parentName: parentName,
            tags: tags
        };
    }

    function getCustomerSourceKey(source) {
        var email = getStringValue(source.email).toLowerCase();
        var phone = normalizePhone(source.dedupePhone || source.phone);
        var name = getStringValue((source.nameParts.firstName + " " + source.nameParts.lastName).replace(/\s+/g, " "));
        var company = getStringValue(source.company || source.parentName).toLowerCase();

        if (email && isLikelyEmail(email)) {
            return "email:" + email;
        }

        if (phone) {
            return "phone:" + phone;
        }

        if (name) {
            return "name:" + name.toLowerCase() + "|company:" + company;
        }

        return "";
    }

    function mergeCustomerSource(target, source) {
        var sourcePhoneMatchesParent = target.recordType === "contact" &&
            normalizePhone(source.phone) &&
            normalizePhone(source.phone) === normalizePhone(target.parentPhone);

        appendUniqueValues(target.tags, source.tags || []);

        if (!target.email && source.email) {
            target.email = source.email;
        }
        if (!target.phone && source.phone && !sourcePhoneMatchesParent) {
            target.phone = source.phone;
        }
        if (!target.dedupePhone && source.dedupePhone && !sourcePhoneMatchesParent) {
            target.dedupePhone = source.dedupePhone;
        }
        if (!target.addressSource && source.addressSource) {
            target.addressSource = source.addressSource;
        }
        if (!target.zip && source.zip) {
            target.zip = source.zip;
        }
        if (!target.country && source.country) {
            target.country = source.country;
        }
        if (!target.city && source.city) {
            target.city = source.city;
        }
        if (!target.company && source.company) {
            target.company = source.company;
        }
    }

    function dedupeCustomerSources(sources) {
        var seen = {};
        var output = [];

        sources.forEach(function (source) {
            var key = getCustomerSourceKey(source);

            if (key && seen[key]) {
                mergeCustomerSource(seen[key], source);
                return;
            }

            output.push(source);
            if (key) {
                seen[key] = source;
            }
        });

        return output;
    }

    function buildCustomerSources(odooRows) {
        var sources = [];

        odooRows.forEach(function (row) {
            var contactSource;

            if (hasMainCustomerDetails(row)) {
                sources.push(buildMainCustomerSource(row));
            }

            if (hasNestedContactDetails(row)) {
                contactSource = buildContactCustomerSource(row);
                if (contactSource) {
                    sources.push(contactSource);
                }
            }
        });

        return dedupeCustomerSources(sources);
    }

    function buildCustomerRecord(templateHeaders, source) {
        var row = source.row;
        var record = createEmptyRecord(templateHeaders);
        var nameParts = source.nameParts || splitDisplayName(source.displayName);
        var address = parseCustomerAddress(source.addressSource, source.zip, source.country, source.city, source.addressNameToRemove || source.company);
        var phone = normalizePhone(source.phone);
        var email = isLikelyEmail(source.email) ? getStringValue(source.email) : "";
        var company = getStringValue(source.company);
        var note = buildCustomerNote(row, source);
        var tags = Array.isArray(source.tags) ? source.tags.join(", ") : "";

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
            record["Default Address Country Code"] = normalizeCountryCode(source.country);
        }
        if (record.hasOwnProperty("Default Address Zip")) {
            record["Default Address Zip"] = address.zip;
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
            record["Tags"] = tags;
        }
        if (record.hasOwnProperty("Note")) {
            record["Note"] = note;
        }
        if (record.hasOwnProperty("Tax Exempt")) {
            record["Tax Exempt"] = "no";
        }

        return record;
    }

    function buildCustomerData(templateHeaders, odooRows) {
        var customerSources = buildCustomerSources(odooRows);

        return {
            customerSources: customerSources,
            customerRows: customerSources.map(function (source) {
                return buildCustomerRecord(templateHeaders, source);
            })
        };
    }

    function buildCustomerRows(templateHeaders, odooRows) {
        return buildCustomerData(templateHeaders, odooRows).customerRows;
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
        var normalizedCustomerData = normalizeCustomerRows(odooDocument.rows);

        if (!templateDocument.headers.some(function (header) {
            return !!getStringValue(header);
        })) {
            templateDocument = {
                headers: DEFAULT_CUSTOMER_HEADERS.slice(),
                rows: []
            };
        }

        if (!odooDocument.rows.length) {
            throw new Error("The Odoo customer CSV does not contain any data rows.");
        }

        var customerData = buildCustomerData(templateDocument.headers, normalizedCustomerData.rows);
        var customerRows = customerData.customerRows;
        var customerSources = customerData.customerSources;
        var customerFileName = settings.customerFileName || "customers.shopify.csv";
        var mappingFileName = settings.mappingFileName || "customers.mapping.csv";
        var customersWithTags = customerRows.filter(function (row) {
            return !!getStringValue(row["Tags"]);
        }).length;

        return {
            templateHeaders: templateDocument.headers.slice(),
            odooRows: normalizedCustomerData.rows,
            customerSources: customerSources,
            customerRows: customerRows,
            mappingRows: CUSTOMER_MAPPING_ROWS.slice(),
            customerCsvText: toCsv(customerRows, templateDocument.headers),
            mappingCsvText: toCsv(CUSTOMER_MAPPING_ROWS, CUSTOMER_MAPPING_HEADERS),
            customerFileName: customerFileName,
            mappingFileName: mappingFileName,
            stats: {
                templateColumns: templateDocument.headers.length,
                odooColumns: odooDocument.headers.length,
                sourceRowsRead: odooDocument.rows.length,
                sourceCustomerRowsParsed: normalizedCustomerData.rows.length,
                customersParsed: customerRows.length,
                contactRecordsCreated: customerSources.filter(function (source) {
                    return source.recordType === "contact";
                }).length,
                customersWithEmail: customerRows.filter(function (row) {
                    return !!getStringValue(row["Email"]);
                }).length,
                customersWithPhone: customerRows.filter(function (row) {
                    return !!normalizePhone(row["Phone"]);
                }).length,
                customersWithTags: customersWithTags,
                mergedTagOnlyRows: normalizedCustomerData.mergedTagOnlyRows,
                ignoredTagOnlyRows: normalizedCustomerData.ignoredTagOnlyRows
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
