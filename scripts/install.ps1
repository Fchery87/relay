$ErrorActionPreference = "Stop"
$baseUrl = if ($env:RELAY_RELEASE_BASE_URL) { $env:RELAY_RELEASE_BASE_URL } else { "https://github.com/Fchery87/relay/releases/latest/download" }
$installDir = if ($env:RELAY_INSTALL_DIR) { $env:RELAY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Relay\bin" }
$asset = "relay-windows-x64.exe"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  Invoke-WebRequest "$baseUrl/$asset" -OutFile (Join-Path $temporary $asset)
  Invoke-WebRequest "$baseUrl/checksums.txt" -OutFile (Join-Path $temporary "checksums.txt")
  Invoke-WebRequest "$baseUrl/checksums.txt.sig" -OutFile (Join-Path $temporary "checksums.txt.sig")
  Invoke-WebRequest "$baseUrl/release-public-key.pem" -OutFile (Join-Path $temporary "release-public-key.pem")
  $openssl = Get-Command openssl -ErrorAction SilentlyContinue
  if (-not $openssl) { throw "OpenSSL is required to verify the signed release" }
  & $openssl.Source dgst -sha256 -verify (Join-Path $temporary "release-public-key.pem") -signature (Join-Path $temporary "checksums.txt.sig") (Join-Path $temporary "checksums.txt") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Release signature verification failed" }
  $expected = ((Get-Content (Join-Path $temporary "checksums.txt") | Where-Object { $_ -match "  $([regex]::Escape($asset))$" }) -split "  ")[0]
  if (-not $expected) { throw "Missing checksum for $asset" }
  $actual = (Get-FileHash (Join-Path $temporary $asset) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) { throw "Checksum verification failed" }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item (Join-Path $temporary $asset) (Join-Path $installDir "relay.exe") -Force
  Write-Host "Installed Relay to $installDir\\relay.exe"
  Write-Host "Run: $installDir\\relay.exe connect --url <your-convex-url>"
} finally { Remove-Item -Recurse -Force $temporary }
