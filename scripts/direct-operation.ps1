param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("patch", "uninstall")]
  [string]$Operation,
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

if (-not (Test-Administrator)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`"",
    "-Operation", $Operation,
    "-Elevated"
  ) -join " "
  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -Verb RunAs `
    -Wait `
    -PassThru
  exit $process.ExitCode
}

if (-not $Elevated) {
  throw "Elevated marker is missing"
}

$package = Get-AppxPackage -Name OpenAI.Codex |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($null -eq $package) {
  throw "OpenAI.Codex AppX package was not found"
}

$installLocation = [IO.Path]::GetFullPath($package.InstallLocation)
$asarPath = [IO.Path]::GetFullPath(
  (Join-Path $installLocation "app\resources\app.asar")
)
$expectedPrefix = $installLocation.TrimEnd("\") + "\"
if (-not $asarPath.StartsWith(
  $expectedPrefix,
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "Resolved app.asar is outside the current AppX package"
}
if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
  throw "Current AppX app.asar was not found"
}

$node = (Get-Command node -ErrorAction Stop).Source
$localPatchRoot = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "isCodexRunOut")
)
$running = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
  Where-Object {
    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) {
      return $false
    }
    $executable = [IO.Path]::GetFullPath($_.ExecutablePath)
    return (
      $executable.StartsWith(
        $expectedPrefix,
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      $executable.StartsWith(
        ($localPatchRoot.TrimEnd("\") + "\"),
        [StringComparison]::OrdinalIgnoreCase
      )
    )
  }

if ($running) {
  $running | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 800
}

$ownershipChanged = $false
try {
  & takeown.exe /F $asarPath /A | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "takeown failed with exit code $LASTEXITCODE"
  }
  $ownershipChanged = $true
  & icacls.exe $asarPath /grant "*S-1-5-32-544:F" | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "icacls grant failed with exit code $LASTEXITCODE"
  }
  $command = if ($Operation -eq "patch") {
    "direct-install"
  } else {
    "direct-uninstall"
  }
  Push-Location $repoRoot
  try {
    & $node (Join-Path $repoRoot "scripts\cli.mjs") $command
    if ($LASTEXITCODE -ne 0) {
      throw "Direct $Operation failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($ownershipChanged) {
    & icacls.exe $asarPath /reset | Out-Host
    $resetExitCode = $LASTEXITCODE
    & icacls.exe $asarPath /setowner "NT SERVICE\TrustedInstaller" | Out-Host
    $ownerExitCode = $LASTEXITCODE
    if ($resetExitCode -ne 0 -or $ownerExitCode -ne 0) {
      throw "Failed to restore AppX ACL/owner"
    }
  }
}

$applicationId = "$($package.PackageFamilyName)!App"
Start-Process -FilePath "explorer.exe" -ArgumentList "shell:AppsFolder\$applicationId"
Write-Host "Operation completed: $Operation"
