# Taskbar badge helper for CliCtrl. Started by server.js; reads lines "<wait> <unread>" from stdin until EOF.
#   wait   = sessions Claude is waiting on you for (yellow)  -> yellow overlay dot with the count, flashes when it grows
#   unread = sessions that finished and were not looked at (blue) -> blue overlay dot with the count
# ITaskbarList3::SetOverlayIcon only works from the process that owns the window (E_FAIL from here), so instead the window's
# own icon is swapped (WM_SETICON works across processes) for the original icon with a coloured dot + count in the corner.
# The taskbar button of every CliCtrl app window (the Edge/Chrome windows that use our profile) gets it; 0/0 restores the original.
param([string]$Profile)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;

[StructLayout(LayoutKind.Sequential)]
public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }

public static class TB {
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO f);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] static extern IntPtr GetClassLongPtr(IntPtr h, int i);
  const uint WM_SETICON = 0x80, WM_GETICON = 0x7F;
  class St { public IntPtr big, small, mine; public string key = "?"; }
  static readonly System.Collections.Generic.Dictionary<IntPtr, St> state = new System.Collections.Generic.Dictionary<IntPtr, St>();
  static bool Valid(IntPtr h) { if (h == IntPtr.Zero) return false; try { using (var ic = Icon.FromHandle(h)) using (var b = ic.ToBitmap()) return true; } catch { return false; } }
  // helper is ending: hand every window its original icon back
  public static void RestoreAll() { foreach (var k in new System.Collections.Generic.List<IntPtr>(state.Keys)) if (IsWindow(k)) Apply(k, Color.Empty, Color.Empty, null); }
  static IntPtr Compose(IntPtr baseIcon, Color fill, Color text, string label) {
    using (var bmp = new Bitmap(64, 64)) using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      if (baseIcon != IntPtr.Zero) using (var ic = Icon.FromHandle(baseIcon)) using (var bi = ic.ToBitmap()) g.DrawImage(bi, 0, 0, 64, 64);
      var r = new Rectangle(26, 26, 37, 37);
      using (var b = new SolidBrush(fill)) g.FillEllipse(b, r);
      using (var p = new Pen(Color.White, 3)) g.DrawEllipse(p, r);
      using (var f = new Font("Segoe UI", label.Length > 1 ? 20 : 26, FontStyle.Bold, GraphicsUnit.Pixel))
      using (var t = new SolidBrush(text)) {
        var sz = g.MeasureString(label, f);
        g.DrawString(label, f, t, r.X + (r.Width - sz.Width) / 2 + 1, r.Y + (r.Height - sz.Height) / 2 + 1);
      }
      return bmp.GetHicon();
    }
  }
  // label == null: put the window's original icon back
  public static void Apply(IntPtr hwnd, Color fill, Color text, string label) {
    St s; if (!state.TryGetValue(hwnd, out s)) {
      s = new St();
      // a handle left behind by an earlier helper that was killed would be dead: validate, else use the window class's icon
      s.big = SendMessage(hwnd, WM_GETICON, (IntPtr)1, IntPtr.Zero); if (!Valid(s.big)) s.big = GetClassLongPtr(hwnd, -14); if (!Valid(s.big)) s.big = IntPtr.Zero;
      s.small = SendMessage(hwnd, WM_GETICON, IntPtr.Zero, IntPtr.Zero); if (!Valid(s.small)) s.small = GetClassLongPtr(hwnd, -34); if (!Valid(s.small)) s.small = IntPtr.Zero;
      state[hwnd] = s;
    }
    var key = label == null ? null : fill.ToArgb() + label;
    if (key == s.key) return;
    s.key = key;
    var old = s.mine;
    if (label == null) { SendMessage(hwnd, WM_SETICON, (IntPtr)1, s.big); SendMessage(hwnd, WM_SETICON, IntPtr.Zero, s.small); s.mine = IntPtr.Zero; }
    else { s.mine = Compose(s.big != IntPtr.Zero ? s.big : s.small, fill, text, label); SendMessage(hwnd, WM_SETICON, (IntPtr)1, s.mine); SendMessage(hwnd, WM_SETICON, IntPtr.Zero, s.mine); }
    if (old != IntPtr.Zero) DestroyIcon(old);
  }
  public static void Forget() { var gone = new System.Collections.Generic.List<IntPtr>(); foreach (var k in state.Keys) if (!IsWindow(k)) gone.Add(k); foreach (var k in gone) state.Remove(k); }
  public static void Flash(IntPtr hwnd) {
    var f = new FLASHWINFO(); f.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)); f.hwnd = hwnd;
    f.dwFlags = 2 | 12; // FLASHW_TRAY | FLASHW_TIMERNOFG: flash the taskbar button until the window is brought to the front
    f.uCount = 0; f.dwTimeout = 0; FlashWindowEx(ref f);
  }
}
'@

function Get-AppWindows {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like ('*' + $Profile + '*') -and $_.CommandLine -notlike '*--type=*' })
  foreach ($p in $procs) {
    $h = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle
    if ($h -and $h -ne [IntPtr]::Zero) { $h }
  }
}

$lastWait = 0
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $n = $line.Trim() -split '\s+'
  if ($n.Count -lt 2) { continue }
  $wait = [int]$n[0]; $unread = [int]$n[1]
  $fill = [Drawing.Color]::Empty; $text = [Drawing.Color]::Empty; $label = $null
  if ($wait -gt 0) { $fill = [Drawing.Color]::FromArgb(250, 190, 20); $text = [Drawing.Color]::Black; $label = $(if ($wait -gt 9) { '9+' } else { "$wait" }) }
  elseif ($unread -gt 0) { $fill = [Drawing.Color]::FromArgb(40, 130, 240); $text = [Drawing.Color]::White; $label = $(if ($unread -gt 9) { '9+' } else { "$unread" }) }
  [TB]::Forget()
  foreach ($h in @(Get-AppWindows)) {
    try {
      [TB]::Apply($h, $fill, $text, $label)
      if ($wait -gt $lastWait) { [TB]::Flash($h) }
    } catch { [Console]::Error.WriteLine('icon failed: ' + $_.Exception.Message) }
  }
  $lastWait = $wait
}
# stdin closed (server gone): do not leave a dot behind
try { [TB]::RestoreAll() } catch {}
