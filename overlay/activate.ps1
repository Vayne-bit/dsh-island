# Bring the DSH main window to the foreground (click-through pill -> click).
# Fallback path only: the overlay normally sends "activate" over watch.ps1's stdin.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IslandFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
}
"@

$targets = Get-Process -Name 'DeepSeek Harness' | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*DeepSeek Harness*'
}
$p = $targets | Select-Object -First 1
if (-not $p) { exit }

# 先按一下 Alt 骗过前台锁定，再抢焦点
[IslandFg]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[IslandFg]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
# 只在真最小化时还原。SW_RESTORE 会把最大化窗口缩回普通窗口，就是用户报的「点了变成窗口化」
if ([IslandFg]::IsIconic($p.MainWindowHandle)) { [IslandFg]::ShowWindow($p.MainWindowHandle, 9) | Out-Null }
[IslandFg]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
