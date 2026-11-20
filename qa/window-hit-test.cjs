'use strict';

const { execFileSync } = require('node:child_process');

// Windows reports HTCAPTION (2) for native drag regions and HTCLIENT (1) for controls.
module.exports = async function windowHitTest(app, page) {
  const points = await page.evaluate(() => {
    const title = document.querySelector('.title-bar-drag').getBoundingClientRect();
    const pin = document.querySelector('.title-pin-btn').getBoundingClientRect();
    const theme = document.querySelector('.theme-seg').getBoundingClientRect();
    const rail = document.querySelector('.side-rail').getBoundingClientRect();
    return [
      [title.x + title.width / 2, title.y + title.height / 2],
      [(pin.right + theme.left) / 2, pin.y + pin.height / 2],
      [pin.x + pin.width / 2, pin.y + pin.height / 2],
      [rail.x + rail.width / 2, rail.y + 22],
    ].map(([x, y]) => [Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio)]);
  });
  const handle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  const coordinates = points.map(([x, y]) => `@(${x},${y})`).join(',');
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BossDotWindowHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
[void][BossDotWindowHitTest]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$window = [IntPtr]::new([long]${handle})
if (![BossDotWindowHitTest]::IsWindow($window)) { throw 'BossDot test window is not available' }
$origin = [BossDotWindowHitTest+Point]::new()
if (![BossDotWindowHitTest]::ClientToScreen($window, [ref]$origin)) { throw 'Cannot locate BossDot test window' }
foreach ($point in @(${coordinates})) {
  $location = (($point[0] + $origin.x) -band 65535) -bor ((($point[1] + $origin.y) -band 65535) -shl 16)
  [BossDotWindowHitTest]::SendMessageW($window, 132, [IntPtr]::Zero, [IntPtr]::new([long]$location)).ToInt64()
}
`;
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return output.trim().split(/\r?\n/).map(Number);
};
