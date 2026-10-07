const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const toIco = require('to-ico');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const THUMBAR_DIR = path.join(ASSETS_DIR, 'thumbar');

if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
if (!fs.existsSync(THUMBAR_DIR)) fs.mkdirSync(THUMBAR_DIR, { recursive: true });

// Helper to supersample and draw
function createIcon(targetSize, drawFn, scale = 4) {
  const w = targetSize * scale;
  const h = targetSize * scale;
  const highRes = new Float32Array(w * h * 4); // RGBA floats 0..1

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = (y * w + x) * 4;
    // Alpha blending
    const srcA = a;
    const dstA = highRes[idx + 3];
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      highRes[idx] = (r * srcA + highRes[idx] * dstA * (1 - srcA)) / outA;
      highRes[idx + 1] = (g * srcA + highRes[idx + 1] * dstA * (1 - srcA)) / outA;
      highRes[idx + 2] = (b * srcA + highRes[idx + 2] * dstA * (1 - srcA)) / outA;
      highRes[idx + 3] = outA;
    }
  }

  drawFn({ w, h, setPixel });

  // Downsample to target PNG
  const png = new PNG({ width: targetSize, height: targetSize });
  const block = scale * scale;

  for (let ty = 0; ty < targetSize; ty++) {
    for (let tx = 0; tx < targetSize; tx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const hx = tx * scale + sx;
          const hy = ty * scale + sy;
          const idx = (hy * w + hx) * 4;
          r += highRes[idx];
          g += highRes[idx + 1];
          b += highRes[idx + 2];
          a += highRes[idx + 3];
        }
      }
      const outIdx = (ty * targetSize + tx) * 4;
      png.data[outIdx] = Math.round((r / block) * 255);
      png.data[outIdx + 1] = Math.round((g / block) * 255);
      png.data[outIdx + 2] = Math.round((b / block) * 255);
      png.data[outIdx + 3] = Math.round((a / block) * 255);
    }
  }

  return png;
}

// Drawing primitives for high-res buffer
function fillRect(ctx, x1, y1, x2, y2, r, g, b, a) {
  const minX = Math.floor(Math.min(x1, x2));
  const maxX = Math.ceil(Math.max(x1, x2));
  const minY = Math.floor(Math.min(y1, y2));
  const maxY = Math.ceil(Math.max(y1, y2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
        ctx.setPixel(x, y, r, g, b, a);
      }
    }
  }
}

function fillRoundedRect(ctx, x1, y1, x2, y2, rad, r, g, b, a) {
  const minX = Math.floor(Math.min(x1, x2));
  const maxX = Math.ceil(Math.max(x1, x2));
  const minY = Math.floor(Math.min(y1, y2));
  const maxY = Math.ceil(Math.max(y1, y2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let inside = false;
      if (x >= x1 + rad && x <= x2 - rad && y >= y1 && y <= y2) inside = true;
      else if (x >= x1 && x <= x2 && y >= y1 + rad && y <= y2 - rad) inside = true;
      else {
        // Corners
        const cx = x < x1 + rad ? x1 + rad : x2 - rad;
        const cy = y < y1 + rad ? y1 + rad : y2 - rad;
        const distSq = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (distSq <= rad * rad) inside = true;
      }
      if (inside) ctx.setPixel(x, y, r, g, b, a);
    }
  }
}

function fillCircle(ctx, cx, cy, rad, r, g, b, a) {
  const minX = Math.floor(cx - rad);
  const maxX = Math.ceil(cx + rad);
  const minY = Math.floor(cy - rad);
  const maxY = Math.ceil(cy + rad);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 <= rad * rad) {
        ctx.setPixel(x, y, r, g, b, a);
      }
    }
  }
}

function fillTriangle(ctx, x1, y1, x2, y2, x3, y3, r, g, b, a) {
  const minX = Math.floor(Math.min(x1, x2, x3));
  const maxX = Math.ceil(Math.max(x1, x2, x3));
  const minY = Math.floor(Math.min(y1, y2, y3));
  const maxY = Math.ceil(Math.max(y1, y2, y3));

  function sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = sign(x, y, x1, y1, x2, y2);
      const d2 = sign(x, y, x2, y2, x3, y3);
      const d3 = sign(x, y, x3, y3, x1, y1);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) {
        ctx.setPixel(x, y, r, g, b, a);
      }
    }
  }
}

// Generate Play icon (32x32)
function generatePlay(alpha = 1.0) {
  return createIcon(32, (ctx) => {
    // Play triangle: (36, 26) to (36, 102) to (98, 64)
    // subtle dark shadow
    fillTriangle(ctx, 36, 28, 36, 104, 100, 66, 0, 0, 0, 0.25 * alpha);
    // white triangle
    fillTriangle(ctx, 36, 26, 36, 102, 98, 64, 1, 1, 1, alpha);
  });
}

// Generate Pause icon (32x32)
function generatePause(alpha = 1.0) {
  return createIcon(32, (ctx) => {
    // Left bar shadow
    fillRoundedRect(ctx, 32, 28, 52, 104, 6, 0, 0, 0, 0.25 * alpha);
    // Right bar shadow
    fillRoundedRect(ctx, 76, 28, 96, 104, 6, 0, 0, 0, 0.25 * alpha);
    // Left bar
    fillRoundedRect(ctx, 32, 26, 52, 102, 6, 1, 1, 1, alpha);
    // Right bar
    fillRoundedRect(ctx, 76, 26, 96, 102, 6, 1, 1, 1, alpha);
  });
}

// Generate Prev icon (32x32)
function generatePrev(alpha = 1.0) {
  return createIcon(32, (ctx) => {
    // Left bar
    fillRoundedRect(ctx, 24, 28, 36, 104, 4, 0, 0, 0, 0.25 * alpha);
    fillRoundedRect(ctx, 24, 26, 36, 102, 4, 1, 1, 1, alpha);
    // Left triangle: base at x=100 (from y=26 to 102), apex at (42, 64)
    fillTriangle(ctx, 100, 28, 100, 104, 42, 66, 0, 0, 0, 0.25 * alpha);
    fillTriangle(ctx, 100, 26, 100, 102, 42, 64, 1, 1, 1, alpha);
  });
}

// Generate Next icon (32x32)
function generateNext(alpha = 1.0) {
  return createIcon(32, (ctx) => {
    // Right bar
    fillRoundedRect(ctx, 92, 28, 104, 104, 4, 0, 0, 0, 0.25 * alpha);
    fillRoundedRect(ctx, 92, 26, 104, 102, 4, 1, 1, 1, alpha);
    // Right triangle: base at x=28 (from y=26 to 102), apex at (86, 64)
    fillTriangle(ctx, 28, 28, 28, 104, 86, 66, 0, 0, 0, 0.25 * alpha);
    fillTriangle(ctx, 28, 26, 28, 102, 86, 64, 1, 1, 1, alpha);
  });
}

// Generate SoundCloud Cloud App Icon (256x256)
function generateAppIcon(size = 256) {
  return createIcon(size, (ctx) => {
    const s = size * 4; // high res scale
    const center = s / 2;
    const cornerRad = s * 0.22; // rounded squircle

    // Background: SoundCloud Orange (#FF5500 with subtle top-to-bottom warm glow)
    for (let y = 0; y < s; y++) {
      const gradT = y / s;
      const r = 1.0;
      const g = 0.38 - gradT * 0.08;
      const b = 0.0;
      for (let x = 0; x < s; x++) {
        // Rounded box
        let inside = false;
        const m = s * 0.04; // small margin
        const x1 = m, y1 = m, x2 = s - m, y2 = s - m;
        if (x >= x1 + cornerRad && x <= x2 - cornerRad && y >= y1 && y <= y2) inside = true;
        else if (x >= x1 && x <= x2 && y >= y1 + cornerRad && y <= y2 - cornerRad) inside = true;
        else {
          const cx = x < x1 + cornerRad ? x1 + cornerRad : x2 - cornerRad;
          const cy = y < y1 + cornerRad ? y1 + cornerRad : y2 - cornerRad;
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= cornerRad * cornerRad) inside = true;
        }
        if (inside) ctx.setPixel(x, y, r, g, b, 1.0);
      }
    }

    // Now draw SoundCloud Cloud Logo in pure white (#FFFFFF)
    // Base y is at 0.65 of height
    const baseY = s * 0.65;
    const barWidth = s * 0.024;
    const barGap = s * 0.044;
    const startX = s * 0.20;

    // Bars: [xOffsetMultiplier, heightFraction]
    const bars = [
      0.18, 0.26, 0.34, 0.40, 0.45, 0.48, 0.47, 0.46, 0.48, 0.52
    ];

    bars.forEach((bh, i) => {
      const bx = startX + i * barGap;
      const barH = bh * s * 0.6;
      fillRoundedRect(ctx, bx - barWidth / 2, baseY - barH, bx + barWidth / 2, baseY, barWidth / 2, 1, 1, 1, 1);
    });

    // Cloud puffs (circles) on the right
    const cloudStartX = startX + (bars.length - 1) * barGap;
    // Puff 1
    fillCircle(ctx, cloudStartX + s * 0.04, baseY - s * 0.16, s * 0.16, 1, 1, 1, 1);
    // Puff 2 (top dome)
    fillCircle(ctx, cloudStartX + s * 0.15, baseY - s * 0.22, s * 0.18, 1, 1, 1, 1);
    // Puff 3 (upper right)
    fillCircle(ctx, cloudStartX + s * 0.27, baseY - s * 0.15, s * 0.15, 1, 1, 1, 1);
    // Puff 4 (lower right)
    fillCircle(ctx, cloudStartX + s * 0.33, baseY - s * 0.07, s * 0.10, 1, 1, 1, 1);

    // Flat bottom fill for the cloud
    fillRect(ctx, cloudStartX, baseY - s * 0.14, cloudStartX + s * 0.33, baseY, 1, 1, 1, 1);
  }, 2);
}

// Generate Tray Icon (32x32)
function generateTrayIcon() {
  return createIcon(32, (ctx) => {
    const s = 128; // scale 4
    // Draw white cloud with orange center or clean white cloud silhouette
    const baseY = s * 0.72;
    const barWidth = s * 0.035;
    const barGap = s * 0.065;
    const startX = s * 0.16;
    const bars = [0.22, 0.35, 0.45, 0.52, 0.58, 0.60];
    bars.forEach((bh, i) => {
      const bx = startX + i * barGap;
      const barH = bh * s * 0.6;
      fillRoundedRect(ctx, bx - barWidth / 2, baseY - barH, bx + barWidth / 2, baseY, barWidth / 2, 1, 1, 1, 1);
    });
    const cloudStartX = startX + (bars.length - 1) * barGap;
    fillCircle(ctx, cloudStartX + s * 0.06, baseY - s * 0.18, s * 0.18, 1, 1, 1, 1);
    fillCircle(ctx, cloudStartX + s * 0.18, baseY - s * 0.24, s * 0.20, 1, 1, 1, 1);
    fillCircle(ctx, cloudStartX + s * 0.32, baseY - s * 0.16, s * 0.16, 1, 1, 1, 1);
    fillCircle(ctx, cloudStartX + s * 0.38, baseY - s * 0.08, s * 0.10, 1, 1, 1, 1);
    fillRect(ctx, cloudStartX, baseY - s * 0.16, cloudStartX + s * 0.38, baseY, 1, 1, 1, 1);
  }, 4);
}

async function main() {
  console.log('Generating Thumbar icons...');
  fs.writeFileSync(path.join(THUMBAR_DIR, 'play.png'), PNG.sync.write(generatePlay(1.0)));
  fs.writeFileSync(path.join(THUMBAR_DIR, 'play-disabled.png'), PNG.sync.write(generatePlay(0.35)));

  fs.writeFileSync(path.join(THUMBAR_DIR, 'pause.png'), PNG.sync.write(generatePause(1.0)));
  fs.writeFileSync(path.join(THUMBAR_DIR, 'pause-disabled.png'), PNG.sync.write(generatePause(0.35)));

  fs.writeFileSync(path.join(THUMBAR_DIR, 'prev.png'), PNG.sync.write(generatePrev(1.0)));
  fs.writeFileSync(path.join(THUMBAR_DIR, 'prev-disabled.png'), PNG.sync.write(generatePrev(0.35)));

  fs.writeFileSync(path.join(THUMBAR_DIR, 'next.png'), PNG.sync.write(generateNext(1.0)));
  fs.writeFileSync(path.join(THUMBAR_DIR, 'next-disabled.png'), PNG.sync.write(generateNext(0.35)));

  // If official PWA icon exists, run build-official-icon.js
  const officialBuilder = path.join(__dirname, 'build-official-icon.js');
  if (fs.existsSync(officialBuilder)) {
    console.log('Building official icons using build-official-icon.js...');
    require('./build-official-icon.js');
  }

  console.log('All assets generated successfully!');
}

main().catch(console.error);
