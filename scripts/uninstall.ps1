$ErrorActionPreference = "Stop"
$installDir = if ($env:RELAY_INSTALL_DIR) { $env:RELAY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Relay\bin" }
$target = Join-Path $installDir "relay.exe"
if (Test-Path $target) {
  Remove-Item -Force $target
  Write-Host "Removed Relay from $target"
} else {
  Write-Host "Relay is not installed at $target"
}
