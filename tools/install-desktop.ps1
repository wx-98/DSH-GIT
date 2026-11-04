<#
.SYNOPSIS
  把本目录安装为 DSH 桌面端（desktop profile）插件。

.DESCRIPTION
  做三件事（幂等，可重复执行）：
    1. 在 profile 的 node_modules 里建立指向本目录的 junction（等价于 pnpm 的 link: 安装）；
    2. 在 profile 的 package.json 里登记 dependencies['@wx-98/dsh-git'] 与 dsh.profile.bundles 中的 @wx-98/dsh-git；
    3. 可选地往 profile 的 cordis.patch.yml 写一个 insert 行，让**正在运行**的 DSH 实例热加载 Host 半边。

  注意：desktop profile 由 Electron 应用独占管理，dsh CLI 会拒绝操作它，所以这里直接改文件。
  安装后需要**重启 DSH 应用**（或用 -LivePatch + 刷新页面）。

.PARAMETER Profile
  profile 目录，默认 $env:USERPROFILE\.dsh\profiles\desktop。

.PARAMETER PluginDir
  插件目录，默认本脚本所在仓库根目录。

.PARAMETER LivePatch
  额外把 insert 行写进 profile 的 cordis.patch.yml（patchReload 默认为 live，运行中的实例会热加载）。

.PARAMETER RemoveLivePatch
  从 cordis.patch.yml 里移除本脚本添加的 insert 行。
#>
[CmdletBinding()]
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$LivePatch,
  [switch]$RemoveLivePatch
)

$ErrorActionPreference = 'Stop'
$nl = [Environment]::NewLine
# DSH reads these files as UTF-8; a BOM breaks its JSON/YAML parsers.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$packageJson = Join-Path $Profile 'package.json'
$nodeModules = Join-Path $Profile 'node_modules'
# Scoped package: node_modules/@wx-98/dsh-git
$pkgName = '@wx-98/dsh-git'
$pkgScope = '@wx-98'
$pkgLeaf = 'dsh-git'
$legacyName = 'dsh-git'
$scopeDir = Join-Path $nodeModules $pkgScope
$linkPath = Join-Path $scopeDir $pkgLeaf
$legacyLinkPath = Join-Path $nodeModules $legacyName
$patchFile = Join-Path $Profile 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $packageJson)) { throw "找不到 profile: $Profile" }
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'package.json'))) { throw "找不到插件目录: $PluginDir" }

$pluginManifest = Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
if ($pluginManifest.name -ne $pkgName) { throw "插件包的 name 应为 $pkgName，实际为 $($pluginManifest.name)" }
if (-not (Test-Path -LiteralPath $scopeDir)) { $null = New-Item -ItemType Directory -Path $scopeDir }
# Remove a legacy unscoped link so the old identity cannot shadow the new one.
if (Test-Path -LiteralPath $legacyLinkPath) {
  $legacyItem = Get-Item -LiteralPath $legacyLinkPath -Force
  if ($legacyItem.LinkType -eq 'Junction') {
    # Remove-Item prompts on a link in non-interactive hosts; Directory.Delete
    # removes the reparse point itself and never touches the target directory.
    [System.IO.Directory]::Delete($legacyLinkPath, $false)
    Write-Host "[-] 已移除旧 junction node_modules\$legacyName"
  }
}

# 1) junction
if (Test-Path -LiteralPath $linkPath) {
  $existing = Get-Item -LiteralPath $linkPath -Force
  if ($existing.LinkType -eq 'Junction' -and $existing.Target -eq $PluginDir) {
    Write-Host "[=] node_modules\$pkgScope\$pkgLeaf 已指向 $PluginDir"
  } else {
    throw "$linkPath 已存在且不是指向本目录的 junction，请先手工处理"
  }
} else {
  $null = New-Item -ItemType Junction -Path $linkPath -Target $PluginDir
  Write-Host "[+] 已建立 junction: $linkPath -> $PluginDir"
}

# 2) package.json
$manifest = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
$depSpec = 'link:' + ($PluginDir -replace '\\', '/')
$changed = $false

if ($null -eq $manifest.dependencies) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if ($manifest.dependencies.PSObject.Properties[$legacyName] -ne $null) {
  $manifest.dependencies.PSObject.Properties.Remove($legacyName)
  $changed = $true
  Write-Host "[-] dependencies['$legacyName'] 已移除"
}
if ($manifest.dependencies.$pkgName -ne $depSpec) {
  $manifest.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $depSpec -Force
  $changed = $true
  Write-Host "[+] dependencies['$pkgName'] = $depSpec"
}
$bundles = @($manifest.dsh.profile.bundles) | Where-Object { $_ -ne $legacyName }
if ($bundles -notcontains $pkgName) {
  $manifest.dsh.profile.bundles = @($bundles + $pkgName)
  $changed = $true
  Write-Host "[+] dsh.profile.bundles += $pkgName"
} elseif (@($manifest.dsh.profile.bundles) -ne $bundles) {
  $manifest.dsh.profile.bundles = $bundles
  $changed = $true
}
if ($changed) {
  $backup = $packageJson + '.dsh-git-backup'
  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $packageJson -Destination $backup }
  [System.IO.File]::WriteAllText($packageJson, ($manifest | ConvertTo-Json -Depth 32), $utf8NoBom)
  Write-Host "[+] 已写回 package.json（原文件备份为 $(Split-Path -Leaf $backup)）"
} else {
  Write-Host "[=] package.json 已登记 $pkgName"
}

# Remove the previous unscoped live-patch block (identity migration), if any.
if (Test-Path -LiteralPath $patchFile) {
  $existingPatch = Get-Content -LiteralPath $patchFile -Raw
  $legacyMarker = '# >>> dsh-git live patch >>>'
  $legacyPattern = '(?s)\r?\n?' + [regex]::Escape($legacyMarker) + '.*?# <<< dsh-git live patch <<<'
  if ($existingPatch -match $legacyPattern) {
    [System.IO.File]::WriteAllText($patchFile, [regex]::Replace($existingPatch, $legacyPattern, ''), $utf8NoBom)
    Write-Host '[-] 已移除旧的 dsh-git live patch 块'
  }
}

# 3) 可选的 live patch
$marker = '# >>> @wx-98/dsh-git live patch >>>'
$block = @(
  $marker,
  '- insert:',
  '    - id: git',
  "      name: '@wx-98/dsh-git'",
  '# <<< @wx-98/dsh-git live patch <<<'
) -join $nl

if ($RemoveLivePatch) {
  if (Test-Path -LiteralPath $patchFile) {
    $content = Get-Content -LiteralPath $patchFile -Raw
    $pattern = '(?s)\r?\n?' + [regex]::Escape($marker) + '.*?# <<< @wx-98/dsh-git live patch <<<'
    if ($content -match $pattern) {
      [System.IO.File]::WriteAllText($patchFile, [regex]::Replace($content, $pattern, ''), $utf8NoBom)
      Write-Host '[-] 已移除 cordis.patch.yml 中的 live patch 块'
    } else {
      Write-Host '[=] cordis.patch.yml 里没有 live patch 块'
    }
  }
} elseif ($LivePatch) {
  $content = ''
  if (Test-Path -LiteralPath $patchFile) { $content = Get-Content -LiteralPath $patchFile -Raw }
  if ($content -notmatch [regex]::Escape($marker)) {
    Copy-Item -LiteralPath $patchFile -Destination ($patchFile + '.dsh-git-backup') -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText($patchFile, ($content.TrimEnd() + $nl + $nl + $block + $nl), $utf8NoBom)
    Write-Host '[+] 已写入 live patch（运行中的实例会热加载 Host 半边）'
  } else {
    Write-Host '[=] live patch 块已存在'
  }
}

Write-Host ''
Write-Host '完成。后续步骤：'
Write-Host '  1. 重启 DSH 桌面应用（或已用 -LivePatch 时只需刷新页面）。'
Write-Host '  2. 在右侧栏点 + -> 选择 Git 标签。'
