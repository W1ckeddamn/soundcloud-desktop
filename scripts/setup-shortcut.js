const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const targetExe = path.resolve(__dirname, '..', 'dist', 'SoundCloud-win32-x64', 'SoundCloud.exe');
const workingDir = path.resolve(__dirname, '..', 'dist', 'SoundCloud-win32-x64');
const iconPath = path.resolve(__dirname, '..', 'assets', 'icon.ico');
const userProfile = process.env.USERPROFILE || 'C:\\Users\\wicked';
const desktopShortcut = path.join(userProfile, 'Desktop', 'SoundCloud.lnk');

console.log('Target Exe:', targetExe);
console.log('Exists:', fs.existsSync(targetExe));
console.log('Icon Path:', iconPath);
console.log('Exists:', fs.existsSync(iconPath));
console.log('Shortcut Path:', desktopShortcut);

const psScript = `
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut("${desktopShortcut.replace(/\\/g, '\\\\')}")
$sc.TargetPath = "${targetExe.replace(/\\/g, '\\\\')}"
$sc.WorkingDirectory = "${workingDir.replace(/\\/g, '\\\\')}"
$sc.Arguments = ""
$sc.IconLocation = "${iconPath.replace(/\\/g, '\\\\')},0"
$sc.Description = "SoundCloud Desktop Application"
$sc.Save()

$verify = $wsh.CreateShortcut("${desktopShortcut.replace(/\\/g, '\\\\')}")
Write-Output "Verified TargetPath: $($verify.TargetPath)"
Write-Output "Verified Arguments: $($verify.Arguments)"
Write-Output "Verified IconLocation: $($verify.IconLocation)"
`;

const tempPs = path.join(__dirname, 'temp_shortcut.ps1');
fs.writeFileSync(tempPs, psScript, 'utf8');

try {
  const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPs}"`).toString();
  console.log('Result:\n', result);
} finally {
  if (fs.existsSync(tempPs)) fs.unlinkSync(tempPs);
}
