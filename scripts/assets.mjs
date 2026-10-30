import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const imageExtensionPattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;
const allowedAssetPattern = /^(?:assets|src\/client\/public)\//u;
const excludedFixturePattern =
  /^(?:(?:coverage|dist|docs?|node_modules)\/)|(?:^|\/)(?:__fixtures__|fixtures)\//u;
const requiredAssets = [
  "assets/icon.png",
  "src/client/public/reddit_temp_logo.jpg",
];

const projectFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => existsSync(file));

const imageFiles = projectFiles.filter(
  (file) =>
    imageExtensionPattern.test(file) && !excludedFixturePattern.test(file),
);

const misplacedImages = imageFiles.filter(
  (file) => !allowedAssetPattern.test(file),
);
const missingAssets = requiredAssets.filter((file) => !existsSync(file));
const duplicateImages = Object.values(
  imageFiles.reduce((groups, file) => {
    const digest = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
    (groups[digest] ??= []).push(file);
    return groups;
  }, {}),
).filter((files) => files.length > 1);
const hasRootPublicDirectory = existsSync("public");

if (
  misplacedImages.length > 0 ||
  missingAssets.length > 0 ||
  duplicateImages.length > 0 ||
  hasRootPublicDirectory
) {
  const errors = ["Asset location audit failed:"];
  if (misplacedImages.length > 0) {
    errors.push(
      "Application images must be stored under assets/ or src/client/public/:",
      ...misplacedImages.map((file) => `  - ${file}`),
    );
  }
  if (missingAssets.length > 0) {
    errors.push(
      "Required application images are missing:",
      ...missingAssets.map((file) => `  - ${file}`),
    );
  }
  if (duplicateImages.length > 0) {
    errors.push(
      "Duplicate application images were found:",
      ...duplicateImages.map((files) => `  - ${files.join(", ")}`),
    );
  }
  if (hasRootPublicDirectory) {
    errors.push(
      "Remove the root public/ directory; src/client/public/ is the single Vite public directory.",
    );
  }
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Asset location audit passed.");
}
