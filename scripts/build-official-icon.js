const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const toIco = require('to-ico');

const sourcePath = path.join(__dirname, '..', 'assets', 'pwa-round-icon-512x512.png');
const assetsDir = path.join(__dirname, '..', 'assets');

if (!fs.existsSync(sourcePath)) {
  console.error('Source icon does not exist:', sourcePath);
  process.exit(1);
}

const sourceBuffer = fs.readFileSync(sourcePath);
const srcPng = PNG.sync.read(sourceBuffer);

console.log(`Source icon loaded: ${srcPng.width}x${srcPng.height}`);

// Area-averaging downsample for high fidelity
function resizePNG(src, targetSize) {
  const dst = new PNG({ width: targetSize, height: targetSize });
  const xRatio = src.width / targetSize;
  const yRatio = src.height / targetSize;

  for (let ty = 0; ty < targetSize; ty++) {
    const srcYStart = ty * yRatio;
    const srcYEnd = (ty + 1) * yRatio;
    const y0 = Math.floor(srcYStart);
    const y1 = Math.min(src.height, Math.ceil(srcYEnd));

    for (let tx = 0; tx < targetSize; tx++) {
      const srcXStart = tx * xRatio;
      const srcXEnd = (tx + 1) * xRatio;
      const x0 = Math.floor(srcXStart);
      const x1 = Math.min(src.width, Math.ceil(srcXEnd));

      let totalWeight = 0;
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

      for (let sy = y0; sy < y1; sy++) {
        const yWeight = Math.min(sy + 1, srcYEnd) - Math.max(sy, srcYStart);
        if (yWeight <= 0) continue;

        for (let sx = x0; sx < x1; sx++) {
          const xWeight = Math.min(sx + 1, srcXEnd) - Math.max(sx, srcXStart);
          if (xWeight <= 0) continue;

          const weight = xWeight * yWeight;
          const idx = (sy * src.width + sx) * 4;

          const a = src.data[idx + 3] / 255;
          // Premultiplied alpha for correct color blending
          rSum += src.data[idx] * a * weight;
          gSum += src.data[idx + 1] * a * weight;
          bSum += src.data[idx + 2] * a * weight;
          aSum += a * weight;
          totalWeight += weight;
        }
      }

      const dstIdx = (ty * targetSize + tx) * 4;
      if (totalWeight > 0 && aSum > 0) {
        const avgA = aSum / totalWeight;
        dst.data[dstIdx] = Math.round((rSum / aSum));
        dst.data[dstIdx + 1] = Math.round((gSum / aSum));
        dst.data[dstIdx + 2] = Math.round((bSum / aSum));
        dst.data[dstIdx + 3] = Math.round(avgA * 255);
      } else {
        dst.data[dstIdx] = 0;
        dst.data[dstIdx + 1] = 0;
        dst.data[dstIdx + 2] = 0;
        dst.data[dstIdx + 3] = 0;
      }
    }
  }

  return dst;
}

async function generateAll() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const size of sizes) {
    const resized = resizePNG(srcPng, size);
    const buf = PNG.sync.write(resized);
    pngBuffers.push(buf);
    console.log(`Generated ${size}x${size} icon layer`);

    if (size === 256) {
      fs.writeFileSync(path.join(assetsDir, 'icon.png'), buf);
      console.log('Saved assets/icon.png (256x256)');
    }
    if (size === 32) {
      fs.writeFileSync(path.join(assetsDir, 'tray.png'), buf);
      console.log('Saved assets/tray.png (32x32)');
    }
  }

  const icoBuffer = await toIco(pngBuffers);
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer);
  console.log('Saved assets/icon.ico (with 16, 32, 48, 64, 128, 256 layers)');
}

generateAll().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
