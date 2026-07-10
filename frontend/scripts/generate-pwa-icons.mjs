import sharp from "sharp";
import fs from "fs";
import path from "path";

const publicDir = path.resolve(process.cwd(), "public");
const svgPath = path.join(publicDir, "favicon.svg");

if (!fs.existsSync(svgPath)) {
  console.error("Source favicon.svg not found at", svgPath);
  process.exit(1);
}

const sizes = [
  { name: "icon-192.png", width: 192, height: 192 },
  { name: "icon-512.png", width: 512, height: 512 },
  { name: "apple-touch-icon.png", width: 180, height: 180 },
  { name: "favicon-32x32.png", width: 32, height: 32 },
  { name: "favicon-16x16.png", width: 16, height: 16 },
];

async function generate() {
  for (const size of sizes) {
    const outPath = path.join(publicDir, size.name);
    await sharp(svgPath)
      .resize(size.width, size.height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outPath);
    console.log("Generated", outPath);
  }
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
