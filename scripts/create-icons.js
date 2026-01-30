// Script to create tray icons as PNG files
// Run with: node scripts/create-icons.js

const fs = require('fs');
const path = require('path');

// Create a simple 32x32 PNG with a colored circle
// Using PNG format with RGBA data

function createPNG(width, height, red, green, blue) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);  // width
  ihdrData.writeUInt32BE(height, 4); // height
  ihdrData.writeUInt8(8, 8);         // bit depth
  ihdrData.writeUInt8(6, 9);         // color type (RGBA)
  ihdrData.writeUInt8(0, 10);        // compression
  ihdrData.writeUInt8(0, 11);        // filter
  ihdrData.writeUInt8(0, 12);        // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // Create image data with a circle
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2 - 2; // Leave 2px margin

  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // Filter byte for each row
    for (let x = 0; x < width; x++) {
      const dx = x - centerX + 0.5;
      const dy = y - centerY + 0.5;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= radius) {
        // Inside circle - use the color
        rawData.push(red, green, blue, 255);
      } else if (distance <= radius + 1) {
        // Anti-aliasing edge
        const alpha = Math.max(0, Math.min(255, Math.round((radius + 1 - distance) * 255)));
        rawData.push(red, green, blue, alpha);
      } else {
        // Outside - transparent
        rawData.push(0, 0, 0, 0);
      }
    }
  }

  // Compress with zlib
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(rawData), { level: 9 });

  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

// CRC32 implementation for PNG
function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = makeCRCTable();

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeCRCTable() {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xEDB88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[n] = c >>> 0;
  }
  return table;
}

// Create icons
const iconsDir = path.join(__dirname, '..', 'src', 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// White circle for idle (32x32 for retina)
const idleIcon = createPNG(32, 32, 255, 255, 255);
fs.writeFileSync(path.join(iconsDir, 'tray-idle.png'), idleIcon);
console.log('Created tray-idle.png');

// Red circle for recording
const recordingIcon = createPNG(32, 32, 255, 59, 48);
fs.writeFileSync(path.join(iconsDir, 'tray-recording.png'), recordingIcon);
console.log('Created tray-recording.png');

// Orange circle for transcribing
const transcribingIcon = createPNG(32, 32, 255, 149, 0);
fs.writeFileSync(path.join(iconsDir, 'tray-transcribing.png'), transcribingIcon);
console.log('Created tray-transcribing.png');

console.log('All icons created successfully!');
