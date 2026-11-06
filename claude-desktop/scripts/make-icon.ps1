Add-Type -AssemblyName System.Drawing

$size = 512
$out  = "E:\Web\FuckCladue\claude-desktop\build\icon.png"

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

function Round-Rect([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90) | Out-Null
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90) | Out-Null
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90) | Out-Null
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90) | Out-Null
  $p.CloseFigure()
  return $p
}

# 外底板（深色，带一点渐变）
$rect = Round-Rect 16 16 ($size - 32) ($size - 32) 104
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point $size, $size),
  [System.Drawing.Color]::FromArgb(255, 30, 32, 40),
  [System.Drawing.Color]::FromArgb(255, 17, 18, 22))
$g.FillPath($brush, $rect)

# 描边（Claude 橙，低透明度）
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 217, 119, 87)), 6
$g.DrawPath($pen, $rect)

# 中间：终端提示符 ">_" 造型（用两笔几何图形，避免字体依赖）
$orange = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 119, 87))
$penO   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 217, 119, 87)), 30
$penO.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$penO.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
$penO.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

# ">" 折线
$pts = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point 150, 190),
  (New-Object System.Drawing.Point 235, 256),
  (New-Object System.Drawing.Point 150, 322)
)
$g.DrawLines($penO, $pts)

# "_" 光标
$g.DrawLine($penO, 275, 322, 375, 322)

# 角标小方块（虚拟环境/容器意象）
$sq = Round-Rect 340 150 62 62 16
$g.FillPath($orange, $sq)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("icon written: {0}" -f $out)
