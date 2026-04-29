param(
    [string]$InputPath = "odoo_order.csv",
    [string]$OutputPath = "",
    [string]$MappingPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-StringValue {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return ""
    }

    return ([string]$Value).Trim()
}

function Parse-DecimalOrNull {
    param(
        [string]$Value
    )

    $trimmed = Get-StringValue $Value
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $null
    }

    $parsed = 0.0
    if ([double]::TryParse($trimmed, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return [decimal]$parsed
    }

    return $null
}

function Parse-IntOrNull {
    param(
        [string]$Value
    )

    $trimmed = Get-StringValue $Value
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $null
    }

    $parsed = 0
    if ([int]::TryParse($trimmed, [ref]$parsed)) {
        return $parsed
    }

    return $null
}

function Normalize-Phone {
    param(
        [string]$Phone
    )

    $digits = [regex]::Replace((Get-StringValue $Phone), "\D", "")
    if ([string]::IsNullOrWhiteSpace($digits)) {
        return ""
    }

    if ($digits.Length -eq 8) {
        return "+65$digits"
    }

    if ($digits.Length -eq 10 -and $digits.StartsWith("65")) {
        return "+$digits"
    }

    if ($digits.StartsWith("65") -and $digits.Length -gt 10) {
        return "+$digits"
    }

    return ""
}

function Escape-MatrixifyValuePart {
    param(
        [string]$Value
    )

    $text = Get-StringValue $Value
    $text = $text.Replace("\", "\\")
    $text = $text.Replace(":", "\:")
    return $text
}

function Format-MatrixifyKeyValueLine {
    param(
        [string]$Key,
        [string]$Value
    )

    return ("{0}: {1}" -f (Get-StringValue $Key), (Escape-MatrixifyValuePart $Value))
}

function Split-OrderLine {
    param(
        [string]$OrderReference,
        [string]$RawLine
    )

    $cleanLine = Get-StringValue $RawLine
    if ([string]::IsNullOrWhiteSpace($cleanLine)) {
        return @{
            RawLine = ""
            SKU = ""
            Title = ""
        }
    }

    $escapedOrderReference = [regex]::Escape($OrderReference)
    $pattern = "^$escapedOrderReference\s*-\s*(?<sku>\S+)\s*(?<title>.*)$"
    $match = [regex]::Match($cleanLine, $pattern)

    if ($match.Success) {
        $sku = Get-StringValue $match.Groups["sku"].Value
        $title = Get-StringValue $match.Groups["title"].Value
        if ([string]::IsNullOrWhiteSpace($title)) {
            $title = $sku
            $sku = ""
        }

        return @{
            RawLine = $cleanLine
            SKU = $sku
            Title = $title
        }
    }

    return @{
        RawLine = $cleanLine
        SKU = ""
        Title = $cleanLine
    }
}

function Get-AdditionalDetails {
    param(
        [object]$Order,
        [int]$ActualLineCount,
        [int]$TargetLineCount
    )

    $details = New-Object System.Collections.Generic.List[string]
    $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Order Reference" -Value $Order.OrderReference))

    if ($Order.TotalRaw) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Total" -Value "$($Order.TotalRaw) $($Order.Currency)"))
    } else {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Total" -Value "Missing in source export"))
    }

    if ($Order.Customer) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Customer" -Value $Order.Customer))
    }

    if ($Order.DeliveryAddress) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Delivery Address" -Value $Order.DeliveryAddress))
    }

    if ($Order.MobileRaw) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Mobile" -Value $Order.MobileRaw))
    }

    if ($Order.ShippingPolicy) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Shipping Policy" -Value $Order.ShippingPolicy))
    }

    if ($Order.OrderStatus) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Order Status" -Value $Order.OrderStatus))
    }

    if ($Order.ShippingStatus) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Shipping Status" -Value $Order.ShippingStatus))
    }

    if ($Order.OrderDate) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Order Date" -Value $Order.OrderDate))
    }

    $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Parsed Order Lines" -Value $ActualLineCount))
    $details.Add((Format-MatrixifyKeyValueLine -Key "Odoo Cart Quantity" -Value $Order.CartQuantityRaw))

    if ($TargetLineCount -gt $ActualLineCount) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Quantity Assumption" -Value "Source cart quantity exceeded parsed order lines by $($TargetLineCount - $ActualLineCount); extra quantity assigned to the first line item."))
    }

    if ($TargetLineCount -lt $ActualLineCount) {
        $details.Add((Format-MatrixifyKeyValueLine -Key "Quantity Warning" -Value "Parsed order lines exceeded source cart quantity by $($ActualLineCount - $TargetLineCount); all parsed lines were kept."))
    }

    return ($details -join "`n")
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Input file not found: $InputPath"
}

$resolvedInputPath = (Resolve-Path -LiteralPath $InputPath).Path
$inputDirectory = Split-Path -Path $resolvedInputPath -Parent
$inputBaseName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedInputPath)

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path -Path $inputDirectory -ChildPath "$inputBaseName.matrixify.orders.csv"
}

if ([string]::IsNullOrWhiteSpace($MappingPath)) {
    $MappingPath = Join-Path -Path $inputDirectory -ChildPath "$inputBaseName.matrixify.mapping.csv"
}

$sourceRows = Import-Csv -Path $InputPath
$headers = $sourceRows[0].PSObject.Properties.Name

$orders = New-Object System.Collections.Generic.List[object]
$currentOrder = $null

foreach ($row in $sourceRows) {
    $orderReference = Get-StringValue $row."Order Reference"
    $orderLine = Get-StringValue $row."Order Lines"

    if (-not [string]::IsNullOrWhiteSpace($orderReference)) {
        if ($null -ne $currentOrder) {
            $orders.Add([pscustomobject]$currentOrder)
        }

        $currentOrder = @{
            OrderReference = $orderReference
            Customer = Get-StringValue $row.Customer
            TotalRaw = Get-StringValue $row.Total
            Total = Parse-DecimalOrNull $row.Total
            Currency = Get-StringValue $row.Currency
            DeliveryAddress = Get-StringValue $row."Delivery Address"
            CartQuantityRaw = Get-StringValue $row."Cart Quantity"
            CartQuantity = Parse-IntOrNull $row."Cart Quantity"
            MobileRaw = Get-StringValue $row.Mobile
            NormalizedPhone = Normalize-Phone $row.Mobile
            OrderStatus = Get-StringValue $row."Order Status"
            PaymentStatus = Get-StringValue $row."Payment Status"
            OrderId = Get-StringValue $row."Order ID"
            OrderDate = Get-StringValue $row."Order Date"
            ShippingAddress = Get-StringValue $row."Shipping Address"
            ShippingAmount = Get-StringValue $row."Shipping Amount"
            ShippingPhone = Get-StringValue $row."Shipping Phone"
            ShippingPolicy = Get-StringValue $row."Shipping Policy"
            ShippingStatus = Get-StringValue $row."Shipping Status"
            DeliveryDate = Get-StringValue $row."Delivery Date"
            Transactions = Get-StringValue $row.Transactions
            SourceHeaderRow = $row
            LineItems = New-Object System.Collections.Generic.List[object]
        }
    }

    if ($null -ne $currentOrder -and -not [string]::IsNullOrWhiteSpace($orderLine)) {
        $parsedLine = Split-OrderLine -OrderReference $currentOrder.OrderReference -RawLine $orderLine
        $currentOrder.LineItems.Add([pscustomobject]@{
            SourceOrderLine = $parsedLine.RawLine
            OdooSKU = $parsedLine.SKU
            Title = $parsedLine.Title
            AssumedExtraQuantity = $false
        })
    }
}

if ($null -ne $currentOrder) {
    $orders.Add([pscustomobject]$currentOrder)
}

$matrixifyRows = New-Object System.Collections.Generic.List[object]

foreach ($order in $orders) {
    $actualLineCount = $order.LineItems.Count
    $targetLineCount = if ($null -ne $order.CartQuantity -and $order.CartQuantity -gt 0) { $order.CartQuantity } else { $actualLineCount }

    $expandedLines = New-Object System.Collections.Generic.List[object]
    foreach ($line in $order.LineItems) {
        $expandedLines.Add([pscustomobject]@{
            SourceOrderLine = $line.SourceOrderLine
            OdooSKU = $line.OdooSKU
            Title = $line.Title
            AssumedExtraQuantity = $false
        })
    }

    if ($expandedLines.Count -gt 0 -and $targetLineCount -gt $expandedLines.Count) {
        $firstLine = $expandedLines[0]
        for ($index = $expandedLines.Count; $index -lt $targetLineCount; $index++) {
            $expandedLines.Add([pscustomobject]@{
                SourceOrderLine = $firstLine.SourceOrderLine
                OdooSKU = $firstLine.OdooSKU
                Title = $firstLine.Title
                AssumedExtraQuantity = $true
            })
        }
    }

    if ($expandedLines.Count -eq 0) {
        $expandedLines.Add([pscustomobject]@{
            SourceOrderLine = ""
            OdooSKU = ""
            Title = "Imported Odoo Order"
            AssumedExtraQuantity = $false
        })
        $targetLineCount = 1
    }

    $unitPrices = @()
    if ($null -ne $order.Total) {
        $totalCents = [int][decimal]::Round($order.Total * 100, 0, [System.MidpointRounding]::AwayFromZero)
        $baseCents = [math]::Floor($totalCents / $expandedLines.Count)
        $remainder = $totalCents % $expandedLines.Count

        for ($index = 0; $index -lt $expandedLines.Count; $index++) {
            $lineCents = $baseCents
            if ($index -lt $remainder) {
                $lineCents++
            }

            $unitPrices += ([decimal]$lineCents / 100)
        }
    } else {
        for ($index = 0; $index -lt $expandedLines.Count; $index++) {
            $unitPrices += [decimal]0
        }
    }

    $additionalDetails = Get-AdditionalDetails -Order $order -ActualLineCount $actualLineCount -TargetLineCount $targetLineCount
    $lineDistributionNote = if ($targetLineCount -gt $actualLineCount) { "Assumed extra quantity on duplicated first line item" } else { "" }
    $orderNote = "Imported from Odoo CSV for Matrixify. Historical line prices were distributed from the order total because the source file had no line-level prices."

    for ($index = 0; $index -lt $expandedLines.Count; $index++) {
        $line = $expandedLines[$index]
        $lineProperties = New-Object System.Collections.Generic.List[string]

        if ($line.OdooSKU) {
            $lineProperties.Add((Format-MatrixifyKeyValueLine -Key "Odoo SKU" -Value $line.OdooSKU))
        }

        if ($line.SourceOrderLine) {
            $lineProperties.Add((Format-MatrixifyKeyValueLine -Key "Odoo Source Line" -Value $line.SourceOrderLine))
        }

        if ($line.AssumedExtraQuantity) {
            $lineProperties.Add((Format-MatrixifyKeyValueLine -Key "Quantity Assumption" -Value "Added duplicate row to match Odoo cart quantity."))
        }

        $linePropertiesText = $lineProperties -join "`n"
        $linePriceText = ([decimal]$unitPrices[$index]).ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture)

        $matrixifyRows.Add([pscustomobject]@{
            Name = $order.OrderReference
            Command = "NEW"
            "Send Receipt" = "FALSE"
            "Inventory Behaviour" = "bypass"
            "Processed At" = $order.OrderDate
            Currency = if ($order.Currency) { $order.Currency } else { "SGD" }
            Source = "odoo_migration"
            "Source Identifier" = $order.OrderReference
            "Payment: Status" = if ($order.PaymentStatus) { $order.PaymentStatus } else { "paid" }
            Phone = $order.NormalizedPhone
            Note = $orderNote
            "Additional Details" = $additionalDetails
            "Line: Type" = "Line Item"
            "Line: Quantity" = "1"
            "Line: Title" = $line.Title
            "Line: Price" = $linePriceText
            "Line: Properties" = $linePropertiesText
            "Odoo Order Reference" = $order.OrderReference
            "Odoo Customer" = $order.Customer
            "Odoo Total" = $order.TotalRaw
            "Odoo Currency" = $order.Currency
            "Odoo Delivery Address" = $order.DeliveryAddress
            "Odoo Cart Quantity" = $order.CartQuantityRaw
            "Odoo Mobile" = $order.MobileRaw
            "Odoo Order Status" = $order.OrderStatus
            "Odoo Payment Status" = $order.PaymentStatus
            "Odoo Order ID" = $order.OrderId
            "Odoo Order Lines" = $line.SourceOrderLine
            "Odoo Order Lines displayed on Website" = Get-StringValue $order.SourceHeaderRow."Order Lines displayed on Website"
            "Odoo Order Date" = $order.OrderDate
            "Odoo Shipping Address" = $order.ShippingAddress
            "Odoo Shipping Amount" = $order.ShippingAmount
            "Odoo Shipping Phone" = $order.ShippingPhone
            "Odoo Shipping Policy" = $order.ShippingPolicy
            "Odoo Shipping Status" = $order.ShippingStatus
            "Odoo Delivery Date" = $order.DeliveryDate
            "Odoo Transactions" = $order.Transactions
            "Derived Line Price Allocation" = "Distributed from order total across $($expandedLines.Count) unit rows"
            "Derived Quantity Note" = if ($line.AssumedExtraQuantity) { $lineDistributionNote } else { "" }
            "Derived Phone Note" = if ($order.MobileRaw -and -not $order.NormalizedPhone) { "Source phone could not be normalized safely" } else { "" }
        })
    }
}

$mappingRows = @(
    [pscustomobject]@{ "Source Column" = "Order Reference"; "Matrixify Column / Handling" = "Name, Source Identifier, Odoo Order Reference"; "Action" = "Renamed + Copied"; "Notes" = "Used as the Shopify order key and preserved in audit columns." }
    [pscustomobject]@{ "Source Column" = "Customer"; "Matrixify Column / Handling" = "Additional Details, Odoo Customer"; "Action" = "Copied to audit/detail"; "Notes" = "Not forced into Shopify Customer fields because source lacks a reliable customer identifier." }
    [pscustomobject]@{ "Source Column" = "Total"; "Matrixify Column / Handling" = "Line: Price (distributed), Odoo Total"; "Action" = "Derived"; "Notes" = "Source has no line prices, so order total was split across unit rows to preserve the order total exactly." }
    [pscustomobject]@{ "Source Column" = "Currency"; "Matrixify Column / Handling" = "Currency, Odoo Currency"; "Action" = "Renamed + Copied"; "Notes" = "Kept as the Shopify order currency." }
    [pscustomobject]@{ "Source Column" = "Delivery Address"; "Matrixify Column / Handling" = "Additional Details, Odoo Delivery Address"; "Action" = "Copied to audit/detail"; "Notes" = "Not mapped to Shopify address fields because the export contains names, not structured addresses." }
    [pscustomobject]@{ "Source Column" = "Cart Quantity"; "Matrixify Column / Handling" = "Line: Quantity (expanded into unit rows), Odoo Cart Quantity"; "Action" = "Derived"; "Notes" = "Used to expand rows so the Shopify file matches the source quantity count." }
    [pscustomobject]@{ "Source Column" = "Mobile"; "Matrixify Column / Handling" = "Phone, Additional Details, Odoo Mobile"; "Action" = "Derived + Copied"; "Notes" = "Normalized to +65 where possible; original value preserved." }
    [pscustomobject]@{ "Source Column" = "Order Status"; "Matrixify Column / Handling" = "Additional Details, Odoo Order Status"; "Action" = "Copied to audit/detail"; "Notes" = "Not mapped to fulfillment because Matrixify requires fulfillment lines for shipped/delivered status." }
    [pscustomobject]@{ "Source Column" = "Payment Status"; "Matrixify Column / Handling" = "Payment: Status, Odoo Payment Status"; "Action" = "Fallback"; "Notes" = "Source values were blank, so generated file uses Matrixify's default paid state for new orders." }
    [pscustomobject]@{ "Source Column" = "Order ID"; "Matrixify Column / Handling" = "Odoo Order ID"; "Action" = "Not imported"; "Notes" = "Source column is blank for all rows." }
    [pscustomobject]@{ "Source Column" = "Order Lines"; "Matrixify Column / Handling" = "Line: Title, Line: Properties, Odoo Order Lines"; "Action" = "Parsed + Copied"; "Notes" = "Parsed into SKU and title; SKU stored in line properties to keep custom line item import safe." }
    [pscustomobject]@{ "Source Column" = "Order Lines displayed on Website"; "Matrixify Column / Handling" = "Odoo Order Lines displayed on Website"; "Action" = "Not imported"; "Notes" = "Kept only as an audit column because it duplicates order lines and is not needed by Matrixify." }
    [pscustomobject]@{ "Source Column" = "Order Date"; "Matrixify Column / Handling" = "Processed At, Odoo Order Date"; "Action" = "Renamed + Copied"; "Notes" = "Used as the Shopify processed date." }
    [pscustomobject]@{ "Source Column" = "Shipping Address"; "Matrixify Column / Handling" = "Odoo Shipping Address"; "Action" = "Not imported"; "Notes" = "Source column is blank for all rows." }
    [pscustomobject]@{ "Source Column" = "Shipping Amount"; "Matrixify Column / Handling" = "Odoo Shipping Amount"; "Action" = "Not imported"; "Notes" = "Source column is blank for all rows, so no Shopify Shipping Line was created." }
    [pscustomobject]@{ "Source Column" = "Shipping Phone"; "Matrixify Column / Handling" = "Odoo Shipping Phone"; "Action" = "Not imported"; "Notes" = "Source column is blank for all rows." }
    [pscustomobject]@{ "Source Column" = "Shipping Policy"; "Matrixify Column / Handling" = "Additional Details, Odoo Shipping Policy"; "Action" = "Copied to audit/detail"; "Notes" = "Preserved as metadata because it has no direct Shopify order field." }
    [pscustomobject]@{ "Source Column" = "Shipping Status"; "Matrixify Column / Handling" = "Additional Details, Odoo Shipping Status"; "Action" = "Copied to audit/detail"; "Notes" = "Not mapped to Shopify fulfillment status because fulfillment lines are required." }
    [pscustomobject]@{ "Source Column" = "Delivery Date"; "Matrixify Column / Handling" = "Odoo Delivery Date"; "Action" = "Not imported"; "Notes" = "Source column is blank for all rows." }
    [pscustomobject]@{ "Source Column" = "Transactions"; "Matrixify Column / Handling" = "Odoo Transactions"; "Action" = "Not imported"; "Notes" = "Source column is blank for all rows, so no transaction rows were created." }
)

$matrixifyRows | Export-Csv -Path $OutputPath -NoTypeInformation -Encoding UTF8
$mappingRows | Export-Csv -Path $MappingPath -NoTypeInformation -Encoding UTF8

$orderCount = $orders.Count
$outputRowCount = $matrixifyRows.Count
$missingTotalCount = @($orders | Where-Object { $null -eq $_.Total }).Count
$normalizedPhoneCount = @($orders | Where-Object { $_.NormalizedPhone }).Count
$quantityAdjustedOrderCount = @($orders | Where-Object {
    $actualCount = $_.LineItems.Count
    $targetCount = if ($null -ne $_.CartQuantity -and $_.CartQuantity -gt 0) { $_.CartQuantity } else { $actualCount }
    $targetCount -gt $actualCount
}).Count

Write-Output "Orders parsed: $orderCount"
Write-Output "Matrixify rows written: $outputRowCount"
Write-Output "Orders with missing total: $missingTotalCount"
Write-Output "Orders with normalized phone: $normalizedPhoneCount"
Write-Output "Orders with quantity assumptions: $quantityAdjustedOrderCount"
Write-Output "Output CSV: $OutputPath"
Write-Output "Mapping CSV: $MappingPath"
