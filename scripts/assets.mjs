import { execFileSync } from "node:child_process";

const imageExtensionPattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;
const allowedAssetPattern = /^assets\//u;
const excludedFixturePattern =
  /^(?:(?:coverage|dist|docs?|node_modules)\/)|(?:^|\/)(?:__fixtures__|fixtures)\//u;

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"));

const misplacedImages = trackedFiles.filter(
  (file) =>
    imageExtensionPattern.test(file) &&
    !allowedAssetPattern.test(file) &&
    !excludedFixturePattern.test(file),
);

if (misplacedImages.length > 0) {
  console.error(
    [
      "Tracked application images must be stored under assets/:",
      ...misplacedImages.map((file) => `  - ${file}`),
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.info("Asset location audit passed.");
}
