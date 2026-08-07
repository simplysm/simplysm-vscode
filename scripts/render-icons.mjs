// packages/*/images/icon.svg → icon.png (128×128, 투명 배경) 렌더
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootPath = path.dirname(import.meta.dirname);
const pkgNames = ["tasks"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 128, height: 128 } });

for (const pkgName of pkgNames) {
  const svgPath = path.join(rootPath, "packages", pkgName, "images", "icon.svg");
  const svgText = await readFile(svgPath, "utf8");
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svgText}</body></html>`,
  );
  await page.screenshot({
    path: svgPath.replace(/\.svg$/, ".png"),
    omitBackground: true,
    clip: { x: 0, y: 0, width: 128, height: 128 },
  });
}

await browser.close();
