Param(
  [string]$BackendUrl = "https://movie-rec-sbf1.onrender.com",
  [string]$WsUrl = "wss://movie-rec-sbf1.onrender.com/ws",
  [string]$MlUrl = ""
)

$ErrorActionPreference = "Stop"

Write-Host "[render-tunnel] Using backend: $BackendUrl"
Write-Host "[render-tunnel] Using ws:      $WsUrl"
if ([string]::IsNullOrWhiteSpace($MlUrl)) {
  Write-Host "[render-tunnel] ML disabled for this run (MlUrl empty)"
} else {
  Write-Host "[render-tunnel] Using ml:      $MlUrl"
}

$env:EXPO_PUBLIC_BACKEND_URL = $BackendUrl
$env:EXPO_PUBLIC_CINEMA_WS_URL = $WsUrl
$env:EXPO_PUBLIC_ML_API_URL = $MlUrl
$env:NODE_ENV = "development"

npx expo start -c --tunnel --dev-client
