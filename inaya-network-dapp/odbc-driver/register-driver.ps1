#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers inayaodbc.dll with the Windows ODBC Driver Manager and
  creates a System DSN for it.

.WHY THIS SCRIPT EXISTS
  Windows ODBC driver registration writes to
  HKLM:\SOFTWARE\ODBC\ODBCINST.INI, which requires local administrator
  rights. The environment this driver was built and tested in did not
  have admin rights (confirmed: a direct write to that key returned
  Access Denied), so this step could not be completed or verified there.
  The driver DLL itself was tested for real by loading it directly with
  LoadLibrary and calling its exported SQL* functions, bypassing the
  Driver Manager -- see test/direct_test.c and ../docs/mainframe-legacy-
  data-access-report.md for exactly what was and wasn't verified.

  Run this script (as Administrator) on a machine where you want real
  Driver-Manager-mediated access -- e.g. from Excel, Power BI, or
  PowerShell's System.Data.Odbc -- and it will do the same registration
  SQLInstallDriverEx/SQLConfigDataSource would, directly against the
  registry, then verify the registration by opening a real connection.

.PARAMETER Host
  Base URL of the Inaya API, e.g. http://localhost:3000 or
  https://app.inaya.network

.PARAMETER DataSourceId
  The legacy data source's id (from the Business Workspace's Data
  Sources tab, or the /api/orgs/data-sources list).

.PARAMETER ApiKey
  An Inaya API key with access to that org (Settings -> API Keys).

.PARAMETER DsnName
  The ODBC DSN name to create. Defaults to "Inaya SQL".
#>
param(
    [string]$Host = "http://localhost:3000",
    [Parameter(Mandatory=$true)][string]$DataSourceId,
    [Parameter(Mandatory=$true)][string]$ApiKey,
    [string]$DsnName = "Inaya SQL"
)

$ErrorActionPreference = "Stop"
$driverName = "Inaya SQL Driver"
$dllPath = Join-Path $PSScriptRoot "inayaodbc.dll"

if (-not (Test-Path $dllPath)) {
    throw "inayaodbc.dll not found at $dllPath -- run build.sh first."
}
$dllPath = (Resolve-Path $dllPath).Path

Write-Host "Registering driver '$driverName' -> $dllPath"
$driverKey = "HKLM:\SOFTWARE\ODBC\ODBCINST.INI\$driverName"
New-Item -Path $driverKey -Force | Out-Null
Set-ItemProperty -Path $driverKey -Name "Driver" -Value $dllPath
Set-ItemProperty -Path $driverKey -Name "Setup" -Value $dllPath
Set-ItemProperty -Path $driverKey -Name "APILevel" -Value "1"
Set-ItemProperty -Path $driverKey -Name "ConnectFunctions" -Value "YYN"
Set-ItemProperty -Path $driverKey -Name "DriverODBCVer" -Value "03.80"
Set-ItemProperty -Path $driverKey -Name "FileUsage" -Value "0"

$driversListKey = "HKLM:\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers"
New-Item -Path $driversListKey -Force | Out-Null
Set-ItemProperty -Path $driversListKey -Name $driverName -Value "Installed"

Write-Host "Creating System DSN '$DsnName'"
$dsnKey = "HKLM:\SOFTWARE\ODBC\ODBC.INI\$DsnName"
New-Item -Path $dsnKey -Force | Out-Null
Set-ItemProperty -Path $dsnKey -Name "Driver" -Value $dllPath
Set-ItemProperty -Path $dsnKey -Name "HOST" -Value $Host
Set-ItemProperty -Path $dsnKey -Name "DATASOURCEID" -Value $DataSourceId
Set-ItemProperty -Path $dsnKey -Name "APIKEY" -Value $ApiKey

$dsnListKey = "HKLM:\SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources"
New-Item -Path $dsnListKey -Force | Out-Null
Set-ItemProperty -Path $dsnListKey -Name $DsnName -Value $driverName

Write-Host "Registered. Verifying with a real connection via System.Data.Odbc..."
Add-Type -AssemblyName System.Data
$conn = New-Object System.Data.Odbc.OdbcConnection("DSN=$DsnName")
$conn.Open()
Write-Host "Connected. Server version: $($conn.ServerVersion)"
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT 1"
try {
    $reader = $cmd.ExecuteReader()
    Write-Host "Driver-Manager-mediated query executed successfully."
    $reader.Close()
} catch {
    Write-Host "Connected, but the test query failed (this is expected if no table named exactly that exists -- try a real table from your published schema instead): $($_.Exception.Message)"
}
$conn.Close()
Write-Host "Done. Any ODBC-aware application (Excel, Power BI, PowerShell) can now use DSN=$DsnName."
