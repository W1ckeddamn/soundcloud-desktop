const fs = require('fs');
const path = require('path');
const toIco = require('to-ico');

const thumbarDir = path.join(__dirname, '..', 'assets', 'thumbar');

async function convert() {
  const names = ['play', 'pause', 'prev', 'next', 'play-disabled', 'pause-disabled', 'prev-disabled', 'next-disabled'];
  for (const name of names) {
    const pngBuf = fs.readFileSync(path.join(thumbarDir, `${name}.png`));
    const icoBuf = await toIco([pngBuf]);
    fs.writeFileSync(path.join(thumbarDir, `${name}.ico`), icoBuf);
  }
  console.log('Converted all thumbar icons to ICO!');
}

convert().catch(console.error);
