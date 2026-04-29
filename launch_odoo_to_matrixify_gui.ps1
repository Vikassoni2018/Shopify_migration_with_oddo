Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# http://127.0.0.1:3456/

$scriptPath = Join-Path -Path $PSScriptRoot -ChildPath "transform_odoo_to_matrixify.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Could not find transform_odoo_to_matrixify.ps1 in:`n$PSScriptRoot",
        "Odoo to Matrixify",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

$openDialog = New-Object System.Windows.Forms.OpenFileDialog
$openDialog.Title = "Select Odoo CSV file"
$openDialog.Filter = "CSV files (*.csv)|*.csv|All files (*.*)|*.*"
$openDialog.Multiselect = $false

if ($openDialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 0
}

$inputPath = $openDialog.FileName
$inputDirectory = Split-Path -Path $inputPath -Parent
$inputBaseName = [System.IO.Path]::GetFileNameWithoutExtension($inputPath)
$outputPath = Join-Path -Path $inputDirectory -ChildPath "$inputBaseName.matrixify.orders.csv"
$mappingPath = Join-Path -Path $inputDirectory -ChildPath "$inputBaseName.matrixify.mapping.csv"

try {
    & $scriptPath -InputPath $inputPath -OutputPath $outputPath -MappingPath $mappingPath | Out-String | Set-Variable -Name conversionOutput

    $message = @(
        "Conversion completed successfully."
        ""
        "Input:"
        $inputPath
        ""
        "Orders file:"
        $outputPath
        ""
        "Mapping file:"
        $mappingPath
    ) -join "`n"

    [System.Windows.Forms.MessageBox]::Show(
        $message,
        "Odoo to Matrixify",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}
catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Conversion failed:`n$($_.Exception.Message)",
        "Odoo to Matrixify",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}
