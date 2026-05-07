Add-Type -AssemblyName System.Windows.Forms

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hostAddress = "127.0.0.1"
$port = 3456
$appUrl = "http://${hostAddress}:${port}"
$serverScriptPath = Join-Path -Path $PSScriptRoot -ChildPath "shopify_sync_server.js"

function Show-LauncherMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [System.Windows.Forms.MessageBoxIcon]$Icon
    )

    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        "Odoo to Shopify Order Sync",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $Icon
    ) | Out-Null
}

function Test-AppUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

function Read-LogContent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    return (Get-Content -LiteralPath $Path -Raw).Trim()
}

if (-not (Test-Path -LiteralPath $serverScriptPath)) {
    Show-LauncherMessage -Message "Could not find shopify_sync_server.js in:`n$PSScriptRoot" -Icon Error
    exit 1
}

if (Test-AppUrl -Url $appUrl) {
    Start-Process $appUrl | Out-Null
    exit 0
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Show-LauncherMessage -Message "Node.js was not found in PATH.`n`nInstall Node.js, then run Open_Odoo_CSV_Converter.bat again." -Icon Error
    exit 1
}

$stdoutPath = Join-Path -Path $env:TEMP -ChildPath ("odoo-shopify-sync-" + [guid]::NewGuid().ToString("N") + ".stdout.log")
$stderrPath = Join-Path -Path $env:TEMP -ChildPath ("odoo-shopify-sync-" + [guid]::NewGuid().ToString("N") + ".stderr.log")
$nodeProcess = $null

try {
    $nodeProcess = Start-Process `
        -FilePath $nodeCommand.Source `
        -ArgumentList @($serverScriptPath) `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath

    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
        if (Test-AppUrl -Url $appUrl) {
            Start-Process $appUrl | Out-Null
            exit 0
        }

        $nodeProcess.Refresh()
        if ($nodeProcess.HasExited) {
            break
        }

        Start-Sleep -Milliseconds 300
    }

    $stdout = Read-LogContent -Path $stdoutPath
    $stderr = Read-LogContent -Path $stderrPath
    $details = New-Object System.Collections.Generic.List[string]

    $details.Add("The local web server did not start successfully.")
    $details.Add("")
    $details.Add("Expected URL:")
    $details.Add($appUrl)
    $details.Add("")
    $details.Add("Things to check:")
    $details.Add("1. Node.js is installed and available in PATH.")
    $details.Add("2. No security software is blocking local Node processes.")
    $details.Add("3. Port 3456 is free or already serving this app.")

    if ($stderr) {
        $details.Add("")
        $details.Add("Error details:")
        $details.Add($stderr)
    }
    elseif ($stdout) {
        $details.Add("")
        $details.Add("Server output:")
        $details.Add($stdout)
    }

    Show-LauncherMessage -Message ($details -join "`n") -Icon Error
    exit 1
}
finally {
    if ($nodeProcess -and -not $nodeProcess.HasExited -and -not (Test-AppUrl -Url $appUrl)) {
        Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
