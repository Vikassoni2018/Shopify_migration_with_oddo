param()

$projectRoot = $PSScriptRoot
$envPath = Join-Path -Path $projectRoot -ChildPath ".env"
$settings = @{}

if (Test-Path -LiteralPath $envPath) {
    Get-Content -LiteralPath $envPath | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) {
            return
        }

        $separatorIndex = $line.IndexOf("=")
        if ($separatorIndex -lt 1) {
            return
        }

        $key = $line.Substring(0, $separatorIndex).Trim()
        $value = $line.Substring($separatorIndex + 1).Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $settings[$key] = $value
    }
}

$port = if ($settings.ContainsKey("PORT") -and $settings["PORT"]) { $settings["PORT"] } else { "3456" }
$localBaseUrl = if ($settings.ContainsKey("LOCAL_API_BASE_URL") -and $settings["LOCAL_API_BASE_URL"]) {
    $settings["LOCAL_API_BASE_URL"]
} elseif ($settings.ContainsKey("APP_BASE_URL") -and $settings["APP_BASE_URL"] -match "^https?://(127\.0\.0\.1|localhost)") {
    $settings["APP_BASE_URL"]
} else {
    "http://127.0.0.1:$port"
}

Start-Process node -ArgumentList "shopify_sync_server.js" -WorkingDirectory $projectRoot -WindowStyle Hidden
Start-Sleep -Seconds 2
Start-Process $localBaseUrl
