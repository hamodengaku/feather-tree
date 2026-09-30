<#
.SYNOPSIS
  build/icon/source.png から、build/icon.ico に必要な9サイズの PNG を作る。

.DESCRIPTION
  System.Drawing (GDI+) の HighQualityBicubic で縮小する。
  出力は 32bppArgb で保存するため、build/icon/README.md の必須要件
  （R1 PNG形式 / R2 ファイル名=実寸 / R3 8bit RGBA・非インターレース）を満たす。

  このスクリプトは画像を「作る」側。build/icon.ico への封入は
  scripts/make-icon.mjs（npm run icon）が別途行う。

  SIZES はここと scripts/make-icon.mjs の両方で定義している。
  増減する場合は両方と build/icon/README.md の表を直すこと。

.PARAMETER Source
  元画像のパス。既定は build/icon/source.png。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build/icon/make-sizes.ps1
  npm run icon:sizes
#>
param(
  [string]$Source = (Join-Path $PSScriptRoot "source.png")
)

$ErrorActionPreference = "Stop"

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$outDir = $PSScriptRoot

if (-not (Test-Path $Source)) {
  Write-Error "元画像が見つかりません: $Source"
  exit 1
}

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
try {
  if ($src.Width -ne $src.Height) {
    Write-Error "元画像が正方形ではありません: $($src.Width)x$($src.Height)"
    exit 1
  }
  Write-Output "[icon:sizes] source: $Source ($($src.Width)x$($src.Height))"

  foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($src, 0, 0, $size, $size)
    } finally {
      $g.Dispose()
    }

    $outPath = Join-Path $outDir "$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $bytes = (Get-Item $outPath).Length
    Write-Output ("[icon:sizes] wrote {0}.png ({1:N1} KB)" -f $size, ($bytes / 1KB))
  }
} finally {
  $src.Dispose()
}

Write-Output "[icon:sizes] 完了。npm run icon で build/icon.ico を作り直してください。"
