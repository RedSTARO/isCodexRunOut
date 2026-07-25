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
  try {
    $process = Start-Process `
      -FilePath "powershell.exe" `
      -ArgumentList $arguments `
      -Verb RunAs `
      -Wait `
      -PassThru
    exit $process.ExitCode
  } catch {
    Write-Error "Failed to start the elevated process: $($_.Exception.Message)"
    exit 1
  }
}

if (-not $Elevated) {
  throw "Elevated marker is missing"
}

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$patchHome = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "isCodexRunOut")
)
$backupRoot = [IO.Path]::GetFullPath((Join-Path $patchHome "codex_backup"))
$activeRoot = [IO.Path]::GetFullPath((Join-Path $patchHome "codex"))
$activeAppRoot = Join-Path $activeRoot "app"
$activeExecutable = Join-Path $activeAppRoot "ChatGPT.exe"
$redirectStatePath = Join-Path $patchHome "redirect-state.json"
$logPath = Join-Path $patchHome "direct-operation.log"
New-Item -ItemType Directory -Path $patchHome -Force | Out-Null
Set-Content `
  -LiteralPath $logPath `
  -Value "isCodexRunOut copy-redirect operation log" `
  -Encoding UTF8

function Write-OperationLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  $timestamp = [DateTimeOffset]::Now.ToString("o")
  Add-Content `
    -LiteralPath $logPath `
    -Value "[$timestamp] $Message" `
    -Encoding UTF8
}

function Assert-ManagedPath {
  param([Parameter(Mandatory = $true)][string]$Target)

  $resolved = [IO.Path]::GetFullPath($Target)
  $prefix = $patchHome.TrimEnd("\") + "\"
  if (-not $resolved.StartsWith(
    $prefix,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Refusing to operate outside the isCodexRunOut directory: $resolved"
  }
}

function Invoke-LayoutCopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Assert-ManagedPath -Target $Destination
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Write-OperationLog "robocopy source=$Source destination=$Destination"
  & robocopy.exe `
    $Source `
    $Destination `
    /MIR `
    /COPY:DAT `
    /DCOPY:DAT `
    /R:2 `
    /W:1 `
    /XJ `
    /NFL `
    /NDL `
    /NP `
    /NJH `
    /NJS 2>&1 |
    ForEach-Object {
      if (-not [string]::IsNullOrWhiteSpace($_.ToString())) {
        Write-OperationLog "robocopy: $($_.ToString())"
      }
    }
  $exitCode = $LASTEXITCODE
  Write-OperationLog "robocopy exit code=$exitCode"
  if ($exitCode -ge 8) {
    throw "robocopy failed with exit code $exitCode"
  }
}

function Stop-CodexProcesses {
  $processes = @(
    Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'"
  )
  Write-OperationLog "stopping Codex process count=$($processes.Count)"
  $processes | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($processes.Count -gt 0) {
    Start-Sleep -Milliseconds 800
  }
}

function Read-Shortcut {
  param(
    [Parameter(Mandatory = $true)]$Shell,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $shortcut = $Shell.CreateShortcut($Path)
  return [ordered]@{
    targetPath = $shortcut.TargetPath
    arguments = $shortcut.Arguments
    workingDirectory = $shortcut.WorkingDirectory
    iconLocation = $shortcut.IconLocation
    description = $shortcut.Description
    hotkey = $shortcut.Hotkey
    windowStyle = $shortcut.WindowStyle
  }
}

function Write-Shortcut {
  param(
    [Parameter(Mandatory = $true)]$Shell,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Values
  )

  New-Item `
    -ItemType Directory `
    -Path ([IO.Path]::GetDirectoryName($Path)) `
    -Force |
    Out-Null
  $shortcut = $Shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Values.targetPath
  $shortcut.Arguments = $Values.arguments
  $shortcut.WorkingDirectory = $Values.workingDirectory
  $shortcut.IconLocation = $Values.iconLocation
  $shortcut.Description = $Values.description
  if ($null -ne $Values.hotkey) {
    $shortcut.Hotkey = $Values.hotkey
  }
  if ($null -ne $Values.windowStyle) {
    $shortcut.WindowStyle = $Values.windowStyle
  }
  $shortcut.Save()
}

function Install-Redirects {
  $shell = New-Object -ComObject WScript.Shell
  $desktop = [Environment]::GetFolderPath("Desktop")
  $programs = [Environment]::GetFolderPath("Programs")
  $desired = @(
    (Join-Path $desktop "Codex.lnk"),
    (Join-Path $programs "ChatGPT (isCodexRunOut).lnk")
  )
  $candidateRoots = @($desktop, $programs) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique
  $existing = @(
    $candidateRoots | ForEach-Object {
      Get-ChildItem `
        -LiteralPath $_ `
        -Recurse `
        -Filter "*.lnk" `
        -ErrorAction SilentlyContinue
    } | Where-Object {
      $shortcut = $shell.CreateShortcut($_.FullName)
      $_.BaseName -eq "Codex" -or
      $shortcut.TargetPath -match "OpenAI\.Codex|isCodexRunOut" -or
      $shortcut.Arguments -match "OpenAI\.Codex|isCodexRunOut"
    } | ForEach-Object { $_.FullName }
  )
  $paths = @($existing + $desired) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Sort-Object -Unique
  if (Test-Path -LiteralPath $redirectStatePath -PathType Leaf) {
    $state = Get-Content -Raw -LiteralPath $redirectStatePath |
      ConvertFrom-Json
    if ($state.schema -ne 1 -or $state.mode -ne "copy-redirect") {
      throw "redirect-state.json has an incompatible schema"
    }
    $paths = @($state.shortcuts | ForEach-Object { $_.path })
  } else {
    $shortcuts = @(
      $paths | ForEach-Object {
        $wasPresent = Test-Path -LiteralPath $_ -PathType Leaf
        [ordered]@{
          path = $_
          existed = $wasPresent
          original = if ($wasPresent) {
            Read-Shortcut -Shell $shell -Path $_
          } else {
            $null
          }
        }
      }
    )
    $environment = [ordered]@{
      IS_CODEX_RUN_OUT_ROOT = [Environment]::GetEnvironmentVariable(
        "IS_CODEX_RUN_OUT_ROOT",
        "User"
      )
      IS_CODEX_RUN_OUT_APP = [Environment]::GetEnvironmentVariable(
        "IS_CODEX_RUN_OUT_APP",
        "User"
      )
    }
    $state = [ordered]@{
      schema = 1
      mode = "copy-redirect"
      createdAt = [DateTimeOffset]::Now.ToString("o")
      shortcuts = $shortcuts
      environment = $environment
    }
    $state |
      ConvertTo-Json -Depth 8 |
      Set-Content -LiteralPath $redirectStatePath -Encoding UTF8
  }

  $values = [ordered]@{
    targetPath = $activeExecutable
    arguments = ""
    workingDirectory = $activeAppRoot
    iconLocation = "$activeExecutable,0"
    description = "Codex Desktop with isCodexRunOut"
    hotkey = ""
    windowStyle = 1
  }
  $paths | ForEach-Object {
    Write-Shortcut -Shell $shell -Path $_ -Values $values
    Write-OperationLog "shortcut redirected path=$_"
  }
  [Environment]::SetEnvironmentVariable(
    "IS_CODEX_RUN_OUT_ROOT",
    $activeRoot,
    "User"
  )
  [Environment]::SetEnvironmentVariable(
    "IS_CODEX_RUN_OUT_APP",
    $activeExecutable,
    "User"
  )
  $env:IS_CODEX_RUN_OUT_ROOT = $activeRoot
  $env:IS_CODEX_RUN_OUT_APP = $activeExecutable
  Write-OperationLog "user environment redirect variables updated"
}

function Restore-Redirects {
  if (-not (Test-Path -LiteralPath $redirectStatePath -PathType Leaf)) {
    return
  }
  $state = Get-Content -Raw -LiteralPath $redirectStatePath |
    ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.mode -ne "copy-redirect") {
    throw "redirect-state.json has an incompatible schema"
  }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($entry in $state.shortcuts) {
    if ($entry.existed) {
      Write-Shortcut `
        -Shell $shell `
        -Path $entry.path `
        -Values $entry.original
      Write-OperationLog "shortcut restored path=$($entry.path)"
    } elseif (Test-Path -LiteralPath $entry.path -PathType Leaf) {
      $current = $shell.CreateShortcut($entry.path)
      if ($current.TargetPath -eq $activeExecutable) {
        Remove-Item -LiteralPath $entry.path -Force
        Write-OperationLog "created shortcut removed path=$($entry.path)"
      }
    }
  }
  [Environment]::SetEnvironmentVariable(
    "IS_CODEX_RUN_OUT_ROOT",
    $state.environment.IS_CODEX_RUN_OUT_ROOT,
    "User"
  )
  [Environment]::SetEnvironmentVariable(
    "IS_CODEX_RUN_OUT_APP",
    $state.environment.IS_CODEX_RUN_OUT_APP,
    "User"
  )
  Remove-Item -LiteralPath $redirectStatePath -Force
  Write-OperationLog "user environment redirect variables restored"
}

function Remove-ManagedItem {
  param([Parameter(Mandatory = $true)][string]$Target)

  Assert-ManagedPath -Target $Target
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
    Write-OperationLog "removed managed path=$Target"
  }
}

try {
  Write-OperationLog "start operation=$Operation pid=$PID"
  $package = Get-AppxPackage -Name OpenAI.Codex |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -eq $package) {
    throw "OpenAI.Codex AppX package was not found"
  }
  $sourceRoot = [IO.Path]::GetFullPath($package.InstallLocation)
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Codex Store source directory was not found"
  }

  if ($Operation -eq "patch") {
    Invoke-LayoutCopy -Source $sourceRoot -Destination $backupRoot
    Stop-CodexProcesses
    Invoke-LayoutCopy -Source $backupRoot -Destination $activeRoot

    $node = (Get-Command node -ErrorAction Stop).Source
    Push-Location $repoRoot
    try {
      & $node `
        (Join-Path $repoRoot "scripts\cli.mjs") `
        "copy-patch" `
        $backupRoot `
        $activeRoot 2>&1 |
        ForEach-Object {
          Write-Host $_
          Write-OperationLog "node: $($_.ToString())"
        }
      $nodeExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($nodeExitCode -ne 0) {
      throw "copy-patch failed with exit code $nodeExitCode"
    }
    if (-not (Test-Path -LiteralPath $activeExecutable -PathType Leaf)) {
      throw "Patched Codex executable was not found"
    }

    Install-Redirects
    Remove-ManagedItem -Target (Join-Path $patchHome "versions")
    Remove-ManagedItem -Target (Join-Path $patchHome "backups")
    foreach ($oldState in @("state.json", "direct-state.json")) {
      $oldStatePath = Join-Path $patchHome $oldState
      if (Test-Path -LiteralPath $oldStatePath -PathType Leaf) {
        Remove-Item -LiteralPath $oldStatePath -Force
      }
    }

    $startMenuShortcut = Join-Path (
      [Environment]::GetFolderPath("Programs")
    ) "ChatGPT (isCodexRunOut).lnk"
    Start-Process `
      -FilePath "explorer.exe" `
      -ArgumentList "`"$startMenuShortcut`""
    Write-OperationLog "patched copy launch requested"
  } else {
    Stop-CodexProcesses
    Restore-Redirects
    $node = (Get-Command node -ErrorAction Stop).Source
    & $node (Join-Path $repoRoot "scripts\cli.mjs") "forget"
    Remove-ManagedItem -Target $activeRoot
    Remove-ManagedItem -Target $backupRoot
    Remove-ManagedItem -Target (Join-Path $patchHome "versions")
    Remove-ManagedItem -Target (Join-Path $patchHome "backups")

    $applicationId = "$($package.PackageFamilyName)!App"
    Start-Process `
      -FilePath "explorer.exe" `
      -ArgumentList "shell:AppsFolder\$applicationId"
    Write-OperationLog "Store Codex launch requested"
  }

  Write-OperationLog "operation completed"
  Write-Host "Operation completed: $Operation"
  Write-Host "Log: $logPath"
  exit 0
} catch {
  Write-OperationLog "operation error: $($_.Exception.ToString())"
  Write-Error "$Operation failed: $($_.Exception.Message)"
  Write-Host "Detailed log: $logPath"
  exit 1
}
