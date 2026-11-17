# Generates the pixel-art app icon (16x16 grid) as public/icon.svg, public/icon-*.png and public/icon.ico.
# Edit the $grid below and re-run:  powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pub = Join-Path $root 'public'

$n = 16
# . transparent   B border   D background   S glyph shadow (auto)   1..4 glyph (light -> dark)
$grid = [string[]]@(
  '.BBBBBBBBBBBBBB.',
  'BBDDDDDDDDDDDDBB',
  'BDDDDDDDDDDDDDDB',
  'BDDDDDDDDDDDDDDB',
  'BDD11DDDDDDDDDDB',
  'BDDD11DDDDDDDDDB',
  'BDDDD22DDDDDDDDB',
  'BDDDDD22DDDDDDDB',
  'BDDDDD33DDDDDDDB',
  'BDDDD33DDDDDDDDB',
  'BDDD44DDD4444DDB',
  'BDD44DDDD4444DDB',
  'BDDDDDDDDDDDDDDB',
  'BDDDDDDDDDDDDDDB',
  'BBDDDDDDDDDDDDBB',
  '.BBBBBBBBBBBBBB.'
)
# drop shadow: a background cell one step down-right of a glyph pixel
for ($y = $n - 1; $y -ge 1; $y--) {
  $a = $grid[$y].ToCharArray()
  for ($x = 1; $x -lt $n; $x++) { if ($a[$x] -eq 'D' -and '1234'.Contains([string]$grid[$y - 1][$x - 1])) { $a[$x] = 'S' } }
  $grid[$y] = -join $a
}
$pal = @{
  'B' = '#c25a1f'; 'D' = '#15181e'; 'S' = '#3d2416'
  '1' = '#ffb27a'; '2' = '#ff9a57'; '3' = '#f77a2c'; '4' = '#ea580c'
}

# SVG: one rect per horizontal run, crisp edges
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append("<svg xmlns=`"http://www.w3.org/2000/svg`" viewBox=`"0 0 $n $n`" shape-rendering=`"crispEdges`">")
for ($y = 0; $y -lt $n; $y++) {
  $row = $grid[$y]; $x = 0
  while ($x -lt $n) {
    $c = $row[$x]; $x0 = $x
    while ($x -lt $n -and $row[$x] -eq $c) { $x++ }
    if ($c -ne '.') { [void]$sb.Append("<rect x=`"$x0`" y=`"$y`" width=`"$($x - $x0)`" height=`"1`" fill=`"$($pal[[string]$c])`"/>") }
  }
}
[void]$sb.Append('</svg>')
[IO.File]::WriteAllText((Join-Path $pub 'icon.svg'), $sb.ToString())

# PNGs (nearest-neighbour upscale)
$base = New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt $n; $y++) { for ($x = 0; $x -lt $n; $x++) {
  $c = [string]$grid[$y][$x]
  $col = if ($c -eq '.') { [System.Drawing.Color]::Transparent } else { [System.Drawing.ColorTranslator]::FromHtml($pal[$c]) }
  $base.SetPixel($x, $y, $col)
} }
function Scale($size) {
  $b = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($base, 0, 0, $size, $size); $g.Dispose()
  $ms = New-Object IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
  return ,$ms.ToArray()
}
$pngs = [ordered]@{}
foreach ($s in 16, 32, 48, 64, 128, 256) { $pngs["$s"] = Scale $s }
foreach ($s in 32, 192, 512) { [IO.File]::WriteAllBytes((Join-Path $pub "icon-$s.png"), (Scale $s)) }

# ICO with embedded PNGs
$ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$pngs.Count)
$off = 6 + 16 * $pngs.Count
foreach ($s in $pngs.Keys) {
  $d = $pngs[$s]; $dim = if ([int]$s -ge 256) { 0 } else { [int]$s }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$d.Length); $w.Write([uint32]$off); $off += $d.Length
}
foreach ($s in $pngs.Keys) { $w.Write($pngs[$s]) }
$w.Flush(); [IO.File]::WriteAllBytes((Join-Path $pub 'icon.ico'), $ms.ToArray())
Write-Output 'icon.svg / icon-32,192,512.png / icon.ico written'
