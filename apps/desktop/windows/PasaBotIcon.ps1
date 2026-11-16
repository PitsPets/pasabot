# PasaBot's mark, "Silip" (two eyes), drawn with GDI+ for Windows: the tray icon in three states (the same
# drawing as the macOS menu-bar icon, apps/desktop/macos/PasaBotMenu.swift eyesIcon) and the app's .ico for the
# installer and the Start menu (build-windows.ps1). Cream eyes on the app icon's dark green plate, so it reads on a
# light and a dark taskbar. PowerShell 5.1 + System.Drawing, which ship with Windows. Dot-source it: . .\PasaBotIcon.ps1
Add-Type -AssemblyName System.Drawing

$script:PlateColor = [System.Drawing.Color]::FromArgb(255, 0x14, 0x43, 0x2F)
$script:EyeColor = [System.Drawing.Color]::FromArgb(255, 0xFF, 0xFD, 0xF6)

# state: 'running' (eyes open), 'stopped' (eyes closed), 'problem' (eyes crossed)
function New-PasaBotBitmap([int]$Size, [string]$State = 'running') {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    # the plate: a rounded square
    $r = [single]($Size * 0.22)
    $d = [single]($r * 2)
    $w = [single]($Size - 1)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($w - $d, 0, $d, $d, 270, 90)
    $path.AddArc($w - $d, $w - $d, $d, $d, 0, 90)
    $path.AddArc(0, $w - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $plate = New-Object System.Drawing.SolidBrush($script:PlateColor)
    $g.FillPath($plate, $path)
    $plate.Dispose(); $path.Dispose()
    # the eyes, on the macOS 18-unit design (y flipped: GDI+ counts from the top)
    $k = [single]($Size / 18.0)
    $pen = New-Object System.Drawing.Pen($script:EyeColor, [single]([Math]::Max(1.0, 1.4 * $k)))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $fill = New-Object System.Drawing.SolidBrush($script:EyeColor)
    foreach ($cx in @(4.6, 13.4)) {
      $ex = [single](($cx - 3) * $k); $ey = [single]((18 - 4.5 - 9) * $k)
      $ew = [single](6 * $k); $eh = [single](9 * $k)
      switch ($State) {
        'running' {
          $g.DrawEllipse($pen, $ex, $ey, $ew, $eh)
          $g.FillEllipse($fill, [single](($cx - 0.5) * $k), [single]((18 - 6.8 - 3.4) * $k), [single](2.8 * $k), [single](3.4 * $k))
        }
        'stopped' {
          $g.DrawBezier($pen, [single](($cx - 3) * $k), [single]((18 - 9.5) * $k), [single](($cx - 1.6) * $k), [single]((18 - 6.5) * $k),
            [single](($cx + 1.6) * $k), [single]((18 - 6.5) * $k), [single](($cx + 3) * $k), [single]((18 - 9.5) * $k))
        }
        default {
          $g.DrawEllipse($pen, $ex, $ey, $ew, $eh)
          $g.DrawLine($pen, [single](($cx - 1.2) * $k), [single]((18 - 7.8) * $k), [single](($cx + 1.2) * $k), [single]((18 - 10.2) * $k))
          $g.DrawLine($pen, [single](($cx - 1.2) * $k), [single]((18 - 10.2) * $k), [single](($cx + 1.2) * $k), [single]((18 - 7.8) * $k))
        }
      }
    }
    $pen.Dispose(); $fill.Dispose()
  } finally {
    $g.Dispose()
  }
  return $bmp
}

# a tray icon for one state; the caller disposes it
function New-PasaBotIcon([string]$State = 'running') {
  $size = [Math]::Max(16, [System.Windows.Forms.SystemInformation]::SmallIconSize.Width)
  $bmp = New-PasaBotBitmap $size $State
  try { return [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) } finally { $bmp.Dispose() }
}

# a multi-size .ico (PNG entries, Windows Vista and later) for the installer and the shortcuts
function Save-PasaBotIco([string]$Path) {
  $sizes = @(16, 24, 32, 48, 64, 256)
  $pngs = @()
  foreach ($s in $sizes) {
    $bmp = New-PasaBotBitmap $s 'running'
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $pngs += , $ms.ToArray()
    $ms.Dispose()
  }
  $out = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($out)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $b = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset)
    $offset += $pngs[$i].Length
  }
  foreach ($p in $pngs) { $bw.Write($p) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
  $bw.Dispose(); $out.Dispose()
}
